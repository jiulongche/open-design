import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODEX_PLUGIN_HANDOFF_STATES,
  CODEX_PLUGIN_PLATFORM_TARGETS,
  CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
  CODEX_PLUGIN_RUNTIME_MEDIA_TYPES,
  CodexPluginProtocolError,
  assertCodexPluginHandoffTransition,
  compareCodexPluginShellVersions,
  normalizeCodexPluginPlatformTarget,
  parseCodexPluginAcquisitionManifest,
  parseCodexPluginFixtureReport,
  parseCodexPluginHandoffDescriptor,
  parseCodexPluginRuntimeReady,
  resolveCodexPluginReleasePaths,
  resolveCodexPluginShellPaths,
  resolveCodexPluginSuitePaths,
} from "../src/index.js";
import { resolveDistributionSuitePaths } from "@open-design/distribution-proto";

const RUNTIME_DIGEST = `sha256:${"a".repeat(64)}`;
const TOKEN_DIGEST = `sha256:${"b".repeat(64)}`;

function manifest() {
  return {
    artifact: {
      digest: RUNTIME_DIGEST,
      entryPath: "runtime.mjs",
      mediaType: CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.NODE_MODULE_V1,
      size: 42,
      url: "http://127.0.0.1:17456/runtime.mjs",
    },
    channel: "beta",
    control: {
      codexPlugin: {
        version: {
          min: "0.1.0",
        },
      },
    },
    namespace: "release-beta",
    protocolVersion: 1,
    runtimeDigest: RUNTIME_DIGEST,
    runtimeVersion: "1.2.3-beta.4",
    schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
  } as const;
}

function handoff(state: string, overrides: Record<string, unknown> = {}) {
  return {
    channel: "beta",
    createdAt: "2026-07-27T12:00:00.000Z",
    handoffId: "handoff_123456789",
    namespace: "release-beta",
    resumeTokenDigest: TOKEN_DIGEST,
    runtime: {
      protocolVersion: 1,
      runtimeDigest: RUNTIME_DIGEST,
      runtimeVersion: "1.2.3-beta.4",
    },
    schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
    shell: {
      pid: 123,
      version: "0.1.0",
    },
    state,
    updatedAt: "2026-07-27T12:00:01.000Z",
    ...overrides,
  };
}

describe("@open-design/codex-plugin-proto", () => {
  it("shares only namespace data and isolates Codex plugin lifecycle roots", () => {
    const suite = resolveDistributionSuitePaths({
      channel: "beta",
      namespace: "release-beta",
      namespaceBaseRoot: resolve("/tmp/open-design-beta/namespaces"),
    });
    const paths = resolveCodexPluginShellPaths(suite);
    const pluginSuite = resolveCodexPluginSuitePaths(suite);

    expect(paths.shellRoot).toBe(
      join(suite.namespaceRoot, "codex-plugin"),
    );
    expect(paths.handoffsRoot).toBe(
      join(paths.shellRoot, "state", "handoffs"),
    );
    expect(paths.logsRoot).toBe(join(paths.shellRoot, "logs"));
    expect(pluginSuite.dataRoot).toBe(suite.dataRoot);
    expect(pluginSuite.cacheRoot).toBe(join(paths.shellRoot, "cache"));
    expect(pluginSuite.logsRoot).toBe(join(paths.shellRoot, "logs"));
    expect(pluginSuite.runtimeRoot).toBe(join(paths.shellRoot, "runtime"));
    expect(pluginSuite.updatesRoot).toBe(join(paths.shellRoot, "updates"));
    expect(paths.shellRoot.startsWith(suite.namespaceRoot)).toBe(true);
  });

  it("parses a loopback acquisition manifest bound to one runtime digest", () => {
    expect(parseCodexPluginAcquisitionManifest(manifest())).toEqual(manifest());
    expect(parseCodexPluginAcquisitionManifest({
      ...manifest(),
      artifact: {
        ...manifest().artifact,
        mediaType: CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.ZIP_V1,
        url: "http://127.0.0.1:17456/runtime.zip",
      },
    }).artifact.mediaType).toBe(CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.ZIP_V1);
    expect(() => parseCodexPluginAcquisitionManifest({
      ...manifest(),
      artifact: {
        ...manifest().artifact,
        digest: `sha256:${"c".repeat(64)}`,
      },
    })).toThrow("artifact digest must equal runtime digest");
    expect(() => parseCodexPluginAcquisitionManifest({
      ...manifest(),
      artifact: {
        ...manifest().artifact,
        url: "http://example.com/runtime.mjs",
      },
    })).toThrow("https or loopback http");
    expect(compareCodexPluginShellVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareCodexPluginShellVersions("0.2.0", "0.1.0")).toBeGreaterThan(0);
    expect(compareCodexPluginShellVersions("0.2.0-beta.1", "0.2.0")).toBeLessThan(0);
  });

  it("normalizes the legacy flat shell floor into launcher-style control", () => {
    const legacy = {
      ...manifest(),
      control: undefined,
      minShellVersion: "0.1.0",
    };
    delete legacy.control;
    expect(parseCodexPluginAcquisitionManifest(legacy).control).toEqual({
      codexPlugin: {
        version: {
          min: "0.1.0",
        },
      },
    });
  });

  it("validates handoff state-specific runtime bindings", () => {
    expect(parseCodexPluginHandoffDescriptor(
      handoff(CODEX_PLUGIN_HANDOFF_STATES.PREPARED),
    ).state).toBe(CODEX_PLUGIN_HANDOFF_STATES.PREPARED);
    expect(parseCodexPluginHandoffDescriptor(handoff(
      CODEX_PLUGIN_HANDOFF_STATES.LAUNCHED,
      {
        runtime: {
          endpointUrl: "http://127.0.0.1:17456/status",
          pid: 456,
          protocolVersion: 1,
          runtimeDigest: RUNTIME_DIGEST,
          runtimeVersion: "1.2.3-beta.4",
        },
      },
    )).state).toBe(CODEX_PLUGIN_HANDOFF_STATES.LAUNCHED);
    expect(() => parseCodexPluginHandoffDescriptor(
      handoff(CODEX_PLUGIN_HANDOFF_STATES.FAILED),
    )).toThrow("requires an error");
  });

  it("allows only forward handoff transitions", () => {
    expect(() => assertCodexPluginHandoffTransition(
      CODEX_PLUGIN_HANDOFF_STATES.PREPARED,
      CODEX_PLUGIN_HANDOFF_STATES.ACQUIRED,
    )).not.toThrow();
    expect(() => assertCodexPluginHandoffTransition(
      CODEX_PLUGIN_HANDOFF_STATES.LAUNCHED,
      CODEX_PLUGIN_HANDOFF_STATES.CONFIRMED,
    )).not.toThrow();
    expect(() => assertCodexPluginHandoffTransition(
      CODEX_PLUGIN_HANDOFF_STATES.CONFIRMED,
      CODEX_PLUGIN_HANDOFF_STATES.PREPARED,
    )).toThrow(CodexPluginProtocolError);
  });

  it("validates the one-time runtime ready message", () => {
    expect(parseCodexPluginRuntimeReady({
      endpointUrl: "http://127.0.0.1:17456/status",
      handoffId: "handoff_123456789",
      pid: 456,
      resumeTokenDigest: TOKEN_DIGEST,
      schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
    })).toMatchObject({
      handoffId: "handoff_123456789",
      pid: 456,
    });
  });

  it("parses a loopback fixture report with a runtime manifest URL", () => {
    expect(parseCodexPluginFixtureReport({
      endpointUrl: "http://127.0.0.1:17456/runtime",
      healthUrl: "http://127.0.0.1:17456/health",
      identity: {
        channel: "beta",
        namespace: "release-beta",
        protocolVersion: 1,
        runtimeDigest: RUNTIME_DIGEST,
        runtimeVersion: "1.2.3-beta.4",
        shellDigest: TOKEN_DIGEST,
        shellType: "codex-plugin",
        shellVersion: "0.1.0",
      },
      runtimeManifestUrl: "http://127.0.0.1:17456/runtime/manifest.json",
      schemaVersion: 1,
    })).toMatchObject({
      runtimeManifestUrl: "http://127.0.0.1:17456/runtime/manifest.json",
    });
  });

  it("accepts only the platform targets shipped as native plugin artifacts", () => {
    expect(normalizeCodexPluginPlatformTarget(
      CODEX_PLUGIN_PLATFORM_TARGETS.DARWIN_ARM64,
    )).toBe("darwin-arm64");
    expect(normalizeCodexPluginPlatformTarget(
      CODEX_PLUGIN_PLATFORM_TARGETS.WIN32_X64,
    )).toBe("win32-x64");
    expect(() => normalizeCodexPluginPlatformTarget("linux-x64")).toThrow(
      "unsupported Codex plugin platform target",
    );
  });

  it("resolves one production path family per channel, namespace, and platform", () => {
    expect(resolveCodexPluginReleasePaths({
      channel: "beta",
      mediaType: CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.ZIP_V1,
      namespace: "release-beta",
      platform: CODEX_PLUGIN_PLATFORM_TARGETS.DARWIN_ARM64,
      runtimeVersion: "1.2.3-beta.4",
    })).toEqual({
      latestRuntimeManifestPath:
        "codex-plugin/beta/release-beta/darwin-arm64/latest/runtime.json",
      root: "codex-plugin/beta/release-beta/darwin-arm64",
      runtimeArtifactPath:
        "codex-plugin/beta/release-beta/darwin-arm64/versions/1.2.3-beta.4/runtime/runtime.zip",
    });
  });
});
