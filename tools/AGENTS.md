# tools/AGENTS.md

Follow the root `AGENTS.md` first. This file only records module-level boundaries for `tools/`.

## Active tools

- `tools/codex` provides `@open-design/tools-codex` and the `tools-codex` bin. It owns the persistent, namespaced Codex Desktop acceptance environment under `~/.od/tools-codex/<namespace>`, plugin preparation, controlled Desktop lifecycle, evidence reports, and layered cleanup.
- `tools/dev` provides `@open-design/tools-dev` and the `tools-dev` bin. It is the only currently active local development lifecycle control plane.
- `pnpm tools-dev` manages daemon -> web -> desktop.
- `pnpm tools-dev run web` runs foreground daemon + web for the Playwright webServer flow.
- `pnpm tools-dev inspect desktop ...` inspects the desktop runtime through sidecar IPC.
- `tools/pack` provides `@open-design/tools-pack` and the `tools-pack` bin. The active slice is packaged artifact build/install/start/stop/logs/uninstall/cleanup/list/reset, Codex plugin local-marketplace snapshots, beta release artifact preparation for mac and Windows lanes, plus a Linux AppImage lane with optional containerized builds.
- `tools/serve` provides `@open-design/tools-serve` and the `tools-serve` bin. It owns local fixture services such as `tools-serve start updater` and identity-bound Codex plugin runtime fixtures.
- `tools/release` provides `@open-design/tools-release` and the `tools-release` bin. It owns release metadata, storage publishing, release reports, and notification-facing file/data contracts; artifact build, cache, installer, payload, and smoke work stays in `tools/pack`.

## Retired tools

- `tools/pr` / `@open-design/tools-pr` / `pnpm tools-pr` has been retired from this repository. Maintainer PR-duty workflows now live outside the product workspace in `PerishCode/duty`; do not restore an Open Design-local PR-duty tool without a new explicit maintainer decision.

## Packaging scope

- Keep `tools-pack` focused on packaging/runtime control, release artifact preparation, and the packaged-updater acceptance harness. The updater product surface and launcher handoff live in `apps/desktop` and `apps/packaged`; do not duplicate that application logic in the tool.
- Pack-specific Electron builder resources belong under `tools/pack/resources/`; do not reference app/docs/download assets directly from pack logic.
- Namespace controls packaged data/log/runtime/cache paths. Ports are transient transport details and must not participate in path decisions.
- There is no root `pnpm build` aggregate. Use package-scoped builds for source packages and `pnpm tools-pack ...` for packaged artifact build/install/release flows.

## Orchestration boundary

- Tool tests live in each tool's `tests/` directory, sibling to `src/`; keep `src/` source-only and do not add new `*.test.ts` or `*.test.tsx` files under `src/`.
- Orchestration layers must consume primitives from `@open-design/sidecar-proto`, `@open-design/sidecar`, and `@open-design/platform`.
- Do not hand-build `--od-stamp-*` args, process-scan regexes, runtime tokens, process roles, or duplicate namespace/source args in `tools/dev`, future `tools/pack`, or packaged launchers.
- `tools-codex` must fail closed when a pre-existing Codex Desktop root process is present. It may stop only processes carrying the exact run stamp recorded by its namespace marker.
- `tools-codex` environment namespaces are stable local acceptance identities and are independent from Codex plugin distribution namespaces in `tools-pack` reports.
- `tools-codex clean` must remain layered. Credentials are never part of implicit cache/plugin cleanup, and whole-home deletion requires an exact canonical path confirmation.
- Port flags are authoritative inputs: `--daemon-port` and `--web-port`. Internal env vars are `OD_PORT` and `OD_WEB_PORT`; do not introduce `NEXT_PORT`.

## Common tools commands

```bash
pnpm --filter @open-design/tools-codex typecheck
pnpm --filter @open-design/tools-codex test
pnpm --filter @open-design/tools-codex build
pnpm --filter @open-design/tools-dev typecheck
pnpm --filter @open-design/tools-dev build
pnpm --filter @open-design/tools-pack typecheck
pnpm --filter @open-design/tools-pack build
pnpm --filter @open-design/tools-serve typecheck
pnpm --filter @open-design/tools-serve build
pnpm --filter @open-design/tools-release typecheck
pnpm --filter @open-design/tools-release build
pnpm --filter @open-design/tools-release test
pnpm tools-codex init --namespace codex-smoke
pnpm tools-codex status --namespace codex-smoke --json
pnpm tools-codex start --namespace codex-smoke --build-report <path> --json
pnpm tools-codex invoke --namespace codex-smoke --build-report <path> --json
pnpm tools-codex accept --namespace codex-smoke --build-report <path> --json
pnpm tools-dev status --json
pnpm tools-dev logs --json
pnpm tools-dev check
pnpm tools-pack mac build --to all
pnpm tools-pack mac install
pnpm tools-pack mac cleanup
pnpm tools-pack win build --to nsis
pnpm tools-pack win install
pnpm tools-pack win inspect --expr "document.title"
pnpm tools-pack win cleanup
pnpm tools-pack linux build --to appimage
pnpm tools-pack linux install
pnpm tools-pack linux install --headless
pnpm tools-pack linux start --headless
pnpm tools-pack linux stop --headless
pnpm tools-pack linux build --containerized
pnpm tools-pack codex-plugin build --channel stable --runtime-version 0.16.1 --runtime-digest sha256:<64-lowercase-hex>
pnpm tools-serve start updater
pnpm tools-serve start codex-plugin --build-report <path>
```
