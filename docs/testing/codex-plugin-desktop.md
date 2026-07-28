# Codex plugin local distribution and Desktop acceptance

This harness validates the Codex plugin as a distribution shell homologous to
the packaged Open Design Desktop shell:

```text
shared OD suite substrate
├── channel + namespace + canonical suite paths
├── shared runtime/store + daemon data
├── Desktop shell: packaged + desktop
└── Codex shell: codex-plugin

shared coordinate: channel + namespace + runtimeVersion + runtimeDigest + protocolVersion
shell coordinate: shellType + shellVersion + shellDigest
```

The Codex plugin is distributed independently from Open Design Desktop. It does
not require an installed Open Design app or consume Desktop-only lifecycle
state. Once configured for the same channel root and namespace, both shells
resolve the same suite runtime/store and daemon data instead of maintaining
parallel copies.

The current local bootstrap accepts an explicit suite binding through
`--distribution-channel-root <absolute-path>` or
`OD_DISTRIBUTION_CHANNEL_ROOT`. It then resolves the identity's namespace with
`packages/distribution-proto`, including the same `OD_DATA_DIR` scoping rules
as packaged. Without that binding, the read-only status tool reports
`suite.configured: false`; runtime acquisition and handoff must not guess a
different root. Runtime acquisition additionally requires
`--runtime-manifest-url` or `OD_CODEX_PLUGIN_RUNTIME_MANIFEST_URL`; the two
bindings are supplied together by the acceptance control plane.
The plugin `.mcp.json` explicitly forwards these variables (plus optional
`OD_DATA_DIR`) into its stdio server; arbitrary host environment is not
implicitly inherited by plugin MCP processes.

The MCP catalog is static from initialize: `get_open_design_status` remains
read-only, while `ensure_open_design_runtime` lazily acquires or attaches the
exact runtime. Acquisition uses the shared runtime store and lease below the
suite namespace, writes a Codex-only handoff journal, starts the runtime
detached, validates its one-time ready-file token digest and loopback identity,
then advances the shared binding and active pointer.

## Ownership and safety model

`tools-pack` builds a relocatable local Codex marketplace plus a deterministic
acceptance-only runtime probe artifact. `tools-serve` validates and serves that
artifact with an identity-bound acquisition manifest. `tools-codex` owns the
Codex Desktop acceptance lifecycle and the host-independent handoff probe.

Each acceptance environment lives at:

```text
~/.od/tools-codex/<environment-namespace>/
├── codex-home/       # dedicated CODEX_HOME
├── workspace/        # Desktop launch workspace
├── reports/          # machine-readable acceptance evidence
├── runs/             # run-local artifacts
└── namespace.json    # ownership and prepared-plugin state
```

The environment namespace is a stable local operations identity. It is
deliberately independent from the distribution namespace recorded in a plugin
build report, so one environment can be reused across successive builds.

The harness uses the real Codex Desktop installation and existing OS login
resources, but isolates Codex-owned file state through the dedicated
`CODEX_HOME`. This is not a complete application sandbox: Desktop may still
write host-level crash-reporting or framework state outside `CODEX_HOME`.

Safety rules:

- At most one Codex Desktop root instance may exist during acceptance.
- `start` fails before mutation if any Desktop root is already present.
- A controlled root receives an environment stamp and is recorded in a run
  marker.
- `stop` only targets the exact stamped root and its stamped helpers.
- Unknown process-enumeration state fails closed.
- Normal cleanup never removes credentials.
- Whole-environment deletion requires the exact canonical namespace path.

## Build the local marketplace

Channel is an explicit authoritative input. Runtime version must match it.
Plugin shell version is independent and defaults to `apps/codex-plugin`'s
package version.

```bash
pnpm tools-pack codex-plugin build \
  --channel stable \
  --namespace codex-smoke-build \
  --runtime-version 0.16.1 \
  --protocol-version 1 \
  --json
```

The default report is:

```text
.tmp/tools-pack/out/codex-plugin/namespaces/<namespace>/build-report.json
```

Its `paths.artifactRoot` is the local marketplace root and
`runtimeArtifact` records the exact generated runtime bytes, digest, entry
path, and size. The runtime digest in the identity is calculated from those
bytes; `--runtime-digest` is an optional assertion, not a second source of
truth. Paths inside the
plugin manifest and MCP config remain package-relative; absolute paths exist
only in the tool report. Generated marketplaces use `authentication: ON_USE`,
which is accepted by current Codex plugin validation while preserving the
plugin's explicit runtime boundary.

## Serve and probe the runtime handoff

Start the loopback fixture in a dedicated terminal:

```bash
pnpm tools-serve start codex-plugin \
  --build-report .tmp/tools-pack/out/codex-plugin/namespaces/codex-smoke-build/build-report.json \
  --json
```

The JSON result contains `runtimeManifestUrl`; `/report` remains the
shell-identity fixture consumed by the status path. Use one explicit absolute
channel root for the shared suite:

```bash
pnpm tools-codex handoff \
  --build-report .tmp/tools-pack/out/codex-plugin/namespaces/codex-smoke-build/build-report.json \
  --distribution-channel-root <absolute-shared-channel-root> \
  --runtime-manifest-url <runtimeManifestUrl> \
  --fixture-report-url <endpoint-origin>/report \
  --json
```

The first call must return a confirmed handoff. A repeated call must return
`attached: true` for the same exact binding. If the runtime owner later exits,
the next call may remove only that dead binding while holding the shared lease,
reuse the immutable artifact, and advance the pointer generation. A live but
unobservable or incompatible binding quick-fails instead of being replaced.

## Initialize and inspect an acceptance environment

Choose a stable environment namespace and reuse it across builds:

```bash
pnpm tools-codex init --namespace desktop-smoke
pnpm tools-codex status --namespace desktop-smoke --json
```

Initialization creates only a minimal owned directory structure and sentinel.
It does not edit the user's default `~/.codex/config.toml`. A non-empty,
unowned namespace directory is rejected instead of adopted implicitly.

On first use, check the `login` field in `status`. If the isolated home needs
authentication, log in explicitly with that home:

```bash
CODEX_HOME="$HOME/.od/tools-codex/desktop-smoke/codex-home" codex login
```

Login state is retained across ordinary prepare, cache, plugin, and run
cleanup. Credential removal is always an explicit layer.

## Prepare the generated plugin

```bash
pnpm tools-codex prepare \
  --namespace desktop-smoke \
  --build-report .tmp/tools-pack/out/codex-plugin/namespaces/codex-smoke-build/build-report.json \
  --json
```

`prepare` validates the build report and marketplace, then installs the
marketplace and plugin into the dedicated `CODEX_HOME`. Repeating it with the
same build is idempotent. A changed build replaces only the marketplace/plugin
previously recorded by that namespace sentinel.

Preparation is blocked while any Codex Desktop root is running.

## Start and stop the controlled Desktop instance

```bash
pnpm tools-codex start --namespace desktop-smoke --json
```

The tool launches through the official `codex app` entrypoint with the
namespace `CODEX_HOME`, a run stamp, the managed workspace, and the
authoritative `--enable plugins` launch override. It does not persistently
fight Codex-managed feature configuration.

If an existing Desktop instance is detected, close it and retry. The tool will
not attach to, restart, or terminate an unmanaged instance.

For release acceptance, pass the prepared build report to `start`:

```bash
pnpm tools-codex start \
  --namespace desktop-smoke \
  --build-report .tmp/tools-pack/out/codex-plugin/namespaces/codex-smoke-build/build-report.json \
  --json
```

When this run validates runtime handoff, append the same
`--distribution-channel-root <absolute-shared-channel-root>` and
`--runtime-manifest-url <runtimeManifestUrl>` pair used by the standalone
probe. The controlled Desktop root and plugin MCP inherit the pair; no default
Codex config file is edited.

The controlled Desktop root is recorded first. The command then observes the
Desktop app-server loading the prepared plugin and writes
`reports/desktop-host-load.json`.

```text
controlled Desktop root
└── Desktop app-server
    ├── exact inherited run/home stamp
    ├── Codex Desktop client provenance
    └── open-design plugin MCP initialization
```

The harness captures a live app-server -> plugin MCP process chain when
available. Because Desktop may initialize and terminate a plugin MCP before an
external poll sees it, the durable fallback reads the managed app-server log
for the exact current app-server PID, Desktop client version, plugin name, and
shell version. The cached plugin's `distribution.json` must independently
match the complete build identity. A log from another PID, Desktop run, home,
version, or cache cannot satisfy the gate.

If host-load observation needs to be retried without restarting Desktop:

```bash
pnpm tools-codex capture-host-load \
  --namespace desktop-smoke \
  --build-report .tmp/tools-pack/out/codex-plugin/namespaces/codex-smoke-build/build-report.json \
  --json
```

`start` without `--build-report` remains available for initial login or host
diagnosis. A host-load timeout does not authorize adoption or termination of
an unmanaged instance.

After the checkpoint:

```bash
pnpm tools-codex stop --namespace desktop-smoke --json
```

Normal stop sends a graceful termination to stamped processes and then
reconciles stamped orphan helpers. Use `--force` only when the reported
controlled processes do not exit; force mode still cannot target an unstamped
process.

## Run the automated plugin invocation

While the same controlled Desktop run is active:

```bash
pnpm tools-codex invoke \
  --namespace desktop-smoke \
  --build-report .tmp/tools-pack/out/codex-plugin/namespaces/codex-smoke-build/build-report.json \
  --json
```

`invoke` runs an ephemeral, read-only `codex exec` against the same managed
`CODEX_HOME`. It uses `approval_policy=on-request` with
`approvals_reviewer=auto_review`, so side-effecting MCP calls retain their
truthful annotations while eligible low/medium-risk approval requests can be
reviewed without an operator click. Reviewer denial or failure remains a hard
failure. Without runtime binding flags it accepts only one
completed `open-design/get_open_design_status` call. With the same explicit
channel-root/manifest pair, it instead requires exactly one completed
`open-design/ensure_open_design_runtime` call. Both lanes require an exact
structured shell identity and completed terminal turn. The report is written
to `reports/automated-invocation.json`.

Transient incomplete turns may be retried up to two attempts by default.
Identity mismatch, duplicate target calls, explicit tool failure, and
invocation-owned process residue are not treated as transient success. Every
attempt carries a unique environment stamp so cleanup cannot target Desktop's
own plugin process.

## Combine acceptance evidence

Run:

```bash
pnpm tools-codex accept \
  --namespace desktop-smoke \
  --build-report .tmp/tools-pack/out/codex-plugin/namespaces/codex-smoke-build/build-report.json \
  --json
```

For a handoff run, pass the same channel-root/manifest pair again so the stdio
acceptance probe validates the runtime tool as well as the saved Desktop and
Codex-exec evidence.

The default automated gate uses two independent evidence lanes:

- `desktopHostLoaded`: current controlled Desktop run loaded the exact cached
  plugin through its own app-server.
- `automatedInvocation`: same run and managed home completed the exact plugin
  tool call through Codex JSONL.

`desktopUiObserved` is optional low-frequency operator evidence. It never gets
inferred from CLI output. If supplied through `--desktop-ui-observation`, it
must use this provenance envelope:

```json
{
  "schemaVersion": 1,
  "capturedAt": "2026-07-27T12:00:00.000Z",
  "provenance": {
    "kind": "operator-captured-desktop-ui",
    "runId": "<current tools-codex run id>"
  },
  "server": "open-design",
  "tool": "get_open_design_status",
  "structuredContent": {
    "identity": {
      "channel": "stable",
      "namespace": "codex-smoke-build",
      "protocolVersion": 1,
      "runtimeDigest": "sha256:<64-lowercase-hex>",
      "runtimeVersion": "0.16.1",
      "shellDigest": "sha256:<64-lowercase-hex>",
      "shellType": "codex-plugin",
      "shellVersion": "0.1.0"
    }
  }
}
```

Raw tool JSON without explicit Desktop run provenance is rejected instead of
being allowed to masquerade as Desktop UI evidence. For a handoff UI
checkpoint, the same envelope may use
`"tool": "ensure_open_design_runtime"` while retaining the complete shell
identity in `structuredContent.identity`.

Possible statuses:

- `PASS`: artifact/plugin checks pass and both current-run automated evidence
  lanes exactly match the build identity.
- `OPERATOR_ACTION_REQUIRED`: automated product checks pass, but login,
  controlled start, host-load capture, or invocation evidence remains.
- `BLOCKED_BY_HOST_STATE`: Codex CLI/Desktop is missing, an unmanaged Desktop
  is running, or process state cannot be proven safe.
- `FAIL`: the artifact, stdio MCP, prepared plugin, current-run evidence, or
  explicitly supplied Desktop UI identity is inconsistent.

Reports are retained under the namespace `reports/` directory.

## Optional deterministic fixture

For runtime-transport development, start the build-bound loopback fixture:

```bash
pnpm tools-serve start codex-plugin \
  --build-report .tmp/tools-pack/out/codex-plugin/namespaces/codex-smoke-build/build-report.json \
  --json
```

The dynamic port is transport-only and must not change channel, distribution
namespace, versions, digests, protocol version, or artifact paths.

## Layered cleanup

Inspect status before cleanup, then select the narrowest layer:

```bash
pnpm tools-codex clean --namespace desktop-smoke --layer runs
pnpm tools-codex clean --namespace desktop-smoke --layer plugin
pnpm tools-codex clean --namespace desktop-smoke --layer cache
pnpm tools-codex clean --namespace desktop-smoke --layer control
```

Credential removal is separate:

```bash
pnpm tools-codex clean --namespace desktop-smoke --layer credentials
```

Deleting the entire environment requires exact-target confirmation:

```bash
pnpm tools-codex clean \
  --namespace desktop-smoke \
  --layer home \
  --confirm-home "$HOME/.od/tools-codex/desktop-smoke"
```

Cleanup fails closed while Desktop root state is running or unknown. The
`credentials` layer removes only the managed home's file credential; OS
credential-store entries remain host-owned.

## Failure triage

- Build report rejected: inspect channel/version consistency, digest form,
  sorted inventory, and path containment.
- Marketplace rejected: regenerate it and confirm the authentication policy is
  `ON_USE`.
- Stdio probe failed: run generated `mcp/server.mjs` from `paths.shellRoot`;
  package-relative paths must survive copying the whole plugin elsewhere.
- Start blocked: close every Codex Desktop root, then rerun `status`; never
  bypass the singleton preflight with a manual process kill inside the tool.
- Controlled stop incomplete: inspect the stamped PID list in the result,
  retry with `--force`, and retain the namespace reports if helpers survive.
- Host-load capture timeout: keep the controlled instance running, retry
  `capture-host-load`, and inspect the report's process-chain checks before
  treating it as a package defect.
- Invocation failed: inspect attempt terminal state, target call count,
  diagnostics, and residual cleanup. Retries intentionally do not mask identity
  mismatch or duplicate tool calls.
- Stale evidence: rerun `capture-host-load` and `invoke` for the current run;
  reports from a previous controlled run are unavailable, not current proof.
- Identity mismatch: retain the build report and all three reports. Do not
  repair generated identity or evidence files by hand.

## Current first-version boundary

This proves the shell/distribution seam and establishes a repeatable Desktop
acceptance control plane. Cloud/account flows, complete capability parity,
runtime auto-update, bootstrap handoff, and `minCodexPluginVersion` remain
follow-up phases.
