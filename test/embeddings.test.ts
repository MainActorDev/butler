import { describe, expect, it } from 'vitest';
import { HashEmbedding, OpenAICompatEmbedding, cosine } from '../src/embeddings/index.ts';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { StorageRetriever } from '../src/memory/retrieval.ts';
import { fileConnector } from '../src/sources/file.ts';
import { ingest } from '../src/sources/connector.ts';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

/** Stage E (condition 5): embedding seam + hybrid retrieval, measured —
 *  BM25 stays default; hybrid must EARN its place on a synthetic corpus. */

const HERE = dirname(fileURLToPath(import.meta.url));

describe('embedding seam', () => {
  it('HashEmbedding is deterministic + normalized; cosine sanity', async () => {
    const e = new HashEmbedding(32);
    const vecs = await e.embed(['login settle wait', 'login settle wait', 'network profile freeze']);
    const a = vecs[0]!; const b = vecs[1]!; const c = vecs[2]!;
    expect(a).toEqual(b); // deterministic
    const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(cosine(a, c)).toBeLessThan(cosine(a, b)); // identical > different
    expect(cosine(a, b)).toBeCloseTo(1, 5);
  });

  it('OpenAICompatEmbedding sends the shape + parses vectors (injected fetch)', async () => {
    let captured: { url: string; body: string } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: String(init?.body ?? '') };
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const p = new OpenAICompatEmbedding({ baseUrl: 'https://emb.example/v1', apiKey: 'k', model: 'm', dimensions: 2 }, { fetchImpl });
    const out = await p.embed(['a', 'b']);
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(captured!.url).toBe('https://emb.example/v1/embeddings');
    const body = JSON.parse(captured!.body) as { model: string; input: string[] };
    expect(body.model).toBe('m');
    expect(body.input).toEqual(['a', 'b']);
  });

  it('provider failure → typed error with status', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    const p = new OpenAICompatEmbedding({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', dimensions: 2 }, { fetchImpl });
    await expect(p.embed(['a'])).rejects.toThrow(/503/);
  });
});

describe('hybrid retrieval (condition 5)', () => {
  it('mode toggle: bm25 default; hybrid reranks via embeddings; failure degrades to bm25', async () => {
    const storage = SqliteStorage.memory();
    await storage.insertNote({ scope_key: 'app:login', kind: 'pitfall', content: 'login needs settle-wait before tapping submit on slow networks', source_type: 'session', source_ref: 's1', created_by: 't' });
    await storage.insertNote({ scope_key: 'app:net', kind: 'convention', content: 'freeze network responses as presets via the traffic log', source_type: 'session', source_ref: 's2', created_by: 't' });

    const bm25 = new StorageRetriever(storage);
    const hybrid = new StorageRetriever(storage, { mode: 'hybrid' });

    const r1 = await bm25.retrieve('login settle submit', 1);
    const r2 = await hybrid.retrieve('login settle submit', 1);
    expect(r1[0]!.content).toContain('settle-wait');
    expect(r2[0]!.content).toContain('settle-wait'); // same winner via the hybrid path

    // degradation: a provider that throws → hybrid falls back to bm25 WITH a warning, never hard-fails
    const failing = new StorageRetriever(storage, {
      mode: 'hybrid',
      embed: { model: 'boom', dimensions: 1, embed: async () => { throw new Error('endpoint down'); } },
    });
    const r3 = await failing.retrieve('login settle submit', 1);
    expect(r3[0]!.content).toContain('settle-wait');
    storage.close();
  });

  it('MEASURED: bm25 vs hybrid on a synthetic corpus (≥200 docs) — the comparison is a logged artifact', async () => {
    // synthetic corpus: 25 topics × 9 paraphrase docs each; query set with planted relevance
    const topics = ['login flow', 'logout confirmation', 'payment retry', 'profile edit', 'search filters', 'onboarding tour', 'push notifications', 'dark mode', 'offline cache', 'file upload', 'image crop', 'rate limiting', 'session expiry', 'email verification', 'password reset', 'two factor auth', 'data export', 'audit log', 'webhook retries', 'api versioning', 'pagination cursor', 'sorting options', 'bulk actions', 'trash restore', 'sharing links'];
    const variants = ['in the mobile app', 'on the web client', 'for enterprise tenants', 'after a cold start', 'under heavy load', 'with legacy accounts', 'during migration', 'in the admin panel', 'for beta users'];

    const storage = SqliteStorage.memory();
    await storage.upsertSource({ id: 'synth', kind: 'file', config_json: '{}', status: 'active', last_synced_at: null });
    let n = 0;
    for (const t of topics) {
      for (const v of variants) {
        await storage.upsertDocument({ sha256: `synth-${n.toString().padStart(4, '0')}`, source_id: 'synth', uri: `synth://${n}`, title: `${t} ${v}`, content: `${t} ${v}: described behavior and acceptance criteria for this configuration path`, kind: 'markdown', fetched_at: n, bytes_path: null });
        await storage.insertChunks(`synth-${n.toString().padStart(4, '0')}`, [{ ordinal: 0, heading_path: t, content: `${t} ${v}: described behavior and acceptance criteria for this configuration path`, tokens: 20 }]);
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(200);

    // queries: topic + a variant phrase; expected: the topic appears in the top-3 heading
    const queries = topics.slice(0, 15).map((t) => ({ q: `${t} described behavior`, expect: t }));

    const bm25 = new StorageRetriever(storage);
    const hybrid = new StorageRetriever(storage, { mode: 'hybrid', rerankPool: 50 });
    // register chunks for retrieval scope
    for (let i = 0; i < n; i++) {
      const rows = await storage.documentChunks(`synth-${i.toString().padStart(4, '0')}`);
      bm25.registerChunks(rows);
      hybrid.registerChunks(rows);
    }

    const recall = async (r: StorageRetriever): Promise<number> => {
      let hits = 0;
      for (const { q, expect } of queries) {
        const top = await r.retrieve(q, 3);
        if (top.some((t) => (t.headingPath ?? '').includes(expect) || t.content.includes(expect))) hits++;
      }
      return hits / queries.length;
    };
    const bm25Recall = await recall(bm25);
    const hybridRecall = await recall(hybrid);
    console.warn(`[measured] bm25 recall@3 = ${bm25Recall.toFixed(2)} · hybrid(hash-mock) recall@3 = ${hybridRecall.toFixed(2)}`);

    // assertion is about the MECHANISM (both modes retrieve sanely on this corpus),
    // not about hash-mock beating BM25 — quality claims need a real embedding provider
    expect(bm25Recall).toBeGreaterThanOrEqual(0.6);
    expect(hybridRecall).toBeGreaterThanOrEqual(0.3); // hash-mock rerank shuffles; must not destroy retrieval
    storage.close();
  }, 30_000);
});
