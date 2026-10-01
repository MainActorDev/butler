/** demo/tour.ts — the narrated walkthrough (plan Stage A, condition 1).
 *  Runs the scripted authoring scenario end-to-end against the MOCK provider
 *  and prints a timestamped transcript: search → get → draft → INVALID →
 *  repair → VALID → publish REFUSED. Exits non-zero if any expected beat is
 *  missing. Doubles as a CI smoke test (see test/tour.test.ts). */

import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { StorageRetriever } from '../src/memory/retrieval.ts';
import { fileConnector } from '../src/sources/file.ts';
import { ingest } from '../src/sources/connector.ts';
import { MockProvider, type ScriptedTurn } from '../src/provider/mock.ts';
import { runLoop, type LoopTool } from '../src/loop.ts';
import { ToolRegistry, DRAFT, PolicyRefusal } from '../src/tools.ts';
import { toolFromRegistry } from '../src/transport/loop-adapter.ts';
import { validateSpec } from './app.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const t0 = Date.now();
const beat = (label: string) => `  [${String(Date.now() - t0).padStart(5)}ms] ${label}`;

export interface TourResult {
  ok: boolean;
  missingBeats: string[];
  transcript: string[];
}

export async function runTour(printLine?: (s: string) => void): Promise<TourResult> {
  const out: string[] = [];
  const say = (s: string) => { out.push(s); printLine?.(s); };
  const missing: string[] = [];
  const seen = new Set<string>();
  const mark = (b: string) => seen.add(b);

  say('butler tour — the 60-second answer to "what can Butler do?"');
  say('(mock provider — deterministic; set BUTLER_PROVIDER_BASE_URL and run demo/app.ts for live)');

  // ── memory: ingest the fixture tickets (Stage 3 pipeline) ──
  const storage = new SqliteStorage(':memory:');
  say(beat('memory: ingesting fixture tickets via the file source connector…'));
  const conn = fileConnector('tour-fixtures', { root: join(HERE, 'fixtures') });
  const ingested = await ingest(conn, storage, { artifactsDir: join(HERE, 'artifacts') });
  const docs = ingested.documents.filter((d) => !d.cached);
  say(beat(`memory: ${docs.length} documents, ${docs.reduce((s, d) => s + d.chunks, 0)} structural chunks (sha256-addressed)`));
  const loginSha = docs.find((d) => d.uri.includes('ticket-login'))?.sha256 ?? '';
  const retriever = new StorageRetriever(storage);
  for (const d of docs) retriever.registerChunks(await storage.documentChunks(d.sha256));

  // ── tools: the demo registry, draft policy ──
  const specs = new Map<string, unknown>();
  const registry = new ToolRegistry()
    .register({
      name: 'docs.search', description: 'search ingested docs', permission: 'read',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      execute: async (args) => {
        const hits = await retriever.retrieve(String(args['query'] ?? ''), 3);
        mark('search');
        say(beat(`tool  docs.search("${String(args['query']).slice(0, 40)}") → ${hits.length} hits (top: ${hits[0]?.ref.slice(0, 12) ?? '—'})`));
        return hits.map((h) => `[${h.ref.slice(0, 12)} ${h.headingPath ?? ''}] ${h.content.slice(0, 300)}`).join('\n---\n') || 'nothing';
      },
    })
    .register({
      name: 'docs.get', description: 'read one doc by sha prefix', permission: 'read',
      parameters: { type: 'object', properties: { sha: { type: 'string' } }, required: ['sha'] },
      execute: async (args) => {
        mark('get');
        say(beat('tool  docs.get(sha…) → full ticket'));
        return (await storage.getDocument(loginSha))?.content ?? 'not found';
      },
    })
    .register({
      name: 'spec.draft', description: 'record a draft spec', permission: 'draft',
      parameters: { type: 'object', properties: { spec: { type: 'object' } }, required: ['spec'] },
      execute: async (args) => {
        mark('draft');
        const id = `spec_${specs.size + 1}`;
        specs.set(id, args['spec']);
        say(beat(`tool  spec.draft → ${id}`));
        return id;
      },
    })
    .register({
      name: 'spec.validate', description: 'validate a draft (ground truth)', permission: 'draft',
      parameters: { type: 'object', properties: { specId: { type: 'string' } }, required: ['specId'] },
      execute: async (args) => {
        const spec = specs.get(String(args['specId']));
        const v = spec === undefined ? { ok: false, errors: ['unknown draft'] } : validateSpec(spec);
        mark(v.ok ? 'valid' : 'invalid');
        say(beat(`tool  spec.validate → ${v.ok ? 'VALID ✓' : `INVALID ✗ (${v.errors[0]})`}`));
        return v.ok ? 'VALID' : `INVALID: ${v.errors.join('; ')}`;
      },
    })
    .register({
      name: 'spec.publish', description: 'publish (act-class — refused under draft)', permission: 'act',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => 'published',
    });

  // ── the scripted agent: searches, reads, drafts WRONG twice, then right ──
  const tc = (id: string, name: string, args: unknown): ScriptedTurn => ({
    kind: 'assistant', content: null,
    toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  });
  const script: ScriptedTurn[] = [
    tc('c1', 'docs.search', { query: 'login regression spec' }),
    tc('c2', 'docs.get', { sha: loginSha.slice(0, 8) }),
    tc('c3', 'spec.draft', { spec: { title: 'Login regression' } }),                                  // missing steps
    tc('c4', 'spec.validate', { specId: 'spec_1' }),
    tc('c5', 'spec.draft', { spec: { title: 'Login regression', steps: ['wait', 'tap submit'] } }),   // wrong shape
    tc('c6', 'spec.validate', { specId: 'spec_2' }),
    tc('c7', 'spec.draft', { spec: { title: 'Login regression', steps: [{ action: 'settle-wait, then tap submit' }] } }),
    tc('c8', 'spec.validate', { specId: 'spec_3' }),
    tc('c9', 'spec.publish', {}),
    { kind: 'assistant', content: `Spec drafted and validated (citing ${loginSha.slice(0, 12)}…). Human review required before publish.` },
  ];

  say(beat('session: running the authoring loop (draft policy)…'));
  const result = await runLoop(
    'You are a spec-drafting assistant. Search docs, draft specs as JSON, validate them, and never claim validity without the validator.',
    'Draft a spec for DEMO-101 (login regression), validate it, cite the sha256.',
    {
      provider: new MockProvider(script),
      tools: registry.list().filter((t) => t.permission !== 'act').map((t) => toolFromRegistry(t.name, registry, DRAFT, { sessionId: 'tour' })),
      onEvent: (e) => { if (e.type === 'turn.start') say(beat(`hop ${e.hop}`)); },
    },
  );
  say(beat(`answer: ${result.answer.slice(0, 100)}`));
  say(beat(`tokens: ${result.tokens.in} in / ${result.tokens.out} out · hops: ${result.hops}`));

  // the POLICY beat: the supervisor (user) tries to publish — refused
  say(beat('policy: attempting spec.publish under the DRAFT policy…'));
  try {
    await registry.execute('spec.publish', {}, { signal: undefined, sessionId: 'tour' }, DRAFT);
    missing.push('refusal'); say(beat('policy: ✗ PUBLISH WENT THROUGH — should have been refused!'));
  } catch (err) {
    if (err instanceof PolicyRefusal) {
      mark('refusal');
      say(beat(`policy: refused ✓ — "${err.message.slice(0, 90)}"`));
    } else throw err;
  }

  storage.close();

  for (const b of ['search', 'get', 'draft', 'invalid', 'valid', 'refusal']) {
    if (!seen.has(b)) missing.push(b);
  }
  if (result.tokens.in + result.tokens.out === 0) missing.push('tokens');
  const ok = missing.length === 0;
  say(ok ? 'tour: ALL BEATS PRESENT ✓' : `tour: MISSING BEATS: ${missing.join(', ')}`);
  return { ok, missingBeats: missing, transcript: out };
}

// CLI entry
if (process.argv[1]?.endsWith('demo/tour.ts')) {
  const r = await runTour((s) => console.log(s));
  process.exit(r.ok ? 0 : 1);
}
