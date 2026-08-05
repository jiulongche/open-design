import { homedir } from "node:os";
import { join, win32 } from "node:path";

import {
  normalizeDistributionAbsolutePath,
  resolveDistributionSuitePaths,
  type DistributionIdentityV1,
  type DistributionSuitePaths,
} from "@open-design/distribution-proto";
import {
  CODEX_PLUGIN_ARGS,
  CODEX_PLUGIN_ENV,
  resolveCodexPluginSuitePaths,
} from "@open-design/codex-plugin-proto";
import {
  isReleaseChannel,
  releaseInstallIdentity,
} from "@open-design/release";

export type CodexPluginSuiteObservation =
  | {
      configured: false;
    }
  | {
      configured: true;
      paths: DistributionSuitePaths;
    };

function valueAfterArg(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

export function resolveCodexPluginDistributionChannelRoot(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  defaults: {
    channel?: unknown;
    homeDir?: string;
    platform?: NodeJS.Platform;
  } = {},
): string | null {
  const value = valueAfterArg(args, CODEX_PLUGIN_ARGS.DISTRIBUTION_CHANNEL_ROOT)
    ?? env[CODEX_PLUGIN_ENV.DISTRIBUTION_CHANNEL_ROOT]
    ?? null;
  if (value != null && value.trim().length > 0) {
    return normalizeDistributionAbsolutePath(
      value.trim(),
      "distribution channel root",
    );
  }
  if (!isReleaseChannel(defaults.channel)) return null;
  const productName = releaseInstallIdentity(defaults.channel).productName;
  const platform = defaults.platform ?? process.platform;
  const home = defaults.homeDir ?? homedir();
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", productName);
  }
  if (platform === "win32") {
    const roamingRoot = env.APPDATA?.trim() || win32.join(
      home,
      "AppData",
      "Roaming",
    );
    return win32.join(roamingRoot, productName);
  }
  return null;
}

export function resolveCodexPluginRuntimeManifestUrl(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env[CODEX_PLUGIN_ENV.RUNTIME_MANIFEST_URL]
    ?? valueAfterArg(args, CODEX_PLUGIN_ARGS.RUNTIME_MANIFEST_URL)
    ?? null;
  if (value == null || value.trim().length === 0) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Codex plugin runtime manifest URL must be valid");
  }
  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
    throw new Error(
      "Codex plugin runtime manifest URL must not contain credentials or a fragment",
    );
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "Codex plugin runtime manifest URL must use https or loopback http",
    );
  }
  return url.toString();
}

export function observeCodexPluginSuite(options: {
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  identity: DistributionIdentityV1;
  platform?: NodeJS.Platform;
}): CodexPluginSuiteObservation {
  const args = options.args ?? [];
  const env = options.env ?? process.env;
  const channelRoot = resolveCodexPluginDistributionChannelRoot(args, env, {
    channel: options.identity.channel,
    platform: options.platform,
  });
  if (channelRoot == null) return { configured: false };
  return {
    configured: true,
    paths: resolveCodexPluginSuitePaths(
      resolveDistributionSuitePaths({
        channel: options.identity.channel,
        dataDir: env.OD_DATA_DIR,
        namespace: options.identity.namespace,
        namespaceBaseRoot: join(channelRoot, "namespaces"),
        platform: options.platform ?? process.platform,
      }),
    ),
  };
}
