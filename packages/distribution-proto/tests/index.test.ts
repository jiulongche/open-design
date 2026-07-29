import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DISTRIBUTION_REPORT_SCHEMA_VERSION,
  DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
  DISTRIBUTION_SHELL_TYPES,
  DISTRIBUTION_SUITE_PATH_ERROR_CODES,
  DistributionProtocolError,
  DistributionSuitePathError,
  assertSameDistributionIdentity,
  calculateDistributionArtifactInventory,
  normalizeDistributionIdentity,
  normalizeDistributionInventoryPath,
  normalizeDistributionRuntimeIdentity,
  normalizeDistributionVersion,
  parseDistributionBuildReport,
  parseDistributionRuntimeAttempt,
  parseDistributionRuntimeBinding,
  parseDistributionRuntimeLease,
  parseDistributionRuntimePointer,
  parseDistributionServeReport,
  isDistributionRuntimeLeaseExpired,
  resolveDistributionRuntimeStorePaths,
  resolveDistributionRuntimeVersionPaths,
  resolveDistributionSuitePaths,
  selectDistributionRuntimeTarget,
  type DistributionIdentityV1,
} from "../src/index.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function identity(
  overrides: Partial<DistributionIdentityV1> = {},
): DistributionIdentityV1 {
  return {
    channel: "beta",
    namespace: "codex-smoke",
    protocolVersion: 1,
    runtimeDigest: DIGEST_A,
    runtimeVersion: "1.2.3-beta.4",
    shellDigest: DIGEST_B,
    shellType: DISTRIBUTION_SHELL_TYPES.CODEX_PLUGIN,
    shellVersion: "0.1.0",
    ...overrides,
  };
}

describe("@open-design/distribution-proto", () => {
  it("normalizes an explicit distribution identity", () => {
    expect(normalizeDistributionIdentity(identity())).toEqual(identity());
  });

  it("requires the runtime version to match the explicit channel", () => {
    expect(() => normalizeDistributionIdentity(identity({
      channel: "stable",
      runtimeVersion: "1.2.3-beta.4",
    }))).toThrow("stable release version must be x.y.z");
  });

  it("keeps shell version independent from the runtime release channel", () => {
    expect(normalizeDistributionIdentity(identity({
      shellVersion: "2.0.0",
    })).shellVersion).toBe("2.0.0");
  });

  it("resolves one shared channel and namespace suite layout for every shell", () => {
    const channelRoot = resolve("/tmp/open-design-beta");
    const paths = resolveDistributionSuitePaths({
      channel: "beta",
      namespace: "release-beta",
      namespaceBaseRoot: join(channelRoot, "namespaces"),
    });

    expect(paths).toEqual({
      cacheRoot: join(channelRoot, "namespaces", "release-beta", "cache"),
      channel: "beta",
      channelRoot,
      dataRoot: join(channelRoot, "namespaces", "release-beta", "data"),
      logsRoot: join(channelRoot, "namespaces", "release-beta", "logs"),
      namespace: "release-beta",
      namespaceBaseRoot: join(channelRoot, "namespaces"),
      namespaceRoot: join(channelRoot, "namespaces", "release-beta"),
      runtimeRoot: join(channelRoot, "namespaces", "release-beta", "runtime"),
      updatesRoot: join(channelRoot, "namespaces", "release-beta", "updates"),
    });
  });

  it("keeps shared data-root overrides namespace scoped", () => {
    const channelRoot = resolve("/tmp/open-design-beta");
    const sharedDataBase = resolve("/tmp/open-design-data");
    const stable = resolveDistributionSuitePaths({
      channel: "stable",
      dataDir: sharedDataBase,
      namespace: "release-stable",
      namespaceBaseRoot: join(channelRoot, "namespaces"),
    });
    const beta = resolveDistributionSuitePaths({
      channel: "beta",
      dataDir: sharedDataBase,
      namespace: "release-beta",
      namespaceBaseRoot: join(channelRoot, "namespaces"),
    });

    expect(stable.dataRoot).toBe(
      join(sharedDataBase, "namespaces", "release-stable", "data"),
    );
    expect(beta.dataRoot).toBe(
      join(sharedDataBase, "namespaces", "release-beta", "data"),
    );
    expect(stable.dataRoot).not.toBe(beta.dataRoot);
  });

  it("derives a shell-neutral immutable runtime store from suite paths", () => {
    const suite = resolveDistributionSuitePaths({
      channel: "beta",
      namespace: "release-beta",
      namespaceBaseRoot: resolve("/tmp/open-design-beta/namespaces"),
    });
    const store = resolveDistributionRuntimeStorePaths(suite);
    const version = resolveDistributionRuntimeVersionPaths({
      runtimeDigest: DIGEST_A,
      runtimeVersion: "1.2.3-beta.4",
      storePaths: store,
    });

    expect(store.activePath).toBe(
      join(suite.runtimeRoot, "store", "state", "active.json"),
    );
    expect(store.attemptPath).toBe(
      join(suite.runtimeRoot, "store", "state", "attempt.json"),
    );
    expect(store.bindingPath).toBe(
      join(suite.runtimeRoot, "store", "state", "binding.json"),
    );
    expect(store.leasePath).toBe(
      join(suite.runtimeRoot, "store", "state", "lock", "lease.json"),
    );
    expect(store.downloadsRoot).toBe(
      join(suite.updatesRoot, "runtime", "downloads"),
    );
    expect(version.versionRoot).toBe(
      join(
        store.versionsRoot,
        "1.2.3-beta.4",
        "a".repeat(64),
      ),
    );
    expect(version.payloadRoot).toBe(join(version.versionRoot, "payload"));
  });

  it("parses a channel-bound shared runtime pointer", () => {
    expect(parseDistributionRuntimePointer({
      channel: "beta",
      generation: 3,
      namespace: "release-beta",
      protocolVersion: 1,
      runtimeDigest: DIGEST_A,
      runtimeVersion: "1.2.3-beta.4",
      schemaVersion: DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
      updatedAt: "2026-07-27T12:00:00.000Z",
    })).toEqual({
      channel: "beta",
      generation: 3,
      namespace: "release-beta",
      protocolVersion: 1,
      runtimeDigest: DIGEST_A,
      runtimeVersion: "1.2.3-beta.4",
      schemaVersion: DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
      updatedAt: "2026-07-27T12:00:00.000Z",
    });
    expect(() => parseDistributionRuntimePointer({
      channel: "stable",
      generation: 3,
      namespace: "release-stable",
      protocolVersion: 1,
      runtimeDigest: DIGEST_A,
      runtimeVersion: "1.2.3-beta.4",
      schemaVersion: DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
      updatedAt: "2026-07-27T12:00:00.000Z",
    })).toThrow("stable release version must be x.y.z");
  });

  it("selects a confirmed active runtime offline and after a failed immutable attempt", () => {
    const active = parseDistributionRuntimePointer({
      channel: "beta",
      generation: 3,
      namespace: "release-beta",
      protocolVersion: 1,
      runtimeDigest: DIGEST_A,
      runtimeVersion: "1.2.3-beta.4",
      schemaVersion: DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
      updatedAt: "2026-07-27T12:00:00.000Z",
    });
    const requested = normalizeDistributionRuntimeIdentity({
      channel: "beta",
      namespace: "release-beta",
      protocolVersion: 1,
      runtimeDigest: DIGEST_B,
      runtimeVersion: "1.2.4-beta.5",
    });
    const attempted = parseDistributionRuntimeAttempt({
      ...requested,
      attemptedAt: "2026-07-27T12:05:00.000Z",
      schemaVersion: DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
    });

    expect(selectDistributionRuntimeTarget({ active })).toEqual({
      reason: "active-offline",
      selected: "active",
    });
    expect(selectDistributionRuntimeTarget({
      active,
      attempted,
      requested,
    })).toEqual({
      reason: "active-after-failed-attempt",
      selected: "active",
    });
    expect(selectDistributionRuntimeTarget({
      active,
      attempted,
      requested: {
        ...requested,
        runtimeDigest: `sha256:${"c".repeat(64)}`,
        runtimeVersion: "1.2.5-beta.6",
      },
    })).toEqual({
      reason: "requested",
      selected: "requested",
    });
    expect(selectDistributionRuntimeTarget({
      attempted,
      requested,
    })).toEqual({
      reason: "requested-without-fallback",
      selected: "requested",
    });
  });

  it("keeps runtime acquisition ownership in the shared distribution lease", () => {
    const lease = parseDistributionRuntimeLease({
      acquiredAt: "2026-07-27T12:00:00.000Z",
      channel: "beta",
      expiresAt: "2026-07-27T12:02:00.000Z",
      leaseId: "lease_12345678901",
      namespace: "release-beta",
      owner: {
        pid: 123,
        shellType: "codex-plugin",
      },
      schemaVersion: DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
    });

    expect(isDistributionRuntimeLeaseExpired(
      lease,
      Date.parse("2026-07-27T12:01:59.999Z"),
    )).toBe(false);
    expect(isDistributionRuntimeLeaseExpired(
      lease,
      Date.parse("2026-07-27T12:02:00.000Z"),
    )).toBe(true);
  });

  it("parses one shared runtime binding for cross-shell attach", () => {
    const identity = normalizeDistributionRuntimeIdentity({
      channel: "beta",
      namespace: "release-beta",
      protocolVersion: 1,
      runtimeDigest: DIGEST_A,
      runtimeVersion: "1.2.3-beta.4",
    });
    expect(parseDistributionRuntimeBinding({
      ...identity,
      endpointUrl: "http://127.0.0.1:17456/status",
      generation: 4,
      owner: {
        pid: 456,
        shellType: "codex-plugin",
      },
      schemaVersion: DISTRIBUTION_RUNTIME_SCHEMA_VERSION,
      startedAt: "2026-07-27T12:00:00.000Z",
      updatedAt: "2026-07-27T12:00:01.000Z",
    })).toMatchObject({
      ...identity,
      generation: 4,
      owner: {
        pid: 456,
        shellType: "codex-plugin",
      },
    });
  });

  it("rejects relative and cross-namespace shared data roots with typed errors", () => {
    expect(() => resolveDistributionSuitePaths({
      channel: "beta",
      dataDir: "relative/data",
      namespace: "release-beta",
      namespaceBaseRoot: resolve("/tmp/open-design-beta/namespaces"),
      platform: "linux",
    })).toThrowError(expect.objectContaining({
      code: DISTRIBUTION_SUITE_PATH_ERROR_CODES.DATA_ROOT_NOT_ABSOLUTE,
    }));

    const mismatched = join(
      resolve("/tmp/open-design-beta"),
      "namespaces",
      "release-stable",
      "data",
    );
    expect(() => resolveDistributionSuitePaths({
      channel: "beta",
      dataDir: mismatched,
      namespace: "release-beta",
      namespaceBaseRoot: resolve("/tmp/open-design-beta/namespaces"),
    })).toThrow(DistributionSuitePathError);
    try {
      resolveDistributionSuitePaths({
        channel: "beta",
        dataDir: mismatched,
        namespace: "release-beta",
        namespaceBaseRoot: resolve("/tmp/open-design-beta/namespaces"),
      });
    } catch (error) {
      expect(error).toMatchObject({
        activeNamespace: "release-beta",
        code: DISTRIBUTION_SUITE_PATH_ERROR_CODES.DATA_ROOT_NAMESPACE_MISMATCH,
        configuredNamespace: "release-stable",
      });
    }
  });

  it("rejects versions and inventory paths that can escape a package", () => {
    expect(() => normalizeDistributionVersion("../1.2.3")).toThrow(
      DistributionProtocolError,
    );
    expect(() => normalizeDistributionInventoryPath("../plugin.json")).toThrow(
      DistributionProtocolError,
    );
    expect(() => normalizeDistributionInventoryPath("skills\\one")).toThrow(
      DistributionProtocolError,
    );
  });

  it("calculates a deterministic artifact inventory independent of input order", () => {
    const first = calculateDistributionArtifactInventory([
      { bytes: Buffer.from("server"), path: "mcp/server.mjs" },
      { bytes: Buffer.from("manifest"), path: ".codex-plugin/plugin.json" },
    ]);
    const second = calculateDistributionArtifactInventory([
      { bytes: Buffer.from("manifest"), path: ".codex-plugin/plugin.json" },
      { bytes: Buffer.from("server"), path: "mcp/server.mjs" },
    ]);
    expect(first).toEqual(second);
    expect(first.files).toEqual([
      ".codex-plugin/plugin.json",
      "mcp/server.mjs",
    ]);
    expect(first.size).toBe(Buffer.byteLength("manifestserver"));
  });

  it("parses a build report and enforces path containment", () => {
    const artifactRoot = resolve("/tmp/od-distribution/marketplace");
    const runtimePath = resolve(artifactRoot, "..", "runtime", "runtime.mjs");
    expect(parseDistributionBuildReport({
      artifact: {
        digest: DIGEST_B,
        files: [".codex-plugin/plugin.json", "mcp/server.mjs"],
        size: 42,
      },
      identity: identity(),
      paths: {
        artifactRoot,
        manifestPath: resolve(artifactRoot, "plugin", ".codex-plugin", "plugin.json"),
        shellRoot: resolve(artifactRoot, "plugin"),
      },
      runtimeArtifact: {
        digest: DIGEST_A,
        entryPath: "runtime.mjs",
        path: runtimePath,
        size: 84,
      },
      schemaVersion: DISTRIBUTION_REPORT_SCHEMA_VERSION,
    })).toMatchObject({
      paths: {
        shellRoot: resolve(artifactRoot, "plugin"),
      },
      runtimeArtifact: {
        path: runtimePath,
      },
    });

    expect(() => parseDistributionBuildReport({
      artifact: {
        digest: DIGEST_B,
        files: [".codex-plugin/plugin.json"],
        size: 42,
      },
      identity: identity(),
      paths: {
        artifactRoot,
        manifestPath: resolve("/tmp/outside/plugin.json"),
        shellRoot: resolve("/tmp/outside"),
      },
      schemaVersion: DISTRIBUTION_REPORT_SCHEMA_VERSION,
    })).toThrow("shell root escapes artifact root");

    expect(() => parseDistributionBuildReport({
      artifact: {
        digest: DIGEST_B,
        files: [".codex-plugin/plugin.json"],
        size: 42,
      },
      identity: identity(),
      paths: {
        artifactRoot,
        manifestPath: resolve(artifactRoot, "plugin", ".codex-plugin", "plugin.json"),
        shellRoot: resolve(artifactRoot, "plugin"),
      },
      runtimeArtifact: {
        digest: DIGEST_A,
        entryPath: "runtime.mjs",
        path: resolve("/tmp/outside/runtime.mjs"),
        size: 84,
      },
      schemaVersion: DISTRIBUTION_REPORT_SCHEMA_VERSION,
    })).toThrow("runtime artifact path escapes");
  });

  it("parses loopback fixture reports and compares exact identity", () => {
    const report = parseDistributionServeReport({
      endpointUrl: "http://127.0.0.1:17456/mcp",
      healthUrl: "http://127.0.0.1:17456/health",
      identity: identity(),
      schemaVersion: DISTRIBUTION_REPORT_SCHEMA_VERSION,
    });
    expect(report.endpointUrl).toBe("http://127.0.0.1:17456/mcp");
    expect(() => assertSameDistributionIdentity(identity(), report.identity)).not.toThrow();
    expect(() => assertSameDistributionIdentity(
      identity(),
      identity({ shellVersion: "0.2.0" }),
    )).toThrow("distribution identity mismatch");
  });

  it("rejects remote fixture endpoints and digest drift", () => {
    expect(() => parseDistributionServeReport({
      endpointUrl: "https://example.com/mcp",
      healthUrl: "http://127.0.0.1:17456/health",
      identity: identity(),
      schemaVersion: DISTRIBUTION_REPORT_SCHEMA_VERSION,
    })).toThrow("must use http for a local fixture");

    expect(() => parseDistributionBuildReport({
      artifact: {
        digest: DIGEST_A,
        files: [],
        size: 0,
      },
      identity: identity(),
      paths: {
        artifactRoot: resolve("/tmp/od-distribution"),
        manifestPath: resolve("/tmp/od-distribution/plugin/plugin.json"),
        shellRoot: resolve("/tmp/od-distribution/plugin"),
      },
      schemaVersion: DISTRIBUTION_REPORT_SCHEMA_VERSION,
    })).toThrow("does not match shell digest");

    expect(() => parseDistributionBuildReport({
      artifact: {
        digest: DIGEST_B,
        files: [],
        size: 0,
      },
      identity: identity(),
      paths: {
        artifactRoot: resolve("/tmp/od-distribution"),
        manifestPath: resolve("/tmp/od-distribution/plugin/plugin.json"),
        shellRoot: resolve("/tmp/od-distribution/plugin"),
      },
      runtimeArtifact: {
        digest: DIGEST_B,
        entryPath: "runtime.mjs",
        path: resolve("/tmp/runtime.mjs"),
        size: 1,
      },
      schemaVersion: DISTRIBUTION_REPORT_SCHEMA_VERSION,
    })).toThrow("does not match runtime digest");
  });
});
