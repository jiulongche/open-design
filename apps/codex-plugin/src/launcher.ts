import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, toNamespacedPath, win32 } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  CODEX_PLUGIN_HANDOFF_STATES,
  CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
  CODEX_PLUGIN_RUNTIME_ENV,
  CODEX_PLUGIN_RUNTIME_MEDIA_TYPES,
  CODEX_PLUGIN_UPDATE_CHECK_STATES,
  compareCodexPluginShellVersions,
  parseCodexPluginAcquisitionManifest,
  parseCodexPluginHandoffDescriptor,
  parseCodexPluginRuntimeReady,
  parseCodexPluginUpdateCheck,
  resolveCodexPluginShellPaths,
  type CodexPluginAcquisitionManifestV1,
  type CodexPluginHandoffDescriptorV1,
  type CodexPluginUpdateCheckV1,
} from "@open-design/codex-plugin-proto";
import {
  DISTRIBUTION_DEFAULT_RUNTIME_LEASE_TTL_MS,
  DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
  DISTRIBUTION_SHELL_TYPES,
  assertSameDistributionRuntimeIdentity,
  isDistributionRuntimeLeaseExpired,
  normalizeDistributionRuntimeIdentity,
  parseDistributionRuntimeAttempt,
  parseDistributionRuntimeBinding,
  parseDistributionRuntimeLease,
  parseDistributionRuntimePointer,
  resolveDistributionRuntimeStorePaths,
  resolveDistributionRuntimeVersionPaths,
  selectDistributionRuntimeTarget,
  type DistributionIdentityV1,
  type DistributionRuntimeAttemptV1,
  type DistributionRuntimeBindingV1,
  type DistributionRuntimeIdentityV1,
  type DistributionRuntimeLeaseV1,
  type DistributionRuntimePointerV1,
  type DistributionSuitePaths,
} from "@open-design/distribution-proto";

export type CodexPluginRuntimeEnsureResult = {
  attached: boolean;
  binding: DistributionRuntimeBindingV1;
  handoff: CodexPluginHandoffDescriptorV1 | null;
  manifest: CodexPluginAcquisitionManifestV1;
  reusedArtifact: boolean;
  updateCheck: CodexPluginUpdateCheckV1;
};

export class CodexPluginLauncherError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexPluginLauncherError";
    this.code = code;
  }
}

type RuntimeSession = {
  binding: DistributionRuntimeBindingV1;
  child: RuntimeProcessHandle | null;
};

type RuntimeProcessHandle = {
  kill: (signal: NodeJS.Signals) => void;
  pid: number;
  unref: () => void;
};

export const CODEX_PLUGIN_ACTIVE_MANIFEST_TIMEOUT_MS = 500;
export const CODEX_PLUGIN_FIRST_MANIFEST_TIMEOUT_MS = 5_000;
export const CODEX_PLUGIN_LIVE_BINDING_PROBE_TIMEOUT_MS = 400;
export const CODEX_PLUGIN_RUNTIME_READY_TIMEOUT_MS = 45_000;
export const CODEX_PLUGIN_RUNTIME_OBSERVER_TIMEOUT_MS = 50_000;

const RUNTIME_LEASE_ATTACH_TIMEOUT_MS =
  CODEX_PLUGIN_RUNTIME_OBSERVER_TIMEOUT_MS;
const RUNTIME_LEASE_POLL_INTERVAL_MS = 250;

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function tokenDigest(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function spawnFilesystemPath(path: string): string {
  return process.platform === "win32" ? toNamespacedPath(path) : path;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return raw == null ? null : JSON.parse(raw) as unknown;
}

async function readParsedJsonIfExists<T>(options: {
  code: string;
  label: string;
  parse(value: unknown): T;
  path: string;
}): Promise<T | null> {
  try {
    const raw = await readJsonIfExists(options.path);
    return raw == null ? null : options.parse(raw);
  } catch (error) {
    throw new CodexPluginLauncherError(
      options.code,
      `${options.label} is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, path);
}

function runtimeIdentityFromManifest(
  manifest: CodexPluginAcquisitionManifestV1,
): DistributionRuntimeIdentityV1 {
  return normalizeDistributionRuntimeIdentity({
    channel: manifest.channel,
    namespace: manifest.namespace,
    protocolVersion: manifest.protocolVersion,
    runtimeDigest: manifest.runtimeDigest,
    runtimeVersion: manifest.runtimeVersion,
  });
}

function runtimeIdentityFromRuntime(
  runtime: DistributionRuntimeIdentityV1,
): DistributionRuntimeIdentityV1 {
  return normalizeDistributionRuntimeIdentity({
    channel: runtime.channel,
    namespace: runtime.namespace,
    protocolVersion: runtime.protocolVersion,
    runtimeDigest: runtime.runtimeDigest,
    runtimeVersion: runtime.runtimeVersion,
  });
}

function assertRuntimeCoordinates(
  identity: Pick<
    DistributionRuntimeIdentityV1,
    "channel" | "namespace" | "protocolVersion"
  >,
  runtime: Pick<
    DistributionRuntimeIdentityV1,
    "channel" | "namespace" | "protocolVersion"
  >,
): void {
  if (
    identity.channel !== runtime.channel
    || identity.namespace !== runtime.namespace
    || identity.protocolVersion !== runtime.protocolVersion
  ) {
    throw new CodexPluginLauncherError(
      "RUNTIME_COORDINATE_MISMATCH",
      "runtime manifest channel, namespace, or protocol does not match the Codex plugin distribution",
    );
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new CodexPluginLauncherError(
      "RUNTIME_HTTP_FAILED",
      `runtime request returned HTTP ${response.status}: ${url}`,
    );
  }
  return await response.json() as unknown;
}

async function observeBinding(
  binding: DistributionRuntimeBindingV1,
  fetchImpl: typeof fetch,
  timeoutMs = CODEX_PLUGIN_LIVE_BINDING_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (!isProcessAlive(binding.owner.pid)) return false;
  try {
    const actual = normalizeDistributionRuntimeIdentity(
      await fetchJson(binding.endpointUrl, fetchImpl, timeoutMs),
    );
    assertSameDistributionRuntimeIdentity(binding, actual);
    return true;
  } catch {
    return false;
  }
}

async function readCompatibleBinding(options: {
  expected: DistributionRuntimeIdentityV1;
  fetchImpl: typeof fetch;
  path: string;
}): Promise<DistributionRuntimeBindingV1 | null> {
  const binding = await readParsedJsonIfExists({
    code: "RUNTIME_BINDING_STATE_INVALID",
    label: "runtime binding state",
    parse: parseDistributionRuntimeBinding,
    path: options.path,
  });
  if (binding == null) return null;
  try {
    assertSameDistributionRuntimeIdentity(options.expected, binding);
  } catch {
    if (isProcessAlive(binding.owner.pid)) {
      throw new CodexPluginLauncherError(
        "INCOMPATIBLE_RUNTIME_ACTIVE",
        "an incompatible Open Design runtime is active for this channel and namespace",
      );
    }
    return null;
  }
  if (await observeBinding(binding, options.fetchImpl)) return binding;
  if (isProcessAlive(binding.owner.pid)) {
    throw new CodexPluginLauncherError(
      "RUNTIME_BINDING_UNHEALTHY",
      `the compatible Open Design runtime pid ${binding.owner.pid} is alive but not observable`,
    );
  }
  return null;
}

async function removeDeadRuntimeBinding(options: {
  path: string;
}): Promise<void> {
  const binding = await readParsedJsonIfExists({
    code: "RUNTIME_BINDING_STATE_INVALID",
    label: "runtime binding state",
    parse: parseDistributionRuntimeBinding,
    path: options.path,
  });
  if (binding == null) return;
  if (isProcessAlive(binding.owner.pid)) {
    throw new CodexPluginLauncherError(
      "RUNTIME_BINDING_LIVE",
      `refusing to replace runtime binding owned by live pid ${binding.owner.pid}`,
    );
  }
  await rm(options.path, { force: true });
}

async function acquireRuntimeLease(options: {
  channel: DistributionRuntimeIdentityV1["channel"];
  leasePath: string;
  lockRoot: string;
  namespace: string;
}): Promise<DistributionRuntimeLeaseV1> {
  await mkdir(dirname(options.lockRoot), { mode: 0o700, recursive: true });
  try {
    await mkdir(options.lockRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readParsedJsonIfExists({
      code: "RUNTIME_LEASE_STATE_INVALID",
      label: "runtime lease state",
      parse: parseDistributionRuntimeLease,
      path: options.leasePath,
    });
    if (existing == null) {
      throw new CodexPluginLauncherError(
        "RUNTIME_LOCK_UNKNOWN",
        "runtime acquisition lock exists without a readable lease",
      );
    }
    throw new CodexPluginLauncherError(
      isDistributionRuntimeLeaseExpired(existing)
        ? "RUNTIME_LEASE_EXPIRED"
        : "RUNTIME_BUSY",
      `runtime acquisition is owned by ${existing.owner.shellType} pid ${existing.owner.pid}`,
    );
  }
  const acquiredAt = new Date();
  const lease: DistributionRuntimeLeaseV1 = {
    acquiredAt: acquiredAt.toISOString(),
    channel: options.channel,
    expiresAt: new Date(
      acquiredAt.getTime() + DISTRIBUTION_DEFAULT_RUNTIME_LEASE_TTL_MS,
    ).toISOString(),
    leaseId: opaqueId("lease"),
    namespace: options.namespace,
    owner: {
      pid: process.pid,
      shellType: DISTRIBUTION_SHELL_TYPES.CODEX_PLUGIN,
    },
    schemaVersion: DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
  };
  await writeJsonAtomic(options.leasePath, lease);
  return lease;
}

async function acquireRuntimeLeaseOrAttach(options: {
  channel: DistributionRuntimeIdentityV1["channel"];
  expected: DistributionRuntimeIdentityV1;
  fetchImpl: typeof fetch;
  leasePath: string;
  lockRoot: string;
  namespace: string;
  bindingPath: string;
}): Promise<
  | { binding: DistributionRuntimeBindingV1; lease: null }
  | { binding: null; lease: DistributionRuntimeLeaseV1 }
> {
  const deadline = Date.now() + RUNTIME_LEASE_ATTACH_TIMEOUT_MS;
  while (true) {
    const binding = await readCompatibleBinding({
      expected: options.expected,
      fetchImpl: options.fetchImpl,
      path: options.bindingPath,
    });
    if (binding != null) return { binding, lease: null };
    try {
      return {
        binding: null,
        lease: await acquireRuntimeLease({
          channel: options.channel,
          leasePath: options.leasePath,
          lockRoot: options.lockRoot,
          namespace: options.namespace,
        }),
      };
    } catch (error) {
      if (
        !(error instanceof CodexPluginLauncherError)
        || !["RUNTIME_BUSY", "RUNTIME_LEASE_EXPIRED", "RUNTIME_LOCK_UNKNOWN"]
          .includes(error.code)
      ) {
        throw error;
      }
      const lease = await readParsedJsonIfExists({
        code: "RUNTIME_LEASE_STATE_INVALID",
        label: "runtime lease state",
        parse: parseDistributionRuntimeLease,
        path: options.leasePath,
      });
      if (lease != null) {
        if (
          isDistributionRuntimeLeaseExpired(lease)
          && !isProcessAlive(lease.owner.pid)
        ) {
          await rm(options.lockRoot, { force: true, recursive: true });
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new CodexPluginLauncherError(
          "RUNTIME_BUSY",
          `runtime acquisition did not publish a compatible binding within ${RUNTIME_LEASE_ATTACH_TIMEOUT_MS}ms`,
        );
      }
      await sleep(RUNTIME_LEASE_POLL_INTERVAL_MS);
    }
  }
}

async function releaseRuntimeLease(options: {
  lease: DistributionRuntimeLeaseV1;
  leasePath: string;
  lockRoot: string;
}): Promise<void> {
  const current = await readParsedJsonIfExists({
    code: "RUNTIME_LEASE_STATE_INVALID",
    label: "runtime lease state",
    parse: parseDistributionRuntimeLease,
    path: options.leasePath,
  });
  if (current == null) return;
  if (current.leaseId !== options.lease.leaseId) {
    throw new CodexPluginLauncherError(
      "RUNTIME_LEASE_REPLACED",
      "runtime acquisition lease changed before release",
    );
  }
  await rm(options.lockRoot, { force: true, recursive: true });
}

async function verifyRuntimeArtifact(path: string, manifest: CodexPluginAcquisitionManifestV1): Promise<void> {
  const bytes = await readFile(path);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (bytes.byteLength !== manifest.artifact.size || digest !== manifest.artifact.digest) {
    throw new CodexPluginLauncherError(
      "RUNTIME_ARTIFACT_MISMATCH",
      "runtime artifact size or digest does not match the acquisition manifest",
    );
  }
}

function runCommand(
  command: string,
  args: readonly string[],
  errorCode = "RUNTIME_EXTRACT_FAILED",
): Promise<string> {
  return new Promise<string>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const appendTail = (current: string, chunk: unknown): string =>
      `${current}${String(chunk)}`.slice(-4_000);
    child.stdout?.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk);
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0 && signal == null) {
        resolveRun(stdout.trim());
        return;
      }
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      rejectRun(new CodexPluginLauncherError(
        errorCode,
        `${command} failed with ${signal == null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`}${detail.length === 0 ? "" : `:\n${detail}`}`,
      ));
    });
  });
}

export function windowsRuntimeArchiveExtractionInvocation(
  archivePath: string,
  payloadRoot: string,
  nodeExecutablePath = process.execPath,
): { args: readonly string[]; command: string } {
  return {
    args: ["x", "-y", `-o${payloadRoot}`, archivePath],
    command: win32.join(win32.dirname(nodeExecutablePath), "7zip", "7z.exe"),
  };
}

function quoteWindowsCommandLineArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  return `"${value
    .replace(/(\\*)"/gu, "$1$1\\\"")
    .replace(/(\\+)$/u, "$1$1")}"`;
}

export function windowsRuntimeProcessCreateArgs(
  commandLine: string,
  currentDirectory: string,
): readonly string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "& { param($commandLineBase64, $currentDirectoryBase64) $commandLine = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($commandLineBase64)); $currentDirectory = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($currentDirectoryBase64)); $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $currentDirectory }; [pscustomobject]@{ processId = [int]$result.ProcessId; returnValue = [int]$result.ReturnValue } | ConvertTo-Json -Compress }",
    Buffer.from(commandLine, "utf8").toString("base64"),
    Buffer.from(currentDirectory, "utf8").toString("base64"),
  ];
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function openWindowsRuntimeLaunchPipe(environment: NodeJS.ProcessEnv): Promise<{
  close: () => Promise<void>;
  delivered: Promise<void>;
  path: string;
}> {
  const path = `\\\\.\\pipe\\open-design-codex-${opaqueId("runtime")}`;
  const payload = JSON.stringify(Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ));
  const server = createServer();
  let connected = false;
  let resolveDelivery!: () => void;
  let rejectDelivery!: (error: Error) => void;
  const delivered = new Promise<void>((resolve, reject) => {
    resolveDelivery = resolve;
    rejectDelivery = reject;
  });
  server.on("connection", (socket) => {
    if (connected) {
      socket.destroy();
      return;
    }
    connected = true;
    socket.once("error", rejectDelivery);
    socket.end(payload, () => resolveDelivery());
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    server.once("error", onError);
    server.listen(path, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  return {
    close: async () => await closeServer(server),
    delivered,
    path,
  };
}

async function launchWindowsBreakawayRuntime(options: {
  cwd: string;
  entryPath: string;
  environment: NodeJS.ProcessEnv;
}): Promise<RuntimeProcessHandle> {
  const launchPipe = await openWindowsRuntimeLaunchPipe(options.environment);
  let pid: number | null = null;
  try {
    const commandLine = [
      process.execPath,
      options.entryPath,
      "--launch-pipe",
      launchPipe.path,
    ].map(quoteWindowsCommandLineArgument).join(" ");
    const stdout = await runCommand(
      "powershell.exe",
      windowsRuntimeProcessCreateArgs(commandLine, options.cwd),
      "RUNTIME_SPAWN_FAILED",
    );
    const result = JSON.parse(stdout) as {
      processId?: unknown;
      returnValue?: unknown;
    };
    if (
      result.returnValue !== 0
      || !Number.isSafeInteger(result.processId)
      || (result.processId as number) <= 0
    ) {
      throw new CodexPluginLauncherError(
        "RUNTIME_SPAWN_FAILED",
        `Win32_Process.Create failed with return value ${String(result.returnValue)}`,
      );
    }
    pid = result.processId as number;
    await Promise.race([
      launchPipe.delivered,
      sleep(10_000).then(() => {
        throw new CodexPluginLauncherError(
          "RUNTIME_SPAWN_FAILED",
          "Windows runtime did not connect to its private environment pipe",
        );
      }),
    ]);
    if (!isProcessAlive(pid)) {
      throw new CodexPluginLauncherError(
        "RUNTIME_EXITED_EARLY",
        "Windows runtime exited before launch environment delivery completed",
      );
    }
    return {
      kill: (signal) => {
        process.kill(pid!, signal);
      },
      pid,
      unref: () => undefined,
    };
  } catch (error) {
    if (pid != null && isProcessAlive(pid)) process.kill(pid, "SIGKILL");
    throw error;
  } finally {
    await launchPipe.close();
  }
}

async function launchRuntimeProcess(options: {
  cwd: string;
  entryPath: string;
  environment: NodeJS.ProcessEnv;
  useWindowsBreakaway: boolean;
}): Promise<RuntimeProcessHandle> {
  if (process.platform === "win32" && options.useWindowsBreakaway) {
    return await launchWindowsBreakawayRuntime(options);
  }
  const child = spawn(
    spawnFilesystemPath(process.execPath),
    [options.entryPath],
    {
      cwd: spawnFilesystemPath(options.cwd),
      detached: true,
      env: options.environment,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("error", rejectSpawn);
    child.once("spawn", resolveSpawn);
  });
  if (child.pid == null) {
    throw new CodexPluginLauncherError(
      "RUNTIME_SPAWN_FAILED",
      "runtime process did not expose a pid after spawn",
    );
  }
  return {
    kill: (signal) => {
      child.kill(signal);
    },
    pid: child.pid,
    unref: () => child.unref(),
  };
}

async function extractRuntimeArchive(
  archivePath: string,
  payloadRoot: string,
): Promise<void> {
  await mkdir(payloadRoot, { mode: 0o700, recursive: true });
  if (process.platform === "darwin") {
    await runCommand("ditto", ["-x", "-k", archivePath, payloadRoot]);
    return;
  }
  if (process.platform === "win32") {
    const invocation = windowsRuntimeArchiveExtractionInvocation(
      archivePath,
      payloadRoot,
    );
    await runCommand(
      invocation.command,
      invocation.args,
    );
    return;
  }
  throw new CodexPluginLauncherError(
    "RUNTIME_EXTRACT_UNSUPPORTED",
    `Codex plugin runtime archive extraction is unsupported on ${process.platform}`,
  );
}

async function acquireRuntimeArtifact(options: {
  fetchImpl: typeof fetch;
  manifest: CodexPluginAcquisitionManifestV1;
  storePaths: ReturnType<typeof resolveDistributionRuntimeStorePaths>;
}): Promise<{ entryPath: string; reused: boolean }> {
  const versionPaths = resolveDistributionRuntimeVersionPaths({
    runtimeDigest: options.manifest.runtimeDigest,
    runtimeVersion: options.manifest.runtimeVersion,
    storePaths: options.storePaths,
  });
  const entryPath = join(
    versionPaths.payloadRoot,
    ...options.manifest.artifact.entryPath.split("/"),
  );
  const archiveArtifactPath = join(versionPaths.versionRoot, "artifact.zip");
  const installedArtifactPath =
    options.manifest.artifact.mediaType === CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.ZIP_V1
      ? archiveArtifactPath
      : entryPath;
  if (await pathExists(installedArtifactPath)) {
    await verifyRuntimeArtifact(installedArtifactPath, options.manifest);
    if (!(await pathExists(entryPath))) {
      throw new CodexPluginLauncherError(
        "RUNTIME_ENTRY_MISSING",
        `installed runtime entry is missing: ${options.manifest.artifact.entryPath}`,
      );
    }
    return { entryPath, reused: true };
  }

  const response = await options.fetchImpl(options.manifest.artifact.url, {
    headers: { accept: options.manifest.artifact.mediaType },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new CodexPluginLauncherError(
      "RUNTIME_DOWNLOAD_FAILED",
      `runtime artifact returned HTTP ${response.status}`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (bytes.byteLength !== options.manifest.artifact.size
    || digest !== options.manifest.artifact.digest) {
    throw new CodexPluginLauncherError(
      "RUNTIME_ARTIFACT_MISMATCH",
      "downloaded runtime artifact size or digest does not match the manifest",
    );
  }

  const stagingRoot = join(
    options.storePaths.stagingRoot,
    opaqueId("acquire"),
  );
  const stagingPayloadRoot = join(stagingRoot, "payload");
  const stagingEntryPath = join(
    stagingPayloadRoot,
    ...options.manifest.artifact.entryPath.split("/"),
  );
  if (options.manifest.artifact.mediaType === CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.ZIP_V1) {
    const stagingArchivePath = join(stagingRoot, "artifact.zip");
    await mkdir(stagingRoot, { mode: 0o700, recursive: true });
    await writeFile(stagingArchivePath, bytes, { mode: 0o600 });
    await extractRuntimeArchive(stagingArchivePath, stagingPayloadRoot);
    if (!(await pathExists(stagingEntryPath))) {
      throw new CodexPluginLauncherError(
        "RUNTIME_ENTRY_MISSING",
        `runtime archive does not contain ${options.manifest.artifact.entryPath}`,
      );
    }
  } else {
    await mkdir(dirname(stagingEntryPath), { mode: 0o700, recursive: true });
    await writeFile(stagingEntryPath, bytes, { mode: 0o700 });
  }
  await writeJsonAtomic(join(stagingRoot, "manifest.json"), options.manifest);
  await mkdir(dirname(versionPaths.versionRoot), { mode: 0o700, recursive: true });
  try {
    await rename(stagingRoot, versionPaths.versionRoot);
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY"].includes(
      (error as NodeJS.ErrnoException).code ?? "",
    )) {
      throw error;
    }
    await rm(stagingRoot, { force: true, recursive: true });
  }
  await verifyRuntimeArtifact(installedArtifactPath, options.manifest);
  if (!(await pathExists(entryPath))) {
    throw new CodexPluginLauncherError(
      "RUNTIME_ENTRY_MISSING",
      `installed runtime entry is missing: ${options.manifest.artifact.entryPath}`,
    );
  }
  return { entryPath, reused: false };
}

async function readCompatibleActiveRuntime(options: {
  shellVersion: string;
  storePaths: ReturnType<typeof resolveDistributionRuntimeStorePaths>;
}): Promise<{
  manifest: CodexPluginAcquisitionManifestV1;
  pointer: DistributionRuntimePointerV1;
} | null> {
  const pointer = await readParsedJsonIfExists({
    code: "RUNTIME_ACTIVE_STATE_INVALID",
    label: "active runtime pointer",
    parse: parseDistributionRuntimePointer,
    path: options.storePaths.activePath,
  });
  if (pointer == null) return null;
  const versionPaths = resolveDistributionRuntimeVersionPaths({
    runtimeDigest: pointer.runtimeDigest,
    runtimeVersion: pointer.runtimeVersion,
    storePaths: options.storePaths,
  });
  const manifest = await readParsedJsonIfExists({
    code: "RUNTIME_MANIFEST_STATE_INVALID",
    label: "installed runtime manifest",
    parse: parseCodexPluginAcquisitionManifest,
    path: versionPaths.manifestPath,
  });
  if (manifest == null) {
    throw new CodexPluginLauncherError(
      "RUNTIME_MANIFEST_STATE_INVALID",
      `active runtime manifest is missing for ${pointer.runtimeVersion}`,
    );
  }
  const identity = runtimeIdentityFromManifest(manifest);
  try {
    assertSameDistributionRuntimeIdentity(pointer, identity);
  } catch (error) {
    throw new CodexPluginLauncherError(
      "RUNTIME_MANIFEST_STATE_INVALID",
      `installed runtime manifest does not match active pointer: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    compareCodexPluginShellVersions(
      options.shellVersion,
      manifest.control.codexPlugin.version.min,
    ) < 0
  ) {
    return null;
  }
  return { manifest, pointer };
}

async function waitForRuntimeReady(
  path: string,
  child: RuntimeProcessHandle,
  timeoutMs: number,
): Promise<ReturnType<typeof parseCodexPluginRuntimeReady>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const raw = await readJsonIfExists(path);
    if (raw != null) return parseCodexPluginRuntimeReady(raw);
    if (!isProcessAlive(child.pid)) {
      throw new CodexPluginLauncherError(
        "RUNTIME_EXITED_EARLY",
        "runtime exited before writing its ready handoff",
      );
    }
    await sleep(50);
  }
  throw new CodexPluginLauncherError(
    "RUNTIME_READY_TIMEOUT",
    `runtime did not become ready within ${timeoutMs}ms`,
  );
}

async function stopFailedRuntime(child: RuntimeProcessHandle): Promise<void> {
  const pid = child.pid;
  if (!isProcessAlive(pid)) return;
  child.kill("SIGTERM");
  const startedAt = Date.now();
  while (isProcessAlive(pid) && Date.now() - startedAt < 5_000) {
    await sleep(50);
  }
  if (!isProcessAlive(pid)) return;
  child.kill("SIGKILL");
  const forcedAt = Date.now();
  while (isProcessAlive(pid) && Date.now() - forcedAt < 2_000) {
    await sleep(50);
  }
  if (isProcessAlive(pid)) {
    throw new CodexPluginLauncherError(
      "RUNTIME_STOP_FAILED",
      `owned runtime pid ${pid} did not exit`,
    );
  }
}

function sameRuntimeIdentity(
  left: DistributionRuntimeIdentityV1,
  right: DistributionRuntimeIdentityV1,
): boolean {
  try {
    assertSameDistributionRuntimeIdentity(left, right);
    return true;
  } catch {
    return false;
  }
}

function updateCheckError(error: unknown): {
  code: string;
  message: string;
} {
  return {
    code: error instanceof CodexPluginLauncherError
      ? error.code
      : "RUNTIME_UPDATE_CHECK_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

export class CodexPluginRuntimeLauncher {
  private readonly fetchImpl: typeof fetch;
  private readonly identity: DistributionIdentityV1;
  private readonly manifestUrl: string;
  private readonly shellVersion: string;
  private readonly suitePaths: DistributionSuitePaths;
  private session: RuntimeSession | null = null;
  private updateCheckGeneration = 0;
  private updateCheckPromise: Promise<void> | null = null;
  private updateStatus: CodexPluginUpdateCheckV1 | null = null;

  constructor(options: {
    fetchImpl?: typeof fetch;
    identity: DistributionIdentityV1;
    manifestUrl: string;
    shellVersion: string;
    suitePaths: DistributionSuitePaths;
  }) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.identity = options.identity;
    this.manifestUrl = options.manifestUrl;
    this.shellVersion = options.shellVersion;
    this.suitePaths = options.suitePaths;
  }

  private createUpdateStatus(options:
    | {
        active: DistributionRuntimeIdentityV1;
        state:
          | typeof CODEX_PLUGIN_UPDATE_CHECK_STATES.CURRENT
          | typeof CODEX_PLUGIN_UPDATE_CHECK_STATES.DEFERRED;
      }
    | {
        active?: DistributionRuntimeIdentityV1;
        candidate: DistributionRuntimeIdentityV1;
        minimumShellVersion: string;
        shellUpdateUrl?: string;
        state: typeof CODEX_PLUGIN_UPDATE_CHECK_STATES.AVAILABLE;
      }
    | {
        active?: DistributionRuntimeIdentityV1;
        error: unknown;
        state: typeof CODEX_PLUGIN_UPDATE_CHECK_STATES.UNAVAILABLE;
      }
  ): CodexPluginUpdateCheckV1 {
    return parseCodexPluginUpdateCheck({
      ...("active" in options && options.active != null
        ? { active: runtimeIdentityFromRuntime(options.active) }
        : {}),
      ...("candidate" in options
        ? {
            candidate: runtimeIdentityFromRuntime(options.candidate),
          }
        : {}),
      ...("error" in options
        ? { error: updateCheckError(options.error) }
        : {}),
      ...("minimumShellVersion" in options
        ? { minimumShellVersion: options.minimumShellVersion }
        : {}),
      schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
      ...("shellUpdateUrl" in options && options.shellUpdateUrl != null
        ? { shellUpdateUrl: options.shellUpdateUrl }
        : {}),
      state: options.state,
      updatedAt: new Date().toISOString(),
    });
  }

  private async persistUpdateStatus(
    status: CodexPluginUpdateCheckV1,
    generation = this.updateCheckGeneration,
  ): Promise<void> {
    if (generation !== this.updateCheckGeneration) return;
    this.updateStatus = status;
    const shellPaths = resolveCodexPluginShellPaths(this.suitePaths);
    await writeJsonAtomic(shellPaths.updateCheckPath, status);
  }

  async readUpdateStatus(): Promise<CodexPluginUpdateCheckV1 | null> {
    if (this.updateStatus != null) return this.updateStatus;
    const shellPaths = resolveCodexPluginShellPaths(this.suitePaths);
    const status = await readParsedJsonIfExists({
      code: "RUNTIME_UPDATE_STATE_INVALID",
      label: "runtime update check state",
      parse: parseCodexPluginUpdateCheck,
      path: shellPaths.updateCheckPath,
    });
    this.updateStatus = status;
    return status;
  }

  private async fetchRequestedManifest(
    timeoutMs: number,
  ): Promise<CodexPluginAcquisitionManifestV1> {
    let raw: unknown;
    try {
      raw = await fetchJson(this.manifestUrl, this.fetchImpl, timeoutMs);
    } catch (error) {
      throw error;
    }
    let manifest: CodexPluginAcquisitionManifestV1;
    try {
      manifest = parseCodexPluginAcquisitionManifest(raw);
    } catch (error) {
      throw new CodexPluginLauncherError(
        "RUNTIME_MANIFEST_INVALID",
        `requested runtime manifest is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const requestedIdentity = runtimeIdentityFromManifest(manifest);
    assertRuntimeCoordinates(this.identity, requestedIdentity);
    return manifest;
  }

  private updateStatusForManifest(options: {
    active?: DistributionRuntimeIdentityV1;
    manifest: CodexPluginAcquisitionManifestV1;
  }): CodexPluginUpdateCheckV1 {
    const candidate = runtimeIdentityFromManifest(options.manifest);
    if (
      options.active != null
      && sameRuntimeIdentity(options.active, candidate)
    ) {
      return this.createUpdateStatus({
        active: options.active,
        state: CODEX_PLUGIN_UPDATE_CHECK_STATES.CURRENT,
      });
    }
    return this.createUpdateStatus({
      ...(options.active == null ? {} : { active: options.active }),
      candidate,
      minimumShellVersion:
        options.manifest.control.codexPlugin.version.min,
      ...(options.manifest.control.codexPlugin.version.url == null
        ? {}
        : {
            shellUpdateUrl:
              options.manifest.control.codexPlugin.version.url,
          }),
      state: CODEX_PLUGIN_UPDATE_CHECK_STATES.AVAILABLE,
    });
  }

  private scheduleBackgroundUpdateCheck(
    active: DistributionRuntimeIdentityV1,
  ): CodexPluginUpdateCheckV1 {
    const deferred = this.createUpdateStatus({
      active,
      state: CODEX_PLUGIN_UPDATE_CHECK_STATES.DEFERRED,
    });
    this.updateStatus = deferred;
    if (this.updateCheckPromise != null) return deferred;
    const generation = ++this.updateCheckGeneration;
    const shellPaths = resolveCodexPluginShellPaths(this.suitePaths);
    const pending = (async () => {
      await this.persistUpdateStatus(deferred, generation);
      try {
        const manifest = await this.fetchRequestedManifest(
          CODEX_PLUGIN_FIRST_MANIFEST_TIMEOUT_MS,
        );
        if (generation !== this.updateCheckGeneration) return;
        await writeJsonAtomic(shellPaths.acquisitionPath, manifest);
        await this.persistUpdateStatus(this.updateStatusForManifest({
          active,
          manifest,
        }), generation);
      } catch (error) {
        await this.persistUpdateStatus(this.createUpdateStatus({
          active,
          error,
          state: CODEX_PLUGIN_UPDATE_CHECK_STATES.UNAVAILABLE,
        }), generation).catch(() => undefined);
      }
    })().catch(() => undefined).finally(() => {
      if (this.updateCheckPromise === pending) {
        this.updateCheckPromise = null;
      }
    });
    this.updateCheckPromise = pending;
    return deferred;
  }

  private async settleUpdateStatusForBinding(
    status: CodexPluginUpdateCheckV1,
    binding: DistributionRuntimeBindingV1,
    generation: number,
  ): Promise<CodexPluginUpdateCheckV1> {
    if (
      status.state !== CODEX_PLUGIN_UPDATE_CHECK_STATES.AVAILABLE
      || status.candidate == null
      || !sameRuntimeIdentity(status.candidate, binding)
    ) {
      return status;
    }
    const current = this.createUpdateStatus({
      active: binding,
      state: CODEX_PLUGIN_UPDATE_CHECK_STATES.CURRENT,
    });
    await this.persistUpdateStatus(current, generation);
    return current;
  }

  async stopOwnedRuntime(): Promise<void> {
    const session = this.session;
    if (session?.child == null) return;
    await stopFailedRuntime(session.child);
    const storePaths = resolveDistributionRuntimeStorePaths(this.suitePaths);
    const binding = await readParsedJsonIfExists({
      code: "RUNTIME_BINDING_STATE_INVALID",
      label: "runtime binding state",
      parse: parseDistributionRuntimeBinding,
      path: storePaths.bindingPath,
    });
    if (binding != null) {
      if (
        binding.owner.shellType === DISTRIBUTION_SHELL_TYPES.CODEX_PLUGIN
        && binding.owner.pid === session.binding.owner.pid
      ) {
        await rm(storePaths.bindingPath, { force: true });
      }
    }
    this.session = null;
  }

  async ensureRuntime(): Promise<CodexPluginRuntimeEnsureResult> {
    const storePaths = resolveDistributionRuntimeStorePaths(this.suitePaths);
    const shellPaths = resolveCodexPluginShellPaths(this.suitePaths);
    const activeRuntime = await readCompatibleActiveRuntime({
      shellVersion: this.shellVersion,
      storePaths,
    });
    if (activeRuntime != null) {
      assertRuntimeCoordinates(this.identity, activeRuntime.pointer);
    }

    if (activeRuntime != null && this.session != null) {
      if (
        !sameRuntimeIdentity(activeRuntime.pointer, this.session.binding)
        && isProcessAlive(this.session.binding.owner.pid)
      ) {
        throw new CodexPluginLauncherError(
          "INCOMPATIBLE_RUNTIME_ACTIVE",
          "an incompatible Open Design runtime is active for this channel and namespace",
        );
      }
      if (
        sameRuntimeIdentity(activeRuntime.pointer, this.session.binding)
        && await observeBinding(this.session.binding, this.fetchImpl)
      ) {
        const updateCheck = this.scheduleBackgroundUpdateCheck(
          activeRuntime.pointer,
        );
        return {
          attached: true,
          binding: this.session.binding,
          handoff: null,
          manifest: activeRuntime.manifest,
          reusedArtifact: true,
          updateCheck,
        };
      }
      if (isProcessAlive(this.session.binding.owner.pid)) {
        throw new CodexPluginLauncherError(
          "RUNTIME_BINDING_UNHEALTHY",
          `the compatible Open Design runtime pid ${this.session.binding.owner.pid} is alive but not observable`,
        );
      }
      this.session = null;
    }

    if (activeRuntime != null) {
      const existingActive = await readCompatibleBinding({
        expected: activeRuntime.pointer,
        fetchImpl: this.fetchImpl,
        path: storePaths.bindingPath,
      });
      if (existingActive != null) {
        this.session = { binding: existingActive, child: null };
        const updateCheck = this.scheduleBackgroundUpdateCheck(
          activeRuntime.pointer,
        );
        return {
          attached: true,
          binding: existingActive,
          handoff: null,
          manifest: activeRuntime.manifest,
          reusedArtifact: true,
          updateCheck,
        };
      }
    }

    const updateGeneration = ++this.updateCheckGeneration;
    let requestedManifest: CodexPluginAcquisitionManifestV1 | null = null;
    let updateCheck: CodexPluginUpdateCheckV1;
    try {
      requestedManifest = await this.fetchRequestedManifest(
        activeRuntime == null
          ? CODEX_PLUGIN_FIRST_MANIFEST_TIMEOUT_MS
          : CODEX_PLUGIN_ACTIVE_MANIFEST_TIMEOUT_MS,
      );
      await writeJsonAtomic(shellPaths.acquisitionPath, requestedManifest);
      updateCheck = this.updateStatusForManifest({
        ...(activeRuntime == null ? {} : { active: activeRuntime.pointer }),
        manifest: requestedManifest,
      });
      await this.persistUpdateStatus(updateCheck, updateGeneration);
    } catch (error) {
      updateCheck = this.createUpdateStatus({
        ...(activeRuntime == null ? {} : { active: activeRuntime.pointer }),
        error,
        state: CODEX_PLUGIN_UPDATE_CHECK_STATES.UNAVAILABLE,
      });
      await this.persistUpdateStatus(updateCheck, updateGeneration);
      if (activeRuntime == null) {
        throw new CodexPluginLauncherError(
          "RUNTIME_UNAVAILABLE",
          `no compatible local runtime is installed and the requested runtime is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    let armAttempt = false;
    let manifest: CodexPluginAcquisitionManifestV1;
    if (
      requestedManifest != null
      && compareCodexPluginShellVersions(
        this.shellVersion,
        requestedManifest.control.codexPlugin.version.min,
      ) < 0
    ) {
      if (activeRuntime == null) {
        throw new CodexPluginLauncherError(
          "SHELL_VERSION_TOO_OLD",
          `Codex plugin ${this.shellVersion} is below required ${requestedManifest.control.codexPlugin.version.min} and no compatible runtime fallback is installed`,
        );
      }
      manifest = activeRuntime.manifest;
    } else {
      const attempted = await readParsedJsonIfExists({
        code: "RUNTIME_ATTEMPT_STATE_INVALID",
        label: "runtime attempt state",
        parse: parseDistributionRuntimeAttempt,
        path: storePaths.attemptPath,
      });
      if (attempted != null) {
        try {
          assertRuntimeCoordinates(this.identity, attempted);
        } catch (error) {
          throw new CodexPluginLauncherError(
            "RUNTIME_ATTEMPT_STATE_INVALID",
            `runtime attempt coordinates are invalid: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      const requestedIdentity = requestedManifest == null
        ? null
        : runtimeIdentityFromManifest(requestedManifest);
      const selection = selectDistributionRuntimeTarget({
        active: activeRuntime?.pointer ?? null,
        attempted,
        requested: requestedIdentity,
      });
      if (selection.selected === "active" && activeRuntime != null) {
        manifest = activeRuntime.manifest;
      } else if (selection.selected === "requested" && requestedManifest != null) {
        manifest = requestedManifest;
        armAttempt = true;
      } else {
        throw new CodexPluginLauncherError(
          "RUNTIME_UNAVAILABLE",
          "no compatible local or requested Codex plugin runtime is available",
        );
      }
    }
    const expected = runtimeIdentityFromManifest(manifest);
    assertRuntimeCoordinates(this.identity, expected);

    if (
      this.session != null
      && await observeBinding(this.session.binding, this.fetchImpl)
    ) {
      assertSameDistributionRuntimeIdentity(expected, this.session.binding);
      updateCheck = await this.settleUpdateStatusForBinding(
        updateCheck,
        this.session.binding,
        updateGeneration,
      );
      return {
        attached: true,
        binding: this.session.binding,
        handoff: null,
        manifest,
        reusedArtifact: true,
        updateCheck,
      };
    }

    const existing = await readCompatibleBinding({
      expected,
      fetchImpl: this.fetchImpl,
      path: storePaths.bindingPath,
    });
    if (existing != null) {
      this.session = { binding: existing, child: null };
      updateCheck = await this.settleUpdateStatusForBinding(
        updateCheck,
        existing,
        updateGeneration,
      );
      return {
        attached: true,
        binding: existing,
        handoff: null,
        manifest,
        reusedArtifact: true,
        updateCheck,
      };
    }

    const acquisition = await acquireRuntimeLeaseOrAttach({
      bindingPath: storePaths.bindingPath,
      channel: expected.channel,
      expected,
      fetchImpl: this.fetchImpl,
      leasePath: storePaths.leasePath,
      lockRoot: storePaths.lockRoot,
      namespace: expected.namespace,
    });
    if (acquisition.binding != null) {
      this.session = { binding: acquisition.binding, child: null };
      updateCheck = await this.settleUpdateStatusForBinding(
        updateCheck,
        acquisition.binding,
        updateGeneration,
      );
      return {
        attached: true,
        binding: acquisition.binding,
        handoff: null,
        manifest,
        reusedArtifact: true,
        updateCheck,
      };
    }
    const lease = acquisition.lease;
    let child: RuntimeProcessHandle | null = null;
    const handoffId = opaqueId("handoff");
    const resumeToken = randomBytes(32).toString("base64url");
    const accessToken = expected.protocolVersion >= 2
      ? randomBytes(32).toString("base64url")
      : null;
    const handoffPath = join(shellPaths.handoffsRoot, `${handoffId}.json`);
    const readyPath = join(shellPaths.handoffsRoot, `${handoffId}.ready.json`);
    const createdAt = new Date().toISOString();
    let handoff = parseCodexPluginHandoffDescriptor({
      channel: expected.channel,
      createdAt,
      handoffId,
      namespace: expected.namespace,
      resumeTokenDigest: tokenDigest(resumeToken),
      runtime: {
        protocolVersion: expected.protocolVersion,
        runtimeDigest: expected.runtimeDigest,
        runtimeVersion: expected.runtimeVersion,
      },
      schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
      shell: {
        pid: process.pid,
        version: this.shellVersion,
      },
      state: CODEX_PLUGIN_HANDOFF_STATES.PREPARED,
      updatedAt: createdAt,
    });
    await writeJsonAtomic(handoffPath, handoff);

    try {
      const concurrent = await readCompatibleBinding({
        expected,
        fetchImpl: this.fetchImpl,
        path: storePaths.bindingPath,
      });
      if (concurrent != null) {
        this.session = { binding: concurrent, child: null };
        updateCheck = await this.settleUpdateStatusForBinding(
          updateCheck,
          concurrent,
          updateGeneration,
        );
        await releaseRuntimeLease({
          lease,
          leasePath: storePaths.leasePath,
          lockRoot: storePaths.lockRoot,
        });
        return {
          attached: true,
          binding: concurrent,
          handoff: null,
          manifest,
          reusedArtifact: true,
          updateCheck,
        };
      }
      await removeDeadRuntimeBinding({ path: storePaths.bindingPath });

      const acquired = await acquireRuntimeArtifact({
        fetchImpl: this.fetchImpl,
        manifest,
        storePaths,
      });
      if (armAttempt) {
        const attempt: DistributionRuntimeAttemptV1 = {
          ...expected,
          attemptedAt: new Date().toISOString(),
          schemaVersion: DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
        };
        await writeJsonAtomic(storePaths.attemptPath, attempt);
      }
      handoff = parseCodexPluginHandoffDescriptor({
        ...handoff,
        state: CODEX_PLUGIN_HANDOFF_STATES.ACQUIRED,
        updatedAt: new Date().toISOString(),
      });
      await writeJsonAtomic(handoffPath, handoff);

      child = await launchRuntimeProcess({
        cwd: dirname(acquired.entryPath),
        entryPath: acquired.entryPath,
        environment: {
          ...process.env,
          ...(accessToken == null
            ? {}
            : { [CODEX_PLUGIN_RUNTIME_ENV.ACCESS_TOKEN]: accessToken }),
          [CODEX_PLUGIN_RUNTIME_ENV.CHANNEL]: expected.channel,
          [CODEX_PLUGIN_RUNTIME_ENV.DATA_ROOT]: this.suitePaths.dataRoot,
          [CODEX_PLUGIN_RUNTIME_ENV.HANDOFF_ID]: handoffId,
          [CODEX_PLUGIN_RUNTIME_ENV.HANDOFF_TOKEN]: resumeToken,
          [CODEX_PLUGIN_RUNTIME_ENV.LOGS_ROOT]: this.suitePaths.logsRoot,
          [CODEX_PLUGIN_RUNTIME_ENV.NAMESPACE]: expected.namespace,
          [CODEX_PLUGIN_RUNTIME_ENV.PROTOCOL_VERSION]:
            expected.protocolVersion.toString(),
          [CODEX_PLUGIN_RUNTIME_ENV.READY_PATH]: readyPath,
          [CODEX_PLUGIN_RUNTIME_ENV.RUNTIME_DIGEST]: expected.runtimeDigest,
          [CODEX_PLUGIN_RUNTIME_ENV.RUNTIME_VERSION]: expected.runtimeVersion,
        },
        useWindowsBreakaway:
          manifest.artifact.mediaType === CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.ZIP_V1,
      });
      const ready = await waitForRuntimeReady(
        readyPath,
        child,
        CODEX_PLUGIN_RUNTIME_READY_TIMEOUT_MS,
      )
        .finally(async () => {
          await rm(readyPath, { force: true });
        });
      if (
        ready.handoffId !== handoffId
        || ready.resumeTokenDigest !== tokenDigest(resumeToken)
        || ready.pid !== child.pid
      ) {
        throw new CodexPluginLauncherError(
          "RUNTIME_READY_MISMATCH",
          "runtime ready message does not match the prepared handoff",
        );
      }
      handoff = parseCodexPluginHandoffDescriptor({
        ...handoff,
        runtime: {
          ...handoff.runtime,
          endpointUrl: ready.endpointUrl,
          pid: ready.pid,
        },
        state: CODEX_PLUGIN_HANDOFF_STATES.LAUNCHED,
        updatedAt: new Date().toISOString(),
      });
      await writeJsonAtomic(handoffPath, handoff);

      const observed = normalizeDistributionRuntimeIdentity(
        await fetchJson(ready.endpointUrl, this.fetchImpl, 5_000),
      );
      assertSameDistributionRuntimeIdentity(expected, observed);
      const previousPointer = await readParsedJsonIfExists({
        code: "RUNTIME_ACTIVE_STATE_INVALID",
        label: "active runtime pointer",
        parse: parseDistributionRuntimePointer,
        path: storePaths.activePath,
      });
      if (
        previousPointer != null
        && (
          previousPointer.channel !== expected.channel
          || previousPointer.namespace !== expected.namespace
        )
      ) {
        throw new CodexPluginLauncherError(
          "RUNTIME_POINTER_COORDINATE_MISMATCH",
          "active runtime pointer does not belong to this channel and namespace",
        );
      }
      const now = new Date().toISOString();
      const pointer: DistributionRuntimePointerV1 = {
        ...expected,
        generation: (previousPointer?.generation ?? -1) + 1,
        schemaVersion: DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
        updatedAt: now,
      };
      const binding: DistributionRuntimeBindingV1 = {
        ...expected,
        endpointUrl: ready.endpointUrl,
        generation: pointer.generation,
        owner: {
          pid: ready.pid,
          shellType: DISTRIBUTION_SHELL_TYPES.CODEX_PLUGIN,
        },
        schemaVersion: DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
        startedAt: now,
        updatedAt: now,
      };
      if (accessToken == null) {
        await rm(shellPaths.accessPath, { force: true });
      } else {
        await writeJsonAtomic(shellPaths.accessPath, {
          ...expected,
          accessToken,
          schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
        });
      }
      await writeJsonAtomic(storePaths.bindingPath, binding);
      await writeJsonAtomic(storePaths.activePath, pointer);
      if (armAttempt) await rm(storePaths.attemptPath, { force: true });
      handoff = parseCodexPluginHandoffDescriptor({
        ...handoff,
        state: CODEX_PLUGIN_HANDOFF_STATES.CONFIRMED,
        updatedAt: new Date().toISOString(),
      });
      await writeJsonAtomic(handoffPath, handoff);
      child.unref();
      this.session = { binding, child };
      updateCheck = await this.settleUpdateStatusForBinding(
        updateCheck,
        binding,
        updateGeneration,
      );
      await releaseRuntimeLease({
        lease,
        leasePath: storePaths.leasePath,
        lockRoot: storePaths.lockRoot,
      });
      return {
        attached: false,
        binding,
        handoff,
        manifest,
        reusedArtifact: acquired.reused,
        updateCheck,
      };
    } catch (error) {
      if (child != null) await stopFailedRuntime(child);
      await rm(readyPath, { force: true }).catch(() => undefined);
      const failed = parseCodexPluginHandoffDescriptor({
        ...handoff,
        error: {
          code: error instanceof CodexPluginLauncherError
            ? error.code
            : "RUNTIME_HANDOFF_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
        runtime: {
          protocolVersion: handoff.runtime.protocolVersion,
          runtimeDigest: handoff.runtime.runtimeDigest,
          runtimeVersion: handoff.runtime.runtimeVersion,
        },
        state: CODEX_PLUGIN_HANDOFF_STATES.FAILED,
        updatedAt: new Date().toISOString(),
      });
      await writeJsonAtomic(handoffPath, failed).catch(() => undefined);
      await releaseRuntimeLease({
        lease,
        leasePath: storePaths.leasePath,
        lockRoot: storePaths.lockRoot,
      }).catch(() => undefined);
      throw error;
    }
  }
}
