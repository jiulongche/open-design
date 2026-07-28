import type { DistributionIdentityV1 } from "@open-design/distribution-proto";
import { describe, expect, it } from "vitest";

import {
  parseCodexExecJsonl,
  parseToolCodexAutomatedInvocationReport,
} from "../src/invocation.js";

const IDENTITY: DistributionIdentityV1 = {
  channel: "stable",
  namespace: "codex-smoke",
  protocolVersion: 1,
  runtimeDigest: `sha256:${"a".repeat(64)}`,
  runtimeVersion: "0.16.1",
  shellDigest: `sha256:${"b".repeat(64)}`,
  shellType: "codex-plugin",
  shellVersion: "0.1.0",
};

function jsonl(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

describe("tools-codex automated invocation evidence", () => {
  it("accepts one completed status tool call and terminal turn", () => {
    const result = parseCodexExecJsonl(jsonl(
      {
        thread_id: "thread-123",
        type: "thread.started",
      },
      {
        item: {
          arguments: {},
          error: null,
          result: {
            structured_content: {
              identity: IDENTITY,
            },
          },
          server: "open-design",
          status: "completed",
          tool: "get_open_design_status",
          type: "mcp_tool_call",
        },
        type: "item.completed",
      },
      {
        type: "turn.completed",
        usage: {
          cached_input_tokens: 100,
          input_tokens: 200,
          output_tokens: 10,
        },
      },
    ), IDENTITY);

    expect(result).toMatchObject({
      identityMatches: true,
      invalidJsonLines: 0,
      retryable: false,
      status: "PASS",
      terminalEvent: "turn.completed",
      threadId: "thread-123",
      toolCallCount: 1,
      toolCallStatus: "completed",
    });
  });

  it("accepts the static runtime handoff tool when selected", () => {
    expect(parseCodexExecJsonl(jsonl(
      {
        item: {
          error: null,
          result: {
            structured_content: {
              binding: {
                channel: IDENTITY.channel,
                namespace: IDENTITY.namespace,
                protocolVersion: IDENTITY.protocolVersion,
                runtimeDigest: IDENTITY.runtimeDigest,
                runtimeVersion: IDENTITY.runtimeVersion,
              },
              identity: IDENTITY,
            },
          },
          server: "open-design",
          status: "completed",
          tool: "ensure_open_design_runtime",
          type: "mcp_tool_call",
        },
        type: "item.completed",
      },
      { type: "turn.completed" },
    ), IDENTITY, "ensure_open_design_runtime")).toMatchObject({
      identityMatches: true,
      status: "PASS",
      targetTool: "ensure_open_design_runtime",
      toolCallCount: 1,
    });
  });

  it("does not retry identity mismatch or duplicate target calls", () => {
    const wrongIdentity = {
      ...IDENTITY,
      shellVersion: "9.9.9",
    };
    const call = {
      item: {
        error: null,
        result: {
          structured_content: {
            identity: wrongIdentity,
          },
        },
        server: "open-design",
        status: "completed",
        tool: "get_open_design_status",
        type: "mcp_tool_call",
      },
      type: "item.completed",
    };
    expect(parseCodexExecJsonl(jsonl(
      call,
      { type: "turn.completed" },
    ), IDENTITY)).toMatchObject({
      identityMatches: false,
      retryable: false,
      status: "FAIL",
    });
    expect(parseCodexExecJsonl(jsonl(
      {
        ...call,
        item: {
          ...call.item,
          result: { structured_content: { identity: IDENTITY } },
        },
      },
      {
        ...call,
        item: {
          ...call.item,
          result: { structured_content: { identity: IDENTITY } },
        },
      },
      { type: "turn.completed" },
    ), IDENTITY)).toMatchObject({
      retryable: false,
      status: "FAIL",
      toolCallCount: 2,
    });
  });

  it("marks an incomplete transport-shaped result as retryable", () => {
    expect(parseCodexExecJsonl(jsonl(
      {
        thread_id: "thread-123",
        type: "thread.started",
      },
    ), IDENTITY)).toMatchObject({
      retryable: true,
      status: "FAIL",
      terminalEvent: null,
      toolCallCount: 0,
    });
  });

  it("rejects a forged PASS without a passing attempt", () => {
    expect(() => parseToolCodexAutomatedInvocationReport({
      attempts: [],
      buildReportPath: "/tmp/build-report.json",
      generatedAt: "2026-07-27T12:00:00.000Z",
      identity: IDENTITY,
      provenance: {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        desktopRootPid: 10,
        desktopRootStartedAt: "Mon Jul 27 12:00:00 2026",
        desktopRunId: "run-123",
        ephemeral: true,
        invocationId: "invoke-123",
        kind: "codex-exec-jsonl",
        sandbox: "read-only",
        workspace: "/managed/workspace",
      },
      reasonCode: null,
      schemaVersion: 2,
      status: "PASS",
      successfulAttempt: 1,
    })).toThrowError(expect.objectContaining({
      code: "AUTOMATED_INVOCATION_REPORT_INVALID",
    }));
  });
});
