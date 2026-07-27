import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DISTRIBUTION_REPORT_SCHEMA_VERSION,
  DISTRIBUTION_SHELL_TYPES,
  DistributionProtocolError,
  assertSameDistributionIdentity,
  calculateDistributionArtifactInventory,
  normalizeDistributionIdentity,
  normalizeDistributionInventoryPath,
  normalizeDistributionVersion,
  parseDistributionBuildReport,
  parseDistributionServeReport,
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
    const artifactRoot = resolve("/tmp/od-distribution");
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
      schemaVersion: DISTRIBUTION_REPORT_SCHEMA_VERSION,
    }).paths.shellRoot).toBe(resolve(artifactRoot, "plugin"));

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
  });
});
