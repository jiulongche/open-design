// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';

function body(cap: unknown) {
  return JSON.stringify({ version: { version: '1', channel: 'stable', packaged: false, platform: 'linux', arch: 'x64', ...(cap ? { capabilities: cap } : {}) } });
}
describe('diag', () => {
  it('probe + toggle behaviour', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: any) => { calls.push(String(u)); return new Response(body({ slideRenderer: true }), { status: 200, headers: { 'content-type': 'application/json' } }); }));
    render(<FileViewer projectId="p" projectKind="prototype"
      file={{ name: 'slides.html', path: 'slides.html', mime: 'text/html', kind: 'html', size: 1, mtime: 0,
        artifactManifest: { version: 1, kind: 'html', title: 'S', entry: 'slides.html', renderer: 'html', exports: ['html'] } } as any}
      liveHtml='<html><body><section data-screen-label="One">One</section></body></html>' />);
    const btn = await screen.findByRole('button', { name: /export/i });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: /Export as PPTX/i })).toBeTruthy());
    console.log('DIAG after open1: item=', !!screen.queryByRole('menuitem', { name: /Export as PPTX/i }), 'fetches=', calls.length);
    fireEvent.click(btn);
    console.log('DIAG after click2: item=', !!screen.queryByRole('menuitem', { name: /Export as PPTX/i }), 'fetches=', calls.length);
    fireEvent.click(btn);
    console.log('DIAG after click3: item=', !!screen.queryByRole('menuitem', { name: /Export as PPTX/i }), 'fetches=', calls.length);
    console.log('DIAG urls=', JSON.stringify(calls));
  });
});
