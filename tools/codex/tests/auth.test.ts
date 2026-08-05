import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertToolCodexAuthNotClonedFromDefault,
  verifyToolCodexManagedAuth,
} from "../src/auth.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

async function authHomes() {
  const root = await mkdtemp(join(tmpdir(), "open-design-tools-codex-auth-"));
  roots.push(root);
  const defaultCodexHome = join(root, "default");
  const managedCodexHome = join(root, "managed");
  await Promise.all([
    mkdir(defaultCodexHome, { recursive: true }),
    mkdir(managedCodexHome, { recursive: true }),
  ]);
  return { defaultCodexHome, managedCodexHome };
}

describe("tools-codex authentication isolation", () => {
  it("allows an independently authenticated managed home", async () => {
    const homes = await authHomes();
    await writeFile(join(homes.defaultCodexHome, "auth.json"), "default-auth\n");
    await writeFile(join(homes.managedCodexHome, "auth.json"), "managed-auth\n");

    await expect(assertToolCodexAuthNotClonedFromDefault(homes))
      .resolves.toBeUndefined();
  });

  it("rejects a byte-for-byte copy of the default Codex credentials", async () => {
    const homes = await authHomes();
    await writeFile(join(homes.defaultCodexHome, "auth.json"), "shared-auth\n");
    await writeFile(join(homes.managedCodexHome, "auth.json"), "shared-auth\n");

    await expect(assertToolCodexAuthNotClonedFromDefault(homes))
      .rejects.toMatchObject({ code: "MANAGED_AUTH_CLONE_FORBIDDEN" });
  });

  it("rejects a hard link to the default Codex credentials", async () => {
    const homes = await authHomes();
    const defaultAuthPath = join(homes.defaultCodexHome, "auth.json");
    await writeFile(defaultAuthPath, "shared-auth\n");
    await link(defaultAuthPath, join(homes.managedCodexHome, "auth.json"));

    await expect(assertToolCodexAuthNotClonedFromDefault(homes))
      .rejects.toMatchObject({ code: "MANAGED_AUTH_CLONE_FORBIDDEN" });
  });

  it("requires managed credentials for the real CLI preflight", async () => {
    const homes = await authHomes();

    await expect(verifyToolCodexManagedAuth(homes))
      .rejects.toMatchObject({ code: "MANAGED_AUTH_REQUIRED" });
  });

  it("reports an independent managed login without exposing credentials", async () => {
    const homes = await authHomes();
    await writeFile(join(homes.defaultCodexHome, "auth.json"), "default-auth\n");
    await writeFile(join(homes.managedCodexHome, "auth.json"), "managed-auth\n");

    await expect(verifyToolCodexManagedAuth(homes)).resolves.toEqual({
      independentFromDefault: true,
      managedAuthPath: join(homes.managedCodexHome, "auth.json"),
    });
  });
});
