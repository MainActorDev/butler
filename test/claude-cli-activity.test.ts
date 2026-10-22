/** chat-reliability F2 — claude-cli parser fixes over a FAKE binary:
 *  (a) the completed assistant snapshot must REPLACE/complete the streamed
 *      block — never re-emit duplicated deltas;
 *  (b) native tool_use ids flow into onTool invocationId;
 *  (c) results are FULL (no 160-char clip) and EMPTY results are recorded. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCliProvider } from '../src/provider/claude-cli.ts';

type ToolEv = { phase: 'call' | 'result'; name: string; invocationId?: string; arg?: string; result?: string; isError?: boolean };

function fakeClaude(events: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'butler-cc-'));
  const path = join(dir, 'claude');
  const script = `#!/usr/bin/env node
const evts = ${JSON.stringify(events)};
process.stdout.write(evts.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

const MSGS = [
  { role: 'system' as const, content: 'sys prompt' },
  { role: 'user' as const, content: 'do the thing' },
];

describe('claude-cli parser: snapshot/delta dedup + native tool ids + full results', () => {
  it('streamed deltas + completed snapshot → NO duplicated text', async () => {
    const bin = fakeClaude([
      { type: 'system', subtype: 'init', session_id: 's_f2' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'de' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'velop' } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'develop' }] } }, // the snapshot — must NOT re-emit
      { type: 'result', subtype: 'success', result: 'develop', session_id: 's_f2' },
    ]);
    const deltas: string[] = [];
    const p = claudeCliProvider({ kind: 'claude-cli', baseUrl: 'x', apiKey: 'k', model: 'cc', binPath: bin });
    const r = await p.complete(MSGS, [], { remainingMs: 10_000, onDelta: (d) => { deltas.push(d); } });
    expect(deltas).toEqual(['de', 'velop']); // exactly the stream — no 'develop' duplicate
    expect(deltas.join('')).toBe('develop'); // byte-exact
    expect(r.message.content).toBe('develop');
  });

  it('a snapshot that EXTENDS a cut stream completes the block with the missing tail only', async () => {
    const bin = fakeClaude([
      { type: 'system', subtype: 'init', session_id: 's_tail' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'de' } } }, // stream cut mid-block
      { type: 'assistant', message: { content: [{ type: 'text', text: 'develop' }] } },
      { type: 'result', subtype: 'success', result: 'develop', session_id: 's_tail' },
    ]);
    const deltas: string[] = [];
    const p = claudeCliProvider({ kind: 'claude-cli', baseUrl: 'x', apiKey: 'k', model: 'cc', binPath: bin });
    await p.complete(MSGS, [], { remainingMs: 10_000, onDelta: (d) => { deltas.push(d); } });
    expect(deltas.join('')).toBe('develop'); // completed…
    expect(deltas).toEqual(['de', 'velop']); // …without re-emitting 'de'
  });

  it('snapshot-only mode (no stream events) still emits the text exactly once', async () => {
    const bin = fakeClaude([
      { type: 'system', subtype: 'init', session_id: 's_snap' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'result', subtype: 'success', result: 'Hello', session_id: 's_snap' },
    ]);
    const deltas: string[] = [];
    const p = claudeCliProvider({ kind: 'claude-cli', baseUrl: 'x', apiKey: 'k', model: 'cc', binPath: bin });
    await p.complete(MSGS, [], { remainingMs: 10_000, onDelta: (d) => { deltas.push(d); } });
    expect(deltas).toEqual(['Hello']);
  });

  it('native tool_use ids are preserved into onTool invocationId (call AND result)', async () => {
    const bin = fakeClaude([
      { type: 'system', subtype: 'init', session_id: 's_tool' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_NATIVE_42', name: 'screens_registry', input: { command: 'list active screens' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_NATIVE_42', content: 'ok' }] } },
      { type: 'result', subtype: 'success', result: 'used the tool', session_id: 's_tool' },
    ]);
    const tools: ToolEv[] = [];
    const p = claudeCliProvider({ kind: 'claude-cli', baseUrl: 'x', apiKey: 'k', model: 'cc', binPath: bin });
    await p.complete(MSGS, [], { remainingMs: 10_000, onTool: (e) => { tools.push(e); } });
    const call = tools.find((t) => t.phase === 'call');
    expect(call?.name).toBe('screens_registry');
    expect(call?.invocationId).toBe('toolu_NATIVE_42'); // PREVIOUSLY dropped
    const result = tools.find((t) => t.phase === 'result');
    expect(result?.invocationId).toBe('toolu_NATIVE_42'); // correlated via native id
    expect(result?.isError).toBe(false);
  });

  it('empty results are recorded (result:"", isError:false) — and long results are NOT truncated at 160 chars', async () => {
    const long = 'X'.repeat(300);
    const bin = fakeClaude([
      { type: 'system', subtype: 'init', session_id: 's_res' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_NATIVE_42', name: 'screens_registry', input: { command: 'probe' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_NATIVE_42', content: '' }] } }, // empty — was OMITTED
      { type: 'user', message: { content: [{ type: 'tool_result', content: long }] } }, // order-correlated, 300 chars
      { type: 'result', subtype: 'success', result: 'probed', session_id: 's_res' },
    ]);
    const tools: ToolEv[] = [];
    const p = claudeCliProvider({ kind: 'claude-cli', baseUrl: 'x', apiKey: 'k', model: 'cc', binPath: bin });
    await p.complete(MSGS, [], { remainingMs: 10_000, onTool: (e) => { tools.push(e); } });
    const results = tools.filter((t) => t.phase === 'result');
    expect(results).toHaveLength(2);
    const empty = results.find((t) => t.result === '');
    expect(empty).toMatchObject({ isError: false, invocationId: 'toolu_NATIVE_42' }); // PREVIOUSLY dropped entirely
    const full = results.find((t) => t.result === long);
    expect(full).toBeDefined(); // PREVIOUSLY clipped to 160 chars
  });
});
