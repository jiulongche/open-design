import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const BUILT_SERVER = join(TEST_ROOT, "..", "dist", "mcp", "server.mjs");

const IDENTITY = {
  channel: "beta",
  namespace: "relocated",
  protocolVersion: 1,
  runtimeDigest: `sha256:${"a".repeat(64)}`,
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

    const transport = new StdioClientTransport({
      args: [
        "./mcp/server.mjs",
        "--identity-file",
        "./distribution.json",
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
      ]);
      const result = await client.callTool({
        arguments: {},
        name: "get_open_design_status",
      });
      expect(result.structuredContent).toEqual({
        fixture: { configured: false },
        identity: IDENTITY,
      });
      const resource = await client.readResource({
        uri: "od://distribution/identity",
      });
      expect(resource.contents).toHaveLength(1);
      expect(JSON.parse(
        "text" in resource.contents[0]! ? resource.contents[0]!.text : "",
      )).toEqual(IDENTITY);
    } finally {
      await client.close();
    }
  });
});
