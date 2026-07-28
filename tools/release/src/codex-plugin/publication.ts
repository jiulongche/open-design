import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import {
  CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
  CODEX_PLUGIN_RUNTIME_MEDIA_TYPES,
  normalizeCodexPluginPlatformTarget,
  parseCodexPluginAcquisitionManifest,
  resolveCodexPluginReleasePaths,
  type CodexPluginAcquisitionManifestV1,
  type CodexPluginPlatformTarget,
  type CodexPluginRuntimeMediaType,
} from "@open-design/codex-plugin-proto";
import {
  parseDistributionBuildReport,
  type DistributionBuildReportV1,
} from "@open-design/distribution-proto";
import {
  compareReleaseBaseVersions,
  parseReleaseBaseVersion,
  parseReleaseVersion,
} from "@open-design/release";

export type CodexPluginPublicationPlan = {
  artifact: {
    cacheControl: string;
    contentType: CodexPluginRuntimeMediaType;
    objectKey: string;
    path: string;
    url: string;
  };
  buildReport: DistributionBuildReportV1;
  latestManifest: {
    cacheControl: string;
    manifest: CodexPluginAcquisitionManifestV1;
    objectKey: string;
    url: string;
  };
  platform: CodexPluginPlatformTarget;
};

function runtimeMediaType(path: string): CodexPluginRuntimeMediaType {
  return path.endsWith(".zip")
    ? CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.ZIP_V1
    : CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.NODE_MODULE_V1;
}

function publicObjectUrl(publicOrigin: string, objectKey: string): string {
  return `${publicOrigin.replace(/\/+$/u, "")}/${objectKey}`;
}

export async function loadCodexPluginBuildReport(
  buildReportPath: string,
): Promise<DistributionBuildReportV1> {
  return parseDistributionBuildReport(
    JSON.parse(await readFile(buildReportPath, "utf8")) as unknown,
  );
}

export async function createCodexPluginPublicationPlan(options: {
  buildReport: DistributionBuildReportV1;
  minimumShellVersion?: string;
  platform: unknown;
  publicOrigin: string;
  shellUpdateUrl?: string;
}): Promise<CodexPluginPublicationPlan> {
  const buildReport = parseDistributionBuildReport(options.buildReport);
  if (buildReport.identity.shellType !== "codex-plugin") {
    throw new Error("Codex plugin publication requires a codex-plugin build report");
  }
  if (buildReport.runtimeArtifact == null) {
    throw new Error("Codex plugin build report does not contain a runtime artifact");
  }
  const platform = normalizeCodexPluginPlatformTarget(options.platform);
  const reportPlatform = normalizeCodexPluginPlatformTarget(
    basename(dirname(buildReport.paths.artifactRoot)),
  );
  if (reportPlatform !== platform) {
    throw new Error(
      `Codex plugin publication platform mismatch: report is ${reportPlatform}; requested ${platform}`,
    );
  }
  const bytes = await readFile(buildReport.runtimeArtifact.path);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (
    bytes.byteLength !== buildReport.runtimeArtifact.size
    || digest !== buildReport.runtimeArtifact.digest
  ) {
    throw new Error("Codex plugin runtime artifact does not match its build report");
  }
  const mediaType = runtimeMediaType(buildReport.runtimeArtifact.path);
  const paths = resolveCodexPluginReleasePaths({
    channel: buildReport.identity.channel,
    mediaType,
    namespace: buildReport.identity.namespace,
    platform,
    runtimeVersion: buildReport.identity.runtimeVersion,
  });
  const artifactUrl = publicObjectUrl(
    options.publicOrigin,
    paths.runtimeArtifactPath,
  );
  const manifest = parseCodexPluginAcquisitionManifest({
    artifact: {
      digest: buildReport.runtimeArtifact.digest,
      entryPath: buildReport.runtimeArtifact.entryPath,
      mediaType,
      size: buildReport.runtimeArtifact.size,
      url: artifactUrl,
    },
    channel: buildReport.identity.channel,
    control: {
      codexPlugin: {
        version: {
          min: options.minimumShellVersion ?? buildReport.identity.shellVersion,
          ...(options.shellUpdateUrl == null || options.shellUpdateUrl.length === 0
            ? {}
            : { url: options.shellUpdateUrl }),
        },
      },
    },
    namespace: buildReport.identity.namespace,
    protocolVersion: buildReport.identity.protocolVersion,
    runtimeDigest: buildReport.identity.runtimeDigest,
    runtimeVersion: buildReport.identity.runtimeVersion,
    schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
  });
  return {
    artifact: {
      cacheControl: "public, max-age=31536000, immutable",
      contentType: mediaType,
      objectKey: paths.runtimeArtifactPath,
      path: buildReport.runtimeArtifact.path,
      url: artifactUrl,
    },
    buildReport,
    latestManifest: {
      cacheControl: "public, max-age=60, must-revalidate",
      manifest,
      objectKey: paths.latestRuntimeManifestPath,
      url: publicObjectUrl(options.publicOrigin, paths.latestRuntimeManifestPath),
    },
    platform,
  };
}

export function compareCodexPluginRuntimeVersions(
  left: CodexPluginAcquisitionManifestV1,
  right: CodexPluginAcquisitionManifestV1,
): number {
  if (left.channel !== right.channel) {
    throw new Error(
      `cannot compare Codex runtime versions across ${left.channel} and ${right.channel}`,
    );
  }
  const leftVersion = parseReleaseVersion(left.runtimeVersion, left.channel);
  const rightVersion = parseReleaseVersion(right.runtimeVersion, right.channel);
  const leftBase = parseReleaseBaseVersion(leftVersion.baseVersion);
  const rightBase = parseReleaseBaseVersion(rightVersion.baseVersion);
  if (leftBase == null || rightBase == null) {
    throw new Error("Codex runtime version contains an invalid base version");
  }
  const baseOrder = compareReleaseBaseVersions(leftBase, rightBase);
  if (baseOrder !== 0) return baseOrder;
  if (leftVersion.channel === "stable" || rightVersion.channel === "stable") {
    return 0;
  }
  return Math.sign(leftVersion.number - rightVersion.number);
}
