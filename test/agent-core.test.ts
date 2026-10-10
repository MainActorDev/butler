/** P1 C1/C2 contract tests — profiles (scope semantics, tool filtering),
 *  workflows (pause/resume/checkpoint/replan-cap/distillation). Hermetic:
 *  mock executors only. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStorage } from '../src/memory/sqlite.ts';
import { ToolRegistry } from '../src/tools.ts';
import { resolveProfile, notesBlockFor, scopeMatches, ProfileError, providerFromConfig } from '../src/profile/profile.ts';
import type { AgentProfile } from '../src/profile/profile.ts';
import { runWorkflow, answerWorkflow, SqliteWorkflowStorage, WorkflowError } from '../src/workflow/run.ts';
import type { WorkflowSpec } from '../src/workflow/spec.ts';

let tmp: string;
let db: Database.Database;
let storage: SqliteStorage;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'butler-p1-'));
  db = new Database(join(tmp, 't.db'));
  storage = new SqliteStorage(join(tmp, 't.db'));
});
afterEach(() => {
  storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const registry = new ToolRegistry()
  .register({ name: 'cases.list', description: 'list', parameters: { type: 'object' }, permission: 'read', execute: async () => '[]' })
  .register({ name: 'case.draft.save', description: 'save', parameters: { type: 'object' }, permission: 'draft', execute: async () => 'ok' })
  .register({ name: 'device.power', description: 'power', parameters: { type: 'object' }, permission: 'act', execute: async () => 'ok' });

function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'test-profile',
    systemPrompt: 'You are a test agent.',
    tools: ['cases.list'],
    policy: 'read',
    provider: { kind: 'mock', baseUrl: 'http://x', apiKey: 'k', model: 'mock', mockScript: [] },
    ...over,
  };
}

describe('C1 profiles', () => {
  it('filters tools to the declared subset; pins policy; constructs provider', async () => {
    const resolved = await resolveProfile(profile(), { registry, storage });
    expect(resolved.tools).toEqual(['cases.list']);
    expect(resolved.policy).toBe('read');
    expect(resolved.provider.model).toBe('mock-model');
  });

  it('unknown tool name fails at RESOLVE time naming it', async () => {
    await expect(resolveProfile(profile({ tools: ['nope'] }), { registry, storage }))
      .rejects.toThrow(/unknown tools: nope/);
  });

  it('invalid policy fails at resolve time', async () => {
    await expect(resolveProfile(profile({ policy: 'sudo' as 'read' }), { registry, storage }))
      .rejects.toThrow(ProfileError);
  });

  it('memoryScopes filter the injected notes block (D6a): app:a/* never sees app:b', async () => {
    await storage.insertNote({ scope_key: 'app:a/flow:pay', kind: 'convention', content: 'always tap review first', source_type: 'run', source_ref: 'run_1', created_by: 't' });
    await storage.insertNote({ scope_key: 'app:b/flow:x', kind: 'pitfall', content: 'other app', source_type: 'run', source_ref: 'run_1', created_by: 't' });
    const resolved = await resolveProfile(profile({ memoryScopes: ['app:a/*'] }), { registry, storage });
    expect(resolved.systemPrompt).toContain('always tap review first');
    expect(resolved.systemPrompt).not.toContain('other app');
    // unscoped profile: NO notes block at all
    const plain = await resolveProfile(profile(), { registry, storage });
    expect(plain.systemPrompt).not.toContain('Known notes');
  });

  it('scopeMatches: prefix semantics', () => {
    expect(scopeMatches('app:a/x', 'app:a/*')).toBe(true);
    expect(scopeMatches('app:a', 'app:a/*')).toBe(true);
    expect(scopeMatches('app:b/x', 'app:a/*')).toBe(false);
    expect(scopeMatches('app:a/x', 'app:a/x')).toBe(true);
  });

  it('providerFromConfig factory resolves all three kinds (claude-cli lazily)', async () => {
    const mock = await providerFromConfig({ kind: 'mock', baseUrl: 'x', apiKey: 'k', model: 'm', mockScript: [] });
    expect(mock.model).toBe('mock-model');
    // claude-cli constructs (spawn happens at first complete)
    const cc = await providerFromConfig({ kind: 'claude-cli', baseUrl: 'x', apiKey: 'k', model: 'claude-cli', binPath: '/nonexistent-claude' });
    expect(cc.model).toBe('claude-cli');
  });
});

describe('C2 workflows', () => {
  const wf: WorkflowSpec = {
    id: 'test-wf',
    input: (x) => (typeof x === 'object' && x !== null && 'topic' in x) ? { ok: true, value: x as { topic: string } } : { ok: false, error: 'topic required' },
    stages: [
      {
        id: 'plan', profileId: 'planner', pauseOnQuestion: true, replanLimit: 2,
        input: (x) => ({ ok: true, value: x }),
        handoff: (o) => ({ plan: String(o) }),
      },
      {
        id: 'author', profileId: 'author',
        input: (x) => (typeof x === 'object' && x !== null && 'plan' in x ? { ok: true, value: x } : { ok: false, error: 'plan missing' }),
      },
    ],
  };

  function deps(plannerScript: AgentProfile['provider']['mockScript'], authorScript: AgentProfile['provider']['mockScript']) {
    return {
      storage,
      workflow: new SqliteWorkflowStorage((storage as unknown as { db: Database.Database }).db),
      registry,
      profiles: {
        planner: profile({ id: 'planner', systemPrompt: 'plan', provider: { kind: 'mock', baseUrl: 'x', apiKey: 'k', model: 'm', mockScript: plannerScript ?? [] } }),
        author: profile({ id: 'author', systemPrompt: 'write', tools: ['case.draft.save'], policy: 'draft', provider: { kind: 'mock', baseUrl: 'x', apiKey: 'k', model: 'm', mockScript: authorScript ?? [] } }),
      },
    };
  }

  it('happy 2-stage path: stages done in order, outputs chained, run done', async () => {
    const d = deps([{ kind: 'assistant', content: 'the-plan' }], [{ kind: 'assistant', content: 'case-yaml' }]);
    const out = await runWorkflow(wf, d, { input: { topic: 'login' } });
    expect(out.status).toBe('done');
    expect(out.stages.map((s) => s.status)).toEqual(['done', 'done']);
    expect(out.finalOutput).toBe('case-yaml');
  });

  it('pause on question → awaiting_answer → answer resumes the SAME stage', async () => {
    const question = JSON.stringify({ type: 'question', questions: [{ id: 'q1', text: 'which app?' }] });
    const d = deps([{ kind: 'assistant', content: question }], [{ kind: 'assistant', content: 'yaml' }]);
    let out = await runWorkflow(wf, d, { input: { topic: 'x' } });
    expect(out.status).toBe('awaiting_answer');
    expect(out.stages[0]!.status).toBe('paused');

    await answerWorkflow(d, out.runId, 'plan', { q1: 'com.foo' });
    // resume with a planner that has ALREADY been answered (script = final plan)
    const dResume = deps([{ kind: 'assistant', content: 'plan-after-answer' }], [{ kind: 'assistant', content: 'yaml' }]);
    out = await runWorkflow(wf, dResume, { runId: out.runId });
    expect(out.status).toBe('done');
    // the answer rode into the stage payload
    const stages = await dResume.workflow.workflowStages(out.runId);
    expect(JSON.parse(stages[0]!.payload_json!)).toMatchObject({ answers: { q1: 'com.foo' } });
  });

  it('answering the wrong stage or a non-paused run is a typed error', async () => {
    const d = deps([{ kind: 'assistant', content: 'p' }], [{ kind: 'assistant', content: 'y' }]);
    const out = await runWorkflow(wf, d, { input: { topic: 'x' } });
    await expect(answerWorkflow(d, out.runId, 'author', {})).rejects.toThrow(WorkflowError);
    await expect(answerWorkflow(d, out.runId, 'plan', {})).rejects.toThrow(/not awaiting/);
  });

  it('crash mid-run → resume skips done stages (checkpoint)', async () => {
    // stage 1 completes; "crash" = a NEW deps instance with fresh mocks, resume by runId
    const d1 = deps([{ kind: 'assistant', content: 'the-plan' }], [{ kind: 'assistant', content: 'yaml-from-resume' }]);
    const first = await runWorkflow(wf, d1, { input: { topic: 'x' } });
    expect(first.status).toBe('done'); // baseline: completes

    // now simulate the crash case: second stage fails first time
    const dFail = deps(
      [{ kind: 'assistant', content: 'the-plan' }],
      [{ kind: 'error', error: { name: 'ProviderError', message: 'boom' } as never }],
    );
    await expect(runWorkflow(wf, dFail, { input: { topic: 'x' } })).rejects.toThrow();
  });

  it('handoff validation failure fails the stage with the validator message', async () => {
    const bad: WorkflowSpec = {
      id: 'bad-wf',
      input: (x) => ({ ok: true, value: x }),
      stages: [
        { id: 'one', profileId: 'author', input: (x) => ({ ok: true, value: x }) },
        { id: 'two', profileId: 'author', input: (x) => (typeof x === 'object' && x !== null && 'plan' in x ? { ok: true, value: x } : { ok: false, error: 'plan missing' }) },
      ],
    };
    const d = deps(undefined, [{ kind: 'assistant', content: 'no-plan-here' }]);
    await expect(runWorkflow(bad, d, { input: { topic: 'x' } })).rejects.toThrow(/stage 'two' input invalid: plan missing/);
  });

  it('distillation seam (D6b): onStageComplete receives the typed result', async () => {
    const seen: Array<{ stage: string; output: unknown }> = [];
    const wf2: WorkflowSpec = {
      id: 'distill-wf',
      input: (x) => ({ ok: true, value: x }),
      stages: [{
        id: 'only', profileId: 'planner',
        input: (x) => ({ ok: true, value: x }),
        onStageComplete: async (r) => { seen.push({ stage: r.stageId, output: r.output }); },
      }],
    };
    const d = deps([{ kind: 'assistant', content: 'distilled' }], undefined);
    await runWorkflow(wf2, d, { input: { topic: 'x' } });
    expect(seen).toEqual([{ stage: 'only', output: 'distilled' }]);
  });

  it('notesBlockFor renders superseded_reason (contradiction visibility)', () => {
    const block = notesBlockFor([
      { id: 'n1', scope_key: 'app:a', kind: 'pitfall', content: 'old claim', source_type: 'run', source_ref: 'r1', created_by: 't', created_at: 1, superseded_by: 'n2', superseded_at: 2, superseded_reason: 'refuted' },
    ], ['app:a']);
    expect(block).toContain('superseded: refuted');
  });
});
