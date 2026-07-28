import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  CODEX_ELECTRON_AGENT_RUN_ID_ENV,
  CODEX_ELECTRON_USER_DATA_PATH_ENV,
  assertStopRootOwnership,
  codexHomeDigest,
  createWindowsRestrictedDesktopLaunchRequest,
  findCodexDesktopRoots,
  parseWindowsCodexDesktopApplication,
  parseWindowsRestrictedDesktopLaunchHandshake,
  quoteWindowsCommandLineArgument,
  readEnvironmentValue,
  readProcessEnvironmentValues,
  runCommand,
  windowsDesktopLoginIsUsable,
  windowsUserDataDirectoryArgument,
} from "../src/host.js";
import {
  resolveToolCodexPaths,
  type ToolCodexRunMarkerV1,
} from "../src/state.js";

const MARKER = {
  appPath: "/Applications/Codex.app",
  codexHome: "/managed/codex-home",
  desktopUserDataPath: null,
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
    ], undefined, "darwin");

    expect(roots).toEqual([{
      command: "/Applications/Codex.app/Contents/MacOS/ChatGPT",
      executablePath: "/Applications/Codex.app/Contents/MacOS/ChatGPT",
      pid: 10,
      ppid: 1,
    }]);
  });

  it("finds the exact installed Windows MSIX root with app launch arguments", () => {
    const executablePath =
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe";
    const rootCommand = [
      `"${executablePath}"`,
      "--no-first-run",
      "--no-startup-window",
      "--enable-features=OwlAuth,OwlDownloads",
      "codex://threads/new?path=%5C%5C%3F%5CC%3A%5Cmanaged%5Cworkspace",
    ].join(" ");
    const roots = findCodexDesktopRoots([
      {
        command: rootCommand,
        executablePath,
        pid: 20,
        ppid: 10,
        startedAt: "2026-07-28T06:06:32.2147100Z",
      },
      {
        command: `"${executablePath}" --type=renderer --lang=zh-CN`,
        executablePath,
        pid: 21,
        ppid: 20,
      },
      {
        command: "\"C:\\foreign\\ChatGPT.exe\"",
        executablePath: "C:\\foreign\\ChatGPT.exe",
        pid: 22,
        ppid: 10,
      },
    ], executablePath, "win32");

    expect(roots).toEqual([{
      command: rootCommand,
      executablePath,
      pid: 20,
      ppid: 10,
      startedAt: "2026-07-28T06:06:32.2147100Z",
    }]);
    expect(findCodexDesktopRoots([
      {
        command: rootCommand,
        executablePath,
        pid: 20,
        ppid: 10,
      },
    ], undefined, "win32")).toHaveLength(1);
  });

  it("parses the exact Windows package identity and AUMID", () => {
    expect(parseWindowsCodexDesktopApplication(JSON.stringify({
      AppId: "App",
      Aumid: "OpenAI.Codex_2p2nqsd0c76g0!App",
      ExecutablePath:
        "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe",
      InstallLocation:
        "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0",
      PackageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
      PackageFullName:
        "OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0",
      Version: "26.721.4979.0",
    }))).toMatchObject({
      applicationId: "App",
      aumid: "OpenAI.Codex_2p2nqsd0c76g0!App",
      packageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
      version: "26.721.4979.0",
    });
  });

  it("builds one restricted Windows launch with explicit profile isolation", () => {
    const application = parseWindowsCodexDesktopApplication(JSON.stringify({
      AppId: "App",
      Aumid: "OpenAI.Codex_2p2nqsd0c76g0!App",
      ExecutablePath:
        "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe",
      InstallLocation:
        "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0",
      PackageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
      PackageFullName:
        "OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0",
      Version: "26.721.4979.0",
    }));
    const paths = resolveToolCodexPaths({
      namespace: "desktop-smoke",
      stateRoot: "/managed state",
    });
    const request = createWindowsRestrictedDesktopLaunchRequest({
      application,
      paths,
      runId: "run-123",
      runtimeBinding: {
        distributionChannelRoot: "C:\\managed runtime",
        runtimeManifestUrl: "https://example.test/runtime.json",
      },
      systemRoot: "C:\\Windows",
      workspace: "C:\\managed workspace",
    });

    expect(request.runasPath).toBe("C:\\Windows\\System32\\runas.exe");
    expect(request.runasArgs[0]).toBe("/trustlevel:0x20000");
    expect(request.payload.arguments).toEqual([
      `--user-data-dir=${paths.desktopUserDataPath}`,
      expect.stringMatching(/^codex:\/\/threads\/new\?path=/),
    ]);
    expect(request.payload.environment).toMatchObject({
      CODEX_HOME: paths.codexHome,
      [CODEX_ELECTRON_AGENT_RUN_ID_ENV]:
        "open-design-tools-codex-run-123",
      [CODEX_ELECTRON_USER_DATA_PATH_ENV]: paths.desktopUserDataPath,
      OD_TOOLS_CODEX_RUN_ID: "run-123",
    });
    expect(request.payload.argumentLine).toContain("\"--user-data-dir=");
    expect(request.helperCommand).toContain("-EncodedCommand");
  });

  it("quotes Windows arguments without losing trailing slashes or quotes", () => {
    expect(quoteWindowsCommandLineArgument("plain")).toBe("plain");
    expect(quoteWindowsCommandLineArgument("C:\\managed path\\")).toBe(
      "\"C:\\managed path\\\\\"",
    );
    expect(quoteWindowsCommandLineArgument("say \"ok\"")).toBe(
      "\"say \\\"ok\\\"\"",
    );
  });

  it("validates a non-admin restricted helper handshake", () => {
    const handshake = parseWindowsRestrictedDesktopLaunchHandshake(
      `\uFEFF${JSON.stringify({
        childPid: 20,
        completedAt: "2026-07-28T12:00:00.0000000+08:00",
        helperPid: 10,
        isAdministrator: false,
        owner: "open-design/tools-codex",
        runId: "run-123",
        schemaVersion: 1,
      })}`,
      "run-123",
    );
    expect(handshake.childPid).toBe(20);
    expect(() => parseWindowsRestrictedDesktopLaunchHandshake({
      ...handshake,
      isAdministrator: true,
    }, "run-123")).toThrowError(expect.objectContaining({
      code: "RESTRICTED_HELPER_TOKEN_INVALID",
    }));
  });

  it("requires ChatGPT authentication for Windows Desktop", () => {
    expect(windowsDesktopLoginIsUsable({
      code: 0,
      stderr: "",
      stdout: "Logged in using ChatGPT",
    })).toBe(true);
    expect(windowsDesktopLoginIsUsable({
      code: 0,
      stderr: "",
      stdout: "Logged in using an API key",
    })).toBe(false);
    expect(windowsDesktopLoginIsUsable({
      code: 1,
      stderr: "Not logged in",
      stdout: "",
    })).toBe(false);
  });

  it("extracts only an explicit Chromium user-data argument", () => {
    expect(windowsUserDataDirectoryArgument(
      "\"C:\\app\\ChatGPT.exe\" --user-data-dir=\"C:\\managed profile\" codex://threads/new",
    )).toBe("C:\\managed profile");
    expect(windowsUserDataDirectoryArgument(
      "\"C:\\app\\ChatGPT.exe\" codex://threads/new",
    )).toBeNull();
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

  it.runIf(process.platform === "win32" && process.arch === "x64")(
    "reads selected stamps from an owned native Windows process",
    async () => {
      const child = spawn(process.execPath, [
        "-e",
        "setInterval(() => {}, 60_000)",
      ], {
        env: {
          ...process.env,
          OD_TOOLS_CODEX_ENV_READER_TEST: "reader proof=ok",
          OD_TOOLS_CODEX_ENV_READER_UNREQUESTED: "must-not-be-returned",
        },
        stdio: "ignore",
        windowsHide: true,
      });
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child.once("error", rejectSpawn);
        child.once("spawn", resolveSpawn);
      });
      expect(child.pid).toBeTypeOf("number");
      try {
        const values = await readProcessEnvironmentValues(child.pid!, [
          "OD_TOOLS_CODEX_ENV_READER_TEST",
          "OD_TOOLS_CODEX_ENV_READER_MISSING",
        ]);
        expect(values).toEqual({
          OD_TOOLS_CODEX_ENV_READER_MISSING: null,
          OD_TOOLS_CODEX_ENV_READER_TEST: "reader proof=ok",
        });
        expect(values).not.toHaveProperty(
          "OD_TOOLS_CODEX_ENV_READER_UNREQUESTED",
        );
      } finally {
        child.kill();
        await new Promise<void>((resolveExit) => {
          if (child.exitCode != null) resolveExit();
          else child.once("exit", () => resolveExit());
        });
      }
    },
  );

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
