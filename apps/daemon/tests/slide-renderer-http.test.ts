import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { httpSlideRendererFromEnv, startServer } from '../src/server.js';

// The optional HTTP slide renderer: the extension point that lets a deployment
// without an Electron sidecar supply one. The properties worth pinning are the
// ones an operator cannot see going wrong — an unset variable that quietly
// changes something, a renderer outage reported as a render result, or a
// renderer choosing where the daemon writes files.

const MAGIC = 'ODRENDER1';

/** Builds the binary return frame the renderer speaks. */
function frame(
  header: Record<string, unknown>,
  parts: Array<{ name: string; body: Buffer }>,
  overrides?: { declaredBytes?: number[] },
): Buffer {
  const headerJson = Buffer.from(
    JSON.stringify({
      ...header,
      parts: parts.map((part, i) => ({
        name: part.name,
        bytes: overrides?.declaredBytes?.[i] ?? part.body.length,
      })),
    }),
    'utf8',
  );
  const len = Buffer.alloc(4);
  len.writeUInt32BE(headerJson.length);
  return Buffer.concat([Buffer.from(MAGIC, 'ascii'), len, headerJson, ...parts.map((p) => p.body)]);
}

const servers: http.Server[] = [];
const tempDirs: string[] = [];

/** A stub renderer. `respond` decides what the single /render-slides call returns. */
async function stubRenderer(
  respond: (res: http.ServerResponse) => void,
): Promise<string> {
  const server = http.createServer((req, res) => {
    if (req.url !== '/render-slides' || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    // Drain the request body before answering; the daemon always sends one.
    req.resume();
    req.on('end', () => respond(res));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

// The output dir is a SUBDIRECTORY of the temp root so that a test about
// escaping it has somewhere owned to escape into. Pointing the escape at the
// system temp dir instead would leave a stray file there and make the assertion
// depend on how clean /tmp happens to be.
function tempOutputDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-slide-renderer-'));
  tempDirs.push(root);
  const dir = path.join(root, 'out');
  fs.mkdirSync(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('httpSlideRendererFromEnv', () => {
  // The whole opt-in claim rests on this: an operator who never sets the
  // variable must get a daemon that is byte-for-byte the one they have today.
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('binds nothing when the URL is %s', (_label, url) => {
    expect(httpSlideRendererFromEnv(url)).toBeNull();
  });

  it('renders through the configured URL, tolerating a trailing slash', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'no slides', errorCode: 'NO_SLIDES' }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };

    const render = httpSlideRendererFromEnv(`http://127.0.0.1:${port}//`);
    await render!({ html: '<p>hi</p>', deck: true });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('/render-slides');
    expect(seen[0]!.body).toEqual({ html: '<p>hi</p>', deck: true });
  });

  // The distinction that matters to whoever reads the failure: "the renderer is
  // down" and "this deck cannot be rendered" need different actions, so they
  // must not arrive as the same thing.
  it('throws when the renderer itself fails, surfacing its message', async () => {
    const base = await stubRenderer((res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'renderer pool exhausted' }));
    });

    await expect(httpSlideRendererFromEnv(base)!({ html: '' })).rejects.toThrow(
      'renderer pool exhausted',
    );
  });

  it('throws with the status when a renderer failure has no JSON body', async () => {
    const base = await stubRenderer((res) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('bad gateway');
    });

    await expect(httpSlideRendererFromEnv(base)!({ html: '' })).rejects.toThrow('HTTP 502');
  });

  it('returns a failed RENDER verbatim instead of throwing', async () => {
    const base = await stubRenderer((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'page is too tall', errorCode: 'PAGE_TOO_TALL' }));
    });

    await expect(httpSlideRendererFromEnv(base)!({ html: '' })).resolves.toEqual({
      ok: false,
      error: 'page is too tall',
      errorCode: 'PAGE_TOO_TALL',
    });
  });

  it('writes an editable pptx into the daemon-chosen directory', async () => {
    const outputDir = tempOutputDir();
    const body = Buffer.from('PKpptx-bytes');
    const base = await stubRenderer((res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(frame({ ok: true, mode: 'deck' }, [{ name: 'deck.pptx', body }]));
    });

    const result = await httpSlideRendererFromEnv(base)!({ html: '', editable: true, outputDir });

    expect(result).toEqual({ ok: true, mode: 'deck', pptxFile: path.join(outputDir, 'deck.pptx') });
    expect(fs.readFileSync(path.join(outputDir, 'deck.pptx'))).toEqual(body);
    // `parts` is transport framing, not part of the contract the routes read.
    expect(result).not.toHaveProperty('parts');
  });

  it('writes rendered slides in order and reports them as slideFiles', async () => {
    const outputDir = tempOutputDir();
    const parts = [
      { name: 'slide-1.png', body: Buffer.from('first') },
      { name: 'slide-2.png', body: Buffer.from('second-longer') },
    ];
    const base = await stubRenderer((res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(frame({ ok: true, mode: 'deck', width: 1920, height: 1080 }, parts));
    });

    const result = await httpSlideRendererFromEnv(base)!({ html: '', outputDir });

    expect(result.slideFiles).toEqual([
      path.join(outputDir, 'slide-1.png'),
      path.join(outputDir, 'slide-2.png'),
    ]);
    expect(fs.readFileSync(path.join(outputDir, 'slide-2.png')).toString()).toBe('second-longer');
  });

  // The renderer is a separate process — possibly a separate container — and it
  // names the files. It must not be able to name one that lands outside the
  // directory the daemon owns.
  it('confines renderer-named files to the output directory', async () => {
    const outputDir = tempOutputDir();
    const escapee = path.join(path.dirname(outputDir), 'escaped.png');
    const base = await stubRenderer((res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(frame({ ok: true, mode: 'deck' }, [
        { name: '../escaped.png', body: Buffer.from('nope') },
      ]));
    });

    const result = await httpSlideRendererFromEnv(base)!({ html: '', outputDir });

    expect(result.slideFiles).toEqual([path.join(outputDir, 'escaped.png')]);
    expect(fs.existsSync(escapee)).toBe(false);
  });

  it('rejects a frame whose parts do not account for its length', async () => {
    const outputDir = tempOutputDir();
    const base = await stubRenderer((res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      // Declares fewer bytes than it sends: a truncated or mis-framed response.
      res.end(frame({ ok: true }, [{ name: 'a.png', body: Buffer.from('12345') }], {
        declaredBytes: [2],
      }));
    });

    await expect(httpSlideRendererFromEnv(base)!({ html: '', outputDir })).rejects.toThrow(
      'frame length mismatch',
    );
  });

  it('rejects a response that is not a render frame at all', async () => {
    const outputDir = tempOutputDir();
    const base = await stubRenderer((res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from('this is not a frame'));
    });

    await expect(httpSlideRendererFromEnv(base)!({ html: '', outputDir })).rejects.toThrow(
      'unrecognised frame',
    );
  });

  it('refuses a binary handoff with nowhere to put it', async () => {
    const base = await stubRenderer((res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(frame({ ok: true }, [{ name: 'a.png', body: Buffer.from('x') }]));
    });

    await expect(httpSlideRendererFromEnv(base)!({ html: '' })).rejects.toThrow('requires outputDir');
  });
});

// Wiring, observed where a user would feel it: the export route's answer and
// the capability the daemon advertises. Both have to move together with the
// extension point, or the UI is told one thing while the routes do another —
// the drift the capability flag was introduced to prevent (#7224).
describe('OD_SLIDE_RENDERER_URL wiring', () => {
  const projectId = 'proj-http-slide-renderer';

  async function withDaemon(
    url: string | undefined,
    options: Parameters<typeof startServer>[0],
    body: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const previous = process.env.OD_SLIDE_RENDERER_URL;
    if (url === undefined) delete process.env.OD_SLIDE_RENDERER_URL;
    else process.env.OD_SLIDE_RENDERER_URL = url;
    const started = (await startServer({ port: 0, returnServer: true, ...options })) as {
      url: string;
      server: http.Server;
    };
    // Written per-daemon because the data dir is shared across this file's tests.
    const dir = path.join(process.env.OD_DATA_DIR!, 'projects', projectId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'deck.html'),
      '<html><body><section class="slide">A</section></body></html>',
    );
    try {
      await body(started.url);
    } finally {
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
      if (previous === undefined) delete process.env.OD_SLIDE_RENDERER_URL;
      else process.env.OD_SLIDE_RENDERER_URL = previous;
    }
  }

  const exportEditablePptx = (baseUrl: string) =>
    fetch(`${baseUrl}/api/projects/${projectId}/export/pptx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'deck.html', editable: true }),
    });

  const capability = async (baseUrl: string) => {
    const res = await fetch(`${baseUrl}/api/version`);
    const json = (await res.json()) as { version?: { capabilities?: { slideRenderer?: boolean } } };
    return json.version?.capabilities?.slideRenderer;
  };

  // The opt-in claim, stated where a user would notice it breaking: leave the
  // variable alone and the daemon answers exactly as it does today.
  it('changes nothing when the variable is unset', async () => {
    await withDaemon(undefined, {}, async (baseUrl) => {
      expect(await capability(baseUrl)).toBe(false);
      const res = await exportEditablePptx(baseUrl);
      expect(res.status).toBe(501);
    });
  });

  it('serves exports through the configured renderer and advertises it', async () => {
    const bytes = Buffer.from('PK\x03\x04from-the-http-renderer');
    const base = await stubRenderer((res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(frame({ ok: true, mode: 'deck' }, [{ name: 'deck.pptx', body: bytes }]));
    });

    await withDaemon(base, {}, async (baseUrl) => {
      expect(await capability(baseUrl)).toBe(true);
      const res = await exportEditablePptx(baseUrl);

      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
    });
  });

  // An injected renderer belongs to the desktop sidecar and the environment must
  // not be able to displace it. Asserted on WHICH renderer produced the bytes —
  // both are present and both advertise the same capability, so the flag alone
  // could not tell these two worlds apart.
  it('never displaces a renderer the host injected', async () => {
    const httpBytes = Buffer.from('PK\x03\x04from-the-http-renderer');
    const injectedBytes = Buffer.from('PK\x03\x04from-the-injected-renderer');
    const base = await stubRenderer((res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(frame({ ok: true, mode: 'deck' }, [{ name: 'deck.pptx', body: httpBytes }]));
    });
    const injected = async (input: { outputDir?: string }) => {
      const file = path.join(input.outputDir!, 'deck.pptx');
      await fs.promises.mkdir(input.outputDir!, { recursive: true });
      await fs.promises.writeFile(file, injectedBytes);
      return { ok: true as const, pptxFile: file, mode: 'deck' as const };
    };

    await withDaemon(base, { desktopSlideRenderer: injected }, async (baseUrl) => {
      const res = await exportEditablePptx(baseUrl);

      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(injectedBytes);
    });
  });
});
