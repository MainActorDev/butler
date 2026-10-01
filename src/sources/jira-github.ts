/** jira + github connectors (plan Stage 3): REST fetchers normalized into
 *  documents. Injectable fetch; tests use recorded responses (no live
 *  network in CI). Fields → jira-ticket chunks; diffs → diff chunks. */
import type { NormalizedDocument, SourceConnector } from './connector.ts';

export interface JiraSourceConfig {
  baseUrl: string;      // e.g. https://lionparcel.atlassian.net
  project: string;      // project key
  /** auth: PAT/basic via env, resolved by the CONSUMER (never stored) */
  authHeader?: string;
  jql?: string;
  maxIssues?: number;
}

interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    description?: string | null;
    status?: { name?: string };
    comment?: { comments?: Array<{ author?: { displayName?: string }; body?: string }> };
    attachment?: Array<{ filename?: string; id?: string }>;
  };
}

function issueToDoc(issue: JiraIssue): NormalizedDocument {
  const f = issue.fields;
  const lines = [
    `KEY: ${issue.key}`,
    `SUMMARY: ${f.summary ?? ''}`,
    `STATUS: ${f.status?.name ?? ''}`,
    `DESCRIPTION: ${f.description ?? ''}`,
    ...(f.attachment ?? []).map((a, i) => `ATTACHMENT ${i + 1}: ${a.filename ?? a.id ?? 'unknown'}`),
    ...(f.comment?.comments ?? []).map((c) => `COMMENT (${c.author?.displayName ?? '?'}): ${c.body ?? ''}`),
  ];
  return { uri: `jira://${issue.key}`, title: `${issue.key} ${f.summary ?? ''}`, content: lines.join('\n'), kind: 'jira-ticket' };
}

export function jiraConnector(sourceId: string, cfg: JiraSourceConfig, fetchImpl: typeof fetch = fetch): SourceConnector {
  return {
    kind: 'jira',
    sourceId,
    async fetch(signal) {
      const jql = cfg.jql ?? `project = "${cfg.project}" ORDER BY updated DESC`;
      const res = await fetchImpl(
        `${cfg.baseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${cfg.maxIssues ?? 20}&fields=summary,description,status,comment,attachment`,
        { headers: { ...(cfg.authHeader ? { authorization: cfg.authHeader } : {}), accept: 'application/json' }, ...(signal ? { signal } : {}) },
      );
      if (!res.ok) throw new Error(`jira search failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const body = (await res.json()) as { issues?: JiraIssue[] };
      return (body.issues ?? []).map(issueToDoc);
    },
  };
}

export interface GithubSourceConfig {
  repo: string;         // owner/name
  /** issue numbers to pull; empty = recent open issues */
  issues?: number[];
  /** PR numbers whose diffs to pull */
  pulls?: number[];
  token?: string;
  maxItems?: number;
}

interface GhIssue { number: number; title: string; body: string | null; state: string; user?: { login?: string } }

export function githubConnector(sourceId: string, cfg: GithubSourceConfig, fetchImpl: typeof fetch = fetch): SourceConnector {
  const headers = { accept: 'application/vnd.github+json', ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) };
  return {
    kind: 'github',
    sourceId,
    async fetch(signal) {
      const out: NormalizedDocument[] = [];
      const gh = async (path: string): Promise<Response> => fetchImpl(`https://api.github.com${path}`, { headers, ...(signal ? { signal } : {}) });
      const issueDoc = (i: GhIssue): NormalizedDocument => ({
        uri: `github://${cfg.repo}/issues/${i.number}`,
        title: `#${i.number} ${i.title}`,
        content: `NUMBER: ${i.number}\nTITLE: ${i.title}\nSTATE: ${i.state}\nAUTHOR: ${i.user?.login ?? ''}\nBODY: ${i.body ?? ''}`,
        kind: 'jira-ticket', // same field-chunking discipline
      });

      if (cfg.issues?.length) {
        for (const n of cfg.issues.slice(0, cfg.maxItems ?? 20)) {
          const r = await gh(`/repos/${cfg.repo}/issues/${n}`);
          if (r.ok) out.push(issueDoc((await r.json()) as GhIssue));
        }
      } else {
        const r = await gh(`/repos/${cfg.repo}/issues?state=open&per_page=${cfg.maxItems ?? 20}`);
        if (r.ok) for (const i of (await r.json()) as GhIssue[]) out.push(issueDoc(i));
      }

      for (const n of cfg.pulls ?? []) {
        const r = await gh(`/repos/${cfg.repo}/pulls/${n}`);
        if (!r.ok) continue;
        const pr = (await r.json()) as { number: number; title: string; diff_url?: string; body?: string | null };
        out.push({
          uri: `github://${cfg.repo}/pulls/${n}`,
          title: `PR #${n} ${pr.title}`,
          content: `NUMBER: ${n}\nTITLE: ${pr.title}\nBODY: ${pr.body ?? ''}`,
          kind: 'jira-ticket',
        });
        const d = await fetchImpl(`https://api.github.com/repos/${cfg.repo}/pulls/${n}`, { headers: { ...headers, accept: 'application/vnd.github.diff' }, ...(signal ? { signal } : {}) });
        if (d.ok) {
          out.push({ uri: `github://${cfg.repo}/pulls/${n}.diff`, title: `PR #${n} diff`, content: await d.text(), kind: 'diff' });
        }
      }
      return out;
    },
  };
}
