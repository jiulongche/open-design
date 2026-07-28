import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
  CODEX_PLUGIN_RUNTIME_ENV,
  CODEX_PLUGIN_RUNTIME_MEDIA_TYPES,
  resolveCodexPluginSuitePaths,
} from "@open-design/codex-plugin-proto";
import {
  resolveDistributionRuntimeStorePaths,
  resolveDistributionRuntimeVersionPaths,
  resolveDistributionSuitePaths,
} from "@open-design/distribution-proto";

import { CodexPluginRuntimeLauncher } from "../src/launcher.js";

const runtimeLeasePollControl = vi.hoisted(() => ({
  current: null as null | {
    observed: () => void;
    resume: Promise<void>;
  },
}));

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...actual,
    setTimeout: async (...args: Parameters<typeof actual.setTimeout>) => {
      const [delay] = args;
      const control = runtimeLeasePollControl.current;
      if (delay === 250 && control != null) {
        control.observed();
        await control.resume;
        return args[1];
      }
      return await actual.setTimeout(...args);
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  runtimeLeasePollControl.current = null;
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { force: true, recursive: true });
  }));
});

describe("Codex plugin runtime launcher", () => {
  it("acquires one immutable runtime, confirms handoff, and reattaches", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-codex-runtime-launcher-"));
    roots.push(root);
    const namespaceBaseRoot = process.platform === "win32"
      ? join(
          root,
          `long-${"a".repeat(80)}`,
          `long-${"b".repeat(80)}`,
          "namespaces",
        )
      : join(root, "namespaces");
    const suitePaths = resolveCodexPluginSuitePaths(
      resolveDistributionSuitePaths({
        channel: "beta",
        namespace: "release-beta",
        namespaceBaseRoot,
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
    if (process.platform === "win32") {
      const versionPaths = resolveDistributionRuntimeVersionPaths({
        runtimeDigest,
        runtimeVersion: "1.2.3-beta.4",
        storePaths,
      });
      expect(versionPaths.payloadRoot.length).toBeGreaterThan(260);
    }
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

  it("observes a live acquisition lease and attaches after binding publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-codex-runtime-concurrent-"));
    roots.push(root);
    const suitePaths = resolveCodexPluginSuitePaths(
      resolveDistributionSuitePaths({
        channel: "beta",
        namespace: "release-beta-concurrent",
        namespaceBaseRoot: join(root, "namespaces"),
      }),
    );
    const runtimeBytes = Buffer.from(`
import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
`);
    const runtimeDigest =
      `sha256:${createHash("sha256").update(runtimeBytes).digest("hex")}`;
    const manifestUrl = "http://127.0.0.1:17456/concurrent/manifest.json";
    const artifactUrl = "http://127.0.0.1:17456/concurrent/runtime.mjs";
    const manifest = {
      artifact: {
        digest: runtimeDigest,
        entryPath: "runtime.mjs",
        mediaType: CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.NODE_MODULE_V1,
        size: runtimeBytes.byteLength,
        url: artifactUrl,
      },
      channel: "beta",
      control: {
        codexPlugin: {
          version: {
            min: "0.1.0",
          },
        },
      },
      namespace: "release-beta-concurrent",
      protocolVersion: 1,
      runtimeDigest,
      runtimeVersion: "1.2.3-beta.4",
      schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
    } as const;
    let releaseArtifact!: () => void;
    const artifactReleased = new Promise<void>((resolve) => {
      releaseArtifact = resolve;
    });
    let artifactRequested!: () => void;
    const artifactRequestObserved = new Promise<void>((resolve) => {
      artifactRequested = resolve;
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === manifestUrl) {
        return new Response(JSON.stringify(manifest), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === artifactUrl) {
        artifactRequested();
        await artifactReleased;
        return new Response(runtimeBytes, {
          headers: { "content-type": manifest.artifact.mediaType },
        });
      }
      return await fetch(input, init);
    };
    const createLauncher = () => new CodexPluginRuntimeLauncher({
      fetchImpl,
      identity: {
        channel: "beta",
        namespace: "release-beta-concurrent",
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
    const owner = createLauncher();
    const observer = createLauncher();
    let leasePollObserved!: () => void;
    const leasePoll = new Promise<void>((resolve) => {
      leasePollObserved = resolve;
    });
    let resumeLeasePoll!: () => void;
    const leasePollResumed = new Promise<void>((resolve) => {
      resumeLeasePoll = resolve;
    });
    runtimeLeasePollControl.current = {
      observed: leasePollObserved,
      resume: leasePollResumed,
    };

    try {
      const ownerResultPromise = owner.ensureRuntime();
      await artifactRequestObserved;
      const observerResultPromise = observer.ensureRuntime();
      await leasePoll;

      releaseArtifact();
      const ownerResult = await ownerResultPromise;
      resumeLeasePoll();
      const observerResult = await observerResultPromise;

      expect(ownerResult).toMatchObject({
        attached: false,
        handoff: {
          state: "confirmed",
        },
        reusedArtifact: false,
      });
      expect(observerResult).toMatchObject({
        attached: true,
        handoff: null,
        reusedArtifact: true,
      });
      expect(observerResult.binding.owner.pid).toBe(ownerResult.binding.owner.pid);
    } finally {
      releaseArtifact();
      resumeLeasePoll();
      runtimeLeasePollControl.current = null;
      await observer.stopOwnedRuntime();
      await owner.stopOwnedRuntime();
    }
  }, 20_000);
});
