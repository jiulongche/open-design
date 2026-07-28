import { resolve } from "node:path";

import { cac } from "cac";

import {
  TOOLS_CODEX_CLEAN_LAYERS,
  cleanToolCodexEnvironment,
  type ToolCodexCleanLayer,
} from "./clean.js";
import {
  captureToolCodexDesktopHostLoad,
} from "./desktop-evidence.js";
import {
  inspectToolCodexEnvironment,
  startToolCodexDesktop,
  stopToolCodexDesktop,
} from "./host.js";
import {
  runToolCodexAutomatedInvocation,
} from "./invocation.js";
import {
  prepareToolCodexPlugin,
  runToolCodexHandoffProbe,
  runToolCodexAcceptance,
} from "./plugin.js";
import { resolveToolCodexRuntimeBinding } from "./runtime.js";
import {
  ToolCodexError,
  initializeToolCodexEnvironment,
  resolveToolCodexPaths,
} from "./state.js";

type CommonOptions = {
  appPath?: string;
  codexBin?: string;
  json?: boolean;
  namespace?: string;
  stateRoot?: string;
};

type PrepareOptions = CommonOptions & {
  buildReport?: string;
};

type StartOptions = CommonOptions & {
  buildReport?: string;
  distributionChannelRoot?: string;
  environmentManifestUrl?: string;
  hostLoadTimeoutMs?: string;
  runtimeManifestUrl?: string;
  workspace?: string;
};

type StopOptions = CommonOptions & {
  force?: boolean;
};

type AcceptOptions = PrepareOptions & {
  automatedInvocationReport?: string;
  desktopHostLoadReport?: string;
  desktopUiObservation?: string;
  distributionChannelRoot?: string;
  environmentManifestUrl?: string;
  fixtureReportUrl?: string;
  out?: string;
  runtimeManifestUrl?: string;
};

type CaptureHostLoadOptions = PrepareOptions & {
  out?: string;
  timeoutMs?: string;
};

type InvokeOptions = PrepareOptions & {
  distributionChannelRoot?: string;
  environmentManifestUrl?: string;
  maxAttempts?: string;
  out?: string;
  runtimeManifestUrl?: string;
  timeoutMs?: string;
};

type HandoffOptions = {
  buildReport?: string;
  distributionChannelRoot?: string;
  environmentManifestUrl?: string;
  fixtureReportUrl?: string;
  json?: boolean;
  runtimeManifestUrl?: string;
};

type CleanOptions = CommonOptions & {
  confirmHome?: string;
  layer?: string;
};

function requireNamespace(options: CommonOptions): string {
  if (options.namespace == null || options.namespace.length === 0) {
    throw new ToolCodexError("NAMESPACE_REQUIRED", "--namespace is required");
  }
  return options.namespace;
}

function requireBuildReport(options: PrepareOptions): string {
  if (options.buildReport == null || options.buildReport.length === 0) {
    throw new ToolCodexError("BUILD_REPORT_REQUIRED", "--build-report is required");
  }
  return resolve(options.buildReport);
}

function pathsFor(options: CommonOptions) {
  return resolveToolCodexPaths({
    namespace: requireNamespace(options),
    stateRoot: options.stateRoot,
  });
}

function integerOption(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ToolCodexError("OPTION_INVALID", `${name} must be an integer`);
  }
  return parsed;
}

function printResult(value: unknown, options: CommonOptions): void {
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (value != null && typeof value === "object" && "state" in value) {
    const state = (value as { state?: unknown }).state;
    const reason = (value as { reasonCode?: unknown }).reasonCode;
    process.stdout.write(
      `tools-codex: ${String(state)}${reason == null ? "" : ` (${String(reason)})`}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printError(error: unknown): never {
  if (error instanceof ToolCodexError) {
    process.stderr.write(`${JSON.stringify({
      code: error.code,
      message: error.message,
      ...(error.details == null ? {} : { details: error.details }),
    }, null, 2)}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(1);
}

const cli = cac("tools-codex");

function runtimeOptions(command: ReturnType<typeof cli.command>) {
  return command
    .option(
      "--distribution-channel-root <path>",
      "Absolute shared OD distribution channel root",
    )
    .option(
      "--environment-manifest-url <url>",
      "Codex plugin managed Node environment manifest URL",
    )
    .option(
      "--runtime-manifest-url <url>",
      "Codex plugin runtime acquisition manifest URL",
    );
}

process.on("uncaughtException", printError);
process.on("unhandledRejection", printError);

function common(command: ReturnType<typeof cli.command>) {
  return command
    .option("--namespace <namespace>", "Stable tools-codex environment namespace")
    .option("--state-root <path>", "Override the tools-codex state root")
    .option("--codex-bin <path>", "Override the Codex CLI executable", { default: "codex" })
    .option("--app-path <path>", "Override the Codex.app bundle path")
    .option("--json", "Print machine-readable JSON");
}

common(cli.command("init", "Initialize a persistent managed Codex acceptance environment"))
  .action(async (options: CommonOptions) => {
    const paths = pathsFor(options);
    const result = await initializeToolCodexEnvironment(paths);
    printResult({
      created: result.created,
      namespace: paths.namespace,
      paths: {
        codexHome: paths.codexHome,
        namespaceRoot: paths.namespaceRoot,
        stateRoot: paths.root,
      },
      sentinel: result.sentinel,
    }, options);
  });

common(cli.command("status", "Inspect managed state and fail-closed Codex Desktop ownership"))
  .action(async (options: CommonOptions) => {
    printResult(await inspectToolCodexEnvironment({
      appPath: options.appPath,
      codexBin: options.codexBin,
      paths: pathsFor(options),
    }), options);
  });

common(cli.command("prepare", "Reconcile a packed Open Design plugin into the managed Codex home"))
  .option("--build-report <path>", "Codex plugin build report from tools-pack")
  .action(async (options: PrepareOptions) => {
    printResult(await prepareToolCodexPlugin({
      appPath: options.appPath,
      buildReportPath: requireBuildReport(options),
      codexBin: options.codexBin,
      paths: pathsFor(options),
    }), options);
  });

runtimeOptions(common(cli.command("start", "Start one controlled Codex Desktop instance")))
  .option("--build-report <path>", "Capture Desktop host-load provenance for this build")
  .option("--host-load-timeout-ms <ms>", "Host-load capture timeout", { default: "60000" })
  .option("--workspace <path>", "Workspace to open; defaults to the managed workspace")
  .action(async (options: StartOptions) => {
    const paths = pathsFor(options);
    const started = await startToolCodexDesktop({
      appPath: options.appPath,
      codexBin: options.codexBin,
      paths,
      runtimeBinding: resolveToolCodexRuntimeBinding(options),
      workspace: options.workspace,
    });
    if (options.buildReport == null) {
      printResult(started, options);
      return;
    }
    const hostLoad = await captureToolCodexDesktopHostLoad({
      appPath: options.appPath,
      buildReportPath: requireBuildReport(options),
      codexBin: options.codexBin,
      paths,
      timeoutMs: integerOption(options.hostLoadTimeoutMs, "--host-load-timeout-ms"),
    });
    printResult({ ...started, hostLoad }, options);
    if (hostLoad.status === "FAIL") process.exitCode = 1;
  });

common(cli.command("stop", "Stop only the Codex Desktop processes owned by this environment"))
  .option("--force", "Escalate remaining stamped processes after graceful stop")
  .action(async (options: StopOptions) => {
    printResult(await stopToolCodexDesktop({
      force: options.force,
      paths: pathsFor(options),
    }), options);
  });

common(cli.command("capture-host-load", "Capture Desktop -> app-server -> plugin MCP provenance"))
  .option("--build-report <path>", "Codex plugin build report from tools-pack")
  .option("--timeout-ms <ms>", "Maximum time to observe the plugin MCP", { default: "60000" })
  .option("--out <path>", "Host-load report path under the managed reports directory")
  .action(async (options: CaptureHostLoadOptions) => {
    const report = await captureToolCodexDesktopHostLoad({
      appPath: options.appPath,
      buildReportPath: requireBuildReport(options),
      codexBin: options.codexBin,
      outputPath: options.out == null ? undefined : resolve(options.out),
      paths: pathsFor(options),
      timeoutMs: integerOption(options.timeoutMs, "--timeout-ms"),
    });
    printResult(report, options);
    if (report.status === "FAIL") process.exitCode = 1;
  });

runtimeOptions(common(cli.command("invoke", "Invoke the prepared plugin through same-home Codex exec JSONL")))
  .option("--build-report <path>", "Codex plugin build report from tools-pack")
  .option("--max-attempts <count>", "Retry only transient incomplete turns", { default: "2" })
  .option("--timeout-ms <ms>", "Per-attempt Codex exec timeout", { default: "120000" })
  .option("--out <path>", "Invocation report path under the managed reports directory")
  .action(async (options: InvokeOptions) => {
    const report = await runToolCodexAutomatedInvocation({
      appPath: options.appPath,
      buildReportPath: requireBuildReport(options),
      codexBin: options.codexBin,
      maxAttempts: integerOption(options.maxAttempts, "--max-attempts"),
      outputPath: options.out == null ? undefined : resolve(options.out),
      paths: pathsFor(options),
      runtimeBinding: resolveToolCodexRuntimeBinding(options),
      timeoutMs: integerOption(options.timeoutMs, "--timeout-ms"),
    });
    printResult(report, options);
    if (report.status === "FAIL") process.exitCode = 1;
  });

runtimeOptions(common(cli.command("accept", "Combine artifact, Desktop host-load, and automated invocation evidence")))
  .option("--build-report <path>", "Codex plugin build report from tools-pack")
  .option("--desktop-host-load-report <path>", "Override Desktop host-load evidence path")
  .option("--automated-invocation-report <path>", "Override automated invocation evidence path")
  .option("--desktop-ui-observation <path>", "Optional operator-captured Desktop UI evidence envelope")
  .option("--fixture-report-url <url>", "Identity-bound tools-serve fixture report URL")
  .option("--out <path>", "Acceptance report path under the managed reports directory")
  .action(async (options: AcceptOptions) => {
    const report = await runToolCodexAcceptance({
      appPath: options.appPath,
      automatedInvocationReportPath: options.automatedInvocationReport,
      buildReportPath: requireBuildReport(options),
      codexBin: options.codexBin,
      desktopHostLoadReportPath: options.desktopHostLoadReport,
      desktopUiObservationPath: options.desktopUiObservation,
      fixtureReportUrl: options.fixtureReportUrl,
      outputPath: options.out,
      paths: pathsFor(options),
      runtimeBinding: resolveToolCodexRuntimeBinding(options),
    });
    printResult(report, options);
    if (report.status === "FAIL") process.exitCode = 1;
  });

runtimeOptions(cli.command("handoff", "Probe static MCP bootstrap and exact runtime handoff"))
  .option("--build-report <path>", "Codex plugin build report from tools-pack")
  .option("--fixture-report-url <url>", "Optional identity-bound fixture report URL")
  .option("--json", "Print machine-readable JSON")
  .action(async (options: HandoffOptions) => {
    const runtimeBinding = resolveToolCodexRuntimeBinding(options);
    if (runtimeBinding == null) {
      throw new ToolCodexError(
        "RUNTIME_BINDING_REQUIRED",
        "handoff requires --distribution-channel-root and --runtime-manifest-url",
      );
    }
    printResult(await runToolCodexHandoffProbe({
      buildReportPath: requireBuildReport(options),
      fixtureReportUrl: options.fixtureReportUrl,
      runtimeBinding,
    }), options);
  });

common(cli.command("clean", "Clean one explicit layer of a managed Codex environment"))
  .option(
    "--layer <layer>",
    `Required layer: ${TOOLS_CODEX_CLEAN_LAYERS.join("|")}`,
  )
  .option("--confirm-home <path>", "Exact namespace root required for --layer home")
  .action(async (options: CleanOptions) => {
    if (!TOOLS_CODEX_CLEAN_LAYERS.includes(options.layer as ToolCodexCleanLayer)) {
      throw new ToolCodexError(
        "CLEAN_LAYER_REQUIRED",
        `--layer must be one of ${TOOLS_CODEX_CLEAN_LAYERS.join(", ")}`,
      );
    }
    printResult(await cleanToolCodexEnvironment({
      appPath: options.appPath,
      codexBin: options.codexBin,
      confirmHome: options.confirmHome,
      layer: options.layer as ToolCodexCleanLayer,
      paths: pathsFor(options),
    }), options);
  });

cli.help();
cli.parse();
