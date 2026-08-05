import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_PLUGIN_RUNTIME_MEDIA_TYPES,
  parseCodexPluginAcquisitionManifest,
} from "@open-design/codex-plugin-proto";
import { parseDistributionBuildReport } from "@open-design/distribution-proto";
import { afterEach, describe, expect, it } from "vitest";

import {
  compareCodexPluginRuntimeVersions,
  createCodexPluginPublicationPlan,
} from "../src/codex-plugin/publication.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

async function fixtureReport(runtimeVersion = "0.16.1-beta.1") {
  const root = await mkdtemp(join(tmpdir(), "od-codex-release-"));
  roots.push(root);
  const platformRoot = join(root, "darwin-arm64");
  const artifactRoot = join(platformRoot, "marketplace");
  const shellRoot = join(artifactRoot, "plugins", "open-design");
  const runtimePath = join(platformRoot, "runtime", "runtime.zip");
  const runtimeBytes = Buffer.from(`runtime:${runtimeVersion}\n`);
  const runtimeDigest =
    `sha256:${createHash("sha256").update(runtimeBytes).digest("hex")}`;
  await mkdir(join(shellRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(platformRoot, "runtime"), { recursive: true });
  await writeFile(join(shellRoot, ".codex-plugin", "plugin.json"), "{}\n");
  await writeFile(runtimePath, runtimeBytes);
  return parseDistributionBuildReport({
    artifact: {
      digest: `sha256:${"b".repeat(64)}`,
      files: [".codex-plugin/plugin.json"],
      size: 3,
    },
    identity: {
      channel: "beta",
      namespace: "release-beta",
      protocolVersion: 1,
      runtimeDigest,
      runtimeVersion,
      shellDigest: `sha256:${"b".repeat(64)}`,
      shellType: "codex-plugin",
      shellVersion: "0.1.0",
    },
    paths: {
      artifactRoot,
      manifestPath: join(shellRoot, ".codex-plugin", "plugin.json"),
      shellRoot,
    },
    runtimeArtifact: {
      digest: runtimeDigest,
      entryPath: "runtime.mjs",
      path: runtimePath,
      size: runtimeBytes.byteLength,
    },
    schemaVersion: 1,
  });
}

describe("Codex plugin runtime publication", () => {
  it("plans production-shaped immutable and latest objects", async () => {
    const plan = await createCodexPluginPublicationPlan({
      buildReport: await fixtureReport(),
      platform: "darwin-arm64",
      publicOrigin: "https://releases.example.com/",
    });

    expect(plan.artifact).toMatchObject({
      contentType: CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.ZIP_V1,
      objectKey:
        "beta/closure/darwin-arm64/versions/0.16.1-beta.1/runtime/runtime.zip",
      url:
        "https://releases.example.com/beta/closure/darwin-arm64/versions/0.16.1-beta.1/runtime/runtime.zip",
    });
    expect(plan.latestManifest.objectKey).toBe(
      "beta/closure/darwin-arm64/latest/runtime.json",
    );
    expect(parseCodexPluginAcquisitionManifest(
      plan.latestManifest.manifest,
    )).toEqual(plan.latestManifest.manifest);
  });

  it("orders counted runtime versions without moving latest backward", async () => {
    const older = (await createCodexPluginPublicationPlan({
      buildReport: await fixtureReport("0.16.1-beta.1"),
      platform: "darwin-arm64",
      publicOrigin: "https://releases.example.com",
    })).latestManifest.manifest;
    const newer = (await createCodexPluginPublicationPlan({
      buildReport: await fixtureReport("0.16.2-beta.1"),
      platform: "darwin-arm64",
      publicOrigin: "https://releases.example.com",
    })).latestManifest.manifest;

    expect(compareCodexPluginRuntimeVersions(newer, older)).toBeGreaterThan(0);
    expect(compareCodexPluginRuntimeVersions(older, newer)).toBeLessThan(0);
  });

  it("refuses to publish a report under another platform path", async () => {
    await expect(createCodexPluginPublicationPlan({
      buildReport: await fixtureReport(),
      platform: "win32-x64",
      publicOrigin: "https://releases.example.com",
    })).rejects.toThrow("platform mismatch");
  });
});
