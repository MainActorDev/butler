/** file source connector (plan Stage 3): markdown/text files (and binary
 *  attachments) from a directory — the demo's fixture "tickets" ride this. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { NormalizedDocument, SourceConnector } from './connector.ts';

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml']);

export interface FileSourceConfig {
  root: string;
  /** limit total files (a path is a source; keep it scoped) */
  maxFiles?: number;
}

export function fileConnector(sourceId: string, cfg: FileSourceConfig): SourceConnector {
  const max = cfg.maxFiles ?? 500;
  return {
    kind: 'file',
    sourceId,
    async fetch() {
      const out: NormalizedDocument[] = [];
      const walk = (dir: string): void => {
        if (out.length >= max) return;
        for (const entry of readdirSync(dir).sort()) {
          if (out.length >= max) break;
          const p = join(dir, entry);
          const st = statSync(p);
          if (st.isDirectory()) { walk(p); continue; }
          const ext = entry.slice(entry.lastIndexOf('.')).toLowerCase();
          const uri = `file://${relative(cfg.root, p)}`;
          if (TEXT_EXT.has(ext)) {
            out.push({ uri, title: entry, content: readFileSync(p, 'utf8'), kind: ext === '.md' || ext === '.markdown' ? 'markdown' : ext.slice(1) });
          } else {
            out.push({ uri, title: entry, content: null, kind: `binary${ext}`, bytes: new Uint8Array(readFileSync(p)) });
          }
        }
      };
      walk(cfg.root);
      return out;
    },
  };
}
