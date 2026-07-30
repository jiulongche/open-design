import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
  CODEX_PLUGIN_RUNTIME_ENV,
  CODEX_PLUGIN_RUNTIME_MEDIA_TYPES,
} from "@open-design/codex-plugin-proto";
import {
  OD_MCP_RESOURCE_TEMPLATES,
  OD_MCP_TOOL_NAMES,
} from "@open-design/contracts/mcp/od-catalog";
import { describe, expect, it } from "vitest";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const BUILT_SERVER = join(TEST_ROOT, "..", "dist", "mcp", "server.mjs");

const RUNTIME_SOURCE = `
import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
const identity = {
  channel: process.env.${CODEX_PLUGIN_RUNTIME_ENV.CHANNEL},
  namespace: process.env.${CODEX_PLUGIN_RUNTIME_ENV.NAMESPACE},
  protocolVersion: Number(process.env.${CODEX_PLUGIN_RUNTIME_ENV.PROTOCOL_VERSION}),
  runtimeDigest: process.env.${CODEX_PLUGIN_RUNTIME_ENV.RUNTIME_DIGEST},
  runtimeVersion: process.env.${CODEX_PLUGIN_RUNTIME_ENV.RUNTIME_VERSION},
};
const shellPid = process.ppid;
const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.method === "GET" && request.url === "/status") {
    response.end(JSON.stringify(identity));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    request.method === "POST"
    && request.url === "/mcp"
    && message.method === "tools/call"
    && message.params?.name === "list_projects"
  ) {
    response.end(JSON.stringify({
      content: [{
        type: "text",
        text: JSON.stringify({ projects: [{ id: "shared-project", name: "Shared project" }] }, null, 2),
      }],
    }));
    return;
  }
  response.statusCode = 400;
  response.end(JSON.stringify({ error: "unexpected request" }));
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const readyPath = process.env.${CODEX_PLUGIN_RUNTIME_ENV.READY_PATH};
  const temporaryPath = readyPath + "." + process.pid + ".tmp";
  const ready = {
    endpointUrl: "http://127.0.0.1:" + address.port + "/status",
    handoffId: process.env.${CODEX_PLUGIN_RUNTIME_ENV.HANDOFF_ID},
    pid: process.pid,
    resumeTokenDigest: "sha256:" + createHash("sha256")
      .update(process.env.${CODEX_PLUGIN_RUNTIME_ENV.HANDOFF_TOKEN})
      .digest("hex"),
    schemaVersion: ${CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION},
  };
  void writeFile(temporaryPath, JSON.stringify(ready), { mode: 0o600 })
    .then(() => rename(temporaryPath, readyPath));
});
setInterval(() => {
  try {
    process.kill(shellPid, 0);
  } catch {
    server.close(() => process.exit(0));
  }
}, 50);
`;
const RUNTIME_BYTES = Buffer.from(RUNTIME_SOURCE);
const RUNTIME_DIGEST =
  `sha256:${createHash("sha256").update(RUNTIME_BYTES).digest("hex")}`;

const IDENTITY = {
  channel: "beta",
  namespace: "relocated",
  protocolVersion: 1,
  runtimeDigest: RUNTIME_DIGEST,
  runtimeVersion: "0.16.1-beta.1",
  shellDigest: `sha256:${"b".repeat(64)}`,
  shellType: "codex-plugin",
  shellVersion: "0.1.0",
} as const;

describe("Codex plugin stdio MCP", () => {
  it("initializes, lists, and calls the status tool after relocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-codex-plugin-relocated-"));
    await mkdir(join(root, "mcp"), { recursive: true });
    await cp(BUILT_SERVER, join(root, "mcp", "server.mjs"));
    await writeFile(join(root, "distribution.json"), JSON.stringify(IDENTITY));
    const channelRoot = join(root, "suite", "beta");
    const manifestServer = createServer((request, response) => {
      if (request.url === "/runtime.mjs") {
        response.setHeader(
          "content-type",
          CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.NODE_MODULE_V1,
        );
        response.end(RUNTIME_BYTES);
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        artifact: {
          digest: RUNTIME_DIGEST,
          entryPath: "runtime.mjs",
          mediaType: CODEX_PLUGIN_RUNTIME_MEDIA_TYPES.NODE_MODULE_V1,
          size: RUNTIME_BYTES.byteLength,
          url: `http://127.0.0.1:${
            (manifestServer.address() as { port: number }).port
          }/runtime.mjs`,
        },
        channel: IDENTITY.channel,
        control: {
          codexPlugin: {
            version: { min: IDENTITY.shellVersion },
          },
        },
        namespace: IDENTITY.namespace,
        protocolVersion: IDENTITY.protocolVersion,
        runtimeDigest: RUNTIME_DIGEST,
        runtimeVersion: IDENTITY.runtimeVersion,
        schemaVersion: CODEX_PLUGIN_PROTOCOL_SCHEMA_VERSION,
      }));
    });
    await new Promise<void>((resolve, reject) => {
      manifestServer.once("error", reject);
      manifestServer.listen(0, "127.0.0.1", () => resolve());
    });
    const manifestAddress = manifestServer.address() as { port: number };

    const transport = new StdioClientTransport({
      args: [
        "./mcp/server.mjs",
        "--identity-file",
        "./distribution.json",
        "--distribution-channel-root",
        channelRoot,
        "--runtime-manifest-url",
        `http://127.0.0.1:${manifestAddress.port}/manifest.json`,
      ],
      command: process.execPath,
      cwd: root,
      stderr: "pipe",
    });
    const client = new Client({
      name: "open-design-codex-plugin-test",
      version: "0.1.0",
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "get_open_design_status",
        "ensure_open_design_runtime",
        ...OD_MCP_TOOL_NAMES,
      ]);
      const result = await client.callTool({
        arguments: {},
        name: "get_open_design_status",
      });
      expect(result.structuredContent).toEqual({
        fixture: { configured: false },
        identity: IDENTITY,
        suite: {
          configured: true,
          paths: {
            cacheRoot: join(
              channelRoot,
              "namespaces",
              IDENTITY.namespace,
              "codex-plugin",
              "cache",
            ),
            channel: IDENTITY.channel,
            channelRoot,
            dataRoot: join(channelRoot, "namespaces", IDENTITY.namespace, "data"),
            logsRoot: join(
              channelRoot,
              "namespaces",
              IDENTITY.namespace,
              "codex-plugin",
              "logs",
            ),
            namespace: IDENTITY.namespace,
            namespaceBaseRoot: join(channelRoot, "namespaces"),
            namespaceRoot: join(channelRoot, "namespaces", IDENTITY.namespace),
            runtimeRoot: join(
              channelRoot,
              "namespaces",
              IDENTITY.namespace,
              "codex-plugin",
              "runtime",
            ),
            updatesRoot: join(
              channelRoot,
              "namespaces",
              IDENTITY.namespace,
              "codex-plugin",
              "updates",
            ),
          },
        },
        updateCheck: null,
      });
      const resource = await client.readResource({
        uri: "od://distribution/identity",
      });
      expect(await client.listResourceTemplates()).toEqual({
        resourceTemplates: OD_MCP_RESOURCE_TEMPLATES,
      });
      expect(resource.contents).toHaveLength(1);
      expect(JSON.parse(
        "text" in resource.contents[0]! ? resource.contents[0]!.text : "",
      )).toEqual(IDENTITY);
      const productResult = await client.callTool({
        arguments: {},
        name: "list_projects",
      });
      const productContent = productResult.content as Array<
        { text?: string; type?: string }
      >;
      expect(JSON.parse(
        productContent[0]?.type === "text"
          ? productContent[0].text ?? ""
          : "",
      )).toEqual({
        projects: [{ id: "shared-project", name: "Shared project" }],
      });
    } finally {
      await client.close();
      const bindingPath = join(
        channelRoot,
        "namespaces",
        IDENTITY.namespace,
        "codex-plugin",
        "runtime",
        "binding.json",
      );
      const binding = JSON.parse(
        await readFile(bindingPath, "utf8").catch(() => "{}"),
      ) as { owner?: { pid?: number } };
      if (typeof binding.owner?.pid === "number") {
        try {
          process.kill(binding.owner.pid, "SIGTERM");
        } catch {
          // Runtime already stopped with its parent.
        }
      }
      await new Promise<void>((resolve) => manifestServer.close(() => resolve()));
    }
  });
});
