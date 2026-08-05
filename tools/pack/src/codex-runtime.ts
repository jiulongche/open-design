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
import { dirname, join, relative } from "node:path";

import {
  CODEX_PLUGIN_RUNTIME_ENV,
  CODEX_PLUGIN_RUNTIME_MEDIA_TYPES,
} from "@open-design/codex-plugin-proto";
import { createPackageManagerInvocation } from "@open-design/platform";

import { copyBundledResourceTrees, winResources } from "./resources.js";

const RUNTIME_INTERNAL_PACKAGES = [
  { directory: "packages/release", name: "@open-design/release" },
  { directory: "packages/contracts", name: "@open-design/contracts" },
  { directory: "packages/codex-plugin-proto", name: "@open-design/codex-plugin-proto" },
  { directory: "packages/registry-protocol", name: "@open-design/registry-protocol" },
  { directory: "packages/sidecar-proto", name: "@open-design/sidecar-proto" },
  { directory: "packages/distribution-proto", name: "@open-design/distribution-proto" },
  { directory: "packages/launcher-proto", name: "@open-design/launcher-proto" },
  { directory: "packages/sidecar", name: "@open-design/sidecar" },
  { directory: "packages/platform", name: "@open-design/platform" },
  { directory: "packages/download", name: "@open-design/download" },
  { directory: "packages/host", name: "@open-design/host" },
  { directory: "packages/agui-adapter", name: "@open-design/agui-adapter" },
  { directory: "packages/plugin-runtime", name: "@open-design/plugin-runtime" },
  { directory: "packages/diagnostics", name: "@open-design/diagnostics" },
  { directory: "apps/daemon", name: "@open-design/daemon" },
] as const;

export type CodexProductionRuntimeArtifact = {
  digest: string;
  entryPath: "runtime.mjs";
  mediaType: typeof CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.ZIP_V1;
  path: string;
  size: number;
};

export type CodexProductionRuntimeArchiveInvocation = {
  args: readonly string[];
  command: string;
};

export function resolveCodexProductionRuntimeArchiveInvocation(options: {
  arch?: string;
  artifactPath: string;
  platform?: NodeJS.Platform;
}): CodexProductionRuntimeArchiveInvocation {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform === "darwin" && arch === "arm64") {
    return {
      args: [
        "-c",
        "-k",
        "--sequesterRsrc",
        "--rsrc",
        ".",
        options.artifactPath,
      ],
      command: "ditto",
    };
  }
  if (platform === "win32" && arch === "x64") {
    return {
      args: ["a", "-tzip", "-mx=5", options.artifactPath, ".\\*"],
      command: winResources.sevenZipExe,
    };
  }
  throw new Error(
    `Codex production runtime requires darwin-arm64 or win32-x64; got ${platform}-${arch}`,
  );
}

async function resolveNodeNpmCliPath(nodeExecutable = process.execPath): Promise<string> {
  const executableRoot = dirname(nodeExecutable);
  const candidates = process.platform === "win32"
    ? [join(executableRoot, "node_modules", "npm", "bin", "npm-cli.js")]
    : [
        join(dirname(executableRoot), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
        join(executableRoot, "node_modules", "npm", "bin", "npm-cli.js"),
      ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue through the known Node distribution layouts.
    }
  }
  throw new Error(
    `Codex production runtime could not resolve npm-cli.js beside ${nodeExecutable}`,
  );
}

function run(command: string, args: readonly string[], options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}): Promise<void> {
  return new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "inherit",
      windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments,
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0 && signal == null) {
        resolveRun();
        return;
      }
      rejectRun(new Error(
        `${command} failed with ${signal == null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`}`,
      ));
    });
  });
}

async function packWorkspaceTarballs(
  workspaceRoot: string,
  tarballsRoot: string,
): Promise<Record<string, string>> {
  await rm(tarballsRoot, { force: true, recursive: true });
  await mkdir(tarballsRoot, { recursive: true });
  const packed: Record<string, string> = {};

  for (const packageInfo of RUNTIME_INTERNAL_PACKAGES) {
    const before = new Set(await readdir(tarballsRoot));
    const invocation = createPackageManagerInvocation(
      [
        "-C",
        packageInfo.directory,
        "pack",
        "--pack-destination",
        tarballsRoot,
      ],
      process.env,
    );
    await run(invocation.command, invocation.args, {
      cwd: workspaceRoot,
      env: process.env,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const after = await readdir(tarballsRoot);
    const created = after.filter((entry) => !before.has(entry));
    if (created.length !== 1 || created[0] == null) {
      throw new Error(
        `expected one Codex runtime tarball for ${packageInfo.name}; got ${created.length}`,
      );
    }
    packed[packageInfo.name] = join(tarballsRoot, created[0]);
  }

  return packed;
}

export function codexProductionRuntimeSource(): string {
  return `import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const env = ${JSON.stringify(CODEX_PLUGIN_RUNTIME_ENV)};
const loadRuntimeEnvironment = async () => {
  const launchPipeIndex = process.argv.indexOf("--launch-pipe");
  if (launchPipeIndex < 0) return process.env;
  const launchPipePath = process.argv[launchPipeIndex + 1];
  if (typeof launchPipePath !== "string" || launchPipePath.length === 0) {
    throw new Error("Windows Codex runtime launch pipe path is missing");
  }
  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const socket = connect(launchPipePath);
    const timeout = setTimeout(() => {
      socket.destroy(new Error("Windows Codex runtime launch pipe timed out"));
    }, 10_000);
    timeout.unref();
    socket.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        socket.destroy(new Error("Windows Codex runtime launch environment is too large"));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once("end", () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
  const parsed = JSON.parse(raw);
  if (
    parsed == null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || !Object.values(parsed).every((value) => typeof value === "string")
  ) {
    throw new Error("Windows Codex runtime launch environment is invalid");
  }
  return { ...process.env, ...parsed };
};
const runtimeEnvironment = await loadRuntimeEnvironment();
const runtimeRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(runtimeRoot, "node_modules");
const daemonCli = join(projectRoot, "@open-design", "daemon", "dist", "cli.js");
const daemonMcp = join(projectRoot, "@open-design", "daemon", "dist", "mcp.js");
const codexPluginProto = join(projectRoot, "@open-design", "codex-plugin-proto", "dist", "index.mjs");
const resourceRoot = join(projectRoot, "open-design");
const logsRoot = runtimeEnvironment[env.LOGS_ROOT];
const logPath = join(logsRoot, "runtime", "latest.log");
const identity = {
  channel: runtimeEnvironment[env.CHANNEL],
  namespace: runtimeEnvironment[env.NAMESPACE],
  protocolVersion: Number(runtimeEnvironment[env.PROTOCOL_VERSION]),
  runtimeDigest: runtimeEnvironment[env.RUNTIME_DIGEST],
  runtimeVersion: runtimeEnvironment[env.RUNTIME_VERSION],
};
const accessToken = runtimeEnvironment[env.ACCESS_TOKEN];
if (
  identity.protocolVersion >= 2
  && (typeof accessToken !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(accessToken))
) {
  throw new Error("protocol-v2 Codex runtime requires a valid access token");
}

await mkdir(dirname(logPath), { recursive: true });
await writeFile(logPath, "", "utf8");
const daemon = spawn(process.execPath, [
  daemonCli,
  "daemon",
  "start",
  "--headless",
  "--port",
  "0",
], {
  cwd: projectRoot,
  env: {
    ...runtimeEnvironment,
    OD_BIN: daemonCli,
    OD_DAEMON_CLI_PATH: daemonCli,
    OD_DATA_DIR: runtimeEnvironment[env.DATA_ROOT],
    OD_NODE_BIN: process.execPath,
    OD_RESOURCE_ROOT: resourceRoot,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let daemonOutput = "";
let daemonUrl;
const appendLog = (chunk) => {
  const text = String(chunk);
  daemonOutput += text;
  void appendFile(logPath, text, "utf8");
  const match = daemonOutput.match(/\\[od\\] listening on (http:\\/\\/[^\\s]+) \\(headless\\)/u);
  if (match) daemonUrl = match[1];
};
daemon.stdout.on("data", appendLog);
daemon.stderr.on("data", appendLog);

const deadline = Date.now() + 90_000;
while (daemonUrl == null && Date.now() < deadline) {
  if (daemon.exitCode != null) {
    throw new Error("Open Design daemon exited before reporting readiness");
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
}
if (daemonUrl == null) {
  daemon.kill("SIGTERM");
  throw new Error("Open Design daemon did not report its URL within 90s");
}
const health = await fetch(daemonUrl + "/api/ready", {
  signal: AbortSignal.timeout(5_000),
});
if (!health.ok) {
  daemon.kill("SIGTERM");
  throw new Error("Open Design daemon readiness returned HTTP " + health.status);
}
await appendFile(logPath, "[codex-plugin-runtime] ready daemon=" + daemonUrl + "\\n", "utf8");

const {
  createMcpGatewaySession,
  handleMcpToolCall,
  listMcpResources,
  readMcpResource,
} = await import(pathToFileURL(daemonMcp).href);
const { parseCodexPluginMcpEnvelope } = await import(
  pathToFileURL(codexPluginProto).href
);
const gatewaySessions = new Map();

const authorized = (request) => {
  if (identity.protocolVersion < 2) return true;
  const supplied = request.headers.authorization;
  const expected = "Bearer " + accessToken;
  if (typeof supplied !== "string" || supplied.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
};

const sendJson = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload) + "\\n");
};
const readJsonBody = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) {
      throw new Error("runtime MCP request body exceeds 16 MiB");
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? {} : JSON.parse(text);
};

const identityServer = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && requestUrl.pathname === "/status") {
      sendJson(response, 200, identity);
      return;
    }
    if (request.method !== "POST" || requestUrl.pathname !== "/mcp") {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    if (!authorized(request)) {
      sendJson(response, 401, { error: "runtime MCP authorization failed" });
      return;
    }
    const rawMessage = await readJsonBody(request);
    const message = identity.protocolVersion >= 2
      ? parseCodexPluginMcpEnvelope(rawMessage)
      : rawMessage;
    if (
      identity.protocolVersion >= 2
      && message.protocolVersion !== identity.protocolVersion
    ) {
      sendJson(response, 409, { error: "runtime MCP protocol version mismatch" });
      return;
    }
    let result;
    if (message.method === "tools/call") {
      if (identity.protocolVersion >= 2) {
        let session = gatewaySessions.get(message.session.id);
        if (session == null) {
          if (gatewaySessions.size >= 32) {
            gatewaySessions.delete(gatewaySessions.keys().next().value);
          }
          session = await createMcpGatewaySession({
            baseUrl: daemonUrl,
            clientInfo: message.session.host,
            externalPluginContext: message.session.plugin,
          });
          gatewaySessions.set(message.session.id, session);
        }
        result = await session.call(
          message.params?.name,
          message.params?.arguments ?? {},
        );
      } else {
        result = await handleMcpToolCall(
          daemonUrl,
          message.params?.name,
          message.params?.arguments ?? {},
        );
      }
    } else if (message.method === "resources/list") {
      result = await listMcpResources(daemonUrl);
    } else if (message.method === "resources/read") {
      result = await readMcpResource(daemonUrl, message.params?.uri);
    } else {
      sendJson(response, 400, { error: "unsupported runtime MCP method" });
      return;
    }
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
await new Promise((resolveListen, rejectListen) => {
  identityServer.once("error", rejectListen);
  identityServer.listen(0, "127.0.0.1", () => {
    identityServer.off("error", rejectListen);
    resolveListen();
  });
});
const address = identityServer.address();
if (address == null || typeof address === "string") {
  daemon.kill("SIGTERM");
  throw new Error("Codex runtime identity server did not bind to TCP");
}

const readyPath = runtimeEnvironment[env.READY_PATH];
const temporaryPath = readyPath + "." + process.pid + ".tmp";
const ready = {
  endpointUrl: "http://127.0.0.1:" + address.port + "/status",
  handoffId: runtimeEnvironment[env.HANDOFF_ID],
  pid: process.pid,
  resumeTokenDigest: "sha256:" + createHash("sha256")
    .update(runtimeEnvironment[env.HANDOFF_TOKEN])
    .digest("hex"),
  schemaVersion: 1,
};
await writeFile(temporaryPath, JSON.stringify(ready), { mode: 0o600 });
await rename(temporaryPath, readyPath);

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  identityServer.close();
  daemon.kill("SIGTERM");
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
daemon.once("exit", (code, signal) => {
  if (!stopping) {
    void appendFile(
      logPath,
      "[codex-plugin-runtime] daemon exited code=" + code + " signal=" + signal + "\\n",
      "utf8",
    ).finally(() => process.exit(code ?? 1));
    return;
  }
  process.exit(0);
});
`;
}

export async function buildCodexProductionRuntime(options: {
  artifactPath: string;
  runtimeVersion: string;
  stageRoot: string;
  workspaceRoot: string;
}): Promise<CodexProductionRuntimeArtifact> {
  const archiveInvocation = resolveCodexProductionRuntimeArchiveInvocation({
    artifactPath: options.artifactPath,
  });

  const appRoot = join(options.stageRoot, "app");
  const tarballsRoot = join(options.stageRoot, "tarballs");
  await rm(options.stageRoot, { force: true, recursive: true });
  await mkdir(appRoot, { recursive: true });
  const packed = await packWorkspaceTarballs(options.workspaceRoot, tarballsRoot);
  const dependencies = Object.fromEntries(
    Object.entries(packed).map(([name, path]) => [
      name,
      `file:${relative(appRoot, path)}`,
    ]),
  );
  await writeFile(join(appRoot, "package.json"), `${JSON.stringify({
    dependencies,
    description: "Open Design Codex plugin production runtime",
    name: "open-design-codex-plugin-runtime",
    private: true,
    version: options.runtimeVersion,
  }, null, 2)}\n`, "utf8");
  await run(process.execPath, [
    await resolveNodeNpmCliPath(),
    "install",
    "--omit=dev",
    "--no-package-lock",
  ], {
    cwd: appRoot,
    env: process.env,
  });

  const resourceRoot = join(appRoot, "node_modules", "open-design");
  await mkdir(resourceRoot, { recursive: true });
  await copyBundledResourceTrees({
    resourceRoot,
    workspaceRoot: options.workspaceRoot,
  });
  const webOut = join(options.workspaceRoot, "apps", "web", "out");
  const webOutStat = await stat(webOut);
  if (!webOutStat.isDirectory()) {
    throw new Error(`Codex production runtime web output is missing: ${webOut}`);
  }
  await cp(webOut, join(appRoot, "node_modules", "apps", "web", "out"), {
    recursive: true,
  });

  const entryPath = join(appRoot, "runtime.mjs");
  await writeFile(entryPath, codexProductionRuntimeSource(), {
    encoding: "utf8",
    mode: 0o700,
  });
  await chmod(entryPath, 0o700);
  await mkdir(dirname(options.artifactPath), { recursive: true });
  await rm(options.artifactPath, { force: true });
  await run(archiveInvocation.command, archiveInvocation.args, { cwd: appRoot });
  const bytes = await readFile(options.artifactPath);
  await rm(options.stageRoot, { force: true, recursive: true });
  return {
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    entryPath: "runtime.mjs",
    mediaType: CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.ZIP_V1,
    path: options.artifactPath,
    size: bytes.byteLength,
  };
}
