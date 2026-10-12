/** R2-F3: retrieval-based memory — ranking, fallback, and the sqlite side table. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { TokenEmbedding, cosine } from '../src/embeddings/index.ts';
import { notesBlockFor } from '../src/profile/profile.ts';
import type { NoteRow } from '../src/memory/contract.ts';

let dir: string;
let storage: SqliteStorage;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'r2-f3-'));
  storage = new SqliteStorage(path.join(dir, 'agent.db'));
});
afterAll(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });

async function seedNote(content: string): Promise<NoteRow> {
  const row = await storage.insertNote({
    scope_key: 'app:com.lionparcel.dev/*', kind: 'pitfall', content,
    source_type: 'run', source_ref: 'run_test', created_by: 'test',
  });
  return row as NoteRow;
}

describe('note embeddings side table', () => {
  it('round-trips a vector', async () => {
    const e = new TokenEmbedding();
    const note = await seedNote('voucher eligibility gate for guest checkout');
    const v = (await e.embed([note.content]))[0]!;
    await storage.saveNoteEmbedding(note.id, e.model, v.length, new Float32Array(v));
    const rows = await storage.noteEmbeddings(e.model);
    expect(rows).toHaveLength(1);
    const back = Array.from(rows[0]!.vector);
    expect(cosine(v, back)).toBeCloseTo(1.0, 5);
  });
});

describe('retrieval ranking (TokenEmbedding)', () => {
  it('ranks the relevant note first and the block orders by score', async () => {
    const e = new TokenEmbedding();
    const corpus = [
      'home login bar lacks accessibility identifier on ios-consumer',
      'voucher eligibility rules for guest checkout per CUST-6001',
      'tab bar coordinates break on small devices',
      'network preset for offline mode scenarios',
    ];
    e.fit([...corpus, 'login retry backoff after 401']);
    for (const c of corpus) {
      const n = await seedNote(c);
      const v = (await e.embed([c]))[0]!;
      await storage.saveNoteEmbedding(n.id, e.model, v.length, new Float32Array(v));
    }
    const notes = await storage.activeNotes();
    const stored = await storage.noteEmbeddings(e.model);
    const qv = (await e.embed(['voucher rules for guest users']))[0]!;
    const byId = new Map(notes.map((n) => [n.id, n]));
    const ranked = stored
      .map((se) => ({ note: byId.get(se.noteId)!, score: cosine(qv, Array.from(se.vector)) }))
      .sort((a, b) => b.score - a.score);
    expect(ranked[0]!.note.content).toContain('voucher eligibility');
    const block = notesBlockFor(notes, ['app:com.lionparcel.dev/*'], ranked);
    expect(block.indexOf('voucher eligibility')).toBeLessThan(block.indexOf('tab bar coordinates'));
  });

  it('legacy fallback: no ranking → recency top-20 block still renders', async () => {
    const notes = await storage.activeNotes();
    const block = notesBlockFor(notes, ['app:com.lionparcel.dev/*'], undefined);
    expect(block).toContain('## Known notes');
  });
});
