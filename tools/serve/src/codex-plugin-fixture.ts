import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

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
  info: DistributionServeReportV1;
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
  let info: DistributionServeReportV1 | null = null;
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
      sendJson(response, info);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await listen(server, options.port ?? 0, host);
  const origin = serverOrigin(server);
  info = parseDistributionServeReport({
    endpointUrl: `${origin}/runtime`,
    healthUrl: `${origin}/health`,
    identity: buildReport.identity,
    schemaVersion: DISTRIBUTION_REPORT_SCHEMA_VERSION,
  });
  return {
    buildReport,
    close: () => close(server),
    info,
  };
}
