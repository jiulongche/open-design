import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  assertSameDistributionIdentity,
  distributionIdentityKey,
  parseDistributionBuildReport,
  type DistributionIdentityV1,
} from "@open-design/distribution-proto";
import {
  listProcessSnapshotsStrict,
  type ProcessSnapshot,
} from "@open-design/platform";

import {
  TOOLS_CODEX_HOME_DIGEST_ENV,
  TOOLS_CODEX_RUN_ID_ENV,
  codexHomeDigest,
  inspectToolCodexEnvironment,
  readProcessCwd,
  readProcessEnvironmentValue,
  readProcessStartedAt,
  runCommand,
} from "./host.js";
import {
  ToolCodexError,
  acquireToolCodexGlobalLock,
  readToolCodexSentinel,
  writeToolCodexReport,
  type ToolCodexPaths,
  type ToolCodexRunMarkerV1,
} from "./state.js";

export const TOOL_CODEX_DESKTOP_HOST_LOAD_SCHEMA_VERSION = 1 as const;

export type ToolCodexProcessEvidence = {
  command: string;
  cwd: string | null;
  pid: number;
  ppid: number;
  startedAt: string | null;
};

export type ToolCodexDesktopHostLoadReportV1 = {
  buildReportPath: string;
  checks: {
    appServerDescendsFromRoot: boolean;
    appServerHomeStampMatches: boolean;
    appServerRunStampMatches: boolean;
    cachedIdentityMatches: boolean;
    desktopClientObserved: boolean;
    pluginCwdMatchesExpected: boolean | null;
    pluginDescendsFromAppServer: boolean | null;
    pluginHomeStampMatches: boolean | null;
    pluginRunStampMatches: boolean | null;
    preparedIdentityMatches: boolean;
    rootControlled: boolean;
  };
  expectedPluginCacheRoot: string;
  generatedAt: string;
  identity: DistributionIdentityV1;
  processes: {
    appServer: ToolCodexProcessEvidence | null;
    pluginMcp: ToolCodexProcessEvidence | null;
    root: ToolCodexProcessEvidence;
  };
  provenance: {
    kind: "desktop-host-load";
    observationKind: "app-server-log" | "process-chain";
    runId: string;
    rootPid: number;
    rootStartedAt: string;
  };
  logEvidence: {
    appServerProcessUuid: string;
    desktopClientObserved: boolean;
    initializedAt: string;
    serverName: "open-design";
    serverVersion: string;
  } | null;
  reasonCode: string | null;
  schemaVersion: typeof TOOL_CODEX_DESKTOP_HOST_LOAD_SCHEMA_VERSION;
  status: "PASS" | "FAIL";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function canonicalPath(path: string): Promise<string> {
  return await realpath(path).catch(() => resolve(path));
}

function commandRunsDesktopAppServer(command: string, marker: ToolCodexRunMarkerV1): boolean {
  const executable = join(marker.appPath, "Contents", "Resources", "codex");
  return command.startsWith(`${executable} `)
    && /(?:^|\s)app-server(?:\s|$)/.test(command);
}

function commandRunsOpenDesignPluginMcp(command: string): boolean {
  return /(?:^|\s)(?:\S*\/)?node(?:\s|$)/.test(command)
    && /(?:^|\s)\.\/mcp\/server\.mjs(?:\s|$)/.test(command)
    && /(?:^|\s)--identity-file(?:=|\s+)\.\/distribution\.json(?:\s|$)/.test(command);
}

export function processDescendsFrom(
  processes: readonly ProcessSnapshot[],
  pid: number,
  ancestorPid: number,
): boolean {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const visited = new Set<number>();
  let current = byPid.get(pid);
  while (current != null && !visited.has(current.pid)) {
    if (current.ppid === ancestorPid) return true;
    visited.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return false;
}

export function findDesktopHostLoadCandidates(
  processes: readonly ProcessSnapshot[],
  marker: ToolCodexRunMarkerV1,
): Array<{ appServer: ProcessSnapshot; pluginMcp: ProcessSnapshot }> {
  const appServers = processes.filter((entry) =>
    commandRunsDesktopAppServer(entry.command, marker)
    && processDescendsFrom(processes, entry.pid, marker.rootPid)
  );
  return appServers.flatMap((appServer) =>
    processes
      .filter((entry) =>
        commandRunsOpenDesignPluginMcp(entry.command)
        && processDescendsFrom(processes, entry.pid, appServer.pid)
      )
      .map((pluginMcp) => ({ appServer, pluginMcp }))
  );
}

export type DesktopHostLoadLogEvidence = NonNullable<
  ToolCodexDesktopHostLoadReportV1["logEvidence"]
>;

export function parseDesktopHostLoadLogRow(value: {
  body: unknown;
  processUuid: unknown;
  ts: unknown;
}): Omit<DesktopHostLoadLogEvidence, "desktopClientObserved"> | null {
  if (typeof value.body !== "string"
    || typeof value.processUuid !== "string"
    || typeof value.ts !== "number") {
    return null;
  }
  if (!value.body.includes("server_name=open-design")
    || !value.body.includes("Service initialized")) {
    return null;
  }
  const implementation = value.body.match(
    /Implementation \{ name: "open-design".*?version: "([^"]+)"/,
  );
  if (implementation == null) return null;
  return {
    appServerProcessUuid: value.processUuid,
    initializedAt: new Date(value.ts * 1_000).toISOString(),
    serverName: "open-design",
    serverVersion: implementation[1],
  };
}

async function readDesktopHostLoadLogEvidence(options: {
  appServerPid: number;
  codexHome: string;
  desktopVersion: string | null;
  shellVersion: string;
  startedAt: string;
}): Promise<DesktopHostLoadLogEvidence | null> {
  const startedAtSeconds = Math.floor(Date.parse(options.startedAt) / 1_000);
  const result = await runCommand("sqlite3", [
    "-json",
    join(options.codexHome, "logs_2.sqlite"),
    `
      SELECT
        feedback_log_body AS body,
        process_uuid AS processUuid,
        ts
      FROM logs
      WHERE ts >= ${startedAtSeconds}
        AND process_uuid LIKE 'pid:${options.appServerPid}:%'
        AND (
          (
            feedback_log_body LIKE '%server_name=open-design%'
            AND feedback_log_body LIKE '%Service initialized%'
          )
          OR feedback_log_body LIKE '%app_server.client_name="Codex Desktop"%'
        )
      ORDER BY ts DESC, ts_nanos DESC, id DESC
      LIMIT 100
    `,
  ]);
  if (result.code !== 0) return null;
  let rows: Array<{
    body?: unknown;
    processUuid?: unknown;
    ts?: unknown;
  }>;
  try {
    const value = JSON.parse(result.stdout) as unknown;
    rows = Array.isArray(value) ? value : [];
  } catch {
    return null;
  }
  const initialized = rows
    .map((row) => parseDesktopHostLoadLogRow({
      body: row.body,
      processUuid: row.processUuid,
      ts: row.ts,
    }))
    .find((entry) => entry?.serverVersion === options.shellVersion);
  if (initialized == null) return null;
  const desktopClientObserved = rows.some((row) =>
    row.processUuid === initialized.appServerProcessUuid
    && typeof row.body === "string"
    && row.body.includes('app_server.client_name="Codex Desktop"')
    && (options.desktopVersion == null
      || row.body.includes(`app_server.client_version="${options.desktopVersion}"`))
  );
  return {
    ...initialized,
    desktopClientObserved,
  };
}

async function processEvidence(
  processInfo: ProcessSnapshot,
  cwd?: string | null,
): Promise<ToolCodexProcessEvidence> {
  return {
    command: processInfo.command,
    cwd: cwd === undefined ? await readProcessCwd(processInfo.pid) : cwd,
    pid: processInfo.pid,
    ppid: processInfo.ppid,
    startedAt: await readProcessStartedAt(processInfo.pid),
  };
}

async function logBackedHostLoadReport(options: {
  appServer: ProcessSnapshot | null;
  buildReportPath: string;
  cachedIdentityMatches: boolean;
  codexHome: string;
  desktopVersion: string | null;
  expectedPluginCacheRoot: string;
  identity: DistributionIdentityV1;
  marker: ToolCodexRunMarkerV1;
  preparedIdentityMatches: boolean;
  processes: ProcessSnapshot[];
  root: ProcessSnapshot;
}): Promise<ToolCodexDesktopHostLoadReportV1> {
  const appServerStamps = options.appServer == null
    ? { homeDigest: null, runId: null }
    : {
        homeDigest: await readProcessEnvironmentValue(
          options.appServer.pid,
          TOOLS_CODEX_HOME_DIGEST_ENV,
        ),
        runId: await readProcessEnvironmentValue(
          options.appServer.pid,
          TOOLS_CODEX_RUN_ID_ENV,
        ),
      };
  const logEvidence = options.appServer == null
    ? null
    : await readDesktopHostLoadLogEvidence({
        appServerPid: options.appServer.pid,
        codexHome: options.codexHome,
        desktopVersion: options.desktopVersion,
        shellVersion: options.identity.shellVersion,
        startedAt: options.marker.startedAt,
      });
  const appServerDescendsFromRoot = options.appServer != null
    && processDescendsFrom(
      options.processes,
      options.appServer.pid,
      options.marker.rootPid,
    );
  const appServerHomeStampMatches = appServerStamps.homeDigest
    === codexHomeDigest(options.codexHome);
  const appServerRunStampMatches = appServerStamps.runId
    === options.marker.runId;
  const passed = logEvidence != null
    && logEvidence.desktopClientObserved
    && appServerDescendsFromRoot
    && appServerHomeStampMatches
    && appServerRunStampMatches
    && options.cachedIdentityMatches
    && options.preparedIdentityMatches;
  return {
    buildReportPath: options.buildReportPath,
    checks: {
      appServerDescendsFromRoot,
      appServerHomeStampMatches,
      appServerRunStampMatches,
      cachedIdentityMatches: options.cachedIdentityMatches,
      desktopClientObserved: logEvidence?.desktopClientObserved ?? false,
      pluginCwdMatchesExpected: null,
      pluginDescendsFromAppServer: null,
      pluginHomeStampMatches: null,
      pluginRunStampMatches: null,
      preparedIdentityMatches: options.preparedIdentityMatches,
      rootControlled: true,
    },
    expectedPluginCacheRoot: options.expectedPluginCacheRoot,
    generatedAt: new Date().toISOString(),
    identity: options.identity,
    logEvidence,
    processes: {
      appServer: options.appServer == null
        ? null
        : await processEvidence(options.appServer),
      pluginMcp: null,
      root: await processEvidence(options.root),
    },
    provenance: {
      kind: "desktop-host-load",
      observationKind: "app-server-log",
      rootPid: options.marker.rootPid,
      rootStartedAt: options.marker.rootStartedAt,
      runId: options.marker.runId,
    },
    reasonCode: passed ? null : "DESKTOP_PLUGIN_MCP_NOT_OBSERVED",
    schemaVersion: TOOL_CODEX_DESKTOP_HOST_LOAD_SCHEMA_VERSION,
    status: passed ? "PASS" : "FAIL",
  };
}

export function parseToolCodexDesktopHostLoadReport(
  value: unknown,
): ToolCodexDesktopHostLoadReportV1 {
  if (!isRecord(value)
    || value.schemaVersion !== TOOL_CODEX_DESKTOP_HOST_LOAD_SCHEMA_VERSION
    || (value.status !== "PASS" && value.status !== "FAIL")
    || !isRecord(value.provenance)
    || value.provenance.kind !== "desktop-host-load"
    || (value.provenance.observationKind !== "process-chain"
      && value.provenance.observationKind !== "app-server-log")
    || typeof value.provenance.runId !== "string"
    || typeof value.provenance.rootPid !== "number"
    || typeof value.provenance.rootStartedAt !== "string"
    || !isRecord(value.identity)
    || typeof value.buildReportPath !== "string"
    || typeof value.expectedPluginCacheRoot !== "string"
    || typeof value.generatedAt !== "string"
    || !isRecord(value.checks)
    || !isRecord(value.processes)) {
    throw new ToolCodexError(
      "DESKTOP_HOST_LOAD_REPORT_INVALID",
      "Desktop host-load report is invalid",
    );
  }
  const checks = value.checks;
  const processes = value.processes;
  const observationKind = value.provenance.observationKind;
  const booleanChecks = [
    "appServerDescendsFromRoot",
    "appServerHomeStampMatches",
    "appServerRunStampMatches",
    "cachedIdentityMatches",
    "desktopClientObserved",
    "preparedIdentityMatches",
    "rootControlled",
  ] as const;
  const optionalBooleanChecks = [
    "pluginCwdMatchesExpected",
    "pluginDescendsFromAppServer",
    "pluginHomeStampMatches",
    "pluginRunStampMatches",
  ] as const;
  const processIsValid = (processValue: unknown): boolean =>
    isRecord(processValue)
    && typeof processValue.command === "string"
    && (processValue.cwd == null || typeof processValue.cwd === "string")
    && typeof processValue.pid === "number"
    && typeof processValue.ppid === "number"
    && (processValue.startedAt == null || typeof processValue.startedAt === "string");
  if (booleanChecks.some((key) => typeof checks[key] !== "boolean")
    || optionalBooleanChecks.some((key) =>
      checks[key] != null && typeof checks[key] !== "boolean"
    )
    || !processIsValid(processes.root)
    || (processes.appServer != null && !processIsValid(processes.appServer))
    || (processes.pluginMcp != null && !processIsValid(processes.pluginMcp))) {
    throw new ToolCodexError(
      "DESKTOP_HOST_LOAD_REPORT_INVALID",
      "Desktop host-load report checks or process evidence are invalid",
    );
  }
  if (value.status === "PASS") {
    const commonPassed = booleanChecks.every((key) => checks[key] === true);
    const processPassed = observationKind === "process-chain"
      && optionalBooleanChecks.every((key) => checks[key] === true)
      && processes.appServer != null
      && processes.pluginMcp != null
      && value.logEvidence == null;
    const logPassed = observationKind === "app-server-log"
      && optionalBooleanChecks.every((key) => checks[key] == null)
      && processes.appServer != null
      && processes.pluginMcp == null
      && isRecord(value.logEvidence)
      && typeof value.logEvidence.appServerProcessUuid === "string"
      && value.logEvidence.desktopClientObserved === true
      && typeof value.logEvidence.initializedAt === "string"
      && value.logEvidence.serverName === "open-design"
      && typeof value.logEvidence.serverVersion === "string";
    if (!commonPassed || (!processPassed && !logPassed)) {
      throw new ToolCodexError(
        "DESKTOP_HOST_LOAD_REPORT_INVALID",
        "passing Desktop host-load evidence is internally inconsistent",
      );
    }
  }
  return value as ToolCodexDesktopHostLoadReportV1;
}

export async function captureToolCodexDesktopHostLoad(options: {
  appPath?: string;
  buildReportPath: string;
  codexBin?: string;
  outputPath?: string;
  paths: ToolCodexPaths;
  timeoutMs?: number;
}): Promise<ToolCodexDesktopHostLoadReportV1> {
  const buildReportPath = resolve(options.buildReportPath);
  const buildReport = parseDistributionBuildReport(await readJson(buildReportPath));
  const sentinel = await readToolCodexSentinel(options.paths);
  const preparedIdentityMatches = sentinel.prepared != null
    && sentinel.prepared.identityKey === distributionIdentityKey(buildReport.identity)
    && await canonicalPath(sentinel.prepared.artifactRoot)
      === await canonicalPath(buildReport.paths.artifactRoot);
  if (!preparedIdentityMatches || sentinel.prepared == null) {
    throw new ToolCodexError(
      "PREPARED_IDENTITY_MISMATCH",
      "Desktop host-load capture requires the exact build to be prepared",
    );
  }

  const expectedPluginCacheRoot = await canonicalPath(join(
    options.paths.codexHome,
    "plugins",
    "cache",
    sentinel.prepared.marketplaceName,
    "open-design",
    buildReport.identity.shellVersion,
  ));
  let cachedIdentityMatches = false;
  try {
    const cachedIdentity = await readJson(join(
      expectedPluginCacheRoot,
      "distribution.json",
    ));
    assertSameDistributionIdentity(
      buildReport.identity,
      cachedIdentity as DistributionIdentityV1,
    );
    cachedIdentityMatches = true;
  } catch {
    cachedIdentityMatches = false;
  }
  const lock = await acquireToolCodexGlobalLock(options.paths, "capture-host-load");
  try {
    const host = await inspectToolCodexEnvironment({
      appPath: options.appPath,
      codexBin: options.codexBin,
      paths: options.paths,
    });
    if (host.state !== "running-controlled" || host.marker == null) {
      throw new ToolCodexError(
        host.reasonCode ?? "CONTROLLED_DESKTOP_REQUIRED",
        "Desktop host-load capture requires one controlled Codex Desktop instance",
      );
    }
    const marker = host.marker;
    const root = host.desktop.roots.find((entry) => entry.pid === marker.rootPid);
    if (root == null) {
      throw new ToolCodexError(
        "CONTROL_IDENTITY_MISMATCH",
        "controlled Desktop root is missing from the current process snapshot",
      );
    }
    let observedAppServer: ProcessSnapshot | null = null;
    let observedProcesses: ProcessSnapshot[] = [];
    let nextLogProbeAt = 0;
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      const processes = await listProcessSnapshotsStrict();
      observedProcesses = processes;
      observedAppServer = processes.find((entry) =>
        commandRunsDesktopAppServer(entry.command, marker)
        && processDescendsFrom(processes, entry.pid, marker.rootPid)
      ) ?? observedAppServer;
      for (const candidate of findDesktopHostLoadCandidates(processes, marker)) {
        const [
          cwd,
          pluginRunId,
          pluginHomeDigest,
          appServerRunId,
          appServerHomeDigest,
        ] = await Promise.all([
          readProcessCwd(candidate.pluginMcp.pid),
          readProcessEnvironmentValue(candidate.pluginMcp.pid, TOOLS_CODEX_RUN_ID_ENV),
          readProcessEnvironmentValue(candidate.pluginMcp.pid, TOOLS_CODEX_HOME_DIGEST_ENV),
          readProcessEnvironmentValue(candidate.appServer.pid, TOOLS_CODEX_RUN_ID_ENV),
          readProcessEnvironmentValue(candidate.appServer.pid, TOOLS_CODEX_HOME_DIGEST_ENV),
        ]);
        if (cwd == null) continue;
        const canonicalCwd = await canonicalPath(cwd);
        const checks = {
          appServerDescendsFromRoot: processDescendsFrom(
            processes,
            candidate.appServer.pid,
            marker.rootPid,
          ),
          appServerHomeStampMatches:
            appServerHomeDigest === codexHomeDigest(options.paths.codexHome),
          appServerRunStampMatches: appServerRunId === marker.runId,
          cachedIdentityMatches,
          desktopClientObserved: true,
          pluginCwdMatchesExpected: canonicalCwd === expectedPluginCacheRoot,
          pluginHomeStampMatches:
            pluginHomeDigest === codexHomeDigest(options.paths.codexHome),
          pluginDescendsFromAppServer: processDescendsFrom(
            processes,
            candidate.pluginMcp.pid,
            candidate.appServer.pid,
          ),
          pluginRunStampMatches: pluginRunId === marker.runId,
          preparedIdentityMatches,
          rootControlled: true,
        };
        if (!Object.values(checks).every(Boolean)) continue;
        const report: ToolCodexDesktopHostLoadReportV1 = {
          buildReportPath,
          checks,
          expectedPluginCacheRoot,
          generatedAt: new Date().toISOString(),
          identity: buildReport.identity,
          logEvidence: null,
          processes: {
            appServer: await processEvidence(candidate.appServer),
            pluginMcp: await processEvidence(candidate.pluginMcp, canonicalCwd),
            root: await processEvidence(root),
          },
          provenance: {
            kind: "desktop-host-load",
            observationKind: "process-chain",
            rootPid: marker.rootPid,
            rootStartedAt: marker.rootStartedAt,
            runId: marker.runId,
          },
          reasonCode: null,
          schemaVersion: TOOL_CODEX_DESKTOP_HOST_LOAD_SCHEMA_VERSION,
          status: "PASS",
        };
        await writeToolCodexReport(
          options.paths,
          options.outputPath ?? options.paths.desktopHostLoadReportPath,
          report,
        );
        return report;
      }
      if (observedAppServer != null && Date.now() >= nextLogProbeAt) {
        nextLogProbeAt = Date.now() + 1_000;
        const logReport = await logBackedHostLoadReport({
          appServer: observedAppServer,
          buildReportPath,
          cachedIdentityMatches,
          codexHome: options.paths.codexHome,
          desktopVersion: marker.desktopVersion,
          expectedPluginCacheRoot,
          identity: buildReport.identity,
          marker,
          preparedIdentityMatches,
          processes,
          root,
        });
        if (logReport.status === "PASS") {
          await writeToolCodexReport(
            options.paths,
            options.outputPath ?? options.paths.desktopHostLoadReportPath,
            logReport,
          );
          return logReport;
        }
      }
      await sleep(250);
    }

    if (observedAppServer == null) {
      observedProcesses = await listProcessSnapshotsStrict();
      observedAppServer = observedProcesses.find((entry) =>
        commandRunsDesktopAppServer(entry.command, marker)
        && processDescendsFrom(observedProcesses, entry.pid, marker.rootPid)
      ) ?? null;
    }
    const report = await logBackedHostLoadReport({
      appServer: observedAppServer,
      buildReportPath,
      cachedIdentityMatches,
      codexHome: options.paths.codexHome,
      desktopVersion: marker.desktopVersion,
      expectedPluginCacheRoot,
      identity: buildReport.identity,
      marker,
      preparedIdentityMatches,
      processes: observedProcesses,
      root,
    });
    await writeToolCodexReport(
      options.paths,
      options.outputPath ?? options.paths.desktopHostLoadReportPath,
      report,
    );
    return report;
  } finally {
    await lock.release();
  }
}
