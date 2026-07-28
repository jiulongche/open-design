import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
  CODEX_PLUGIN_RUNTIME_ENV,
  CODEX_PLUGIN_RUNTIME_MEDIA_TYPES,
  resolveCodexPluginSuitePaths,
} from "@open-design/codex-plugin-proto";
import {
  resolveDistributionRuntimeStorePaths,
  resolveDistributionSuitePaths,
} from "@open-design/distribution-proto";

import { CodexPluginRuntimeLauncher } from "../src/launcher.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { force: true, recursive: true });
  }));
});

describe("Codex plugin runtime launcher", () => {
  it("acquires one immutable runtime, confirms handoff, and reattaches", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-codex-runtime-launcher-"));
    roots.push(root);
    const suitePaths = resolveCodexPluginSuitePaths(
      resolveDistributionSuitePaths({
        channel: "beta",
        namespace: "release-beta",
        namespaceBaseRoot: join(root, "namespaces"),
      }),
    );
    const runtimeSource = (tag: string) => `
import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
const buildTag = ${JSON.stringify(tag)};
const identity = {
  channel: process.env.${CODEX_PLUGIN_RUNTIME_ENV.CHANNEL},
  namespace: process.env.${CODEX_PLUGIN_RUNTIME_ENV.NAMESPACE},
  protocolVersion: Number(process.env.${CODEX_PLUGIN_RUNTIME_ENV.PROTOCOL_VERSION}),
  runtimeDigest: process.env.${CODEX_PLUGIN_RUNTIME_ENV.RUNTIME_DIGEST},
  runtimeVersion: process.env.${CODEX_PLUGIN_RUNTIME_ENV.RUNTIME_VERSION},
};
const server = createServer((_request, response) => {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(identity));
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const readyPath = process.env.${CODEX_PLUGIN_RUNTIME_ENV.READY_PATH};
  const temporaryPath = readyPath + "." + process.pid + ".tmp";
  const ready = {
    endpointUrl: \`http://127.0.0.1:\${address.port}/status\`,
    handoffId: process.env.${CODEX_PLUGIN_RUNTIME_ENV.HANDOFF_ID},
    pid: process.pid,
    resumeTokenDigest: "sha256:" + createHash("sha256")
      .update(process.env.${CODEX_PLUGIN_RUNTIME_ENV.HANDOFF_TOKEN})
      .digest("hex"),
    schemaVersion: ${CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION},
  };
  void writeFile(temporaryPath, JSON.stringify(ready), { mode: 0o600 })
    .then(() => rename(temporaryPath, readyPath));
});
`;
    const manifestUrl = "http://127.0.0.1:17456/manifest.json";
    const artifacts = new Map<string, Buffer>();
    const createManifest = (
      runtimeVersion: string,
      tag: string,
      minShellVersion = "0.1.0",
    ) => {
      const bytes = Buffer.from(runtimeSource(tag));
      const digest =
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const artifactUrl =
        `http://127.0.0.1:17456/${runtimeVersion}/runtime.mjs`;
      artifacts.set(artifactUrl, bytes);
      return {
        artifact: {
          digest,
          entryPath: "runtime.mjs",
          mediaType: CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.NODE_MODULE_V1,
          size: bytes.byteLength,
          url: artifactUrl,
        },
        channel: "beta",
        control: {
          codexPlugin: {
            version: {
              min: minShellVersion,
            },
          },
        },
        namespace: "release-beta",
        protocolVersion: 1,
        runtimeDigest: digest,
        runtimeVersion,
        schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
      } as const;
    };
    let manifest = createManifest("1.2.3-beta.4", "v1");
    const runtimeDigest = manifest.runtimeDigest;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === manifestUrl) {
        return new Response(JSON.stringify(manifest), {
          headers: { "content-type": "application/json" },
        });
      }
      const artifact = artifacts.get(url);
      if (artifact != null) {
        return new Response(artifact, {
          headers: { "content-type": manifest.artifact.mediaType },
        });
      }
      return await fetch(input, init);
    };
    const launcher = new CodexPluginRuntimeLauncher({
      fetchImpl,
      identity: {
        channel: "beta",
        namespace: "release-beta",
        protocolVersion: 1,
        runtimeDigest,
        runtimeVersion: "1.2.3-beta.4",
        shellDigest: `sha256:${"b".repeat(64)}`,
        shellType: "codex-plugin",
        shellVersion: "0.1.0",
      },
      manifestUrl,
      shellVersion: "0.1.0",
      suitePaths,
    });
    const storePaths = resolveDistributionRuntimeStorePaths(suitePaths);
    await mkdir(dirname(storePaths.activePath), { recursive: true });
    await writeFile(storePaths.activePath, JSON.stringify({
      channel: "beta",
      generation: 7,
      namespace: "release-beta",
      protocolVersion: 1,
      runtimeDigest: `sha256:${"c".repeat(64)}`,
      runtimeVersion: "1.2.2-beta.3",
      schemaVersion: 1,
      updatedAt: "2026-07-27T12:00:00.000Z",
    }));

    try {
      const first = await launcher.ensureRuntime();
      expect(first).toMatchObject({
        attached: false,
        handoff: {
          state: "confirmed",
        },
        reusedArtifact: false,
      });
      const second = await launcher.ensureRuntime();
      expect(second).toMatchObject({
        attached: true,
        handoff: null,
        reusedArtifact: true,
      });

      expect(JSON.parse(await readFile(storePaths.activePath, "utf8"))).toMatchObject({
        generation: 8,
        runtimeDigest,
        runtimeVersion: "1.2.3-beta.4",
      });
      expect(JSON.parse(await readFile(storePaths.bindingPath, "utf8"))).toMatchObject({
        owner: {
          shellType: "codex-plugin",
        },
        runtimeDigest,
      });

      await launcher.stopOwnedRuntime();
      manifest = createManifest("1.2.4-beta.5", "v2");
      const updated = await launcher.ensureRuntime();
      expect(updated).toMatchObject({
        attached: false,
        manifest: {
          runtimeDigest: manifest.runtimeDigest,
          runtimeVersion: "1.2.4-beta.5",
        },
        reusedArtifact: false,
      });
      expect(JSON.parse(await readFile(storePaths.activePath, "utf8"))).toMatchObject({
        generation: 9,
        runtimeDigest: manifest.runtimeDigest,
        runtimeVersion: "1.2.4-beta.5",
      });

      const compatibleManifest = manifest;
      manifest = createManifest("1.2.5-beta.6", "v3", "0.2.0");
      const fallback = await launcher.ensureRuntime();
      expect(fallback).toMatchObject({
        attached: true,
        manifest: {
          runtimeDigest: compatibleManifest.runtimeDigest,
          runtimeVersion: compatibleManifest.runtimeVersion,
        },
        reusedArtifact: true,
      });
    } finally {
      await launcher.stopOwnedRuntime();
    }
  }, 20_000);
});
