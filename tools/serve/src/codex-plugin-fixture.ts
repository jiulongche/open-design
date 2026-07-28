import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

import {
  CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
  CODEX_PLUGIN_RUNTIME_MEDIA_TYPES,
  parseCodexPluginAcquisitionManifest,
  parseCodexPluginFixtureReport,
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

export type CodexPluginFixtureOptions = {
  buildReportPath: string;
  host?: string;
  port?: number;
};

export type CodexPluginFixtureServer = {
  buildReport: DistributionBuildReportV1;
  close(): Promise<void>;
  info: CodexPluginFixtureReportV1;
  manifest: CodexPluginAcquisitionManifestV1;
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

export async function startCodexPluginFixtureServer(
  options: CodexPluginFixtureOptions,
): Promise<CodexPluginFixtureServer> {
  const host = options.host ?? "127.0.0.1";
  assertLoopbackHost(host);
  const buildReportPath = resolve(options.buildReportPath);
  const buildReport = parseDistributionBuildReport(
    JSON.parse(await readFile(buildReportPath, "utf8")) as unknown,
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
  let info: CodexPluginFixtureReportV1 | null = null;
  let manifest: CodexPluginAcquisitionManifestV1 | null = null;
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("allow", "GET, HEAD");
      response.end();
      return;
    }
    if (request.url === "/health") {
      sendJson(response, {
        identity: buildReport.identity,
        ok: true,
      });
      return;
    }
    if (request.url === "/runtime") {
      sendJson(response, {
        identity: buildReport.identity,
        runtime: {
          digest: buildReport.identity.runtimeDigest,
          protocolVersion: buildReport.identity.protocolVersion,
          version: buildReport.identity.runtimeVersion,
        },
      });
      return;
    }
    if (request.url === "/report" && info != null) {
      sendJson(response, parseDistributionServeReport({
        endpointUrl: info.endpointUrl,
        healthUrl: info.healthUrl,
        identity: info.identity,
        schemaVersion: info.schemaVersion,
      }));
      return;
    }
    if (request.url === "/runtime/manifest.json" && manifest != null) {
      sendJson(response, manifest);
      return;
    }
    if (request.url === "/runtime/runtime.mjs") {
      response.statusCode = 200;
      response.setHeader(
        "content-type",
        CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.NODE_MODULE_V1,
      );
      response.setHeader("content-length", String(runtimeBytes.byteLength));
      response.end(request.method === "HEAD" ? undefined : runtimeBytes);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await listen(server, options.port ?? 0, host);
  const origin = serverOrigin(server);
  manifest = parseCodexPluginAcquisitionManifest({
    artifact: {
      digest: buildReport.runtimeArtifact.digest,
      entryPath: buildReport.runtimeArtifact.entryPath,
      mediaType: CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.NODE_MODULE_V1,
      size: buildReport.runtimeArtifact.size,
      url: `${origin}/runtime/runtime.mjs`,
    },
    channel: buildReport.identity.channel,
    minShellVersion: buildReport.identity.shellVersion,
    namespace: buildReport.identity.namespace,
    protocolVersion: buildReport.identity.protocolVersion,
    runtimeDigest: buildReport.identity.runtimeDigest,
    runtimeVersion: buildReport.identity.runtimeVersion,
    schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
  });
  info = parseCodexPluginFixtureReport({
    endpointUrl: `${origin}/runtime`,
    healthUrl: `${origin}/health`,
    identity: buildReport.identity,
    runtimeManifestUrl: `${origin}/runtime/manifest.json`,
    schemaVersion: DISTRIBUTION_REPORT_SCHEMA_VERSION,
  });
  return {
    buildReport,
    close: () => close(server),
    info,
    manifest,
  };
}
