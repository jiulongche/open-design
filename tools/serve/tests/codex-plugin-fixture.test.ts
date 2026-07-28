import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseCodexPluginAcquisitionManifest,
  parseCodexPluginFixtureReport,
} from "@open-design/codex-plugin-proto";
import {
  assertSameDistributionIdentity,
  parseDistributionServeReport,
} from "@open-design/distribution-proto";
import { describe, expect, it } from "vitest";

import { startCodexPluginFixtureServer } from "../src/codex-plugin-fixture.js";

const RUNTIME_BYTES = Buffer.from("export {};\n");
const RUNTIME_DIGEST =
  `sha256:${createHash("sha256").update(RUNTIME_BYTES).digest("hex")}`;
const IDENTITY = {
  channel: "beta",
  namespace: "codex-smoke",
  protocolVersion: 1,
  runtimeDigest: RUNTIME_DIGEST,
  runtimeVersion: "0.16.1-beta.1",
  shellDigest: `sha256:${"b".repeat(64)}`,
  shellType: "codex-plugin",
  shellVersion: "0.1.0",
} as const;

async function writeBuildReport(options: {
  runtimeBytes?: Buffer;
  runtimeVersion?: string;
} = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-design-codex-plugin-serve-"));
  const shellRoot = join(root, "marketplace", "plugins", "open-design");
  const runtimePath = join(root, "runtime", "runtime.mjs");
  const runtimeBytes = options.runtimeBytes ?? RUNTIME_BYTES;
  const runtimeDigest =
    `sha256:${createHash("sha256").update(runtimeBytes).digest("hex")}`;
  const identity = {
    ...IDENTITY,
    runtimeDigest,
    runtimeVersion: options.runtimeVersion ?? IDENTITY.runtimeVersion,
  };
  await mkdir(join(shellRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(runtimePath, runtimeBytes);
  const path = join(root, "build-report.json");
  await writeFile(path, JSON.stringify({
    artifact: {
      digest: IDENTITY.shellDigest,
      files: [".codex-plugin/plugin.json"],
      size: 1,
    },
    identity,
    paths: {
      artifactRoot: join(root, "marketplace"),
      manifestPath: join(shellRoot, ".codex-plugin", "plugin.json"),
      shellRoot,
    },
    runtimeArtifact: {
      digest: runtimeDigest,
      entryPath: "runtime.mjs",
      path: runtimePath,
      size: runtimeBytes.byteLength,
    },
    schemaVersion: 1,
  }));
  return path;
}

describe("Codex plugin fixture", () => {
  it("serves a report and runtime bound to the build identity", async () => {
    const server = await startCodexPluginFixtureServer({
      buildReportPath: await writeBuildReport(),
    });
    try {
      expect(parseCodexPluginFixtureReport(server.info)).toEqual(server.info);
      const report = parseDistributionServeReport(
        await (await fetch(server.info.endpointUrl.replace("/runtime", "/report"))).json(),
      );
      assertSameDistributionIdentity(IDENTITY, report.identity);
      expect(report.endpointUrl).toBe(server.info.endpointUrl);

      const runtime = await (await fetch(server.info.endpointUrl)).json() as {
        identity?: unknown;
        runtime?: { version?: string };
      };
      expect(runtime.identity).toEqual(IDENTITY);
      expect(runtime.runtime?.version).toBe(IDENTITY.runtimeVersion);

      const manifest = parseCodexPluginAcquisitionManifest(
        await (await fetch(server.info.runtimeManifestUrl)).json(),
      );
      expect(manifest.runtimeDigest).toBe(RUNTIME_DIGEST);
      expect(Buffer.from(
        await (await fetch(manifest.artifact.url)).arrayBuffer(),
      )).toEqual(RUNTIME_BYTES);

      const health = await (await fetch(server.info.healthUrl)).json() as {
        ok?: boolean;
      };
      expect(health.ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("uses dynamic ports without changing the distribution identity", async () => {
    const buildReportPath = await writeBuildReport();
    const first = await startCodexPluginFixtureServer({ buildReportPath });
    const second = await startCodexPluginFixtureServer({ buildReportPath });
    try {
      expect(first.info.endpointUrl).not.toBe(second.info.endpointUrl);
      expect(first.info.identity).toEqual(second.info.identity);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("atomically promotes latest runtime while retaining immutable artifacts", async () => {
    const firstBytes = Buffer.from("export const fixture = 1;\n");
    const secondBytes = Buffer.from("export const fixture = 2;\n");
    const thirdBytes = Buffer.from("export const fixture = 3;\n");
    const server = await startCodexPluginFixtureServer({
      buildReportPath: await writeBuildReport({
        runtimeBytes: firstBytes,
        runtimeVersion: "0.16.1-beta.1",
      }),
    });
    try {
      const manifestUrl = server.info.runtimeManifestUrl;
      const firstManifest = parseCodexPluginAcquisitionManifest(
        await (await fetch(manifestUrl)).json(),
      );
      const promotedInfo = await server.promote({
        buildReportPath: await writeBuildReport({
          runtimeBytes: secondBytes,
          runtimeVersion: "0.16.2-beta.1",
        }),
      });
      const secondManifest = parseCodexPluginAcquisitionManifest(
        await (await fetch(manifestUrl)).json(),
      );

      expect(promotedInfo.runtimeManifestUrl).toBe(manifestUrl);
      expect(secondManifest.runtimeVersion).toBe("0.16.2-beta.1");
      expect(Buffer.from(
        await (await fetch(firstManifest.artifact.url)).arrayBuffer(),
      )).toEqual(firstBytes);
      expect(Buffer.from(
        await (await fetch(secondManifest.artifact.url)).arrayBuffer(),
      )).toEqual(secondBytes);

      await expect(server.promote({
        buildReportPath: await writeBuildReport({
          runtimeBytes: thirdBytes,
          runtimeVersion: "0.16.2-beta.1",
        }),
      })).rejects.toThrow("would replace immutable artifact");

      await server.promote({
        buildReportPath: await writeBuildReport({
          runtimeBytes: thirdBytes,
          runtimeVersion: "0.16.3-beta.1",
        }),
        minimumShellVersion: "0.2.0",
      });
      expect(parseCodexPluginAcquisitionManifest(
        await (await fetch(manifestUrl)).json(),
      ).control.codexPlugin.version.min).toBe("0.2.0");
    } finally {
      await server.close();
    }
  });
});
