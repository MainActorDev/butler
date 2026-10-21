/** watchRoots (Stage 3, plan F3): debounced changed-path batches over one or
 *  more directory roots. Pure mechanism — the consumer owns policy (which
 *  roots, what to ignore, what to do with batches).
 *
 *  One OS watch per root (fs.watch recursive — FSEvents on macOS); no
 *  polling. A watcher error (root deleted, EMFILE) marks that root dead and
 *  surfaces via healthy(); it does NOT throw into the caller's loop. No
 *  mid-process resurrection — restart on next boot keeps the contract simple
 *  (the stale-trigger full walk remains the fallback leg). */
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

export interface WatchHandle {
  /** stop every watcher; pending batch is dropped (shutdown, not flush) */
  stop(): void;
  /** false once every root has died (caller degrades to its fallback leg) */
  healthy(): boolean;
  /** human-readable state for status notes */
  describe(): string;
}

export interface WatchOptions {
  /** quiet period before a batch fires (default 400ms — one editor save is
   *  several filesystem events) */
  debounceMs?: number;
  /** policy: return true to IGNORE a changed path (abs) */
  ignore?: (absPath: string) => boolean;
}

interface RootState {
  root: string;
  watcher: FSWatcher | null;
  alive: boolean;
  lastError: string | null;
}

export function watchRoots(roots: string[], opts: WatchOptions, onBatch: (changedAbsPaths: string[]) => void): WatchHandle {
  const debounceMs = opts.debounceMs ?? 400;
  const pending = new Map<string, number>(); // absPath → seq
  let timer: ReturnType<typeof setTimeout> | null = null;
  const states: RootState[] = roots.map((root) => ({ root, watcher: null, alive: false, lastError: null }));

  const flush = (): void => {
    timer = null;
    if (pending.size === 0) return;
    const batch = [...pending.keys()];
    pending.clear();
    try {
      onBatch(batch);
    } catch {
      // consumer errors never kill the watcher; their problem to log
    }
  };

  const schedule = (absPath: string): void => {
    pending.set(absPath, (pending.get(absPath) ?? 0) + 1);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  const startRoot = (state: RootState): void => {
    try {
      state.watcher = watch(state.root, { recursive: true }, (_event, filename) => {
        if (!state.alive) return;
        if (typeof filename !== 'string') { schedule(state.root); return; } // whole-root event
        const abs = join(state.root, filename);
        if (opts.ignore?.(abs)) return;
        schedule(abs);
      });
      state.alive = true;
      state.lastError = null;
      state.watcher.on('error', (err: Error) => {
        // root deleted / perms / EMFILE — mark dead, surface, keep others up
        state.alive = false;
        state.lastError = err.message;
        try { state.watcher?.close(); } catch { /* already gone */ }
        state.watcher = null;
      });
      state.watcher.on('close', () => { state.alive = false; });
    } catch (err) {
      state.alive = false;
      state.lastError = err instanceof Error ? err.message : String(err);
    }
  };

  for (const state of states) startRoot(state);

  return {
    stop(): void {
      if (timer) { clearTimeout(timer); timer = null; }
      pending.clear();
      for (const state of states) {
        try { state.watcher?.close(); } catch { /* already gone */ }
        state.watcher = null;
        state.alive = false;
      }
    },
    healthy(): boolean {
      return states.some((s) => s.alive);
    },
    describe(): string {
      const alive = states.filter((s) => s.alive).length;
      const dead = states.filter((s) => !s.alive && s.lastError);
      return dead.length > 0
        ? `${alive}/${states.length} roots watching (dead: ${dead.map((d) => `${d.root.split('/').pop()}: ${d.lastError}`).join('; ')})`
        : `${alive}/${states.length} roots watching`;
    },
  };
}
