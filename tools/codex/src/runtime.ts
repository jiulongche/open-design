import { isAbsolute, resolve } from "node:path";

import { CODEX_PLUGIN_ENV } from "@open-design/codex-plugin-proto";

import { ToolCodexError } from "./state.js";

export type ToolCodexRuntimeBinding = {
  distributionChannelRoot: string;
  runtimeManifestUrl: string;
};

function normalizeRuntimeManifestUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ToolCodexError(
      "RUNTIME_MANIFEST_URL_INVALID",
      "--runtime-manifest-url must be a valid URL",
    );
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username.length > 0
    || url.password.length > 0
    || url.hash.length > 0
  ) {
    throw new ToolCodexError(
      "RUNTIME_MANIFEST_URL_INVALID",
      "--runtime-manifest-url must use HTTPS or loopback HTTP without credentials or a fragment",
    );
  }
  return url.toString();
}

export function resolveToolCodexRuntimeBinding(options: {
  distributionChannelRoot?: string;
  runtimeManifestUrl?: string;
}): ToolCodexRuntimeBinding | null {
  const hasChannelRoot = options.distributionChannelRoot != null
    && options.distributionChannelRoot.length > 0;
  const hasManifestUrl = options.runtimeManifestUrl != null
    && options.runtimeManifestUrl.length > 0;
  if (hasChannelRoot !== hasManifestUrl) {
    throw new ToolCodexError(
      "RUNTIME_BINDING_INCOMPLETE",
      "--distribution-channel-root and --runtime-manifest-url must be provided together",
    );
  }
  if (!hasChannelRoot || !hasManifestUrl) return null;
  const channelRoot = options.distributionChannelRoot!;
  if (!isAbsolute(channelRoot)) {
    throw new ToolCodexError(
      "DISTRIBUTION_CHANNEL_ROOT_INVALID",
      "--distribution-channel-root must be absolute",
    );
  }
  return {
    distributionChannelRoot: resolve(channelRoot),
    runtimeManifestUrl: normalizeRuntimeManifestUrl(options.runtimeManifestUrl!),
  };
}

export function toolCodexRuntimeEnv(
  binding: ToolCodexRuntimeBinding | null | undefined,
): NodeJS.ProcessEnv {
  if (binding == null) return {};
  return {
    [CODEX_PLUGIN_ENV.DISTRIBUTION_CHANNEL_ROOT]:
      binding.distributionChannelRoot,
    [CODEX_PLUGIN_ENV.RUNTIME_MANIFEST_URL]: binding.runtimeManifestUrl,
  };
}
