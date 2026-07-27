import { describe, expect, it } from "vitest";

import {
  findDesktopHostLoadCandidates,
  parseDesktopHostLoadLogRow,
  parseToolCodexDesktopHostLoadReport,
  processDescendsFrom,
} from "../src/desktop-evidence.js";
import type { ToolCodexRunMarkerV1 } from "../src/state.js";

const MARKER = {
  appPath: "/Applications/Codex.app",
  codexHome: "/managed/codex-home",
  desktopVersion: "26.721.41059",
  executablePath: "/Applications/Codex.app/Contents/MacOS/ChatGPT",
  namespace: "desktop-smoke",
  owner: "open-design/tools-codex",
  rootPid: 10,
  rootStartedAt: "Mon Jul 27 12:00:00 2026",
  runId: "run-123",
  schemaVersion: 1,
  startedAt: "2026-07-27T04:00:00.000Z",
  workspace: "/managed/workspace",
} satisfies ToolCodexRunMarkerV1;

describe("tools-codex Desktop host-load provenance", () => {
  it("requires a controlled-root descendant app-server and its direct plugin child", () => {
    const processes = [
      {
        command: MARKER.executablePath,
        pid: 10,
        ppid: 1,
      },
      {
        command: "/Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper",
        pid: 11,
        ppid: 10,
      },
      {
        command: "/Applications/Codex.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled",
        pid: 12,
        ppid: 11,
      },
      {
        command: "node ./mcp/server.mjs --identity-file ./distribution.json",
        pid: 13,
        ppid: 12,
      },
      {
        command: "node ./mcp/server.mjs --identity-file ./distribution.json",
        pid: 14,
        ppid: 99,
      },
    ];

    expect(processDescendsFrom(processes, 12, 10)).toBe(true);
    expect(processDescendsFrom(processes, 14, 10)).toBe(false);
    expect(findDesktopHostLoadCandidates(processes, MARKER)).toEqual([{
      appServer: processes[2],
      pluginMcp: processes[3],
    }]);
  });

  it("rejects lookalike app-server and plugin commands", () => {
    expect(findDesktopHostLoadCandidates([
      {
        command: MARKER.executablePath,
        pid: 10,
        ppid: 1,
      },
      {
        command: "/tmp/codex app-server",
        pid: 12,
        ppid: 10,
      },
      {
        command: "node ./mcp/server.mjs --identity-file ./other.json",
        pid: 13,
        ppid: 12,
      },
    ], MARKER)).toEqual([]);
  });

  it("extracts durable app-server plugin initialization evidence", () => {
    expect(parseDesktopHostLoadLogRow({
      body: 'new{server_name=open-design}:start_server_task{server_name=open-design}:initialize:serve_inner: Service initialized as client peer_info=Some(InitializeResult { server_info: Implementation { name: "open-design", title: None, version: "0.1.0", description: None } })',
      processUuid: "pid:12:uuid-123",
      ts: 1785151063,
    })).toEqual({
      appServerProcessUuid: "pid:12:uuid-123",
      initializedAt: "2026-07-27T11:17:43.000Z",
      serverName: "open-design",
      serverVersion: "0.1.0",
    });
  });

  it("rejects a forged PASS with incomplete host checks", () => {
    expect(() => parseToolCodexDesktopHostLoadReport({
      buildReportPath: "/tmp/build-report.json",
      checks: {
        appServerDescendsFromRoot: false,
        appServerHomeStampMatches: false,
        appServerRunStampMatches: false,
        cachedIdentityMatches: false,
        desktopClientObserved: false,
        pluginCwdMatchesExpected: null,
        pluginDescendsFromAppServer: null,
        pluginHomeStampMatches: null,
        pluginRunStampMatches: null,
        preparedIdentityMatches: false,
        rootControlled: false,
      },
      expectedPluginCacheRoot: "/managed/cache",
      generatedAt: "2026-07-27T12:00:00.000Z",
      identity: { channel: "stable" },
      logEvidence: null,
      processes: {
        appServer: null,
        pluginMcp: null,
        root: {
          command: MARKER.executablePath,
          cwd: "/",
          pid: 10,
          ppid: 1,
          startedAt: MARKER.rootStartedAt,
        },
      },
      provenance: {
        kind: "desktop-host-load",
        observationKind: "app-server-log",
        rootPid: 10,
        rootStartedAt: MARKER.rootStartedAt,
        runId: MARKER.runId,
      },
      reasonCode: null,
      schemaVersion: 1,
      status: "PASS",
    })).toThrowError(expect.objectContaining({
      code: "DESKTOP_HOST_LOAD_REPORT_INVALID",
    }));
  });
});
