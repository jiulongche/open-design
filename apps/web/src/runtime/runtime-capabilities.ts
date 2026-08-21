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

import { useEffect, useState } from 'react';

import type { AppVersionInfo } from '../types';

type Listener = (value: boolean) => void;

let cached: boolean | null = null;
let inFlight: Promise<boolean | null> | null = null;
const listeners = new Set<Listener>();

// Bounded, backing-off retry. An unresolved probe used to be terminal for an
// already-mounted viewer: the answer never arrived, the gate stayed permissive,
// and the export it was meant to hide could still be clicked into a 501. A
// probe that races daemon startup or blips is exactly the case that needs a
// second look, so retry a few times and then stop — an unreachable daemon is
// its own visible problem and should not be polled forever.
const RETRY_DELAYS_MS = [500, 1_500, 4_000];

function publish(value: boolean): void {
  cached = value;
  for (const listener of listeners) listener(value);
}

/**
 * Feed an already-fetched `/api/version` payload into the capability cache.
 * Called by the app's boot fetch so the common path costs no extra request and
 * cannot disagree with what boot already learned.
 */
export function recordAppVersionInfo(info: AppVersionInfo | null | undefined): void {
  const next = info?.capabilities?.slideRenderer;
  if (typeof next === 'boolean') publish(next);
}

async function probe(): Promise<boolean | null> {
  try {
    const resp = await fetch('/api/version');
    if (!resp.ok) return null;
    const body = (await resp.json()) as { version?: AppVersionInfo };
    const next = body?.version?.capabilities?.slideRenderer;
    if (typeof next !== 'boolean') return null;
    publish(next);
    return next;
  } catch {
    return null;
  }
}

/**
 * `true` / `false` once the daemon has answered, `null` while unknown —
 * either unreachable or a daemon predating the field.
 */
export function loadSlideRendererAvailable(): Promise<boolean | null> {
  if (cached !== null) return Promise.resolve(cached);
  if (!inFlight) {
    inFlight = (async () => {
      try {
        return await probe();
      } finally {
        // Allow a retry when the answer was not knowable this time.
        if (cached === null) inFlight = null;
      }
    })();
  }
  return inFlight;
}

/** Test seam: drop the module-scope cache and any pending work. */
export function resetSlideRendererAvailableCache(): void {
  cached = null;
  inFlight = null;
  listeners.clear();
}

/**
 * `null` until the daemon answers. Callers gating UI should treat `null` as
 * "assume available" rather than "hide": a daemon older than the capability
 * field omits it, and hiding on absence would take a working export away from
 * every deployment that has not upgraded. Only an explicit `false` — a daemon
 * that answered and said it has no renderer — should hide anything.
 *
 * Subscribes to the shared cache, so an answer that arrives from the app's boot
 * fetch (or from another mounted consumer) reaches this component too instead
 * of leaving it pinned on its own failed probe.
 */
export function useSlideRendererAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(cached);

  useEffect(() => {
    if (cached !== null) {
      setAvailable(cached);
      return;
    }

    let cancelled = false;
    const listener: Listener = (value) => {
      if (!cancelled) setAvailable(value);
    };
    listeners.add(listener);

    void (async () => {
      for (let attempt = 0; ; attempt += 1) {
        if (cancelled) return;
        const next = await loadSlideRendererAvailable();
        // `publish` already notified the listener; nothing more to do.
        if (next !== null) return;
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) return;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    })();

    return () => {
      cancelled = true;
      listeners.delete(listener);
    };
  }, []);

  return available;
}
