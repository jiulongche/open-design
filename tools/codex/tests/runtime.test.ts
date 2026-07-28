import { resolve } from "node:path";

import { CODEX_PLUGIN_ENV } from "@open-design/codex-plugin-proto";
import { describe, expect, it } from "vitest";

import {
  resolveToolCodexRuntimeBinding,
  runtimeBindingFromPreparedState,
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
      runtimeManifestUrl: "http://127.0.0.1:17456/runtime/manifest.json",
    })).toThrow("must be absolute");
  });

  it("maps the validated binding onto the stable plugin environment", () => {
    const binding = resolveToolCodexRuntimeBinding({
      distributionChannelRoot: "/tmp/open-design/stable",
      runtimeManifestUrl: "http://127.0.0.1:17456/runtime/manifest.json",
    });
    expect(binding).toEqual({
      distributionChannelRoot: resolve("/tmp/open-design/stable"),
      runtimeManifestUrl: "http://127.0.0.1:17456/runtime/manifest.json",
    });
    expect(toolCodexRuntimeEnv(binding)).toEqual({
      [CODEX_PLUGIN_ENV.DISTRIBUTION_CHANNEL_ROOT]:
        resolve("/tmp/open-design/stable"),
      [CODEX_PLUGIN_ENV.RUNTIME_MANIFEST_URL]:
        "http://127.0.0.1:17456/runtime/manifest.json",
    });
  });

  it("loads only the runtime binding verified for the prepared plugin", () => {
    expect(runtimeBindingFromPreparedState(undefined)).toBeNull();
    expect(runtimeBindingFromPreparedState({
      artifactRoot: "/tmp/open-design/artifact",
      identityKey: "identity",
      marketplaceName: "open-design-smoke",
      preparedAt: "2026-07-28T00:00:00.000Z",
      runtime: {
        buildReportPath: "/tmp/open-design/artifact/build-report.json",
        distributionChannelRoot: "/tmp/open-design/stable",
        fixtureReportUrl: "http://127.0.0.1:17456/report",
        identityKey: "identity",
        runtimeManifestUrl:
          "http://127.0.0.1:17456/runtime/manifest.json",
        verifiedAt: "2026-07-28T00:01:00.000Z",
      },
    })).toEqual({
      distributionChannelRoot: resolve("/tmp/open-design/stable"),
      runtimeManifestUrl:
        "http://127.0.0.1:17456/runtime/manifest.json",
    });
    expect(() => runtimeBindingFromPreparedState({
      artifactRoot: "/tmp/open-design/artifact",
      identityKey: "identity",
      marketplaceName: "open-design-smoke",
      preparedAt: "2026-07-28T00:00:00.000Z",
      runtime: {
        buildReportPath: "/tmp/open-design/artifact/build-report.json",
        distributionChannelRoot: "/tmp/open-design/stable",
        fixtureReportUrl: null,
        identityKey: "different",
        runtimeManifestUrl:
          "http://127.0.0.1:17456/runtime/manifest.json",
        verifiedAt: "2026-07-28T00:01:00.000Z",
      },
    })).toThrowError(expect.objectContaining({
      code: "RUNTIME_BINDING_IDENTITY_MISMATCH",
    }));
  });
});
