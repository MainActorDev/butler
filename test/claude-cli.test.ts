/** P1 C4 — claude-cli adapter over a FAKE binary. Hermetic: no real claude,
 *  no keys. The fixture scripts emit stream-json events. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCliProvider } from '../src/provider/claude-cli.ts';
import { ProviderError } from '../src/provider/types.ts';

let tmp: string;

function fakeClaude(behavior: 'ok' | 'die' | 'session-lost' | 'garbage'): string {
  const dir = mkdtempSync(join(tmpdir(), 'butler-cc-'));
  const path = join(dir, 'claude');
  const scripts: Record<string, string> = {
    ok: `#!/usr/bin/env node
const evts = [
  { type: 'system', subtype: 'init', session_id: 'sess_fake_123' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking…' }] } },
  { type: 'result', subtype: 'success', result: 'THE-ANSWER', session_id: 'sess_fake_123' },
];
process.stdout.write(evts.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
`,
    die: `#!/usr/bin/env node
process.stderr.write('fatal: no config\\n');
process.exit(3);
`,
    'session-lost': `#!/usr/bin/env node
const evts = [
  { type: 'system', subtype: 'init', session_id: 's1' },
  { type: 'result', subtype: 'error_during_execution', error: 'could not find session xyz' },
];
process.stdout.write(evts.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
`,
    garbage: `#!/usr/bin/env node
process.stdout.write('not json at all\\n\\n');
`,
    // v0.5.4 regression: the million-token silent-empty — narration streamed,
    // tool_use blocks present, but the result event carries ""
    'empty-result': `#!/usr/bin/env node
const evts = [
  { type: 'system', subtype: 'init', session_id: 's_empty' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Executing /author — registry first.' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'screens_registry', input: {} }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Code reads complete. Decisions locked.' }] } },
  { type: 'result', subtype: 'success', result: '', session_id: 's_empty', usage: { input_tokens: 500000, output_tokens: 500000 } },
];
process.stdout.write(evts.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
`,
  };
  writeFileSync(path, scripts[behavior]!);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'butler-p1c4-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const MSGS = [
  { role: 'system' as const, content: 'sys prompt' },
  { role: 'user' as const, content: 'do the thing' },
];

describe('C4 claude-cli adapter (fake binary)', () => {
  it('parses stream-json, extracts result text, captures session id', async () => {
    const p = claudeCliProvider({ kind: 'claude-cli', baseUrl: 'x', apiKey: 'k', model: 'cc', binPath: fakeClaude('ok') });
    const res = await p.complete(MSGS, [], { remainingMs: 10_000 });
    expect(res.message.content).toBe('THE-ANSWER');
    expect(res.finishReason).toBe('stop');
    expect((p as unknown as { claudeSessionId: string | null }).claudeSessionId).toBe('sess_fake_123');
  });

  it('nonzero exit without result → typed ProviderError with code + stderr', async () => {
    const p = claudeCliProvider({ kind: 'claude-cli', baseUrl: 'x', apiKey: 'k', model: 'cc', binPath: fakeClaude('die') });
    await expect(p.complete(MSGS, [], { remainingMs: 10_000 })).rejects.toThrow(/exited 3: fatal: no config/);
  });

  it('session-lost result → retryable ProviderError, session id reset', async () => {
    const p = claudeCliProvider({ kind: 'claude-cli', baseUrl: 'x', apiKey: 'k', model: 'cc', binPath: fakeClaude('session-lost') });
    // seed a session id so --resume is attempted
    await p.complete(MSGS, [], { remainingMs: 10_000 }).catch((e: ProviderError) => {
      expect(e.message).toContain('session lost');
      expect(e.retryable).toBe(true);
    });
    expect((p as unknown as { claudeSessionId: string | null }).claudeSessionId).toBeNull();
  });

  it('no result event → ProviderError naming it', async () => {
    const p = claudeCliProvider({ kind: 'claude-cli', baseUrl: 'x', apiKey: 'k', model: 'cc', binPath: fakeClaude('garbage') });
    await expect(p.complete(MSGS, [], { remainingMs: 10_000 })).rejects.toThrow(/no result event/);
  });

  it('timeout kills the child (SIGINT path) and rejects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-cc-'));
    const path = join(dir, 'claude');
    writeFileSync(path, `#!/usr/bin/env node
setTimeout(() => process.stdout.write('{}\\n'), 60_000);
`);
    chmodSync(path, 0o755);
    const p = claudeCliProvider({ kind: 'claude-cli', baseUrl: 'x', apiKey: 'k', model: 'cc', binPath: path, timeoutMs: 300 });
    await expect(p.complete(MSGS, [], { remainingMs: 10_000 })).rejects.toThrow(/no result event|exited/);
  });
});

describe('v0.5.4 — empty result after real work (the million-token silent-empty)', () => {
  it('falls back to the streamed assistant text when result.result is empty', async () => {
    const p = claudeCliProvider({ kind: 'claude-cli', baseUrl: 'x', apiKey: 'k', model: 'cc', binPath: fakeClaude('empty-result') });
    const r = await p.complete(MSGS, [], { remainingMs: 10_000 });
    expect(r.message.content).toContain('Executing /author');
    expect(r.message.content).toContain('Decisions locked');
  });

  it('partial stream counts as real output — never a silent empty completion', async () => {
    const p = claudeCliProvider({ kind: 'claude-cli', baseUrl: 'x', apiKey: 'k', model: 'cc', binPath: fakeClaude('empty-result') });
    const deltas: string[] = [];
    const r = await p.complete(MSGS, [], { remainingMs: 10_000, onDelta: (d) => { deltas.push(d); } });
    expect((r.message.content ?? '').length).toBeGreaterThan(0);
  });
});
