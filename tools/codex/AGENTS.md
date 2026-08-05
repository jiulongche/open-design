# tools/codex/AGENTS.md

Follow the repository root `AGENTS.md` and `tools/AGENTS.md` first. This file
owns the focused maintenance map and safety rules for Codex plugin acceptance.
The operator guide and evidence model live in
`docs/testing/codex-plugin-desktop.md`.

## Operating model

`tools/codex` manages one persistent namespaced acceptance environment under
`~/.od/tools-codex/<environment-namespace>`. It:

- verifies a packed platform-targeted Codex plugin artifact;
- installs the marketplace/plugin into an isolated `CODEX_HOME`;
- probes the artifact's declared stdio MCP entry;
- starts and stops only a positively owned Desktop process tree;
- records operator-confirmed Desktop PNG evidence for the current run;
- combines machine checks with that screenshot evidence and performs exact
  layered cleanup.

The plugin shell is updated only through Codex plugin installation/update.
`.mcp.json`, the platform execution carrier, MCP bundle, skills, and embedded
identity are one immutable versioned artifact. There is no independent managed
Node/environment manifest lifecycle.

`ensure_open_design_runtime` acquires the product runtime into the external
channel/namespace runtime store. Runtime manifests, artifacts, leases,
bindings, pointers, and ready handoffs are independent from the plugin ZIP.
Verify that lifecycle separately with an isolated Codex CLI, a target-host
`tools-pack` artifact, and a promotable `tools-serve` fixture. CLI JSONL plus
the external store state are authoritative for this non-Desktop lane; a
Desktop PNG is not required.

## Platform boundary

- Plugin artifact targets: `darwin-arm64`, `win32-x64`.
- Controlled Desktop start/stop supports macOS and native x64 Windows.
- Windows static artifact, stdio, marketplace, plugin update, and controlled
  Desktop lifecycle validation are supported.
- Windows read-only status resolves the `OpenAI.Codex` MSIX/AUMID, exact
  full-trust executable, root PID/PPID, and creation time. A pre-existing root
  must report `running-unmanaged`.
- On native `win32-x64`, process evidence may read only explicitly requested
  environment stamps. Introspection failures return no evidence and never
  authorize ownership or cleanup.
- Windows start uses the exact package-local `ChatGPT.exe` through
  `runas /trustlevel:0x20000`. The restricted helper receives one task-owned
  payload, sets process-local home/run/runtime inputs, and must report a
  non-administrator handshake before marker creation.
- Full Windows profile isolation requires both
  `CODEX_ELECTRON_USER_DATA_PATH=<namespace desktop-user-data>` and the same
  explicit `--user-data-dir` argument. Either half alone is insufficient.
- Windows start requires a ChatGPT login in the managed `CODEX_HOME`.
  Unauthenticated deep-link startup is rejected before launch because this
  Desktop build renders an empty route instead of a usable login surface.
- Windows prepare must preflight the final cached MCP command path. The
  platform carrier cannot be launched when that path exceeds 259 characters;
  fail with `WINDOWS_PLUGIN_CACHE_PATH_TOO_LONG` before Codex mutates the
  marketplace or plugin installation. Prefer compact local shell versions.
- Do not inject user-global environment/registry state, adopt an existing
  root, backfill a marker, or stop an unstamped instance.
- Windows root discovery must recognize the exact installed `ChatGPT.exe`
  root even when its command contains app launch flags/URI, while excluding
  Chromium `--type=` child processes.

## Core files

- `src/index.ts` — CLI commands and option composition.
- `src/state.ts` — paths, owner/sentinel metadata, locks, markers, reports.
- `src/host.ts` — CLI/Desktop discovery and controlled lifecycle.
- `src/plugin.ts` — artifact verification, marketplace prepare, stdio probe,
  operator screenshot recording, and acceptance classification.
- `src/runtime.ts` — explicit channel-root/runtime-manifest binding.
- `src/clean.ts` — exact cleanup layers.

Adjacent owners:

- `apps/codex-plugin/src/server.ts` — plugin stdio MCP.
- `apps/codex-plugin/src/launcher.ts` — external runtime acquisition/attach.
- `apps/codex-plugin/plugin/open-design/` — plugin source assets and skills.
- `packages/codex-plugin-proto/` — platform target and runtime handoff protocol.
- `packages/distribution-proto/` — shell-neutral identity/store/report schema.
- `tools/pack/src/codex-plugin.ts` — platform artifact and local marketplace.
- `tools/serve/src/codex-plugin-fixture.ts` — runtime-only loopback fixture.

## Safety invariants

- A pre-existing or unprovable Desktop root blocks mutation. Never adopt,
  restart, or terminate it.
- A controlled instance requires the exact namespace marker, root PID/start
  time, run stamp, Codex-home digest, and managed home. Windows additionally
  requires the exact Electron user-data environment and Chromium
  `--user-data-dir`.
- The global Desktop lock is shared across namespaces because Desktop is a
  user-level singleton.
- `prepare` and cleanup require a stopped, known host state.
- Credentials survive ordinary prepare/run/plugin/cache/control cleanup.
- Whole-home deletion requires exact canonical confirmation.
- Keep mismatched artifacts and reports intact during diagnosis.
- The stdio probe must read the verified artifact's `.mcp.json`; never
  hard-code a host shell or bypass the packaged execution carrier.
- The MCP command must remain a relative artifact entry and initialize within
  the declared timeout, which must not exceed 10 seconds.
- Desktop product acceptance is operator-driven on both macOS and Windows.
  Require a current-run PNG that visibly shows the prompt, completed tool
  result, and complete distribution identity. Do not infer UI success from
  CLI output, logs, or process state.
- Do not use the Desktop lane to prove runtime update state transitions.
  Exercise initial acquisition, live-incompatible fail-closed, stale-owner
  recovery, same-host attach, startup failure pointer preservation, and
  shell-compatibility fallback through an isolated Codex CLI instead.

## Build and handoff

Build on the target host. `--platform` may be explicit; `--carrier-path` is
only for an alternate host-native Node 24 executable:

```bash
pnpm tools-pack codex-plugin build \
  --channel stable \
  --namespace codex-smoke \
  --platform win32-x64 \
  --carrier-path <node-24-executable> \
  --runtime-version 0.16.1 \
  --protocol-version 2 \
  --json
```

The report path includes the platform:

```text
.tmp/tools-pack/out/codex-plugin/namespaces/<namespace>/<platform>/build-report.json
```

Start the runtime fixture and retain `runtimeManifestUrl`. To exercise one
explicit N to N+1 transition from another process, pre-bind the next report and
retain the unguessable `promotionUrl`:

```bash
pnpm tools-serve start codex-plugin \
  --build-report <build-report> \
  --promotion-build-report <next-build-report> \
  --json
```

`POST <promotionUrl>` validates the entire next report before atomically
switching `latest`; callers cannot supply an arbitrary path over HTTP.

After initializing the acceptance environment and preparing the matching
plugin below, probe the installed shell entry and external runtime handoff:

```bash
pnpm tools-codex handoff \
  --namespace desktop-smoke \
  --build-report <build-report> \
  --distribution-channel-root <absolute-shared-channel-root> \
  --runtime-manifest-url <runtimeManifestUrl> \
  --fixture-report-url <endpoint-origin>/report \
  --json
```

Repeated handoff should attach to the confirmed compatible binding. A live
incompatible or unobservable owner fails closed. Successful handoff records
the verified runtime binding against the prepared plugin identity.

For an update rehearsal, keep the original shell prepared, promote the feed,
confirm the live-incompatible quick fail, stop only the exact recorded runtime
PID, then repeat `handoff` with the original build report. The returned current
identity must retain the shell digest/version while advancing the runtime
digest/version. Do not prepare the N+1 report: that would test a shell reinstall
instead of runtime self-update.

## Desktop acceptance

Use a stable acceptance namespace:

```bash
pnpm tools-codex init --namespace desktop-smoke
pnpm tools-codex status --namespace desktop-smoke --json
pnpm tools-codex prepare \
  --namespace desktop-smoke \
  --build-report <build-report> \
  --json
```

Before Windows start, authenticate the managed home with ChatGPT:

```powershell
$env:CODEX_HOME = "<state-root>\\desktop-smoke\\codex-home"
codex login
```

Never copy or link an existing `auth.json` into the managed home. Codex owns
rotating ChatGPT OAuth refresh tokens; reusing one credential file across two
homes can invalidate the source login. Run an independent `codex login` with
the managed `CODEX_HOME`. Remove managed credentials with
`tools-codex clean --layer credentials`, which deletes only the managed file;
do not use a copied personal credential as acceptance-fixture material.
Before any real `codex exec` acceptance call, require the no-network credential
isolation preflight:

```powershell
pnpm tools-codex auth-check --namespace desktop-smoke --json
```

On a supported controlled host:

```bash
pnpm tools-codex start \
  --namespace desktop-smoke \
  --json

pnpm tools-codex record-ui \
  --namespace desktop-smoke \
  --build-report <build-report> \
  --screenshot <desktop-screenshot.png> \
  --tool get_open_design_status \
  --operator <operator-name> \
  --json

pnpm tools-codex accept \
  --namespace desktop-smoke \
  --build-report <build-report> \
  --json

pnpm tools-codex stop --namespace desktop-smoke --json
```

After a successful handoff, `start` and `accept` automatically consume the
recorded binding; neither command accepts runtime URLs or channel paths.
Record `ensure_open_design_runtime` instead of `get_open_design_status`.
Without a recorded handoff, both commands use the status-only lane.

The operator Desktop UI checkpoint is required for PASS. `record-ui` copies
the PNG into the managed reports directory and binds its digest, current run,
tool, operator, outcome, and exact build identity. Do not use global
keyboard/mouse/clipboard automation, delete chats, or rewrite evidence.

## Recovery and cleanup

- `running-unmanaged`, multiple roots, or unknown process state: stop and ask
  the operator to close Desktop; do not mutate it.
- Prepare rejected: inspect artifact inventory, relative MCP entry, identity,
  `ON_USE` marketplace policy, and the projected Windows cache command path.
- Screenshot stale or mismatched: retain the observation and image, capture a
  new current-run PNG, and rerun `record-ui`; never edit evidence into a PASS.
- Partial controlled stop: retry only the recorded stamped run with `--force`.

Use the narrowest cleanup layer:

```bash
pnpm tools-codex clean --namespace desktop-smoke --layer runs
pnpm tools-codex clean --namespace desktop-smoke --layer plugin
pnpm tools-codex clean --namespace desktop-smoke --layer cache
pnpm tools-codex clean --namespace desktop-smoke --layer control
```

Credential and whole-home cleanup remain exceptional and explicit.

## Validation

For implementation changes:

```bash
pnpm --filter @open-design/tools-codex typecheck
pnpm --filter @open-design/tools-codex test
pnpm --filter @open-design/tools-codex build
pnpm guard
git diff --check
```

Host ownership or lifecycle changes additionally require a real controlled
Desktop run on the affected platform. Never convert an unmanaged session into
test state.
