# Codex plugin delivery validation contract

This document is the release-blocking coverage ledger for the Open Design
Codex plugin. It complements
[`codex-plugin-desktop.md`](./codex-plugin-desktop.md), which remains the
operator runbook.

The plugin is accepted as a distribution shell parallel to Desktop. The two
shells share OD runtime coordinates and product payload semantics, while
installation, bootstrap, host integration, and update presentation remain
shell-specific.

## Result model

Every capability below has one of these outcomes:

- `PASS`: the required machine evidence exists and all assertions passed.
- `FAIL`: product behavior or an immutable artifact violates the contract.
- `BLOCKED`: a required target host, authenticated Codex host, or operator UI
  observation is unavailable. A blocked required lane is not a release pass.
- `NOT_APPLICABLE`: the capability is explicitly outside that platform or
  release lane. This must be declared by the matrix, not inferred at runtime.

Evidence is valid only when it is bound to the exact build report identity and
contains enough provenance to reproduce the assertion. A test process exit
code without the asserted identity, state files, or artifact digest is not
sufficient for a product-level gate.

## Release lanes

| Lane | Host | Release requirement | Purpose |
| --- | --- | --- | --- |
| Protocol/unit | Linux, macOS, or Windows | Yes | Pure schemas, selectors, state transitions, and negative cases |
| macOS artifact | Native `darwin-arm64` | Yes | Node 24 carrier, relocatable marketplace, production runtime ZIP |
| macOS lifecycle | Native `darwin-arm64` | Yes | Cold start, update, rollback, self-heal, real Codex CLI |
| macOS Desktop | Native `darwin-arm64` | Yes | Installed plugin discovery and operator-observed UI tool call |
| Publication plan | Any host with the target build report | Yes | Immutable object paths, latest CAS, rollback refusal, no side effects |
| Windows artifact | Native `win32-x64` | Required for Windows beta | Carrier, bundled extraction, relocation, MAX_PATH, offline stdio |
| Windows CLI lifecycle | Native `win32-x64` | Required for Windows beta | Production runtime cold start, detach, reattach, offline fallback, real Codex CLI |
| Windows Desktop | Native `win32-x64` | Required for Windows Desktop acceptance | Controlled MSIX discovery and operator-observed UI tool call |
| Linux native artifact | Linux | `NOT_APPLICABLE` | Native Linux Codex plugin delivery is deliberately disabled |

Linux workspace CI must still execute every platform-independent protocol,
launcher, publication, and tool test. It must not construct or claim a native
Linux carrier artifact.

## Capability matrix

### A. Distribution and artifact integrity

| ID | Required assertion | Evidence and executor | Gate |
| --- | --- | --- | --- |
| `ODP-A01` | Channel, namespace, protocol, runtime version/digest, and shell identity normalize strictly; unknown fields and invalid paths fail closed. | `distribution-proto` and `codex-plugin-proto` unit tests | Required |
| `ODP-A02` | Only `darwin-arm64` and `win32-x64` are accepted native targets; Linux is rejected. | `codex-plugin-proto` and `tools-pack` negative tests | Required |
| `ODP-A03` | The marketplace contains `.codex-plugin/plugin.json`, `.mcp.json`, immutable identity, MCP bundle, skills/assets, and the target Node 24 carrier. | `tools-pack codex-plugin build` report plus inventory verification | Required per target |
| `ODP-A04` | The carrier reports Node 24 and the exact target OS/architecture on the target host. Cross-target reuse is rejected. | Target-host `tools-pack` build tests | Required per target |
| `ODP-A05` | The marketplace remains functional after relocation and uses only relative artifact entries, never user `PATH` Node. | Relocated offline stdio probe | Required per target |
| `ODP-A06` | Production runtime ZIP digest, size, declared entry, and extracted entry are verified before execution. Mutation, truncation, missing entry, or archive mismatch fails closed. | Launcher and `tools-codex` integrity tests | Required |
| `ODP-A07` | Shell digest excludes generated identity while the embedded identity and build report agree exactly. | `tools-pack` inventory tests | Required |

### B. MCP bootstrap and product surface

| ID | Required assertion | Evidence and executor | Gate |
| --- | --- | --- | --- |
| `ODP-B01` | With network unavailable and no `PATH` Node, MCP initialize, tools/list, identity resource, and status tool complete within the declared 10 second startup budget. | Packed-artifact offline stdio probe | Required per target |
| `ODP-B02` | The static catalog contains `get_open_design_status` and `ensure_open_design_runtime` with stable schemas and annotations. | `apps/codex-plugin` stdio tests plus packed probe | Required |
| `ODP-B03` | Status returns immutable shell identity, configured suite paths, fixture observation, and the last persisted runtime update status without triggering acquisition. | Status unit/stdio tests | Required |
| `ODP-B04` | Ensure returns the selected runtime manifest, exact binding, current composed identity, attach/acquire result, artifact reuse, handoff evidence, and update-check state. | Launcher and `tools-codex handoff` reports | Required |
| `ODP-B05` | Dynamic OD tools/resources/UI are served by the acquired product runtime; the shell does not depend on unsupported same-turn MCP tool-list refresh. | Real runtime handoff plus existing dynamic-refresh decision evidence | Required |

### C. Availability-first cold start

| ID | Required assertion | Evidence and executor | Gate |
| --- | --- | --- | --- |
| `ODP-C01` | A healthy compatible live binding attaches without waiting for the remote manifest. Local attach target is below 500 ms. | Launcher latency test with a non-resolving manifest fetch | Required |
| `ODP-C02` | Live attach returns update state `deferred`; the best-effort background check later persists `current`, `available`, or `unavailable`. Remote failure does not invalidate the binding. | Launcher update-status tests and persisted status snapshot | Required |
| `ODP-C03` | With a compatible installed active runtime but no live binding, remote manifest lookup has a 500 ms maximum budget, then local startup proceeds. | Fake-clock/controlled-fetch launcher test | Required |
| `ODP-C04` | With no compatible installed active runtime, first acquisition allows a 5 second manifest budget, bounds artifact download at 30 seconds, and enforces a 110 second internal end-to-end acquisition deadline below the host's 120 second tool timeout. Manifest absence returns typed `RUNTIME_UNAVAILABLE`; exhausting the total budget returns typed `RUNTIME_ACQUISITION_TIMEOUT`. | Launcher timeout/error test | Required |
| `ODP-C05` | Runtime ready has a 45 second budget. A concurrent observer waits at least 50 seconds for the owner to publish a binding and never steals a healthy live lease. | Timeout constant assertion plus concurrent launcher test | Required |
| `ODP-C06` | Live incompatible or live unobservable binding fails closed. No implicit takeover, cross-shell stop, or PID replacement occurs. | Launcher negative tests | Required |
| `ODP-C07` | Corrupt active, manifest, attempt, binding, or lease state returns a stable typed launcher error and is never silently repaired or bypassed. | Corrupt-state table tests | Required |

### D. Runtime update, rollback, and recovery

| ID | Required assertion | Evidence and executor | Gate |
| --- | --- | --- | --- |
| `ODP-D01` | First acquisition writes immutable bytes, performs prepared → acquired → launched → confirmed handoff, publishes binding, then advances active. | Launcher test and handoff journal | Required |
| `ODP-D02` | A confirmed active pointer is last-known-good. It is not advanced before ready identity and one-time token validation succeed. | Launcher failure tests | Required |
| `ODP-D03` | A bad candidate with no fallback fails and remains recorded in `attempt.json`; the same immutable candidate is not launched repeatedly. | Launcher first-install/bad-candidate test | Required |
| `ODP-D04` | A bad candidate with a confirmed active fallback is quarantined; the next call starts the fallback and preserves attempt evidence. | Launcher rollback test | Required |
| `ODP-D05` | A later different immutable candidate self-heals, advances generation, and clears the old attempt only after confirmation. | Launcher self-heal test | Required |
| `ODP-D06` | A manifest requiring a newer plugin shell retains the newest compatible installed runtime and exposes the shell floor/update URL. | Launcher shell-floor test | Required |
| `ODP-D07` | Earlier immutable runtime directories remain addressable across promotion; latest rollback and same-version digest replacement are rejected. | Fixture and publisher tests | Required |

### E. Real-host integration

| ID | Required assertion | Evidence and executor | Gate |
| --- | --- | --- | --- |
| `ODP-E01` | The exact packed marketplace installs into an isolated managed `CODEX_HOME`; prepare is idempotent and replacement clears stale verified runtime binding. | `tools-codex prepare/status` report | Required per target |
| `ODP-E02` | A new real `codex --enable plugins exec --json` session invokes ensure through the installed plugin and returns the exact selected runtime identity. The invocation must preserve the managed `CODEX_HOME` configuration; `--ignore-user-config` is invalid because it removes the installed plugin's enablement state. | Codex JSONL plus binding/active snapshots | Required per target |
| `ODP-E03` | Detached runtime survives the ephemeral CLI host and a later CLI call reattaches with `attached:true` and `reusedArtifact:true`. | Two real Codex CLI calls and PID/binding equality | Required per target |
| `ODP-E04` | Controlled Desktop discovers the installed plugin and completes an operator-observed status or ensure tool call in a fresh chat. | Versioned operator screenshot observation plus acceptance report | Required per target |
| `ODP-E05` | Unknown, multiple, or unstamped Desktop roots fail as `BLOCKED_BY_HOST_STATE`; tools never adopt or stop them. | `tools-codex` host-state tests/reports | Required |
| `ODP-E06` | Stop and cleanup affect only exact recorded owners and managed roots. Credentials and default Codex home are untouched. | `tools-codex stop/clean` evidence | Required |

### F. Publication and release topology

| ID | Required assertion | Evidence and executor | Gate |
| --- | --- | --- | --- |
| `ODP-F01` | Runtime publication uses only `<channel>/closure/<platform>`; the Codex adapter namespace remains in the manifest identity and never enters the public object key or Desktop release whitelist. | Publisher plan and workflow topology tests | Required |
| `ODP-F02` | Runtime artifact is immutable and long-cacheable; latest manifest is short-cacheable and updated with conditional/CAS semantics. | `tools-release` publication tests and dry-run report | Required |
| `ODP-F03` | Stable promotion reuses the exact prerelease bytes rather than rebuilding. | Release identity/digest comparison | Required for stable |
| `ODP-F04` | Marketplace shell publication is a separate low-frequency operation. Missing public shell update URL does not block runtime beta delivery, but remains an explicit follow-up. | Release configuration review | Required declaration |
| `ODP-F05` | Repository CI runs platform-independent tests on Linux, native carrier tests only on matching hosts, and never enables Linux native delivery implicitly. | Workflow topology tests | Required |

## Mandatory lifecycle scenario

The target-host lifecycle gate executes one ordered scenario because isolated
unit cases cannot prove preservation of last-known-good state:

1. Pack and install shell `S` with runtime N.
2. Acquire N and preserve manifest, immutable store, handoff, binding, active,
   and current identity.
3. Re-run through the installed plugin and prove fast live attach.
4. Promote N+1 while N is live; attach N immediately and persist update
   `available` asynchronously.
5. Stop the exact N owner and acquire N+1 through the unchanged shell `S`.
6. Stop N+1, make latest unreachable, and prove the 500 ms bounded local cold
   start with update `unavailable`.
7. Stop the fallback, serve crashing N+2, and prove failed attempt plus active
   N+1 preservation.
8. Re-run against the same N+2 and prove N+1 rollback without retrying N+2.
9. Stop N+1, serve valid N+3, and prove self-heal plus attempt removal.
10. Serve N+4 with a shell floor above `S`; prove compatible N+3 remains
    usable and the floor is observable.
11. Run the real Codex CLI attach assertion and the controlled Desktop
    observation against the final compatible runtime.

The fixture may expose programmatic promotion for multiple prevalidated build
reports, but every promotion must preserve fixed shell coordinates, refuse
version rollback, retain earlier immutable URLs, and reject same-version byte
replacement.

## Evidence bundle

One acceptance run must preserve:

- exact shell and runtime build reports;
- artifact inventory and offline stdio observation;
- fixture report and ordered promotion records;
- Codex JSONL for acquisition and reattach;
- update-status snapshots for deferred/current/available/unavailable;
- `active.json`, `attempt.json`, binding, lease observations, handoff journals,
  and immutable version inventory at the relevant checkpoints;
- exact controlled stop evidence;
- publication dry-run JSON and Markdown summary;
- Desktop operator observation and screenshot digest;
- a final capability ledger listing every ID as `PASS`, `FAIL`, `BLOCKED`, or
  `NOT_APPLICABLE`.

Secrets, authentication material, raw environment dumps, and unrelated Codex
home state must not enter the bundle.

## Release decision

The macOS arm64 beta is deliverable only when every applicable required
capability is `PASS`, except the already-declared low-frequency public
marketplace shell URL follow-up in `ODP-F04`. A Windows beta additionally
requires the native artifact and real-CLI lifecycle lanes. Controlled Windows
Desktop acceptance remains a separate operator-observed gate and cannot be
inferred from CLI evidence. Linux native delivery remains disabled even when
all platform-independent tests pass.
