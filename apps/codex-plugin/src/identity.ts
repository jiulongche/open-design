import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertSameDistributionIdentity,
  normalizeDistributionIdentity,
  parseDistributionServeReport,
  type DistributionIdentityV1,
  type DistributionServeReportV1,
} from "@open-design/distribution-proto";

export const IDENTITY_FILE_ARG = "--identity-file";
export const FIXTURE_REPORT_URL_ARG = "--fixture-report-url";
export const FIXTURE_REPORT_URL_ENV = "OD_CODEX_PLUGIN_FIXTURE_REPORT_URL";

type FixtureObservation =
  | {
      configured: false;
    }
  | {
      configured: true;
      error: string;
      reachable: false;
      url: string;
    }
  | {
      configured: true;
      identityMatches: boolean;
      reachable: true;
      report: DistributionServeReportV1;
      url: string;
    };

export type CodexPluginStatus = {
  fixture: FixtureObservation;
  identity: DistributionIdentityV1;
};

function valueAfterArg(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

export function resolveIdentityFile(args: readonly string[], cwd = process.cwd()): string {
  const value = valueAfterArg(args, IDENTITY_FILE_ARG);
  if (value == null || value.length === 0) {
    throw new Error(`${IDENTITY_FILE_ARG} <path> is required`);
  }
  return resolve(cwd, value);
}

export function resolveFixtureReportUrl(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = valueAfterArg(args, FIXTURE_REPORT_URL_ARG)
    ?? env[FIXTURE_REPORT_URL_ENV]
    ?? null;
  if (value == null || value.trim().length === 0) return null;
  return value.trim();
}

export async function readDistributionIdentity(
  identityFile: string,
): Promise<DistributionIdentityV1> {
  const raw = JSON.parse(await readFile(identityFile, "utf8")) as unknown;
  return normalizeDistributionIdentity(raw);
}

export async function observeFixture(
  identity: DistributionIdentityV1,
  fixtureReportUrl: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<FixtureObservation> {
  if (fixtureReportUrl == null) return { configured: false };

  try {
    const response = await fetchImpl(fixtureReportUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      throw new Error(`fixture report returned HTTP ${response.status}`);
    }
    const report = parseDistributionServeReport(await response.json());
    let identityMatches = true;
    try {
      assertSameDistributionIdentity(identity, report.identity);
    } catch {
      identityMatches = false;
    }
    return {
      configured: true,
      identityMatches,
      reachable: true,
      report,
      url: fixtureReportUrl,
    };
  } catch (error) {
    return {
      configured: true,
      error: error instanceof Error ? error.message : String(error),
      reachable: false,
      url: fixtureReportUrl,
    };
  }
}

export async function readCodexPluginStatus(options: {
  fetchImpl?: typeof fetch;
  fixtureReportUrl: string | null;
  identity: DistributionIdentityV1;
}): Promise<CodexPluginStatus> {
  return {
    fixture: await observeFixture(
      options.identity,
      options.fixtureReportUrl,
      options.fetchImpl,
    ),
    identity: options.identity,
  };
}
