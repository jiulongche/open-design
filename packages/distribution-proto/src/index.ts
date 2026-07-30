import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import {
  isReleaseChannel,
  parseReleaseVersion,
  type ReleaseChannel,
} from "@open-design/release";
import { normalizeNamespace } from "@open-design/sidecar-proto";

export const DISTRIBUTION_REPORT_SCHEMA_VERSION = 1 as const;
export const DISTRIBUTION_RUNTIME_SCHEMA_VERSION = 1 as const;
export const DISTRIBUTION_DEFAULT_RUNTIME_LEASE_TTL_MS = 120_000 as const;

export const DISTRIBUTION_SHELL_TYPES = Object.freeze({
  CODEX_PLUGIN: "codex-plugin",
  DESKTOP: "desktop",
} as const);

export type DistributionShellType =
  (typeof DISTRIBUTION_SHELL_TYPES)[keyof typeof DISTRIBUTION_SHELL_TYPES];

export type DistributionRuntimeIdentityV1 = {
  channel: ReleaseChannel;
  namespace: string;
  protocolVersion: number;
  runtimeDigest: string;
  runtimeVersion: string;
};

export type DistributionIdentityV1 = DistributionRuntimeIdentityV1 & {
  shellDigest: string;
  shellType: DistributionShellType;
  shellVersion: string;
};

export const DISTRIBUTION_SUITE_PATH_ERROR_CODES = Object.freeze({
  DATA_ROOT_NAMESPACE_MISMATCH: "DATA_ROOT_NAMESPACE_MISMATCH",
  DATA_ROOT_NOT_ABSOLUTE: "DATA_ROOT_NOT_ABSOLUTE",
} as const);

export type DistributionSuitePathErrorCode =
  (typeof DISTRIBUTION_SUITE_PATH_ERROR_CODES)[keyof typeof DISTRIBUTION_SUITE_PATH_ERROR_CODES];

export type DistributionSuitePathRequest = {
  channel: unknown;
  dataDir?: string | null;
  homeDir?: string;
  namespace: unknown;
  namespaceBaseRoot: string;
  platform?: NodeJS.Platform;
};

export type DistributionSuitePaths = {
  cacheRoot: string;
  channel: ReleaseChannel;
  channelRoot: string;
  dataRoot: string;
  logsRoot: string;
  namespace: string;
  namespaceBaseRoot: string;
  namespaceRoot: string;
  runtimeRoot: string;
  updatesRoot: string;
};

export type DistributionRuntimeStorePaths = {
  activePath: string;
  attemptPath: string;
  bindingPath: string;
  downloadsRoot: string;
  leasePath: string;
  lockRoot: string;
  stagingRoot: string;
  stateRoot: string;
  storeRoot: string;
  versionsRoot: string;
};

export type DistributionRuntimeVersionPathRequest = {
  runtimeDigest: unknown;
  runtimeVersion: unknown;
  storePaths: DistributionRuntimeStorePaths;
};

export type DistributionRuntimeVersionPaths = DistributionRuntimeStorePaths & {
  manifestPath: string;
  payloadRoot: string;
  runtimeDigest: string;
  runtimeVersion: string;
  versionRoot: string;
};

export type DistributionRuntimePointerV1 = {
  channel: ReleaseChannel;
  generation: number;
  namespace: string;
  protocolVersion: number;
  runtimeDigest: string;
  runtimeVersion: string;
  schemaVersion: typeof DISTRIBUTION_RUNTIME_SCHEMA_VERSION;
  updatedAt: string;
};

export type DistributionRuntimeAttemptV1 = DistributionRuntimeIdentityV1 & {
  attemptedAt: string;
  schemaVersion: typeof DISTRIBUTION_RUNTIME_SCHEMA_VERSION;
};

export type DistributionRuntimeTargetSelection =
  | {
      reason: "active-offline" | "active-after-failed-attempt";
      selected: "active";
    }
  | {
      reason: "failed-attempt-without-fallback" | "no-runtime-target";
      selected: null;
    }
  | {
      reason: "requested";
      selected: "requested";
    };

export type DistributionRuntimeLeaseV1 = {
  acquiredAt: string;
  channel: ReleaseChannel;
  expiresAt: string;
  leaseId: string;
  namespace: string;
  owner: {
    pid: number;
    shellType: DistributionShellType;
  };
  schemaVersion: typeof DISTRIBUTION_RUNTIME_SCHEMA_VERSION;
};

export type DistributionRuntimeBindingV1 = DistributionRuntimeIdentityV1 & {
  endpointUrl: string;
  generation: number;
  owner: {
    pid: number;
    shellType: DistributionShellType;
  };
  schemaVersion: typeof DISTRIBUTION_RUNTIME_SCHEMA_VERSION;
  startedAt: string;
  updatedAt: string;
};

export type DistributionArtifactInventoryV1 = {
  digest: string;
  files: string[];
  size: number;
};

export type DistributionArtifactEntry = {
  bytes: Uint8Array;
  path: string;
};

export type DistributionBuildPathsV1 = {
  artifactRoot: string;
  manifestPath: string;
  shellRoot: string;
};

export type DistributionRuntimeArtifactBuildV1 = {
  digest: string;
  entryPath: string;
  path: string;
  size: number;
};

export type DistributionBuildReportV1 = {
  artifact: DistributionArtifactInventoryV1;
  identity: DistributionIdentityV1;
  paths: DistributionBuildPathsV1;
  runtimeArtifact?: DistributionRuntimeArtifactBuildV1;
  schemaVersion: typeof DISTRIBUTION_REPORT_SCHEMA_VERSION;
};

export type DistributionServeReportV1 = {
  endpointUrl: string;
  healthUrl: string;
  identity: DistributionIdentityV1;
  schemaVersion: typeof DISTRIBUTION_REPORT_SCHEMA_VERSION;
};

export class DistributionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DistributionProtocolError";
  }
}

export class DistributionSuitePathError extends DistributionProtocolError {
  readonly activeNamespace?: string;
  readonly code: DistributionSuitePathErrorCode;
  readonly configuredNamespace?: string;
  readonly configuredValue: string;

  constructor(options: {
    activeNamespace?: string;
    code: DistributionSuitePathErrorCode;
    configuredNamespace?: string;
    configuredValue: string;
    message: string;
  }) {
    super(options.message);
    this.name = "DistributionSuitePathError";
    this.activeNamespace = options.activeNamespace;
    this.code = options.code;
    this.configuredNamespace = options.configuredNamespace;
    this.configuredValue = options.configuredValue;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new DistributionProtocolError(`${label} must be an object`);
  return value;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unsupported.length > 0) {
    throw new DistributionProtocolError(
      `${label} contains unsupported fields: ${unsupported.join(", ")}`,
    );
  }
}

function normalizePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new DistributionProtocolError(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizeNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DistributionProtocolError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeIsoDate(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Number.isNaN(Date.parse(value))
  ) {
    throw new DistributionProtocolError(`${label} must be an ISO date string`);
  }
  return value;
}

function normalizeDistributionOpaqueId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value)
  ) {
    throw new DistributionProtocolError(
      `${label} must be 16-128 URL-safe characters`,
    );
  }
  return value;
}

export function normalizeDistributionChannel(value: unknown): ReleaseChannel {
  if (typeof value !== "string") {
    throw new DistributionProtocolError("distribution channel must be a string");
  }
  if (value !== value.trim()) {
    throw new DistributionProtocolError(
      "distribution channel must not contain leading or trailing whitespace",
    );
  }
  if (!isReleaseChannel(value)) {
    throw new DistributionProtocolError(`unsupported distribution channel: ${value}`);
  }
  return value;
}

export function normalizeDistributionNamespace(value: unknown): string {
  try {
    return normalizeNamespace(value);
  } catch (error) {
    throw new DistributionProtocolError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

const HOME_BARE_TOKENS = new Set(["~", "$HOME", "${HOME}"]);
const HOME_PREFIX_RE = /^(~|\$\{HOME\}|\$HOME)[/\\](.*)$/;

function expandDistributionHomePrefix(raw: string, home: string): string {
  if (HOME_BARE_TOKENS.has(raw)) return home;
  const match = HOME_PREFIX_RE.exec(raw);
  if (match) return join(home, match[2] ?? "");
  return raw;
}

function scopedDistributionDataRootNamespace(raw: string): string | null {
  const parts = raw.replace(/[\\/]+$/g, "").split(/[\\/]+/);
  const last = parts.length - 1;
  if (last < 2) return null;
  if (parts[last - 2] !== "namespaces" || parts[last] !== "data") return null;
  return parts[last - 1] ?? null;
}

function normalizeDistributionNamespaceBaseRoot(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DistributionProtocolError(
      "distribution namespace base root must be a non-empty string",
    );
  }
  if (value.includes("\0")) {
    throw new DistributionProtocolError(
      "distribution namespace base root must not contain null bytes",
    );
  }
  return value;
}

export function resolveDistributionSuitePaths(
  request: DistributionSuitePathRequest,
): DistributionSuitePaths {
  const channel = normalizeDistributionChannel(request.channel);
  const namespace = normalizeDistributionNamespace(request.namespace);
  const namespaceBaseRoot = normalizeDistributionNamespaceBaseRoot(
    request.namespaceBaseRoot,
  );
  const channelRoot = join(namespaceBaseRoot, "..");
  const namespaceRoot = join(namespaceBaseRoot, namespace);
  const configuredDataDir = request.dataDir?.trim();
  let dataRoot = join(namespaceRoot, "data");

  if (configuredDataDir != null && configuredDataDir.length > 0) {
    const expanded = expandDistributionHomePrefix(
      configuredDataDir,
      request.homeDir ?? homedir(),
    );
    const platform = request.platform ?? process.platform;
    const absolute = platform === "win32"
      ? win32.isAbsolute(expanded)
      : posix.isAbsolute(expanded);
    if (!absolute) {
      throw new DistributionSuitePathError({
        code: DISTRIBUTION_SUITE_PATH_ERROR_CODES.DATA_ROOT_NOT_ABSOLUTE,
        configuredValue: configuredDataDir,
        message: `distribution data root must be absolute: ${configuredDataDir}`,
      });
    }
    const configuredNamespace = scopedDistributionDataRootNamespace(expanded);
    if (configuredNamespace != null && configuredNamespace !== namespace) {
      throw new DistributionSuitePathError({
        activeNamespace: namespace,
        code: DISTRIBUTION_SUITE_PATH_ERROR_CODES.DATA_ROOT_NAMESPACE_MISMATCH,
        configuredNamespace,
        configuredValue: configuredDataDir,
        message:
          `distribution data root namespace ${configuredNamespace} does not match ${namespace}`,
      });
    }
    dataRoot = configuredNamespace == null
      ? join(expanded, "namespaces", namespace, "data")
      : expanded;
  }

  return {
    cacheRoot: join(namespaceRoot, "cache"),
    channel,
    channelRoot,
    dataRoot,
    logsRoot: join(namespaceRoot, "logs"),
    namespace,
    namespaceBaseRoot,
    namespaceRoot,
    runtimeRoot: join(namespaceRoot, "runtime"),
    updatesRoot: join(namespaceRoot, "updates"),
  };
}

export function resolveDistributionRuntimeStorePaths(
  suitePaths: DistributionSuitePaths,
): DistributionRuntimeStorePaths {
  const storeRoot = join(suitePaths.runtimeRoot, "store");
  const stateRoot = join(storeRoot, "state");
  const runtimeUpdatesRoot = join(suitePaths.updatesRoot, "runtime");
  return {
    activePath: join(stateRoot, "active.json"),
    attemptPath: join(stateRoot, "attempt.json"),
    bindingPath: join(stateRoot, "binding.json"),
    downloadsRoot: join(runtimeUpdatesRoot, "downloads"),
    leasePath: join(stateRoot, "lock", "lease.json"),
    lockRoot: join(stateRoot, "lock"),
    stagingRoot: join(runtimeUpdatesRoot, "staging"),
    stateRoot,
    storeRoot,
    versionsRoot: join(storeRoot, "versions"),
  };
}

export function normalizeDistributionVersion(value: unknown, label = "version"): string {
  if (typeof value !== "string") {
    throw new DistributionProtocolError(`${label} must be a string`);
  }
  if (value.length === 0) {
    throw new DistributionProtocolError(`${label} must not be empty`);
  }
  if (value !== value.trim() || /\s/.test(value)) {
    throw new DistributionProtocolError(`${label} must not contain whitespace`);
  }
  if (value.includes("\0")) {
    throw new DistributionProtocolError(`${label} must not contain null bytes`);
  }
  if (/[\\/]/.test(value) || isAbsolute(value)) {
    throw new DistributionProtocolError(`${label} must not contain path separators`);
  }
  if (value === "." || value === ".." || value.includes("..")) {
    throw new DistributionProtocolError(`${label} must not contain relative path segments`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new DistributionProtocolError(`${label} must be an exact semantic version`);
  }
  return value;
}

export function normalizeDistributionRuntimeVersion(
  value: unknown,
  channel: ReleaseChannel,
): string {
  const version = normalizeDistributionVersion(value, "runtime version");
  try {
    parseReleaseVersion(version, channel);
  } catch (error) {
    throw new DistributionProtocolError(
      error instanceof Error ? error.message : String(error),
    );
  }
  return version;
}

export function normalizeDistributionRuntimeIdentity(
  value: unknown,
): DistributionRuntimeIdentityV1 {
  const record = assertRecord(value, "distribution runtime identity");
  assertAllowedKeys(record, [
    "channel",
    "namespace",
    "protocolVersion",
    "runtimeDigest",
    "runtimeVersion",
  ], "distribution runtime identity");
  const channel = normalizeDistributionChannel(record.channel);
  return {
    channel,
    namespace: normalizeDistributionNamespace(record.namespace),
    protocolVersion: normalizePositiveInteger(record.protocolVersion, "protocol version"),
    runtimeDigest: normalizeDistributionDigest(record.runtimeDigest, "runtime digest"),
    runtimeVersion: normalizeDistributionRuntimeVersion(record.runtimeVersion, channel),
  };
}

export function distributionRuntimeIdentityKey(
  identity: DistributionRuntimeIdentityV1,
): string {
  const normalized = normalizeDistributionRuntimeIdentity({
    channel: identity.channel,
    namespace: identity.namespace,
    protocolVersion: identity.protocolVersion,
    runtimeDigest: identity.runtimeDigest,
    runtimeVersion: identity.runtimeVersion,
  });
  return [
    normalized.channel,
    normalized.namespace,
    normalized.runtimeVersion,
    normalized.runtimeDigest,
    normalized.protocolVersion.toString(),
  ].join("|");
}

export function assertSameDistributionRuntimeIdentity(
  expected: DistributionRuntimeIdentityV1,
  actual: DistributionRuntimeIdentityV1,
): void {
  const expectedKey = distributionRuntimeIdentityKey(expected);
  const actualKey = distributionRuntimeIdentityKey(actual);
  if (expectedKey !== actualKey) {
    throw new DistributionProtocolError(
      `distribution runtime identity mismatch: expected ${expectedKey}; got ${actualKey}`,
    );
  }
}

export function normalizeDistributionDigest(value: unknown, label = "digest"): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new DistributionProtocolError(
      `${label} must use the sha256:<64 lowercase hex characters> form`,
    );
  }
  return value;
}

export function resolveDistributionRuntimeVersionPaths(
  request: DistributionRuntimeVersionPathRequest,
): DistributionRuntimeVersionPaths {
  const runtimeVersion = normalizeDistributionVersion(
    request.runtimeVersion,
    "runtime version",
  );
  const runtimeDigest = normalizeDistributionDigest(
    request.runtimeDigest,
    "runtime digest",
  );
  const versionRoot = join(
    request.storePaths.versionsRoot,
    runtimeVersion,
    runtimeDigest.slice("sha256:".length),
  );
  return {
    ...request.storePaths,
    manifestPath: join(versionRoot, "manifest.json"),
    payloadRoot: join(versionRoot, "payload"),
    runtimeDigest,
    runtimeVersion,
    versionRoot,
  };
}

export function parseDistributionRuntimePointer(
  value: unknown,
): DistributionRuntimePointerV1 {
  const record = assertRecord(value, "distribution runtime pointer");
  assertAllowedKeys(record, [
    "channel",
    "generation",
    "namespace",
    "protocolVersion",
    "runtimeDigest",
    "runtimeVersion",
    "schemaVersion",
    "updatedAt",
  ], "distribution runtime pointer");
  if (record.schemaVersion !== DISTRIBUTION_RUNTIME_SCHEMA_VERSION) {
    throw new DistributionProtocolError(
      `unsupported distribution runtime schema version: ${String(record.schemaVersion)}`,
    );
  }
  const channel = normalizeDistributionChannel(record.channel);
  if (
    typeof record.updatedAt !== "string"
    || record.updatedAt.length === 0
    || Number.isNaN(Date.parse(record.updatedAt))
  ) {
    throw new DistributionProtocolError(
      "distribution runtime pointer updatedAt must be an ISO date string",
    );
  }
  return {
    channel,
    generation: normalizeNonNegativeInteger(record.generation, "runtime generation"),
    namespace: normalizeDistributionNamespace(record.namespace),
    protocolVersion: normalizePositiveInteger(record.protocolVersion, "protocol version"),
    runtimeDigest: normalizeDistributionDigest(record.runtimeDigest, "runtime digest"),
    runtimeVersion: normalizeDistributionRuntimeVersion(record.runtimeVersion, channel),
    schemaVersion: DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
    updatedAt: record.updatedAt,
  };
}

export function parseDistributionRuntimeAttempt(
  value: unknown,
): DistributionRuntimeAttemptV1 {
  const record = assertRecord(value, "distribution runtime attempt");
  assertAllowedKeys(record, [
    "attemptedAt",
    "channel",
    "namespace",
    "protocolVersion",
    "runtimeDigest",
    "runtimeVersion",
    "schemaVersion",
  ], "distribution runtime attempt");
  if (record.schemaVersion !== DISTRIBUTION_RUNTIME_SCHEMA_VERSION) {
    throw new DistributionProtocolError(
      `unsupported distribution runtime schema version: ${String(record.schemaVersion)}`,
    );
  }
  return {
    ...normalizeDistributionRuntimeIdentity({
      channel: record.channel,
      namespace: record.namespace,
      protocolVersion: record.protocolVersion,
      runtimeDigest: record.runtimeDigest,
      runtimeVersion: record.runtimeVersion,
    }),
    attemptedAt: normalizeIsoDate(
      record.attemptedAt,
      "distribution runtime attempt attemptedAt",
    ),
    schemaVersion: DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
  };
}

function sameDistributionRuntimeIdentity(
  first: DistributionRuntimeIdentityV1,
  second: DistributionRuntimeIdentityV1,
): boolean {
  return distributionRuntimeIdentityKey(first)
    === distributionRuntimeIdentityKey(second);
}

/**
 * Selects a runtime target without owning filesystem or process lifecycle.
 *
 * A confirmed active pointer is the local last-known-good runtime. A matching
 * attempt marks a requested immutable runtime that failed before confirmation,
 * so callers should keep serving active until a different release appears.
 * Without a confirmed fallback, the same failed immutable candidate remains
 * quarantined rather than being launched repeatedly.
 */
export function selectDistributionRuntimeTarget(input: {
  active?: DistributionRuntimePointerV1 | null;
  attempted?: DistributionRuntimeAttemptV1 | null;
  requested?: DistributionRuntimeIdentityV1 | null;
}): DistributionRuntimeTargetSelection {
  const active = input.active ?? null;
  const attempted = input.attempted ?? null;
  const requested = input.requested ?? null;

  if (requested == null) {
    return active == null
      ? { reason: "no-runtime-target", selected: null }
      : { reason: "active-offline", selected: "active" };
  }
  if (
    attempted != null
    && sameDistributionRuntimeIdentity(attempted, requested)
  ) {
    return active == null
      ? { reason: "failed-attempt-without-fallback", selected: null }
      : { reason: "active-after-failed-attempt", selected: "active" };
  }
  return { reason: "requested", selected: "requested" };
}

export function parseDistributionRuntimeLease(
  value: unknown,
): DistributionRuntimeLeaseV1 {
  const record = assertRecord(value, "distribution runtime lease");
  assertAllowedKeys(record, [
    "acquiredAt",
    "channel",
    "expiresAt",
    "leaseId",
    "namespace",
    "owner",
    "schemaVersion",
  ], "distribution runtime lease");
  if (record.schemaVersion !== DISTRIBUTION_RUNTIME_SCHEMA_VERSION) {
    throw new DistributionProtocolError(
      `unsupported distribution runtime schema version: ${String(record.schemaVersion)}`,
    );
  }
  const acquiredAt = normalizeIsoDate(record.acquiredAt, "runtime lease acquiredAt");
  const expiresAt = normalizeIsoDate(record.expiresAt, "runtime lease expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(acquiredAt)) {
    throw new DistributionProtocolError(
      "distribution runtime lease expiresAt must be after acquiredAt",
    );
  }
  const owner = assertRecord(record.owner, "distribution runtime lease owner");
  assertAllowedKeys(owner, ["pid", "shellType"], "distribution runtime lease owner");
  return {
    acquiredAt,
    channel: normalizeDistributionChannel(record.channel),
    expiresAt,
    leaseId: normalizeDistributionOpaqueId(record.leaseId, "runtime lease id"),
    namespace: normalizeDistributionNamespace(record.namespace),
    owner: {
      pid: normalizePositiveInteger(owner.pid, "runtime lease owner pid"),
      shellType: normalizeDistributionShellType(owner.shellType),
    },
    schemaVersion: DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
  };
}

export function normalizeDistributionRuntimeEndpointUrl(
  value: unknown,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DistributionProtocolError(
      "distribution runtime endpoint URL must be a non-empty string",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DistributionProtocolError(
      "distribution runtime endpoint URL must be valid",
    );
  }
  if (
    url.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username.length > 0
    || url.password.length > 0
    || url.hash.length > 0
  ) {
    throw new DistributionProtocolError(
      "distribution runtime endpoint URL must use credential-free loopback http",
    );
  }
  return url.toString();
}

export function parseDistributionRuntimeBinding(
  value: unknown,
): DistributionRuntimeBindingV1 {
  const record = assertRecord(value, "distribution runtime binding");
  assertAllowedKeys(record, [
    "channel",
    "endpointUrl",
    "generation",
    "namespace",
    "owner",
    "protocolVersion",
    "runtimeDigest",
    "runtimeVersion",
    "schemaVersion",
    "startedAt",
    "updatedAt",
  ], "distribution runtime binding");
  if (record.schemaVersion !== DISTRIBUTION_RUNTIME_SCHEMA_VERSION) {
    throw new DistributionProtocolError(
      `unsupported distribution runtime schema version: ${String(record.schemaVersion)}`,
    );
  }
  const runtimeIdentity = normalizeDistributionRuntimeIdentity({
    channel: record.channel,
    namespace: record.namespace,
    protocolVersion: record.protocolVersion,
    runtimeDigest: record.runtimeDigest,
    runtimeVersion: record.runtimeVersion,
  });
  const owner = assertRecord(record.owner, "distribution runtime binding owner");
  assertAllowedKeys(owner, ["pid", "shellType"], "distribution runtime binding owner");
  return {
    ...runtimeIdentity,
    endpointUrl: normalizeDistributionRuntimeEndpointUrl(record.endpointUrl),
    generation: normalizeNonNegativeInteger(record.generation, "runtime generation"),
    owner: {
      pid: normalizePositiveInteger(owner.pid, "runtime binding owner pid"),
      shellType: normalizeDistributionShellType(owner.shellType),
    },
    schemaVersion: DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
    startedAt: normalizeIsoDate(record.startedAt, "runtime binding startedAt"),
    updatedAt: normalizeIsoDate(record.updatedAt, "runtime binding updatedAt"),
  };
}

export function isDistributionRuntimeLeaseExpired(
  lease: DistributionRuntimeLeaseV1,
  nowMs = Date.now(),
): boolean {
  return Date.parse(lease.expiresAt) <= nowMs;
}

export function normalizeDistributionShellType(value: unknown): DistributionShellType {
  if (value === DISTRIBUTION_SHELL_TYPES.CODEX_PLUGIN) return value;
  if (value === DISTRIBUTION_SHELL_TYPES.DESKTOP) return value;
  throw new DistributionProtocolError(`unsupported distribution shell type: ${String(value)}`);
}

export function normalizeDistributionIdentity(value: unknown): DistributionIdentityV1 {
  const record = assertRecord(value, "distribution identity");
  assertAllowedKeys(record, [
    "channel",
    "namespace",
    "protocolVersion",
    "runtimeDigest",
    "runtimeVersion",
    "shellDigest",
    "shellType",
    "shellVersion",
  ], "distribution identity");

  const runtimeIdentity = normalizeDistributionRuntimeIdentity({
    channel: record.channel,
    namespace: record.namespace,
    protocolVersion: record.protocolVersion,
    runtimeDigest: record.runtimeDigest,
    runtimeVersion: record.runtimeVersion,
  });
  return {
    ...runtimeIdentity,
    shellDigest: normalizeDistributionDigest(record.shellDigest, "shell digest"),
    shellType: normalizeDistributionShellType(record.shellType),
    shellVersion: normalizeDistributionVersion(record.shellVersion, "shell version"),
  };
}

export function distributionIdentityKey(identity: DistributionIdentityV1): string {
  const normalized = normalizeDistributionIdentity(identity);
  return [
    normalized.channel,
    normalized.namespace,
    normalized.runtimeVersion,
    normalized.runtimeDigest,
    normalized.protocolVersion.toString(),
    normalized.shellType,
    normalized.shellVersion,
    normalized.shellDigest,
  ].join("|");
}

export function assertSameDistributionIdentity(
  expected: DistributionIdentityV1,
  actual: DistributionIdentityV1,
): void {
  const expectedKey = distributionIdentityKey(expected);
  const actualKey = distributionIdentityKey(actual);
  if (expectedKey !== actualKey) {
    throw new DistributionProtocolError(
      `distribution identity mismatch: expected ${expectedKey}; got ${actualKey}`,
    );
  }
}

export function normalizeDistributionAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DistributionProtocolError(`${label} must be a non-empty string`);
  }
  if (value.includes("\0")) {
    throw new DistributionProtocolError(`${label} must not contain null bytes`);
  }
  if (!isAbsolute(value)) {
    throw new DistributionProtocolError(`${label} must be absolute: ${value}`);
  }
  return resolve(value);
}

export function assertDistributionPathWithinRoot(
  root: string,
  target: string,
  label: string,
): string {
  const normalizedRoot = normalizeDistributionAbsolutePath(root, "artifact root");
  const normalizedTarget = normalizeDistributionAbsolutePath(target, label);
  const relation = relative(normalizedRoot, normalizedTarget);
  if (
    relation === ".."
    || relation.startsWith(`..${sep}`)
    || isAbsolute(relation)
  ) {
    throw new DistributionProtocolError(`${label} escapes artifact root: ${normalizedTarget}`);
  }
  return normalizedTarget;
}

export function normalizeDistributionInventoryPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DistributionProtocolError("artifact inventory path must be a non-empty string");
  }
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) {
    throw new DistributionProtocolError(
      `artifact inventory path must be a portable relative path: ${value}`,
    );
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new DistributionProtocolError(
      `artifact inventory path contains an invalid segment: ${value}`,
    );
  }
  return value;
}

export function calculateDistributionArtifactInventory(
  entries: readonly DistributionArtifactEntry[],
): DistributionArtifactInventoryV1 {
  const normalized = entries.map((entry) => ({
    bytes: entry.bytes,
    path: normalizeDistributionInventoryPath(entry.path),
  })).sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
  const files = normalized.map((entry) => entry.path);
  if (new Set(files).size !== files.length) {
    throw new DistributionProtocolError("distribution artifact files must be unique");
  }

  const hash = createHash("sha256");
  let size = 0;
  for (const entry of normalized) {
    const pathBytes = Buffer.from(entry.path, "utf8");
    const bytes = Buffer.from(entry.bytes);
    hash.update(Buffer.from(String(pathBytes.byteLength)));
    hash.update(Buffer.from([0]));
    hash.update(pathBytes);
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(bytes.byteLength)));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    size += bytes.byteLength;
  }
  return {
    digest: `sha256:${hash.digest("hex")}`,
    files,
    size,
  };
}

function normalizeArtifactInventory(value: unknown): DistributionArtifactInventoryV1 {
  const record = assertRecord(value, "distribution artifact inventory");
  assertAllowedKeys(record, ["digest", "files", "size"], "distribution artifact inventory");
  if (!Array.isArray(record.files)) {
    throw new DistributionProtocolError("distribution artifact files must be an array");
  }
  const files = record.files.map(normalizeDistributionInventoryPath);
  const sorted = [...files].sort();
  if (files.some((file, index) => file !== sorted[index])) {
    throw new DistributionProtocolError("distribution artifact files must be sorted");
  }
  if (new Set(files).size !== files.length) {
    throw new DistributionProtocolError("distribution artifact files must be unique");
  }
  return {
    digest: normalizeDistributionDigest(record.digest, "artifact digest"),
    files,
    size: normalizeNonNegativeInteger(record.size, "artifact size"),
  };
}

function normalizeBuildPaths(value: unknown): DistributionBuildPathsV1 {
  const record = assertRecord(value, "distribution build paths");
  assertAllowedKeys(
    record,
    ["artifactRoot", "manifestPath", "shellRoot"],
    "distribution build paths",
  );
  const artifactRoot = normalizeDistributionAbsolutePath(
    record.artifactRoot,
    "artifact root",
  );
  const shellRoot = assertDistributionPathWithinRoot(
    artifactRoot,
    normalizeDistributionAbsolutePath(record.shellRoot, "shell root"),
    "shell root",
  );
  const manifestPath = assertDistributionPathWithinRoot(
    shellRoot,
    normalizeDistributionAbsolutePath(record.manifestPath, "manifest path"),
    "manifest path",
  );
  return { artifactRoot, manifestPath, shellRoot };
}

function normalizeRuntimeArtifactBuild(
  value: unknown,
  identity: DistributionIdentityV1,
  paths: DistributionBuildPathsV1,
): DistributionRuntimeArtifactBuildV1 {
  const record = assertRecord(value, "distribution runtime artifact");
  assertAllowedKeys(
    record,
    ["digest", "entryPath", "path", "size"],
    "distribution runtime artifact",
  );
  const digest = normalizeDistributionDigest(record.digest, "runtime artifact digest");
  if (digest !== identity.runtimeDigest) {
    throw new DistributionProtocolError(
      `runtime artifact digest ${digest} does not match runtime digest ${identity.runtimeDigest}`,
    );
  }
  const namespaceRoot = resolve(paths.artifactRoot, "..");
  const path = assertDistributionPathWithinRoot(
    namespaceRoot,
    normalizeDistributionAbsolutePath(record.path, "runtime artifact path"),
    "runtime artifact path",
  );
  return {
    digest,
    entryPath: normalizeDistributionInventoryPath(record.entryPath),
    path,
    size: normalizeNonNegativeInteger(record.size, "runtime artifact size"),
  };
}

function normalizeReportSchemaVersion(value: unknown): typeof DISTRIBUTION_REPORT_SCHEMA_VERSION {
  if (value !== DISTRIBUTION_REPORT_SCHEMA_VERSION) {
    throw new DistributionProtocolError(
      `unsupported distribution report schema version: ${String(value)}`,
    );
  }
  return DISTRIBUTION_REPORT_SCHEMA_VERSION;
}

export function parseDistributionBuildReport(value: unknown): DistributionBuildReportV1 {
  const record = assertRecord(value, "distribution build report");
  assertAllowedKeys(
    record,
    ["artifact", "identity", "paths", "runtimeArtifact", "schemaVersion"],
    "distribution build report",
  );
  const identity = normalizeDistributionIdentity(record.identity);
  const artifact = normalizeArtifactInventory(record.artifact);
  if (artifact.digest !== identity.shellDigest) {
    throw new DistributionProtocolError(
      `artifact digest ${artifact.digest} does not match shell digest ${identity.shellDigest}`,
    );
  }
  const paths = normalizeBuildPaths(record.paths);
  const runtimeArtifact = record.runtimeArtifact == null
    ? null
    : normalizeRuntimeArtifactBuild(record.runtimeArtifact, identity, paths);
  return {
    artifact,
    identity,
    paths,
    ...(runtimeArtifact == null ? {} : { runtimeArtifact }),
    schemaVersion: normalizeReportSchemaVersion(record.schemaVersion),
  };
}

function normalizeLocalHttpUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DistributionProtocolError(`${label} must be a non-empty string`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DistributionProtocolError(`${label} must be a valid URL`);
  }
  if (url.protocol !== "http:") {
    throw new DistributionProtocolError(`${label} must use http for a local fixture`);
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new DistributionProtocolError(`${label} must use a loopback host`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new DistributionProtocolError(`${label} must not contain credentials`);
  }
  return url.toString();
}

export function parseDistributionServeReport(value: unknown): DistributionServeReportV1 {
  const record = assertRecord(value, "distribution serve report");
  assertAllowedKeys(
    record,
    ["endpointUrl", "healthUrl", "identity", "schemaVersion"],
    "distribution serve report",
  );
  return {
    endpointUrl: normalizeLocalHttpUrl(record.endpointUrl, "fixture endpoint URL"),
    healthUrl: normalizeLocalHttpUrl(record.healthUrl, "fixture health URL"),
    identity: normalizeDistributionIdentity(record.identity),
    schemaVersion: normalizeReportSchemaVersion(record.schemaVersion),
  };
}
