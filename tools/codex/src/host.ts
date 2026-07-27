import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  isProcessAlive,
  listProcessSnapshotsStrict,
  processCommandExactlyRunsExecutable,
  stopProcesses,
  waitForProcessExit,
  type ProcessSnapshot,
  type StopProcessesResult,
} from "@open-design/platform";

import {
  TOOLS_CODEX_OWNER,
  TOOLS_CODEX_SCHEMA_VERSION,
  ToolCodexError,
  acquireToolCodexGlobalLock,
  readToolCodexGlobalLock,
  readToolCodexRunMarker,
  readToolCodexSentinel,
  removeToolCodexRunMarker,
  writeToolCodexRunMarker,
  type ToolCodexPaths,
  type ToolCodexRunMarkerV1,
} from "./state.js";

export const TOOLS_CODEX_RUN_ID_ENV = "OD_TOOLS_CODEX_RUN_ID";
export const TOOLS_CODEX_HOME_DIGEST_ENV = "OD_TOOLS_CODEX_HOME_DIGEST";
const CODEX_DESKTOP_ROOT_SUFFIX = "/Codex.app/Contents/MacOS/ChatGPT";

export type CommandResult = {
  code: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

export type ToolCodexDesktopRoot = ProcessSnapshot & {
  executablePath: string;
};

export type ToolCodexStatusState =
  | "uninitialized"
  | "ready"
  | "running-controlled"
  | "running-unmanaged"
  | "blocked"
  | "unknown";

export type ToolCodexStatus = {
  cli: {
    available: boolean;
    loggedIn: boolean | null;
    loginStatus: string | null;
    version: string | null;
  };
  desktop: {
    appPath: string | null;
    available: boolean;
    controlled: boolean;
    roots: Array<{ command: string; pid: number; ppid: number }>;
    version: string | null;
  };
  lock: Awaited<ReturnType<typeof readToolCodexGlobalLock>>;
  marker: ToolCodexRunMarkerV1 | null;
  namespace: string;
  paths: {
    codexHome: string;
    namespaceRoot: string;
    stateRoot: string;
  };
  reasonCode: string | null;
  state: ToolCodexStatusState;
};

export type ToolCodexStartResult = {
  created: true;
  marker: ToolCodexRunMarkerV1;
};

export type ToolCodexStopResult = {
  forced: boolean;
  matchedPids: number[];
  remainingPids: number[];
  state: "not-running" | "stopped" | "partial";
  stoppedPids: number[];
};

export function codexHomeDigest(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex");
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  return await new Promise((resolveRun) => {
    const child = execFile(command, [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeoutMs,
    }, (error, stdout, stderr) => {
      const processError = error as Omit<NodeJS.ErrnoException, "code"> & {
        code?: unknown;
        killed?: boolean;
        signal?: NodeJS.Signals;
      } | null;
      const code = error == null
        ? 0
        : typeof processError?.code === "number"
          ? Number(processError.code)
          : 1;
      resolveRun({
        code,
        stderr: String(stderr ?? "").trim(),
        stdout: String(stdout ?? "").trim(),
        timedOut: processError?.killed === true && processError.signal != null,
      });
    });
    child.stdin?.end();
  });
}

export function findCodexDesktopRoots(processes: readonly ProcessSnapshot[]): ToolCodexDesktopRoot[] {
  return processes.flatMap((processInfo) => {
    const command = processInfo.command.trim();
    if (!command.endsWith(CODEX_DESKTOP_ROOT_SUFFIX)) return [];
    if (command.slice(0, -CODEX_DESKTOP_ROOT_SUFFIX.length).includes(" ")) return [];
    return [{
      ...processInfo,
      executablePath: command,
    }];
  });
}

export function assertStopRootOwnership(
  roots: readonly ToolCodexDesktopRoot[],
  marker: ToolCodexRunMarkerV1,
): ToolCodexDesktopRoot | null {
  if (roots.length > 1) {
    throw new ToolCodexError(
      "MULTIPLE_DESKTOP_ROOTS",
      "multiple Codex Desktop root processes are present",
      { roots },
    );
  }
  const root = roots[0] ?? null;
  if (root != null && root.pid !== marker.rootPid) {
    throw new ToolCodexError(
      "UNMANAGED_DESKTOP_INSTANCE",
      "a Codex Desktop root is running but does not match the tools-codex marker",
      { markerRootPid: marker.rootPid, roots },
    );
  }
  return root;
}

export function readEnvironmentValue(output: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`(?:^|\\s)${escapedName}=([^\\s]+)`));
  return match?.[1] ?? null;
}

export async function readProcessEnvironmentValue(pid: number, name: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const result = await runCommand("ps", ["eww", "-p", String(pid), "-o", "command="]);
  if (result.code !== 0) return null;
  return readEnvironmentValue(result.stdout, name);
}

export async function readProcessStartedAt(pid: number): Promise<string | null> {
  if (process.platform === "win32") return null;
  const result = await runCommand("ps", ["-p", String(pid), "-o", "lstart="]);
  return result.code === 0 && result.stdout.length > 0 ? result.stdout : null;
}

export async function readProcessCwd(pid: number): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const result = await runCommand("lsof", [
    "-a",
    "-p",
    String(pid),
    "-d",
    "cwd",
    "-Fn",
  ]);
  if (result.code !== 0) return null;
  const cwd = result.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("n"));
  return cwd == null || cwd.length < 2 ? null : cwd.slice(1);
}

export async function listProcessIdsWithEnvironmentValue(options: {
  commandMatches: (command: string) => boolean;
  name: string;
  value: string;
}): Promise<number[]> {
  if (process.platform !== "darwin") return [];
  const processes = await listProcessSnapshotsStrict();
  const matches: number[] = [];
  for (const processInfo of processes) {
    if (!options.commandMatches(processInfo.command)) continue;
    if (await readProcessEnvironmentValue(processInfo.pid, options.name) === options.value) {
      matches.push(processInfo.pid);
    }
  }
  return matches.sort((left, right) => right - left);
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

export async function resolveCodexDesktopApp(
  appPathOverride?: string,
): Promise<{ appPath: string; executablePath: string } | null> {
  const candidates = appPathOverride == null
    ? [
        "/Applications/Codex.app",
        join(homedir(), "Applications", "Codex.app"),
      ]
    : [resolve(appPathOverride)];
  for (const appPath of candidates) {
    const executablePath = join(appPath, "Contents", "MacOS", "ChatGPT");
    if (await pathExists(executablePath)) return { appPath, executablePath };
  }
  return null;
}

async function readDesktopVersion(appPath: string | null): Promise<string | null> {
  if (appPath == null || process.platform !== "darwin") return null;
  const result = await runCommand("defaults", [
    "read",
    join(appPath, "Contents", "Info.plist"),
    "CFBundleShortVersionString",
  ]);
  return result.code === 0 && result.stdout.length > 0 ? result.stdout : null;
}

function codexEnv(paths: ToolCodexPaths, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    CODEX_HOME: paths.codexHome,
  };
}

async function isControlledRoot(
  root: ToolCodexDesktopRoot,
  marker: ToolCodexRunMarkerV1,
): Promise<boolean> {
  if (root.pid !== marker.rootPid
    || root.executablePath !== marker.executablePath
    || !processCommandExactlyRunsExecutable(root.command, marker.executablePath)) {
    return false;
  }
  const [runId, homeDigest, startedAt] = await Promise.all([
    readProcessEnvironmentValue(root.pid, TOOLS_CODEX_RUN_ID_ENV),
    readProcessEnvironmentValue(root.pid, TOOLS_CODEX_HOME_DIGEST_ENV),
    readProcessStartedAt(root.pid),
  ]);
  return runId === marker.runId
    && homeDigest === codexHomeDigest(marker.codexHome)
    && startedAt === marker.rootStartedAt;
}

async function codexCliStatus(
  paths: ToolCodexPaths,
  codexBin: string,
): Promise<ToolCodexStatus["cli"]> {
  const version = await runCommand(codexBin, ["--version"], {
    env: codexEnv(paths),
  });
  if (version.code !== 0) {
    return {
      available: false,
      loggedIn: null,
      loginStatus: null,
      version: null,
    };
  }
  const login = await runCommand(codexBin, ["login", "status"], {
    env: codexEnv(paths),
  });
  return {
    available: true,
    loggedIn: login.code === 0,
    loginStatus: login.stdout || login.stderr || null,
    version: version.stdout || null,
  };
}

export async function inspectToolCodexEnvironment(options: {
  appPath?: string;
  codexBin?: string;
  paths: ToolCodexPaths;
}): Promise<ToolCodexStatus> {
  const codexBin = options.codexBin ?? "codex";
  const application = await resolveCodexDesktopApp(options.appPath);
  const base = {
    namespace: options.paths.namespace,
    paths: {
      codexHome: options.paths.codexHome,
      namespaceRoot: options.paths.namespaceRoot,
      stateRoot: options.paths.root,
    },
  };
  let sentinelExists = true;
  try {
    await readToolCodexSentinel(options.paths);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") sentinelExists = false;
    else if (error instanceof ToolCodexError) {
      return {
        ...base,
        cli: { available: false, loggedIn: null, loginStatus: null, version: null },
        desktop: {
          appPath: application?.appPath ?? null,
          available: application != null,
          controlled: false,
          roots: [],
          version: await readDesktopVersion(application?.appPath ?? null),
        },
        lock: null,
        marker: null,
        reasonCode: error.code,
        state: "unknown",
      };
    } else throw error;
  }
  if (!sentinelExists) {
    return {
      ...base,
      cli: { available: false, loggedIn: null, loginStatus: null, version: null },
      desktop: {
        appPath: application?.appPath ?? null,
        available: application != null,
        controlled: false,
        roots: [],
        version: await readDesktopVersion(application?.appPath ?? null),
      },
      lock: null,
      marker: null,
      reasonCode: "NOT_INITIALIZED",
      state: "uninitialized",
    };
  }

  const [cli, desktopVersion] = await Promise.all([
    codexCliStatus(options.paths, codexBin),
    readDesktopVersion(application?.appPath ?? null),
  ]);
  let lock: ToolCodexStatus["lock"];
  try {
    lock = await readToolCodexGlobalLock(options.paths);
  } catch (error) {
    return {
      ...base,
      cli,
      desktop: {
        appPath: application?.appPath ?? null,
        available: application != null,
        controlled: false,
        roots: [],
        version: desktopVersion,
      },
      lock: null,
      marker: null,
      reasonCode: error instanceof ToolCodexError ? error.code : "GLOBAL_LOCK_INVALID",
      state: "unknown",
    };
  }
  let processes: ProcessSnapshot[];
  try {
    processes = await listProcessSnapshotsStrict();
  } catch {
    return {
      ...base,
      cli,
      desktop: {
        appPath: application?.appPath ?? null,
        available: application != null,
        controlled: false,
        roots: [],
        version: desktopVersion,
      },
      lock,
      marker: null,
      reasonCode: "PROCESS_ENUMERATION_FAILED",
      state: "unknown",
    };
  }
  const roots = findCodexDesktopRoots(processes);
  let marker: ToolCodexRunMarkerV1 | null;
  try {
    marker = await readToolCodexRunMarker(options.paths);
  } catch (error) {
    return {
      ...base,
      cli,
      desktop: {
        appPath: application?.appPath ?? null,
        available: application != null,
        controlled: false,
        roots,
        version: desktopVersion,
      },
      lock,
      marker: null,
      reasonCode: error instanceof ToolCodexError ? error.code : "RUN_MARKER_INVALID",
      state: "unknown",
    };
  }
  if (roots.length > 1) {
    return {
      ...base,
      cli,
      desktop: {
        appPath: application?.appPath ?? null,
        available: application != null,
        controlled: false,
        roots,
        version: desktopVersion,
      },
      lock,
      marker,
      reasonCode: "MULTIPLE_DESKTOP_ROOTS",
      state: "blocked",
    };
  }
  if (roots.length === 0) {
    return {
      ...base,
      cli,
      desktop: {
        appPath: application?.appPath ?? null,
        available: application != null,
        controlled: false,
        roots: [],
        version: desktopVersion,
      },
      lock,
      marker,
      reasonCode: marker == null ? null : "STALE_RUN_MARKER",
      state: "ready",
    };
  }
  const controlled = marker != null && await isControlledRoot(roots[0], marker);
  return {
    ...base,
    cli,
    desktop: {
      appPath: application?.appPath ?? null,
      available: application != null,
      controlled,
      roots,
      version: desktopVersion,
    },
    lock,
    marker,
    reasonCode: controlled ? null : "UNMANAGED_DESKTOP_INSTANCE",
    state: controlled ? "running-controlled" : "running-unmanaged",
  };
}

async function waitForControlledRoot(
  paths: ToolCodexPaths,
  runId: string,
  timeoutMs = 30_000,
): Promise<ToolCodexDesktopRoot> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const roots = findCodexDesktopRoots(await listProcessSnapshotsStrict());
    if (roots.length > 1) {
      throw new ToolCodexError("MULTIPLE_DESKTOP_ROOTS", "multiple Codex Desktop root processes appeared during launch");
    }
    if (roots.length === 1) {
      const [actualRunId, actualHomeDigest] = await Promise.all([
        readProcessEnvironmentValue(roots[0].pid, TOOLS_CODEX_RUN_ID_ENV),
        readProcessEnvironmentValue(roots[0].pid, TOOLS_CODEX_HOME_DIGEST_ENV),
      ]);
      if (actualRunId === runId && actualHomeDigest === codexHomeDigest(paths.codexHome)) {
        return roots[0];
      }
      if (actualRunId != null || actualHomeDigest != null) {
        throw new ToolCodexError("CONTROL_IDENTITY_MISMATCH", "Codex Desktop launch identity does not match this tools-codex run");
      }
    }
    await sleep(250);
  }
  throw new ToolCodexError("DESKTOP_START_TIMEOUT", "timed out waiting for controlled Codex Desktop root process");
}

export async function startToolCodexDesktop(options: {
  appPath?: string;
  codexBin?: string;
  paths: ToolCodexPaths;
  workspace?: string;
}): Promise<ToolCodexStartResult> {
  if (process.platform !== "darwin") {
    throw new ToolCodexError("PLATFORM_UNSUPPORTED", "controlled Codex Desktop start currently supports macOS only");
  }
  await readToolCodexSentinel(options.paths);
  const lock = await acquireToolCodexGlobalLock(options.paths, "start");
  try {
    const beforeRoots = findCodexDesktopRoots(await listProcessSnapshotsStrict());
    if (beforeRoots.length > 0) {
      throw new ToolCodexError(
        "HOST_INSTANCE_PRESENT",
        "Codex Desktop is already running; tools-codex will not adopt or stop it",
        { roots: beforeRoots },
      );
    }
    const application = await resolveCodexDesktopApp(options.appPath);
    if (application == null) {
      throw new ToolCodexError("DESKTOP_NOT_INSTALLED", "Codex Desktop is not installed");
    }
    const workspace = resolve(options.workspace ?? options.paths.workspaceRoot);
    if (options.workspace == null) {
      await mkdir(workspace, { recursive: true, mode: 0o700 });
    } else if (!await pathExists(workspace)) {
      throw new ToolCodexError("WORKSPACE_MISSING", `Codex Desktop workspace does not exist: ${workspace}`);
    }
    const runId = randomUUID();
    const launchedAt = new Date();
    try {
      const result = await runCommand(options.codexBin ?? "codex", [
        "app",
        "--enable",
        "plugins",
        workspace,
      ], {
        env: codexEnv(options.paths, {
          [TOOLS_CODEX_HOME_DIGEST_ENV]: codexHomeDigest(options.paths.codexHome),
          [TOOLS_CODEX_RUN_ID_ENV]: runId,
        }),
      });
      if (result.code !== 0) {
        throw new ToolCodexError(
          "DESKTOP_LAUNCH_FAILED",
          result.stderr || result.stdout || "codex app failed",
        );
      }
      const root = await waitForControlledRoot(options.paths, runId);
      const rootStartedAt = await readProcessStartedAt(root.pid);
      if (rootStartedAt == null) {
        throw new ToolCodexError("PROCESS_START_TIME_UNAVAILABLE", "cannot read Codex Desktop root process start time");
      }
      const marker: ToolCodexRunMarkerV1 = {
        appPath: application.appPath,
        codexHome: options.paths.codexHome,
        desktopVersion: await readDesktopVersion(application.appPath),
        executablePath: application.executablePath,
        namespace: options.paths.namespace,
        owner: TOOLS_CODEX_OWNER,
        rootPid: root.pid,
        rootStartedAt,
        runId,
        schemaVersion: TOOLS_CODEX_SCHEMA_VERSION,
        startedAt: launchedAt.toISOString(),
        workspace,
      };
      await writeToolCodexRunMarker(options.paths, marker);
      return { created: true, marker };
    } catch (error) {
      let remainingPids: number[] | null = null;
      try {
        const stampedPids = await listStampedPids(options.paths, { runId });
        const graceful = await stopGracefully(stampedPids);
        remainingPids = graceful.remainingPids;
        if (remainingPids.length > 0) {
          remainingPids = (await stopProcesses(remainingPids)).remainingPids;
        }
      } catch {
        remainingPids = null;
      }
      if (remainingPids == null || remainingPids.length > 0) {
        throw new ToolCodexError(
          "DESKTOP_START_ROLLBACK_INCOMPLETE",
          "Codex Desktop start failed and stamped-process cleanup could not be proven complete",
          {
            cause: error instanceof Error ? error.message : String(error),
            remainingPids,
            runId,
          },
        );
      }
      throw error;
    }
  } finally {
    await lock.release();
  }
}

async function listStampedPids(
  paths: ToolCodexPaths,
  identity: Pick<ToolCodexRunMarkerV1, "runId">,
): Promise<number[]> {
  const processes = await listProcessSnapshotsStrict();
  const candidates = processes.filter((entry) =>
    entry.command.includes("/Codex.app/")
    || entry.command.includes(paths.codexHome)
  );
  const matches: number[] = [];
  for (const candidate of candidates) {
    const [runId, homeDigest] = await Promise.all([
      readProcessEnvironmentValue(candidate.pid, TOOLS_CODEX_RUN_ID_ENV),
      readProcessEnvironmentValue(candidate.pid, TOOLS_CODEX_HOME_DIGEST_ENV),
    ]);
    if (runId === identity.runId && homeDigest === codexHomeDigest(paths.codexHome)) {
      matches.push(candidate.pid);
    }
  }
  return [...new Set(matches)].sort((left, right) => right - left);
}

async function stopGracefully(pids: number[]): Promise<{
  remainingPids: number[];
  stoppedPids: number[];
}> {
  for (const pid of pids) {
    if (!isProcessAlive(pid)) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  await Promise.all(pids.map((pid) => waitForProcessExit(pid, 5_000)));
  const remainingPids = pids.filter(isProcessAlive);
  return {
    remainingPids,
    stoppedPids: pids.filter((pid) => !remainingPids.includes(pid)),
  };
}

export async function stopToolCodexDesktop(options: {
  force?: boolean;
  paths: ToolCodexPaths;
}): Promise<ToolCodexStopResult> {
  await readToolCodexSentinel(options.paths);
  const lock = await acquireToolCodexGlobalLock(options.paths, "stop");
  try {
    const marker = await readToolCodexRunMarker(options.paths);
    const roots = findCodexDesktopRoots(await listProcessSnapshotsStrict());
    if (marker == null) {
      if (roots.length > 0) {
        throw new ToolCodexError("UNMANAGED_DESKTOP_INSTANCE", "Codex Desktop is running without a tools-codex marker");
      }
      return {
        forced: false,
        matchedPids: [],
        remainingPids: [],
        state: "not-running",
        stoppedPids: [],
      };
    }

    const markerRoot = assertStopRootOwnership(roots, marker);
    if (markerRoot != null && !await isControlledRoot(markerRoot, marker)) {
      throw new ToolCodexError("CONTROL_IDENTITY_MISMATCH", "Codex Desktop root no longer matches the tools-codex marker");
    }
    const initialPids = await listStampedPids(options.paths, marker);
    const rootFirst = initialPids.includes(marker.rootPid)
      ? [marker.rootPid, ...initialPids.filter((pid) => pid !== marker.rootPid)]
      : initialPids;
    const graceful = await stopGracefully(rootFirst);
    await sleep(500);
    const orphanPids = await listStampedPids(options.paths, marker);
    const orphanGraceful = await stopGracefully(orphanPids);
    let remainingPids = [...new Set([
      ...graceful.remainingPids,
      ...orphanGraceful.remainingPids,
    ])].filter(isProcessAlive);
    let forcedResult: StopProcessesResult | null = null;
    if (remainingPids.length > 0 && options.force === true) {
      forcedResult = await stopProcesses(remainingPids);
      remainingPids = forcedResult.remainingPids;
    }
    const matchedPids = [...new Set([...initialPids, ...orphanPids])].sort((left, right) => right - left);
    const stoppedPids = matchedPids.filter((pid) => !remainingPids.includes(pid));
    if (remainingPids.length === 0) {
      await removeToolCodexRunMarker(options.paths);
    }
    return {
      forced: forcedResult != null,
      matchedPids,
      remainingPids,
      state: remainingPids.length === 0 ? "stopped" : "partial",
      stoppedPids,
    };
  } finally {
    await lock.release();
  }
}
