import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
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

import { assertToolCodexAuthNotClonedFromDefault } from "./auth.js";
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
import {
  runtimeBindingFromPreparedState,
  toolCodexRuntimeEnv,
  type ToolCodexRuntimeBinding,
} from "./runtime.js";

export const TOOLS_CODEX_RUN_ID_ENV = "OD_TOOLS_CODEX_RUN_ID";
export const TOOLS_CODEX_HOME_DIGEST_ENV = "OD_TOOLS_CODEX_HOME_DIGEST";
export const CODEX_ELECTRON_AGENT_RUN_ID_ENV =
  "CODEX_ELECTRON_AGENT_RUN_ID";
export const CODEX_ELECTRON_USER_DATA_PATH_ENV =
  "CODEX_ELECTRON_USER_DATA_PATH";
const CODEX_MACOS_DESKTOP_ROOT_SUFFIX = "/Codex.app/Contents/MacOS/ChatGPT";
const CODEX_WINDOWS_PACKAGE_NAME = "OpenAI.Codex";
const CODEX_WINDOWS_EXECUTABLE_SUFFIX = "\\app\\ChatGPT.exe";
const WINDOWS_PROCESS_ENVIRONMENT_MAX_BYTES = 1024 * 1024;
const WINDOWS_PROCESS_ENVIRONMENT_READER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace OpenDesign
{
    public static class ProcessEnvironmentReader
    {
        private const uint PROCESS_VM_READ = 0x0010;
        private const uint PROCESS_QUERY_INFORMATION = 0x0400;
        private const uint MEM_COMMIT = 0x1000;
        private const uint PAGE_NOACCESS = 0x01;
        private const uint PAGE_GUARD = 0x100;
        private const int PROCESS_BASIC_INFORMATION_CLASS = 0;
        private const int PEB_PROCESS_PARAMETERS_OFFSET_X64 = 0x20;
        private const int PROCESS_PARAMETERS_ENVIRONMENT_OFFSET_X64 = 0x80;
        private const int MAX_ENVIRONMENT_BYTES = ${WINDOWS_PROCESS_ENVIRONMENT_MAX_BYTES};

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_BASIC_INFORMATION
        {
            public IntPtr Reserved1;
            public IntPtr PebBaseAddress;
            public IntPtr Reserved2_0;
            public IntPtr Reserved2_1;
            public IntPtr UniqueProcessId;
            public IntPtr Reserved3;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MEMORY_BASIC_INFORMATION
        {
            public IntPtr BaseAddress;
            public IntPtr AllocationBase;
            public uint AllocationProtect;
            public UIntPtr RegionSize;
            public uint State;
            public uint Protect;
            public uint Type;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(
            uint desiredAccess,
            bool inheritHandle,
            int processId
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsWow64Process(
            IntPtr process,
            out bool wow64Process
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool ReadProcessMemory(
            IntPtr process,
            IntPtr baseAddress,
            [Out] byte[] buffer,
            int size,
            out IntPtr bytesRead
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern UIntPtr VirtualQueryEx(
            IntPtr process,
            IntPtr address,
            out MEMORY_BASIC_INFORMATION buffer,
            UIntPtr length
        );

        [DllImport("ntdll.dll")]
        private static extern int NtQueryInformationProcess(
            IntPtr process,
            int processInformationClass,
            ref PROCESS_BASIC_INFORMATION processInformation,
            int processInformationLength,
            out int returnLength
        );

        private static IntPtr Add(IntPtr address, int offset)
        {
            return new IntPtr(checked(address.ToInt64() + offset));
        }

        private static byte[] ReadExact(IntPtr process, IntPtr address, int size)
        {
            byte[] buffer = new byte[size];
            IntPtr bytesRead;
            if (!ReadProcessMemory(process, address, buffer, size, out bytesRead)
                || bytesRead.ToInt64() != size)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return buffer;
        }

        private static IntPtr ReadPointer(IntPtr process, IntPtr address)
        {
            byte[] bytes = ReadExact(process, address, 8);
            return new IntPtr(BitConverter.ToInt64(bytes, 0));
        }

        private static int FindEnvironmentEnd(byte[] bytes)
        {
            for (int index = 0; index + 3 < bytes.Length; index += 2)
            {
                if (bytes[index] == 0
                    && bytes[index + 1] == 0
                    && bytes[index + 2] == 0
                    && bytes[index + 3] == 0)
                {
                    return index;
                }
            }
            return -1;
        }

        private static IntPtr ReadProcessParameters(IntPtr process)
        {
            PROCESS_BASIC_INFORMATION basic = new PROCESS_BASIC_INFORMATION();
            int returnedLength;
            int status = NtQueryInformationProcess(
                process,
                PROCESS_BASIC_INFORMATION_CLASS,
                ref basic,
                Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)),
                out returnedLength
            );
            if (status < 0 || basic.PebBaseAddress == IntPtr.Zero)
            {
                throw new InvalidOperationException(
                    "NtQueryInformationProcess failed with status " + status
                );
            }
            IntPtr processParameters = ReadPointer(
                process,
                Add(basic.PebBaseAddress, PEB_PROCESS_PARAMETERS_OFFSET_X64)
            );
            if (processParameters == IntPtr.Zero)
            {
                throw new InvalidOperationException("process parameters are unavailable");
            }
            return processParameters;
        }

        private static string ReadEnvironmentBlock(
            IntPtr process,
            IntPtr processParameters
        )
        {
            IntPtr environment = ReadPointer(
                process,
                Add(processParameters, PROCESS_PARAMETERS_ENVIRONMENT_OFFSET_X64)
            );
            if (environment == IntPtr.Zero)
            {
                throw new InvalidOperationException("process environment is unavailable");
            }

            using (MemoryStream stream = new MemoryStream())
            {
                long current = environment.ToInt64();
                while (stream.Length < MAX_ENVIRONMENT_BYTES)
                {
                    MEMORY_BASIC_INFORMATION memory;
                    UIntPtr queryLength = new UIntPtr(
                        (uint)Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION))
                    );
                    if (VirtualQueryEx(
                        process,
                        new IntPtr(current),
                        out memory,
                        queryLength
                    ) == UIntPtr.Zero)
                    {
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    }
                    if (memory.State != MEM_COMMIT
                        || (memory.Protect & (PAGE_NOACCESS | PAGE_GUARD)) != 0)
                    {
                        throw new InvalidOperationException(
                            "process environment memory is not readable"
                        );
                    }

                    long regionStart = memory.BaseAddress.ToInt64();
                    long regionEnd = checked(
                        regionStart + (long)memory.RegionSize.ToUInt64()
                    );
                    if (current < regionStart || current >= regionEnd)
                    {
                        throw new InvalidOperationException(
                            "process environment memory region is invalid"
                        );
                    }
                    int chunkSize = (int)Math.Min(
                        65536L,
                        Math.Min(
                            regionEnd - current,
                            MAX_ENVIRONMENT_BYTES - stream.Length
                        )
                    );
                    if (chunkSize <= 0)
                    {
                        break;
                    }
                    byte[] chunk = ReadExact(
                        process,
                        new IntPtr(current),
                        chunkSize
                    );
                    stream.Write(chunk, 0, chunk.Length);
                    byte[] accumulated = stream.ToArray();
                    int end = FindEnvironmentEnd(accumulated);
                    if (end >= 0)
                    {
                        return Encoding.Unicode.GetString(accumulated, 0, end);
                    }
                    current = checked(current + chunkSize);
                }
            }
            throw new InvalidOperationException(
                "process environment terminator was not found"
            );
        }

        private static IntPtr OpenNativeX64Process(int processId)
        {
            if (!Environment.Is64BitProcess)
            {
                throw new PlatformNotSupportedException(
                    "the environment reader requires a native 64-bit process"
                );
            }
            IntPtr process = OpenProcess(
                PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
                false,
                processId
            );
            if (process == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            try
            {
                bool wow64;
                if (!IsWow64Process(process, out wow64))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                if (wow64)
                {
                    throw new PlatformNotSupportedException(
                        "the environment reader supports native x64 targets only"
                    );
                }
                return process;
            }
            catch
            {
                CloseHandle(process);
                throw;
            }
        }

        public static Dictionary<string, string> Read(
            int processId,
            string[] names
        )
        {
            IntPtr process = OpenNativeX64Process(processId);
            try
            {
                Dictionary<string, string> result =
                    new Dictionary<string, string>(StringComparer.Ordinal);
                Dictionary<string, string> requested =
                    new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (string name in names)
                {
                    result[name] = null;
                    requested[name] = name;
                }
                string block = ReadEnvironmentBlock(
                    process,
                    ReadProcessParameters(process)
                );
                foreach (string entry in block.Split('\0'))
                {
                    int separator = entry.IndexOf('=');
                    if (separator <= 0)
                    {
                        continue;
                    }
                    string originalName;
                    string actualName = entry.Substring(0, separator);
                    if (requested.TryGetValue(actualName, out originalName))
                    {
                        result[originalName] = entry.Substring(separator + 1);
                    }
                }
                return result;
            }
            finally
            {
                CloseHandle(process);
            }
        }

    }
}
`;
const WINDOWS_PROCESS_ENVIRONMENT_READER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OD_TOOLS_CODEX_ENV_READER_SOURCE))",
  "Add-Type -TypeDefinition $source -Language CSharp",
  "$namesJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OD_TOOLS_CODEX_ENV_READER_NAMES))",
  "$names = [string[]](ConvertFrom-Json -InputObject $namesJson)",
  "$values = [OpenDesign.ProcessEnvironmentReader]::Read([int]$env:OD_TOOLS_CODEX_ENV_READER_PID, [string[]]$names)",
  "$result = [ordered]@{}",
  "foreach ($name in $names) { $result[$name] = $values[$name] }",
  "$result | ConvertTo-Json -Compress",
].join("; ");
const WINDOWS_RESTRICTED_DESKTOP_LAUNCHER_SOURCE = [
  "$ErrorActionPreference = 'Stop'",
  "$payload = Get-Content -LiteralPath '__PAYLOAD_PATH__' -Raw -Encoding UTF8 | ConvertFrom-Json",
  "foreach ($entry in $payload.environment.psobject.Properties) { [Environment]::SetEnvironmentVariable([string]$entry.Name, [string]$entry.Value, 'Process') }",
  "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
  "$principal = New-Object Security.Principal.WindowsPrincipal($identity)",
  "$process = Start-Process -FilePath ([string]$payload.executablePath) -ArgumentList ([string]$payload.argumentLine) -WorkingDirectory ([string]$payload.workingDirectory) -PassThru",
  "$result = [ordered]@{ childPid=$process.Id; completedAt=[DateTimeOffset]::Now.ToString('o'); helperPid=$PID; isAdministrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); owner=[string]$payload.owner; runId=[string]$payload.runId; schemaVersion=[int]$payload.schemaVersion }",
  "$temporaryPath = ([string]$payload.reportPath) + '.' + $PID + '.tmp'",
  "$encoding = New-Object Text.UTF8Encoding($false)",
  "[IO.File]::WriteAllText($temporaryPath, ($result | ConvertTo-Json -Compress), $encoding)",
  "Move-Item -LiteralPath $temporaryPath -Destination ([string]$payload.reportPath) -Force",
].join("; ");

export type CommandResult = {
  code: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

export type ToolCodexDesktopRoot = ProcessSnapshot & {
  executablePath: string;
};

export type ToolCodexDesktopApplication = {
  appPath: string;
  applicationId: string | null;
  aumid: string | null;
  executablePath: string;
  packageFamilyName: string | null;
  packageFullName: string | null;
  version: string | null;
};

export type WindowsRestrictedDesktopLaunchPayloadV1 = {
  argumentLine: string;
  arguments: string[];
  environment: Record<string, string>;
  executablePath: string;
  owner: typeof TOOLS_CODEX_OWNER;
  reportPath: string;
  runId: string;
  schemaVersion: typeof TOOLS_CODEX_SCHEMA_VERSION;
  workingDirectory: string;
};

export type WindowsRestrictedDesktopLaunchHandshakeV1 = {
  childPid: number;
  completedAt: string;
  helperPid: number;
  isAdministrator: false;
  owner: typeof TOOLS_CODEX_OWNER;
  runId: string;
  schemaVersion: typeof TOOLS_CODEX_SCHEMA_VERSION;
};

export type WindowsRestrictedDesktopLaunchRequest = {
  helperCommand: string;
  payload: WindowsRestrictedDesktopLaunchPayloadV1;
  payloadPath: string;
  reportPath: string;
  runasArgs: [string, string];
  runasPath: string;
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
    applicationId: string | null;
    aumid: string | null;
    available: boolean;
    controlled: boolean;
    executablePath: string | null;
    packageFamilyName: string | null;
    packageFullName: string | null;
    roots: ToolCodexDesktopRoot[];
    version: string | null;
  };
  lock: Awaited<ReturnType<typeof readToolCodexGlobalLock>>;
  marker: ToolCodexRunMarkerV1 | null;
  namespace: string;
  paths: {
    codexHome: string;
    desktopUserDataPath: string;
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

export function windowsDesktopLoginIsUsable(
  result: Pick<CommandResult, "code" | "stderr" | "stdout">,
): boolean {
  return result.code === 0
    && /\bChatGPT\b/i.test(`${result.stdout}\n${result.stderr}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

export function quoteWindowsCommandLineArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value;
  let quoted = "\"";
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === "\"") {
      quoted += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    quoted += `${"\\".repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

function windowsPowerShellPath(systemRoot: string): string {
  return win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsWorkspaceUri(workspace: string): string {
  const uri = new URL("codex://threads/new");
  uri.searchParams.set("path", workspace);
  return uri.toString();
}

function stringEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function createWindowsRestrictedDesktopLaunchRequest(options: {
  application: ToolCodexDesktopApplication;
  paths: ToolCodexPaths;
  runId: string;
  runtimeBinding?: ToolCodexRuntimeBinding | null;
  systemRoot?: string;
  workspace: string;
}): WindowsRestrictedDesktopLaunchRequest {
  const payloadPath = join(
    options.paths.runsRoot,
    `${options.runId}.windows-launch.json`,
  );
  const reportPath = join(
    options.paths.runsRoot,
    `${options.runId}.windows-launch-handshake.json`,
  );
  const arguments_ = [
    `--user-data-dir=${options.paths.desktopUserDataPath}`,
    windowsWorkspaceUri(options.workspace),
  ];
  const payload: WindowsRestrictedDesktopLaunchPayloadV1 = {
    argumentLine: arguments_
      .map(quoteWindowsCommandLineArgument)
      .join(" "),
    arguments: arguments_,
    environment: stringEnvironment({
      CODEX_HOME: options.paths.codexHome,
      [CODEX_ELECTRON_AGENT_RUN_ID_ENV]:
        `open-design-tools-codex-${options.runId}`,
      [CODEX_ELECTRON_USER_DATA_PATH_ENV]:
        options.paths.desktopUserDataPath,
      [TOOLS_CODEX_HOME_DIGEST_ENV]:
        codexHomeDigest(options.paths.codexHome),
      [TOOLS_CODEX_RUN_ID_ENV]: options.runId,
      ...toolCodexRuntimeEnv(options.runtimeBinding),
    }),
    executablePath: options.application.executablePath,
    owner: TOOLS_CODEX_OWNER,
    reportPath,
    runId: options.runId,
    schemaVersion: TOOLS_CODEX_SCHEMA_VERSION,
    workingDirectory: win32.dirname(options.application.executablePath),
  };
  const launcherSource = WINDOWS_RESTRICTED_DESKTOP_LAUNCHER_SOURCE.replace(
    "__PAYLOAD_PATH__",
    payloadPath.replaceAll("'", "''"),
  );
  const systemRoot = options.systemRoot
    ?? process.env.SystemRoot
    ?? "C:\\Windows";
  const helperCommand = [
    windowsPowerShellPath(systemRoot),
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(launcherSource, "utf16le").toString("base64"),
  ].map(quoteWindowsCommandLineArgument).join(" ");
  const runasPath = win32.join(systemRoot, "System32", "runas.exe");
  return {
    helperCommand,
    payload,
    payloadPath,
    reportPath,
    runasArgs: ["/trustlevel:0x20000", helperCommand],
    runasPath,
  };
}

export function parseWindowsRestrictedDesktopLaunchHandshake(
  value: unknown,
  expectedRunId: string,
): WindowsRestrictedDesktopLaunchHandshakeV1 {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value.replace(/^\uFEFF/, "")) as unknown;
    } catch {
      throw new ToolCodexError(
        "RESTRICTED_HELPER_HANDSHAKE_INVALID",
        "Windows restricted launch helper handshake is unreadable",
      );
    }
  }
  if (
    !isRecord(parsed)
    || parsed.owner !== TOOLS_CODEX_OWNER
    || parsed.schemaVersion !== TOOLS_CODEX_SCHEMA_VERSION
    || parsed.runId !== expectedRunId
    || typeof parsed.childPid !== "number"
    || !Number.isSafeInteger(parsed.childPid)
    || parsed.childPid < 1
    || typeof parsed.helperPid !== "number"
    || !Number.isSafeInteger(parsed.helperPid)
    || parsed.helperPid < 1
    || typeof parsed.completedAt !== "string"
    || typeof parsed.isAdministrator !== "boolean"
  ) {
    throw new ToolCodexError(
      "RESTRICTED_HELPER_HANDSHAKE_INVALID",
      "Windows restricted launch helper handshake does not match this tools-codex run",
    );
  }
  if (parsed.isAdministrator) {
    throw new ToolCodexError(
      "RESTRICTED_HELPER_TOKEN_INVALID",
      "Windows restricted launch helper retained an administrator token",
    );
  }
  return {
    childPid: parsed.childPid,
    completedAt: parsed.completedAt,
    helperPid: parsed.helperPid,
    isAdministrator: false,
    owner: TOOLS_CODEX_OWNER,
    runId: expectedRunId,
    schemaVersion: TOOLS_CODEX_SCHEMA_VERSION,
  };
}

async function waitForWindowsRestrictedDesktopLaunchHandshake(
  request: WindowsRestrictedDesktopLaunchRequest,
  timeoutMs = 15_000,
): Promise<WindowsRestrictedDesktopLaunchHandshakeV1> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    let output: string;
    try {
      output = await readFile(request.reportPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await sleep(100);
        continue;
      }
      throw error;
    }
    return parseWindowsRestrictedDesktopLaunchHandshake(
      output,
      request.payload.runId,
    );
  }
  throw new ToolCodexError(
    "RESTRICTED_HELPER_TIMEOUT",
    "timed out waiting for the Windows restricted launch helper handshake",
  );
}

async function launchWindowsCodexDesktop(
  request: WindowsRestrictedDesktopLaunchRequest,
): Promise<WindowsRestrictedDesktopLaunchHandshakeV1> {
  await writeFile(
    request.payloadPath,
    `${JSON.stringify(request.payload, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    },
  );
  const result = await runCommand(
    request.runasPath,
    request.runasArgs,
    {
      cwd: dirname(request.payloadPath),
      timeoutMs: 15_000,
    },
  );
  if (result.code !== 0) {
    throw new ToolCodexError(
      "RESTRICTED_HELPER_LAUNCH_FAILED",
      result.stderr || result.stdout
        || "Windows restricted launch helper failed to start",
      { timedOut: result.timedOut },
    );
  }
  return await waitForWindowsRestrictedDesktopLaunchHandshake(request);
}

function normalizeDesktopExecutablePath(
  path: string,
  platform: NodeJS.Platform,
): string {
  const normalized = platform === "win32"
    ? win32.normalize(path)
    : path.replaceAll("\\", "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function windowsCommandExecutable(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.startsWith('"')) {
    const closingQuote = trimmed.indexOf('"', 1);
    return closingQuote > 1 ? trimmed.slice(1, closingQuote) : null;
  }
  const separator = trimmed.search(/\s/);
  return trimmed.length === 0
    ? null
    : separator === -1
      ? trimmed
      : trimmed.slice(0, separator);
}

function windowsCommandArguments(
  command: string,
  executablePath: string,
): string | null {
  const trimmed = command.trim();
  if (trimmed.startsWith('"')) {
    const closingQuote = trimmed.indexOf('"', 1);
    if (closingQuote <= 1) return null;
    if (
      normalizeDesktopExecutablePath(trimmed.slice(1, closingQuote), "win32")
      !== normalizeDesktopExecutablePath(executablePath, "win32")
    ) {
      return null;
    }
    return trimmed.slice(closingQuote + 1).trim();
  }
  return normalizeDesktopExecutablePath(trimmed, "win32")
      === normalizeDesktopExecutablePath(executablePath, "win32")
    ? ""
    : null;
}

function isWindowsCodexDesktopRootCommand(
  command: string,
  executablePath: string,
): boolean {
  const args = windowsCommandArguments(command, executablePath);
  if (args == null) return false;
  return !args.split(/\s+/).some((arg) => /^--type(?:=|$)/i.test(arg));
}

export function windowsUserDataDirectoryArgument(
  command: string,
): string | null {
  const match = command.match(
    /(?:^|\s)"?--user-data-dir(?:=|\s+)(?:"([^"]+)"|([^"\s]+))"?/i,
  );
  return match?.[1] ?? match?.[2] ?? null;
}

function isWindowsCodexMsixExecutable(path: string): boolean {
  const normalized = win32.normalize(path);
  return normalized.toLowerCase().endsWith(
    CODEX_WINDOWS_EXECUTABLE_SUFFIX.toLowerCase(),
  ) && /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$/i.test(
    normalized,
  );
}

export function findCodexDesktopRoots(
  processes: readonly ProcessSnapshot[],
  expectedExecutablePath?: string,
  platform: NodeJS.Platform = process.platform,
): ToolCodexDesktopRoot[] {
  return processes.flatMap((processInfo) => {
    const command = processInfo.command.trim();
    if (expectedExecutablePath != null) {
      if (
        processInfo.executablePath != null
        && normalizeDesktopExecutablePath(
          processInfo.executablePath,
          platform,
        ) !== normalizeDesktopExecutablePath(expectedExecutablePath, platform)
      ) {
        return [];
      }
      if (platform === "win32") {
        if (!isWindowsCodexDesktopRootCommand(
          command,
          expectedExecutablePath,
        )) {
          return [];
        }
      } else if (!processCommandExactlyRunsExecutable(
        command,
        expectedExecutablePath,
        platform,
      )) {
        return [];
      }
      return [{
        ...processInfo,
        command,
        executablePath: expectedExecutablePath,
      }];
    }
    if (platform === "win32") {
      const executablePath = processInfo.executablePath
        ?? windowsCommandExecutable(command);
      if (
        executablePath == null
        || !isWindowsCodexMsixExecutable(executablePath)
        || !isWindowsCodexDesktopRootCommand(command, executablePath)
      ) {
        return [];
      }
      return [{ ...processInfo, command, executablePath }];
    }
    if (!command.endsWith(CODEX_MACOS_DESKTOP_ROOT_SUFFIX)) return [];
    if (
      command.slice(0, -CODEX_MACOS_DESKTOP_ROOT_SUFFIX.length).includes(" ")
    ) {
      return [];
    }
    return [{
      ...processInfo,
      command,
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

function emptyEnvironmentValues(
  names: readonly string[],
): Record<string, string | null> {
  return Object.fromEntries(names.map((name) => [name, null]));
}

async function readWindowsProcessEnvironmentValues(
  pid: number,
  names: readonly string[],
): Promise<Record<string, string | null>> {
  const values = emptyEnvironmentValues(names);
  if (process.arch !== "x64" || names.length === 0) return values;
  const result = await runCommand("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(
      WINDOWS_PROCESS_ENVIRONMENT_READER_SCRIPT,
      "utf16le",
    ).toString("base64"),
  ], {
    env: {
      ...process.env,
      OD_TOOLS_CODEX_ENV_READER_NAMES: Buffer.from(
        JSON.stringify(names),
        "utf8",
      ).toString("base64"),
      OD_TOOLS_CODEX_ENV_READER_PID: String(pid),
      OD_TOOLS_CODEX_ENV_READER_SOURCE: Buffer.from(
        WINDOWS_PROCESS_ENVIRONMENT_READER_SOURCE,
        "utf8",
      ).toString("base64"),
    },
    timeoutMs: 5_000,
  });
  if (result.code !== 0 || result.stdout.length === 0) return values;
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    for (const name of names) {
      if (typeof parsed[name] === "string") values[name] = parsed[name];
    }
  } catch {
    return emptyEnvironmentValues(names);
  }
  return values;
}

export async function readProcessEnvironmentValues(
  pid: number,
  names: readonly string[],
): Promise<Record<string, string | null>> {
  const uniqueNames = [...new Set(names)];
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || uniqueNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
  ) {
    return emptyEnvironmentValues(uniqueNames);
  }
  if (process.platform === "win32") {
    return await readWindowsProcessEnvironmentValues(pid, uniqueNames);
  }
  if (process.platform !== "darwin") {
    return emptyEnvironmentValues(uniqueNames);
  }
  const result = await runCommand("ps", [
    "eww",
    "-p",
    String(pid),
    "-o",
    "command=",
  ]);
  if (result.code !== 0) return emptyEnvironmentValues(uniqueNames);
  return Object.fromEntries(
    uniqueNames.map((name) => [
      name,
      readEnvironmentValue(result.stdout, name),
    ]),
  );
}

export async function readProcessEnvironmentValue(
  pid: number,
  name: string,
): Promise<string | null> {
  return (await readProcessEnvironmentValues(pid, [name]))[name] ?? null;
}

export async function readProcessStartedAt(pid: number): Promise<string | null> {
  if (process.platform === "win32") {
    return (await listProcessSnapshotsStrict())
      .find((entry) => entry.pid === pid)
      ?.startedAt ?? null;
  }
  const result = await runCommand("ps", ["-p", String(pid), "-o", "lstart="]);
  return result.code === 0 && result.stdout.length > 0 ? result.stdout : null;
}

export async function listProcessIdsWithEnvironmentValue(options: {
  commandMatches: (command: string) => boolean;
  name: string;
  value: string;
}): Promise<number[]> {
  if (process.platform !== "darwin" && process.platform !== "win32") return [];
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

type WindowsCodexDesktopApplicationRecord = {
  AppId?: unknown;
  Aumid?: unknown;
  ExecutablePath?: unknown;
  InstallLocation?: unknown;
  PackageFamilyName?: unknown;
  PackageFullName?: unknown;
  Version?: unknown;
};

export function parseWindowsCodexDesktopApplication(
  output: string,
): ToolCodexDesktopApplication {
  const record = JSON.parse(output) as WindowsCodexDesktopApplicationRecord;
  const required = [
    "AppId",
    "Aumid",
    "ExecutablePath",
    "InstallLocation",
    "PackageFamilyName",
    "PackageFullName",
    "Version",
  ] as const;
  for (const field of required) {
    if (typeof record[field] !== "string" || record[field].length === 0) {
      throw new ToolCodexError(
        "DESKTOP_PACKAGE_INVALID",
        `Codex MSIX package record is missing ${field}`,
      );
    }
  }
  const executablePath = record.ExecutablePath as string;
  if (!isWindowsCodexMsixExecutable(executablePath)) {
    throw new ToolCodexError(
      "DESKTOP_PACKAGE_INVALID",
      `Codex MSIX executable is unexpected: ${executablePath}`,
    );
  }
  return {
    appPath: record.InstallLocation as string,
    applicationId: record.AppId as string,
    aumid: record.Aumid as string,
    executablePath,
    packageFamilyName: record.PackageFamilyName as string,
    packageFullName: record.PackageFullName as string,
    version: record.Version as string,
  };
}

async function resolveWindowsCodexDesktopApp(
  appPathOverride?: string,
): Promise<ToolCodexDesktopApplication | null> {
  if (appPathOverride != null) {
    const candidate = resolve(appPathOverride);
    const executablePath = candidate.toLowerCase().endsWith(".exe")
      ? candidate
      : join(candidate, "app", "ChatGPT.exe");
    if (!await pathExists(executablePath)) return null;
    return {
      appPath: candidate.toLowerCase().endsWith(".exe")
        ? dirname(dirname(candidate))
        : candidate,
      applicationId: null,
      aumid: null,
      executablePath,
      packageFamilyName: null,
      packageFullName: null,
      version: null,
    };
  }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$package = Get-AppxPackage -Name '${CODEX_WINDOWS_PACKAGE_NAME}' | Sort-Object Version -Descending | Select-Object -First 1`,
    "if ($null -eq $package) { exit 3 }",
    "$manifest = Get-AppxPackageManifest -Package $package",
    "$application = @($manifest.Package.Applications.Application) | Where-Object { ([string]$_.Executable).Replace('\\','/') -eq 'app/ChatGPT.exe' } | Select-Object -First 1",
    "if ($null -eq $application) { exit 4 }",
    "[pscustomobject]@{ AppId=[string]$application.Id; Aumid=('{0}!{1}' -f $package.PackageFamilyName,$application.Id); ExecutablePath=(Join-Path $package.InstallLocation ([string]$application.Executable)); InstallLocation=[string]$package.InstallLocation; PackageFamilyName=[string]$package.PackageFamilyName; PackageFullName=[string]$package.PackageFullName; Version=[string]$package.Version } | ConvertTo-Json -Compress",
  ].join("; ");
  const result = await runCommand("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ], { timeoutMs: 5_000 });
  if (result.code !== 0 || result.stdout.length === 0) return null;
  const application = parseWindowsCodexDesktopApplication(result.stdout);
  return await pathExists(application.executablePath) ? application : null;
}

export async function resolveCodexDesktopApp(
  appPathOverride?: string,
): Promise<ToolCodexDesktopApplication | null> {
  if (process.platform === "win32") {
    return await resolveWindowsCodexDesktopApp(appPathOverride);
  }
  const candidates = appPathOverride == null
    ? [
        "/Applications/Codex.app",
        join(homedir(), "Applications", "Codex.app"),
      ]
    : [resolve(appPathOverride)];
  for (const appPath of candidates) {
    const executablePath = join(appPath, "Contents", "MacOS", "ChatGPT");
    if (await pathExists(executablePath)) {
      return {
        appPath,
        applicationId: null,
        aumid: null,
        executablePath,
        packageFamilyName: null,
        packageFullName: null,
        version: null,
      };
    }
  }
  return null;
}

async function readDesktopVersion(
  application: ToolCodexDesktopApplication | null,
): Promise<string | null> {
  if (application?.version != null) return application.version;
  if (application == null || process.platform !== "darwin") return null;
  const result = await runCommand("defaults", [
    "read",
    join(application.appPath, "Contents", "Info.plist"),
    "CFBundleShortVersionString",
  ]);
  return result.code === 0 && result.stdout.length > 0 ? result.stdout : null;
}

function desktopStatus(
  application: ToolCodexDesktopApplication | null,
  version: string | null,
  roots: ToolCodexDesktopRoot[] = [],
  controlled = false,
): ToolCodexStatus["desktop"] {
  return {
    appPath: application?.appPath ?? null,
    applicationId: application?.applicationId ?? null,
    aumid: application?.aumid ?? null,
    available: application != null,
    controlled,
    executablePath: application?.executablePath ?? null,
    packageFamilyName: application?.packageFamilyName ?? null,
    packageFullName: application?.packageFullName ?? null,
    roots,
    version,
  };
}

function codexEnv(paths: ToolCodexPaths, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    CODEX_HOME: paths.codexHome,
  };
}

function managedPathMatches(
  actual: string | null,
  expected: string,
): boolean {
  return actual != null
    && normalizeDesktopExecutablePath(
      resolve(actual),
      process.platform,
    ) === normalizeDesktopExecutablePath(
      resolve(expected),
      process.platform,
    );
}

function expectedElectronAgentRunId(runId: string): string {
  return `open-design-tools-codex-${runId}`;
}

async function isControlledRoot(
  root: ToolCodexDesktopRoot,
  marker: ToolCodexRunMarkerV1,
): Promise<boolean> {
  if (
    root.pid !== marker.rootPid
    || findCodexDesktopRoots([root], marker.executablePath).length !== 1
  ) {
    return false;
  }
  if (
    marker.desktopUserDataPath != null
    && (
      process.platform !== "win32"
      || !managedPathMatches(
        windowsUserDataDirectoryArgument(root.command),
        marker.desktopUserDataPath,
      )
    )
  ) {
    return false;
  }
  const [stamps, startedAt] = await Promise.all([
    readProcessEnvironmentValues(root.pid, [
      "CODEX_HOME",
      CODEX_ELECTRON_AGENT_RUN_ID_ENV,
      CODEX_ELECTRON_USER_DATA_PATH_ENV,
      TOOLS_CODEX_RUN_ID_ENV,
      TOOLS_CODEX_HOME_DIGEST_ENV,
    ]),
    root.startedAt == null
      ? readProcessStartedAt(root.pid)
      : Promise.resolve(root.startedAt),
  ]);
  return stamps[TOOLS_CODEX_RUN_ID_ENV] === marker.runId
    && stamps[TOOLS_CODEX_HOME_DIGEST_ENV] === codexHomeDigest(marker.codexHome)
    && managedPathMatches(stamps.CODEX_HOME ?? null, marker.codexHome)
    && (
      marker.desktopUserDataPath == null
      || (
        stamps[CODEX_ELECTRON_AGENT_RUN_ID_ENV]
          === expectedElectronAgentRunId(marker.runId)
        && managedPathMatches(
          stamps[CODEX_ELECTRON_USER_DATA_PATH_ENV] ?? null,
          marker.desktopUserDataPath,
        )
      )
    )
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
  const desktopVersion = await readDesktopVersion(application);
  const base = {
    namespace: options.paths.namespace,
    paths: {
      codexHome: options.paths.codexHome,
      desktopUserDataPath: options.paths.desktopUserDataPath,
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
        desktop: desktopStatus(application, desktopVersion),
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
      desktop: desktopStatus(application, desktopVersion),
      lock: null,
      marker: null,
      reasonCode: "NOT_INITIALIZED",
      state: "uninitialized",
    };
  }

  const cli = await codexCliStatus(options.paths, codexBin);
  let lock: ToolCodexStatus["lock"];
  try {
    lock = await readToolCodexGlobalLock(options.paths);
  } catch (error) {
    return {
      ...base,
      cli,
      desktop: desktopStatus(application, desktopVersion),
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
      desktop: desktopStatus(application, desktopVersion),
      lock,
      marker: null,
      reasonCode: "PROCESS_ENUMERATION_FAILED",
      state: "unknown",
    };
  }
  const roots = findCodexDesktopRoots(
    processes,
    application?.executablePath,
  );
  let marker: ToolCodexRunMarkerV1 | null;
  try {
    marker = await readToolCodexRunMarker(options.paths);
  } catch (error) {
    return {
      ...base,
      cli,
      desktop: desktopStatus(application, desktopVersion, roots),
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
      desktop: desktopStatus(application, desktopVersion, roots),
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
      desktop: desktopStatus(application, desktopVersion),
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
    desktop: desktopStatus(application, desktopVersion, roots, controlled),
    lock,
    marker,
    reasonCode: controlled ? null : "UNMANAGED_DESKTOP_INSTANCE",
    state: controlled ? "running-controlled" : "running-unmanaged",
  };
}

async function waitForControlledRoot(
  paths: ToolCodexPaths,
  runId: string,
  executablePath: string,
  desktopUserDataPath: string | null,
  timeoutMs = 30_000,
): Promise<ToolCodexDesktopRoot> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const roots = findCodexDesktopRoots(
      await listProcessSnapshotsStrict(),
      executablePath,
    );
    if (roots.length > 1) {
      throw new ToolCodexError("MULTIPLE_DESKTOP_ROOTS", "multiple Codex Desktop root processes appeared during launch");
    }
    if (roots.length === 1) {
      const stamps = await readProcessEnvironmentValues(roots[0].pid, [
        "CODEX_HOME",
        CODEX_ELECTRON_AGENT_RUN_ID_ENV,
        CODEX_ELECTRON_USER_DATA_PATH_ENV,
        TOOLS_CODEX_RUN_ID_ENV,
        TOOLS_CODEX_HOME_DIGEST_ENV,
      ]);
      const actualRunId = stamps[TOOLS_CODEX_RUN_ID_ENV];
      const actualHomeDigest = stamps[TOOLS_CODEX_HOME_DIGEST_ENV];
      const actualCodexHome = stamps.CODEX_HOME ?? null;
      const actualElectronAgentRunId =
        stamps[CODEX_ELECTRON_AGENT_RUN_ID_ENV];
      const actualElectronUserDataPath =
        stamps[CODEX_ELECTRON_USER_DATA_PATH_ENV] ?? null;
      const commandUserDataPath = process.platform === "win32"
        ? windowsUserDataDirectoryArgument(roots[0].command)
        : null;
      if (
        actualRunId === runId
        && actualHomeDigest === codexHomeDigest(paths.codexHome)
        && managedPathMatches(actualCodexHome, paths.codexHome)
        && (
          desktopUserDataPath == null
          || (
            actualElectronAgentRunId === expectedElectronAgentRunId(runId)
            && managedPathMatches(
              actualElectronUserDataPath,
              desktopUserDataPath,
            )
            && managedPathMatches(commandUserDataPath, desktopUserDataPath)
          )
        )
      ) {
        return roots[0];
      }
      if (
        actualRunId != null
        || actualHomeDigest != null
        || actualCodexHome != null
        || actualElectronAgentRunId != null
        || actualElectronUserDataPath != null
      ) {
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
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new ToolCodexError(
      "PLATFORM_UNSUPPORTED",
      "controlled Codex Desktop start supports macOS and Windows only",
    );
  }
  if (process.platform === "win32" && process.arch !== "x64") {
    throw new ToolCodexError(
      "PLATFORM_UNSUPPORTED",
      "controlled Codex Desktop start on Windows requires native x64 Node",
    );
  }
  await readToolCodexSentinel(options.paths);
  await assertToolCodexAuthNotClonedFromDefault({
    managedCodexHome: options.paths.codexHome,
  });
  const lock = await acquireToolCodexGlobalLock(options.paths, "start");
  try {
    const runtimeBinding = runtimeBindingFromPreparedState(
      (await readToolCodexSentinel(options.paths)).prepared,
    );
    const application = await resolveCodexDesktopApp(options.appPath);
    if (application == null) {
      throw new ToolCodexError("DESKTOP_NOT_INSTALLED", "Codex Desktop is not installed");
    }
    const beforeProcesses = await listProcessSnapshotsStrict();
    const beforeRoots = [
      ...findCodexDesktopRoots(beforeProcesses),
      ...findCodexDesktopRoots(
        beforeProcesses,
        application.executablePath,
      ),
    ].filter((root, index, roots) =>
      roots.findIndex((candidate) => candidate.pid === root.pid) === index
    );
    if (beforeRoots.length > 0) {
      throw new ToolCodexError(
        "HOST_INSTANCE_PRESENT",
        "Codex Desktop is already running; tools-codex will not adopt or stop it",
        { roots: beforeRoots },
      );
    }
    const workspace = resolve(options.workspace ?? options.paths.workspaceRoot);
    if (options.workspace == null) {
      await mkdir(workspace, { recursive: true, mode: 0o700 });
    } else if (!await pathExists(workspace)) {
      throw new ToolCodexError("WORKSPACE_MISSING", `Codex Desktop workspace does not exist: ${workspace}`);
    }
    if (process.platform === "win32") {
      const login = await runCommand(
        options.codexBin ?? "codex",
        ["login", "status"],
        { env: codexEnv(options.paths) },
      );
      if (!windowsDesktopLoginIsUsable(login)) {
        throw new ToolCodexError(
          "DESKTOP_LOGIN_REQUIRED",
          "Windows controlled Desktop start requires a ChatGPT login in the managed CODEX_HOME",
          {
            codexHome: options.paths.codexHome,
            loginStatus: login.stdout || login.stderr || null,
          },
        );
      }
    }
    const runId = randomUUID();
    const launchedAt = new Date();
    try {
      const desktopUserDataPath = process.platform === "win32"
        ? options.paths.desktopUserDataPath
        : null;
      if (process.platform === "win32") {
        await mkdir(desktopUserDataPath!, {
          recursive: true,
          mode: 0o700,
        });
        await launchWindowsCodexDesktop(
          createWindowsRestrictedDesktopLaunchRequest({
            application,
            paths: options.paths,
            runId,
            runtimeBinding,
            workspace,
          }),
        );
      } else {
        const launchEnv = codexEnv(options.paths, {
          [TOOLS_CODEX_HOME_DIGEST_ENV]:
            codexHomeDigest(options.paths.codexHome),
          [TOOLS_CODEX_RUN_ID_ENV]: runId,
          ...toolCodexRuntimeEnv(runtimeBinding),
        });
        const result = await runCommand(options.codexBin ?? "codex", [
          "app",
          "--enable",
          "plugins",
          workspace,
        ], { env: launchEnv });
        if (result.code !== 0) {
          throw new ToolCodexError(
            "DESKTOP_LAUNCH_FAILED",
            result.stderr || result.stdout || "codex app failed",
          );
        }
      }
      const root = await waitForControlledRoot(
        options.paths,
        runId,
        application.executablePath,
        desktopUserDataPath,
      );
      const rootStartedAt = await readProcessStartedAt(root.pid);
      if (rootStartedAt == null) {
        throw new ToolCodexError("PROCESS_START_TIME_UNAVAILABLE", "cannot read Codex Desktop root process start time");
      }
      const marker: ToolCodexRunMarkerV1 = {
        appPath: application.appPath,
        codexHome: options.paths.codexHome,
        desktopUserDataPath,
        desktopVersion: await readDesktopVersion(application),
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
  const candidates = processes.filter((entry) => {
    const windowsCommand = entry.command.replaceAll("/", "\\");
    return entry.command.includes("/Codex.app/")
      || /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|resources\\codex)\.exe(?:["\s]|$)/i
        .test(windowsCommand)
      || entry.command.includes(paths.codexHome);
  });
  const matches: number[] = [];
  for (const candidate of candidates) {
    const stamps = await readProcessEnvironmentValues(candidate.pid, [
      TOOLS_CODEX_RUN_ID_ENV,
      TOOLS_CODEX_HOME_DIGEST_ENV,
    ]);
    if (
      stamps[TOOLS_CODEX_RUN_ID_ENV] === identity.runId
      && stamps[TOOLS_CODEX_HOME_DIGEST_ENV] === codexHomeDigest(paths.codexHome)
    ) {
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
