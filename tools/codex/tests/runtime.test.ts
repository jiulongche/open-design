import { resolve } from "node:path";

import { CODEX_PLUGIN_ENV } from "@open-design/codex-plugin-proto";
import { describe, expect, it } from "vitest";

import {
  resolveToolCodexRuntimeBinding,
  toolCodexRuntimeEnv,
} from "../src/runtime.js";

describe("tools-codex runtime binding", () => {
  it("requires one explicit channel root and manifest URL pair", () => {
    expect(resolveToolCodexRuntimeBinding({})).toBeNull();
    expect(() => resolveToolCodexRuntimeBinding({
      distributionChannelRoot: "/tmp/open-design/stable",
    })).toThrow("must be provided together");
    expect(() => resolveToolCodexRuntimeBinding({
      distributionChannelRoot: "relative/stable",
      environmentManifestUrl:
        "http://127.0.0.1:17456/codex-plugin/stable/latest/platforms/darwin-arm64.json",
      runtimeManifestUrl: "http://127.0.0.1:17456/runtime/manifest.json",
    })).toThrow("must be absolute");
  });

  it("maps the validated binding onto the stable plugin environment", () => {
    const binding = resolveToolCodexRuntimeBinding({
      distributionChannelRoot: "/tmp/open-design/stable",
      environmentManifestUrl:
        "http://127.0.0.1:17456/codex-plugin/stable/latest/platforms/darwin-arm64.json",
      runtimeManifestUrl: "http://127.0.0.1:17456/runtime/manifest.json",
    });
    expect(binding).toEqual({
      distributionChannelRoot: resolve("/tmp/open-design/stable"),
      environmentManifestUrl:
        "http://127.0.0.1:17456/codex-plugin/stable/latest/platforms/darwin-arm64.json",
      runtimeManifestUrl: "http://127.0.0.1:17456/runtime/manifest.json",
    });
    expect(toolCodexRuntimeEnv(binding)).toEqual({
      [CODEX_PLUGIN_ENV.DISTRIBUTION_CHANNEL_ROOT]:
        resolve("/tmp/open-design/stable"),
      [CODEX_PLUGIN_ENV.ENVIRONMENT_MANIFEST_URL]:
        "http://127.0.0.1:17456/codex-plugin/stable/latest/platforms/darwin-arm64.json",
      [CODEX_PLUGIN_ENV.RUNTIME_MANIFEST_URL]:
        "http://127.0.0.1:17456/runtime/manifest.json",
    });
  });
});
