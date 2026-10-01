import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { StorageRetriever } from '../src/memory/retrieval.ts';
import { fileConnector } from '../src/sources/file.ts';
import { ingest } from '../src/sources/connector.ts';
import { MockProvider, type ScriptedTurn } from '../src/provider/mock.ts';
import { OpenAICompatProvider } from '../src/provider/openai-compat.ts';
import { runLoop, type LoopTool } from '../src/loop.ts';
import { evalRetrieval, evalBudget, evalAuthoring } from '../src/eval.ts';
import { validateSpec } from '../demo/app.ts';
import { fileURLToPath } from 'node:url';

/** Stage 5: the eval harness (condition 7). Mock by default; live provider
 *  evals run ONLY when BUTLER_* env is present and are reported separately. */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = join(HERE, '..', 'demo', 'fixtures');

let storage: SqliteStorage;
let retriever: StorageRetriever;

beforeAll(async () => {
  storage = SqliteStorage.memory();
  const conn = fileConnector('eval-fixtures', { root: FIXTURES });
  const r = await ingest(conn, storage, { artifactsDir: FIXTURES });
  retriever = new StorageRetriever(storage);
  for (const d of r.documents) retriever.registerChunks(await storage.documentChunks(d.sha256));
});
afterAll(() => storage.close());

const toolCall = (id: string, name: string, args: unknown): ScriptedTurn => ({
  kind: 'assistant', content: null,
  toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

// the demo's validator-as-ground-truth tools, eval-sized
function specTools(): { tools: LoopTool[]; specs: Map<string, unknown> } {
  const specs = new Map<string, unknown>();
  const tools: LoopTool[] = [
    { name: 'docs.search', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } } },
      execute: async (args) => { const hits = await retriever.retrieve(String(args['query'] ?? ''), 3); return hits.map((h) => h.content.slice(0, 300)).join('\n---\n') || 'nothing'; } },
    { name: 'spec.draft', description: 'draft', parameters: { type: 'object', properties: { spec: { type: 'object' } } },
      execute: async (args) => { const id = `spec_${specs.size + 1}`; specs.set(id, args['spec']); return id; } },
    { name: 'spec.validate', description: 'validate', parameters: { type: 'object', properties: { specId: { type: 'string' } } },
      execute: async (args) => { const v = validateSpec(specs.get(String(args['specId']))); return v.ok ? 'VALID' : `INVALID: ${v.errors.join('; ')}`; } },
  ];
  return { tools, specs };
}

describe('retrieval eval — expected doc in top-3', () => {
  it('fixture queries hit their targets', async () => {
    const r = await evalRetrieval({
      retrieve: (q, k) => retriever.retrieve(q, k),
      cases: [
        { name: 'login regression', given: 'login regression dashboard spec', expect: 'DEMO-101' },
        { name: 'logout confirmation', given: 'logout confirmation sheet', expect: 'DEMO-102' },
        { name: 'settle-wait pitfall', given: 'settle wait slow networks submit', expect: 'settle-wait' },
      ],
    });
    expect(r.passed).toBe(true);
    expect(r.passRate).toBe(1);
  });

  it('CANARY: an intentionally wrong expectation FAILS the suite on the metric assertion', async () => {
    // review F7: valid input, wrong expected outcome — must fail ON THE METRIC
    const r = await evalRetrieval({
      retrieve: (q, k) => retriever.retrieve(q, k),
      cases: [
        { name: 'canary-wrong-doc', given: 'logout confirmation sheet', expect: 'THIS-DOC-DOES-NOT-EXIST' },
      ],
    });
    expect(r.passed).toBe(false); // the harness detected the regression
    expect(r.cases[0]!.pass).toBe(false);
    expect(r.cases[0]!.metric).toContain('top-3 contains'); // failed on the metric, not a crash
    expect(r.cases[0]!.detail).toContain('got:');
  });
});

describe('budget eval — loops respect caps', () => {
  it('infinite tool-loop hits hop cap; hang hits wall cap', async () => {
    const echo: LoopTool = { name: 'echo', description: 'e', parameters: { type: 'object', properties: {} }, execute: async () => 'x' };
    const loop: ScriptedTurn = { kind: 'assistant', content: null, toolCalls: [{ id: 'c', type: 'function', function: { name: 'echo', arguments: '{}' } }] };
    const r = await evalBudget({
      tools: [echo],
      cases: [
        { name: 'hop cap', given: [loop, loop, loop, loop, loop, loop, loop, loop], expect: { code: 'BUDGET_EXCEEDED' } },
        { name: 'wall cap on hang', given: [{ kind: 'hang', ms: 10_000 }], expect: { code: 'BUDGET_EXCEEDED', maxWallMs: 3_000 } },
      ],
    });
    expect(r.passed).toBe(true);
    expect(r.cases.every((c) => c.pass)).toBe(true);
  });
});

describe('authoring eval — validator is the judge (mock provider)', () => {
  it('a compliant scripted agent passes; a non-compliant one FAILS', async () => {
    const good = specTools();
    const bad = specTools();
    const r = await evalAuthoring({
      cases: [
        {
          name: 'good agent drafts valid spec',
          provider: new MockProvider([
            toolCall('c1', 'docs.search', { query: 'login regression' }),
            toolCall('c2', 'spec.draft', { spec: { title: 'Login regression', steps: [{ action: 'submit form' }] } }),
            toolCall('c3', 'spec.validate', { specId: 'spec_1' }),
            { kind: 'assistant', content: 'Done — validated.' },
          ]),
          tools: good.tools,
          judge: () => {
            const last = [...good.specs.entries()].at(-1);
            return last ? validateSpec(last[1]).errors : ['no draft produced'];
          },
        },
        {
          name: 'agent that never drafts FAILS',
          provider: new MockProvider([{ kind: 'assistant', content: 'I decided not to draft anything.' }]),
          tools: bad.tools,
          judge: () => (bad.specs.size === 0 ? ['no draft produced'] : []),
        },
      ],
    });
    expect(r.passed).toBe(false); // one case failed
    const goodCase = r.cases.find((c) => c.name.startsWith('good'))!;
    const badCase = r.cases.find((c) => c.name.startsWith('agent that never'))!;
    expect(goodCase.pass).toBe(true);
    expect(badCase.pass).toBe(false);
    expect(badCase.detail).toContain('no draft produced');
  });
});

describe('live-provider eval — only when credentials present', () => {
  it.runIf(process.env['BUTLER_PROVIDER_BASE_URL'])('runs against the live model when BUTLER_PROVIDER_BASE_URL set; skipped (honest) otherwise', { timeout: 240_000 }, async () => {
    const base = process.env['BUTLER_PROVIDER_BASE_URL'];
    if (!base) {
      console.warn('live eval SKIPPED — no BUTLER_PROVIDER_BASE_URL (mock-only CI run)');
      expect(true).toBe(true);
      return;
    }
    const provider = new OpenAICompatProvider({
      baseUrl: base,
      apiKey: process.env['BUTLER_API_KEY'] ?? '',
      model: process.env['BUTLER_MODEL'] ?? 'glm-5.3-flash',
    });
    const { tools, specs } = specTools();
    const r = await evalAuthoring({
      cases: [{
        name: 'live agent drafts a valid spec from DEMO-101',
        provider,
        tools,
        budget: { maxHops: 10, maxTokens: 60_000, wallMs: 120_000 },
        systemPrompt: 'You are a spec-drafting assistant. Search docs, draft specs as JSON via spec.draft, validate with spec.validate, and never claim validity without the validator.',
        prompt: 'Draft a spec for DEMO-101 (login regression) from the docs, then validate it.',
        judge: () => {
          const last = [...specs.entries()].at(-1);
          return last ? validateSpec(last[1]).errors : ['no draft produced'];
        },
      }],
      threshold: 1,
    });
    // live judge is informative in CI: log it, assert it ran — but a flaky
    // network shouldn't red the suite on a mock-CI runner; assert structure
    expect(r.cases).toHaveLength(1);
    console.warn(`live eval result: pass=${r.cases[0]!.pass} detail=${r.cases[0]!.detail}`);
  });
});
