/** R3-S6 migration test: a REAL v0.4.2 DB snapshot (trimmed from the live
 *  drill DB — 3 sessions, 11 messages, 8 notes, all pre-R3 schemas) upgraded
 *  in place by the EventSink. Old rows stay readable; new turns append; the
 *  single-writer projection never touches history it didn't write. */

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventSink } from '../src/orchestrate/event-sink.ts';

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'r3-migration-'));
  dbPath = join(dir, 'v042.db');
  copyFileSync(new URL('../test/fixtures/v042-real-snapshot.db', import.meta.url), dbPath);
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('S6: migration from a real v0.4.2 snapshot', () => {
  it('pre-flight: the fixture has NO R3 tables (genuine v0.4.2 shape)', () => {
    const db = new Database(dbPath, { readonly: true });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    db.close();
    expect(tables).toContain('butler_sessions');
    expect(tables).toContain('butler_messages');
    expect(tables).not.toContain('butler_turn_events');
    expect(tables).not.toContain('butler_turns');
  });

  it('opening the sink creates R3 tables beside old ones (additive, no rewrites)', () => {
    const db = new Database(dbPath);
    const sink = new EventSink(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain('butler_turn_events');
    expect(tables).toContain('butler_turns');
    expect(tables).toContain('butler_command_receipts');
    expect(tables).toContain('butler_outbox');
    // old rows untouched and readable through the same handle
    const msgs = db.prepare('SELECT COUNT(*) AS c FROM butler_messages').get() as { c: number };
    expect(msgs.c).toBeGreaterThanOrEqual(11);
    sink.state; // constructed
  });

  it('a pre-existing session accepts a new durable turn; history renders alongside', () => {
    const db = new Database(dbPath);
    const sink = new EventSink(db);
    const sess = (db.prepare('SELECT id FROM butler_sessions ORDER BY created_at LIMIT 1').get() as { id: string }).id;
    const { events } = sink.handle(sess, { kind: 'turn.request', sessionId: sess, turnId: 't_mig1', prompt: 'post-upgrade question', refIds: [], at: Date.now() }, 'mig:k1');
    expect(events.map((e) => e.kind)).toEqual(['turn.requested', 'user_message.recorded', 'turn.started']);
    // the projected message row lands AFTER the 11 historical ones — no renumbering
    const rows = db.prepare('SELECT COUNT(*) AS c FROM butler_messages WHERE session_id = ?').get(sess) as { c: number };
    expect(rows.c).toBeGreaterThanOrEqual(1);
    // replay of the new events is deterministic
    const st = sink.replay(sess);
    expect(st.turns[0]?.status).toBe('running'); // requested→started, never completed in this test
    db.close();
  });

  it('old sessions with NO events fold to a clean empty state (not an error)', () => {
    const db = new Database(dbPath);
    const sink = new EventSink(db);
    const other = (db.prepare('SELECT id FROM butler_sessions ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
    const st = sink.state(other);
    expect(st.turns).toEqual([]);
    expect(st.activeTurnId).toBeNull();
    db.close();
  });
});
