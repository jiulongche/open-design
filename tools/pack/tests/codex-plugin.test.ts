import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CODEX_PLUGIN_PLATFORM_TARGETS,
  type CodexPluginPlatformTarget,
} from "@open-design/codex-plugin-proto";
import { parseDistributionBuildReport } from "@open-design/distribution-proto";
import { afterEach, describe, expect, it } from "vitest";

import {
  codexProductionRuntimeSource,
  codexMarketplaceName,
  packCodexPlugin,
} from "../src/codex-plugin.js";

const roots: string[] = [];
const platformIt = (
  (process.platform === "win32" && process.arch === "x64")
  || (process.platform === "darwin" && process.arch === "arm64")
) ? it : it.skip;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

function currentTarget(): CodexPluginPlatformTarget {
  if (process.platform === "win32" && process.arch === "x64") {
    return CODEX_PLUGIN_PLATFORM_TARGETS.WIN32_X64;
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return CODEX_PLUGIN_PLATFORM_TARGETS.DARWIN_ARM64;
  }
  throw new Error(`unsupported Codex plugin test host: ${process.platform}-${process.arch}`);
}

function carrierEntry(target: CodexPluginPlatformTarget): string {
  return target === CODEX_PLUGIN_PLATFORM_TARGETS.WIN32_X64
    ? "bin/node.exe"
    : "bin/node";
}

function otherTarget(target: CodexPluginPlatformTarget): CodexPluginPlatformTarget {
  return target === CODEX_PLUGIN_PLATFORM_TARGETS.WIN32_X64
    ? CODEX_PLUGIN_PLATFORM_TARGETS.DARWIN_ARM64
    : CODEX_PLUGIN_PLATFORM_TARGETS.WIN32_X64;
}

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-design-codex-plugin-pack-"));
  roots.push(root);
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
        args: ["./mcp/server.mjs", "--identity-file", "./distribution.json"],
        command: "./bin/node",
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
    expect(codexMarketplaceName(
      "team.preview",
      CODEX_PLUGIN_PLATFORM_TARGETS.WIN32_X64,
    )).toMatch(
      /^open-design-team-preview-win32-x64-[0-9a-f]{8}$/,
    );
    expect(codexMarketplaceName(
      "team.preview",
      CODEX_PLUGIN_PLATFORM_TARGETS.WIN32_X64,
    )).not.toBe(
      codexMarketplaceName(
        "team-preview",
        CODEX_PLUGIN_PLATFORM_TARGETS.WIN32_X64,
      ),
    );
  });

  platformIt("builds a relocatable local marketplace and exact report", async () => {
    const workspaceRoot = await createWorkspace();
    const target = currentTarget();
    const report = await packCodexPlugin({
      carrierPath: process.execPath,
      channel: "beta",
      dir: join(workspaceRoot, "tool-root"),
      namespace: "smoke",
      platform: target,
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
    expect(report.artifact.files).toContain(carrierEntry(target));
    expect(report.artifact.files).not.toContain("bootstrap.sh");
    expect(report.artifact.files).not.toContain("distribution.json");
    expect((await stat(join(report.paths.shellRoot, "distribution.json"))).isFile()).toBe(true);
    expect(report.runtimeArtifact).toMatchObject({
      digest: report.identity.runtimeDigest,
      entryPath: "runtime.mjs",
    });
    const runtimeArtifactStat = await stat(report.runtimeArtifact!.path);
    expect(runtimeArtifactStat.isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(runtimeArtifactStat.mode & 0o100).toBe(0o100);
    }
    expect((await stat(
      join(report.paths.shellRoot, ...carrierEntry(target).split("/")),
    )).isFile()).toBe(true);
    expect(report.paths.artifactRoot).toContain(target);

    const manifest = JSON.parse(await readFile(report.paths.manifestPath, "utf8")) as {
      version?: string;
    };
    expect(manifest.version).toBe("0.2.0");
    const mcpConfig = JSON.parse(await readFile(
      join(report.paths.shellRoot, ".mcp.json"),
      "utf8",
    )) as {
      mcpServers?: {
        "open-design"?: {
          args?: string[];
          command?: string;
          env_vars?: string[];
          startup_timeout_sec?: number;
          tool_timeout_sec?: number;
        };
      };
    };
    expect(mcpConfig.mcpServers?.["open-design"]?.command).toBe(
      `./${carrierEntry(target)}`,
    );
    expect(mcpConfig.mcpServers?.["open-design"]?.args).toEqual([
      "./mcp/server.mjs",
      "--identity-file",
      "./distribution.json",
      "--runtime-manifest-url",
      `https://releases.open-design.ai/codex-plugin/beta/smoke/${target}/latest/runtime.json`,
    ]);
    expect(mcpConfig.mcpServers?.["open-design"]?.env_vars).toEqual([
      "OD_CODEX_PLUGIN_RUNTIME_MANIFEST_URL",
      "OD_DATA_DIR",
      "OD_DISTRIBUTION_CHANNEL_ROOT",
    ]);
    expect(mcpConfig.mcpServers?.["open-design"]?.startup_timeout_sec).toBe(10);
    expect(mcpConfig.mcpServers?.["open-design"]?.tool_timeout_sec).toBe(120);

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

  platformIt("rejects cross-building a platform carrier on the wrong host", async () => {
    const workspaceRoot = await createWorkspace();
    const target = otherTarget(currentTarget());
    await expect(packCodexPlugin({
      carrierPath: process.execPath,
      channel: "stable",
      platform: target,
      runtimeVersion: "2.0.0",
      skipAppBuild: true,
      workspaceRoot,
    })).rejects.toThrow(
      `Codex plugin ${target} artifacts must be built on a ${target} host`,
    );
  });

  platformIt("produces a stable digest for the same shell inputs", async () => {
    const workspaceRoot = await createWorkspace();
    const target = currentTarget();
    const options = {
      carrierPath: process.execPath,
      channel: "stable",
      dir: join(workspaceRoot, "tool-root"),
      namespace: "deterministic",
      platform: target,
      runtimeVersion: "2.0.0",
      skipAppBuild: true,
      workspaceRoot,
    } as const;
    const first = await packCodexPlugin(options);
    const second = await packCodexPlugin(options);
    expect(second.artifact).toEqual(first.artifact);
    expect(second.identity).toEqual(first.identity);
  });

  platformIt("binds the external runtime fixture bytes to the runtime version", async () => {
    const workspaceRoot = await createWorkspace();
    const target = currentTarget();
    const options = {
      carrierPath: process.execPath,
      channel: "stable",
      dir: join(workspaceRoot, "tool-root"),
      namespace: "runtime-version-bound",
      platform: target,
      runtimeVersion: "2.0.0",
      skipAppBuild: true,
      workspaceRoot,
    } as const;
    const first = await packCodexPlugin(options);
    const second = await packCodexPlugin({
      ...options,
      runtimeVersion: "2.0.1",
    });

    expect(second.identity.runtimeDigest).not.toBe(
      first.identity.runtimeDigest,
    );
    expect(second.identity.shellDigest).toBe(first.identity.shellDigest);
  });

  it("renders a production runtime entry that starts the real daemon", () => {
    const source = codexProductionRuntimeSource();
    expect(source).toContain("@open-design\", \"daemon\", \"dist\", \"cli.js");
    expect(source).toContain("\"daemon\",");
    expect(source).toContain("\"start\",");
    expect(source).toContain("\"--headless\",");
    expect(source).toContain("OD_RESOURCE_ROOT");
    expect(source).toContain("/api/ready");
    expect(source).toContain("@open-design\", \"daemon\", \"dist\", \"mcp.js");
    expect(source).toContain('requestUrl.pathname !== "/mcp"');
    expect(source).toContain('message.method === "tools/call"');
    expect(source).toContain('message.method === "resources/read"');
    expect(source).not.toContain("packedRuntimeVersion");
  });
});
