import { access, chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
    expect(paths.globalLockPath.startsWith(paths.namespaceRoot)).toBe(false);
    expect(paths.desktopHostLoadReportPath).toBe(
      join(paths.reportsRoot, "desktop-host-load.json"),
    );
    expect(paths.invocationReportPath).toBe(
      join(paths.reportsRoot, "automated-invocation.json"),
    );
    expect(paths.acceptanceReportPath).toBe(
      join(paths.reportsRoot, "acceptance-report.json"),
    );
    expect(second.sentinel.createdAt).toBe("2026-07-27T00:00:00.000Z");
    await expect(access(paths.configPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(paths.namespaceRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.sentinelPath)).mode & 0o777).toBe(0o600);
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
      },
    }));

    expect(await readToolCodexSentinel(paths)).toMatchObject({
      createdAt: "2026-07-27T00:00:00.000Z",
      prepared: {
        identityKey: "identity",
        marketplaceName: "open-design-smoke",
      },
    });
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
