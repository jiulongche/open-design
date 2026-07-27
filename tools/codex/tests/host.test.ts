import { describe, expect, it } from "vitest";

import {
  assertStopRootOwnership,
  codexHomeDigest,
  findCodexDesktopRoots,
  readEnvironmentValue,
  runCommand,
} from "../src/host.js";
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

describe("tools-codex host identity", () => {
  it("finds only exact Codex Desktop root commands", () => {
    const roots = findCodexDesktopRoots([
      {
        command: "/Applications/Codex.app/Contents/MacOS/ChatGPT",
        pid: 10,
        ppid: 1,
      },
      {
        command: "/Applications/Codex.app/Contents/MacOS/ChatGPT --foreign",
        pid: 11,
        ppid: 1,
      },
      {
        command: "/Applications/Codex.app/Contents/Resources/codex app-server",
        pid: 12,
        ppid: 10,
      },
    ]);

    expect(roots).toEqual([{
      command: "/Applications/Codex.app/Contents/MacOS/ChatGPT",
      executablePath: "/Applications/Codex.app/Contents/MacOS/ChatGPT",
      pid: 10,
      ppid: 1,
    }]);
  });

  it("reads only the requested environment stamp", () => {
    const output = [
      "/Applications/Codex.app/Contents/MacOS/ChatGPT",
      "CODEX_HOME=/managed/home",
      "OD_TOOLS_CODEX_RUN_ID=run-123",
      "SECRET=do-not-read",
    ].join(" ");

    expect(readEnvironmentValue(output, "OD_TOOLS_CODEX_RUN_ID")).toBe("run-123");
    expect(readEnvironmentValue(output, "MISSING")).toBeNull();
  });

  it("derives a stable canonical-home stamp", () => {
    expect(codexHomeDigest("/tmp/a")).toMatch(/^[0-9a-f]{64}$/);
    expect(codexHomeDigest("/tmp/a")).toBe(codexHomeDigest("/tmp/a"));
    expect(codexHomeDigest("/tmp/a")).not.toBe(codexHomeDigest("/tmp/b"));
  });

  it("refuses to stop a root that does not match the recorded controlled pid", () => {
    expect(() => assertStopRootOwnership([{
      command: MARKER.executablePath,
      executablePath: MARKER.executablePath,
      pid: 11,
      ppid: 1,
    }], MARKER)).toThrowError(expect.objectContaining({
      code: "UNMANAGED_DESKTOP_INSTANCE",
    }));
    expect(assertStopRootOwnership([{
      command: MARKER.executablePath,
      executablePath: MARKER.executablePath,
      pid: MARKER.rootPid,
      ppid: 1,
    }], MARKER)?.pid).toBe(MARKER.rootPid);
  });

  it("closes child stdin so non-interactive commands observe EOF", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'))",
    ], {
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      code: 0,
      stdout: "eof",
      timedOut: false,
    });
  });
});
