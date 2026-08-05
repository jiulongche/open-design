import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  calculateDistributionArtifactInventory,
  type DistributionBuildReportV1,
  type DistributionIdentityV1,
} from "@open-design/distribution-proto";
import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_PLUGIN_TOOL_TIMEOUT_MAX_SECONDS,
  WINDOWS_CODEX_PLUGIN_COMMAND_MAX_PATH_LENGTH,
  assertCodexPluginCacheCommandPathSupported,
  classifyToolCodexAcceptance,
  currentIdentityFromStdioObservation,
  inspectToolCodexDesktopScreenshot,
  parseCodexPluginToolTimeoutMs,
  parseToolCodexDesktopUiObservation,
  verifyToolCodexArtifact,
  type ToolCodexAcceptanceSignals,
} from "../src/plugin.js";
import type { ToolCodexStatus } from "../src/host.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

const HOST: ToolCodexStatus = {
  cli: {
    available: true,
    loggedIn: true,
    loginStatus: "Logged in",
    version: "codex-cli 0.145.0",
  },
  desktop: {
    appPath: "/Applications/Codex.app",
    applicationId: null,
    aumid: null,
    available: true,
    controlled: true,
    executablePath: "/Applications/Codex.app/Contents/MacOS/ChatGPT",
    packageFamilyName: null,
    packageFullName: null,
    roots: [{
      command: "/Applications/Codex.app/Contents/MacOS/ChatGPT",
      executablePath: "/Applications/Codex.app/Contents/MacOS/ChatGPT",
      pid: 1,
      ppid: 0,
    }],
    version: "26.721.41059",
  },
  lock: null,
  marker: null,
  namespace: "desktop-smoke",
  paths: {
    codexHome: "/managed/codex-home",
    desktopUserDataPath: "/managed/desktop-user-data",
    namespaceRoot: "/managed",
    stateRoot: "/state",
  },
  reasonCode: null,
  state: "running-controlled",
};

const SIGNALS: ToolCodexAcceptanceSignals = {
  artifactValid: true,
  desktopControlled: true,
  desktopRunning: true,
  desktopUiObserved: true,
  loggedIn: true,
  marketplaceConfigured: true,
  pluginInstalled: true,
  stdioProbePassed: true,
};

describe("tools-codex acceptance", () => {
  it("honors the MCP manifest tool timeout for production cold starts", () => {
    expect(parseCodexPluginToolTimeoutMs(120)).toBe(120_000);
    expect(() => parseCodexPluginToolTimeoutMs(0)).toThrowError(
      expect.objectContaining({ code: "MCP_MANIFEST_INVALID" }),
    );
    expect(() => parseCodexPluginToolTimeoutMs(
      CODEX_PLUGIN_TOOL_TIMEOUT_MAX_SECONDS + 1,
    )).toThrowError(expect.objectContaining({ code: "MCP_MANIFEST_INVALID" }));
  });

  it("uses the selected runtime identity without changing shell fields", () => {
    const fallback = {
      channel: "beta",
      namespace: "release-beta",
      protocolVersion: 1,
      runtimeDigest: `sha256:${"a".repeat(64)}`,
      runtimeVersion: "0.16.2-beta.1",
      shellDigest: `sha256:${"b".repeat(64)}`,
      shellType: "codex-plugin",
      shellVersion: "0.1.0",
    } as const;

    expect(currentIdentityFromStdioObservation({
      runtime: {
        identity: {
          ...fallback,
          runtimeDigest: `sha256:${"c".repeat(64)}`,
          runtimeVersion: "0.16.2-beta.2",
        },
      },
    }, fallback)).toMatchObject({
      runtimeDigest: `sha256:${"c".repeat(64)}`,
      runtimeVersion: "0.16.2-beta.2",
      shellDigest: fallback.shellDigest,
      shellVersion: fallback.shellVersion,
    });
  });

  it("fails before install when the Windows plugin carrier path exceeds MAX_PATH", () => {
    expect(assertCodexPluginCacheCommandPathSupported({
      codexHome: "C:\\od",
      commandEntry: "bin/node.exe",
      marketplaceName: "open-design-smoke-win32-x64",
      platform: "win32",
      shellVersion: "0.1.0+w1",
    })).toBe(
      "C:\\od\\plugins\\cache\\open-design-smoke-win32-x64\\open-design\\0.1.0+w1\\bin\\node.exe",
    );

    const codexHome = `C:\\${"a".repeat(
      WINDOWS_CODEX_PLUGIN_COMMAND_MAX_PATH_LENGTH,
    )}`;
    expect(() => assertCodexPluginCacheCommandPathSupported({
      codexHome,
      commandEntry: "bin/node.exe",
      marketplaceName: "open-design-smoke-win32-x64",
      platform: "win32",
      shellVersion: "0.1.0+codex.local-20260728-155035",
    })).toThrowError(expect.objectContaining({
      code: "WINDOWS_PLUGIN_CACHE_PATH_TOO_LONG",
    }));
  });

  it("requires operator-confirmed Desktop screenshot evidence", () => {
    expect(classifyToolCodexAcceptance(SIGNALS, HOST)).toBe("PASS");
    expect(classifyToolCodexAcceptance({
      ...SIGNALS,
      desktopUiObserved: null,
    }, HOST)).toBe("OPERATOR_ACTION_REQUIRED");
    expect(classifyToolCodexAcceptance({
      ...SIGNALS,
      desktopUiObserved: false,
    }, HOST)).toBe("FAIL");
  });

  it("separates unmanaged host state from product failure", () => {
    expect(classifyToolCodexAcceptance(SIGNALS, {
      ...HOST,
      desktop: { ...HOST.desktop, controlled: false },
      reasonCode: "UNMANAGED_DESKTOP_INSTANCE",
      state: "running-unmanaged",
    })).toBe("BLOCKED_BY_HOST_STATE");
    expect(classifyToolCodexAcceptance({
      ...SIGNALS,
      stdioProbePassed: false,
    }, HOST)).toBe("FAIL");
  });

  it("requires explicit operator, screenshot, outcome, and run provenance", () => {
    expect(parseToolCodexDesktopUiObservation({
      capturedAt: "2026-07-27T12:00:00.000Z",
      outcome: "PASS",
      provenance: {
        kind: "operator-captured-desktop-ui",
        operator: "Nexu",
        runId: "run-123",
      },
      schemaVersion: 2,
      screenshot: {
        mediaType: "image/png",
        path: "desktop.png",
        sha256: `sha256:${"c".repeat(64)}`,
      },
      server: "open-design",
      structuredContent: {
        identity: {
          channel: "stable",
        },
      },
      tool: "get_open_design_status",
    })).toMatchObject({
      provenance: { runId: "run-123" },
    });
    expect(parseToolCodexDesktopUiObservation({
      capturedAt: "2026-07-27T12:00:00.000Z",
      outcome: "PASS",
      provenance: {
        kind: "operator-captured-desktop-ui",
        operator: "Nexu",
        runId: "run-123",
      },
      schemaVersion: 2,
      screenshot: {
        mediaType: "image/png",
        path: "desktop.png",
        sha256: `sha256:${"d".repeat(64)}`,
      },
      server: "open-design",
      structuredContent: {
        identity: {
          channel: "stable",
        },
      },
      tool: "ensure_open_design_runtime",
    })).toMatchObject({
      tool: "ensure_open_design_runtime",
    });
    expect(() => parseToolCodexDesktopUiObservation({
      identity: { channel: "stable" },
    })).toThrowError(expect.objectContaining({
      code: "DESKTOP_UI_OBSERVATION_INVALID",
    }));
  });

  it("binds Desktop evidence to a regular PNG and its exact digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-tools-codex-ui-"));
    roots.push(root);
    const screenshotPath = join(root, "desktop.png");
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      .copy(png);
    png.writeUInt32BE(13, 8);
    Buffer.from("IHDR").copy(png, 12);
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    await writeFile(screenshotPath, png);
    const digest =
      `sha256:${createHash("sha256").update(png).digest("hex")}`;

    await expect(inspectToolCodexDesktopScreenshot(
      screenshotPath,
      digest,
    )).resolves.toMatchObject({
      matches: true,
      mediaType: "image/png",
      path: screenshotPath,
      sha256: digest,
      size: png.byteLength,
    });
    await expect(inspectToolCodexDesktopScreenshot(
      screenshotPath,
      `sha256:${"0".repeat(64)}`,
    )).resolves.toMatchObject({
      matches: false,
    });
  });

  it("detects packed artifact drift before Desktop acceptance", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-tools-codex-artifact-"));
    roots.push(root);
    const shellRoot = join(root, "marketplace", "plugins", "open-design");
    const manifestPath = join(shellRoot, ".codex-plugin", "plugin.json");
    const serverPath = join(shellRoot, "mcp", "server.mjs");
    const runtimePath = join(root, "runtime", "runtime.mjs");
    await mkdir(join(shellRoot, ".codex-plugin"), { recursive: true });
    await mkdir(join(shellRoot, "mcp"), { recursive: true });
    await mkdir(join(root, "runtime"), { recursive: true });
    await writeFile(manifestPath, "{}");
    await writeFile(serverPath, "export {};\n");
    const runtimeBytes = Buffer.from("export const runtime = true;\n");
    await writeFile(runtimePath, runtimeBytes);
    const identity: DistributionIdentityV1 = {
      channel: "stable",
      namespace: "codex-smoke",
      protocolVersion: 1,
      runtimeDigest:
        `sha256:${createHash("sha256").update(runtimeBytes).digest("hex")}`,
      runtimeVersion: "0.16.1",
      shellDigest: "",
      shellType: "codex-plugin",
      shellVersion: "0.1.0",
    };
    const artifact = calculateDistributionArtifactInventory([
      { bytes: Buffer.from("{}"), path: ".codex-plugin/plugin.json" },
      { bytes: Buffer.from("export {};\n"), path: "mcp/server.mjs" },
    ]);
    identity.shellDigest = artifact.digest;
    await writeFile(join(shellRoot, "distribution.json"), JSON.stringify(identity));
    const report: DistributionBuildReportV1 = {
      artifact,
      identity,
      paths: {
        artifactRoot: join(root, "marketplace"),
        manifestPath,
        shellRoot,
      },
      runtimeArtifact: {
        digest: identity.runtimeDigest,
        entryPath: "runtime.mjs",
        path: runtimePath,
        size: runtimeBytes.byteLength,
      },
      schemaVersion: 1,
    };

    await expect(verifyToolCodexArtifact(report)).resolves.toBeUndefined();
    await writeFile(runtimePath, "export const runtime = false;\n");
    await expect(verifyToolCodexArtifact(report)).rejects.toMatchObject({
      code: "RUNTIME_ARTIFACT_INTEGRITY_MISMATCH",
    });
    await writeFile(runtimePath, runtimeBytes);
    await writeFile(serverPath, "export const changed = true;\n");
    await expect(verifyToolCodexArtifact(report)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_MISMATCH",
    });
  });
});
