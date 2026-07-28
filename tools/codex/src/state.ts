import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { normalizeDistributionNamespace } from "@open-design/distribution-proto";
import { isProcessAlive } from "@open-design/platform";

export const TOOLS_CODEX_OWNER = "open-design/tools-codex" as const;
export const TOOLS_CODEX_SCHEMA_VERSION = 1 as const;

export type ToolCodexVerifiedRuntimeState = {
  buildReportPath: string;
  distributionChannelRoot: string;
  fixtureReportUrl: string | null;
  identityKey: string;
  runtimeManifestUrl: string;
  verifiedAt: string;
};

export type ToolCodexPreparedState = {
  artifactRoot: string;
  identityKey: string;
  marketplaceName: string;
  preparedAt: string;
  runtime?: ToolCodexVerifiedRuntimeState;
};

export type ToolCodexSentinelV1 = {
  codexHome: string;
  configPolicy: {
    pluginsFeature: "launch-override";
  };
  createdAt: string;
  namespace: string;
  owner: typeof TOOLS_CODEX_OWNER;
  prepared?: ToolCodexPreparedState;
  schemaVersion: typeof TOOLS_CODEX_SCHEMA_VERSION;
};

type ToolCodexRootOwnerV1 = {
  owner: typeof TOOLS_CODEX_OWNER;
  schemaVersion: typeof TOOLS_CODEX_SCHEMA_VERSION;
};

export type ToolCodexRunMarkerV1 = {
  appPath: string;
  codexHome: string;
  desktopUserDataPath: string | null;
  desktopVersion: string | null;
  executablePath: string;
  namespace: string;
  owner: typeof TOOLS_CODEX_OWNER;
  rootPid: number;
  rootStartedAt: string;
  runId: string;
  schemaVersion: typeof TOOLS_CODEX_SCHEMA_VERSION;
  startedAt: string;
  workspace: string;
};

export type ToolCodexGlobalLockV1 = {
  createdAt: string;
  namespace: string;
  operation: string;
  owner: typeof TOOLS_CODEX_OWNER;
  pid: number;
  schemaVersion: typeof TOOLS_CODEX_SCHEMA_VERSION;
};

export type ToolCodexPaths = {
  acceptanceReportPath: string;
  codexHome: string;
  configPath: string;
  controlRoot: string;
  desktopUiObservationPath: string;
  desktopUserDataPath: string;
  globalLockPath: string;
  markerPath: string;
  namespace: string;
  namespaceRoot: string;
  ownerPath: string;
  reportsRoot: string;
  root: string;
  runsRoot: string;
  sentinelPath: string;
  workspaceRoot: string;
};

export class ToolCodexError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolCodexError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function expandHomePrefix(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function defaultToolsCodexRoot(): string {
  return join(homedir(), ".od", "tools-codex");
}

export function resolveToolCodexPaths(options: {
  namespace: string;
  stateRoot?: string;
}): ToolCodexPaths {
  const namespace = normalizeDistributionNamespace(options.namespace);
  const root = resolve(expandHomePrefix(options.stateRoot ?? defaultToolsCodexRoot()));
  const namespaceRoot = join(root, namespace);
  const codexHome = join(namespaceRoot, "codex-home");
  const desktopUserDataPath = join(namespaceRoot, "desktop-user-data");
  const reportsRoot = join(namespaceRoot, "reports");
  return {
    acceptanceReportPath: join(reportsRoot, "acceptance-report.json"),
    codexHome,
    configPath: join(codexHome, "config.toml"),
    controlRoot: join(root, ".control"),
    desktopUiObservationPath: join(reportsRoot, "desktop-ui-observation.json"),
    desktopUserDataPath,
    globalLockPath: join(root, ".control", "desktop.lock"),
    markerPath: join(namespaceRoot, "run-marker.json"),
    namespace,
    namespaceRoot,
    ownerPath: join(root, ".owner.json"),
    reportsRoot,
    root,
    runsRoot: join(namespaceRoot, "runs"),
    sentinelPath: join(namespaceRoot, "sentinel.json"),
    workspaceRoot: join(namespaceRoot, "workspace"),
  };
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

async function assertNotSymlink(path: string, label: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info?.isSymbolicLink() === true) {
    throw new ToolCodexError("UNSAFE_SYMLINK", `${label} must not be a symbolic link: ${path}`);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function parseRootOwner(value: unknown): ToolCodexRootOwnerV1 {
  if (!isRecord(value)
    || value.owner !== TOOLS_CODEX_OWNER
    || value.schemaVersion !== TOOLS_CODEX_SCHEMA_VERSION) {
    throw new ToolCodexError("ROOT_OWNER_MISMATCH", "tools-codex root owner metadata is invalid");
  }
  return {
    owner: TOOLS_CODEX_OWNER,
    schemaVersion: TOOLS_CODEX_SCHEMA_VERSION,
  };
}

function parsePreparedState(value: unknown): ToolCodexPreparedState | undefined {
  if (value == null) return undefined;
  if (!isRecord(value)
    || typeof value.artifactRoot !== "string"
    || typeof value.identityKey !== "string"
    || typeof value.marketplaceName !== "string"
    || typeof value.preparedAt !== "string") {
    throw new ToolCodexError("SENTINEL_INVALID", "tools-codex prepared state is invalid");
  }
  const runtime = parseVerifiedRuntimeState(value.runtime, value.identityKey);
  return {
    artifactRoot: resolve(value.artifactRoot),
    identityKey: value.identityKey,
    marketplaceName: value.marketplaceName,
    preparedAt: value.preparedAt,
    ...(runtime == null ? {} : { runtime }),
  };
}

function parseVerifiedRuntimeState(
  value: unknown,
  preparedIdentityKey: string,
): ToolCodexVerifiedRuntimeState | undefined {
  if (value == null) return undefined;
  if (!isRecord(value)
    || typeof value.buildReportPath !== "string"
    || typeof value.distributionChannelRoot !== "string"
    || (
      value.fixtureReportUrl !== null
      && typeof value.fixtureReportUrl !== "string"
    )
    || typeof value.identityKey !== "string"
    || value.identityKey !== preparedIdentityKey
    || typeof value.runtimeManifestUrl !== "string"
    || typeof value.verifiedAt !== "string") {
    throw new ToolCodexError(
      "SENTINEL_INVALID",
      "tools-codex verified runtime state is invalid",
    );
  }
  return {
    buildReportPath: resolve(value.buildReportPath),
    distributionChannelRoot: resolve(value.distributionChannelRoot),
    fixtureReportUrl: value.fixtureReportUrl,
    identityKey: value.identityKey,
    runtimeManifestUrl: value.runtimeManifestUrl,
    verifiedAt: value.verifiedAt,
  };
}

export function parseToolCodexSentinel(value: unknown, paths: ToolCodexPaths): ToolCodexSentinelV1 {
  if (!isRecord(value)
    || value.owner !== TOOLS_CODEX_OWNER
    || value.schemaVersion !== TOOLS_CODEX_SCHEMA_VERSION
    || value.namespace !== paths.namespace
    || resolve(String(value.codexHome)) !== paths.codexHome
    || typeof value.createdAt !== "string"
    || !isRecord(value.configPolicy)
    || value.configPolicy.pluginsFeature !== "launch-override") {
    throw new ToolCodexError(
      "SENTINEL_INVALID",
      `tools-codex sentinel does not own ${paths.namespaceRoot}`,
    );
  }
  const prepared = parsePreparedState(value.prepared);
  return {
    codexHome: paths.codexHome,
    configPolicy: { pluginsFeature: "launch-override" },
    createdAt: value.createdAt,
    namespace: paths.namespace,
    owner: TOOLS_CODEX_OWNER,
    ...(prepared == null ? {} : { prepared }),
    schemaVersion: TOOLS_CODEX_SCHEMA_VERSION,
  };
}

export function parseToolCodexRunMarker(value: unknown, paths: ToolCodexPaths): ToolCodexRunMarkerV1 {
  if (!isRecord(value)
    || value.owner !== TOOLS_CODEX_OWNER
    || value.schemaVersion !== TOOLS_CODEX_SCHEMA_VERSION
    || value.namespace !== paths.namespace
    || resolve(String(value.codexHome)) !== paths.codexHome
    || typeof value.appPath !== "string"
    || (
      value.desktopUserDataPath !== null
      && (
        typeof value.desktopUserDataPath !== "string"
        || resolve(value.desktopUserDataPath) !== paths.desktopUserDataPath
      )
    )
    || typeof value.executablePath !== "string"
    || typeof value.rootPid !== "number"
    || !Number.isSafeInteger(value.rootPid)
    || value.rootPid < 1
    || typeof value.rootStartedAt !== "string"
    || typeof value.runId !== "string"
    || typeof value.startedAt !== "string"
    || typeof value.workspace !== "string"
    || (value.desktopVersion != null && typeof value.desktopVersion !== "string")) {
    throw new ToolCodexError("RUN_MARKER_INVALID", "tools-codex run marker is invalid");
  }
  return {
    appPath: resolve(value.appPath),
    codexHome: paths.codexHome,
    desktopUserDataPath: value.desktopUserDataPath == null
      ? null
      : paths.desktopUserDataPath,
    desktopVersion: value.desktopVersion ?? null,
    executablePath: resolve(value.executablePath),
    namespace: paths.namespace,
    owner: TOOLS_CODEX_OWNER,
    rootPid: value.rootPid,
    rootStartedAt: value.rootStartedAt,
    runId: value.runId,
    schemaVersion: TOOLS_CODEX_SCHEMA_VERSION,
    startedAt: value.startedAt,
    workspace: resolve(value.workspace),
  };
}

export async function readToolCodexSentinel(paths: ToolCodexPaths): Promise<ToolCodexSentinelV1> {
  try {
    await assertNotSymlink(paths.root, "tools-codex root");
    await assertNotSymlink(paths.controlRoot, "tools-codex control root");
    await assertNotSymlink(paths.namespaceRoot, "tools-codex namespace root");
    await assertNotSymlink(paths.codexHome, "tools-codex Codex home");
    await assertNotSymlink(
      paths.desktopUserDataPath,
      "tools-codex Desktop user-data root",
    );
    await assertNotSymlink(paths.reportsRoot, "tools-codex reports root");
    await assertNotSymlink(paths.runsRoot, "tools-codex runs root");
    await assertNotSymlink(paths.workspaceRoot, "tools-codex workspace root");
    parseRootOwner(await readJson(paths.ownerPath));
    return parseToolCodexSentinel(await readJson(paths.sentinelPath), paths);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ToolCodexError(
        "SENTINEL_INVALID",
        "tools-codex owner or sentinel metadata is unreadable",
      );
    }
    throw error;
  }
}

export async function readToolCodexRunMarker(paths: ToolCodexPaths): Promise<ToolCodexRunMarkerV1 | null> {
  try {
    return parseToolCodexRunMarker(await readJson(paths.markerPath), paths);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ToolCodexError("RUN_MARKER_INVALID", "tools-codex run marker is unreadable");
    if (error instanceof ToolCodexError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function ensureRootOwnership(paths: ToolCodexPaths): Promise<void> {
  await assertNotSymlink(paths.root, "tools-codex root");
  const rootExists = await pathExists(paths.root);
  if (!rootExists) {
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await chmod(paths.root, 0o700);
    await writeJsonAtomic(paths.ownerPath, {
      owner: TOOLS_CODEX_OWNER,
      schemaVersion: TOOLS_CODEX_SCHEMA_VERSION,
    } satisfies ToolCodexRootOwnerV1);
    return;
  }

  if (await pathExists(paths.ownerPath)) {
    parseRootOwner(await readJson(paths.ownerPath));
    await chmod(paths.root, 0o700);
    return;
  }

  const entries = await readdir(paths.root);
  if (entries.length > 0) {
    throw new ToolCodexError(
      "ROOT_UNOWNED",
      `refusing to adopt non-empty tools-codex root without owner metadata: ${paths.root}`,
    );
  }
  await chmod(paths.root, 0o700);
  await writeJsonAtomic(paths.ownerPath, {
    owner: TOOLS_CODEX_OWNER,
    schemaVersion: TOOLS_CODEX_SCHEMA_VERSION,
  } satisfies ToolCodexRootOwnerV1);
}

export async function initializeToolCodexEnvironment(
  paths: ToolCodexPaths,
  now = new Date(),
): Promise<{ created: boolean; sentinel: ToolCodexSentinelV1 }> {
  await ensureRootOwnership(paths);
  await assertNotSymlink(paths.controlRoot, "tools-codex control root");
  await mkdir(paths.controlRoot, { recursive: true, mode: 0o700 });
  await chmod(paths.controlRoot, 0o700);
  await assertNotSymlink(paths.namespaceRoot, "tools-codex namespace root");

  if (await pathExists(paths.namespaceRoot)) {
    return {
      created: false,
      sentinel: await readToolCodexSentinel(paths),
    };
  }

  await mkdir(paths.namespaceRoot, { mode: 0o700 });
  for (const directory of [
    paths.codexHome,
    paths.desktopUserDataPath,
    paths.reportsRoot,
    paths.runsRoot,
    paths.workspaceRoot,
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const sentinel: ToolCodexSentinelV1 = {
    codexHome: paths.codexHome,
    configPolicy: { pluginsFeature: "launch-override" },
    createdAt: now.toISOString(),
    namespace: paths.namespace,
    owner: TOOLS_CODEX_OWNER,
    schemaVersion: TOOLS_CODEX_SCHEMA_VERSION,
  };
  await writeJsonAtomic(paths.sentinelPath, sentinel);
  return { created: true, sentinel };
}

export async function updateToolCodexSentinel(
  paths: ToolCodexPaths,
  update: (current: ToolCodexSentinelV1) => ToolCodexSentinelV1,
): Promise<ToolCodexSentinelV1> {
  const next = update(await readToolCodexSentinel(paths));
  const normalized = parseToolCodexSentinel(next, paths);
  await writeJsonAtomic(paths.sentinelPath, normalized);
  return normalized;
}

export async function writeToolCodexReport(
  paths: ToolCodexPaths,
  path: string,
  value: unknown,
): Promise<void> {
  await readToolCodexSentinel(paths);
  const resolvedPath = resolveToolCodexReportPath(paths, path);
  await writeJsonAtomic(resolvedPath, value);
}

export function resolveToolCodexReportPath(
  paths: ToolCodexPaths,
  path: string,
): string {
  const resolvedPath = resolve(path);
  if (dirname(resolvedPath) !== paths.reportsRoot) {
    throw new ToolCodexError(
      "REPORT_PATH_INVALID",
      `tools-codex reports must be direct children of ${paths.reportsRoot}`,
    );
  }
  return resolvedPath;
}

export async function writeToolCodexRunMarker(
  paths: ToolCodexPaths,
  marker: ToolCodexRunMarkerV1,
): Promise<void> {
  parseToolCodexRunMarker(marker, paths);
  await writeJsonAtomic(paths.markerPath, marker);
}

export async function removeToolCodexRunMarker(paths: ToolCodexPaths): Promise<void> {
  await unlink(paths.markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function parseGlobalLock(value: unknown): ToolCodexGlobalLockV1 {
  if (!isRecord(value)
    || value.owner !== TOOLS_CODEX_OWNER
    || value.schemaVersion !== TOOLS_CODEX_SCHEMA_VERSION
    || typeof value.createdAt !== "string"
    || typeof value.namespace !== "string"
    || typeof value.operation !== "string"
    || typeof value.pid !== "number"
    || !Number.isSafeInteger(value.pid)
    || value.pid < 1) {
    throw new ToolCodexError("GLOBAL_LOCK_INVALID", "tools-codex global lock is invalid");
  }
  return {
    createdAt: value.createdAt,
    namespace: value.namespace,
    operation: value.operation,
    owner: TOOLS_CODEX_OWNER,
    pid: value.pid,
    schemaVersion: TOOLS_CODEX_SCHEMA_VERSION,
  };
}

export async function readToolCodexGlobalLock(paths: ToolCodexPaths): Promise<ToolCodexGlobalLockV1 | null> {
  try {
    return parseGlobalLock(await readJson(paths.globalLockPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function clearKnownStaleGlobalLock(paths: ToolCodexPaths): Promise<boolean> {
  const lock = await readToolCodexGlobalLock(paths);
  if (lock == null) return false;
  if (isProcessAlive(lock.pid)) {
    throw new ToolCodexError(
      "GLOBAL_LOCK_ACTIVE",
      `tools-codex ${lock.operation} is active in pid ${lock.pid}`,
      { lock },
    );
  }
  await unlink(paths.globalLockPath);
  return true;
}

export async function acquireToolCodexGlobalLock(
  paths: ToolCodexPaths,
  operation: string,
): Promise<{ lock: ToolCodexGlobalLockV1; release(): Promise<void> }> {
  await readToolCodexSentinel(paths);
  await mkdir(paths.controlRoot, { recursive: true, mode: 0o700 });
  let handle: FileHandle;
  try {
    handle = await open(paths.globalLockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const lock = await readToolCodexGlobalLock(paths).catch(() => null);
      throw new ToolCodexError(
        "GLOBAL_LOCKED",
        lock == null
          ? "tools-codex global lock exists but is unreadable"
          : `tools-codex ${lock.operation} is already active in pid ${lock.pid}`,
        lock == null ? undefined : { lock },
      );
    }
    throw error;
  }
  const lock: ToolCodexGlobalLockV1 = {
    createdAt: new Date().toISOString(),
    namespace: paths.namespace,
    operation,
    owner: TOOLS_CODEX_OWNER,
    pid: process.pid,
    schemaVersion: TOOLS_CODEX_SCHEMA_VERSION,
  };
  await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
  await handle.sync();
  let released = false;
  return {
    lock,
    async release() {
      if (released) return;
      released = true;
      await handle.close();
      await unlink(paths.globalLockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}

export async function resetToolCodexDirectory(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}
