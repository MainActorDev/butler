/** repo source connector (plan Stage 3): a codebase as structured source —
 *  file tree + per-file docs + per-symbol chunks (Stage-3 v2: tree-sitter
 *  WASM when the consumer configures grammars; regex fallback otherwise).
 *  Local path or shallow clone when handed a URL. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { NormalizedDocument, SourceConnector } from './connector.ts';
import { symbolsFor, symbolChunksFor, type SymbolGrammars } from './tree-sitter.ts';
import type { StructuralChunk } from '../chunk.ts';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', '__pycache__', 'DerivedData', '.derived-data', '.build', 'Pods', '.swiftpm', 'buck-out']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yaml', '.yml', '.txt', '.css', '.scss', '.html', '.swift', '.kt', '.go', '.rs', '.py', '.rb', '.java', '.sql', '.sh']);

export interface RepoSourceConfig {
  /** local path OR remote https URL (shallow-cloned once into a temp dir) */
  origin: string;
  /** max file bytes read per file (skip monsters) */
  maxFileBytes?: number;
  maxFiles?: number;
  /** include the tree doc (default true) */
  treeDoc?: boolean;
  /** emit a per-symbol-chunks doc per file (plan Stage G). With
   *  `symbolGrammars`, extraction is tree-sitter; without, the TS/JS regex
   *  fallback. */
  symbols?: boolean;
  /** extension→grammar policy for tree-sitter extraction (caller-owned;
   *  see defaultSymbolGrammars). Pure mechanism: butler picks nothing. */
  symbolGrammars?: SymbolGrammars;
  /** ADDITIONAL directory names to skip (consumer-level: workspace clones,
   *  artifact dirs — anything that would eat the walk budget or pollute
   *  context with foreign source). Unioned with the builtin SKIP_DIRS. */
  skipDirs?: string[];
}

function listRepoFiles(root: string, maxFiles: number, maxBytes: number, skipDirs?: string[]): string[] {
  const skip = skipDirs?.length ? new Set([...SKIP_DIRS, ...skipDirs]) : SKIP_DIRS;
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    for (const entry of readdirSync(dir).sort()) {
      if (out.length >= maxFiles) break;
      if (skip.has(entry)) continue;
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

/** file + symbol docs for ONE file (Stage-3: watcher batches re-ingest a
 *  single changed file without paying the walk). Same skip rules as fetch();
 *  null when the path is outside the root, skipped, missing, or oversized. */
export async function repoDocumentFor(cfg: RepoSourceConfig, absPath: string): Promise<NormalizedDocument[] | null> {
  if (/^https?:\/\//.test(cfg.origin)) return null; // URL origins have no stable local path
  const root = cfg.origin;
  if (!isAbsolute(absPath) || !absPath.startsWith(root + '/') && absPath !== root) return null;
  const rel = relative(root, absPath);
  if (rel.startsWith('..') || rel === '') return null;
  for (const seg of rel.split('/').slice(0, -1)) {
    if (cfg.skipDirs?.includes(seg) || SKIP_DIRS.has(seg)) return null;
  }
  const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
  if (!TEXT_EXT.has(ext)) return null;
  let st;
  try { st = statSync(absPath); } catch { return null; } // deleted/moved — batch handles
  if (st.size > (cfg.maxFileBytes ?? 256 * 1024)) return null;
  let content: string;
  try { content = readFileSync(absPath, 'utf8'); } catch { return null; }
  const docs: NormalizedDocument[] = [{ uri: `repo://${rel}`, title: rel, content, kind: 'plain' }];
  if (cfg.symbols) {
    const symDoc = await symbolDocFor(content, rel, cfg.symbolGrammars);
    if (symDoc) docs.push(symDoc);
  }
  return docs;
}

/** per-symbol doc: content = one summary line per symbol (browsable),
 *  chunks = one chunk per symbol with heading_path "symbol: <name> (<kind>)"
 *  (Stage-3 shape — structured filtering; v1 concatenated all symbols into
 *  the content body, unretrievable by heading). */
export async function symbolDocFor(content: string, rel: string, grammars?: SymbolGrammars): Promise<NormalizedDocument | null> {
  const symbols = await symbolsFor(content, rel, grammars ?? {});
  if (symbols.length === 0) return null;
  const chunks: StructuralChunk[] = symbolChunksFor(symbols, content, rel);
  return {
    uri: `repo://${rel}#symbols`,
    title: `${rel} (symbols)`,
    content: symbols.map((s) => `symbol: ${s.name} (${s.kind}) — ${rel}:${s.line}`).join('\n'),
    kind: 'symbols',
    chunks,
  };
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
        const files = listRepoFiles(root, maxFiles, maxBytes, cfg.skipDirs);
        const out: NormalizedDocument[] = [];
        if (cfg.treeDoc !== false) {
          const tree = files.map((f) => relative(root, f)).join('\n');
          out.push({ uri: 'repo://tree', title: 'repository file tree', content: tree, kind: 'plain' });
        }
        for (const f of files) {
          const rel = relative(root, f);
          const content = readFileSync(f, 'utf8');
          out.push({ uri: `repo://${rel}`, title: rel, content, kind: 'plain' });
          if (cfg.symbols) {
            const symDoc = await symbolDocFor(content, rel, cfg.symbolGrammars);
            if (symDoc) out.push(symDoc);
          }
        }
        return out;
      } finally {
        if (tmpClone) { try { execFileSync('rm', ['-rf', tmpClone], { stdio: 'ignore' }); } catch { /* best effort */ } }
      }
    },
  };
}
