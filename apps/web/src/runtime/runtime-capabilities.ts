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

import { useEffect, useState } from 'react';

import { fetchAppVersionInfo } from '../providers/registry';

let cached: boolean | null = null;
let inFlight: Promise<boolean | null> | null = null;

/**
 * `true` / `false` once the daemon has answered, `null` while unknown —
 * either not fetched yet, unreachable, or a daemon predating the field.
 */
export async function loadSlideRendererAvailable(): Promise<boolean | null> {
  if (cached !== null) return cached;
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const info = await fetchAppVersionInfo();
        const next = info?.capabilities?.slideRenderer;
        if (typeof next !== 'boolean') return null;
        cached = next;
        return next;
      } finally {
        // Allow a retry when the answer was not knowable this time.
        if (cached === null) inFlight = null;
      }
    })();
  }
  return inFlight;
}

/** Test seam: drop the module-scope cache. */
export function resetSlideRendererAvailableCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * `null` until the daemon answers. Callers gating UI should treat `null` as
 * "assume available" rather than "hide": a daemon older than the capability
 * field omits it, and hiding on absence would take a working export away from
 * every deployment that has not upgraded yet. Only an explicit `false` — a
 * daemon that answered and said it has no renderer — should hide anything.
 */
export function useSlideRendererAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(cached);
  useEffect(() => {
    if (cached !== null) return;
    let cancelled = false;
    void (async () => {
      const next = await loadSlideRendererAvailable();
      if (!cancelled && next !== null) setAvailable(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}
