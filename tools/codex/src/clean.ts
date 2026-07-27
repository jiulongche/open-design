import { lstat, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  ToolCodexError,
  acquireToolCodexGlobalLock,
  clearKnownStaleGlobalLock,
  readToolCodexRunMarker,
  readToolCodexSentinel,
  removeToolCodexRunMarker,
  resetToolCodexDirectory,
  updateToolCodexSentinel,
  type ToolCodexPaths,
} from "./state.js";
import { inspectToolCodexEnvironment } from "./host.js";
import { removeToolCodexPreparedPlugin } from "./plugin.js";

export const TOOLS_CODEX_CLEAN_LAYERS = [
  "control",
  "runs",
  "plugin",
  "cache",
  "credentials",
  "home",
] as const;

export type ToolCodexCleanLayer = (typeof TOOLS_CODEX_CLEAN_LAYERS)[number];

export type ToolCodexCleanResult = {
  externalCredentialStoreRetained: boolean;
  layer: ToolCodexCleanLayer;
  removed: string[];
  retained: string[];
};

function assertCleanHostReady(status: Awaited<ReturnType<typeof inspectToolCodexEnvironment>>): void {
  if (status.desktop.roots.length > 0 || status.state === "unknown") {
    throw new ToolCodexError(
      status.reasonCode ?? "DESKTOP_RUNNING",
      "tools-codex clean requires a known host state with no Codex Desktop roots",
    );
  }
}

async function removeFileIfPresent(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() && !info.isSocket()) {
      throw new ToolCodexError("CLEAN_TARGET_UNEXPECTED", `clean target is not a file or socket: ${path}`);
    }
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function cleanToolCodexEnvironment(options: {
  appPath?: string;
  codexBin?: string;
  confirmHome?: string;
  layer: ToolCodexCleanLayer;
  paths: ToolCodexPaths;
}): Promise<ToolCodexCleanResult> {
  await readToolCodexSentinel(options.paths);
  const status = await inspectToolCodexEnvironment({
    appPath: options.appPath,
    codexBin: options.codexBin,
    paths: options.paths,
  });
  assertCleanHostReady(status);
  if (options.layer === "control") {
    await clearKnownStaleGlobalLock(options.paths);
  }
  const lock = await acquireToolCodexGlobalLock(options.paths, `clean:${options.layer}`);
  try {
    assertCleanHostReady(await inspectToolCodexEnvironment({
      appPath: options.appPath,
      codexBin: options.codexBin,
      paths: options.paths,
    }));
    const removed: string[] = [];
    const retained: string[] = [];
    if (options.layer === "control") {
      const marker = await readToolCodexRunMarker(options.paths);
      if (marker != null) {
        await removeToolCodexRunMarker(options.paths);
        removed.push(options.paths.markerPath);
      }
      const socketPath = join(options.paths.codexHome, "ipc", "ipc.sock");
      if (await removeFileIfPresent(socketPath)) removed.push(socketPath);
      return {
        externalCredentialStoreRetained: true,
        layer: options.layer,
        removed,
        retained,
      };
    }

    if (options.layer === "runs") {
      await resetToolCodexDirectory(options.paths.runsRoot);
      await resetToolCodexDirectory(options.paths.workspaceRoot);
      removed.push(options.paths.runsRoot, options.paths.workspaceRoot);
      return {
        externalCredentialStoreRetained: true,
        layer: options.layer,
        removed,
        retained,
      };
    }

    if (options.layer === "plugin") {
      const sentinel = await readToolCodexSentinel(options.paths);
      if (sentinel.prepared != null) {
        await removeToolCodexPreparedPlugin(
          options.paths,
          options.codexBin ?? "codex",
          sentinel.prepared.marketplaceName,
        );
        await updateToolCodexSentinel(options.paths, (current) => {
          const { prepared: _prepared, ...rest } = current;
          return rest;
        });
        removed.push(`open-design@${sentinel.prepared.marketplaceName}`);
      }
      return {
        externalCredentialStoreRetained: true,
        layer: options.layer,
        removed,
        retained,
      };
    }

    if (options.layer === "cache") {
      const targets = [
        join(options.paths.codexHome, ".tmp"),
        join(options.paths.codexHome, "computer-use"),
        join(options.paths.codexHome, "plugins"),
      ];
      for (const target of targets) {
        await rm(target, { force: true, recursive: true });
        removed.push(target);
      }
      await updateToolCodexSentinel(options.paths, (current) => {
        const { prepared: _prepared, ...rest } = current;
        return rest;
      });
      retained.push(join(options.paths.codexHome, "auth.json"));
      return {
        externalCredentialStoreRetained: true,
        layer: options.layer,
        removed,
        retained,
      };
    }

    if (options.layer === "credentials") {
      const authPath = join(options.paths.codexHome, "auth.json");
      if (await removeFileIfPresent(authPath)) removed.push(authPath);
      retained.push("OS credential store");
      return {
        externalCredentialStoreRetained: true,
        layer: options.layer,
        removed,
        retained,
      };
    }

    const confirmedHome = options.confirmHome == null
      ? null
      : resolve(options.confirmHome);
    if (confirmedHome !== options.paths.namespaceRoot) {
      throw new ToolCodexError(
        "HOME_CONFIRMATION_REQUIRED",
        `clean home requires --confirm-home ${JSON.stringify(options.paths.namespaceRoot)}`,
      );
    }
    await rm(options.paths.namespaceRoot, { recursive: true, force: false });
    removed.push(options.paths.namespaceRoot);
    return {
      externalCredentialStoreRetained: true,
      layer: options.layer,
      removed,
      retained,
    };
  } finally {
    await lock.release();
  }
}
