import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  CODEX_PLUGIN_HANDOFF_STATES,
  CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
  CODEX_PLUGIN_RUNTIME_ENV,
  compareCodexPluginShellVersions,
  parseCodexPluginAcquisitionManifest,
  parseCodexPluginHandoffDescriptor,
  parseCodexPluginRuntimeReady,
  resolveCodexPluginShellPaths,
  type CodexPluginAcquisitionManifestV1,
  type CodexPluginHandoffDescriptorV1,
} from "@open-design/codex-plugin-proto";
import {
  DISTRIBUTION_DEFAULT_RUNTIME_LEASE_TTL_MS,
  DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
  DISTRIBUTION_SHELL_TYPES,
  assertSameDistributionRuntimeIdentity,
  isDistributionRuntimeLeaseExpired,
  normalizeDistributionRuntimeIdentity,
  parseDistributionRuntimeBinding,
  parseDistributionRuntimeLease,
  parseDistributionRuntimePointer,
  resolveDistributionRuntimeStorePaths,
  resolveDistributionRuntimeVersionPaths,
  type DistributionIdentityV1,
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
  child: ChildProcess | null;
};

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function tokenDigest(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
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
): Promise<boolean> {
  if (!isProcessAlive(binding.owner.pid)) return false;
  try {
    const actual = normalizeDistributionRuntimeIdentity(
      await fetchJson(binding.endpointUrl, fetchImpl, 2_000),
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
  const raw = await readJsonIfExists(options.path);
  if (raw == null) return null;
  const binding = parseDistributionRuntimeBinding(raw);
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
  const raw = await readJsonIfExists(options.path);
  if (raw == null) return;
  const binding = parseDistributionRuntimeBinding(raw);
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
    const existingRaw = await readJsonIfExists(options.leasePath);
    if (existingRaw == null) {
      throw new CodexPluginLauncherError(
        "RUNTIME_LOCK_UNKNOWN",
        "runtime acquisition lock exists without a readable lease",
      );
    }
    const existing = parseDistributionRuntimeLease(existingRaw);
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

async function releaseRuntimeLease(options: {
  lease: DistributionRuntimeLeaseV1;
  leasePath: string;
  lockRoot: string;
}): Promise<void> {
  const raw = await readJsonIfExists(options.leasePath);
  if (raw == null) return;
  const current = parseDistributionRuntimeLease(raw);
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
  if (await pathExists(entryPath)) {
    await verifyRuntimeArtifact(entryPath, options.manifest);
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
  const stagingEntryPath = join(
    stagingRoot,
    "payload",
    ...options.manifest.artifact.entryPath.split("/"),
  );
  await mkdir(dirname(stagingEntryPath), { mode: 0o700, recursive: true });
  await writeFile(stagingEntryPath, bytes, { mode: 0o700 });
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
  await verifyRuntimeArtifact(entryPath, options.manifest);
  return { entryPath, reused: false };
}

async function readCompatibleFallbackManifest(options: {
  shellVersion: string;
  storePaths: ReturnType<typeof resolveDistributionRuntimeStorePaths>;
}): Promise<CodexPluginAcquisitionManifestV1 | null> {
  const pointerRaw = await readJsonIfExists(options.storePaths.activePath);
  if (pointerRaw == null) return null;
  const pointer = parseDistributionRuntimePointer(pointerRaw);
  const versionPaths = resolveDistributionRuntimeVersionPaths({
    runtimeDigest: pointer.runtimeDigest,
    runtimeVersion: pointer.runtimeVersion,
    storePaths: options.storePaths,
  });
  const manifestRaw = await readJsonIfExists(versionPaths.manifestPath);
  if (manifestRaw == null) return null;
  const manifest = parseCodexPluginAcquisitionManifest(manifestRaw);
  const identity = runtimeIdentityFromManifest(manifest);
  assertSameDistributionRuntimeIdentity(pointer, identity);
  if (
    compareCodexPluginShellVersions(
      options.shellVersion,
      manifest.control.codexPlugin.version.min,
    ) < 0
  ) {
    return null;
  }
  return manifest;
}

async function waitForRuntimeReady(
  path: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<ReturnType<typeof parseCodexPluginRuntimeReady>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const raw = await readJsonIfExists(path);
    if (raw != null) return parseCodexPluginRuntimeReady(raw);
    if (child.pid == null || !isProcessAlive(child.pid)) {
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

async function stopFailedRuntime(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid == null || !isProcessAlive(pid)) return;
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

export class CodexPluginRuntimeLauncher {
  private readonly fetchImpl: typeof fetch;
  private readonly identity: DistributionIdentityV1;
  private readonly manifestUrl: string;
  private readonly shellVersion: string;
  private readonly suitePaths: DistributionSuitePaths;
  private session: RuntimeSession | null = null;

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

  async stopOwnedRuntime(): Promise<void> {
    const session = this.session;
    if (session?.child == null) return;
    await stopFailedRuntime(session.child);
    const storePaths = resolveDistributionRuntimeStorePaths(this.suitePaths);
    const raw = await readJsonIfExists(storePaths.bindingPath);
    if (raw != null) {
      const binding = parseDistributionRuntimeBinding(raw);
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
    const requestedManifest = parseCodexPluginAcquisitionManifest(
      await fetchJson(this.manifestUrl, this.fetchImpl, 5_000),
    );
    const requestedIdentity = runtimeIdentityFromManifest(requestedManifest);
    assertRuntimeCoordinates(this.identity, requestedIdentity);
    const storePaths = resolveDistributionRuntimeStorePaths(this.suitePaths);
    const shellPaths = resolveCodexPluginShellPaths(this.suitePaths);
    await writeJsonAtomic(shellPaths.acquisitionPath, requestedManifest);

    let manifest = requestedManifest;
    if (compareCodexPluginShellVersions(
      this.shellVersion,
      requestedManifest.control.codexPlugin.version.min,
    ) < 0) {
      const fallback = await readCompatibleFallbackManifest({
        shellVersion: this.shellVersion,
        storePaths,
      });
      if (fallback == null) {
        throw new CodexPluginLauncherError(
          "SHELL_VERSION_TOO_OLD",
          `Codex plugin ${this.shellVersion} is below required ${requestedManifest.control.codexPlugin.version.min} and no compatible runtime fallback is installed`,
        );
      }
      manifest = fallback;
    }
    const expected = runtimeIdentityFromManifest(manifest);
    assertRuntimeCoordinates(this.identity, expected);

    if (
      this.session != null
      && await observeBinding(this.session.binding, this.fetchImpl)
    ) {
      assertSameDistributionRuntimeIdentity(expected, this.session.binding);
      return {
        attached: true,
        binding: this.session.binding,
        handoff: null,
        manifest,
        reusedArtifact: true,
      };
    }

    const existing = await readCompatibleBinding({
      expected,
      fetchImpl: this.fetchImpl,
      path: storePaths.bindingPath,
    });
    if (existing != null) {
      this.session = { binding: existing, child: null };
      return {
        attached: true,
        binding: existing,
        handoff: null,
        manifest,
        reusedArtifact: true,
      };
    }

    const lease = await acquireRuntimeLease({
      channel: expected.channel,
      leasePath: storePaths.leasePath,
      lockRoot: storePaths.lockRoot,
      namespace: expected.namespace,
    });
    let child: ChildProcess | null = null;
    const handoffId = opaqueId("handoff");
    const resumeToken = randomBytes(32).toString("base64url");
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
        };
      }
      await removeDeadRuntimeBinding({ path: storePaths.bindingPath });

      const acquired = await acquireRuntimeArtifact({
        fetchImpl: this.fetchImpl,
        manifest,
        storePaths,
      });
      handoff = parseCodexPluginHandoffDescriptor({
        ...handoff,
        state: CODEX_PLUGIN_HANDOFF_STATES.ACQUIRED,
        updatedAt: new Date().toISOString(),
      });
      await writeJsonAtomic(handoffPath, handoff);

      child = spawn(process.execPath, [acquired.entryPath], {
        cwd: dirname(acquired.entryPath),
        detached: true,
        env: {
          ...process.env,
          [CODEX_PLUGIN_RUNTIME_ENV.CHANNEL]: expected.channel,
          [CODEX_PLUGIN_RUNTIME_ENV.DATA_ROOT]: this.suitePaths.dataRoot,
          [CODEX_PLUGIN_RUNTIME_ENV.HANDOFF_ID]: handoffId,
          [CODEX_PLUGIN_RUNTIME_ENV.HANDOFF_TOKEN]: resumeToken,
          [CODEX_PLUGIN_RUNTIME_ENV.NAMESPACE]: expected.namespace,
          [CODEX_PLUGIN_RUNTIME_ENV.PROTOCOL_VERSION]:
            expected.protocolVersion.toString(),
          [CODEX_PLUGIN_RUNTIME_ENV.READY_PATH]: readyPath,
          [CODEX_PLUGIN_RUNTIME_ENV.RUNTIME_DIGEST]: expected.runtimeDigest,
          [CODEX_PLUGIN_RUNTIME_ENV.RUNTIME_VERSION]: expected.runtimeVersion,
        },
        stdio: "ignore",
        windowsHide: true,
      });
      const ready = await waitForRuntimeReady(readyPath, child, 45_000)
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
      const previousPointerRaw = await readJsonIfExists(storePaths.activePath);
      const previousPointer = previousPointerRaw == null
        ? null
        : parseDistributionRuntimePointer(previousPointerRaw);
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
      await writeJsonAtomic(storePaths.bindingPath, binding);
      await writeJsonAtomic(storePaths.activePath, pointer);
      handoff = parseCodexPluginHandoffDescriptor({
        ...handoff,
        state: CODEX_PLUGIN_HANDOFF_STATES.CONFIRMED,
        updatedAt: new Date().toISOString(),
      });
      await writeJsonAtomic(handoffPath, handoff);
      child.unref();
      this.session = { binding, child };
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
