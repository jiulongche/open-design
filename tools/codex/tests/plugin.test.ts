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
  classifyToolCodexAcceptance,
  extractObservedIdentity,
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
    available: true,
    controlled: true,
    roots: [{
      command: "/Applications/Codex.app/Contents/MacOS/ChatGPT",
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
    namespaceRoot: "/managed",
    stateRoot: "/state",
  },
  reasonCode: null,
  state: "running-controlled",
};

const SIGNALS: ToolCodexAcceptanceSignals = {
  artifactValid: true,
  automatedInvocation: true,
  desktopControlled: true,
  desktopHostLoaded: true,
  desktopRunning: true,
  desktopUiObserved: null,
  loggedIn: true,
  marketplaceConfigured: true,
  pluginInstalled: true,
  stdioProbePassed: true,
};

describe("tools-codex acceptance", () => {
  it("passes with exact host-load and same-home invocation evidence", () => {
    expect(classifyToolCodexAcceptance(SIGNALS, HOST)).toBe("PASS");
    expect(classifyToolCodexAcceptance({
      ...SIGNALS,
      automatedInvocation: null,
    }, HOST)).toBe("OPERATOR_ACTION_REQUIRED");
    expect(classifyToolCodexAcceptance({
      ...SIGNALS,
      desktopUiObserved: true,
    }, HOST)).toBe("PASS");
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

  it("extracts identity from a tool result envelope", () => {
    const identity = { channel: "stable" };
    expect(extractObservedIdentity({
      result: { structured_content: { identity } },
    })).toEqual(identity);
  });

  it("requires explicit run provenance for optional Desktop UI evidence", () => {
    expect(parseToolCodexDesktopUiObservation({
      capturedAt: "2026-07-27T12:00:00.000Z",
      provenance: {
        kind: "operator-captured-desktop-ui",
        runId: "run-123",
      },
      schemaVersion: 1,
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
    expect(() => parseToolCodexDesktopUiObservation({
      identity: { channel: "stable" },
    })).toThrowError(expect.objectContaining({
      code: "DESKTOP_UI_OBSERVATION_INVALID",
    }));
  });

  it("detects packed artifact drift before Desktop acceptance", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-tools-codex-artifact-"));
    roots.push(root);
    const shellRoot = join(root, "marketplace", "plugins", "open-design");
    const manifestPath = join(shellRoot, ".codex-plugin", "plugin.json");
    const serverPath = join(shellRoot, "mcp", "server.mjs");
    await mkdir(join(shellRoot, ".codex-plugin"), { recursive: true });
    await mkdir(join(shellRoot, "mcp"), { recursive: true });
    await writeFile(manifestPath, "{}");
    await writeFile(serverPath, "export {};\n");
    const identity: DistributionIdentityV1 = {
      channel: "stable",
      namespace: "codex-smoke",
      protocolVersion: 1,
      runtimeDigest: `sha256:${"a".repeat(64)}`,
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
      schemaVersion: 1,
    };

    await expect(verifyToolCodexArtifact(report)).resolves.toBeUndefined();
    await writeFile(serverPath, "export const changed = true;\n");
    await expect(verifyToolCodexArtifact(report)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_MISMATCH",
    });
  });
});
