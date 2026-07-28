import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createCodexPluginPublicationPlan,
  compareCodexPluginRuntimeVersions,
  loadCodexPluginBuildReport,
} from "./publication.ts";
import {
  optional,
  required,
  storageConfigFromEnv,
  writeJson,
} from "../storage/common.ts";
import {
  getStorageObject,
  putStorageObject,
  putStorageObjectWithStatus,
} from "../storage/s3-upload.ts";
import { parseCodexPluginAcquisitionManifest } from "@open-design/codex-plugin-proto";

const buildReportPath = required("CODEX_PLUGIN_BUILD_REPORT");
const platform = required("CODEX_PLUGIN_PLATFORM");
const publicOrigin = required("RELEASE_PUBLIC_ORIGIN");
const outputPath = required("CODEX_PLUGIN_PUBLICATION_REPORT");
const minimumShellVersion = optional("CODEX_PLUGIN_MIN_SHELL_VERSION");
const shellUpdateUrl = optional("CODEX_PLUGIN_SHELL_UPDATE_URL");
const publishSideEffectsEnabled =
  optional("RELEASE_PUBLISH_SIDE_EFFECTS", "true") !== "false";
const dryRunMode = optional("RELEASE_DRY_RUN_MODE", "plan");
const storage = publishSideEffectsEnabled ? storageConfigFromEnv() : null;
const plan = await createCodexPluginPublicationPlan({
  buildReport: await loadCodexPluginBuildReport(buildReportPath),
  minimumShellVersion:
    minimumShellVersion.length === 0 ? undefined : minimumShellVersion,
  platform,
  publicOrigin,
  shellUpdateUrl: shellUpdateUrl.length === 0 ? undefined : shellUpdateUrl,
});

if (publishSideEffectsEnabled) {
  if (storage == null) throw new Error("storage config is required");
  const artifactBytes = await readFile(plan.artifact.path);
  const existingArtifact = await getStorageObject({
    ...storage,
    objectKey: plan.artifact.objectKey,
  });
  if (
    existingArtifact != null
    && !existingArtifact.bytes.equals(artifactBytes)
  ) {
    throw new Error(
      `refusing to replace immutable Codex runtime ${plan.artifact.objectKey}`,
    );
  }
  if (existingArtifact == null) {
    await putStorageObject({
      ...storage,
      body: artifactBytes,
      cacheControl: plan.artifact.cacheControl,
      contentType: plan.artifact.contentType,
      objectKey: plan.artifact.objectKey,
    });
  }

  const latestBytes = Buffer.from(
    `${JSON.stringify(plan.latestManifest.manifest, null, 2)}\n`,
    "utf8",
  );
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const existingLatest = await getStorageObject({
      ...storage,
      objectKey: plan.latestManifest.objectKey,
    });
    const headers: Record<string, string> = {};
    if (existingLatest == null) {
      headers["if-none-match"] = "*";
    } else {
      const existingManifest = parseCodexPluginAcquisitionManifest(
        JSON.parse(existingLatest.text) as unknown,
      );
      if (
        existingManifest.channel !== plan.latestManifest.manifest.channel
        || existingManifest.namespace !== plan.latestManifest.manifest.namespace
        || existingManifest.protocolVersion
          !== plan.latestManifest.manifest.protocolVersion
      ) {
        throw new Error("published Codex latest manifest changed fixed coordinates");
      }
      if (
        compareCodexPluginRuntimeVersions(
          existingManifest,
          plan.latestManifest.manifest,
        ) > 0
      ) {
        throw new Error(
          `refusing to move Codex latest backward from ${existingManifest.runtimeVersion} to ${plan.latestManifest.manifest.runtimeVersion}`,
        );
      }
      if (
        existingManifest.runtimeVersion
          === plan.latestManifest.manifest.runtimeVersion
        && existingManifest.runtimeDigest
          !== plan.latestManifest.manifest.runtimeDigest
      ) {
        throw new Error(
          `Codex latest ${existingManifest.runtimeVersion} already points to different bytes`,
        );
      }
      if (existingLatest.etag.length === 0) {
        throw new Error("Codex latest manifest GET did not return an ETag");
      }
      headers["if-match"] = existingLatest.etag;
    }
    const result = await putStorageObjectWithStatus({
      ...storage,
      body: latestBytes,
      cacheControl: plan.latestManifest.cacheControl,
      contentType: "application/json; charset=utf-8",
      headers,
      objectKey: plan.latestManifest.objectKey,
    });
    if (result.ok) break;
    if (result.status !== 412 || attempt === 5) {
      throw new Error(
        `failed to publish Codex latest manifest: HTTP ${result.status}${result.body.length > 0 ? `: ${result.body}` : ""}`,
      );
    }
  }
} else {
  console.log(
    `[dry-run:${dryRunMode}] would upload ${plan.artifact.path} to ${plan.artifact.objectKey}`,
  );
  console.log(
    `[dry-run:${dryRunMode}] would publish latest manifest to ${plan.latestManifest.objectKey}`,
  );
}

await mkdir(dirname(outputPath), { recursive: true });
writeJson(outputPath, {
  artifact: plan.artifact,
  buildReportPath,
  latestManifest: plan.latestManifest,
  platform: plan.platform,
  state: publishSideEffectsEnabled ? "published" : "planned",
  version: 1,
});
await writeFile(
  `${outputPath}.md`,
  [
    "## Codex plugin runtime publication",
    "",
    `- state: \`${publishSideEffectsEnabled ? "published" : "planned"}\``,
    `- platform: \`${plan.platform}\``,
    `- runtime: \`${plan.buildReport.identity.runtimeVersion}\``,
    `- artifact: ${plan.artifact.url}`,
    `- latest: ${plan.latestManifest.url}`,
    "",
  ].join("\n"),
  "utf8",
);
