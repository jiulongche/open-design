import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const inspectToolCodexEnvironment = vi.hoisted(() => vi.fn(async () => ({
  cli: {
    available: true,
    loggedIn: false,
    loginStatus: "Not logged in",
    version: "codex-cli 0.145.0",
  },
  desktop: {
    appPath: "/Applications/Codex.app",
    available: true,
    controlled: false,
    roots: [],
    version: "26.721.41059",
  },
  lock: null,
  marker: null,
  namespace: "desktop-smoke",
  paths: {
    codexHome: "/managed/codex-home",
    namespaceRoot: "/managed",
    stateRoot: "/state",
  },
  reasonCode: null,
  state: "ready" as const,
})));

vi.mock("../src/host.js", () => ({ inspectToolCodexEnvironment }));
vi.mock("../src/plugin.js", () => ({
  removeToolCodexPreparedPlugin: vi.fn(async () => undefined),
}));

import { cleanToolCodexEnvironment } from "../src/clean.js";
import {
  initializeToolCodexEnvironment,
  resolveToolCodexPaths,
} from "../src/state.js";

const roots: string[] = [];

afterEach(async () => {
  inspectToolCodexEnvironment.mockClear();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

describe("tools-codex layered cleanup", () => {
  it("requires the exact canonical namespace path before deleting the whole home", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-tools-codex-clean-"));
    roots.push(root);
    const paths = resolveToolCodexPaths({
      namespace: "desktop-smoke",
      stateRoot: join(root, "state"),
    });
    await initializeToolCodexEnvironment(paths);

    await expect(cleanToolCodexEnvironment({
      confirmHome: join(root, "wrong"),
      layer: "home",
      paths,
    })).rejects.toMatchObject({ code: "HOME_CONFIRMATION_REQUIRED" });
    await expect(access(paths.namespaceRoot)).resolves.toBeUndefined();

    await expect(cleanToolCodexEnvironment({
      confirmHome: paths.namespaceRoot,
      layer: "home",
      paths,
    })).resolves.toMatchObject({
      externalCredentialStoreRetained: true,
      removed: [paths.namespaceRoot],
    });
    await expect(access(paths.namespaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(inspectToolCodexEnvironment).toHaveBeenCalledTimes(4);
  });
});
