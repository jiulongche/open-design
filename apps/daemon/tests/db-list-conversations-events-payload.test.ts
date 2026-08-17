import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  insertConversation,
  insertProject,
  listConversations,
  openDatabase,
  upsertMessage,
} from '../src/db.js';

/**
 * `listConversations` only needs a *summary* of each conversation's latest run:
 * status, timestamps, and — when the timestamps are incomplete — a `durationMs`
 * recovered from the run's last `usage` event.
 *
 * Its `latest_runs` CTE nevertheless selects `events_json` into the window
 * function that picks the latest assistant row, so SQLite has to materialize
 * every assistant message's full event log for the project just to sort them by
 * position. On an image-heavy project that payload is enormous — tool results
 * carry inline base64 — and the list endpoint pays for all of it while
 * returning a few hundred bytes.
 *
 * These specs pin the summary semantics (so the CTE can be narrowed without
 * silently dropping the `usage` fallback) and assert that list latency does not
 * scale with event-log size.
 */
describe('listConversations event payload', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-list-conversations-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedProject(db: ReturnType<typeof openDatabase>, id: string, now: number) {
    insertProject(db, { id, name: id, createdAt: now, updatedAt: now });
    insertConversation(db, {
      id: `${id}-conv`,
      projectId: id,
      title: id,
      createdAt: now,
      updatedAt: now,
    });
  }

  it('reports the latest run summary from timestamps', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    seedProject(db, 'proj-timestamps', now);
    upsertMessage(db, 'proj-timestamps-conv', {
      id: 'assistant-1',
      role: 'assistant',
      content: 'done',
      runId: 'run-1',
      runStatus: 'succeeded',
      events: [{ kind: 'text', text: 'done' }],
      startedAt: now,
      endedAt: now + 1500,
    });

    const conversations = listConversations(db, 'proj-timestamps');
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.latestRun).toMatchObject({
      status: 'succeeded',
      startedAt: now,
      endedAt: now + 1500,
      durationMs: 1500,
    });
  });

  it('falls back to the last usage event when timestamps are incomplete', () => {
    // This is the ONLY reason the summary needs `events_json` at all. Narrowing
    // the CTE must keep it working, otherwise runs that never recorded an
    // `endedAt` silently lose their duration in the conversation list.
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    seedProject(db, 'proj-usage', now);
    upsertMessage(db, 'proj-usage-conv', {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      runId: 'run-1',
      runStatus: 'succeeded',
      events: [
        { kind: 'usage', durationMs: 900 },
        { kind: 'text', text: 'later block without usage' },
      ],
      startedAt: now,
      // endedAt deliberately omitted
    });

    const conversations = listConversations(db, 'proj-usage');
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.latestRun).toMatchObject({ status: 'succeeded', durationMs: 900 });
  });

  it('picks the newest assistant run, not an earlier one', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    seedProject(db, 'proj-order', now);
    for (const [index, status] of ['failed', 'succeeded'].entries()) {
      upsertMessage(db, 'proj-order-conv', {
        id: `assistant-${index}`,
        role: 'assistant',
        content: '',
        runId: `run-${index}`,
        runStatus: status,
        events: [{ kind: 'usage', durationMs: 100 * (index + 1) }],
        startedAt: now + index,
      });
    }

    const conversations = listConversations(db, 'proj-order');
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.latestRun).toMatchObject({ status: 'succeeded', durationMs: 200 });
  });

  it('does not scale with the size of the stored event logs', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();

    // Two projects, identical shape; only the size of each assistant message's
    // event log differs. A summary query must not care.
    const MESSAGES = 20;
    const bulky = 'x'.repeat(2 * 1024 * 1024); // ~2MB per message, ~40MB total

    seedProject(db, 'proj-small', now);
    seedProject(db, 'proj-large', now);
    for (let index = 0; index < MESSAGES; index += 1) {
      for (const [projectId, text] of [['proj-small', 'x'], ['proj-large', bulky]] as const) {
        upsertMessage(db, `${projectId}-conv`, {
          id: `${projectId}-assistant-${index}`,
          role: 'assistant',
          content: '',
          runId: `${projectId}-run-${index}`,
          runStatus: 'succeeded',
          events: [{ kind: 'text', text }],
          startedAt: now + index,
          endedAt: now + index + 5,
        });
      }
    }

    const measure = (projectId: string) => {
      const started = performance.now();
      const rows = listConversations(db, projectId);
      const elapsed = performance.now() - started;
      expect(rows).toHaveLength(1);
      return elapsed;
    };

    measure('proj-small'); // warm the statement cache
    const smallMs = measure('proj-small');
    const largeMs = measure('proj-large');

    // Generous headroom: the point is that `largeMs` must not grow with the
    // 40MB of event text, not that the two are byte-for-byte equal. Before the
    // fix the window function materializes every event log and this ratio blows
    // past any sane bound.
    expect(largeMs).toBeLessThan(smallMs * 10 + 100);
  }, 60_000);

  it('returns the same summary whether or not event logs are large', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    seedProject(db, 'proj-parity-small', now);
    seedProject(db, 'proj-parity-large', now);
    for (const [projectId, text] of [
      ['proj-parity-small', 'x'],
      ['proj-parity-large', 'x'.repeat(1024 * 1024)],
    ] as const) {
      upsertMessage(db, `${projectId}-conv`, {
        id: `${projectId}-assistant`,
        role: 'assistant',
        content: '',
        runId: `${projectId}-run`,
        runStatus: 'succeeded',
        events: [{ kind: 'text', text }, { kind: 'usage', durationMs: 700 }],
        startedAt: now,
      });
    }

    const [small] = listConversations(db, 'proj-parity-small');
    const [large] = listConversations(db, 'proj-parity-large');
    expect(small).toBeDefined();
    expect(large).toBeDefined();
    expect(large!.latestRun).toEqual(small!.latestRun);
    expect(large!.messageCount).toBe(small!.messageCount);
  }, 30_000);
});
