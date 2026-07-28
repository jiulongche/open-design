import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseDistributionBuildReport } from "@open-design/distribution-proto";
import { describe, expect, it } from "vitest";

import {
  codexMarketplaceName,
  packCodexPlugin,
} from "../src/codex-plugin.js";

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-design-codex-plugin-pack-"));
  const appRoot = join(root, "apps", "codex-plugin");
  const pluginRoot = join(appRoot, "plugin", "open-design");
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "skills", "status"), { recursive: true });
  await mkdir(join(appRoot, "dist", "mcp"), { recursive: true });
  await writeFile(join(appRoot, "package.json"), JSON.stringify({
    version: "0.1.0",
  }));
  await writeFile(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
    description: "fixture",
    name: "open-design",
    version: "0.0.0",
  }));
  await writeFile(join(pluginRoot, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "open-design": {
        env_vars: [
          "OD_CODEX_PLUGIN_RUNTIME_MANIFEST_URL",
          "OD_DATA_DIR",
          "OD_DISTRIBUTION_CHANNEL_ROOT",
        ],
      },
    },
  }));
  await writeFile(join(pluginRoot, "skills", "status", "SKILL.md"), "# Status\n");
  await writeFile(join(appRoot, "dist", "mcp", "server.mjs"), "export {};\n");
  return root;
}

describe("tools-pack codex-plugin", () => {
  it("derives valid, distinct marketplace names from dotted namespaces", () => {
    expect(codexMarketplaceName("team.preview")).toMatch(
      /^open-design-team-preview-[0-9a-f]{8}$/,
    );
    expect(codexMarketplaceName("team.preview")).not.toBe(
      codexMarketplaceName("team-preview"),
    );
  });

  it("builds a relocatable local marketplace and exact report", async () => {
    const workspaceRoot = await createWorkspace();
    const report = await packCodexPlugin({
      channel: "beta",
      dir: join(workspaceRoot, "tool-root"),
      namespace: "smoke",
      protocolVersion: 2,
      runtimeVersion: "2.0.0-beta.1",
      shellVersion: "0.2.0",
      skipAppBuild: true,
      workspaceRoot,
    });

    expect(parseDistributionBuildReport(report)).toEqual(report);
    expect(report.identity).toMatchObject({
      channel: "beta",
      namespace: "smoke",
      protocolVersion: 2,
      runtimeVersion: "2.0.0-beta.1",
      shellType: "codex-plugin",
      shellVersion: "0.2.0",
    });
    expect(report.artifact.files).toEqual([...report.artifact.files].sort());
    expect(report.artifact.files).toContain("mcp/server.mjs");
    expect(report.artifact.files).not.toContain("distribution.json");
    expect((await stat(join(report.paths.shellRoot, "distribution.json"))).isFile()).toBe(true);
    expect(report.runtimeArtifact).toMatchObject({
      digest: report.identity.runtimeDigest,
      entryPath: "runtime.mjs",
    });
    expect((await stat(report.runtimeArtifact!.path)).mode & 0o100).toBe(0o100);

    const manifest = JSON.parse(await readFile(report.paths.manifestPath, "utf8")) as {
      version?: string;
    };
    expect(manifest.version).toBe("0.2.0");
    const mcpConfig = JSON.parse(await readFile(
      join(report.paths.shellRoot, ".mcp.json"),
      "utf8",
    )) as {
      mcpServers?: {
        "open-design"?: { env_vars?: string[] };
      };
    };
    expect(mcpConfig.mcpServers?.["open-design"]?.env_vars).toEqual([
      "OD_CODEX_PLUGIN_RUNTIME_MANIFEST_URL",
      "OD_DATA_DIR",
      "OD_DISTRIBUTION_CHANNEL_ROOT",
    ]);

    const marketplace = JSON.parse(await readFile(
      join(report.paths.artifactRoot, ".agents", "plugins", "marketplace.json"),
      "utf8",
    )) as {
      plugins?: Array<{
        policy?: { authentication?: string; installation?: string };
        source?: { path?: string; source?: string };
      }>;
    };
    expect(marketplace.plugins?.[0]?.policy).toEqual({
      authentication: "ON_USE",
      installation: "AVAILABLE",
    });
    expect(marketplace.plugins?.[0]?.source).toEqual({
      path: "./plugins/open-design",
      source: "local",
    });

    const persisted = JSON.parse(await readFile(
      join(dirname(report.paths.artifactRoot), "build-report.json"),
      "utf8",
    )) as unknown;
    expect(parseDistributionBuildReport(persisted)).toEqual(report);
  });

  it("rejects a runtime version that does not match the explicit channel", async () => {
    const workspaceRoot = await createWorkspace();
    await expect(packCodexPlugin({
      channel: "beta",
      runtimeVersion: "2.0.0",
      skipAppBuild: true,
      workspaceRoot,
    })).rejects.toThrow();
  });

  it("produces a stable digest for the same shell inputs", async () => {
    const workspaceRoot = await createWorkspace();
    const options = {
      channel: "stable",
      dir: join(workspaceRoot, "tool-root"),
      namespace: "deterministic",
      runtimeVersion: "2.0.0",
      skipAppBuild: true,
      workspaceRoot,
    } as const;
    const first = await packCodexPlugin(options);
    const second = await packCodexPlugin(options);
    expect(second.artifact).toEqual(first.artifact);
    expect(second.identity).toEqual(first.identity);
  });
});
