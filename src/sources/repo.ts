/** repo source connector (plan Stage 3): a codebase as structured source —
 *  file tree + grep + explicit file fetch (v1; tree-sitter depth deferred per
 *  ROADMAP). Local path or shallow clone when handed a URL. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { NormalizedDocument, SourceConnector } from './connector.ts';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', '__pycache__', 'DerivedData']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yaml', '.yml', '.txt', '.css', '.scss', '.html', '.swift', '.kt', '.go', '.rs', '.py', '.rb', '.java', '.sql', '.sh']);

export interface RepoSourceConfig {
  /** local path OR remote https URL (shallow-cloned once into a temp dir) */
  origin: string;
  /** max file bytes read per file (skip monsters) */
  maxFileBytes?: number;
  maxFiles?: number;
  /** include the tree doc (default true) */
  treeDoc?: boolean;
}

function listRepoFiles(root: string, maxFiles: number, maxBytes: number): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    for (const entry of readdirSync(dir).sort()) {
      if (out.length >= maxFiles) break;
      if (SKIP_DIRS.has(entry)) continue;
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (st.size > maxBytes) continue;
      const ext = entry.slice(entry.lastIndexOf('.')).toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      out.push(p);
    }
  };
  walk(root);
  return out;
}

export function repoConnector(sourceId: string, cfg: RepoSourceConfig): SourceConnector {
  const maxFiles = cfg.maxFiles ?? 2_000;
  const maxBytes = cfg.maxFileBytes ?? 256 * 1024;
  return {
    kind: 'repo',
    sourceId,
    async fetch() {
      let root = cfg.origin;
      let tmpClone: string | null = null;
      if (/^https?:\/\//.test(cfg.origin)) {
        tmpClone = mkdtempSync(join(tmpdir(), 'butler-repo-'));
        execFileSync('git', ['clone', '--depth', '1', cfg.origin, tmpClone], { stdio: 'ignore' });
        root = tmpClone;
      }
      try {
        const files = listRepoFiles(root, maxFiles, maxBytes);
        const out: NormalizedDocument[] = [];
        if (cfg.treeDoc !== false) {
          const tree = files.map((f) => relative(root, f)).join('\n');
          out.push({ uri: 'repo://tree', title: 'repository file tree', content: tree, kind: 'plain' });
        }
        for (const f of files) {
          const rel = relative(root, f);
          out.push({ uri: `repo://${rel}`, title: rel, content: readFileSync(f, 'utf8'), kind: 'plain' });
        }
        return out;
      } finally {
        if (tmpClone) { try { execFileSync('rm', ['-rf', tmpClone], { stdio: 'ignore' }); } catch { /* best effort */ } }
      }
    },
  };
}
