import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  CODEX_PLUGIN_PLATFORM_TARGETS,
  CODEX_PLUGIN_RUNTIME_ENV,
  CODEX_PLUGIN_RUNTIME_MEDIA_TYPES,
  normalizeCodexPluginPlatformTarget,
  resolveCodexPluginReleasePaths,
  type CodexPluginPlatformTarget,
} from "@open-design/codex-plugin-proto";
import {
  DISTRIBUTION_REPORT_SCHEMA_VERSION,
  DISTRIBUTION_SHELL_TYPES,
  calculateDistributionArtifactInventory,
  normalizeDistributionChannel,
  normalizeDistributionDigest,
  normalizeDistributionIdentity,
  normalizeDistributionNamespace,
  normalizeDistributionRuntimeVersion,
  normalizeDistributionVersion,
  parseDistributionBuildReport,
  type DistributionBuildReportV1,
} from "@open-design/distribution-proto";
import { createPackageManagerInvocation } from "@open-design/platform";

import { WORKSPACE_ROOT } from "./config.js";
import {
  buildCodexProductionRuntime,
  codexProductionRuntimeSource,
} from "./codex-runtime.js";

export type CodexPluginBuildOptions = {
  carrierPath?: string;
  channel?: string;
  dir?: string;
  namespace?: string;
  platform?: string;
  protocolVersion?: string | number;
  runtimeDigest?: string;
  runtimeMode?: string;
  runtimeVersion?: string;
  shellVersion?: string;
  skipAppBuild?: boolean;
  workspaceRoot?: string;
};

const DEFAULT_NAMESPACE = "codex-local";
const DEFAULT_PROTOCOL_VERSION = 1;
const RUNTIME_ENTRY_PATH = "runtime.mjs";
const RUNTIME_ARCHIVE_PATH = "runtime.zip";
const MCP_STARTUP_TIMEOUT_SECONDS = 10;
const MCP_TOOL_TIMEOUT_SECONDS = 120;

function parsePositiveInteger(value: string | number | undefined, label: string): number {
  if (value == null || value === "") return DEFAULT_PROTOCOL_VERSION;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return parsed;
}

async function runWorkspaceBuild(
  workspaceRoot: string,
  packageName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const invocation = createPackageManagerInvocation(
    ["--filter", packageName, "build"],
    env,
  );
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: workspaceRoot,
      env,
      stdio: "inherit",
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0 && signal == null) {
        resolveRun();
        return;
      }
      rejectRun(new Error(
        `${packageName} build failed with ${signal == null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`}`,
      ));
    });
  });
}

async function runAppBuild(
  workspaceRoot: string,
  runtimeMode: CodexPluginRuntimeMode,
): Promise<void> {
  if (runtimeMode === "production") {
    await runWorkspaceBuild(workspaceRoot, "@open-design/daemon...");
    await runWorkspaceBuild(workspaceRoot, "@open-design/web...", {
      ...process.env,
      NODE_ENV: "production",
      OD_WEB_OUTPUT_MODE: "",
    });
  }
  for (const packageName of [
    "@open-design/distribution-proto",
    "@open-design/codex-plugin-proto",
    "@open-design/codex-plugin",
  ]) {
    await runWorkspaceBuild(workspaceRoot, packageName);
  }
}

async function runCapture(
  command: string,
  args: readonly string[],
): Promise<string> {
  return await new Promise<string>((resolveRun, rejectRun) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, [...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0 && signal == null) {
        resolveRun(stdout.trim());
        return;
      }
      rejectRun(new Error(
        `${command} ${args.join(" ")} failed: ${stderr.trim() || `exit ${code ?? signal ?? "unknown"}`}`,
      ));
    });
  });
}

function hostPlatformTarget(
  platform = process.platform,
  architecture = process.arch,
): CodexPluginPlatformTarget | null {
  if (platform === "darwin" && architecture === "arm64") {
    return CODEX_PLUGIN_PLATFORM_TARGETS.DARWIN_ARM64;
  }
  if (platform === "win32" && architecture === "x64") {
    return CODEX_PLUGIN_PLATFORM_TARGETS.WIN32_X64;
  }
  return null;
}

function platformCarrierEntryPath(target: CodexPluginPlatformTarget): string {
  return target === CODEX_PLUGIN_PLATFORM_TARGETS.WIN32_X64
    ? "bin/node.exe"
    : "bin/node";
}

function resolvePlatformTarget(
  explicitTarget: string | undefined,
): CodexPluginPlatformTarget {
  if (explicitTarget != null && explicitTarget.length > 0) {
    return normalizeCodexPluginPlatformTarget(explicitTarget);
  }
  const target = hostPlatformTarget();
  if (target == null) {
    throw new Error(
      `Codex plugin build requires --platform on unsupported host ${process.platform}-${process.arch}`,
    );
  }
  return target;
}

async function resolveCarrierPath(
  target: CodexPluginPlatformTarget,
  explicitPath: string | undefined,
): Promise<string> {
  const currentTarget = hostPlatformTarget();
  if (currentTarget !== target) {
    throw new Error(
      `Codex plugin ${target} artifacts must be built on a ${target} host; current host is ${process.platform}-${process.arch}`,
    );
  }
  const candidate = explicitPath == null ? process.execPath : resolve(explicitPath);
  const info = await stat(candidate).catch((error: NodeJS.ErrnoException) => {
    throw error;
  });
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Codex plugin execution carrier is not a regular file: ${candidate}`);
  }
  const [versionOutput, observedTarget] = await Promise.all([
    runCapture(candidate, ["--version"]),
    runCapture(candidate, ["-p", "process.platform + '-' + process.arch"]),
  ]);
  if (!/^v24\.\d+\.\d+$/.test(versionOutput)) {
    throw new Error(`Codex plugin execution carrier must be Node 24: ${versionOutput}`);
  }
  if (observedTarget !== target) {
    throw new Error(
      `Codex plugin execution carrier target mismatch: expected ${target}; got ${observedTarget}`,
    );
  }
  return candidate;
}

async function packCodexPluginCarrier(options: {
  carrierPath: string | undefined;
  shellRoot: string;
  target: CodexPluginPlatformTarget;
}): Promise<{ entryPath: string; version: string }> {
  const sourcePath = await resolveCarrierPath(options.target, options.carrierPath);
  const version = (await runCapture(sourcePath, ["--version"])).slice(1);
  const entryPath = platformCarrierEntryPath(options.target);
  const targetPath = join(options.shellRoot, ...entryPath.split("/"));
  await mkdir(dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath);
  await chmod(targetPath, 0o700);
  return { entryPath, version };
}

function assertWithinRoot(root: string, target: string, label: string): void {
  const relation = relative(root, target);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} escapes root: ${target}`);
  }
}

async function collectFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ))) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, absolutePath));
    } else if (entry.isFile()) {
      files.push(relative(root, absolutePath).split(sep).join("/"));
    }
  }
  return files;
}

async function digestFiles(root: string, files: readonly string[]): Promise<{
  digest: string;
  size: number;
}> {
  const inventory = calculateDistributionArtifactInventory(await Promise.all(
    files.map(async (file) => ({
      bytes: await readFile(join(root, ...file.split("/"))),
      path: file,
    })),
  ));
  return { digest: inventory.digest, size: inventory.size };
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readPackageVersion(path: string): Promise<string> {
  const payload = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
  return normalizeDistributionVersion(payload.version, "Codex plugin package version");
}

export function codexMarketplaceName(
  namespace: string,
  target: CodexPluginPlatformTarget,
): string {
  const normalized = normalizeDistributionNamespace(namespace);
  const portable = normalized.replaceAll(".", "-");
  if (portable === normalized) return `open-design-${portable}-${target}`;
  const suffix = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `open-design-${portable}-${target}-${suffix}`;
}

function codexPluginMcpConfig(
  target: CodexPluginPlatformTarget,
  releaseManifestUrl: string,
): Record<string, unknown> {
  return {
    mcpServers: {
      "open-design": {
        args: [
          "./mcp/server.mjs",
          "--identity-file",
          "./distribution.json",
          "--runtime-manifest-url",
          releaseManifestUrl,
        ],
        command: `./${platformCarrierEntryPath(target)}`,
        cwd: ".",
        description:
          "Expose the Open Design distribution identity and runtime bridge.",
        env_vars: [
          "OD_CODEX_PLUGIN_RUNTIME_MANIFEST_URL",
          "OD_DATA_DIR",
          "OD_DISTRIBUTION_CHANNEL_ROOT",
        ],
        startup_timeout_sec: MCP_STARTUP_TIMEOUT_SECONDS,
        title: "Open Design",
        tool_timeout_sec: MCP_TOOL_TIMEOUT_SECONDS,
      },
    },
  };
}

type CodexPluginRuntimeMode = "fixture" | "production";

function resolveRuntimeMode(value: string | undefined): CodexPluginRuntimeMode {
  if (value == null || value.length === 0 || value === "fixture") return "fixture";
  if (value === "production") return value;
  throw new Error("Codex plugin runtime mode must be fixture or production");
}

export function codexRuntimeFixtureSource(runtimeVersion: string): string {
  return `import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const env = ${JSON.stringify(CODEX_PLUGIN_RUNTIME_ENV)};
const packedRuntimeVersion = ${JSON.stringify(runtimeVersion)};
const identity = {
  channel: process.env[env.CHANNEL],
  namespace: process.env[env.NAMESPACE],
  protocolVersion: Number(process.env[env.PROTOCOL_VERSION]),
  runtimeDigest: process.env[env.RUNTIME_DIGEST],
  runtimeVersion: process.env[env.RUNTIME_VERSION],
};
if (identity.runtimeVersion !== packedRuntimeVersion) {
  process.exit(1);
}
const idleMs = 15 * 60 * 1000;
let idleTimer;
const shutdown = () => server.close(() => process.exit(0));
const armIdleTimer = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(shutdown, idleMs);
  idleTimer.unref();
};
const server = createServer((_request, response) => {
  armIdleTimer();
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(identity) + "\\n");
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address == null || typeof address === "string") {
    process.exit(1);
  }
  const readyPath = process.env[env.READY_PATH];
  const temporaryPath = readyPath + "." + process.pid + ".tmp";
  const ready = {
    endpointUrl: \`http://127.0.0.1:\${address.port}/status\`,
    handoffId: process.env[env.HANDOFF_ID],
    pid: process.pid,
    resumeTokenDigest: "sha256:" + createHash("sha256")
      .update(process.env[env.HANDOFF_TOKEN])
      .digest("hex"),
    schemaVersion: 1,
  };
  void writeFile(temporaryPath, JSON.stringify(ready), { mode: 0o600 })
    .then(() => rename(temporaryPath, readyPath));
  armIdleTimer();
});
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
`;
}

export async function packCodexPlugin(
  options: CodexPluginBuildOptions = {},
): Promise<DistributionBuildReportV1> {
  const workspaceRoot = resolve(options.workspaceRoot ?? WORKSPACE_ROOT);
  const appRoot = join(workspaceRoot, "apps", "codex-plugin");
  const sourceShellRoot = join(appRoot, "plugin", "open-design");
  const builtServerPath = join(appRoot, "dist", "mcp", "server.mjs");
  if (options.channel == null || options.channel.length === 0) {
    throw new Error("Codex plugin build requires --channel");
  }
  if (options.runtimeVersion == null || options.runtimeVersion.length === 0) {
    throw new Error("Codex plugin build requires --runtime-version");
  }
  const channel = normalizeDistributionChannel(options.channel);
  const namespace = normalizeDistributionNamespace(options.namespace ?? DEFAULT_NAMESPACE);
  const runtimeVersion = normalizeDistributionRuntimeVersion(
    options.runtimeVersion,
    channel,
  );
  const shellVersion = normalizeDistributionVersion(
    options.shellVersion ?? await readPackageVersion(join(appRoot, "package.json")),
    "Codex plugin shell version",
  );
  const protocolVersion = parsePositiveInteger(
    options.protocolVersion,
    "protocol version",
  );
  const platform = resolvePlatformTarget(options.platform);
  const runtimeMode = resolveRuntimeMode(options.runtimeMode);
  const toolRoot = resolve(options.dir ?? join(workspaceRoot, ".tmp", "tools-pack"));
  const namespaceRoot = join(
    toolRoot,
    "out",
    "codex-plugin",
    "namespaces",
    namespace,
    platform,
  );
  const artifactRoot = join(namespaceRoot, "marketplace");
  const runtimeRoot = join(namespaceRoot, "runtime");
  const runtimeArtifactPath = join(
    runtimeRoot,
    runtimeMode === "production" ? RUNTIME_ARCHIVE_PATH : RUNTIME_ENTRY_PATH,
  );
  const shellRoot = join(artifactRoot, "plugins", "open-design");
  const manifestPath = join(shellRoot, ".codex-plugin", "plugin.json");
  const buildReportPath = join(namespaceRoot, "build-report.json");
  const marketplaceName = codexMarketplaceName(namespace, platform);
  assertWithinRoot(toolRoot, namespaceRoot, "Codex plugin namespace root");

  if (options.skipAppBuild !== true) await runAppBuild(workspaceRoot, runtimeMode);
  const builtServerStat = await stat(builtServerPath);
  if (!builtServerStat.isFile() || builtServerStat.size === 0) {
    throw new Error(`Codex plugin MCP bundle is missing or empty: ${builtServerPath}`);
  }

  await rm(namespaceRoot, { force: true, recursive: true });
  let runtimeDigest: string;
  let runtimeSize: number;
  let runtimeEntryPath: string;
  let runtimeMediaType:
    | typeof CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.NODE_MODULE_V1
    | typeof CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.ZIP_V1;
  if (runtimeMode === "production") {
    const runtimeArtifact = await buildCodexProductionRuntime({
      artifactPath: runtimeArtifactPath,
      runtimeVersion,
      stageRoot: join(namespaceRoot, "runtime-stage"),
      workspaceRoot,
    });
    runtimeDigest = runtimeArtifact.digest;
    runtimeSize = runtimeArtifact.size;
    runtimeEntryPath = runtimeArtifact.entryPath;
    runtimeMediaType = runtimeArtifact.mediaType;
  } else {
    const runtimeBytes = Buffer.from(
      codexRuntimeFixtureSource(runtimeVersion),
      "utf8",
    );
    runtimeDigest = digestBytes(runtimeBytes);
    runtimeSize = runtimeBytes.byteLength;
    runtimeEntryPath = RUNTIME_ENTRY_PATH;
    runtimeMediaType = CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.NODE_MODULE_V1;
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(runtimeArtifactPath, runtimeBytes, { mode: 0o700 });
  }
  if (options.runtimeDigest != null && options.runtimeDigest.length > 0) {
    const expectedRuntimeDigest = normalizeDistributionDigest(
      options.runtimeDigest,
      "runtime digest",
    );
    if (expectedRuntimeDigest !== runtimeDigest) {
      throw new Error(
        `runtime digest ${expectedRuntimeDigest} does not match generated artifact ${runtimeDigest}`,
      );
    }
  }
  await mkdir(shellRoot, { recursive: true });
  await cp(sourceShellRoot, shellRoot, { recursive: true });
  await rm(join(shellRoot, "bootstrap.sh"), { force: true });
  await mkdir(join(shellRoot, "mcp"), { recursive: true });
  await cp(builtServerPath, join(shellRoot, "mcp", "server.mjs"));
  await packCodexPluginCarrier({
    carrierPath: options.carrierPath,
    shellRoot,
    target: platform,
  });
  const releasePaths = resolveCodexPluginReleasePaths({
    channel,
    mediaType: runtimeMediaType,
    namespace,
    platform,
    runtimeVersion,
  });
  await writeJson(
    join(shellRoot, ".mcp.json"),
    codexPluginMcpConfig(
      platform,
      `https://releases.open-design.ai/${releasePaths.latestRuntimeManifestPath}`,
    ),
  );

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.version = shellVersion;
  await writeJson(manifestPath, manifest);

  await writeJson(join(artifactRoot, ".agents", "plugins", "marketplace.json"), {
    interface: {
      displayName: `Open Design Local (${platform})`,
    },
    name: marketplaceName,
    plugins: [
      {
        category: "Creativity",
        name: "open-design",
        policy: {
          // Codex 0.145.0 accepts ON_INSTALL or ON_USE. Open Design has no
          // install-time credential flow, so defer any host auth boundary
          // until the plugin is actually invoked.
          authentication: "ON_USE",
          installation: "AVAILABLE",
        },
        source: {
          path: "./plugins/open-design",
          source: "local",
        },
      },
    ],
  });

  // distribution.json carries the digest, so the digestable shell payload is
  // deliberately the immutable plugin content before that generated envelope.
  const files = await collectFiles(shellRoot);
  const payloadFiles = files.filter((file) => file !== "distribution.json");
  const artifact = await digestFiles(shellRoot, payloadFiles);
  const identity = normalizeDistributionIdentity({
    channel,
    namespace,
    protocolVersion,
    runtimeDigest,
    runtimeVersion,
    shellDigest: artifact.digest,
    shellType: DISTRIBUTION_SHELL_TYPES.CODEX_PLUGIN,
    shellVersion,
  });
  await writeJson(join(shellRoot, "distribution.json"), identity);

  const report = parseDistributionBuildReport({
    artifact: {
      digest: artifact.digest,
      files: payloadFiles,
      size: artifact.size,
    },
    identity,
    paths: {
      artifactRoot,
      manifestPath,
      shellRoot,
    },
    runtimeArtifact: {
      digest: runtimeDigest,
      entryPath: runtimeEntryPath,
      path: runtimeArtifactPath,
      size: runtimeSize,
    },
    schemaVersion: DISTRIBUTION_REPORT_SCHEMA_VERSION,
  });
  await writeJson(buildReportPath, report);
  return report;
}

export { codexProductionRuntimeSource };
