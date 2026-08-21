// What the daemon on the other end of /api can actually do.
//
// This is distinct from `isOpenDesignHostAvailable()`, which reports whether
// the web UI is running inside the Electron shell. That is a proxy for "the
// daemon has an off-screen renderer" and it is wrong in both directions: a
// browser pointed at a desktop-hosted daemon would be told the renderer is
// missing when it is not, and a packaged binary started as a plain daemon has
// no renderer despite `packaged: true`. Only the daemon knows, so we ask it.
//
// Served, never stored: the same data dir can be opened by a desktop daemon
// and later by a headless one, so a persisted answer would be a stale claim.
//
// The app's boot pass already fetches /api/version, so it feeds this cache
// through `recordAppVersionInfo` rather than us racing it with a second
// request. Deliberately no import from `providers/registry` — the dependency
// runs the other way, so the two cannot form a cycle.

import { useEffect, useSyncExternalStore } from 'react';

import type { AppVersionInfo } from '../types';

// One state atom, one writer. The earlier shape kept `cached`, `inFlight` and
// the listener set as separate mutable pieces, and every fix exposed another
// pair that could disagree: an invalidation that forgot the in-flight promise,
// a validation path that forgot the invalidation. Collapsing them means those
// inconsistencies are no longer representable rather than merely avoided by
// remembering to update two places.

type Listener = () => void;

/** `null` = unknown: unreachable, malformed, or a daemon predating the field. */
type Snapshot = boolean | null;

let snapshot: Snapshot = null;
let inFlight: Promise<Snapshot> | null = null;
const listeners = new Set<Listener>();

const RETRY_DELAYS_MS = [500, 1_500, 4_000];

/**
 * The only writer. Always drops any in-flight/settled probe: once the answer
 * changes, a promise created under the old one can only report something this
 * state has already superseded.
 */
function setSnapshot(next: Snapshot): void {
  inFlight = null;
  if (snapshot === next) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

/**
 * Full envelope validation. The mixed-version contract says malformed means
 * unknown, so a stray `{version:{capabilities:{slideRenderer:false}}}` must not
 * be able to hide the entry. Lives here rather than in the registry so the
 * dependency stays one-directional (registry imports this module, never the
 * reverse).
 */
export function isAppVersionInfo(value: unknown): value is AppVersionInfo {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AppVersionInfo>;
  const caps = candidate.capabilities as { slideRenderer?: unknown } | undefined;
  if (caps !== undefined && (!caps || typeof caps.slideRenderer !== 'boolean')) return false;
  return (
    typeof candidate.version === 'string' &&
    typeof candidate.channel === 'string' &&
    typeof candidate.packaged === 'boolean' &&
    typeof candidate.platform === 'string' &&
    typeof candidate.arch === 'string'
  );
}

/**
 * Feed a parsed `/api/version` body in. Called by the app's boot fetch so the
 * common path costs no extra request and the two paths cannot disagree.
 *
 * Anything that is not a valid payload carrying a capability resets to unknown:
 * a daemon that stopped advertising the field (restart, downgrade) and a
 * malformed response both mean "we no longer know", and holding a previous
 * `false` would keep hiding the entry against a daemon the contract says we
 * know nothing about.
 */
export function recordAppVersionInfo(info: unknown): void {
  if (!isAppVersionInfo(info)) return setSnapshot(null);
  const next = info.capabilities?.slideRenderer;
  setSnapshot(typeof next === 'boolean' ? next : null);
}

async function probe(): Promise<Snapshot> {
  try {
    const resp = await fetch('/api/version');
    // A transport/HTTP failure says nothing about the daemon's capabilities —
    // unlike a malformed body, it is not an answer — so it must not invalidate
    // a snapshot we already have.
    if (!resp.ok) return snapshot;
    const body = (await resp.json()) as { version?: unknown };
    recordAppVersionInfo(body?.version);
    return snapshot;
  } catch {
    return snapshot;
  }
}

/** `true` / `false` once the daemon has answered, `null` while unknown. */
export function loadSlideRendererAvailable(): Promise<Snapshot> {
  if (snapshot !== null) return Promise.resolve(snapshot);
  // One rule: an in-flight promise only outlives the request while it is
  // still outstanding. Clearing it on settle — not only when it produced an
  // answer — is what keeps an unanswered probe retryable instead of pinning
  // "unknown" for the session.
  if (!inFlight) {
    inFlight = probe().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** Test seam: drop the module-scope state. */
export function resetSlideRendererAvailableCache(): void {
  snapshot = null;
  inFlight = null;
  listeners.clear();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Snapshot {
  return snapshot;
}

/**
 * `null` until the daemon answers. Callers gating UI should treat `null` as
 * "assume available" rather than "hide": a daemon older than the capability
 * field omits it, and hiding on absence would take a working export away from
 * every deployment that has not upgraded. Only an explicit `false` should hide
 * anything.
 *
 * Reads the shared atom, so every mounted consumer sees the same answer —
 * including a later invalidation back to unknown.
 */
export function useSlideRendererAvailable(): Snapshot {
  const available = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (snapshot !== null) return;
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; !cancelled; attempt += 1) {
        if ((await loadSlideRendererAvailable()) !== null) return;
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) return;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return available;
}
