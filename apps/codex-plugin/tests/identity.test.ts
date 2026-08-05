import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CODEX_PLUGIN_ENV } from "@open-design/codex-plugin-proto";

import {
  FIXTURE_REPORT_URL_ENV,
  currentDistributionIdentity,
  observeFixture,
  readDistributionIdentity,
  resolveFixtureReportUrl,
  resolveIdentityFile,
} from "../src/identity.js";
import {
  observeCodexPluginSuite,
  resolveCodexPluginDistributionChannelRoot,
  resolveCodexPluginRuntimeManifestUrl,
} from "../src/suite.js";

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
    )).toBe(resolve("/tmp/plugin/distribution.json"));
  });

  it("reads and validates the generated identity file", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-codex-plugin-"));
    const identityPath = join(root, "distribution.json");
    await writeFile(identityPath, JSON.stringify(IDENTITY));
    expect(await readDistributionIdentity(identityPath)).toEqual(IDENTITY);
  });

  it("combines the immutable shell identity with the selected runtime", () => {
    expect(currentDistributionIdentity(IDENTITY, {
      channel: IDENTITY.channel,
      namespace: IDENTITY.namespace,
      protocolVersion: IDENTITY.protocolVersion,
      runtimeDigest: `sha256:${"c".repeat(64)}`,
      runtimeVersion: "0.16.2-beta.1",
    })).toEqual({
      ...IDENTITY,
      runtimeDigest: `sha256:${"c".repeat(64)}`,
      runtimeVersion: "0.16.2-beta.1",
    });
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

  it("maps the Codex shell onto the shared distribution suite paths", () => {
    const channelRoot = join(tmpdir(), "open-design-beta");
    expect(resolveCodexPluginDistributionChannelRoot([], {
      [CODEX_PLUGIN_ENV.DISTRIBUTION_CHANNEL_ROOT]: channelRoot,
    })).toBe(channelRoot);
    expect(observeCodexPluginSuite({
      env: {
        [CODEX_PLUGIN_ENV.DISTRIBUTION_CHANNEL_ROOT]: channelRoot,
      },
      identity: IDENTITY,
    })).toEqual({
      configured: true,
      paths: {
        cacheRoot: join(
          channelRoot,
          "namespaces",
          IDENTITY.namespace,
          "codex-plugin",
          "cache",
        ),
        channel: IDENTITY.channel,
        channelRoot,
        dataRoot: join(channelRoot, "namespaces", IDENTITY.namespace, "data"),
        logsRoot: join(
          channelRoot,
          "namespaces",
          IDENTITY.namespace,
          "codex-plugin",
          "logs",
        ),
        namespace: IDENTITY.namespace,
        namespaceBaseRoot: join(channelRoot, "namespaces"),
        namespaceRoot: join(channelRoot, "namespaces", IDENTITY.namespace),
        runtimeRoot: join(
          channelRoot,
          "namespaces",
          IDENTITY.namespace,
          "codex-plugin",
          "runtime",
        ),
        updatesRoot: join(
          channelRoot,
          "namespaces",
          IDENTITY.namespace,
          "codex-plugin",
          "updates",
        ),
      },
    });
  });

  it("defaults formal release channels to the matching product data root", () => {
    const homeDir = join(tmpdir(), "codex-home");
    expect(resolveCodexPluginDistributionChannelRoot([], {}, {
      channel: "beta",
      homeDir,
      platform: "darwin",
    })).toBe(join(homeDir, "Library", "Application Support", "Open Design Beta"));
    expect(resolveCodexPluginDistributionChannelRoot([], {
      APPDATA: "C:\\Users\\Fred\\AppData\\Roaming",
    }, {
      channel: "beta",
      homeDir: "C:\\Users\\Fred",
      platform: "win32",
    })).toBe("C:\\Users\\Fred\\AppData\\Roaming\\Open Design Beta");
    expect(resolveCodexPluginDistributionChannelRoot([], {}, {
      channel: "custom",
      homeDir,
      platform: "darwin",
    })).toBeNull();
  });

  it("lets a controlled local environment override the baked release manifest", () => {
    expect(resolveCodexPluginRuntimeManifestUrl(
      ["--runtime-manifest-url", "http://127.0.0.1:17456/manifest.json"],
      {
        [CODEX_PLUGIN_ENV.RUNTIME_MANIFEST_URL]:
          "https://updates.example.com/runtime.json",
      },
    )).toBe("https://updates.example.com/runtime.json");
    expect(() => resolveCodexPluginRuntimeManifestUrl(
      ["--runtime-manifest-url", "http://example.com/runtime.json"],
      {},
    )).toThrow("https or loopback http");
  });
});
