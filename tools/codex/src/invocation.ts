import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertSameDistributionIdentity,
  distributionIdentityKey,
  parseDistributionBuildReport,
  type DistributionIdentityV1,
} from "@open-design/distribution-proto";
import { stopProcesses } from "@open-design/platform";

import {
  inspectToolCodexEnvironment,
  listProcessIdsWithEnvironmentValue,
  runCommand,
} from "./host.js";
import {
  ToolCodexError,
  acquireToolCodexGlobalLock,
  readToolCodexSentinel,
  writeToolCodexReport,
  type ToolCodexPaths,
} from "./state.js";
import {
  toolCodexRuntimeEnv,
  type ToolCodexRuntimeBinding,
} from "./runtime.js";

export const TOOL_CODEX_INVOCATION_SCHEMA_VERSION = 2 as const;
export const TOOLS_CODEX_INVOKE_ID_ENV = "OD_TOOLS_CODEX_INVOKE_ID";

const STATUS_TOOL_NAME = "get_open_design_status";
const ENSURE_RUNTIME_TOOL_NAME = "ensure_open_design_runtime";

function invocationPrompt(targetTool: string): string {
  return [
    "Use $open-design:open-design-status.",
    `Call the ${targetTool} tool exactly once.`,
    "Return only a compact confirmation containing the complete structured identity.",
  ].join(" ");
}

type JsonRecord = Record<string, unknown>;

export type ToolCodexInvocationAttempt = {
  commandExitCode: number;
  diagnostics: string[];
  durationMs: number;
  identity: DistributionIdentityV1 | null;
  identityMatches: boolean | null;
  index: number;
  invalidJsonLines: number;
  residualCleanup: {
    matchedPids: number[];
    remainingPids: number[];
    stoppedPids: number[];
  };
  retryable: boolean;
  status: "PASS" | "FAIL";
  targetTool: string;
  terminalEvent: "turn.completed" | "turn.failed" | null;
  threadId: string | null;
  timedOut: boolean;
  toolCallCount: number;
  toolCallError: string | null;
  toolCallStatus: string | null;
  usage: unknown | null;
};

export type ToolCodexAutomatedInvocationReportV1 = {
  attempts: ToolCodexInvocationAttempt[];
  buildReportPath: string;
  generatedAt: string;
  identity: DistributionIdentityV1;
  provenance: {
    approvalPolicy: "on-request";
    approvalsReviewer: "auto_review";
    desktopRootPid: number;
    desktopRunId: string;
    desktopRootStartedAt: string;
    ephemeral: true;
    invocationId: string;
    kind: "codex-exec-jsonl";
    sandbox: "read-only";
    workspace: string;
  };
  reasonCode: string | null;
  schemaVersion: typeof TOOL_CODEX_INVOCATION_SCHEMA_VERSION;
  status: "PASS" | "FAIL";
  successfulAttempt: number | null;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function canonicalPath(path: string): Promise<string> {
  return await realpath(path).catch(() => resolve(path));
}

function observedIdentity(value: unknown): DistributionIdentityV1 | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.identity)) return value.identity as DistributionIdentityV1;
  for (const key of ["structured_content", "structuredContent", "result"]) {
    if (key in value) {
      const identity = observedIdentity(value[key]);
      if (identity != null) return identity;
    }
  }
  return null;
}

export function parseCodexExecJsonl(
  stdout: string,
  expectedIdentity: DistributionIdentityV1,
  targetTool = STATUS_TOOL_NAME,
): Omit<ToolCodexInvocationAttempt, "commandExitCode" | "diagnostics" | "durationMs" | "index" | "residualCleanup" | "timedOut"> {
  const events: JsonRecord[] = [];
  let invalidJsonLines = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isRecord(value)) events.push(value);
      else invalidJsonLines += 1;
    } catch {
      invalidJsonLines += 1;
    }
  }
  const thread = events.find((event) =>
    event.type === "thread.started" && typeof event.thread_id === "string"
  );
  const targetCalls = events.filter((event) => {
    if (event.type !== "item.completed" || !isRecord(event.item)) return false;
    return event.item.type === "mcp_tool_call"
      && event.item.server === "open-design"
      && event.item.tool === targetTool;
  });
  const toolCall = targetCalls[0]?.item;
  const terminal = [...events].reverse().find((event) =>
    event.type === "turn.completed" || event.type === "turn.failed"
  );
  const identity = observedIdentity(toolCall);
  let identityMatches: boolean | null = null;
  if (identity != null) {
    try {
      assertSameDistributionIdentity(expectedIdentity, identity);
      identityMatches = true;
    } catch {
      identityMatches = false;
    }
  }
  const toolCallStatus = isRecord(toolCall) && typeof toolCall.status === "string"
    ? toolCall.status
    : null;
  const toolCallError = isRecord(toolCall)
    && isRecord(toolCall.error)
    && typeof toolCall.error.message === "string"
    ? toolCall.error.message
    : null;
  const terminalEvent = terminal?.type === "turn.completed"
    ? "turn.completed"
    : terminal?.type === "turn.failed"
      ? "turn.failed"
      : null;
  const passed = invalidJsonLines === 0
    && targetCalls.length === 1
    && toolCallStatus === "completed"
    && (!isRecord(toolCall) || toolCall.error == null)
    && identityMatches === true
    && terminalEvent === "turn.completed";
  const retryable = !passed
    && identityMatches !== false
    && targetCalls.length <= 1
    && toolCallStatus !== "failed"
    && (terminalEvent == null || targetCalls.length === 0 || invalidJsonLines > 0);
  return {
    identity,
    identityMatches,
    invalidJsonLines,
    retryable,
    status: passed ? "PASS" : "FAIL",
    targetTool,
    terminalEvent,
    threadId: typeof thread?.thread_id === "string" ? thread.thread_id : null,
    toolCallCount: targetCalls.length,
    toolCallError,
    toolCallStatus,
    usage: terminal?.type === "turn.completed" ? terminal.usage ?? null : null,
  };
}

export function parseToolCodexAutomatedInvocationReport(
  value: unknown,
): ToolCodexAutomatedInvocationReportV1 {
  if (!isRecord(value)
    || value.schemaVersion !== TOOL_CODEX_INVOCATION_SCHEMA_VERSION
    || (value.status !== "PASS" && value.status !== "FAIL")
    || !isRecord(value.provenance)
    || value.provenance.kind !== "codex-exec-jsonl"
    || typeof value.provenance.desktopRunId !== "string"
    || typeof value.provenance.desktopRootPid !== "number"
    || typeof value.provenance.desktopRootStartedAt !== "string"
    || typeof value.provenance.invocationId !== "string"
    || !isRecord(value.identity)
    || !Array.isArray(value.attempts)
    || typeof value.buildReportPath !== "string"
    || typeof value.generatedAt !== "string") {
    throw new ToolCodexError(
      "AUTOMATED_INVOCATION_REPORT_INVALID",
      "automated invocation report is invalid",
    );
  }
  if (value.provenance.approvalPolicy !== "on-request"
    || value.provenance.approvalsReviewer !== "auto_review"
    || value.provenance.ephemeral !== true
    || value.provenance.sandbox !== "read-only"
    || typeof value.provenance.workspace !== "string"
    || (value.successfulAttempt != null
      && (typeof value.successfulAttempt !== "number"
        || !Number.isSafeInteger(value.successfulAttempt)))) {
    throw new ToolCodexError(
      "AUTOMATED_INVOCATION_REPORT_INVALID",
      "automated invocation provenance is invalid",
    );
  }
  const attempts = value.attempts;
  const attemptIsValid = (attempt: unknown): attempt is ToolCodexInvocationAttempt => {
    if (!isRecord(attempt)
      || (attempt.status !== "PASS" && attempt.status !== "FAIL")
      || typeof attempt.index !== "number"
      || typeof attempt.commandExitCode !== "number"
      || typeof attempt.durationMs !== "number"
      || typeof attempt.invalidJsonLines !== "number"
      || typeof attempt.retryable !== "boolean"
      || typeof attempt.timedOut !== "boolean"
      || typeof attempt.toolCallCount !== "number"
      || (attempt.toolCallError != null
        && typeof attempt.toolCallError !== "string")
      || typeof attempt.targetTool !== "string"
      || !isRecord(attempt.residualCleanup)
      || !Array.isArray(attempt.residualCleanup.matchedPids)
      || !Array.isArray(attempt.residualCleanup.remainingPids)
      || !Array.isArray(attempt.residualCleanup.stoppedPids)) {
      return false;
    }
    return true;
  };
  if (!attempts.every(attemptIsValid)) {
    throw new ToolCodexError(
      "AUTOMATED_INVOCATION_REPORT_INVALID",
      "automated invocation attempts are invalid",
    );
  }
  if (value.status === "PASS") {
    const successfulAttempt = attempts.find((attempt) =>
      attempt.index === value.successfulAttempt
    );
    if (successfulAttempt == null
      || successfulAttempt.status !== "PASS"
      || successfulAttempt.commandExitCode !== 0
      || successfulAttempt.identityMatches !== true
      || successfulAttempt.invalidJsonLines !== 0
      || successfulAttempt.terminalEvent !== "turn.completed"
      || successfulAttempt.timedOut !== false
      || successfulAttempt.toolCallCount !== 1
      || successfulAttempt.toolCallError !== null
      || successfulAttempt.toolCallStatus !== "completed"
      || successfulAttempt.residualCleanup.remainingPids.length !== 0) {
      throw new ToolCodexError(
        "AUTOMATED_INVOCATION_REPORT_INVALID",
        "passing automated invocation evidence is internally inconsistent",
      );
    }
  }
  return value as ToolCodexAutomatedInvocationReportV1;
}

function invocationProcessCandidate(command: string): boolean {
  return command.includes("codex")
    || command.includes("./mcp/server.mjs");
}

function diagnosticLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-20)
    .map((line) => line.slice(0, 2_000));
}

export async function runToolCodexAutomatedInvocation(options: {
  appPath?: string;
  buildReportPath: string;
  codexBin?: string;
  maxAttempts?: number;
  outputPath?: string;
  paths: ToolCodexPaths;
  runtimeBinding?: ToolCodexRuntimeBinding | null;
  timeoutMs?: number;
}): Promise<ToolCodexAutomatedInvocationReportV1> {
  const buildReportPath = resolve(options.buildReportPath);
  const buildReport = parseDistributionBuildReport(await readJson(buildReportPath));
  const sentinel = await readToolCodexSentinel(options.paths);
  const preparedIdentityMatches = sentinel.prepared != null
    && sentinel.prepared.identityKey === distributionIdentityKey(buildReport.identity)
    && await canonicalPath(sentinel.prepared.artifactRoot)
      === await canonicalPath(buildReport.paths.artifactRoot);
  if (!preparedIdentityMatches) {
    throw new ToolCodexError(
      "PREPARED_IDENTITY_MISMATCH",
      "automated invocation requires the exact build to be prepared",
    );
  }
  const maxAttempts = options.maxAttempts ?? 2;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new ToolCodexError(
      "MAX_ATTEMPTS_INVALID",
      "automated invocation max attempts must be between 1 and 3",
    );
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new ToolCodexError(
      "INVOKE_TIMEOUT_INVALID",
      "automated invocation timeout must be between 1000 and 600000 milliseconds",
    );
  }

  const lock = await acquireToolCodexGlobalLock(options.paths, "invoke");
  try {
    const host = await inspectToolCodexEnvironment({
      appPath: options.appPath,
      codexBin: options.codexBin,
      paths: options.paths,
    });
    if (host.state !== "running-controlled" || host.marker == null) {
      throw new ToolCodexError(
        host.reasonCode ?? "CONTROLLED_DESKTOP_REQUIRED",
        "automated invocation requires one controlled Codex Desktop instance",
      );
    }
    if (host.cli.loggedIn !== true) {
      throw new ToolCodexError(
        "CODEX_LOGIN_REQUIRED",
        "automated invocation requires the managed Codex home to be logged in",
      );
    }
    const invocationId = randomUUID();
    const targetTool = options.runtimeBinding == null
      ? STATUS_TOOL_NAME
      : ENSURE_RUNTIME_TOOL_NAME;
    const attempts: ToolCodexInvocationAttempt[] = [];
    for (let index = 1; index <= maxAttempts; index += 1) {
      const startedAt = Date.now();
      const result = await runCommand(options.codexBin ?? "codex", [
        "--enable",
        "plugins",
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "on-request",
        "-c",
        'approvals_reviewer="auto_review"',
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-C",
        options.paths.workspaceRoot,
        "--json",
        invocationPrompt(targetTool),
      ], {
        env: {
          ...process.env,
          CODEX_HOME: options.paths.codexHome,
          [TOOLS_CODEX_INVOKE_ID_ENV]: invocationId,
          ...toolCodexRuntimeEnv(options.runtimeBinding),
        },
        timeoutMs,
      });
      const parsed = parseCodexExecJsonl(
        result.stdout,
        buildReport.identity,
        targetTool,
      );
      const matchedPids = await listProcessIdsWithEnvironmentValue({
        commandMatches: invocationProcessCandidate,
        name: TOOLS_CODEX_INVOKE_ID_ENV,
        value: invocationId,
      });
      const cleanup = await stopProcesses(matchedPids);
      const status = result.code === 0
        && !result.timedOut
        && cleanup.remainingPids.length === 0
        && parsed.status === "PASS"
        ? "PASS"
        : "FAIL";
      attempts.push({
        ...parsed,
        commandExitCode: result.code,
        diagnostics: diagnosticLines(result.stderr),
        durationMs: Date.now() - startedAt,
        index,
        residualCleanup: {
          matchedPids: cleanup.matchedPids,
          remainingPids: cleanup.remainingPids,
          stoppedPids: cleanup.stoppedPids,
        },
        retryable: parsed.retryable || result.code !== 0 || result.timedOut,
        status,
        timedOut: result.timedOut,
      });
      if (status === "PASS") break;
      if (!(parsed.retryable || result.code !== 0 || result.timedOut)
        || cleanup.remainingPids.length > 0) {
        break;
      }
    }

    const currentHost = await inspectToolCodexEnvironment({
      appPath: options.appPath,
      codexBin: options.codexBin,
      paths: options.paths,
    });
    const hostStayedControlled = currentHost.state === "running-controlled"
      && currentHost.marker?.runId === host.marker.runId
      && currentHost.marker.rootPid === host.marker.rootPid
      && currentHost.marker.rootStartedAt === host.marker.rootStartedAt;
    const successfulAttempt = attempts.find((attempt) => attempt.status === "PASS")?.index ?? null;
    const report: ToolCodexAutomatedInvocationReportV1 = {
      attempts,
      buildReportPath,
      generatedAt: new Date().toISOString(),
      identity: buildReport.identity,
      provenance: {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        desktopRootPid: host.marker.rootPid,
        desktopRootStartedAt: host.marker.rootStartedAt,
        desktopRunId: host.marker.runId,
        ephemeral: true,
        invocationId,
        kind: "codex-exec-jsonl",
        sandbox: "read-only",
        workspace: options.paths.workspaceRoot,
      },
      reasonCode: successfulAttempt == null
        ? "AUTOMATED_INVOCATION_FAILED"
        : hostStayedControlled
          ? null
          : "DESKTOP_CONTROL_CHANGED_DURING_INVOCATION",
      schemaVersion: TOOL_CODEX_INVOCATION_SCHEMA_VERSION,
      status: successfulAttempt != null && hostStayedControlled ? "PASS" : "FAIL",
      successfulAttempt,
    };
    await writeToolCodexReport(
      options.paths,
      options.outputPath ?? options.paths.invocationReportPath,
      report,
    );
    return report;
  } finally {
    await lock.release();
  }
}
