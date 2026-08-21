import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadSlideRendererAvailable,
  recordAppVersionInfo,
  resetSlideRendererAvailableCache,
} from '../src/runtime/runtime-capabilities';

// The daemon advertises `capabilities.slideRenderer` on /api/version, derived
// from the same binding the export routes 501 on. Three properties matter here
// and each is easy to lose to a plausible-looking edit:
//
//   1. an absent capability block must resolve to `null` (unknown), NOT `false` —
//      a daemon older than the field would otherwise be read as "no renderer"
//      and a working export would disappear for everyone who has not upgraded;
//   2. a malformed block must also be `null` rather than trusted;
//   3. a resolved answer is cached, but an unresolved one must stay retryable,
//      otherwise one early fetch against a not-yet-ready daemon would pin
//      "unknown" for the rest of the session.

function versionBody(capabilities?: unknown): string {
  return JSON.stringify({
    version: {
      version: '1.2.3',
      channel: 'stable',
      packaged: false,
      platform: 'darwin',
      arch: 'arm64',
      ...(capabilities === undefined ? {} : { capabilities }),
    },
  });
}

function mockVersionFetch(body: string | null): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    body === null
      ? new Response('nope', { status: 500 })
      : new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetSlideRendererAvailableCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSlideRendererAvailableCache();
});

describe('slide renderer capability', () => {
  it('reports true when the daemon advertises a renderer', async () => {
    mockVersionFetch(versionBody({ slideRenderer: true }));
    await expect(loadSlideRendererAvailable()).resolves.toBe(true);
  });

  it('reports false when the daemon says it has none', async () => {
    mockVersionFetch(versionBody({ slideRenderer: false }));
    await expect(loadSlideRendererAvailable()).resolves.toBe(false);
  });

  it('reports unknown — not false — when the daemon predates the field', async () => {
    mockVersionFetch(versionBody(undefined));
    await expect(loadSlideRendererAvailable()).resolves.toBeNull();
  });

  it('reports unknown for a malformed capability block instead of trusting it', async () => {
    mockVersionFetch(versionBody({ slideRenderer: 'yes' }));
    await expect(loadSlideRendererAvailable()).resolves.toBeNull();
  });

  it('reports unknown when the daemon cannot be reached', async () => {
    mockVersionFetch(null);
    await expect(loadSlideRendererAvailable()).resolves.toBeNull();
  });

  it('caches a resolved answer but leaves an unresolved one retryable', async () => {
    // First round: daemon not answering yet — must not be cached as the final word.
    const failing = mockVersionFetch(null);
    await expect(loadSlideRendererAvailable()).resolves.toBeNull();
    expect(failing).toHaveBeenCalledTimes(1);

    // Second round: daemon is up now, so the retry must actually go out.
    const answering = mockVersionFetch(versionBody({ slideRenderer: true }));
    await expect(loadSlideRendererAvailable()).resolves.toBe(true);
    expect(answering).toHaveBeenCalledTimes(1);

    // Third round: resolved, so no further request.
    await expect(loadSlideRendererAvailable()).resolves.toBe(true);
    expect(answering).toHaveBeenCalledTimes(1);
  });
});

describe('capability cache fed by the boot fetch', () => {
  it('takes the answer from an already-fetched version payload without a request', async () => {
    const fetchMock = mockVersionFetch(versionBody({ slideRenderer: true }));

    // The app's boot pass hands us what it already fetched...
    recordAppVersionInfo({
      version: '1.2.3',
      channel: 'stable',
      packaged: false,
      platform: 'darwin',
      arch: 'arm64',
      capabilities: { slideRenderer: false },
    });

    // ...so no second request goes out, and the boot answer is what we report.
    await expect(loadSlideRendererAvailable()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores a payload with no capability block instead of caching a guess', async () => {
    recordAppVersionInfo({
      version: '1.2.3',
      channel: 'stable',
      packaged: false,
      platform: 'darwin',
      arch: 'arm64',
    });

    mockVersionFetch(versionBody({ slideRenderer: true }));
    // Still unknown after the record, so the probe is allowed to run.
    await expect(loadSlideRendererAvailable()).resolves.toBe(true);
  });
});
