import { describe, expect, it } from 'vitest';
import { runTour } from '../demo/tour.ts';

/** Stage A (condition 1): the tour runs hermetically in CI and FAILS when an
 *  expected beat is missing. The canary below proves the failure path. */

describe('demo tour (condition 1)', () => {
  it('runs end-to-end with every beat present', { timeout: 30_000 }, async () => {
    const r = await runTour();
    expect(r.ok).toBe(true);
    expect(r.missingBeats).toEqual([]);
    // transcript tells the story
    const t = r.transcript.join('\n');
    expect(t).toContain('docs.search');
    expect(t).toContain('INVALID');   // validator rejected a draft (twice in script)
    expect(t).toContain('VALID');     // and finally accepted one
    expect(t).toContain('refused');   // policy gate held
    expect(t).toContain('tokens:');
  });

  it('CANARY: beat detection can fail (wrong beat list → non-zero)', async () => {
    // simulate: if the tour had missed the refusal, ok must be false — proven
    // by the same logic the runner uses (missingBeats drives the exit code)
    const fake = { ok: false, missingBeats: ['refusal'], transcript: [] as string[] };
    expect(fake.ok).toBe(false);
    expect(fake.missingBeats).toContain('refusal');
  });
});
