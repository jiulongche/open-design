# tools/codex/AGENTS.md

Follow the repository root `AGENTS.md` and `tools/AGENTS.md` first. This file
owns the focused maintenance map and hot operations for the Codex Desktop
acceptance control plane. The complete distribution model, report schemas, and
long-form explanations remain in `docs/testing/codex-plugin-desktop.md`.

## Scope and operating model

`tools/codex` manages one persistent, namespaced Codex acceptance environment
under `~/.od/tools-codex/<environment-namespace>`. It prepares a packed
`apps/codex-plugin` marketplace, starts and stops only a positively owned Codex
Desktop process tree, captures Desktop host-load evidence, invokes the plugin
through same-home `codex exec`, combines evidence, and performs exact layered
cleanup.

The current Desktop UI lane is intentionally operator-assisted:

- The operator opens a new Desktop chat, enters the acceptance prompt, and
  confirms the visible result.
- The tool owns preflight, plugin preparation, controlled lifecycle,
  host-load provenance, structured invocation, identity checks, reports, and
  process cleanup.
- Ordinary acceptance must not use `osascript`, global keystrokes, mouse
  coordinates, clipboard replacement, or Accessibility automation to enter the
  prompt.
- Do not delete or rewrite Desktop chats, drafts, window state, or host-owned
  Desktop data as cleanup.
- VM-based macOS and Windows UI automation is a future higher-confidence lane,
  not a prerequisite for this control plane.

`CODEX_HOME` isolates Codex configuration, credentials, plugin cache, and the
managed workspace. It does not fully isolate Desktop framework state or
`~/Library/Application Support/Codex`; treat restored windows, macOS Spaces,
crash reporting, and similar host state as external.

## Core file index

Control-plane implementation:

- `src/index.ts` — CLI commands, flags, exit behavior, and command composition.
- `src/state.ts` — managed paths, owner/sentinel metadata, run markers, the
  global Desktop lock, atomic reports, and restrictive file modes.
- `src/host.ts` — Codex CLI/Desktop discovery, fail-closed host status,
  controlled start/stop, run stamps, and process ownership checks.
- `src/plugin.ts` — marketplace preparation, artifact and stdio validation,
  acceptance evidence evaluation, and final status classification.
- `src/desktop-evidence.ts` — current-run Desktop app-server and plugin
  host-load provenance.
- `src/invocation.ts` — ephemeral same-home `codex exec --json` invocation,
  target-tool validation, retries, and invocation-owned cleanup.
- `src/clean.ts` — exact `control`, `runs`, `plugin`, `cache`, `credentials`,
  and `home` cleanup layers.

Tests:

- `tests/state.test.ts` — namespace ownership, state paths, and report
  persistence.
- `tests/host.test.ts` — root detection, run ownership, and command lifecycle.
- `tests/plugin.test.ts` — prepare, artifact integrity, acceptance
  classification, and UI evidence parsing.
- `tests/desktop-evidence.test.ts` — host-load provenance and stale/mismatched
  evidence rejection.
- `tests/invocation.test.ts` — exact tool call, terminal state, retry, stdin,
  and residual-process behavior.
- `tests/clean.test.ts` — layered cleanup and exact-target safety.

Adjacent owners:

- `apps/codex-plugin/src/server.ts` — plugin-owned stdio MCP server.
- `apps/codex-plugin/src/identity.ts` — embedded distribution identity.
- `apps/codex-plugin/plugin/open-design/` — Codex manifest, skill, and assets.
- `packages/distribution-proto/src/index.ts` — neutral identity, report, path,
  version, digest, and canonical artifact-inventory rules.
- `tools/pack/src/codex-plugin.ts` — relocatable marketplace and build report.
- `tools/serve/src/codex-plugin-fixture.ts` — optional identity-bound loopback
  fixture.
- `docs/testing/codex-plugin-desktop.md` — full operator guide and evidence
  envelope.

## Safety invariants

- A pre-existing or unprovable Codex Desktop root blocks mutation. Never adopt,
  restart, or terminate it through `tools-codex`.
- A controlled instance is owned only by the exact namespace run marker and
  inherited run/home stamps. `stop` and `--force` cannot target unstamped
  processes.
- The global Desktop lock is shared across environment namespaces because
  Desktop is a user-level singleton.
- The environment namespace and distribution namespace are independent. Do not
  derive one from the other.
- `prepare` and cleanup require a stopped, known host state.
- Credentials survive ordinary prepare, run, plugin, cache, and control
  cleanup. Credential removal is explicit.
- Whole-home deletion requires the exact canonical namespace path and must
  never be inferred from a broad path, glob, or unresolved variable.
- Keep reports and mismatched build artifacts intact during diagnosis. Do not
  repair identity or evidence JSON by hand.
- Nix is not part of this control plane's current acceptance gate.

## Hot path: local distribution and automated evidence

Use a stable environment namespace across builds. `desktop-smoke` is the
maintainer convention below. The examples consume the existing `codex-smoke`
distribution build; replace only that path segment for a different packed
build.

Initialize once and inspect host state:

```bash
pnpm tools-codex init --namespace desktop-smoke
pnpm tools-codex status --namespace desktop-smoke --json
```

If `loggedIn` is false, perform one explicit login against the managed home:

```bash
CODEX_HOME="$HOME/.od/tools-codex/desktop-smoke/codex-home" codex login
```

Prepare while Desktop is stopped:

```bash
pnpm tools-codex prepare \
  --namespace desktop-smoke \
  --build-report .tmp/tools-pack/out/codex-plugin/namespaces/codex-smoke/build-report.json \
  --json
```

Start the controlled Desktop and capture host-load evidence:

```bash
pnpm tools-codex start \
  --namespace desktop-smoke \
  --build-report .tmp/tools-pack/out/codex-plugin/namespaces/codex-smoke/build-report.json \
  --json
```

While the same controlled run is active, capture the structured invocation:

```bash
pnpm tools-codex invoke \
  --namespace desktop-smoke \
  --build-report .tmp/tools-pack/out/codex-plugin/namespaces/codex-smoke/build-report.json \
  --json
```

Combine the two current-run automated evidence lanes:

```bash
pnpm tools-codex accept \
  --namespace desktop-smoke \
  --build-report .tmp/tools-pack/out/codex-plugin/namespaces/codex-smoke/build-report.json \
  --json
```

Stop the controlled instance after evidence and operator checkpoints are
complete:

```bash
pnpm tools-codex stop --namespace desktop-smoke --json
```

## Hot path: operator-assisted Desktop UI checkpoint

Perform this checkpoint after `start --build-report` succeeds and before
`stop`. The operator, not an automation script, owns the visible UI actions:

1. Switch to the controlled Codex Desktop instance.
2. Open a new blank chat. Do not reuse a chat that contains a draft or unrelated
   task state.
3. Enter:

   ```text
   Use the open-design plugin and call get_open_design_status exactly once.
   Return the complete structured distribution identity from the tool result.
   Do not infer it from repository files or shell commands.
   ```

4. Confirm the visible tool is `open-design/get_open_design_status`.
5. Confirm the displayed identity matches the current build report's channel,
   namespace, protocol version, runtime version/digest, and shell
   type/version/digest.
6. Leave the chat and any screenshot intact when a mismatch occurs. Do not
   rewrite evidence or delete the session to make a rerun appear clean.

The automated `invoke` lane remains required for machine-verifiable identity.
The UI checkpoint is supplemental confidence and does not get inferred from
CLI output. For formal UI evidence, create the
`operator-captured-desktop-ui` envelope documented in
`docs/testing/codex-plugin-desktop.md`, using the current run marker's `runId`,
then pass it explicitly:

```bash
pnpm tools-codex accept \
  --namespace desktop-smoke \
  --build-report .tmp/tools-pack/out/codex-plugin/namespaces/codex-smoke/build-report.json \
  --desktop-ui-observation "$HOME/.od/tools-codex/desktop-smoke/reports/operator-ui-observation.json" \
  --json
```

Do not commit UI observations, screenshots, managed reports, login state, or
task-local acceptance artifacts to the repository.

## Hot recovery paths

- `uninitialized`: run `init`; never adopt a nonempty directory without valid
  owner and sentinel metadata.
- `running-unmanaged`, multiple roots, or unknown process state: stop. Ask the
  operator to close Desktop, then rerun `status`. Do not kill or attach to the
  process through this tool.
- Not logged in: use the managed `CODEX_HOME` login command above. Do not copy
  default-home auth files into the namespace.
- Prepare rejected: regenerate the marketplace; inspect the build report,
  artifact inventory, path containment, and `ON_USE` authentication policy.
- Host-load timeout: keep the controlled run active and retry:

  ```bash
  pnpm tools-codex capture-host-load \
    --namespace desktop-smoke \
    --build-report .tmp/tools-pack/out/codex-plugin/namespaces/codex-smoke/build-report.json \
    --json
  ```

- `STALE_FOR_CURRENT_RUN`: rerun `capture-host-load` and `invoke` for the
  current marker. Previous-run reports are unavailable evidence, not failure.
- Invocation failure: inspect terminal state, target call count, diagnostics,
  and residual cleanup. Do not retry identity mismatch, duplicate target
  calls, or explicit tool failure as transient success.
- UI mismatch: retain the screenshot/observation and all reports; classify it
  separately from a passing structured invocation.
- Partial controlled stop: inspect the marker and exact stamped PID list, then
  retry only that controlled run with:

  ```bash
  pnpm tools-codex stop --namespace desktop-smoke --force --json
  ```

  If stamped processes remain, preserve the namespace and report them. Never
  broaden the process target.

## Cleanup

Use the narrowest layer and inspect `status` first:

```bash
pnpm tools-codex clean --namespace desktop-smoke --layer runs
pnpm tools-codex clean --namespace desktop-smoke --layer plugin
pnpm tools-codex clean --namespace desktop-smoke --layer cache
pnpm tools-codex clean --namespace desktop-smoke --layer control
```

Credential and whole-home cleanup are exceptional. Follow the exact commands
and safety explanation in `docs/testing/codex-plugin-desktop.md`; do not place
them in a routine cleanup sequence.

## Validation for changes

For documentation-only changes, run:

```bash
pnpm guard
git diff --check
```

For implementation changes under `tools/codex`, run:

```bash
pnpm --filter @open-design/tools-codex typecheck
pnpm --filter @open-design/tools-codex test
pnpm --filter @open-design/tools-codex build
pnpm guard
git diff --check
```

Changes to host ownership, start/stop, plugin preparation, host-load,
invocation, acceptance classification, or cleanup also require a real
controlled Desktop run on a GUI-capable macOS host. Coordinate the visible UI
checkpoint with the operator; never turn an unmanaged host session into test
state.
