import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertSameDistributionIdentity,
  parseDistributionServeReport,
} from "@open-design/distribution-proto";
import { describe, expect, it } from "vitest";

import { startCodexPluginFixtureServer } from "../src/codex-plugin-fixture.js";

const IDENTITY = {
  channel: "beta",
  namespace: "codex-smoke",
  protocolVersion: 1,
  runtimeDigest: `sha256:${"a".repeat(64)}`,
  runtimeVersion: "0.16.1-beta.1",
  shellDigest: `sha256:${"b".repeat(64)}`,
  shellType: "codex-plugin",
  shellVersion: "0.1.0",
} as const;

async function writeBuildReport(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-design-codex-plugin-serve-"));
  const shellRoot = join(root, "marketplace", "plugins", "open-design");
  await mkdir(join(shellRoot, ".codex-plugin"), { recursive: true });
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
