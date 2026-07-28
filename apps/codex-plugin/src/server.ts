import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

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
    ],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== IDENTITY_RESOURCE_URI) {
      throw new Error(`unsupported resource URI: ${request.params.uri}`);
    }
    return {
      contents: [
        {
          mimeType: "application/json",
          text: JSON.stringify(identity, null, 2),
          uri: IDENTITY_RESOURCE_URI,
        },
      ],
    };
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
    if (request.params.name !== STATUS_TOOL_NAME) {
      throw new Error(`unsupported tool: ${request.params.name}`);
    }
    const status = await readCodexPluginStatus({
      fixtureReportUrl,
      identity,
      suite,
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
