import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
const NODE_BYTES = Buffer.from("#!/bin/sh\necho v24.14.0\n");
const NODE_DIGEST =
  `sha256:${createHash("sha256").update(NODE_BYTES).digest("hex")}`;
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

async function writeBuildReport(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-design-codex-plugin-serve-"));
  const shellRoot = join(root, "marketplace", "plugins", "open-design");
  const runtimePath = join(root, "runtime", "runtime.mjs");
  const nodePath = join(root, "environment", "darwin-arm64", "node");
  await mkdir(join(shellRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(root, "runtime"), { recursive: true });
  await mkdir(dirname(nodePath), { recursive: true });
  await writeFile(runtimePath, RUNTIME_BYTES);
  await writeFile(nodePath, NODE_BYTES);
  await writeFile(
    join(dirname(nodePath), "artifact.json"),
    JSON.stringify({
      digest: NODE_DIGEST,
      path: nodePath,
      platform: "darwin-arm64",
      size: NODE_BYTES.byteLength,
      version: "24.14.0",
    }),
  );
  const path = join(root, "build-report.json");
  await writeFile(path, JSON.stringify({
    artifact: {
      digest: IDENTITY.shellDigest,
      files: [".codex-plugin/plugin.json"],
      size: 1,
    },
    identity: IDENTITY,
    paths: {
      artifactRoot: join(root, "marketplace"),
      manifestPath: join(shellRoot, ".codex-plugin", "plugin.json"),
      shellRoot,
    },
    runtimeArtifact: {
      digest: RUNTIME_DIGEST,
      entryPath: "runtime.mjs",
      path: runtimePath,
      size: RUNTIME_BYTES.byteLength,
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
      expect(server.info.environmentManifestUrl).toContain(
        "/codex-plugin/beta/latest/platforms/darwin-arm64.json",
      );
      const environmentManifest = await (
        await fetch(server.info.environmentManifestUrl)
      ).json() as {
        node?: { url?: string; version?: string };
      };
      expect(environmentManifest.node?.version).toBe("24.14.0");
      expect(Buffer.from(
        await (await fetch(environmentManifest.node!.url!)).arrayBuffer(),
      )).toEqual(NODE_BYTES);
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
});
