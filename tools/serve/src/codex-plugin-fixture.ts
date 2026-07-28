import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { basename, dirname, resolve } from "node:path";

import {
  CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
  CODEX_PLUGIN_RUNTIME_MEDIA_TYPES,
  normalizeCodexPluginPlatformTarget,
  parseCodexPluginAcquisitionManifest,
  parseCodexPluginFixtureReport,
  resolveCodexPluginReleasePaths,
  type CodexPluginAcquisitionManifestV1,
  type CodexPluginFixtureReportV1,
} from "@open-design/codex-plugin-proto";
import {
  DISTRIBUTION_REPORT_SCHEMA_VERSION,
  parseDistributionBuildReport,
  parseDistributionServeReport,
  type DistributionBuildReportV1,
  type DistributionServeReportV1,
} from "@open-design/distribution-proto";
import {
  compareReleaseBaseVersions,
  parseReleaseBaseVersion,
  parseReleaseVersion,
} from "@open-design/release";

export type CodexPluginFixtureOptions = {
  buildReportPath: string;
  host?: string;
  minimumShellVersion?: string;
  port?: number;
  promotionBuildReportPath?: string;
  promotionMinimumShellVersion?: string;
};

export type CodexPluginFixturePromotionOptions = {
  buildReportPath: string;
  minimumShellVersion?: string;
};

export type CodexPluginFixtureServer = {
  buildReport: DistributionBuildReportV1;
  close(): Promise<void>;
  info: CodexPluginFixtureReportV1;
  manifest: CodexPluginAcquisitionManifestV1;
  promotionUrl: string | null;
  promote(
    options: CodexPluginFixturePromotionOptions,
  ): Promise<CodexPluginFixtureReportV1>;
};

type CodexPluginFixturePayload = {
  buildReport: DistributionBuildReportV1;
  runtimeBytes: Buffer;
};

type CodexPluginFixtureRelease = CodexPluginFixturePayload & {
  artifactPath: string;
  info: CodexPluginFixtureReportV1;
  manifest: CodexPluginAcquisitionManifestV1;
  mediaType:
    (typeof CODEX_PLUGIN_RUNTIME_MEDIA_TYPES)[keyof typeof CODEX_PLUGIN_RUNTIME_MEDIA_TYPES];
};

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error == null ? resolveClose() : rejectClose(error)));
  });
}

function assertLoopbackHost(host: string): void {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Codex plugin fixture host must be loopback");
  }
}

function serverOrigin(server: Server): string {
  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("Codex plugin fixture did not listen on TCP");
  }
  const host = address.address === "::1" ? "[::1]" : "127.0.0.1";
  return `http://${host}:${address.port}`;
}

function sendJson(response: import("node:http").ServerResponse, value: unknown): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

async function loadFixturePayload(
  buildReportPath: string,
): Promise<CodexPluginFixturePayload> {
  const resolvedBuildReportPath = resolve(buildReportPath);
  const buildReport = parseDistributionBuildReport(
    JSON.parse(await readFile(resolvedBuildReportPath, "utf8")) as unknown,
  );
  if (buildReport.runtimeArtifact == null) {
    throw new Error("Codex plugin build report does not contain a runtime artifact");
  }
  const runtimeBytes = await readFile(buildReport.runtimeArtifact.path);
  const runtimeDigest =
    `sha256:${createHash("sha256").update(runtimeBytes).digest("hex")}`;
  if (
    runtimeBytes.byteLength !== buildReport.runtimeArtifact.size
    || runtimeDigest !== buildReport.runtimeArtifact.digest
  ) {
    throw new Error("Codex plugin runtime artifact does not match the build report");
  }
  return { buildReport, runtimeBytes };
}

function assertPromotionCoordinate(
  initial: DistributionBuildReportV1,
  promoted: DistributionBuildReportV1,
): void {
  const fixedKeys = [
    "channel",
    "namespace",
    "protocolVersion",
    "shellDigest",
    "shellType",
    "shellVersion",
  ] as const;
  for (const key of fixedKeys) {
    if (initial.identity[key] !== promoted.identity[key]) {
      throw new Error(
        `Codex plugin fixture promotion changed fixed identity field ${key}`,
      );
    }
  }
}

function compareRuntimeVersions(
  left: DistributionBuildReportV1,
  right: DistributionBuildReportV1,
): number {
  const channel = left.identity.channel;
  const leftVersion = parseReleaseVersion(left.identity.runtimeVersion, channel);
  const rightVersion = parseReleaseVersion(right.identity.runtimeVersion, channel);
  const leftBase = parseReleaseBaseVersion(leftVersion.baseVersion);
  const rightBase = parseReleaseBaseVersion(rightVersion.baseVersion);
  if (leftBase == null || rightBase == null) {
    throw new Error("Codex plugin fixture runtime version is invalid");
  }
  const baseOrder = compareReleaseBaseVersions(leftBase, rightBase);
  if (baseOrder !== 0) return baseOrder;
  if (leftVersion.channel === "stable" || rightVersion.channel === "stable") {
    return 0;
  }
  return Math.sign(leftVersion.number - rightVersion.number);
}

function createFixtureRelease(options: {
  minimumShellVersion?: string;
  origin: string;
  payload: CodexPluginFixturePayload;
}): CodexPluginFixtureRelease {
  const { buildReport, runtimeBytes } = options.payload;
  const platform = normalizeCodexPluginPlatformTarget(
    basename(dirname(buildReport.paths.artifactRoot)),
  );
  const mediaType = buildReport.runtimeArtifact!.path.endsWith(".zip")
    ? CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.ZIP_V1
    : CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.NODE_MODULE_V1;
  const releasePaths = resolveCodexPluginReleasePaths({
    channel: buildReport.identity.channel,
    mediaType,
    namespace: buildReport.identity.namespace,
    platform,
    runtimeVersion: buildReport.identity.runtimeVersion,
  });
  const artifactPath = `/${releasePaths.runtimeArtifactPath}`;
  const manifest = parseCodexPluginAcquisitionManifest({
    artifact: {
      digest: buildReport.runtimeArtifact!.digest,
      entryPath: buildReport.runtimeArtifact!.entryPath,
      mediaType,
      size: buildReport.runtimeArtifact!.size,
      url: `${options.origin}${artifactPath}`,
    },
    channel: buildReport.identity.channel,
    control: {
      codexPlugin: {
        version: {
          min: options.minimumShellVersion ?? buildReport.identity.shellVersion,
        },
      },
    },
    namespace: buildReport.identity.namespace,
    protocolVersion: buildReport.identity.protocolVersion,
    runtimeDigest: buildReport.identity.runtimeDigest,
    runtimeVersion: buildReport.identity.runtimeVersion,
    schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
  });
  const info = parseCodexPluginFixtureReport({
    endpointUrl: `${options.origin}/runtime`,
    healthUrl: `${options.origin}/health`,
    identity: buildReport.identity,
    runtimeManifestUrl:
      `${options.origin}/${releasePaths.latestRuntimeManifestPath}`,
    schemaVersion: DISTRIBUTION_REPORT_SCHEMA_VERSION,
  });
  return {
    artifactPath,
    buildReport,
    info,
    manifest,
    mediaType,
    runtimeBytes,
  };
}

export async function startCodexPluginFixtureServer(
  options: CodexPluginFixtureOptions,
): Promise<CodexPluginFixtureServer> {
  const host = options.host ?? "127.0.0.1";
  assertLoopbackHost(host);
  const initialPayload = await loadFixturePayload(options.buildReportPath);
  let current: CodexPluginFixtureRelease | null = null;
  let origin = "";
  let promotionUrl: string | null = null;
  const releases = new Map<string, CodexPluginFixtureRelease>();
  const promote = async (
    promotionOptions: CodexPluginFixturePromotionOptions,
  ): Promise<CodexPluginFixtureReportV1> => {
    const payload = await loadFixturePayload(promotionOptions.buildReportPath);
    assertPromotionCoordinate(initialPayload.buildReport, payload.buildReport);
    if (
      current != null
      && compareRuntimeVersions(current.buildReport, payload.buildReport) > 0
    ) {
      throw new Error(
        `Codex plugin fixture promotion would move latest backward from ${current.buildReport.identity.runtimeVersion} to ${payload.buildReport.identity.runtimeVersion}`,
      );
    }
    const promoted = createFixtureRelease({
      minimumShellVersion: promotionOptions.minimumShellVersion,
      origin,
      payload,
    });
    const existing = releases.get(promoted.artifactPath);
    if (
      existing != null
      && (
        existing.buildReport.runtimeArtifact!.digest
          !== promoted.buildReport.runtimeArtifact!.digest
        || existing.buildReport.runtimeArtifact!.size
          !== promoted.buildReport.runtimeArtifact!.size
      )
    ) {
      throw new Error(
        `Codex plugin fixture promotion would replace immutable artifact ${promoted.artifactPath}`,
      );
    }
    if (existing == null) releases.set(promoted.artifactPath, promoted);
    current = promoted;
    return promoted.info;
  };
  const server = createServer((request, response) => {
    if (
      request.method === "POST"
      && promotionUrl != null
      && request.url === new URL(promotionUrl).pathname
    ) {
      void promote({
        buildReportPath: options.promotionBuildReportPath!,
        minimumShellVersion: options.promotionMinimumShellVersion,
      }).then(
        (info) => sendJson(response, info),
        (error: unknown) => {
          response.statusCode = 409;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(`${JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          })}\n`);
        },
      );
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("allow", promotionUrl == null ? "GET, HEAD" : "GET, HEAD, POST");
      response.end();
      return;
    }
    if (request.url === "/health" && current != null) {
      sendJson(response, {
        identity: current.buildReport.identity,
        ok: true,
      });
      return;
    }
    if (request.url === "/runtime" && current != null) {
      sendJson(response, {
        identity: current.buildReport.identity,
        runtime: {
          digest: current.buildReport.identity.runtimeDigest,
          protocolVersion: current.buildReport.identity.protocolVersion,
          version: current.buildReport.identity.runtimeVersion,
        },
      });
      return;
    }
    if (request.url === "/report" && current != null) {
      sendJson(response, parseDistributionServeReport({
        endpointUrl: current.info.endpointUrl,
        healthUrl: current.info.healthUrl,
        identity: current.info.identity,
        schemaVersion: current.info.schemaVersion,
      }));
      return;
    }
    if (
      current != null
      && (
        request.url === "/runtime/manifest.json"
        || request.url
          === `/codex-plugin/${current.buildReport.identity.channel}/latest/runtime.json`
        || request.url === new URL(current.info.runtimeManifestUrl).pathname
      )
    ) {
      sendJson(response, current.manifest);
      return;
    }
    const release = request.url === "/runtime/runtime.mjs"
      ? current
      : releases.get(request.url ?? "");
    if (release != null) {
      response.statusCode = 200;
      response.setHeader(
        "content-type",
        release.mediaType,
      );
      response.setHeader(
        "content-length",
        String(release.runtimeBytes.byteLength),
      );
      response.end(
        request.method === "HEAD" ? undefined : release.runtimeBytes,
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await listen(server, options.port ?? 0, host);
  origin = serverOrigin(server);
  if (
    options.promotionBuildReportPath != null
    && options.promotionBuildReportPath.length > 0
  ) {
    promotionUrl =
      `${origin}/__tools-serve/codex-plugin/promote/${randomBytes(16).toString("hex")}`;
  }
  current = createFixtureRelease({
    minimumShellVersion: options.minimumShellVersion,
    origin,
    payload: initialPayload,
  });
  releases.set(current.artifactPath, current);
  return {
    get buildReport() {
      return current!.buildReport;
    },
    close: () => close(server),
    get info() {
      return current!.info;
    },
    get manifest() {
      return current!.manifest;
    },
    get promotionUrl() {
      return promotionUrl;
    },
    promote,
  };
}
