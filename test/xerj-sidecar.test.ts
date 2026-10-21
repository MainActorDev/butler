/** Tests for EsCompatRetriever + xerjSidecar over a fake ES-compatible
 *  endpoint (injectable fetch — butler's embeddings/index.ts:99-105 pattern).
 *  Hermetic: no binary, no network. */
import { describe, expect, it } from 'vitest';
import { EsCompatRetriever } from '../src/retrieval/es-compat.ts';
import { xerjSidecar, chunkToEsDoc, noteToEsDoc, type EsCorpusDoc } from '../src/xerj-sidecar.ts';

/** Minimal in-memory ES endpoint: health, index create, _mget, _bulk,
 *  _search (naive substring match + score), _count. */
function fakeEs(): { fetchImpl: typeof fetch; store: Map<string, EsCorpusDoc>; calls: string[]; state: { bulkDocs: number } } {
  const store = new Map<string, EsCorpusDoc>();
  const calls: string[] = [];
  const state = { bulkDocs: 0 };
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.replace('http://127.0.0.1:9200', '')}`);
    if (/^http:\/\/127\.0\.0\.1:9200\/?$/.test(url)) return json({ name: 'fake' });
    if (method === 'PUT' && /\/butler-corpus$/.test(url)) return store.size === -1 ? json({}, 400) : json({ acknowledged: true });
    if (method === 'POST' && url.endsWith('/_mget')) {
      const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
      return json({ docs: ids.map((id) => ({ _id: id, found: store.has(id) })) });
    }
    if (method === 'POST' && url.includes('/_bulk')) {
      const lines = String(init?.body).trim().split('\n');
      for (let i = 0; i < lines.length; i += 2) {
        const action = JSON.parse(lines[i]!) as { index: { _id: string } };
        const doc = JSON.parse(lines[i + 1]!) as EsCorpusDoc;
        store.set(action.index._id, doc);
        state.bulkDocs++;
      }
      return json({ errors: false });
    }
    if (method === 'POST' && url.endsWith('/_search')) {
      const q = ((JSON.parse(String(init?.body)) as { query: { match: { content: string } } }).query.match.content).toLowerCase();
      const hits = [...store.values()].filter((d) => d.content.toLowerCase().includes(q)).slice(0, 3)
        .map((d, i) => ({ _id: d._id, _score: 1 - i * 0.1, _source: d }));
      return json({ hits: { hits } });
    }
    if (method === 'GET' && url.endsWith('/_count')) return json({ count: store.size });
    return json({ error: 'not found' }, 404);
  }) as typeof fetch;
  return { fetchImpl, store, calls, state };
}

const chunkRow = { doc_sha256: 'a'.repeat(64), ordinal: 2, heading_path: '## Steps', content: 'pay now button crashes on iPad checkout' };
const noteRow = { id: 'note_1', kind: 'pitfall', scope_key: 'app:x', content: 'double-tap bare coordinates rejected' };

describe('EsCompatRetriever', () => {
  it('maps chunk hits to RetrievedChunk with provenance', async () => {
    const { fetchImpl, store } = fakeEs();
    store.set(`${chunkRow.doc_sha256}#2`, chunkToEsDoc(chunkRow));
    const r = new EsCompatRetriever({ baseUrl: 'http://127.0.0.1:9200', index: 'butler-corpus', fetchImpl });
    const hits = await r.retrieve('crashes on iPad', 3);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'chunk', ref: chunkRow.doc_sha256, ordinal: 2, headingPath: '## Steps' });
    expect(hits[0]!.content).toContain('iPad');
  });

  it('maps note hits (note:<id>)', async () => {
    const { fetchImpl, store } = fakeEs();
    store.set('note:note_1', noteToEsDoc(noteRow));
    const r = new EsCompatRetriever({ baseUrl: 'http://127.0.0.1:9200', index: 'butler-corpus', fetchImpl });
    const hits = await r.retrieve('double-tap', 3);
    expect(hits[0]).toMatchObject({ kind: 'note', ref: 'note_1' });
  });

  it('throws on non-2xx (degradation is the runner\'s job)', async () => {
    const failing = (async () => new Response('boom', { status: 502 })) as unknown as typeof fetch;
    const r = new EsCompatRetriever({ baseUrl: 'http://127.0.0.1:9200', index: 'butler-corpus', fetchImpl: failing });
    await expect(r.retrieve('q', 3)).rejects.toThrow('502');
  });
});

describe('xerjSidecar', () => {
  async function* corpus(): AsyncIterable<EsCorpusDoc> {
    yield chunkToEsDoc(chunkRow);
    yield noteToEsDoc(noteRow);
  }

  it('attaches to a healthy endpoint, reconciles, returns a working retriever', async () => {
    const { fetchImpl, store } = fakeEs();
    const res = await xerjSidecar({ dataDir: '/tmp/x', corpus, fetchImpl });
    expect(res.degraded).toBeNull();
    expect(res.retriever).toBeInstanceOf(EsCompatRetriever);
    expect(store.size).toBe(2); // both corpus docs bulk-indexed
    expect(res.indexedCount).toBe(2);
    const hits = await res.retriever!.retrieve('crashes', 3);
    expect(hits[0]!.ref).toBe(chunkRow.doc_sha256);
  });

  it('reconcile is idempotent: already-indexed docs skipped via mget', async () => {
    const { fetchImpl, store, state } = fakeEs();
    store.set(`${chunkRow.doc_sha256}#2`, chunkToEsDoc(chunkRow)); // pre-existing
    const res = await xerjSidecar({ dataDir: '/tmp/x', corpus, fetchImpl });
    expect(res.indexedCount).toBe(2);
    expect(state.bulkDocs).toBe(1); // only the missing note was sent — chunk skipped
  });

  it('attachOnly with no endpoint → degraded, never a throw', async () => {
    const dead = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const res = await xerjSidecar({ dataDir: '/tmp/x', corpus, attachOnly: true, fetchImpl: dead });
    expect(res.retriever).toBeNull();
    expect(res.degraded).toMatch(/no healthy sidecar/);
  });

  it('spawn path that never becomes healthy → degraded with install hint, child killed', async () => {
    const dead = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    let killed = false;
    const res = await xerjSidecar({
      dataDir: '/tmp/x', corpus, fetchImpl: dead, startupTimeoutMs: 300,
      spawnImpl: () => ({ pid: 123, get killed() { return killed; }, kill() { killed = true; } }),
    });
    expect(res.retriever).toBeNull();
    expect(res.degraded).toMatch(/did not become healthy/);
    expect(res.degraded).toMatch(/curl -fsSL https:\/\/xerj.org\/get/);
    expect(killed).toBe(true);
  });
});
