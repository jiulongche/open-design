import { join } from "node:path";

import {
  normalizeDistributionChannel,
  normalizeDistributionDigest,
  normalizeDistributionInventoryPath,
  normalizeDistributionNamespace,
  normalizeDistributionRuntimeIdentity,
  normalizeDistributionRuntimeVersion,
  normalizeDistributionVersion,
  parseDistributionServeReport,
  type DistributionRuntimeIdentityV1,
  type DistributionServeReportV1,
  type DistributionSuitePaths,
} from "@open-design/distribution-proto";

export type CodexPluginChannel = ReturnType<typeof normalizeDistributionChannel>;

export const CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION = 1 as const;

export const CODEX_PLUGIN_ARGS = Object.freeze({
  DISTRIBUTION_CHANNEL_ROOT: "--distribution-channel-root",
  RUNTIME_MANIFEST_URL: "--runtime-manifest-url",
} as const);

export const CODEX_PLUGIN_ENV = Object.freeze({
  DISTRIBUTION_CHANNEL_ROOT: "OD_DISTRIBUTION_CHANNEL_ROOT",
  RUNTIME_MANIFEST_URL: "OD_CODEX_PLUGIN_RUNTIME_MANIFEST_URL",
} as const);

export const CODEX_PLUGIN_RUNTIME_ENV = Object.freeze({
  CHANNEL: "OD_DISTRIBUTION_CHANNEL",
  DATA_ROOT: "OD_DATA_DIR",
  HANDOFF_ID: "OD_CODEX_PLUGIN_HANDOFF_ID",
  HANDOFF_TOKEN: "OD_CODEX_PLUGIN_HANDOFF_TOKEN",
  LOGS_ROOT: "OD_CODEX_PLUGIN_LOGS_ROOT",
  NAMESPACE: "OD_DISTRIBUTION_NAMESPACE",
  PROTOCOL_VERSION: "OD_DISTRIBUTION_PROTOCOL_VERSION",
  READY_PATH: "OD_CODEX_PLUGIN_READY_PATH",
  RUNTIME_DIGEST: "OD_DISTRIBUTION_RUNTIME_DIGEST",
  RUNTIME_VERSION: "OD_DISTRIBUTION_RUNTIME_VERSION",
} as const);

export const CODEX_PLUGIN_RUNTIME_MEDIA_TYPES = Object.freeze({
  NODE_MODULE_V1: "application/vnd.open-design.runtime.node-module-v1",
  ZIP_V1: "application/vnd.open-design.runtime.zip-v1",
} as const);

export const CODEX_PLUGIN_PLATFORM_TARGETS = Object.freeze({
  DARWIN_ARM64: "darwin-arm64",
  WIN32_X64: "win32-x64",
} as const);

export type CodexPluginPlatformTarget =
  (typeof CODEX_PLUGIN_PLATFORM_TARGETS)[keyof typeof CODEX_PLUGIN_PLATFORM_TARGETS];

export type CodexPluginRuntimeMediaType =
  (typeof CODEX_PLUGIN_RUNTIME_MEDIA_TYPES)[keyof typeof CODEX_PLUGIN_RUNTIME_MEDIA_TYPES];

export type CodexPluginReleasePaths = {
  latestRuntimeManifestPath: string;
  root: string;
  runtimeArtifactPath: string;
};

export const CODEX_PLUGIN_HANDOFF_STATES = Object.freeze({
  ACQUIRED: "acquired",
  CONFIRMED: "confirmed",
  FAILED: "failed",
  LAUNCHED: "launched",
  PREPARED: "prepared",
} as const);

export type CodexPluginHandoffState =
  (typeof CODEX_PLUGIN_HANDOFF_STATES)[keyof typeof CODEX_PLUGIN_HANDOFF_STATES];

export const CODEX_PLUGIN_UPDATE_CHECK_STATES = Object.freeze({
  AVAILABLE: "available",
  CURRENT: "current",
  DEFERRED: "deferred",
  UNAVAILABLE: "unavailable",
} as const);

export type CodexPluginUpdateCheckState =
  (typeof CODEX_PLUGIN_UPDATE_CHECK_STATES)[keyof typeof CODEX_PLUGIN_UPDATE_CHECK_STATES];

export type CodexPluginRuntimeArtifactV1 = {
  digest: string;
  entryPath: string;
  mediaType: CodexPluginRuntimeMediaType;
  size: number;
  url: string;
};

export type CodexPluginAcquisitionManifestV1 = {
  artifact: CodexPluginRuntimeArtifactV1;
  channel: CodexPluginChannel;
  control: {
    codexPlugin: {
      version: {
        min: string;
        url?: string;
      };
    };
  };
  namespace: string;
  protocolVersion: number;
  runtimeDigest: string;
  runtimeVersion: string;
  schemaVersion: typeof CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION;
};

export type CodexPluginShellPaths = {
  acquisitionPath: string;
  cacheRoot: string;
  handoffsRoot: string;
  logsRoot: string;
  runtimeRoot: string;
  shellRoot: string;
  stateRoot: string;
  updateCheckPath: string;
  updatesRoot: string;
};

export type CodexPluginUpdateCheckV1 = {
  active?: DistributionRuntimeIdentityV1;
  candidate?: DistributionRuntimeIdentityV1;
  error?: {
    code: string;
    message: string;
  };
  minimumShellVersion?: string;
  schemaVersion: typeof CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION;
  shellUpdateUrl?: string;
  state: CodexPluginUpdateCheckState;
  updatedAt: string;
};

export type CodexPluginHandoffRuntimeV1 = {
  endpointUrl?: string;
  pid?: number;
  protocolVersion: number;
  runtimeDigest: string;
  runtimeVersion: string;
};

export type CodexPluginHandoffDescriptorV1 = {
  channel: CodexPluginChannel;
  createdAt: string;
  error?: {
    code: string;
    message: string;
  };
  handoffId: string;
  namespace: string;
  resumeTokenDigest: string;
  runtime: CodexPluginHandoffRuntimeV1;
  schemaVersion: typeof CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION;
  shell: {
    pid: number;
    version: string;
  };
  state: CodexPluginHandoffState;
  updatedAt: string;
};

export type CodexPluginRuntimeReadyV1 = {
  endpointUrl: string;
  handoffId: string;
  pid: number;
  resumeTokenDigest: string;
  schemaVersion: typeof CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION;
};

export type CodexPluginFixtureReportV1 = DistributionServeReportV1 & {
  runtimeManifestUrl: string;
};

export class CodexPluginProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexPluginProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CodexPluginProtocolError(`${label} must be an object`);
  }
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
    throw new CodexPluginProtocolError(
      `${label} contains unsupported fields: ${unsupported.join(", ")}`,
    );
  }
}

function normalizePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new CodexPluginProtocolError(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizeNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CodexPluginProtocolError(
      `${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

function normalizeIsoDate(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Number.isNaN(Date.parse(value))
  ) {
    throw new CodexPluginProtocolError(`${label} must be an ISO date string`);
  }
  return value;
}

function normalizeHandoffId(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value)
  ) {
    throw new CodexPluginProtocolError(
      "Codex plugin handoff id must be 16-128 URL-safe characters",
    );
  }
  return value;
}

function normalizeErrorCode(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^[A-Z][A-Z0-9_]{2,63}$/.test(value)
  ) {
    throw new CodexPluginProtocolError(
      "Codex plugin error code must use 3-64 uppercase token characters",
    );
  }
  return value;
}

function normalizeNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexPluginProtocolError(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeRuntimeUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexPluginProtocolError(`${label} must be a non-empty URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CodexPluginProtocolError(`${label} must be a valid URL`);
  }
  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
    throw new CodexPluginProtocolError(
      `${label} must not contain credentials or a fragment`,
    );
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CodexPluginProtocolError(
      `${label} must use https or loopback http`,
    );
  }
  return url.toString();
}

function normalizeRuntimeMediaType(value: unknown): CodexPluginRuntimeMediaType {
  if (
    value === CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.NODE_MODULE_V1
    || value === CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.ZIP_V1
  ) {
    return value;
  }
  throw new CodexPluginProtocolError(
    `unsupported Codex plugin runtime media type: ${String(value)}`,
  );
}

export function normalizeCodexPluginPlatformTarget(
  value: unknown,
): CodexPluginPlatformTarget {
  if (
    value === CODEX_PLUGIN_PLATFORM_TARGETS.DARWIN_ARM64
    || value === CODEX_PLUGIN_PLATFORM_TARGETS.WIN32_X64
  ) {
    return value;
  }
  throw new CodexPluginProtocolError(
    `unsupported Codex plugin platform target: ${String(value)}`,
  );
}

export function resolveCodexPluginReleasePaths(options: {
  channel: unknown;
  mediaType: CodexPluginRuntimeMediaType;
  namespace: unknown;
  platform: unknown;
  runtimeVersion: unknown;
}): CodexPluginReleasePaths {
  const channel = normalizeDistributionChannel(options.channel);
  const namespace = normalizeDistributionNamespace(options.namespace);
  const platform = normalizeCodexPluginPlatformTarget(options.platform);
  const runtimeVersion = normalizeDistributionRuntimeVersion(
    options.runtimeVersion,
    channel,
  );
  const mediaType = normalizeRuntimeMediaType(options.mediaType);
  const root = `codex-plugin/${channel}/${namespace}/${platform}`;
  const artifactName =
    mediaType === CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.ZIP_V1
      ? "runtime.zip"
      : "runtime.mjs";
  return {
    latestRuntimeManifestPath: `${root}/latest/runtime.json`,
    root,
    runtimeArtifactPath:
      `${root}/versions/${runtimeVersion}/runtime/${artifactName}`,
  };
}

function normalizeHandoffState(value: unknown): CodexPluginHandoffState {
  const states = Object.values(CODEX_PLUGIN_HANDOFF_STATES);
  if (typeof value === "string" && states.includes(value as CodexPluginHandoffState)) {
    return value as CodexPluginHandoffState;
  }
  throw new CodexPluginProtocolError(
    `unsupported Codex plugin handoff state: ${String(value)}`,
  );
}

type ComparableVersion = {
  core: [number, number, number];
  prerelease: string[];
};

function parseComparableVersion(value: string): ComparableVersion {
  const normalized = normalizeDistributionVersion(value, "Codex plugin version");
  const [withoutBuild] = normalized.split("+", 1);
  const separator = withoutBuild!.indexOf("-");
  const core = separator < 0 ? withoutBuild! : withoutBuild!.slice(0, separator);
  const prerelease = separator < 0 ? "" : withoutBuild!.slice(separator + 1);
  const parts = core.split(".").map(Number);
  return {
    core: [parts[0]!, parts[1]!, parts[2]!],
    prerelease: prerelease.length === 0 ? [] : prerelease.split("."),
  };
}

function compareVersionIdentifier(left: string, right: string): number {
  const leftNumber = /^[0-9]+$/.test(left) ? Number(left) : null;
  const rightNumber = /^[0-9]+$/.test(right) ? Number(right) : null;
  if (leftNumber != null && rightNumber != null) {
    return Math.sign(leftNumber - rightNumber);
  }
  if (leftNumber != null) return -1;
  if (rightNumber != null) return 1;
  return left.localeCompare(right);
}

export function compareCodexPluginShellVersions(
  left: string,
  right: string,
): number {
  const a = parseComparableVersion(left);
  const b = parseComparableVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = a.core[index]! - b.core[index]!;
    if (delta !== 0) return Math.sign(delta);
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const max = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < max; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart == null) return -1;
    if (bPart == null) return 1;
    const delta = compareVersionIdentifier(aPart, bPart);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function resolveCodexPluginShellPaths(
  suitePaths: DistributionSuitePaths,
): CodexPluginShellPaths {
  const shellRoot = join(suitePaths.namespaceRoot, "codex-plugin");
  const stateRoot = join(shellRoot, "state");
  return {
    acquisitionPath: join(stateRoot, "acquisition.json"),
    cacheRoot: join(shellRoot, "cache"),
    handoffsRoot: join(stateRoot, "handoffs"),
    logsRoot: join(shellRoot, "logs"),
    runtimeRoot: join(shellRoot, "runtime"),
    shellRoot,
    stateRoot,
    updateCheckPath: join(stateRoot, "update-check.json"),
    updatesRoot: join(shellRoot, "updates"),
  };
}

export function resolveCodexPluginSuitePaths(
  suitePaths: DistributionSuitePaths,
): DistributionSuitePaths {
  const paths = resolveCodexPluginShellPaths(suitePaths);
  return {
    ...suitePaths,
    cacheRoot: paths.cacheRoot,
    logsRoot: paths.logsRoot,
    runtimeRoot: paths.runtimeRoot,
    updatesRoot: paths.updatesRoot,
  };
}

function parseCodexPluginVersionControl(
  value: unknown,
  legacyMinShellVersion: unknown,
): CodexPluginAcquisitionManifestV1["control"] {
  if (value == null) {
    return {
      codexPlugin: {
        version: {
          min: normalizeDistributionVersion(
            legacyMinShellVersion,
            "minimum Codex plugin shell version",
          ),
        },
      },
    };
  }
  const control = assertRecord(value, "Codex plugin acquisition control");
  assertAllowedKeys(control, ["codexPlugin"], "Codex plugin acquisition control");
  const codexPlugin = assertRecord(
    control.codexPlugin,
    "Codex plugin acquisition control.codexPlugin",
  );
  assertAllowedKeys(
    codexPlugin,
    ["version"],
    "Codex plugin acquisition control.codexPlugin",
  );
  const version = assertRecord(
    codexPlugin.version,
    "Codex plugin acquisition control.codexPlugin.version",
  );
  assertAllowedKeys(
    version,
    ["min", "url"],
    "Codex plugin acquisition control.codexPlugin.version",
  );
  return {
    codexPlugin: {
      version: {
        min: normalizeDistributionVersion(
          version.min,
          "minimum Codex plugin shell version",
        ),
        ...(version.url == null
          ? {}
          : { url: normalizeRuntimeUrl(version.url, "Codex plugin update URL") }),
      },
    },
  };
}

export function parseCodexPluginAcquisitionManifest(
  value: unknown,
): CodexPluginAcquisitionManifestV1 {
  const record = assertRecord(value, "Codex plugin acquisition manifest");
  assertAllowedKeys(record, [
    "artifact",
    "channel",
    "control",
    "minShellVersion",
    "namespace",
    "protocolVersion",
    "runtimeDigest",
    "runtimeVersion",
    "schemaVersion",
  ], "Codex plugin acquisition manifest");
  if (record.schemaVersion !== CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION) {
    throw new CodexPluginProtocolError(
      `unsupported Codex plugin protocol schema version: ${String(record.schemaVersion)}`,
    );
  }
  const channel = normalizeDistributionChannel(record.channel);
  const runtimeDigest = normalizeDistributionDigest(
    record.runtimeDigest,
    "runtime digest",
  );
  const artifactRecord = assertRecord(
    record.artifact,
    "Codex plugin runtime artifact",
  );
  assertAllowedKeys(artifactRecord, [
    "digest",
    "entryPath",
    "mediaType",
    "size",
    "url",
  ], "Codex plugin runtime artifact");
  const artifact: CodexPluginRuntimeArtifactV1 = {
    digest: normalizeDistributionDigest(artifactRecord.digest, "artifact digest"),
    entryPath: normalizeDistributionInventoryPath(artifactRecord.entryPath),
    mediaType: normalizeRuntimeMediaType(artifactRecord.mediaType),
    size: normalizeNonNegativeInteger(artifactRecord.size, "artifact size"),
    url: normalizeRuntimeUrl(artifactRecord.url, "artifact URL"),
  };
  if (artifact.digest !== runtimeDigest) {
    throw new CodexPluginProtocolError(
      "Codex plugin artifact digest must equal runtime digest",
    );
  }
  return {
    artifact,
    channel,
    control: parseCodexPluginVersionControl(
      record.control,
      record.minShellVersion,
    ),
    namespace: normalizeDistributionNamespace(record.namespace),
    protocolVersion: normalizePositiveInteger(
      record.protocolVersion,
      "protocol version",
    ),
    runtimeDigest,
    runtimeVersion: normalizeDistributionRuntimeVersion(
      record.runtimeVersion,
      channel,
    ),
    schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
  };
}

export function parseCodexPluginUpdateCheck(
  value: unknown,
): CodexPluginUpdateCheckV1 {
  const record = assertRecord(value, "Codex plugin update check");
  assertAllowedKeys(record, [
    "active",
    "candidate",
    "error",
    "minimumShellVersion",
    "schemaVersion",
    "shellUpdateUrl",
    "state",
    "updatedAt",
  ], "Codex plugin update check");
  if (record.schemaVersion !== CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION) {
    throw new CodexPluginProtocolError(
      `unsupported Codex plugin protocol schema version: ${String(record.schemaVersion)}`,
    );
  }
  const states = Object.values(CODEX_PLUGIN_UPDATE_CHECK_STATES);
  if (
    typeof record.state !== "string"
    || !states.includes(record.state as CodexPluginUpdateCheckState)
  ) {
    throw new CodexPluginProtocolError(
      `unsupported Codex plugin update check state: ${String(record.state)}`,
    );
  }
  const state = record.state as CodexPluginUpdateCheckState;
  const active = record.active == null
    ? undefined
    : normalizeDistributionRuntimeIdentity(record.active);
  const candidate = record.candidate == null
    ? undefined
    : normalizeDistributionRuntimeIdentity(record.candidate);
  const minimumShellVersion = record.minimumShellVersion == null
    ? undefined
    : normalizeDistributionVersion(
        record.minimumShellVersion,
        "minimum Codex plugin shell version",
      );
  const shellUpdateUrl = record.shellUpdateUrl == null
    ? undefined
    : normalizeRuntimeUrl(
        record.shellUpdateUrl,
        "Codex plugin shell update URL",
      );
  let error: CodexPluginUpdateCheckV1["error"];
  if (record.error != null) {
    const errorRecord = assertRecord(
      record.error,
      "Codex plugin update check error",
    );
    assertAllowedKeys(
      errorRecord,
      ["code", "message"],
      "Codex plugin update check error",
    );
    error = {
      code: normalizeErrorCode(errorRecord.code),
      message: normalizeNonEmptyString(
        errorRecord.message,
        "update check error message",
      ),
    };
  }
  if (
    (state === CODEX_PLUGIN_UPDATE_CHECK_STATES.CURRENT
      || state === CODEX_PLUGIN_UPDATE_CHECK_STATES.DEFERRED)
    && active == null
  ) {
    throw new CodexPluginProtocolError(
      `${state} Codex plugin update check requires an active runtime`,
    );
  }
  if (
    state === CODEX_PLUGIN_UPDATE_CHECK_STATES.AVAILABLE
    && (candidate == null || minimumShellVersion == null)
  ) {
    throw new CodexPluginProtocolError(
      "available Codex plugin update check requires a candidate runtime and minimum shell version",
    );
  }
  if (
    state === CODEX_PLUGIN_UPDATE_CHECK_STATES.UNAVAILABLE
    && error == null
  ) {
    throw new CodexPluginProtocolError(
      "unavailable Codex plugin update check requires an error",
    );
  }
  if (
    state !== CODEX_PLUGIN_UPDATE_CHECK_STATES.AVAILABLE
    && (
      candidate != null
      || minimumShellVersion != null
      || shellUpdateUrl != null
    )
  ) {
    throw new CodexPluginProtocolError(
      `${state} Codex plugin update check must not contain candidate update metadata`,
    );
  }
  if (
    state !== CODEX_PLUGIN_UPDATE_CHECK_STATES.UNAVAILABLE
    && error != null
  ) {
    throw new CodexPluginProtocolError(
      `${state} Codex plugin update check must not contain an error`,
    );
  }
  return {
    ...(active == null ? {} : { active }),
    ...(candidate == null ? {} : { candidate }),
    ...(error == null ? {} : { error }),
    ...(minimumShellVersion == null ? {} : { minimumShellVersion }),
    schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
    ...(shellUpdateUrl == null ? {} : { shellUpdateUrl }),
    state,
    updatedAt: normalizeIsoDate(record.updatedAt, "update check updatedAt"),
  };
}

function parseHandoffRuntime(value: unknown): CodexPluginHandoffRuntimeV1 {
  const record = assertRecord(value, "Codex plugin handoff runtime");
  assertAllowedKeys(record, [
    "endpointUrl",
    "pid",
    "protocolVersion",
    "runtimeDigest",
    "runtimeVersion",
  ], "Codex plugin handoff runtime");
  return {
    ...(record.endpointUrl == null
      ? {}
      : { endpointUrl: normalizeRuntimeUrl(record.endpointUrl, "runtime endpoint URL") }),
    ...(record.pid == null
      ? {}
      : { pid: normalizePositiveInteger(record.pid, "runtime pid") }),
    protocolVersion: normalizePositiveInteger(
      record.protocolVersion,
      "protocol version",
    ),
    runtimeDigest: normalizeDistributionDigest(record.runtimeDigest, "runtime digest"),
    runtimeVersion: normalizeDistributionVersion(
      record.runtimeVersion,
      "runtime version",
    ),
  };
}

export function parseCodexPluginHandoffDescriptor(
  value: unknown,
): CodexPluginHandoffDescriptorV1 {
  const record = assertRecord(value, "Codex plugin handoff descriptor");
  assertAllowedKeys(record, [
    "channel",
    "createdAt",
    "error",
    "handoffId",
    "namespace",
    "resumeTokenDigest",
    "runtime",
    "schemaVersion",
    "shell",
    "state",
    "updatedAt",
  ], "Codex plugin handoff descriptor");
  if (record.schemaVersion !== CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION) {
    throw new CodexPluginProtocolError(
      `unsupported Codex plugin protocol schema version: ${String(record.schemaVersion)}`,
    );
  }
  const channel = normalizeDistributionChannel(record.channel);
  const state = normalizeHandoffState(record.state);
  const runtime = parseHandoffRuntime(record.runtime);
  runtime.runtimeVersion = normalizeDistributionRuntimeVersion(
    runtime.runtimeVersion,
    channel,
  );
  const shellRecord = assertRecord(record.shell, "Codex plugin handoff shell");
  assertAllowedKeys(shellRecord, ["pid", "version"], "Codex plugin handoff shell");
  let error: CodexPluginHandoffDescriptorV1["error"];
  if (record.error != null) {
    const errorRecord = assertRecord(record.error, "Codex plugin handoff error");
    assertAllowedKeys(errorRecord, ["code", "message"], "Codex plugin handoff error");
    error = {
      code: normalizeErrorCode(errorRecord.code),
      message: normalizeNonEmptyString(errorRecord.message, "handoff error message"),
    };
  }
  if (state === CODEX_PLUGIN_HANDOFF_STATES.FAILED && error == null) {
    throw new CodexPluginProtocolError("failed Codex plugin handoff requires an error");
  }
  if (state !== CODEX_PLUGIN_HANDOFF_STATES.FAILED && error != null) {
    throw new CodexPluginProtocolError(
      "non-failed Codex plugin handoff must not contain an error",
    );
  }
  if (
    (state === CODEX_PLUGIN_HANDOFF_STATES.LAUNCHED
      || state === CODEX_PLUGIN_HANDOFF_STATES.CONFIRMED)
    && (runtime.pid == null || runtime.endpointUrl == null)
  ) {
    throw new CodexPluginProtocolError(
      `${state} Codex plugin handoff requires runtime pid and endpoint URL`,
    );
  }
  if (
    (state === CODEX_PLUGIN_HANDOFF_STATES.PREPARED
      || state === CODEX_PLUGIN_HANDOFF_STATES.ACQUIRED)
    && (runtime.pid != null || runtime.endpointUrl != null)
  ) {
    throw new CodexPluginProtocolError(
      `${state} Codex plugin handoff must not bind a running runtime`,
    );
  }
  return {
    channel,
    createdAt: normalizeIsoDate(record.createdAt, "handoff createdAt"),
    ...(error == null ? {} : { error }),
    handoffId: normalizeHandoffId(record.handoffId),
    namespace: normalizeDistributionNamespace(record.namespace),
    resumeTokenDigest: normalizeDistributionDigest(
      record.resumeTokenDigest,
      "resume token digest",
    ),
    runtime,
    schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
    shell: {
      pid: normalizePositiveInteger(shellRecord.pid, "shell pid"),
      version: normalizeDistributionVersion(shellRecord.version, "shell version"),
    },
    state,
    updatedAt: normalizeIsoDate(record.updatedAt, "handoff updatedAt"),
  };
}

export function parseCodexPluginRuntimeReady(
  value: unknown,
): CodexPluginRuntimeReadyV1 {
  const record = assertRecord(value, "Codex plugin runtime ready message");
  assertAllowedKeys(record, [
    "endpointUrl",
    "handoffId",
    "pid",
    "resumeTokenDigest",
    "schemaVersion",
  ], "Codex plugin runtime ready message");
  if (record.schemaVersion !== CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION) {
    throw new CodexPluginProtocolError(
      `unsupported Codex plugin protocol schema version: ${String(record.schemaVersion)}`,
    );
  }
  return {
    endpointUrl: normalizeRuntimeUrl(record.endpointUrl, "runtime endpoint URL"),
    handoffId: normalizeHandoffId(record.handoffId),
    pid: normalizePositiveInteger(record.pid, "runtime pid"),
    resumeTokenDigest: normalizeDistributionDigest(
      record.resumeTokenDigest,
      "resume token digest",
    ),
    schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
  };
}

export function parseCodexPluginFixtureReport(
  value: unknown,
): CodexPluginFixtureReportV1 {
  const record = assertRecord(value, "Codex plugin fixture report");
  assertAllowedKeys(record, [
    "endpointUrl",
    "healthUrl",
    "identity",
    "runtimeManifestUrl",
    "schemaVersion",
  ], "Codex plugin fixture report");
  const distribution = parseDistributionServeReport({
    endpointUrl: record.endpointUrl,
    healthUrl: record.healthUrl,
    identity: record.identity,
    schemaVersion: record.schemaVersion,
  });
  return {
    ...distribution,
    runtimeManifestUrl: normalizeRuntimeUrl(
      record.runtimeManifestUrl,
      "runtime manifest URL",
    ),
  };
}

const HANDOFF_TRANSITIONS: Readonly<Record<CodexPluginHandoffState, readonly CodexPluginHandoffState[]>> =
  Object.freeze({
    [CODEX_PLUGIN_HANDOFF_STATES.ACQUIRED]: [
      CODEX_PLUGIN_HANDOFF_STATES.FAILED,
      CODEX_PLUGIN_HANDOFF_STATES.LAUNCHED,
    ],
    [CODEX_PLUGIN_HANDOFF_STATES.CONFIRMED]: [],
    [CODEX_PLUGIN_HANDOFF_STATES.FAILED]: [],
    [CODEX_PLUGIN_HANDOFF_STATES.LAUNCHED]: [
      CODEX_PLUGIN_HANDOFF_STATES.CONFIRMED,
      CODEX_PLUGIN_HANDOFF_STATES.FAILED,
    ],
    [CODEX_PLUGIN_HANDOFF_STATES.PREPARED]: [
      CODEX_PLUGIN_HANDOFF_STATES.ACQUIRED,
      CODEX_PLUGIN_HANDOFF_STATES.FAILED,
    ],
  });

export function assertCodexPluginHandoffTransition(
  from: CodexPluginHandoffState,
  to: CodexPluginHandoffState,
): void {
  if (!HANDOFF_TRANSITIONS[from].includes(to)) {
    throw new CodexPluginProtocolError(
      `unsupported Codex plugin handoff transition: ${from} -> ${to}`,
    );
  }
}
