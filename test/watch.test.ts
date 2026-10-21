import { describe, expect, it } from 'vitest';
import { watchRoots } from '../src/watch.ts';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

/** Stage-3 watchRoots mechanism: debounced batches, ignore policy, health.
 *  Real fs events on a tmp dir (FSEvents on macOS) with a short debounce. */

describe('watchRoots', () => {
  it('coalesces a save into one debounced batch of changed paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-watch-'));
    const batches: string[][] = [];
    const h = watchRoots([dir], { debounceMs: 60 }, (b) => batches.push(b));
    try {
      expect(h.healthy()).toBe(true);
      writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
      // one editor save = several events; debounce must merge them
      appendFileSync(join(dir, 'a.ts'), 'export const b = 2;\n');
      await vi.waitFor(() => expect(batches.length).toBeGreaterThan(0));
      const flat = batches.flat();
      expect(flat).toContain(join(dir, 'a.ts'));
      expect(flat.filter((p) => p === join(dir, 'a.ts')).length).toBe(1);
    } finally {
      h.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignore policy filters paths from batches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-watch2-'));
    mkdirSync(join(dir, 'noise'));
    const batches: string[][] = [];
    const h = watchRoots([dir], { debounceMs: 60, ignore: (p) => p.includes('/noise/') }, (b) => batches.push(b));
    try {
      writeFileSync(join(dir, 'noise', 'junk.log'), 'x');
      writeFileSync(join(dir, 'keep.ts'), 'export const k = 1;\n');
      await vi.waitFor(() => expect(batches.flat().length).toBeGreaterThan(0));
      expect(batches.flat()).not.toContain(join(dir, 'noise', 'junk.log'));
      expect(batches.flat()).toContain(join(dir, 'keep.ts'));
    } finally {
      h.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stop() silences future events and reports unhealthy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-watch3-'));
    let fired = 0;
    const h = watchRoots([dir], { debounceMs: 50 }, () => { fired += 1; });
    h.stop();
    expect(h.healthy()).toBe(false);
    writeFileSync(join(dir, 'late.ts'), 'late');
    await new Promise((r) => setTimeout(r, 250));
    expect(fired).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a dead root surfaces via describe(); other roots keep watching', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'butler-watchA-'));
    const dirB = mkdtempSync(join(tmpdir(), 'butler-watchB-'));
    const batches: string[][] = [];
    // dirA does not exist → its watcher dies at start; dirB must survive
    const gone = join(dirA, 'missing-root');
    const h = watchRoots([gone, dirB], { debounceMs: 60 }, (b) => batches.push(b));
    try {
      expect(h.healthy()).toBe(true); // B alive
      expect(h.describe()).toContain('1/2 roots watching');
      writeFileSync(join(dirB, 'b.ts'), 'export const b = 1;\n');
      await vi.waitFor(() => expect(batches.flat()).toContain(join(dirB, 'b.ts')));
    } finally {
      h.stop();
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
