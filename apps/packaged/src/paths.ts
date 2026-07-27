import { join } from "node:path";

import {
  DISTRIBUTION_SUITE_PATH_ERROR_CODES,
  DistributionSuitePathError,
  resolveDistributionSuitePaths,
  type DistributionSuitePaths,
} from "@open-design/distribution-proto";
import {
  releaseChannelFromNamespace,
  releaseChannelFromVersion,
  type ReleaseChannel,
} from "@open-design/release";
import { APP_KEYS, normalizeNamespace } from "@open-design/sidecar-proto";

import type { PackagedConfig } from "./config.js";
import { PackagedPathAccessError } from "./errors.js";

export type PackagedNamespacePaths = Omit<DistributionSuitePaths, "updatesRoot"> & {
  desktopIdentityPath: string;
  desktopLogPath: string;
  desktopLogsRoot: string;
  electronSessionDataRoot: string;
  electronUserDataRoot: string;
  headlessIdentityPath: string;
  /**
   * Channel-root directory — one level above the `namespaces/` parent. The
   * daemon writes `installation.json` here so installationId survives any
   * reset of the namespace-scoped data subtree (namespace churn between
   * packaged versions, future per-namespace data wipes, etc.). See
   * `apps/daemon/src/installation.ts`.
   */
  installationRoot: string;
  installerObservationRoot: string;
  resourceRoot: string;
  updateRoot: string;
  webIdentityPath: string;
};

export function resolvePackagedDistributionChannel(
  config: Pick<PackagedConfig, "appVersion" | "namespace">,
): ReleaseChannel {
  return releaseChannelFromVersion(config.appVersion)
    ?? releaseChannelFromNamespace(config.namespace, "default")
    ?? "stable";
}

function wrapPackagedSuitePathError(error: unknown): never {
  if (!(error instanceof DistributionSuitePathError)) throw error;
  if (error.code === DISTRIBUTION_SUITE_PATH_ERROR_CODES.DATA_ROOT_NOT_ABSOLUTE) {
    throw new PackagedPathAccessError(
      [
        "Open Design's packaged runtime requires OD_DATA_DIR to be an absolute path.",
        "",
        `Configured value: ${error.configuredValue}`,
        "",
        "Set OD_DATA_DIR to an absolute path (for example, C:\\\\Users\\\\You\\\\OpenDesign on Windows or /Users/you/OpenDesign on macOS/Linux) and relaunch Open Design.",
      ].join("\n"),
      { title: "Open Design cannot start with this OD_DATA_DIR" },
    );
  }
  throw new PackagedPathAccessError(
    [
      "Open Design's packaged runtime requires OD_DATA_DIR to target the active namespace.",
      "",
      `Configured value: ${error.configuredValue}`,
      `Configured namespace: ${error.configuredNamespace ?? "unknown"}`,
      `Active namespace: ${error.activeNamespace ?? "unknown"}`,
      "",
      "Use an unscoped absolute base path or relaunch the matching packaged namespace.",
    ].join("\n"),
    { title: "Open Design cannot start with this OD_DATA_DIR" },
  );
}

export function resolvePackagedNamespacePaths(
  config: PackagedConfig,
  namespace = config.namespace,
  env: NodeJS.ProcessEnv = {},
): PackagedNamespacePaths {
  const normalizedNamespace = normalizeNamespace(namespace);
  let suitePaths: DistributionSuitePaths;
  try {
    suitePaths = resolveDistributionSuitePaths({
      channel: resolvePackagedDistributionChannel({
        appVersion: config.appVersion,
        namespace: normalizedNamespace,
      }),
      dataDir: env.OD_DATA_DIR,
      namespace: normalizedNamespace,
      namespaceBaseRoot: config.namespaceBaseRoot,
      platform: process.platform,
    });
  } catch (error) {
    wrapPackagedSuitePathError(error);
  }

  return {
    cacheRoot: suitePaths.cacheRoot,
    channel: suitePaths.channel,
    channelRoot: suitePaths.channelRoot,
    dataRoot: suitePaths.dataRoot,
    desktopIdentityPath: join(suitePaths.runtimeRoot, "desktop-root.json"),
    desktopLogPath: join(suitePaths.logsRoot, APP_KEYS.DESKTOP, "latest.log"),
    desktopLogsRoot: join(suitePaths.logsRoot, APP_KEYS.DESKTOP),
    electronSessionDataRoot: join(suitePaths.namespaceRoot, "user-data", "session"),
    electronUserDataRoot: join(suitePaths.namespaceRoot, "user-data"),
    headlessIdentityPath: join(suitePaths.runtimeRoot, "headless-root.json"),
    installationRoot: suitePaths.channelRoot,
    installerObservationRoot: join(suitePaths.dataRoot, "observations", "installer"),
    logsRoot: suitePaths.logsRoot,
    namespace: suitePaths.namespace,
    namespaceBaseRoot: suitePaths.namespaceBaseRoot,
    namespaceRoot: suitePaths.namespaceRoot,
    resourceRoot: config.resourceRoot,
    runtimeRoot: suitePaths.runtimeRoot,
    updateRoot: suitePaths.updatesRoot,
    webIdentityPath: join(suitePaths.runtimeRoot, "web-root.json"),
  };
}
