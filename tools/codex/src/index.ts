import { resolve } from "node:path";

import { cac } from "cac";

import {
  TOOLS_CODEX_CLEAN_LAYERS,
  cleanToolCodexEnvironment,
  type ToolCodexCleanLayer,
} from "./clean.js";
import {
  inspectToolCodexEnvironment,
  startToolCodexDesktop,
  stopToolCodexDesktop,
} from "./host.js";
import {
  prepareToolCodexPlugin,
  recordToolCodexDesktopUiObservation,
  runToolCodexAcceptance,
  verifyAndRecordToolCodexRuntimeHandoff,
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
  workspace?: string;
};

type StopOptions = CommonOptions & {
  force?: boolean;
};

type AcceptOptions = PrepareOptions & {
  desktopUiObservation?: string;
  out?: string;
};

type RecordUiOptions = PrepareOptions & {
  operator?: string;
  outcome?: string;
  out?: string;
  screenshot?: string;
  tool?: string;
};

type HandoffOptions = CommonOptions & {
  buildReport?: string;
  distributionChannelRoot?: string;
  fixtureReportUrl?: string;
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
        desktopUserDataPath: paths.desktopUserDataPath,
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

common(cli.command("start", "Start one controlled Codex Desktop instance"))
  .option("--workspace <path>", "Workspace to open; defaults to the managed workspace")
  .action(async (options: StartOptions) => {
    printResult(await startToolCodexDesktop({
      appPath: options.appPath,
      codexBin: options.codexBin,
      paths: pathsFor(options),
      workspace: options.workspace,
    }), options);
  });

common(cli.command("stop", "Stop only the Codex Desktop processes owned by this environment"))
  .option("--force", "Escalate remaining stamped processes after graceful stop")
  .action(async (options: StopOptions) => {
    printResult(await stopToolCodexDesktop({
      force: options.force,
      paths: pathsFor(options),
    }), options);
  });

common(cli.command("record-ui", "Record operator-confirmed Desktop screenshot evidence"))
  .option("--build-report <path>", "Codex plugin build report from tools-pack")
  .option("--screenshot <path>", "PNG screenshot showing the Desktop prompt and completed tool result")
  .option("--tool <name>", "Observed Open Design tool name")
  .option("--operator <name>", "Operator who confirmed the screenshot")
  .option("--outcome <PASS|FAIL>", "Operator-observed result", { default: "PASS" })
  .option("--out <path>", "Desktop UI observation path under the managed reports directory")
  .action(async (options: RecordUiOptions) => {
    if (options.screenshot == null || options.screenshot.length === 0) {
      throw new ToolCodexError("SCREENSHOT_REQUIRED", "--screenshot is required");
    }
    if (options.operator == null || options.operator.length === 0) {
      throw new ToolCodexError("OPERATOR_REQUIRED", "--operator is required");
    }
    if (
      options.tool !== "get_open_design_status"
      && options.tool !== "ensure_open_design_runtime"
    ) {
      throw new ToolCodexError(
        "DESKTOP_UI_TOOL_INVALID",
        "--tool must be get_open_design_status or ensure_open_design_runtime",
      );
    }
    if (options.outcome !== "PASS" && options.outcome !== "FAIL") {
      throw new ToolCodexError(
        "DESKTOP_UI_OUTCOME_INVALID",
        "--outcome must be PASS or FAIL",
      );
    }
    printResult(await recordToolCodexDesktopUiObservation({
      appPath: options.appPath,
      buildReportPath: requireBuildReport(options),
      codexBin: options.codexBin,
      operator: options.operator,
      outcome: options.outcome,
      outputPath: options.out == null ? undefined : resolve(options.out),
      paths: pathsFor(options),
      screenshotPath: options.screenshot,
      tool: options.tool,
    }), options);
  });

common(cli.command("accept", "Combine artifact checks with operator-captured Desktop screenshot evidence"))
  .option("--build-report <path>", "Codex plugin build report from tools-pack")
  .option("--desktop-ui-observation <path>", "Operator-captured Desktop UI evidence; required for PASS")
  .option("--out <path>", "Acceptance report path under the managed reports directory")
  .action(async (options: AcceptOptions) => {
    const report = await runToolCodexAcceptance({
      appPath: options.appPath,
      buildReportPath: requireBuildReport(options),
      codexBin: options.codexBin,
      desktopUiObservationPath: options.desktopUiObservation,
      outputPath: options.out,
      paths: pathsFor(options),
    });
    printResult(report, options);
    if (report.status === "FAIL") process.exitCode = 1;
  });

runtimeOptions(common(cli.command("handoff", "Verify and bind exact runtime handoff")))
  .option("--build-report <path>", "Codex plugin build report from tools-pack")
  .option("--fixture-report-url <url>", "Optional identity-bound fixture report URL")
  .action(async (options: HandoffOptions) => {
    const runtimeBinding = resolveToolCodexRuntimeBinding(options);
    if (runtimeBinding == null) {
      throw new ToolCodexError(
        "RUNTIME_BINDING_REQUIRED",
        "handoff requires --distribution-channel-root and --runtime-manifest-url",
      );
    }
    printResult(await verifyAndRecordToolCodexRuntimeHandoff({
      buildReportPath: requireBuildReport(options),
      fixtureReportUrl: options.fixtureReportUrl,
      paths: pathsFor(options),
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
