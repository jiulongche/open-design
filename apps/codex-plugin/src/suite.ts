import { join } from "node:path";

import {
  normalizeDistributionAbsolutePath,
  resolveDistributionSuitePaths,
  type DistributionIdentityV1,
  type DistributionSuitePaths,
} from "@open-design/distribution-proto";

export const DISTRIBUTION_CHANNEL_ROOT_ARG = "--distribution-channel-root";
export const DISTRIBUTION_CHANNEL_ROOT_ENV = "OD_DISTRIBUTION_CHANNEL_ROOT";

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
): string | null {
  const value = valueAfterArg(args, DISTRIBUTION_CHANNEL_ROOT_ARG)
    ?? env[DISTRIBUTION_CHANNEL_ROOT_ENV]
    ?? null;
  if (value == null || value.trim().length === 0) return null;
  return normalizeDistributionAbsolutePath(
    value.trim(),
    "distribution channel root",
  );
}

export function observeCodexPluginSuite(options: {
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  identity: DistributionIdentityV1;
  platform?: NodeJS.Platform;
}): CodexPluginSuiteObservation {
  const args = options.args ?? [];
  const env = options.env ?? process.env;
  const channelRoot = resolveCodexPluginDistributionChannelRoot(args, env);
  if (channelRoot == null) return { configured: false };
  return {
    configured: true,
    paths: resolveDistributionSuitePaths({
      channel: options.identity.channel,
      dataDir: env.OD_DATA_DIR,
      namespace: options.identity.namespace,
      namespaceBaseRoot: join(channelRoot, "namespaces"),
      platform: options.platform ?? process.platform,
    }),
  };
}
