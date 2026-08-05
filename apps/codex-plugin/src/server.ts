import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  OD_MCP_RESOURCE_TEMPLATES,
  OD_MCP_STATIC_RESOURCES,
  OD_MCP_TOOL_DEFS,
  OD_MCP_TOOL_NAMES,
} from "@open-design/contracts/mcp/od-catalog";
import type { DistributionRuntimeBindingV1 } from "@open-design/distribution-proto";
import { randomBytes } from "node:crypto";
import { CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION } from "@open-design/codex-plugin-proto";

import {
  readCodexPluginStatus,
  readDistributionIdentity,
  resolveFixtureReportUrl,
  resolveIdentityFile,
  currentDistributionIdentity,
} from "./identity.js";
import { CodexPluginRuntimeLauncher } from "./launcher.js";
import {
  observeCodexPluginSuite,
  resolveCodexPluginRuntimeManifestUrl,
} from "./suite.js";

export const STATUS_TOOL_NAME = "get_open_design_status";
export const ENSURE_RUNTIME_TOOL_NAME = "ensure_open_design_runtime";
const IDENTITY_RESOURCE_URI = "od://distribution/identity";
const PRODUCT_TOOL_NAMES = new Set(OD_MCP_TOOL_NAMES);
const MCP_SESSION_ID = `session_${randomBytes(18).toString("base64url")}`;

type RuntimeMcpMessage = {
  method: "resources/read" | "tools/call";
  params: Record<string, unknown>;
};

type RuntimeMcpSession = {
  host: { name: string; version?: string };
  plugin: {
    distributionMechanism: "unknown";
    id: "open-design";
    publisherClass: "open_design_first_party";
    version: string;
  };
};

function runtimeMcpUrl(binding: DistributionRuntimeBindingV1): string {
  const url = new URL(binding.endpointUrl);
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  return url.href;
}

async function proxyRuntimeMcp<Result>(
  binding: DistributionRuntimeBindingV1,
  message: RuntimeMcpMessage,
  accessToken: string | null,
  session: RuntimeMcpSession,
): Promise<Result> {
  const url = runtimeMcpUrl(binding);
  if (binding.protocolVersion >= 2 && accessToken == null) {
    throw new Error("protocol-v2 Open Design runtime access token is missing");
  }
  const response = await fetch(url, {
    body: JSON.stringify(binding.protocolVersion >= 2
      ? {
          ...message,
          protocolVersion: binding.protocolVersion,
          schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
          session: {
            ...session,
            id: MCP_SESSION_ID,
          },
        }
      : message),
    headers: {
      accept: "application/json",
      ...(accessToken == null
        ? {}
        : { authorization: `Bearer ${accessToken}` }),
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json().catch(() => null) as
    | { error?: unknown }
    | null;
  if (!response.ok) {
    const detail = typeof payload?.error === "string"
      ? payload.error
      : `HTTP ${response.status}`;
    throw new Error(`Open Design runtime MCP gateway failed: ${detail}`);
  }
  return payload as Result;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const identityFile = resolveIdentityFile(args);
  const identity = await readDistributionIdentity(identityFile);
  const fixtureReportUrl = resolveFixtureReportUrl(args);
  const suite = observeCodexPluginSuite({ args, identity });
  const runtimeManifestUrl = resolveCodexPluginRuntimeManifestUrl(args)
    ?? `https://releases.open-design.ai/codex-plugin/${identity.channel}/latest/runtime.json`;
  const runtimeLauncher = suite.configured && runtimeManifestUrl != null
    ? new CodexPluginRuntimeLauncher({
        identity,
        manifestUrl: runtimeManifestUrl,
        shellVersion: identity.shellVersion,
        suitePaths: suite.paths,
      })
    : null;

  const runtimeSession = (): RuntimeMcpSession => {
    const client = server.getClientVersion();
    return {
      host: {
        name: typeof client?.name === "string" && client.name.length > 0
          ? client.name
          : "codex_unknown",
        ...(typeof client?.version === "string" && client.version.length > 0
          ? { version: client.version }
          : {}),
      },
      plugin: {
        distributionMechanism: "unknown",
        id: "open-design",
        publisherClass: "open_design_first_party",
        version: identity.shellVersion,
      },
    };
  };

  const server = new Server(
    {
      name: "open-design",
      version: identity.shellVersion,
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
      instructions:
        "Open Design tools are declared by this shell and lazily acquire or attach the exact local runtime on first product tool or product resource read. Prefer get_artifact for a complete design bundle; use create_project then start_run and poll get_run for generation.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: true,
        },
        description:
          "Report the Open Design distribution, Codex shell, and optional local fixture identity.",
        inputSchema: {
          additionalProperties: false,
          properties: {},
          type: "object",
        },
        name: STATUS_TOOL_NAME,
        title: "Get Open Design status",
      },
      {
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: false,
        },
        description:
          "Acquire or attach the exact Open Design runtime for this channel and namespace, then complete a fail-closed local handoff.",
        inputSchema: {
          additionalProperties: false,
          properties: {},
          type: "object",
        },
        name: ENSURE_RUNTIME_TOOL_NAME,
        title: "Ensure Open Design runtime",
      },
      ...OD_MCP_TOOL_DEFS,
    ],
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        description: "The immutable distribution identity embedded by tools-pack.",
        mimeType: "application/json",
        name: "Open Design distribution identity",
        uri: IDENTITY_RESOURCE_URI,
      },
      ...OD_MCP_STATIC_RESOURCES,
    ],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: OD_MCP_RESOURCE_TEMPLATES,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === IDENTITY_RESOURCE_URI) {
      return {
        contents: [
          {
            mimeType: "application/json",
            text: JSON.stringify(identity, null, 2),
            uri: IDENTITY_RESOURCE_URI,
          },
        ],
      };
    }
    if (runtimeLauncher == null) {
      throw new Error(
        "Open Design runtime handoff requires both a configured distribution channel root and runtime manifest URL",
      );
    }
    const result = await runtimeLauncher.ensureRuntime();
    const accessToken = await runtimeLauncher.readRuntimeAccessToken(result.binding);
    return await proxyRuntimeMcp<ReadResourceResult>(result.binding, {
      method: "resources/read",
      params: { uri: request.params.uri },
    }, accessToken, runtimeSession());
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === ENSURE_RUNTIME_TOOL_NAME) {
      if (runtimeLauncher == null) {
        throw new Error(
          "Open Design runtime handoff requires both a configured distribution channel root and runtime manifest URL",
        );
      }
      const result = await runtimeLauncher.ensureRuntime();
      const structuredContent = {
        ...result,
        identity: currentDistributionIdentity(identity, result.binding),
      };
      return {
        content: [
          {
            text: JSON.stringify(structuredContent, null, 2),
            type: "text",
          },
        ],
        structuredContent,
      };
    }
    if (request.params.name === STATUS_TOOL_NAME) {
      const status = await readCodexPluginStatus({
        fixtureReportUrl,
        identity,
        suite,
        updateCheck: await runtimeLauncher?.readUpdateStatus() ?? null,
      });
      return {
        content: [
          {
            text: JSON.stringify(status, null, 2),
            type: "text",
          },
        ],
        structuredContent: status,
      };
    }
    if (!PRODUCT_TOOL_NAMES.has(request.params.name)) {
      throw new Error(`unsupported tool: ${request.params.name}`);
    }
    if (runtimeLauncher == null) {
      throw new Error(
        "Open Design runtime handoff requires both a configured distribution channel root and runtime manifest URL",
      );
    }
    const result = await runtimeLauncher.ensureRuntime();
    const accessToken = await runtimeLauncher.readRuntimeAccessToken(result.binding);
    return await proxyRuntimeMcp<CallToolResult>(result.binding, {
      method: "tools/call",
      params: {
        arguments: request.params.arguments ?? {},
        name: request.params.name,
      },
    }, accessToken, runtimeSession());
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolveClose) => {
    const onClose = transport.onclose;
    transport.onclose = () => {
      onClose?.();
      resolveClose();
    };
  });
}

run().catch((error) => {
  process.stderr.write(
    `open-design codex plugin failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
