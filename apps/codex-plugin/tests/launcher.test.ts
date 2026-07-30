import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
  CODEX_PLUGIN_RUNTIME_ENV,
  CODEX_PLUGIN_RUNTIME_MEDIA_TYPES,
  CODEX_PLUGIN_UPDATE_CHECK_STATES,
  resolveCodexPluginSuitePaths,
} from "@open-design/codex-plugin-proto";
import {
  resolveDistributionRuntimeStorePaths,
  resolveDistributionRuntimeVersionPaths,
  resolveDistributionSuitePaths,
} from "@open-design/distribution-proto";

import {
  CODEX_PLUGIN_ACTIVE_MANIFEST_TIMEOUT_MS,
  CODEX_PLUGIN_FIRST_MANIFEST_TIMEOUT_MS,
  CODEX_PLUGIN_RUNTIME_OBSERVER_TIMEOUT_MS,
  CODEX_PLUGIN_RUNTIME_READY_TIMEOUT_MS,
  CodexPluginRuntimeLauncher,
} from "../src/launcher.js";

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

async function waitForUpdateState(
  launcher: CodexPluginRuntimeLauncher,
  state: string,
  timeoutMs = 2_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await launcher.readUpdateStatus();
    if (status?.state === state) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`update check did not reach ${state} within ${timeoutMs}ms`);
}

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
    const runtimeSource = (tag: string) => tag === "crash"
      ? "process.exit(1);\n"
      : `
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
      shellUpdateUrl?: string,
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
              ...(shellUpdateUrl == null ? {} : { url: shellUpdateUrl }),
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
    const previousManifest = createManifest("1.2.2-beta.3", "v0");
    let manifest = createManifest("1.2.3-beta.4", "v1");
    let manifestMode: "available" | "blocked" | "offline" = "available";
    const manifestControl: {
      release: (() => void) | null;
    } = { release: null };
    let observeBlockedManifest: (() => void) | null = null;
    const runtimeDigest = manifest.runtimeDigest;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === manifestUrl) {
        if (manifestMode === "blocked") {
          observeBlockedManifest?.();
          await new Promise<void>((resolve, reject) => {
            manifestControl.release = resolve;
            const signal = init?.signal;
            const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
            if (signal?.aborted) {
              onAbort();
              return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });
          });
        }
        if (manifestMode === "offline") {
          return new Response("offline", { status: 503 });
        }
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
    const previousVersionPaths = resolveDistributionRuntimeVersionPaths({
      runtimeDigest: previousManifest.runtimeDigest,
      runtimeVersion: previousManifest.runtimeVersion,
      storePaths,
    });
    await mkdir(dirname(previousVersionPaths.manifestPath), { recursive: true });
    await writeFile(
      previousVersionPaths.manifestPath,
      JSON.stringify(previousManifest),
    );
    await writeFile(storePaths.activePath, JSON.stringify({
      channel: "beta",
      generation: 7,
      namespace: "release-beta",
      protocolVersion: 1,
      runtimeDigest: previousManifest.runtimeDigest,
      runtimeVersion: previousManifest.runtimeVersion,
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
        updateCheck: {
          state: CODEX_PLUGIN_UPDATE_CHECK_STATES.CURRENT,
        },
      });
      manifestMode = "blocked";
      const blockedManifestObserved = new Promise<void>((resolve) => {
        observeBlockedManifest = resolve;
      });
      const attachedAt = Date.now();
      try {
        const second = await Promise.race([
          launcher.ensureRuntime(),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(
              "live attach waited for the remote manifest",
            )), 500);
          }),
        ]);
        expect(Date.now() - attachedAt).toBeLessThan(500);
        expect(second).toMatchObject({
          attached: true,
          handoff: null,
          reusedArtifact: true,
          updateCheck: {
            state: CODEX_PLUGIN_UPDATE_CHECK_STATES.DEFERRED,
          },
        });
        await blockedManifestObserved;
      } finally {
        manifestMode = "available";
        manifestControl.release?.();
        manifestControl.release = null;
        observeBlockedManifest = null;
      }
      await waitForUpdateState(
        launcher,
        CODEX_PLUGIN_UPDATE_CHECK_STATES.CURRENT,
      );

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
      manifestMode = "blocked";
      const offlineStartedAt = Date.now();
      const offline = await launcher.ensureRuntime();
      expect(Date.now() - offlineStartedAt).toBeGreaterThanOrEqual(
        CODEX_PLUGIN_ACTIVE_MANIFEST_TIMEOUT_MS - 100,
      );
      expect(Date.now() - offlineStartedAt).toBeLessThan(2_000);
      expect(offline).toMatchObject({
        attached: false,
        manifest: {
          runtimeDigest,
          runtimeVersion: "1.2.3-beta.4",
        },
        reusedArtifact: true,
        updateCheck: {
          state: CODEX_PLUGIN_UPDATE_CHECK_STATES.UNAVAILABLE,
        },
      });

      await launcher.stopOwnedRuntime();
      manifestMode = "available";
      const failedManifest = createManifest("1.2.4-beta.5", "crash");
      manifest = failedManifest;
      await expect(launcher.ensureRuntime()).rejects.toMatchObject({
        code: "RUNTIME_EXITED_EARLY",
      });
      expect(JSON.parse(await readFile(storePaths.attemptPath, "utf8"))).toMatchObject({
        runtimeDigest: failedManifest.runtimeDigest,
        runtimeVersion: "1.2.4-beta.5",
      });
      expect(JSON.parse(await readFile(storePaths.activePath, "utf8"))).toMatchObject({
        generation: 9,
        runtimeDigest,
        runtimeVersion: "1.2.3-beta.4",
      });

      const rollback = await launcher.ensureRuntime();
      expect(rollback).toMatchObject({
        attached: false,
        manifest: {
          runtimeDigest,
          runtimeVersion: "1.2.3-beta.4",
        },
        reusedArtifact: true,
      });
      expect(JSON.parse(await readFile(storePaths.attemptPath, "utf8"))).toMatchObject({
        runtimeDigest: failedManifest.runtimeDigest,
        runtimeVersion: "1.2.4-beta.5",
      });

      await launcher.stopOwnedRuntime();
      manifest = createManifest("1.2.5-beta.6", "v3");
      const updated = await launcher.ensureRuntime();
      expect(updated).toMatchObject({
        attached: false,
        manifest: {
          runtimeDigest: manifest.runtimeDigest,
          runtimeVersion: "1.2.5-beta.6",
        },
        reusedArtifact: false,
      });
      expect(JSON.parse(await readFile(storePaths.activePath, "utf8"))).toMatchObject({
        generation: 11,
        runtimeDigest: manifest.runtimeDigest,
        runtimeVersion: "1.2.5-beta.6",
      });
      await expect(readFile(storePaths.attemptPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      const compatibleManifest = manifest;
      manifest = createManifest(
        "1.2.6-beta.7",
        "v4",
        "0.2.0",
        "https://updates.example.com/codex-plugin",
      );
      const fallback = await launcher.ensureRuntime();
      expect(fallback).toMatchObject({
        attached: true,
        manifest: {
          runtimeDigest: compatibleManifest.runtimeDigest,
          runtimeVersion: compatibleManifest.runtimeVersion,
        },
        reusedArtifact: true,
        updateCheck: {
          state: CODEX_PLUGIN_UPDATE_CHECK_STATES.DEFERRED,
        },
      });
      expect(await waitForUpdateState(
        launcher,
        CODEX_PLUGIN_UPDATE_CHECK_STATES.AVAILABLE,
      )).toMatchObject({
        candidate: {
          runtimeVersion: "1.2.6-beta.7",
        },
        minimumShellVersion: "0.2.0",
        shellUpdateUrl: "https://updates.example.com/codex-plugin",
      });
    } finally {
      manifestControl.release?.();
      await launcher.stopOwnedRuntime();
    }
  }, 20_000);

  it("uses the agreed first-install, active, ready, and observer budgets", () => {
    expect(CODEX_PLUGIN_ACTIVE_MANIFEST_TIMEOUT_MS).toBe(500);
    expect(CODEX_PLUGIN_FIRST_MANIFEST_TIMEOUT_MS).toBe(5_000);
    expect(CODEX_PLUGIN_RUNTIME_READY_TIMEOUT_MS).toBe(45_000);
    expect(CODEX_PLUGIN_RUNTIME_OBSERVER_TIMEOUT_MS).toBeGreaterThanOrEqual(
      CODEX_PLUGIN_RUNTIME_READY_TIMEOUT_MS + 5_000,
    );
  });

  it("returns typed unavailable state when first installation cannot reach a manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-codex-runtime-unavailable-"));
    roots.push(root);
    const suitePaths = resolveCodexPluginSuitePaths(
      resolveDistributionSuitePaths({
        channel: "beta",
        namespace: "release-beta-unavailable",
        namespaceBaseRoot: join(root, "namespaces"),
      }),
    );
    const launcher = new CodexPluginRuntimeLauncher({
      fetchImpl: async () => new Response("offline", { status: 503 }),
      identity: {
        channel: "beta",
        namespace: "release-beta-unavailable",
        protocolVersion: 1,
        runtimeDigest: `sha256:${"a".repeat(64)}`,
        runtimeVersion: "1.2.3-beta.4",
        shellDigest: `sha256:${"b".repeat(64)}`,
        shellType: "codex-plugin",
        shellVersion: "0.1.0",
      },
      manifestUrl:
        "http://127.0.0.1:17456/unavailable/manifest.json",
      shellVersion: "0.1.0",
      suitePaths,
    });
    await expect(launcher.ensureRuntime()).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
    expect(await launcher.readUpdateStatus()).toMatchObject({
      error: {
        code: "RUNTIME_HTTP_FAILED",
      },
      state: CODEX_PLUGIN_UPDATE_CHECK_STATES.UNAVAILABLE,
    });
  });

  it("does not retry one failed immutable candidate without a confirmed fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-codex-runtime-quarantine-"));
    roots.push(root);
    const suitePaths = resolveCodexPluginSuitePaths(
      resolveDistributionSuitePaths({
        channel: "beta",
        namespace: "release-beta-quarantine",
        namespaceBaseRoot: join(root, "namespaces"),
      }),
    );
    const bytes = Buffer.from("process.exit(1);\n");
    const digest =
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const manifestUrl = "http://127.0.0.1:17456/quarantine/manifest.json";
    const artifactUrl = "http://127.0.0.1:17456/quarantine/runtime.mjs";
    const manifest = {
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
            min: "0.1.0",
          },
        },
      },
      namespace: "release-beta-quarantine",
      protocolVersion: 1,
      runtimeDigest: digest,
      runtimeVersion: "1.2.3-beta.4",
      schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
    } as const;
    let artifactRequests = 0;
    const launcher = new CodexPluginRuntimeLauncher({
      fetchImpl: async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === manifestUrl) {
          return new Response(JSON.stringify(manifest), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url === artifactUrl) {
          artifactRequests += 1;
          return new Response(bytes, {
            headers: { "content-type": manifest.artifact.mediaType },
          });
        }
        throw new Error(`unexpected URL: ${url}`);
      },
      identity: {
        channel: "beta",
        namespace: "release-beta-quarantine",
        protocolVersion: 1,
        runtimeDigest: digest,
        runtimeVersion: "1.2.3-beta.4",
        shellDigest: `sha256:${"b".repeat(64)}`,
        shellType: "codex-plugin",
        shellVersion: "0.1.0",
      },
      manifestUrl,
      shellVersion: "0.1.0",
      suitePaths,
    });
    await expect(launcher.ensureRuntime()).rejects.toMatchObject({
      code: "RUNTIME_EXITED_EARLY",
    });
    await expect(launcher.ensureRuntime()).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
    expect(artifactRequests).toBe(1);
  });

  it("fails closed with typed errors for corrupt local runtime state", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const manifest = {
      artifact: {
        digest,
        entryPath: "runtime.mjs",
        mediaType: CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.NODE_MODULE_V1,
        size: 1,
        url: "http://127.0.0.1:17456/corrupt/runtime.mjs",
      },
      channel: "beta",
      control: {
        codexPlugin: {
          version: {
            min: "0.1.0",
          },
        },
      },
      namespace: "release-beta-corrupt",
      protocolVersion: 1,
      runtimeDigest: digest,
      runtimeVersion: "1.2.3-beta.4",
      schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
    } as const;
    const cases = [
      {
        code: "RUNTIME_ACTIVE_STATE_INVALID",
        prepare: async (
          storePaths: ReturnType<typeof resolveDistributionRuntimeStorePaths>,
        ) => {
          await mkdir(dirname(storePaths.activePath), { recursive: true });
          await writeFile(storePaths.activePath, "{");
        },
      },
      {
        code: "RUNTIME_MANIFEST_STATE_INVALID",
        prepare: async (
          storePaths: ReturnType<typeof resolveDistributionRuntimeStorePaths>,
        ) => {
          await mkdir(dirname(storePaths.activePath), { recursive: true });
          await writeFile(storePaths.activePath, JSON.stringify({
            channel: manifest.channel,
            generation: 0,
            namespace: manifest.namespace,
            protocolVersion: manifest.protocolVersion,
            runtimeDigest: manifest.runtimeDigest,
            runtimeVersion: manifest.runtimeVersion,
            schemaVersion: 1,
            updatedAt: "2026-07-29T12:00:00.000Z",
          }));
          const versionPaths = resolveDistributionRuntimeVersionPaths({
            runtimeDigest: manifest.runtimeDigest,
            runtimeVersion: manifest.runtimeVersion,
            storePaths,
          });
          await mkdir(dirname(versionPaths.manifestPath), { recursive: true });
          await writeFile(versionPaths.manifestPath, "{");
        },
      },
      {
        code: "RUNTIME_ATTEMPT_STATE_INVALID",
        prepare: async (
          storePaths: ReturnType<typeof resolveDistributionRuntimeStorePaths>,
        ) => {
          await mkdir(dirname(storePaths.attemptPath), { recursive: true });
          await writeFile(storePaths.attemptPath, "{");
        },
      },
      {
        code: "RUNTIME_BINDING_STATE_INVALID",
        prepare: async (
          storePaths: ReturnType<typeof resolveDistributionRuntimeStorePaths>,
        ) => {
          await mkdir(dirname(storePaths.bindingPath), { recursive: true });
          await writeFile(storePaths.bindingPath, "{");
        },
      },
      {
        code: "RUNTIME_LEASE_STATE_INVALID",
        prepare: async (
          storePaths: ReturnType<typeof resolveDistributionRuntimeStorePaths>,
        ) => {
          await mkdir(storePaths.lockRoot, { recursive: true });
          await writeFile(storePaths.leasePath, "{");
        },
      },
    ] as const;

    for (const stateCase of cases) {
      const root = await mkdtemp(join(tmpdir(), "od-codex-runtime-corrupt-"));
      roots.push(root);
      const suitePaths = resolveCodexPluginSuitePaths(
        resolveDistributionSuitePaths({
          channel: "beta",
          namespace: manifest.namespace,
          namespaceBaseRoot: join(root, "namespaces"),
        }),
      );
      const storePaths = resolveDistributionRuntimeStorePaths(suitePaths);
      await stateCase.prepare(storePaths);
      const launcher = new CodexPluginRuntimeLauncher({
        fetchImpl: async (input) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.includes("manifest")) {
            return new Response(JSON.stringify(manifest), {
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error(`unexpected URL: ${url}`);
        },
        identity: {
          channel: manifest.channel,
          namespace: manifest.namespace,
          protocolVersion: manifest.protocolVersion,
          runtimeDigest: manifest.runtimeDigest,
          runtimeVersion: manifest.runtimeVersion,
          shellDigest: `sha256:${"b".repeat(64)}`,
          shellType: "codex-plugin",
          shellVersion: "0.1.0",
        },
        manifestUrl: "http://127.0.0.1:17456/corrupt/manifest.json",
        shellVersion: "0.1.0",
        suitePaths,
      });
      await expect(launcher.ensureRuntime()).rejects.toMatchObject({
        code: stateCase.code,
      });
    }
  });

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
