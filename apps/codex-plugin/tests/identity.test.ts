import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FIXTURE_REPORT_URL_ENV,
  observeFixture,
  readDistributionIdentity,
  resolveFixtureReportUrl,
  resolveIdentityFile,
} from "../src/identity.js";

const RUNTIME_DIGEST = `sha256:${"a".repeat(64)}`;
const SHELL_DIGEST = `sha256:${"b".repeat(64)}`;

const IDENTITY = {
  channel: "beta",
  namespace: "codex-smoke",
  protocolVersion: 1,
  runtimeDigest: RUNTIME_DIGEST,
  runtimeVersion: "0.16.1-beta.1",
  shellDigest: SHELL_DIGEST,
  shellType: "codex-plugin",
  shellVersion: "0.1.0",
} as const;

describe("codex plugin identity", () => {
  it("resolves the package-relative identity path", () => {
    expect(resolveIdentityFile(
      ["--identity-file", "./distribution.json"],
      "/tmp/plugin",
    )).toBe("/tmp/plugin/distribution.json");
  });

  it("reads and validates the generated identity file", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-codex-plugin-"));
    const identityPath = join(root, "distribution.json");
    await writeFile(identityPath, JSON.stringify(IDENTITY));
    expect(await readDistributionIdentity(identityPath)).toEqual(IDENTITY);
  });

  it("prefers the explicit fixture report URL over the environment", () => {
    expect(resolveFixtureReportUrl(
      ["--fixture-report-url", "http://127.0.0.1:1/report"],
      { [FIXTURE_REPORT_URL_ENV]: "http://127.0.0.1:2/report" },
    )).toBe("http://127.0.0.1:1/report");
  });

  it("reports an exact fixture identity match", async () => {
    const observation = await observeFixture(
      IDENTITY,
      "http://127.0.0.1:17456/report",
      async () => new Response(JSON.stringify({
        endpointUrl: "http://127.0.0.1:17456/mcp",
        healthUrl: "http://127.0.0.1:17456/health",
        identity: IDENTITY,
        schemaVersion: 1,
      }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    expect(observation).toMatchObject({
      configured: true,
      identityMatches: true,
      reachable: true,
    });
  });

  it("keeps the status tool available when no fixture is configured", async () => {
    expect(await observeFixture(IDENTITY, null)).toEqual({ configured: false });
  });
});
