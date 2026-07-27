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

export const DISTRIBUTION_SHELL_TYPES = Object.freeze({
  CODEX_PLUGIN: "codex-plugin",
  DESKTOP: "desktop",
} as const);

export type DistributionShellType =
  (typeof DISTRIBUTION_SHELL_TYPES)[keyof typeof DISTRIBUTION_SHELL_TYPES];

export type DistributionIdentityV1 = {
  channel: ReleaseChannel;
  namespace: string;
  protocolVersion: number;
  runtimeDigest: string;
  runtimeVersion: string;
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

export type DistributionBuildReportV1 = {
  artifact: DistributionArtifactInventoryV1;
  identity: DistributionIdentityV1;
  paths: DistributionBuildPathsV1;
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

export function normalizeDistributionDigest(value: unknown, label = "digest"): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new DistributionProtocolError(
      `${label} must use the sha256:<64 lowercase hex characters> form`,
    );
  }
  return value;
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

  const channel = normalizeDistributionChannel(record.channel);
  return {
    channel,
    namespace: normalizeDistributionNamespace(record.namespace),
    protocolVersion: normalizePositiveInteger(record.protocolVersion, "protocol version"),
    runtimeDigest: normalizeDistributionDigest(record.runtimeDigest, "runtime digest"),
    runtimeVersion: normalizeDistributionRuntimeVersion(record.runtimeVersion, channel),
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
    ["artifact", "identity", "paths", "schemaVersion"],
    "distribution build report",
  );
  const identity = normalizeDistributionIdentity(record.identity);
  const artifact = normalizeArtifactInventory(record.artifact);
  if (artifact.digest !== identity.shellDigest) {
    throw new DistributionProtocolError(
      `artifact digest ${artifact.digest} does not match shell digest ${identity.shellDigest}`,
    );
  }
  return {
    artifact,
    identity,
    paths: normalizeBuildPaths(record.paths),
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
