import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingest, MAX_CHUNKS_PER_SOURCE, type SourceConnector } from '../src/sources/connector.ts';
import { repoConnector } from '../src/sources/repo.ts';
import { SqliteStorage } from '../src/memory/sqlite.ts';

/** Per-source chunk budget: ingest() honours `connector.maxChunks` (default
 *  MAX_CHUNKS_PER_SOURCE), and repoConnector passes `cfg.maxChunks` through. */

const dir = mkdtempSync(join(tmpdir(), 'butler-budget-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

/** n docs with one prechunked chunk each — chunk count is exact */
function fixed(sourceId: string, n: number, maxChunks?: number): SourceConnector {
  return {
    kind: 'file',
    sourceId,
    ...(maxChunks !== undefined ? { maxChunks } : {}),
    async fetch() {
      return Array.from({ length: n }, (_, i) => ({
        uri: `file://${sourceId}/${i}`, title: `${i}`, content: `${sourceId} doc ${i}`, kind: 'plain' as const,
        chunks: [{ ordinal: 0, headingPath: `${i}`, content: `${sourceId} doc ${i}`, tokens: 2 }],
      }));
    },
  };
}

describe('ingest chunk budget', () => {
  it('default stays MAX_CHUNKS_PER_SOURCE (10,000): doc 10,001 is skipped', async () => {
    expect(MAX_CHUNKS_PER_SOURCE).toBe(10_000);
    const storage = SqliteStorage.memory();
    const r = await ingest(fixed('dflt', 10_001), storage, { artifactsDir: dir });
    expect(r.documents).toHaveLength(10_000);
    expect(r.skipped).toEqual([{ uri: 'file://dflt/10000', reason: 'chunk cap reached for source' }]);
    storage.close();
  });

  it('a connector maxChunks lowers or raises the budget', async () => {
    const storage = SqliteStorage.memory();
    const low = await ingest(fixed('low', 5, 3), storage, { artifactsDir: dir });
    expect(low.documents.map((d) => d.uri)).toEqual(['file://low/0', 'file://low/1', 'file://low/2']);
    expect(low.skipped.map((s) => s.uri)).toEqual(['file://low/3', 'file://low/4']);
    const high = await ingest(fixed('high', 10_005, 20_000), storage, { artifactsDir: dir });
    expect(high.documents).toHaveLength(10_005);
    expect(high.skipped).toEqual([]);
    storage.close();
  });

  it('repoConnector passes cfg.maxChunks through; the alphabetical walk drops LATER files at the cap', async () => {
    const root = join(dir, 'repo');
    for (const d of ['a', 'z']) {
      mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, d, 'x.md'), `# One\n${d}1\n# Two\n${d}2\n# Three\n${d}3\n`); // distinct content: identical text would hit the content-address cache
    }
    const cfg = { origin: root, treeDoc: false, symbols: false };
    expect(repoConnector('r0', cfg).maxChunks).toBeUndefined();
    const storage = SqliteStorage.memory();
    const capped = await ingest(repoConnector('r1', { ...cfg, maxChunks: 3 }), storage, { artifactsDir: dir });
    expect(capped.documents.map((d) => d.uri)).toEqual(['repo://a/x.md']);
    expect(capped.skipped.map((s) => s.uri)).toEqual(['repo://z/x.md']);
    storage.close();
  });
});
