import { createHash } from "node:crypto";
import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CODEX_PLUGIN_ARGS,
  parseCodexPluginAcquisitionManifest,
} from "@open-design/codex-plugin-proto";
import {
  assertSameDistributionIdentity,
  assertSameDistributionRuntimeIdentity,
  calculateDistributionArtifactInventory,
  distributionIdentityKey,
  parseDistributionBuildReport,
  parseDistributionRuntimeBinding,
  type DistributionBuildReportV1,
  type DistributionIdentityV1,
} from "@open-design/distribution-proto";

import {
  parseToolCodexDesktopHostLoadReport,
  type ToolCodexDesktopHostLoadReportV1,
} from "./desktop-evidence.js";
import {
  ToolCodexError,
  acquireToolCodexGlobalLock,
  readToolCodexSentinel,
  updateToolCodexSentinel,
  writeToolCodexReport,
  type ToolCodexPaths,
} from "./state.js";
import {
  inspectToolCodexEnvironment,
  runCommand,
  type ToolCodexStatus,
} from "./host.js";
import {
  TOOL_CODEX_INVOCATION_SCHEMA_VERSION,
  parseToolCodexAutomatedInvocationReport,
  type ToolCodexAutomatedInvocationReportV1,
} from "./invocation.js";
import {
  toolCodexRuntimeEnv,
  type ToolCodexRuntimeBinding,
} from "./runtime.js";

export const CODEX_DESKTOP_ACCEPTANCE_STATUSES = [
  "PASS",
  "OPERATOR_ACTION_REQUIRED",
  "BLOCKED_BY_HOST_STATE",
  "FAIL",
] as const;

export type CodexDesktopAcceptanceStatus =
  (typeof CODEX_DESKTOP_ACCEPTANCE_STATUSES)[number];

export type ToolCodexPrepareResult = {
  artifactRoot: string;
  identity: DistributionIdentityV1;
  marketplaceName: string;
  pluginInstalled: true;
  reused: boolean;
};

export type ToolCodexAcceptanceSignals = {
  artifactValid: boolean;
  automatedInvocation: boolean | null;
  desktopControlled: boolean;
  desktopHostLoaded: boolean | null;
  desktopRunning: boolean;
  desktopUiObserved: boolean | null;
  loggedIn: boolean | null;
  marketplaceConfigured: boolean;
  pluginInstalled: boolean;
  stdioProbePassed: boolean;
};

export type ToolCodexEvidenceEvaluation = {
  available: boolean;
  identityMatches: boolean | null;
  reasonCode: string | null;
  reportPath: string | null;
  runMatches: boolean | null;
  status: "PASS" | "FAIL" | null;
};

export type ToolCodexAcceptanceReport = {
  buildReportPath: string;
  generatedAt: string;
  identity: DistributionIdentityV1;
  marketplaceRoot: string;
  observations: {
    cliVersion: string | null;
    desktopVersion: string | null;
    marketplaceName: string;
    stdioStatus: unknown | null;
  };
  evidence: {
    automatedInvocation: ToolCodexEvidenceEvaluation;
    desktopHostLoaded: ToolCodexEvidenceEvaluation;
    desktopUiObserved: ToolCodexEvidenceEvaluation;
  };
  operator: {
    checkpoints: string[];
  };
  signals: ToolCodexAcceptanceSignals;
  status: CodexDesktopAcceptanceStatus;
};

function assertPrepareHostReady(status: ToolCodexStatus): void {
  if (status.state !== "ready") {
    throw new ToolCodexError(
      status.state === "running-controlled"
        ? "CONTROLLED_DESKTOP_RUNNING"
        : status.reasonCode ?? "HOST_STATE_BLOCKED",
      "tools-codex prepare requires no running Codex Desktop instance",
    );
  }
}

type MarketplaceListPayload = {
  marketplaces?: Array<{
    marketplaceSource?: { source?: unknown };
    name?: unknown;
    root?: unknown;
  }>;
};

type PluginListPayload = {
  installed?: Array<{
    enabled?: unknown;
    marketplaceName?: unknown;
    name?: unknown;
    version?: unknown;
  }>;
};

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function collectArtifactEntries(
  root: string,
  current = root,
): Promise<Array<{ bytes: Uint8Array; path: string }>> {
  const entries = await readdir(current, { withFileTypes: true });
  const result: Array<{ bytes: Uint8Array; path: string }> = [];
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      throw new ToolCodexError(
        "ARTIFACT_INTEGRITY_MISMATCH",
        `Codex plugin artifact must not contain symbolic links: ${absolutePath}`,
      );
    }
    if (info.isDirectory()) {
      result.push(...await collectArtifactEntries(root, absolutePath));
      continue;
    }
    if (!info.isFile()) {
      throw new ToolCodexError(
        "ARTIFACT_INTEGRITY_MISMATCH",
        `Codex plugin artifact contains an unsupported entry: ${absolutePath}`,
      );
    }
    const path = relative(root, absolutePath).split(sep).join("/");
    if (path !== "distribution.json") {
      result.push({ bytes: await readFile(absolutePath), path });
    }
  }
  return result;
}

export async function verifyToolCodexArtifact(
  buildReport: DistributionBuildReportV1,
): Promise<void> {
  const inventory = calculateDistributionArtifactInventory(
    await collectArtifactEntries(buildReport.paths.shellRoot),
  );
  if (inventory.digest !== buildReport.artifact.digest
    || inventory.size !== buildReport.artifact.size
    || inventory.files.length !== buildReport.artifact.files.length
    || inventory.files.some((file, index) => file !== buildReport.artifact.files[index])) {
    throw new ToolCodexError(
      "ARTIFACT_INTEGRITY_MISMATCH",
      "Codex plugin artifact no longer matches its tools-pack build report",
      {
        actual: inventory,
        expected: buildReport.artifact,
      },
    );
  }
  const embeddedIdentity = await readJson(
    join(buildReport.paths.shellRoot, "distribution.json"),
  );
  try {
    assertSameDistributionIdentity(
      buildReport.identity,
      embeddedIdentity as DistributionIdentityV1,
    );
  } catch (error) {
    throw new ToolCodexError(
      "ARTIFACT_IDENTITY_MISMATCH",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (buildReport.runtimeArtifact != null) {
    const info = await lstat(buildReport.runtimeArtifact.path).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (info == null || !info.isFile() || info.isSymbolicLink()) {
      throw new ToolCodexError(
        "RUNTIME_ARTIFACT_INTEGRITY_MISMATCH",
        "Open Design runtime artifact is missing, unsafe, or not a regular file",
      );
    }
    const bytes = await readFile(buildReport.runtimeArtifact.path);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (
      bytes.byteLength !== buildReport.runtimeArtifact.size
      || digest !== buildReport.runtimeArtifact.digest
      || digest !== buildReport.identity.runtimeDigest
    ) {
      throw new ToolCodexError(
        "RUNTIME_ARTIFACT_INTEGRITY_MISMATCH",
        "Open Design runtime artifact no longer matches its tools-pack build report",
      );
    }
  }
}

async function canonicalPath(path: string): Promise<string> {
  return await realpath(path).catch(() => resolve(path));
}

function parseJsonOutput(output: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return null;
  }
}

async function runCodex(
  paths: ToolCodexPaths,
  codexBin: string,
  args: string[],
): Promise<ReturnType<typeof runCommand> extends Promise<infer TResult> ? TResult : never> {
  return await runCommand(codexBin, args, {
    env: {
      ...process.env,
      CODEX_HOME: paths.codexHome,
    },
  });
}

async function runCodexJson(
  paths: ToolCodexPaths,
  codexBin: string,
  args: string[],
  label: string,
): Promise<unknown> {
  const result = await runCodex(paths, codexBin, args);
  if (result.code !== 0) {
    throw new ToolCodexError(
      "CODEX_COMMAND_FAILED",
      `${label} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
    );
  }
  const parsed = parseJsonOutput(result.stdout);
  if (parsed == null) {
    throw new ToolCodexError("CODEX_OUTPUT_INVALID", `${label} did not return JSON`);
  }
  return parsed;
}

function marketplaceEntries(value: unknown): NonNullable<MarketplaceListPayload["marketplaces"]> {
  if (value == null || typeof value !== "object") return [];
  const marketplaces = (value as MarketplaceListPayload).marketplaces;
  return Array.isArray(marketplaces) ? marketplaces : [];
}

function installedPluginEntries(value: unknown): NonNullable<PluginListPayload["installed"]> {
  if (value == null || typeof value !== "object") return [];
  const installed = (value as PluginListPayload).installed;
  return Array.isArray(installed) ? installed : [];
}

async function marketplaceMatches(
  payload: unknown,
  name: string,
  root: string,
): Promise<boolean> {
  const canonicalRoot = await canonicalPath(root);
  for (const entry of marketplaceEntries(payload)) {
    if (entry.name !== name) continue;
    const candidate = typeof entry.root === "string"
      ? entry.root
      : typeof entry.marketplaceSource?.source === "string"
        ? entry.marketplaceSource.source
        : null;
    if (candidate != null && await canonicalPath(candidate) === canonicalRoot) return true;
  }
  return false;
}

function pluginMatches(
  payload: unknown,
  marketplaceName: string,
  version: string,
): boolean {
  return installedPluginEntries(payload).some((entry) =>
    entry.name === "open-design"
    && entry.marketplaceName === marketplaceName
    && entry.version === version
    && entry.enabled === true
  );
}

function hasPluginFromMarketplace(payload: unknown, marketplaceName: string): boolean {
  return installedPluginEntries(payload).some((entry) =>
    entry.name === "open-design" && entry.marketplaceName === marketplaceName
  );
}

async function readMarketplace(buildReport: DistributionBuildReportV1): Promise<{
  marketplaceName: string;
}> {
  const value = await readJson(
    join(buildReport.paths.artifactRoot, ".agents", "plugins", "marketplace.json"),
  );
  if (value == null || typeof value !== "object") {
    throw new ToolCodexError("MARKETPLACE_INVALID", "generated marketplace must be an object");
  }
  const record = value as {
    name?: unknown;
    plugins?: Array<{
      name?: unknown;
      policy?: { authentication?: unknown };
    }>;
  };
  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new ToolCodexError("MARKETPLACE_INVALID", "generated marketplace name is missing");
  }
  const plugin = record.plugins?.find((entry) => entry.name === "open-design");
  if (plugin?.policy?.authentication !== "ON_USE") {
    throw new ToolCodexError(
      "MARKETPLACE_AUTH_POLICY_UNSUPPORTED",
      "open-design marketplace authentication policy must be ON_USE",
    );
  }
  return { marketplaceName: record.name };
}

export async function removeToolCodexPreparedPlugin(
  paths: ToolCodexPaths,
  codexBin: string,
  marketplaceName: string,
): Promise<void> {
  const pluginRemoval = await runCodex(paths, codexBin, [
    "--enable",
    "plugins",
    "plugin",
    "remove",
    `open-design@${marketplaceName}`,
    "--json",
  ]);
  if (pluginRemoval.code !== 0) {
    const plugins = await runCodexJson(paths, codexBin, [
      "--enable",
      "plugins",
      "plugin",
      "list",
      "--available",
      "--json",
    ], "codex plugin list after removal");
    if (hasPluginFromMarketplace(plugins, marketplaceName)) {
      throw new ToolCodexError(
        "CODEX_COMMAND_FAILED",
        `codex plugin remove failed: ${pluginRemoval.stderr || pluginRemoval.stdout || `exit ${pluginRemoval.code}`}`,
      );
    }
  }
  const marketplaceRemoval = await runCodex(paths, codexBin, [
    "--enable",
    "plugins",
    "plugin",
    "marketplace",
    "remove",
    marketplaceName,
    "--json",
  ]);
  if (marketplaceRemoval.code !== 0) {
    const marketplaces = await runCodexJson(paths, codexBin, [
      "--enable",
      "plugins",
      "plugin",
      "marketplace",
      "list",
      "--json",
    ], "codex plugin marketplace list after removal");
    if (marketplaceEntries(marketplaces).some((entry) => entry.name === marketplaceName)) {
      throw new ToolCodexError(
        "CODEX_COMMAND_FAILED",
        `codex plugin marketplace remove failed: ${marketplaceRemoval.stderr || marketplaceRemoval.stdout || `exit ${marketplaceRemoval.code}`}`,
      );
    }
  }
}

export async function prepareToolCodexPlugin(options: {
  appPath?: string;
  buildReportPath: string;
  codexBin?: string;
  paths: ToolCodexPaths;
}): Promise<ToolCodexPrepareResult> {
  const buildReportPath = resolve(options.buildReportPath);
  const buildReport = parseDistributionBuildReport(await readJson(buildReportPath));
  await verifyToolCodexArtifact(buildReport);
  const { marketplaceName } = await readMarketplace(buildReport);
  const codexBin = options.codexBin ?? "codex";
  const status = await inspectToolCodexEnvironment({
    appPath: options.appPath,
    codexBin,
    paths: options.paths,
  });
  assertPrepareHostReady(status);

  const lock = await acquireToolCodexGlobalLock(options.paths, "prepare");
  try {
    assertPrepareHostReady(await inspectToolCodexEnvironment({
      appPath: options.appPath,
      codexBin,
      paths: options.paths,
    }));
    const sentinel = await readToolCodexSentinel(options.paths);
    const [marketplaces, plugins] = await Promise.all([
      runCodexJson(options.paths, codexBin, [
        "--enable",
        "plugins",
        "plugin",
        "marketplace",
        "list",
        "--json",
      ], "codex plugin marketplace list"),
      runCodexJson(options.paths, codexBin, [
        "--enable",
        "plugins",
        "plugin",
        "list",
        "--available",
        "--json",
      ], "codex plugin list"),
    ]);
    const identityKey = distributionIdentityKey(buildReport.identity);
    const samePreparedState = sentinel.prepared?.identityKey === identityKey
      && await canonicalPath(sentinel.prepared.artifactRoot)
        === await canonicalPath(buildReport.paths.artifactRoot)
      && sentinel.prepared.marketplaceName === marketplaceName;
    if (samePreparedState
      && await marketplaceMatches(marketplaces, marketplaceName, buildReport.paths.artifactRoot)
      && pluginMatches(plugins, marketplaceName, buildReport.identity.shellVersion)) {
      return {
        artifactRoot: buildReport.paths.artifactRoot,
        identity: buildReport.identity,
        marketplaceName,
        pluginInstalled: true,
        reused: true,
      };
    }

    const conflict = marketplaceEntries(marketplaces).some((entry) =>
      entry.name === marketplaceName
    );
    if (conflict && sentinel.prepared?.marketplaceName !== marketplaceName) {
      throw new ToolCodexError(
        "MARKETPLACE_NAME_CONFLICT",
        `marketplace ${marketplaceName} exists but is not owned by this tools-codex sentinel`,
      );
    }
    if (sentinel.prepared != null) {
      await removeToolCodexPreparedPlugin(options.paths, codexBin, sentinel.prepared.marketplaceName);
    }

    await runCodexJson(options.paths, codexBin, [
      "--enable",
      "plugins",
      "plugin",
      "marketplace",
      "add",
      buildReport.paths.artifactRoot,
      "--json",
    ], "codex plugin marketplace add");
    await updateToolCodexSentinel(options.paths, (current) => ({
      ...current,
      prepared: {
        artifactRoot: buildReport.paths.artifactRoot,
        identityKey,
        marketplaceName,
        preparedAt: new Date().toISOString(),
      },
    }));
    await runCodexJson(options.paths, codexBin, [
      "--enable",
      "plugins",
      "plugin",
      "add",
      `open-design@${marketplaceName}`,
      "--json",
    ], "codex plugin add");
    return {
      artifactRoot: buildReport.paths.artifactRoot,
      identity: buildReport.identity,
      marketplaceName,
      pluginInstalled: true,
      reused: false,
    };
  } finally {
    await lock.release();
  }
}

async function probeStdio(
  buildReport: DistributionBuildReportV1,
  fixtureReportUrl?: string,
  runtimeBinding?: ToolCodexRuntimeBinding | null,
): Promise<unknown> {
  const args = [
    "./bootstrap.sh",
    "--identity-file",
    "./distribution.json",
  ];
  if (fixtureReportUrl != null) {
    args.push("--fixture-report-url", fixtureReportUrl);
  }
  if (runtimeBinding != null) {
    args.push(
      CODEX_PLUGIN_ARGS.DISTRIBUTION_CHANNEL_ROOT,
      runtimeBinding.distributionChannelRoot,
      CODEX_PLUGIN_ARGS.RUNTIME_MANIFEST_URL,
      runtimeBinding.runtimeManifestUrl,
    );
  }
  const transport = new StdioClientTransport({
    args,
    command: "/bin/sh",
    cwd: buildReport.paths.shellRoot,
    env: Object.fromEntries(
      Object.entries({
        ...process.env,
        ...toolCodexRuntimeEnv(runtimeBinding),
      }).filter((entry): entry is [string, string] => entry[1] != null),
    ),
    stderr: "pipe",
  });
  const client = new Client({
    name: "open-design-tools-codex-acceptance",
    version: "0.1.0",
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === "get_open_design_status")) {
      throw new Error("Codex plugin status tool is missing");
    }
    if (!tools.tools.some((tool) => tool.name === "ensure_open_design_runtime")) {
      throw new Error("Codex plugin runtime handoff tool is missing");
    }
    const result = await client.callTool({
      arguments: {},
      name: "get_open_design_status",
    });
    const status = result.structuredContent;
    if (status == null || typeof status !== "object" || !("identity" in status)) {
      throw new Error("Codex plugin status tool did not return an identity");
    }
    assertSameDistributionIdentity(
      buildReport.identity,
      (status as { identity: DistributionIdentityV1 }).identity,
    );
    if (runtimeBinding == null) return status;
    const runtime = await client.callTool({
      arguments: {},
      name: "ensure_open_design_runtime",
    });
    if (
      runtime.structuredContent == null
      || typeof runtime.structuredContent !== "object"
      || !("binding" in runtime.structuredContent)
      || !("manifest" in runtime.structuredContent)
    ) {
      throw new Error("Codex plugin runtime handoff did not return a binding");
    }
    const selectedManifest = parseCodexPluginAcquisitionManifest(
      (runtime.structuredContent as { manifest: unknown }).manifest,
    );
    assertSameDistributionRuntimeIdentity(
      selectedManifest,
      parseDistributionRuntimeBinding(
        (runtime.structuredContent as { binding: unknown }).binding,
      ),
    );
    return { runtime: runtime.structuredContent, status };
  } finally {
    await client.close();
  }
}

export async function runToolCodexHandoffProbe(options: {
  buildReportPath: string;
  fixtureReportUrl?: string;
  runtimeBinding: ToolCodexRuntimeBinding;
}): Promise<unknown> {
  const buildReportPath = resolve(options.buildReportPath);
  const buildReport = parseDistributionBuildReport(await readJson(buildReportPath));
  await verifyToolCodexArtifact(buildReport);
  return {
    buildReportPath,
    identity: buildReport.identity,
    observation: await probeStdio(
      buildReport,
      options.fixtureReportUrl,
      options.runtimeBinding,
    ),
  };
}

export function extractObservedIdentity(value: unknown): DistributionIdentityV1 | null {
  if (value == null || typeof value !== "object") return null;
  if ("identity" in value) {
    return (value as { identity?: DistributionIdentityV1 }).identity ?? null;
  }
  for (const key of ["structuredContent", "structured_content", "result"]) {
    if (key in value) {
      const identity = extractObservedIdentity(
        (value as Record<string, unknown>)[key],
      );
      if (identity != null) return identity;
    }
  }
  return null;
}

export const TOOL_CODEX_DESKTOP_UI_OBSERVATION_SCHEMA_VERSION = 1 as const;

export type ToolCodexDesktopUiObservationV1 = {
  capturedAt: string;
  provenance: {
    kind: "operator-captured-desktop-ui";
    runId: string;
  };
  schemaVersion: typeof TOOL_CODEX_DESKTOP_UI_OBSERVATION_SCHEMA_VERSION;
  server: "open-design";
  structuredContent: {
    identity: DistributionIdentityV1;
  };
  tool: "ensure_open_design_runtime" | "get_open_design_status";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

export function parseToolCodexDesktopUiObservation(
  value: unknown,
): ToolCodexDesktopUiObservationV1 {
  if (!isRecord(value)
    || value.schemaVersion !== TOOL_CODEX_DESKTOP_UI_OBSERVATION_SCHEMA_VERSION
    || value.server !== "open-design"
    || (
      value.tool !== "get_open_design_status"
      && value.tool !== "ensure_open_design_runtime"
    )
    || typeof value.capturedAt !== "string"
    || !isRecord(value.provenance)
    || value.provenance.kind !== "operator-captured-desktop-ui"
    || typeof value.provenance.runId !== "string"
    || !isRecord(value.structuredContent)
    || !isRecord(value.structuredContent.identity)) {
    throw new ToolCodexError(
      "DESKTOP_UI_OBSERVATION_INVALID",
      "Desktop UI observation must include explicit operator provenance",
    );
  }
  return value as ToolCodexDesktopUiObservationV1;
}

export function classifyToolCodexAcceptance(
  signals: ToolCodexAcceptanceSignals,
  host: ToolCodexStatus,
): CodexDesktopAcceptanceStatus {
  if (!signals.artifactValid
    || !signals.stdioProbePassed
    || signals.desktopHostLoaded === false
    || signals.automatedInvocation === false
    || signals.desktopUiObserved === false) {
    return "FAIL";
  }
  if (!host.cli.available
    || !host.desktop.available
    || host.state === "unknown"
    || host.state === "blocked"
    || host.state === "running-unmanaged") {
    return "BLOCKED_BY_HOST_STATE";
  }
  if (!signals.desktopRunning
    || !signals.desktopControlled
    || signals.loggedIn !== true
    || !signals.marketplaceConfigured
    || !signals.pluginInstalled
    || signals.desktopHostLoaded == null
    || signals.automatedInvocation == null) {
    return "OPERATOR_ACTION_REQUIRED";
  }
  return "PASS";
}

function identityMatches(
  expected: DistributionIdentityV1,
  actual: DistributionIdentityV1,
): boolean {
  try {
    assertSameDistributionIdentity(expected, actual);
    return true;
  } catch {
    return false;
  }
}

async function optionalReport(path: string): Promise<unknown | null> {
  return await readJson(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

function unavailableEvidence(
  path: string | null,
  reasonCode: string | null = null,
): ToolCodexEvidenceEvaluation {
  return {
    available: false,
    identityMatches: null,
    reasonCode,
    reportPath: path,
    runMatches: null,
    status: null,
  };
}

function evaluateDesktopHostLoad(
  report: ToolCodexDesktopHostLoadReportV1 | null,
  reportPath: string,
  buildIdentity: DistributionIdentityV1,
  host: ToolCodexStatus,
): ToolCodexEvidenceEvaluation {
  if (report == null) return unavailableEvidence(reportPath, "EVIDENCE_NOT_CAPTURED");
  const identityMatch = identityMatches(buildIdentity, report.identity);
  const runMatches = host.marker != null
    && report.provenance.runId === host.marker.runId
    && report.provenance.rootPid === host.marker.rootPid
    && report.provenance.rootStartedAt === host.marker.rootStartedAt;
  if (!runMatches) return unavailableEvidence(reportPath, "STALE_FOR_CURRENT_RUN");
  return {
    available: true,
    identityMatches: identityMatch,
    reasonCode: identityMatch && report.status === "PASS"
      ? null
      : report.reasonCode ?? "DESKTOP_HOST_LOAD_MISMATCH",
    reportPath,
    runMatches,
    status: identityMatch && report.status === "PASS" ? "PASS" : "FAIL",
  };
}

function evaluateAutomatedInvocation(
  report: ToolCodexAutomatedInvocationReportV1 | null,
  reportPath: string,
  buildIdentity: DistributionIdentityV1,
  host: ToolCodexStatus,
): ToolCodexEvidenceEvaluation {
  if (report == null) return unavailableEvidence(reportPath, "EVIDENCE_NOT_CAPTURED");
  const identityMatch = identityMatches(buildIdentity, report.identity);
  const runMatches = host.marker != null
    && report.provenance.desktopRunId === host.marker.runId
    && report.provenance.desktopRootPid === host.marker.rootPid
    && report.provenance.desktopRootStartedAt === host.marker.rootStartedAt;
  if (!runMatches) return unavailableEvidence(reportPath, "STALE_FOR_CURRENT_RUN");
  return {
    available: true,
    identityMatches: identityMatch,
    reasonCode: identityMatch && report.status === "PASS"
      ? null
      : report.reasonCode ?? "AUTOMATED_INVOCATION_MISMATCH",
    reportPath,
    runMatches,
    status: identityMatch && report.status === "PASS" ? "PASS" : "FAIL",
  };
}

function evaluateDesktopUiObservation(
  observation: ToolCodexDesktopUiObservationV1 | null,
  reportPath: string | null,
  buildIdentity: DistributionIdentityV1,
  host: ToolCodexStatus,
): ToolCodexEvidenceEvaluation {
  if (observation == null) return unavailableEvidence(reportPath);
  const identityMatch = identityMatches(
    buildIdentity,
    observation.structuredContent.identity,
  );
  const runMatches = host.marker != null
    && observation.provenance.runId === host.marker.runId;
  if (!runMatches) return unavailableEvidence(reportPath, "STALE_FOR_CURRENT_RUN");
  return {
    available: true,
    identityMatches: identityMatch,
    reasonCode: identityMatch ? null : "DESKTOP_UI_IDENTITY_MISMATCH",
    reportPath,
    runMatches,
    status: identityMatch ? "PASS" : "FAIL",
  };
}

export async function runToolCodexAcceptance(options: {
  appPath?: string;
  automatedInvocationReportPath?: string;
  buildReportPath: string;
  codexBin?: string;
  desktopHostLoadReportPath?: string;
  desktopUiObservationPath?: string;
  fixtureReportUrl?: string;
  outputPath?: string;
  paths: ToolCodexPaths;
  runtimeBinding?: ToolCodexRuntimeBinding | null;
}): Promise<ToolCodexAcceptanceReport> {
  await readToolCodexSentinel(options.paths);
  const buildReportPath = resolve(options.buildReportPath);
  const buildReport = parseDistributionBuildReport(await readJson(buildReportPath));
  const { marketplaceName } = await readMarketplace(buildReport);
  const artifactValid = await verifyToolCodexArtifact(buildReport)
    .then(() => true)
    .catch(() => false);
  const codexBin = options.codexBin ?? "codex";
  const host = await inspectToolCodexEnvironment({
    appPath: options.appPath,
    codexBin,
    paths: options.paths,
  });
  const [marketplaces, plugins] = host.cli.available
    ? await Promise.all([
        runCodexJson(options.paths, codexBin, [
          "--enable", "plugins", "plugin", "marketplace", "list", "--json",
        ], "codex plugin marketplace list"),
        runCodexJson(options.paths, codexBin, [
          "--enable", "plugins", "plugin", "list", "--available", "--json",
        ], "codex plugin list"),
      ])
    : [null, null];

  let stdioStatus: unknown | null = null;
  let stdioProbePassed = false;
  try {
    stdioStatus = await probeStdio(
      buildReport,
      options.fixtureReportUrl,
      options.runtimeBinding,
    );
    stdioProbePassed = true;
  } catch (error) {
    stdioStatus = {
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const desktopHostLoadReportPath = resolve(
    options.desktopHostLoadReportPath ?? options.paths.desktopHostLoadReportPath,
  );
  const automatedInvocationReportPath = resolve(
    options.automatedInvocationReportPath ?? options.paths.invocationReportPath,
  );
  let desktopHostLoadReport: ToolCodexDesktopHostLoadReportV1 | null = null;
  let automatedInvocationReport: ToolCodexAutomatedInvocationReportV1 | null = null;
  try {
    const value = await optionalReport(desktopHostLoadReportPath);
    desktopHostLoadReport = value == null
      ? null
      : parseToolCodexDesktopHostLoadReport(value);
  } catch {
    desktopHostLoadReport = {
      buildReportPath,
      checks: {
        appServerDescendsFromRoot: false,
        appServerHomeStampMatches: false,
        appServerRunStampMatches: false,
        cachedIdentityMatches: false,
        desktopClientObserved: false,
        pluginCwdMatchesExpected: false,
        pluginHomeStampMatches: false,
        pluginDescendsFromAppServer: false,
        pluginRunStampMatches: false,
        preparedIdentityMatches: false,
        rootControlled: false,
      },
      expectedPluginCacheRoot: "",
      generatedAt: new Date().toISOString(),
      identity: buildReport.identity,
      logEvidence: null,
      processes: {
        appServer: null,
        pluginMcp: null,
        root: {
          command: "",
          cwd: null,
          pid: 0,
          ppid: 0,
          startedAt: null,
        },
      },
      provenance: {
        kind: "desktop-host-load",
        observationKind: "process-chain",
        rootPid: host.marker?.rootPid ?? 0,
        rootStartedAt: host.marker?.rootStartedAt ?? "",
        runId: host.marker?.runId ?? "",
      },
      reasonCode: "DESKTOP_HOST_LOAD_REPORT_INVALID",
      schemaVersion: 1,
      status: "FAIL",
    };
  }
  try {
    const value = await optionalReport(automatedInvocationReportPath);
    automatedInvocationReport = value == null
      ? null
      : parseToolCodexAutomatedInvocationReport(value);
  } catch {
    automatedInvocationReport = {
      attempts: [],
      buildReportPath,
      generatedAt: new Date().toISOString(),
      identity: buildReport.identity,
      provenance: {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        desktopRootPid: host.marker?.rootPid ?? 0,
        desktopRootStartedAt: host.marker?.rootStartedAt ?? "",
        desktopRunId: host.marker?.runId ?? "",
        ephemeral: true,
        invocationId: "",
        kind: "codex-exec-jsonl",
        sandbox: "read-only",
        workspace: options.paths.workspaceRoot,
      },
      reasonCode: "AUTOMATED_INVOCATION_REPORT_INVALID",
      schemaVersion: TOOL_CODEX_INVOCATION_SCHEMA_VERSION,
      status: "FAIL",
      successfulAttempt: null,
    };
  }
  const desktopUiObservationPath = options.desktopUiObservationPath == null
    ? null
    : resolve(options.desktopUiObservationPath);
  let desktopUiObservation: ToolCodexDesktopUiObservationV1 | null = null;
  if (desktopUiObservationPath != null) {
    desktopUiObservation = parseToolCodexDesktopUiObservation(
      await readJson(desktopUiObservationPath),
    );
  }
  const evidence = {
    automatedInvocation: evaluateAutomatedInvocation(
      automatedInvocationReport,
      automatedInvocationReportPath,
      buildReport.identity,
      host,
    ),
    desktopHostLoaded: evaluateDesktopHostLoad(
      desktopHostLoadReport,
      desktopHostLoadReportPath,
      buildReport.identity,
      host,
    ),
    desktopUiObserved: evaluateDesktopUiObservation(
      desktopUiObservation,
      desktopUiObservationPath,
      buildReport.identity,
      host,
    ),
  };
  const signals: ToolCodexAcceptanceSignals = {
    artifactValid,
    automatedInvocation: evidence.automatedInvocation.status === "PASS"
      ? true
      : evidence.automatedInvocation.status === "FAIL"
        ? false
        : null,
    desktopControlled: host.desktop.controlled,
    desktopHostLoaded: evidence.desktopHostLoaded.status === "PASS"
      ? true
      : evidence.desktopHostLoaded.status === "FAIL"
        ? false
        : null,
    desktopRunning: host.desktop.roots.length === 1,
    desktopUiObserved: evidence.desktopUiObserved.status === "PASS"
      ? true
      : evidence.desktopUiObserved.status === "FAIL"
        ? false
        : null,
    loggedIn: host.cli.loggedIn,
    marketplaceConfigured: marketplaces == null
      ? false
      : await marketplaceMatches(
          marketplaces,
          marketplaceName,
          buildReport.paths.artifactRoot,
        ),
    pluginInstalled: plugins == null
      ? false
      : pluginMatches(plugins, marketplaceName, buildReport.identity.shellVersion),
    stdioProbePassed,
  };
  const checkpoints: string[] = [];
  if (signals.loggedIn !== true) {
    checkpoints.push("Complete Codex login in the controlled Desktop instance.");
  }
  if (signals.desktopRunning !== true || signals.desktopControlled !== true) {
    checkpoints.push("Start one controlled Desktop instance for this environment.");
  }
  if (signals.desktopHostLoaded == null) {
    checkpoints.push(
      "Start Desktop with --build-report or run capture-host-load for this build.",
    );
  }
  if (signals.automatedInvocation == null) {
    checkpoints.push("Run tools-codex invoke for the same controlled Desktop run.");
  }
  const report: ToolCodexAcceptanceReport = {
    buildReportPath,
    evidence,
    generatedAt: new Date().toISOString(),
    identity: buildReport.identity,
    marketplaceRoot: buildReport.paths.artifactRoot,
    observations: {
      cliVersion: host.cli.version,
      desktopVersion: host.desktop.version,
      marketplaceName,
      stdioStatus,
    },
    operator: {
      checkpoints,
    },
    signals,
    status: classifyToolCodexAcceptance(signals, host),
  };
  const outputPath = resolve(
    options.outputPath ?? options.paths.acceptanceReportPath,
  );
  await writeToolCodexReport(options.paths, outputPath, report);
  return report;
}

export async function isToolCodexArtifactAvailable(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}
