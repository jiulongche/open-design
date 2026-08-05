import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ToolCodexError } from "./state.js";

async function fileInfoIfExists(path: string) {
  return await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

export async function assertToolCodexAuthNotClonedFromDefault(options: {
  defaultCodexHome?: string;
  managedCodexHome: string;
}): Promise<void> {
  const managedAuthPath = join(options.managedCodexHome, "auth.json");
  const managedLinkInfo = await fileInfoIfExists(managedAuthPath);
  if (managedLinkInfo == null) return;
  if (managedLinkInfo.isSymbolicLink()) {
    throw new ToolCodexError(
      "MANAGED_AUTH_CLONE_FORBIDDEN",
      "managed CODEX_HOME auth.json must not be a symbolic link; authenticate this home independently",
      { managedAuthPath },
    );
  }
  if (!managedLinkInfo.isFile()) {
    throw new ToolCodexError(
      "MANAGED_AUTH_INVALID",
      "managed CODEX_HOME auth.json must be a regular file",
      { managedAuthPath },
    );
  }

  const defaultCodexHome = resolve(
    options.defaultCodexHome ?? join(homedir(), ".codex"),
  );
  const defaultAuthPath = join(defaultCodexHome, "auth.json");
  const defaultLinkInfo = await fileInfoIfExists(defaultAuthPath);
  if (defaultLinkInfo == null) return;

  const [managedRealPath, defaultRealPath, managedInfo, defaultInfo] =
    await Promise.all([
      realpath(managedAuthPath),
      realpath(defaultAuthPath),
      stat(managedAuthPath),
      stat(defaultAuthPath),
    ]);
  const sameFile = managedRealPath === defaultRealPath
    || (
      managedInfo.dev === defaultInfo.dev
      && managedInfo.ino !== 0
      && managedInfo.ino === defaultInfo.ino
    );
  const sameBytes = managedInfo.size === defaultInfo.size
    && (await readFile(managedAuthPath)).equals(await readFile(defaultAuthPath));
  if (!sameFile && !sameBytes) return;

  throw new ToolCodexError(
    "MANAGED_AUTH_CLONE_FORBIDDEN",
    "managed CODEX_HOME must use an independent Codex login; copying the default auth.json can invalidate the default session when OAuth refresh tokens rotate",
    { defaultAuthPath, managedAuthPath },
  );
}

export async function verifyToolCodexManagedAuth(options: {
  defaultCodexHome?: string;
  managedCodexHome: string;
}): Promise<{
  independentFromDefault: true;
  managedAuthPath: string;
}> {
  const managedAuthPath = join(options.managedCodexHome, "auth.json");
  if (await fileInfoIfExists(managedAuthPath) == null) {
    throw new ToolCodexError(
      "MANAGED_AUTH_REQUIRED",
      "managed CODEX_HOME must be authenticated independently before real Codex CLI acceptance",
      { managedAuthPath },
    );
  }
  await assertToolCodexAuthNotClonedFromDefault(options);
  return { independentFromDefault: true, managedAuthPath };
}
