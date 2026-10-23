import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { EventSink } from '../src/orchestrate/event-sink.ts';
import type { TurnCommand, TurnEvent } from '../src/orchestrate/turn-engine.ts';

/** B2 push-on-append on the REAL EventSink (the scratch prototype modelled
 *  it): listeners fire only after the OUTERMOST commit, never for rows a
 *  rollback discarded, in order, and a throwing listener is isolated. */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const rig = () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-onappend-'));
  dirs.push(dir);
  const storage = new SqliteStorage(join(dir, 'agent.db'));
  const db = storage.handle() as Database.Database;
  const sink = new EventSink(db, { passive: true, enqueueRunTurn: false });
  const pushed: Array<{ sid: string; rows: TurnEvent[] }> = [];
  sink.onAppend((sid, rows) => { pushed.push({ sid, rows }); });
  return { storage, db, sink, pushed };
};
const note = (sid: string, text: string): TurnCommand => ({ kind: 'session.notice', sessionId: sid, level: 'info', text });
const texts = (pushed: Array<{ rows: TurnEvent[] }>) => pushed.flatMap((p) => p.rows.map((r) => (r.detail as { text?: string }).text));

describe('EventSink.onAppend', () => {
  it('a top-level write is pushed once, after commit, with its committed seq', () => {
    const { sink, pushed, storage } = rig();
    sink.handle('s1', note('s1', 'a'), 'k1');
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.sid).toBe('s1');
    expect(pushed[0]!.rows.map((r) => r.seq)).toEqual([1]);
    storage.close();
  });

  it('writes inside withTransaction are NOT pushed before the outer commit, then pushed in order', () => {
    const { sink, pushed, storage } = rig();
    sink.withTransaction(() => {
      sink.handleInTransaction('s1', note('s1', 'a'), 'k1', undefined);
      sink.handleInTransaction('s1', note('s1', 'b'), 'k2', undefined);
      expect(pushed).toHaveLength(0);
    });
    expect(texts(pushed)).toEqual(['a', 'b']);
    storage.close();
  });

  it('an outer rollback is never pushed — not now, not with the next commit', () => {
    const { sink, pushed, storage } = rig();
    expect(() => sink.withTransaction(() => {
      sink.handleInTransaction('s1', note('s1', 'doomed'), 'k1', undefined);
      throw new Error('boom');
    })).toThrow('boom');
    expect(pushed).toHaveLength(0);
    sink.handle('s1', note('s1', 'next'), 'k2');
    expect(texts(pushed)).toEqual(['next']);
    storage.close();
  });

  it('an inner savepoint rollback discards only its own rows', () => {
    const { sink, pushed, storage } = rig();
    sink.withTransaction(() => {
      sink.handleInTransaction('s1', note('s1', 'kept'), 'k1', undefined);
      try {
        sink.withTransaction(() => {
          sink.handleInTransaction('s1', note('s1', 'inner'), 'k2', undefined);
          throw new Error('inner');
        });
      } catch { /* inner savepoint rolled back */ }
    });
    expect(texts(pushed)).toEqual(['kept']);
    storage.close();
  });

  it('a failed top-level apply pushes nothing', () => {
    const { sink, pushed, storage } = rig();
    expect(() => sink.handleInTransaction('s1', note('s1', 'x'), 'k1', () => { throw new Error('alsoRun failed'); })).toThrow('alsoRun failed');
    expect(pushed).toHaveLength(0);
    storage.close();
  });

  it('a throwing listener never affects the write or the other listeners; unsubscribe stops pushes', () => {
    const { sink, pushed, storage } = rig();
    const off = sink.onAppend(() => { throw new Error('listener fault'); });
    expect(() => sink.handle('s1', note('s1', 'a'), 'k1')).not.toThrow();
    expect(texts(pushed)).toEqual(['a']);
    expect(sink.events('s1')).toHaveLength(1);
    off();
    const seen: string[] = [];
    const off2 = sink.onAppend(() => { seen.push('x'); });
    off2();
    sink.handle('s1', note('s1', 'b'), 'k2');
    expect(seen).toEqual([]);
    storage.close();
  });

  it('rows of different sessions in one commit are pushed per session', () => {
    const { sink, pushed, storage } = rig();
    sink.withTransaction(() => {
      sink.handleInTransaction('s1', note('s1', 'one'), 'k1', undefined);
      sink.handleInTransaction('s2', note('s2', 'two'), 'k2', undefined);
    });
    expect(pushed.map((p) => p.sid)).toEqual(['s1', 's2']);
    storage.close();
  });
});
