import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ToolCodexError,
  initializeToolCodexEnvironment,
  readToolCodexSentinel,
  resolveToolCodexPaths,
  updateToolCodexSentinel,
} from "../src/state.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-design-tools-codex-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

describe("tools-codex managed state", () => {
  it("initializes a separate control root and Codex home idempotently", async () => {
    const stateRoot = await createRoot();
    const paths = resolveToolCodexPaths({
      namespace: "desktop-smoke",
      stateRoot: join(stateRoot, "tools-codex"),
    });
    const first = await initializeToolCodexEnvironment(paths, new Date("2026-07-27T00:00:00.000Z"));
    const second = await initializeToolCodexEnvironment(paths, new Date("2026-07-28T00:00:00.000Z"));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(paths.codexHome).toBe(join(paths.namespaceRoot, "codex-home"));
    expect(paths.desktopUserDataPath).toBe(
      join(paths.namespaceRoot, "desktop-user-data"),
    );
    expect(paths.globalLockPath.startsWith(paths.namespaceRoot)).toBe(false);
    expect(paths.desktopUiObservationPath).toBe(
      join(paths.reportsRoot, "desktop-ui-observation.json"),
    );
    expect(paths.acceptanceReportPath).toBe(
      join(paths.reportsRoot, "acceptance-report.json"),
    );
    expect(second.sentinel.createdAt).toBe("2026-07-27T00:00:00.000Z");
    await expect(access(paths.configPath)).rejects.toMatchObject({ code: "ENOENT" });
    if (process.platform !== "win32") {
      expect((await stat(paths.namespaceRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.sentinelPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses to adopt a non-empty unowned state root", async () => {
    const stateRoot = await createRoot();
    const toolsRoot = join(stateRoot, "tools-codex");
    await mkdir(toolsRoot);
    await writeFile(join(toolsRoot, "foreign.txt"), "foreign");
    const paths = resolveToolCodexPaths({
      namespace: "desktop-smoke",
      stateRoot: toolsRoot,
    });

    await expect(initializeToolCodexEnvironment(paths)).rejects.toMatchObject({
      code: "ROOT_UNOWNED",
    } satisfies Partial<ToolCodexError>);
  });

  it("persists prepared state without rewriting unrelated sentinel fields", async () => {
    const stateRoot = await createRoot();
    const paths = resolveToolCodexPaths({
      namespace: "desktop-smoke",
      stateRoot: join(stateRoot, "tools-codex"),
    });
    await initializeToolCodexEnvironment(paths, new Date("2026-07-27T00:00:00.000Z"));
    await updateToolCodexSentinel(paths, (current) => ({
      ...current,
      prepared: {
        artifactRoot: join(stateRoot, "artifact"),
        identityKey: "identity",
        marketplaceName: "open-design-smoke",
        preparedAt: "2026-07-27T01:00:00.000Z",
        runtime: {
          buildReportPath: join(stateRoot, "artifact", "build-report.json"),
          distributionChannelRoot: join(stateRoot, "channel"),
          fixtureReportUrl: "http://127.0.0.1:17456/report",
          identityKey: "identity",
          runtimeManifestUrl:
            "http://127.0.0.1:17456/runtime/manifest.json",
          verifiedAt: "2026-07-27T01:30:00.000Z",
        },
      },
    }));

    expect(await readToolCodexSentinel(paths)).toMatchObject({
      createdAt: "2026-07-27T00:00:00.000Z",
      prepared: {
        identityKey: "identity",
        marketplaceName: "open-design-smoke",
        runtime: {
          identityKey: "identity",
          runtimeManifestUrl:
            "http://127.0.0.1:17456/runtime/manifest.json",
        },
      },
    });
  });

  it("rejects runtime state for a different prepared identity", async () => {
    const stateRoot = await createRoot();
    const paths = resolveToolCodexPaths({
      namespace: "desktop-smoke",
      stateRoot: join(stateRoot, "tools-codex"),
    });
    await initializeToolCodexEnvironment(paths);
    const sentinel = JSON.parse(
      await readFile(paths.sentinelPath, "utf8"),
    ) as Record<string, unknown>;
    sentinel.prepared = {
      artifactRoot: join(stateRoot, "artifact"),
      identityKey: "prepared-identity",
      marketplaceName: "open-design-smoke",
      preparedAt: "2026-07-27T01:00:00.000Z",
      runtime: {
        buildReportPath: join(stateRoot, "artifact", "build-report.json"),
        distributionChannelRoot: join(stateRoot, "channel"),
        fixtureReportUrl: null,
        identityKey: "different-identity",
        runtimeManifestUrl:
          "http://127.0.0.1:17456/runtime/manifest.json",
        verifiedAt: "2026-07-27T01:30:00.000Z",
      },
    };
    await writeFile(paths.sentinelPath, JSON.stringify(sentinel));

    await expect(readToolCodexSentinel(paths)).rejects.toMatchObject({
      code: "SENTINEL_INVALID",
    } satisfies Partial<ToolCodexError>);
  });

  it("rejects a symlinked namespace root", async () => {
    const stateRoot = await createRoot();
    const paths = resolveToolCodexPaths({
      namespace: "desktop-smoke",
      stateRoot: join(stateRoot, "tools-codex"),
    });
    await initializeToolCodexEnvironment(paths);
    await rm(paths.namespaceRoot, { recursive: true });
    await mkdir(join(stateRoot, "foreign"));
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(join(stateRoot, "foreign"), paths.namespaceRoot)
    );
    await chmod(paths.root, 0o700);

    await expect(readToolCodexSentinel(paths)).rejects.toMatchObject({
      code: "UNSAFE_SYMLINK",
    } satisfies Partial<ToolCodexError>);
  });

  it("fails closed when sentinel metadata is unreadable", async () => {
    const stateRoot = await createRoot();
    const paths = resolveToolCodexPaths({
      namespace: "desktop-smoke",
      stateRoot: join(stateRoot, "tools-codex"),
    });
    await initializeToolCodexEnvironment(paths);
    await writeFile(paths.sentinelPath, "{");

    await expect(readToolCodexSentinel(paths)).rejects.toMatchObject({
      code: "SENTINEL_INVALID",
    } satisfies Partial<ToolCodexError>);
  });
});
