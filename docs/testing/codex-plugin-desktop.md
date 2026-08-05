# Codex plugin local distribution and Desktop acceptance

The release-blocking capability ledger and evidence requirements are defined
in [`codex-plugin-delivery-validation.md`](./codex-plugin-delivery-validation.md).
This document is the operational runbook for producing that evidence.

The Codex plugin is a distribution shell parallel to packaged Open Design:

```text
shared coordinate: channel + namespace + data
shell identity: shellType + shellVersion + shellDigest

platform plugin artifact
├── .mcp.json
├── Node 24 execution carrier
├── MCP bundle
├── skills/assets
└── distribution.json

external product runtime store
├── acquisition manifest
├── immutable versions
├── lease
├── binding + active pointer
└── ready handoff journal
```

The shell artifact is installed and updated only through Codex plugin native
capabilities. It does not download Node or another shell environment before
MCP initialize. Product runtime acquisition starts only when
`ensure_open_design_runtime` is called and does not affect plugin ZIP size.

## Platform targets

`tools-pack codex-plugin build` produces one platform-specific marketplace:

- `darwin-arm64` → `./bin/node`
- `win32-x64` → `./bin/node.exe`

The MCP entry is relative to the installed plugin cache, does not use user
`PATH`, and declares:

- startup timeout: 10 seconds;
- tool timeout: 120 seconds;
- forwarded runtime inputs:
  `OD_CODEX_PLUGIN_RUNTIME_MANIFEST_URL`, `OD_DATA_DIR`,
  `OD_DISTRIBUTION_CHANNEL_ROOT`.

Controlled Desktop acceptance supports macOS and native x64 Windows. The
Windows lane includes artifact build, offline stdio, marketplace
install/update, MSIX/process discovery, and controlled Desktop lifecycle. Both
platforms use the same operator-driven Desktop acceptance contract. The native
`win32-x64` reader returns only explicitly requested environment stamps;
failure yields no ownership evidence.

## Build a local marketplace

Channel and runtime version are authoritative inputs. Shell version defaults to
`apps/codex-plugin/package.json`.

```bash
pnpm tools-pack codex-plugin build \
  --channel stable \
  --namespace codex-smoke-build \
  --platform win32-x64 \
  --carrier-path <node-24-executable> \
  --runtime-version 0.16.1 \
  --protocol-version 2 \
  --json
```

When the build host matches a supported target, `--platform` defaults to that
host and `--carrier-path` defaults to `process.execPath`. Builds must run on
the target host because the builder executes the carrier to verify Node 24 and
the exact platform architecture.

The report path is:

```text
.tmp/tools-pack/out/codex-plugin/namespaces/<namespace>/<platform>/build-report.json
```

`paths.artifactRoot` is the relocatable marketplace.
With `--runtime-mode production`, `runtimeArtifact` is a ZIP containing the
real daemon, static web, required internal packages, and resources. It is
published independently from the marketplace shell. The default fixture mode
remains available for cheap protocol tests. `artifact.files` includes the
platform carrier and excludes the generated `distribution.json`; the identity
binds its digest as `shellDigest`.

The Windows shell also bundles the matching 7-Zip extractor. Production
runtime startup uses a private named-pipe environment handoff and creates the
runtime outside the ephemeral Codex CLI process job, so a confirmed runtime
can remain available after `codex exec` exits.

## Offline shell gate

Before Desktop acceptance:

1. Verify the build report and artifact inventory.
2. Read the artifact's `.mcp.json`.
3. Confirm the command is a relative verified artifact entry.
4. Start from `paths.shellRoot` with network unavailable and no PATH Node.
5. Require initialize, `tools/list`, and `get_open_design_status` within
   10 seconds.
6. Confirm the returned identity exactly matches the build report.

`tools-codex` performs this probe from the declared artifact entry. It must not
replace the command with `/bin/sh`, system Node, or a Codex-internal Node.

## Runtime fixture and handoff

Start the identity-bound loopback fixture:

```bash
pnpm tools-serve start codex-plugin \
  --build-report <build-report> \
  --promotion-build-report <next-build-report> \
  --json
```

The result exposes `runtimeManifestUrl` and, when a next report is configured,
an unguessable `promotionUrl`; `/report` remains the status fixture. A
`POST <promotionUrl>` validates the pre-bound next build before switching
`latest`. The fixture no longer serves an environment/Node artifact.

After the managed environment is initialized and the matching plugin is
prepared as described below, probe runtime acquisition:

```bash
pnpm tools-codex handoff \
  --namespace desktop-smoke \
  --build-report <build-report> \
  --distribution-channel-root <absolute-shared-channel-root> \
  --runtime-manifest-url <runtimeManifestUrl> \
  --fixture-report-url <endpoint-origin>/report \
  --json
```

The first call downloads and verifies the external runtime, writes it under the
immutable runtime store, starts it, validates the one-time ready token and
loopback identity, then confirms the binding/pointer. A repeated call attaches
to the compatible binding. Runtime launch is pre-armed in `attempt.json`; ready
confirmation clears that attempt and advances `active.json`, whose pointer is
therefore the local last-known-good runtime. A successful handoff records the
exact runtime binding under the prepared plugin state. Replacing the prepared
plugin clears that binding.

A live incompatible or unobservable binding fails closed. A dead binding may
be replaced only while holding the runtime lease. Concurrent acquisition must
eventually use bounded observe-and-attach rather than stealing a live lease.
Cold start is availability-first: when `latest/runtime.json` is unreachable,
the shell selects the compatible installed active runtime and does not make the
remote feed a startup dependency. An unconfirmed immutable attempt is not
retried while a confirmed active runtime exists; a different later release may
advance normally.

## Non-Desktop runtime lifecycle gate

Desktop acceptance proves that the installed plugin is visible and usable in
the real UI. It is not the runtime updater test harness. Verify the external
runtime lifecycle with:

- a target-host `tools-pack codex-plugin build` for each runtime fixture;
- one isolated, authenticated `CODEX_HOME` with the packed plugin installed;
- one task-owned `OD_DISTRIBUTION_CHANNEL_ROOT`;
- a loopback `tools-serve` Codex plugin fixture;
- real `codex --enable plugins exec --json` calls to
  `ensure_open_design_runtime`.

Immediately before every real CLI acceptance call, run:

```bash
pnpm tools-codex auth-check --namespace <environment-namespace> --json
```

This no-network preflight requires a managed login and rejects a credential
file copied or linked from the default Codex home.

The fixture's programmatic or loopback HTTP promotion keeps the same
`runtimeManifestUrl`, loads and validates the next build report before
switching `latest`, and continues serving all earlier immutable artifact URLs.
It rejects channel/namespace/protocol or shell identity drift, latest rollback,
and different bytes published at an existing runtime version URL.

The required lifecycle sequence is:

1. Acquire N through the installed plugin and confirm its manifest, binding,
   active pointer, immutable store entry, and ready handoff.
2. While N remains alive, promote `latest` to N+1 and require the next ensure
   call to attach N without waiting for the feed. Require update state
   `deferred` in the response and persisted `available` after the best-effort
   background check.
3. Stop only the exact runtime PID from the confirmed binding. Runtime takeover
   and cross-shell exit orchestration are intentionally outside this cold-start
   scope.
4. Repeat handoff through the original installed shell. Require acquisition of
   N+1, retention of both immutable version directories, and a current identity
   whose shell fields are unchanged while runtime fields advance.
5. Invoke the same installed plugin through real
   `codex --enable plugins exec --json`; require `attached:true` and
   `reusedArtifact:true` for N+1.
6. Make the manifest endpoint unavailable, stop N+1 precisely, and require a
   cold start from the installed N+1 artifact after no more than a 500 ms
   remote budget. Require update state `unavailable`.
7. Stop that exact offline-started N+1 runtime, then promote to a validly
   hashed N+2 runtime that exits before ready. Require the tool call to fail,
   `attempt.json` to identify N+2, and the active pointer to remain on N+1 with
   no live binding or temporary ready state. Repeat the call against the same
   latest manifest and require automatic startup of N+1 while preserving the
   N+2 attempt evidence.
8. Stop that exact rollback N+1 runtime, promote a valid N+3 release, and
   require it to self-heal the runtime state: active advances to N+3 and
   `attempt.json` is removed after ready confirmation.
9. Serve a newer manifest whose minimum shell version excludes the installed
   shell; require selection and startup of the newest compatible installed
   runtime instead.

The production runtime is detached after a confirmed handoff and can outlive an
ephemeral `codex exec` host. Do not infer exit from CLI completion. Preserve
Codex JSONL, fixture identity, `active.json`, binding evidence, exact controlled
exit evidence, failed-attempt evidence when applicable, and immutable store
inventory as the acceptance record. No UI screenshot is required for this
non-Desktop gate.

`get_open_design_status` reports the immutable identity embedded when the shell
was built. After runtime promotion, `ensure_open_design_runtime` is the
authoritative current identity: it combines those shell fields with the
selected binding's runtime fields.

For non-interactive CLI acceptance, a mutating MCP tool still follows Codex's
approval policy. Use an operator-persisted approval or the explicitly
controlled `--dangerously-bypass-approvals-and-sandbox` acceptance invocation;
`--ask-for-approval never` cancels the tool call rather than approving it.
Do not pass `--ignore-user-config`: plugin installation and enablement are
stored in the managed `CODEX_HOME/config.toml`, so ignoring that configuration
invalidates the host-integration probe.

## Production publication

The runtime publisher consumes the target-host build report and writes only
the Codex plugin R2 hierarchy:

```text
codex-plugin/<channel>/<namespace>/<platform>/
├── latest/runtime.json
└── versions/<runtime-version>/runtime/runtime.zip
```

Run a side-effect-free plan locally:

```bash
CODEX_PLUGIN_BUILD_REPORT=<build-report> \
CODEX_PLUGIN_PLATFORM=darwin-arm64 \
CODEX_PLUGIN_PUBLICATION_REPORT=<report.json> \
RELEASE_PUBLIC_ORIGIN=https://releases.open-design.ai \
RELEASE_PUBLISH_SIDE_EFFECTS=false \
pnpm tools-release publish-codex-plugin
```

Immutable runtime uploads refuse replacement. `latest` uses conditional writes
and refuses rollback or a same-version digest change. `release-beta` builds and
plans this payload on the native macOS arm64 and Windows x64 jobs, publishing
it only when the workflow's existing `publish` input is true.

## Managed acceptance environment

Each environment lives under:

```text
~/.od/tools-codex/<environment-namespace>/
├── codex-home/
├── desktop-user-data/
├── workspace/
├── reports/
├── runs/
└── sentinel.json
```

The environment namespace is independent from the distribution namespace.
Initialization never edits the default `~/.codex/config.toml` or adopts a
non-empty unowned directory.

```bash
pnpm tools-codex init --namespace desktop-smoke
pnpm tools-codex status --namespace desktop-smoke --json
```

If login is required:

```bash
CODEX_HOME="$HOME/.od/tools-codex/desktop-smoke/codex-home" codex login
```

Windows controlled start requires a ChatGPT login in the managed home:

```powershell
$env:CODEX_HOME = "$HOME\\.od\\tools-codex\\desktop-smoke\\codex-home"
codex login
```

The managed home must receive its own login. Never copy, hard-link, or
symlink `auth.json` from the default Codex home: ChatGPT OAuth refresh tokens
rotate, and concurrent reuse can invalidate the source session. For cleanup,
use `tools-codex clean --layer credentials` to remove only the managed auth
file instead of treating a personal credential as disposable test data.

Run `tools-codex auth-check --namespace desktop-smoke --json` after login and
before any real CLI or Desktop acceptance call.

`tools-codex start` fails with `DESKTOP_LOGIN_REQUIRED` before opening
Desktop when this precondition is missing.

Prepare while Desktop is stopped:

```bash
pnpm tools-codex prepare \
  --namespace desktop-smoke \
  --build-report <build-report> \
  --json
```

Preparation verifies the artifact, adds the marketplace, and installs the
plugin into the dedicated home. Repeating the same build is idempotent; a new
plugin version replaces the previous versioned cache through Codex itself.
On Windows, preparation also computes the final cached MCP command path before
install. Paths longer than 259 characters fail with
`WINDOWS_PLUGIN_CACHE_PATH_TOO_LONG`; shorten the tools-codex state root,
distribution namespace, or development shell version. Keep local cachebuster
versions compact because the shell version is part of Codex's cache path.

## Controlled Desktop lane

On a supported macOS or native x64 Windows host:

```bash
pnpm tools-codex start \
  --namespace desktop-smoke \
  --json
```

On macOS, the official `codex app` entry receives the isolated home, run id,
home digest, workspace, and plugin feature override. On Windows, a restricted
basic-user helper starts the exact installed MSIX `app\ChatGPT.exe` with
process-local home/run inputs. The root receives both
`CODEX_ELECTRON_USER_DATA_PATH` and the same explicit `--user-data-dir`, so
Owl/Chromium and Electron stay inside `desktop-user-data/`. Start fails if any
Desktop root already exists. The tool never adopts or stops an unmanaged
instance.

`start` reads the runtime binding previously verified by `handoff`; it never
accepts a manifest URL or distribution channel directly. If no verified
binding exists, Desktop starts in the status-only lane.

While the run remains controlled, the operator opens a fresh Desktop chat and
requests exactly one Open Design tool call:

- without runtime binding: `get_open_design_status`;
- with runtime binding: `ensure_open_design_runtime`.

Capture a PNG screenshot that shows the Desktop surface, prompt, completed
tool result, and complete distribution identity. Then bind the screenshot to
the current controlled run and exact build:

```bash
pnpm tools-codex record-ui \
  --namespace desktop-smoke \
  --build-report <build-report> \
  --screenshot <desktop-screenshot.png> \
  --tool ensure_open_design_runtime \
  --operator <operator-name> \
  --json
```

`record-ui` rejects a screenshot that predates the current run, verifies that
it is a regular PNG, copies it into the managed reports directory, hashes it,
and records explicit operator provenance, outcome, tool, run id, and build
identity. It does not inspect or automate the Desktop UI; the operator owns the
visual judgment.

Finish acceptance:

```bash
pnpm tools-codex accept \
  --namespace desktop-smoke \
  --build-report <build-report> \
  --json
```

`accept` consumes the same recorded binding and fixture report as `start`.
Without a verified handoff it expects the status-only lane. It combines
artifact inventory, offline stdio, installed plugin, current controlled host
state, and the operator screenshot observation. Automated Desktop invocation,
keyboard/mouse/clipboard automation, and internal host-load evidence are not
acceptance requirements.

Stop only the controlled run:

```bash
pnpm tools-codex stop --namespace desktop-smoke --json
```

## Windows controlled-host gate

Windows status resolves the installed package/AUMID, exact full-trust
executable, root PID/PPID, command line, and creation time. A pre-existing
instance returns `running-unmanaged`.

The Windows ownership primitives also:

- read only requested run/home environment stamps from native x64 processes;
- bind the exact package-local root executable, PID, creation time, managed
  home, run stamp, and isolated Chromium user-data path.

Cold-host validation for Codex CLI 0.145.0 and Windows MSIX 26.721.4979.0
established:

- `codex app` opened the requested workspace through `codex://` activation,
  but the resulting Desktop root and app-server had no `CODEX_HOME`, run id,
  or home-digest stamp;
- directly starting the exact package-local `app\ChatGPT.exe` produced the
  same result when launched from an elevated caller because Owl de-elevation
  discarded the temporary environment;
- `runas /trustlevel:0x20000` creates a restricted same-user helper whose final
  root preserves `CODEX_HOME`, run id, home digest, and runtime inputs for its
  descendants;
- `CODEX_ELECTRON_USER_DATA_PATH` alone does not isolate Owl's outer Chromium
  profile;
- pairing it with the same `--user-data-dir` produced isolated profile writes
  and zero default-profile writes in the controlled run;
- the controlled marker/start/status/stop lifecycle completed without forced
  cleanup;
- unauthenticated workspace deep-link startup rendered a blank `/` route, so
  Windows start now requires prior ChatGPT login in the managed home.

The restricted helper is not a global compatibility shim: it consumes one
run-scoped payload, writes one atomic non-admin handshake, and exits. No user
environment, registry, scheduled task, marker backfill, or process adoption is
allowed.

When an unstamped MSIX Desktop root exists, Windows `status` reports
`running-unmanaged`, including roots whose exact `ChatGPT.exe` command contains
app launch arguments. Only the operator may close that instance.

## Operator UI checkpoint

The operator screenshot is the authoritative Desktop product acceptance
evidence on both macOS and Windows. Missing current-run screenshot evidence
returns `OPERATOR_ACTION_REQUIRED`; it is not inferred from CLI output, logs,
or process state.

Do not use global keyboard/mouse/clipboard automation, delete chats, rewrite
reports, or claim a PASS from an image that does not visibly show the prompt,
completed tool result, and complete distribution identity.

## Statuses

- `PASS` — artifact, stdio, installed plugin, controlled run, and the
  operator-confirmed screenshot agree.
- `OPERATOR_ACTION_REQUIRED` — machine checks do not show a product failure,
  but login, controlled start, or current-run screenshot evidence is
  incomplete.
- `BLOCKED_BY_HOST_STATE` — Desktop/CLI is missing, unmanaged, multiple, or
  unprovable.
- `FAIL` — artifact, identity, MCP, screenshot digest/tool, or explicit
  operator outcome is inconsistent.

## Cleanup

Use the narrowest layer:

```bash
pnpm tools-codex clean --namespace desktop-smoke --layer runs
pnpm tools-codex clean --namespace desktop-smoke --layer plugin
pnpm tools-codex clean --namespace desktop-smoke --layer cache
pnpm tools-codex clean --namespace desktop-smoke --layer control
```

Credential removal and whole-home deletion are explicit exceptional actions.
Cleanup fails closed while Desktop state is running or unknown.

## Failure triage

- Build report rejected: inspect channel/version, sorted inventory, digest, and
  path containment.
- MCP probe failed: inspect the generated relative command and carrier target;
  do not substitute a host runtime.
- Marketplace rejected: verify `ON_USE` policy and platform-specific report
  path.
- Start blocked: close every Desktop root and rerun status.
- `DESKTOP_LOGIN_REQUIRED`: authenticate the managed `CODEX_HOME` with
  ChatGPT, then retry start. Do not copy the default profile or auth file.
- Blank Windows window from an older run: preserve its logs for diagnosis,
  stop it only through its valid marker, authenticate the managed home, and
  retry.
- Screenshot rejected as stale: capture a new PNG during the current
  controlled run and rerun `record-ui`.
- Screenshot digest mismatch: retain the observation and image for diagnosis;
  do not rewrite either file to force a PASS.
- Identity mismatch: retain the build report and reports; never repair
  generated identity by hand.
