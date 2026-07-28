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
  parseCodexPluginEnvironmentArtifactBuild,
  type CodexPluginEnvironmentArtifactBuildV1,
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

export type CodexPluginBuildOptions = {
  channel?: string;
  dir?: string;
  namespace?: string;
  nodePath?: string;
  protocolVersion?: string | number;
  runtimeDigest?: string;
  runtimeVersion?: string;
  shellVersion?: string;
  skipAppBuild?: boolean;
  workspaceRoot?: string;
};

const DEFAULT_NAMESPACE = "codex-local";
const DEFAULT_PROTOCOL_VERSION = 1;
const RUNTIME_ENTRY_PATH = "runtime.mjs";
const DARWIN_ARM64_NODE_PATH =
  "/Applications/Codex.app/Contents/Resources/cua_node/bin/node";

function parsePositiveInteger(value: string | number | undefined, label: string): number {
  if (value == null || value === "") return DEFAULT_PROTOCOL_VERSION;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return parsed;
}

async function runAppBuild(workspaceRoot: string): Promise<void> {
  for (const packageName of [
    "@open-design/distribution-proto",
    "@open-design/codex-plugin-proto",
    "@open-design/codex-plugin",
  ]) {
    const invocation = createPackageManagerInvocation(
      ["--filter", packageName, "build"],
      process.env,
    );
    await new Promise<void>((resolveRun, rejectRun) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: workspaceRoot,
        env: process.env,
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

async function resolveDarwinArm64NodePath(
  explicitPath: string | undefined,
): Promise<string | null> {
  const candidate = explicitPath == null
    ? process.platform === "darwin" && process.arch === "arm64"
      ? DARWIN_ARM64_NODE_PATH
      : null
    : resolve(explicitPath);
  if (candidate == null) return null;
  const info = await stat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && explicitPath == null) return null;
    throw error;
  });
  if (info == null) return null;
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Codex plugin Node artifact is not a regular file: ${candidate}`);
  }
  const [versionOutput, architecture] = await Promise.all([
    runCapture(candidate, ["--version"]),
    runCapture(candidate, ["-p", "process.arch"]),
  ]);
  if (!/^v24\.\d+\.\d+$/.test(versionOutput)) {
    throw new Error(`Codex plugin Node artifact must be Node 24: ${versionOutput}`);
  }
  if (architecture !== "arm64") {
    throw new Error(`Codex plugin Node artifact must be arm64: ${architecture}`);
  }
  return candidate;
}

async function packCodexPluginEnvironment(options: {
  namespaceRoot: string;
  nodePath: string | undefined;
}): Promise<CodexPluginEnvironmentArtifactBuildV1> {
  const sourcePath = await resolveDarwinArm64NodePath(options.nodePath);
  if (sourcePath == null) {
    throw new Error(
      "Codex plugin build requires a macOS arm64 Node 24 artifact; run on Apple Silicon with Codex installed or pass --node-path",
    );
  }
  const version = (await runCapture(sourcePath, ["--version"])).slice(1);
  const targetPath = join(
    options.namespaceRoot,
    "environment",
    CODEX_PLUGIN_PLATFORM_TARGETS.DARWIN_ARM64,
    "node",
  );
  await mkdir(dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath);
  await chmod(targetPath, 0o700);
  const bytes = await readFile(targetPath);
  const report = parseCodexPluginEnvironmentArtifactBuild({
    digest: digestBytes(bytes),
    path: targetPath,
    platform: CODEX_PLUGIN_PLATFORM_TARGETS.DARWIN_ARM64,
    size: bytes.byteLength,
    version,
  });
  await writeJson(join(dirname(targetPath), "artifact.json"), report);
  return report;
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

export function codexMarketplaceName(namespace: string): string {
  const normalized = normalizeDistributionNamespace(namespace);
  const portable = normalized.replaceAll(".", "-");
  if (portable === normalized) return `open-design-${portable}`;
  const suffix = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `open-design-${portable}-${suffix}`;
}

export function codexRuntimeFixtureSource(): string {
  return `import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const env = ${JSON.stringify(CODEX_PLUGIN_RUNTIME_ENV)};
const identity = {
  channel: process.env[env.CHANNEL],
  namespace: process.env[env.NAMESPACE],
  protocolVersion: Number(process.env[env.PROTOCOL_VERSION]),
  runtimeDigest: process.env[env.RUNTIME_DIGEST],
  runtimeVersion: process.env[env.RUNTIME_VERSION],
};
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
  const toolRoot = resolve(options.dir ?? join(workspaceRoot, ".tmp", "tools-pack"));
  const namespaceRoot = join(
    toolRoot,
    "out",
    "codex-plugin",
    "namespaces",
    namespace,
  );
  const artifactRoot = join(namespaceRoot, "marketplace");
  const runtimeRoot = join(namespaceRoot, "runtime");
  const runtimeArtifactPath = join(runtimeRoot, RUNTIME_ENTRY_PATH);
  const shellRoot = join(artifactRoot, "plugins", "open-design");
  const manifestPath = join(shellRoot, ".codex-plugin", "plugin.json");
  const buildReportPath = join(namespaceRoot, "build-report.json");
  const marketplaceName = codexMarketplaceName(namespace);
  assertWithinRoot(toolRoot, namespaceRoot, "Codex plugin namespace root");

  if (options.skipAppBuild !== true) await runAppBuild(workspaceRoot);
  const builtServerStat = await stat(builtServerPath);
  if (!builtServerStat.isFile() || builtServerStat.size === 0) {
    throw new Error(`Codex plugin MCP bundle is missing or empty: ${builtServerPath}`);
  }

  await rm(namespaceRoot, { force: true, recursive: true });
  const runtimeBytes = Buffer.from(codexRuntimeFixtureSource(), "utf8");
  const runtimeDigest = digestBytes(runtimeBytes);
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
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(runtimeArtifactPath, runtimeBytes, { mode: 0o700 });
  await mkdir(shellRoot, { recursive: true });
  await cp(sourceShellRoot, shellRoot, { recursive: true });
  await mkdir(join(shellRoot, "mcp"), { recursive: true });
  await cp(builtServerPath, join(shellRoot, "mcp", "server.mjs"));
  await packCodexPluginEnvironment({
    namespaceRoot,
    nodePath: options.nodePath,
  });

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.version = shellVersion;
  await writeJson(manifestPath, manifest);

  await writeJson(join(artifactRoot, ".agents", "plugins", "marketplace.json"), {
    interface: {
      displayName: "Open Design Local",
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
      entryPath: RUNTIME_ENTRY_PATH,
      path: runtimeArtifactPath,
      size: runtimeBytes.byteLength,
    },
    schemaVersion: DISTRIBUTION_REPORT_SCHEMA_VERSION,
  });
  await writeJson(buildReportPath, report);
  return report;
}
