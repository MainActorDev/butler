import { describe, expect, it } from 'vitest';
import { EsCompatRetriever } from '../src/retrieval/es-compat.ts';

/** Stage-3 F2: structured search — heading_path prefix filter + BM25, same
 *  failure contract as retrieve(). Hermetic fake endpoint. */

type Call = { path: string; body: unknown };

function fakeEndpoint(hits: unknown[], log: Call[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    log.push({ path: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify({ hits: { hits, total: { value: hits.length } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('EsCompatRetriever.search', () => {
  it('filter-only query (empty q) with heading_prefix — symbol lookups', async () => {
    const calls: Call[] = [];
    const r = new EsCompatRetriever({
      baseUrl: 'http://x', index: 'corpus',
      fetchImpl: fakeEndpoint([{ _id: 'abc#2', _score: 3.1, _source: { content: 'src/a.swift:5\nfunc validate', heading_path: 'symbol: validate (function)', ordinal: 2 } }], calls),
    });
    const hits = await r.search({ query: '', headingPrefix: 'symbol: validate', size: 5 });
    expect(hits[0]?.headingPath).toBe('symbol: validate (function)');
    expect(hits[0]?.ordinal).toBe(2);
    const body = calls[0]!.body as { size: number; query: { bool: { must: unknown[]; filter: unknown[] } } };
    expect(body.size).toBe(5);
    expect(body.query.bool.must[0]).toEqual({ match_all: {} });
    expect(JSON.stringify(body.query.bool.filter)).toContain('match_phrase_prefix');
  });

  it('query + heading_prefix combine (must + filter)', async () => {
    const calls: Call[] = [];
    const r = new EsCompatRetriever({ baseUrl: 'http://x', index: 'corpus', fetchImpl: fakeEndpoint([], calls) });
    await r.search({ query: 'validator', headingPrefix: 'symbol: Validator' });
    const body = calls[0]!.body as { query: { bool: { must: unknown[]; filter: unknown[] } } };
    expect(JSON.stringify(body.query.bool.must)).toContain('"validator"');
    expect(body.query.bool.filter.length).toBe(1);
  });

  it('no headingPrefix → no filter clause', async () => {
    const calls: Call[] = [];
    const r = new EsCompatRetriever({ baseUrl: 'http://x', index: 'corpus', fetchImpl: fakeEndpoint([], calls) });
    await r.search({ query: 'anything' });
    const body = calls[0]!.body as { query: { bool: { must: unknown[]; filter: unknown[] } } };
    expect(body.query.bool.filter).toEqual([]);
  });

  it('non-2xx throws (same contract as retrieve)', async () => {
    const r = new EsCompatRetriever({
      baseUrl: 'http://x', index: 'corpus',
      fetchImpl: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
    });
    await expect(r.search({ query: 'x' })).rejects.toThrow(/structured search failed \(500\)/);
  });
});
