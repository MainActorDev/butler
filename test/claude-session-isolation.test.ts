/** R2-F4: claude-cli session isolation — per-key --resume, no cross-talk. */
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCliProvider } from '../src/provider/claude-cli.ts';

/** fake claude binary: echoes the --resume arg (or 'fresh') and a session_id */
const fakeBin = (seen: string[]): string => {
  const path = `/tmp/fake-claude-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`;
  const { writeFileSync, chmodSync } = require('node:fs') as typeof import('node:fs');
  writeFileSync(path, `#!/bin/bash
sleep 0.05
RID=""; for a in "$@"; do if [ "$PREV" = "--resume" ]; then RID="$a"; fi; PREV="$a"; done
if [ -n "$RID" ]; then S="$RID"; else S="sess_'$RANDOM'"; fi
echo '{"type":"system","subtype":"init","session_id":"'"$S"'"}'
echo "ARGS:$(printf '%s ' "$@")" >&2
sleep 0.05
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}'
echo '{"type":"result","subtype":"success","result":"ok"}'
`);
  chmodSync(path, 0o755);
  seen.push(path);
  return path;
};

describe('ClaudeCliProvider session isolation', () => {
  it('keys --resume per sessionKey: interleaved turns keep distinct sessions', async () => {
    const seen: string[] = [];
    const p = new ClaudeCliProvider({ baseUrl: '', apiKey: 'x', model: 'm', binPath: fakeBin(seen), policyClass: 'read' } as never);
    const turn = (key: string) => p.complete([{ role: 'user', content: 'hi' }], [], { remainingMs: 5000, sessionKey: key });

    // A1, B1, A2 — A2 must resume A's session, B1 must be fresh
    await turn('lionidas-sess-A');
    // capture the session ids the fake binary generated per call via stderr? simpler: inspect the provider's map
    const mapA = (p as unknown as { sessionIds: Map<string, string> }).sessionIds;
    expect(mapA.has('lionidas-sess-A')).toBe(true);
    await turn('lionidas-sess-B');
    expect(mapA.has('lionidas-sess-B')).toBe(true);
    expect(mapA.get('lionidas-sess-A')).not.toBe(mapA.get('lionidas-sess-B'));
    const aBefore = mapA.get('lionidas-sess-A');
    expect(aBefore).toMatch(/^sess_/);
    await turn('lionidas-sess-A');
    expect(mapA.get('lionidas-sess-A')).toBe(aBefore); // echo-back: --resume kept the id
  });

  it('legacy path (no sessionKey) still works', async () => {
    const seen: string[] = [];
    const p = new ClaudeCliProvider({ baseUrl: '', apiKey: 'x', model: 'm', binPath: fakeBin(seen), policyClass: 'read' } as never);
    const r = await p.complete([{ role: 'user', content: 'hi' }], [], { remainingMs: 5000 });
    expect(r.message.content).toBe('ok');
  });
});
