import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep, win32 } from "node:path";

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
  normalizeDistributionInventoryPath,
  parseDistributionBuildReport,
  parseDistributionRuntimeBinding,
  type DistributionBuildReportV1,
  type DistributionIdentityV1,
} from "@open-design/distribution-proto";

import {
  ToolCodexError,
  acquireToolCodexGlobalLock,
  readToolCodexSentinel,
  resolveToolCodexReportPath,
  updateToolCodexSentinel,
  writeToolCodexReport,
  type ToolCodexPaths,
  type ToolCodexVerifiedRuntimeState,
} from "./state.js";
import {
  inspectToolCodexEnvironment,
  runCommand,
  type ToolCodexStatus,
} from "./host.js";
import {
  runtimeBindingFromPreparedState,
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
  desktopControlled: boolean;
  desktopRunning: boolean;
  desktopUiObserved: boolean | null;
  loggedIn: boolean | null;
  marketplaceConfigured: boolean;
  pluginInstalled: boolean;
  stdioProbePassed: boolean;
};

export type ToolCodexEvidenceEvaluation = {
  available: boolean;
  capturedAt: string | null;
  identityMatches: boolean | null;
  outcome: "PASS" | "FAIL" | null;
  reasonCode: string | null;
  reportPath: string | null;
  runMatches: boolean | null;
  screenshot: {
    mediaType: "image/png";
    path: string;
    sha256: string;
    size: number;
  } | null;
  screenshotMatches: boolean | null;
  status: "PASS" | "FAIL" | null;
  toolMatches: boolean | null;
};

export type ToolCodexAcceptanceReport = {
  buildReportPath: string;
  generatedAt: string;
  identity: DistributionIdentityV1;
  marketplaceRoot: string;
  observations: {
    cliVersion: string | null;
    desktopVersion: string | null;
    expectedTool: "ensure_open_design_runtime" | "get_open_design_status";
    marketplaceName: string;
    stdioStatus: unknown | null;
  };
  evidence: {
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

type CodexPluginMcpLaunch = {
  args: string[];
  command: string;
  commandEntry: string;
  startupTimeoutMs: number;
};

export const WINDOWS_CODEX_PLUGIN_COMMAND_MAX_PATH_LENGTH = 259;

export function assertCodexPluginCacheCommandPathSupported(options: {
  codexHome: string;
  commandEntry: string;
  marketplaceName: string;
  platform?: NodeJS.Platform;
  shellVersion: string;
}): string {
  const platform = options.platform ?? process.platform;
  const commandPath = platform === "win32"
    ? win32.join(
        options.codexHome,
        "plugins",
        "cache",
        options.marketplaceName,
        "open-design",
        options.shellVersion,
        ...options.commandEntry.split("/"),
      )
    : join(
        options.codexHome,
        "plugins",
        "cache",
        options.marketplaceName,
        "open-design",
        options.shellVersion,
        ...options.commandEntry.split("/"),
      );
  if (
    platform === "win32"
    && commandPath.length > WINDOWS_CODEX_PLUGIN_COMMAND_MAX_PATH_LENGTH
  ) {
    throw new ToolCodexError(
      "WINDOWS_PLUGIN_CACHE_PATH_TOO_LONG",
      `installed Codex plugin command path exceeds the Win32 process-launch limit: ${commandPath.length} > ${WINDOWS_CODEX_PLUGIN_COMMAND_MAX_PATH_LENGTH}`,
      {
        commandPath,
        commandPathLength: commandPath.length,
        maxPathLength: WINDOWS_CODEX_PLUGIN_COMMAND_MAX_PATH_LENGTH,
        remedies: [
          "use a shorter tools-codex --state-root",
          "use a shorter distribution namespace",
          "use a compact development shell version",
        ],
      },
    );
  }
  return commandPath;
}

async function readCodexPluginMcpLaunch(
  buildReport: DistributionBuildReportV1,
): Promise<CodexPluginMcpLaunch> {
  const value = await readJson(join(buildReport.paths.shellRoot, ".mcp.json"));
  if (value == null || typeof value !== "object") {
    throw new ToolCodexError(
      "MCP_MANIFEST_INVALID",
      "Codex plugin MCP manifest must be an object",
    );
  }
  const server = (value as {
    mcpServers?: {
      "open-design"?: {
        args?: unknown;
        command?: unknown;
        cwd?: unknown;
        startup_timeout_sec?: unknown;
      };
    };
  }).mcpServers?.["open-design"];
  if (server == null
    || typeof server.command !== "string"
    || !server.command.startsWith("./")
    || !Array.isArray(server.args)
    || !server.args.every((entry): entry is string => typeof entry === "string")
    || server.cwd !== "."
    || typeof server.startup_timeout_sec !== "number"
    || !Number.isFinite(server.startup_timeout_sec)
    || server.startup_timeout_sec <= 0
    || server.startup_timeout_sec > 10) {
    throw new ToolCodexError(
      "MCP_MANIFEST_INVALID",
      "Codex plugin MCP manifest must declare a relative command, string args, cwd '.', and startup timeout at most 10 seconds",
    );
  }
  const commandEntry = normalizeDistributionInventoryPath(
    server.command.slice(2),
  );
  if (!buildReport.artifact.files.includes(commandEntry)) {
    throw new ToolCodexError(
      "MCP_COMMAND_NOT_IN_ARTIFACT",
      `Codex plugin MCP command is not part of the verified artifact: ${commandEntry}`,
    );
  }
  return {
    args: [...server.args],
    command: join(buildReport.paths.shellRoot, ...commandEntry.split("/")),
    commandEntry,
    startupTimeoutMs: server.startup_timeout_sec * 1_000,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout != null) clearTimeout(timeout);
  }
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
  const [{ marketplaceName }, launch] = await Promise.all([
    readMarketplace(buildReport),
    readCodexPluginMcpLaunch(buildReport),
  ]);
  assertCodexPluginCacheCommandPathSupported({
    codexHome: options.paths.codexHome,
    commandEntry: launch.commandEntry,
    marketplaceName,
    shellVersion: buildReport.identity.shellVersion,
  });
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
  const launch = await readCodexPluginMcpLaunch(buildReport);
  const args = [...launch.args];
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
    command: launch.command,
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
    await withTimeout(
      client.connect(transport),
      launch.startupTimeoutMs,
      `Codex plugin MCP initialize exceeded ${launch.startupTimeoutMs}ms`,
    );
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

export type ToolCodexHandoffReport = {
  buildReportPath: string;
  identity: DistributionIdentityV1;
  observation: unknown;
};

export async function runToolCodexHandoffProbe(options: {
  buildReportPath: string;
  fixtureReportUrl?: string;
  runtimeBinding: ToolCodexRuntimeBinding;
}): Promise<ToolCodexHandoffReport> {
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

export async function verifyAndRecordToolCodexRuntimeHandoff(options: {
  buildReportPath: string;
  fixtureReportUrl?: string;
  paths: ToolCodexPaths;
  runtimeBinding: ToolCodexRuntimeBinding;
}): Promise<ToolCodexHandoffReport & {
  runtime: ToolCodexVerifiedRuntimeState;
}> {
  const lock = await acquireToolCodexGlobalLock(options.paths, "handoff");
  try {
    const buildReportPath = resolve(options.buildReportPath);
    const buildReport = parseDistributionBuildReport(
      await readJson(buildReportPath),
    );
    const identityKey = distributionIdentityKey(buildReport.identity);
    const sentinel = await readToolCodexSentinel(options.paths);
    if (
      sentinel.prepared == null
      || sentinel.prepared.identityKey !== identityKey
      || await canonicalPath(sentinel.prepared.artifactRoot)
        !== await canonicalPath(buildReport.paths.artifactRoot)
    ) {
      throw new ToolCodexError(
        "RUNTIME_HANDOFF_PREPARE_MISMATCH",
        "handoff build must match the plugin prepared in this managed environment",
      );
    }
    const report = await runToolCodexHandoffProbe({
      buildReportPath,
      fixtureReportUrl: options.fixtureReportUrl,
      runtimeBinding: options.runtimeBinding,
    });
    const runtime: ToolCodexVerifiedRuntimeState = {
      buildReportPath,
      distributionChannelRoot:
        options.runtimeBinding.distributionChannelRoot,
      fixtureReportUrl: options.fixtureReportUrl ?? null,
      identityKey,
      runtimeManifestUrl: options.runtimeBinding.runtimeManifestUrl,
      verifiedAt: new Date().toISOString(),
    };
    await updateToolCodexSentinel(options.paths, (current) => {
      if (
        current.prepared == null
        || current.prepared.identityKey !== identityKey
      ) {
        throw new ToolCodexError(
          "RUNTIME_HANDOFF_PREPARE_MISMATCH",
          "prepared plugin changed before runtime handoff could be recorded",
        );
      }
      return {
        ...current,
        prepared: {
          ...current.prepared,
          runtime,
        },
      };
    });
    return { ...report, runtime };
  } finally {
    await lock.release();
  }
}

export const TOOL_CODEX_DESKTOP_UI_OBSERVATION_SCHEMA_VERSION = 2 as const;

export type ToolCodexDesktopUiObservationV2 = {
  capturedAt: string;
  outcome: "PASS" | "FAIL";
  provenance: {
    kind: "operator-captured-desktop-ui";
    operator: string;
    runId: string;
  };
  schemaVersion: typeof TOOL_CODEX_DESKTOP_UI_OBSERVATION_SCHEMA_VERSION;
  screenshot: {
    mediaType: "image/png";
    path: string;
    sha256: string;
  };
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
): ToolCodexDesktopUiObservationV2 {
  if (!isRecord(value)
    || value.schemaVersion !== TOOL_CODEX_DESKTOP_UI_OBSERVATION_SCHEMA_VERSION
    || value.server !== "open-design"
    || (
      value.tool !== "get_open_design_status"
      && value.tool !== "ensure_open_design_runtime"
    )
    || typeof value.capturedAt !== "string"
    || !Number.isFinite(Date.parse(value.capturedAt))
    || (value.outcome !== "PASS" && value.outcome !== "FAIL")
    || !isRecord(value.provenance)
    || value.provenance.kind !== "operator-captured-desktop-ui"
    || typeof value.provenance.operator !== "string"
    || value.provenance.operator.trim().length === 0
    || typeof value.provenance.runId !== "string"
    || value.provenance.runId.length === 0
    || !isRecord(value.screenshot)
    || value.screenshot.mediaType !== "image/png"
    || typeof value.screenshot.path !== "string"
    || value.screenshot.path.length === 0
    || typeof value.screenshot.sha256 !== "string"
    || !/^sha256:[0-9a-f]{64}$/.test(value.screenshot.sha256)
    || !isRecord(value.structuredContent)
    || !isRecord(value.structuredContent.identity)) {
    throw new ToolCodexError(
      "DESKTOP_UI_OBSERVATION_INVALID",
      "Desktop UI observation must include explicit operator provenance, a PNG screenshot digest, outcome, tool, and identity",
    );
  }
  return value as ToolCodexDesktopUiObservationV2;
}

export function classifyToolCodexAcceptance(
  signals: ToolCodexAcceptanceSignals,
  host: ToolCodexStatus,
): CodexDesktopAcceptanceStatus {
  if (!signals.artifactValid
    || !signals.stdioProbePassed
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
    || signals.desktopUiObserved == null) {
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

function unavailableEvidence(
  path: string | null,
  reasonCode: string | null = null,
): ToolCodexEvidenceEvaluation {
  return {
    available: false,
    capturedAt: null,
    identityMatches: null,
    outcome: null,
    reasonCode,
    reportPath: path,
    runMatches: null,
    screenshot: null,
    screenshotMatches: null,
    status: null,
    toolMatches: null,
  };
}

function isPng(bytes: Buffer): boolean {
  return bytes.length >= 33
    && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    && bytes.readUInt32BE(8) === 13
    && bytes.subarray(12, 16).equals(Buffer.from("IHDR"))
    && bytes.readUInt32BE(16) > 0
    && bytes.readUInt32BE(20) > 0;
}

export async function inspectToolCodexDesktopScreenshot(
  path: string,
  expectedDigest: string,
): Promise<ToolCodexEvidenceEvaluation["screenshot"] & {
  matches: boolean;
}> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ToolCodexError(
      "DESKTOP_UI_SCREENSHOT_INVALID",
      `Desktop UI screenshot must be a regular PNG file: ${path}`,
    );
  }
  const bytes = await readFile(path);
  if (!isPng(bytes)) {
    throw new ToolCodexError(
      "DESKTOP_UI_SCREENSHOT_INVALID",
      `Desktop UI screenshot is not a PNG file: ${path}`,
    );
  }
  const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return {
    matches: sha256 === expectedDigest,
    mediaType: "image/png",
    path,
    sha256,
    size: bytes.byteLength,
  };
}

async function writeScreenshotEvidence(path: string, bytes: Buffer): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink() === true) {
    throw new ToolCodexError(
      "DESKTOP_UI_SCREENSHOT_INVALID",
      `Desktop UI evidence path must not be a symbolic link: ${path}`,
    );
  }
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, bytes, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

async function evaluateDesktopUiObservation(
  observation: ToolCodexDesktopUiObservationV2 | null,
  reportPath: string | null,
  buildIdentity: DistributionIdentityV1,
  host: ToolCodexStatus,
  expectedTool: ToolCodexDesktopUiObservationV2["tool"],
): Promise<ToolCodexEvidenceEvaluation> {
  if (observation == null) {
    return unavailableEvidence(reportPath, "OPERATOR_SCREENSHOT_REQUIRED");
  }
  const identityMatch = identityMatches(
    buildIdentity,
    observation.structuredContent.identity,
  );
  const capturedAt = Date.parse(observation.capturedAt);
  const markerStartedAt = host.marker == null
    ? Number.NaN
    : Date.parse(host.marker.startedAt);
  const runMatches = host.marker != null
    && observation.provenance.runId === host.marker.runId
    && capturedAt >= markerStartedAt;
  const toolMatches = observation.tool === expectedTool;
  const screenshotPath = resolve(
    reportPath == null ? process.cwd() : dirname(reportPath),
    observation.screenshot.path,
  );
  let screenshot: ToolCodexEvidenceEvaluation["screenshot"] = null;
  let screenshotMatches = false;
  let screenshotReason: string | null = null;
  try {
    const inspected = await inspectToolCodexDesktopScreenshot(
      screenshotPath,
      observation.screenshot.sha256,
    );
    screenshot = {
      mediaType: inspected.mediaType,
      path: inspected.path,
      sha256: inspected.sha256,
      size: inspected.size,
    };
    screenshotMatches = inspected.matches;
    if (!inspected.matches) screenshotReason = "DESKTOP_UI_SCREENSHOT_DIGEST_MISMATCH";
  } catch (error) {
    screenshotReason = error instanceof ToolCodexError
      ? error.code
      : "DESKTOP_UI_SCREENSHOT_UNAVAILABLE";
  }
  if (!runMatches) {
    return {
      available: false,
      capturedAt: observation.capturedAt,
      identityMatches: identityMatch,
      outcome: observation.outcome,
      reasonCode: "STALE_FOR_CURRENT_RUN",
      reportPath,
      runMatches,
      screenshot,
      screenshotMatches,
      status: null,
      toolMatches,
    };
  }
  const reasonCode = observation.outcome === "FAIL"
    ? "OPERATOR_REPORTED_DESKTOP_FAILURE"
    : !identityMatch
      ? "DESKTOP_UI_IDENTITY_MISMATCH"
      : !toolMatches
        ? "DESKTOP_UI_TOOL_MISMATCH"
        : screenshotReason;
  const passed = reasonCode == null && screenshotMatches;
  return {
    available: true,
    capturedAt: observation.capturedAt,
    identityMatches: identityMatch,
    outcome: observation.outcome,
    reasonCode,
    reportPath,
    runMatches,
    screenshot,
    screenshotMatches,
    status: passed ? "PASS" : "FAIL",
    toolMatches,
  };
}

type RecordToolCodexDesktopUiObservationOptions = {
  appPath?: string;
  buildReportPath: string;
  codexBin?: string;
  operator: string;
  outcome?: "PASS" | "FAIL";
  outputPath?: string;
  paths: ToolCodexPaths;
  screenshotPath: string;
  tool: ToolCodexDesktopUiObservationV2["tool"];
};

async function recordToolCodexDesktopUiObservationUnlocked(
  options: RecordToolCodexDesktopUiObservationOptions,
): Promise<ToolCodexDesktopUiObservationV2> {
  if (options.operator.trim().length === 0) {
    throw new ToolCodexError(
      "OPERATOR_REQUIRED",
      "record-ui requires a non-empty operator",
    );
  }
  if (
    options.tool !== "get_open_design_status"
    && options.tool !== "ensure_open_design_runtime"
  ) {
    throw new ToolCodexError(
      "DESKTOP_UI_TOOL_INVALID",
      "record-ui tool must be get_open_design_status or ensure_open_design_runtime",
    );
  }
  const buildReportPath = resolve(options.buildReportPath);
  const buildReport = parseDistributionBuildReport(await readJson(buildReportPath));
  const host = await inspectToolCodexEnvironment({
    appPath: options.appPath,
    codexBin: options.codexBin ?? "codex",
    paths: options.paths,
  });
  if (host.state !== "running-controlled" || host.marker == null) {
    throw new ToolCodexError(
      "CONTROLLED_DESKTOP_REQUIRED",
      "record-ui requires the current namespaced controlled Desktop run",
    );
  }
  const screenshotPath = resolve(options.screenshotPath);
  if (extname(screenshotPath).toLowerCase() !== ".png") {
    throw new ToolCodexError(
      "DESKTOP_UI_SCREENSHOT_INVALID",
      "record-ui requires a PNG screenshot",
    );
  }
  const screenshotInfo = await stat(screenshotPath);
  if (screenshotInfo.mtimeMs < Date.parse(host.marker.startedAt)) {
    throw new ToolCodexError(
      "DESKTOP_UI_SCREENSHOT_STALE",
      "the screenshot predates the current controlled Desktop run",
    );
  }
  const screenshot = await inspectToolCodexDesktopScreenshot(screenshotPath, "");
  const outputPath = resolveToolCodexReportPath(
    options.paths,
    options.outputPath ?? options.paths.desktopUiObservationPath,
  );
  const recordedScreenshotPath = join(dirname(outputPath), "desktop-ui.png");
  await mkdir(dirname(recordedScreenshotPath), { recursive: true, mode: 0o700 });
  await writeScreenshotEvidence(recordedScreenshotPath, await readFile(screenshotPath));
  const observation: ToolCodexDesktopUiObservationV2 = {
    capturedAt: screenshotInfo.mtime.toISOString(),
    outcome: options.outcome ?? "PASS",
    provenance: {
      kind: "operator-captured-desktop-ui",
      operator: options.operator.trim(),
      runId: host.marker.runId,
    },
    schemaVersion: TOOL_CODEX_DESKTOP_UI_OBSERVATION_SCHEMA_VERSION,
    screenshot: {
      mediaType: screenshot.mediaType,
      path: "desktop-ui.png",
      sha256: screenshot.sha256,
    },
    server: "open-design",
    structuredContent: {
      identity: buildReport.identity,
    },
    tool: options.tool,
  };
  await writeToolCodexReport(options.paths, outputPath, observation);
  return observation;
}

export async function recordToolCodexDesktopUiObservation(
  options: RecordToolCodexDesktopUiObservationOptions,
): Promise<ToolCodexDesktopUiObservationV2> {
  const lock = await acquireToolCodexGlobalLock(options.paths, "record-ui");
  try {
    return await recordToolCodexDesktopUiObservationUnlocked(options);
  } finally {
    await lock.release();
  }
}

export async function runToolCodexAcceptance(options: {
  appPath?: string;
  buildReportPath: string;
  codexBin?: string;
  desktopUiObservationPath?: string;
  outputPath?: string;
  paths: ToolCodexPaths;
}): Promise<ToolCodexAcceptanceReport> {
  const sentinel = await readToolCodexSentinel(options.paths);
  const runtimeBinding = runtimeBindingFromPreparedState(sentinel.prepared);
  const fixtureReportUrl = sentinel.prepared?.runtime?.fixtureReportUrl
    ?? undefined;
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
      fixtureReportUrl,
      runtimeBinding,
    );
    stdioProbePassed = true;
  } catch (error) {
    stdioStatus = {
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const desktopUiObservationPath = resolve(
    options.desktopUiObservationPath ?? options.paths.desktopUiObservationPath,
  );
  let desktopUiObservation: ToolCodexDesktopUiObservationV2 | null = null;
  try {
    desktopUiObservation = parseToolCodexDesktopUiObservation(
      await readJson(desktopUiObservationPath),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const expectedTool = runtimeBinding == null
    ? "get_open_design_status"
    : "ensure_open_design_runtime";
  const evidence = {
    desktopUiObserved: await evaluateDesktopUiObservation(
      desktopUiObservation,
      desktopUiObservationPath,
      buildReport.identity,
      host,
      expectedTool,
    ),
  };
  const signals: ToolCodexAcceptanceSignals = {
    artifactValid,
    desktopControlled: host.desktop.controlled,
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
  if (signals.desktopUiObserved == null) {
    checkpoints.push(
      `Call ${expectedTool} in Desktop, capture a PNG screenshot, then run tools-codex record-ui.`,
    );
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
      expectedTool,
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
