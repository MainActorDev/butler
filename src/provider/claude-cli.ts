/** P1 C4 — claude-cli executor adapter: runs `claude -p --bare` as a Butler
 *  Provider. Butler's permission gate stays UPSTREAM (registry + policy);
 *  the subprocess runs with --permission-prompts none so nothing waits on a
 *  human, and --allowedTools derived from the policy class as defense in
 *  depth. Session continuity via --resume (Claude Code session ids).
 *
 *  Flags (verified against code.claude.com headless docs, 2026-10-10):
 *    -p --bare              one-shot, no host context (hooks/skills/CLAUDE.md)
 *    --output-format stream-json  newline-delimited JSON events on stdout
 *    --resume <sessionId>   continue a prior session (empty here = fresh)
 *    --allowedTools …       tool allowlist
 *    --permission-prompts none   never block on permission
 *  Shutdown discipline: SIGINT ends the in-flight turn cleanly; SIGTERM is
 *  the hard fallback after a grace period (a SIGTERM'd turn is LOST). */

import { spawn, type ChildProcess } from 'node:child_process';
import { ProviderError } from './types.ts';
import type { Provider, ProviderConfig, ProviderMessage, ProviderResponse, ProviderTool } from './types.ts';
import type { ExecutorConfig } from '../profile/profile.ts';

export interface ClaudeCliEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null;
  tool_use_id?: string;
  message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown; is_error?: boolean; content?: unknown }> };
  error?: string;
  /** v0.5.3 --include-partial-messages: Anthropic SSE events wrapped by the CLI.
   *  content_block_delta carries text_delta — the true token stream. */
  stream_event?: { type?: string; delta?: { type?: string; text?: string }; message?: { content?: Array<{ type: string; text?: string }> } };
}

/** lioclaw pattern: the one meaningful argument of a tool call (command,
 *  file path, query…) so traces read "⏵ Bash sqlite3 …" not "⏵ Bash…". */
function inputSummary(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const m = raw as Record<string, unknown>;
  for (const k of ['command', 'file_path', 'path', 'query', 'pattern', 'url', 'prompt', 'description', 'issue_key']) {
    const v = m[k];
    if (typeof v === 'string' && v.trim()) return v.split('\n')[0]!.slice(0, 90);
  }
  return '';
}

const INTERNAL_PROGRESS = new Set(['thinking_tokens', 'task_progress', 'task_started', 'background_tasks_changed']);

export class ClaudeCliProvider implements Provider {
  readonly model: string;
  /** R2-F4: per-CALLER claude session map — one provider instance may serve many
   *  Lionidas sessions; each keeps its own --resume continuity. A null/unset key
   *  falls back to the legacy single-session behavior (back-compat). */
  private readonly sessionIds = new Map<string, string>();
  private sessionId: string | null = null;
  private child: ChildProcess | null = null;

  constructor(private cfg: ProviderConfig & { binPath?: string; policyClass?: 'read' | 'draft' | 'act'; env?: Record<string, string>; mcpConfigPath?: string }) {
    this.model = cfg.model || 'claude-cli';
  }

  /** map policy → claude tool allowlist (defense in depth; the registry is the real gate) */
  private allowedTools(): string[] {
    // rev15: Bash is NEVER granted — the Lionidas registry rides MCP and all
    // data access flows through policy-gated tools. Read/Grep/Glob stay for
    // the agent's own scratch context; file writes stay draft-class.
    // rev16: filesystem access is READ-ONLY at the harness level. Drafting
    // flows through the Lionidas registry tools (case.draft.* etc.) which
    // persist via the server, never by editing files in place.
    // rev17c: the MCP server tools are ALLOWED by prefix — acceptEdits still
    // prompts for anything not allowlisted (headless = denied). The deny-list
    // remains the wall for Bash/Web/Task/Notebook.
    void this.cfg;
    return ['Read', 'Grep', 'Glob', 'LS', 'mcp__lionidas'];
  }

  async complete(
    messages: ProviderMessage[],
    _tools: ProviderTool[],
    opts: { remainingMs: number; signal?: AbortSignal | undefined; onDelta?: (delta: string) => void; onTool?: (e: { phase: 'call' | 'result'; name: string; arg?: string; result?: string; isError?: boolean }) => void; sessionKey?: string },
  ): Promise<ProviderResponse> {
    const bin = (this.cfg as { binPath?: string }).binPath ?? 'claude';
    // R2-F4: isolation — the caller's key addresses its OWN claude session
    const activeSession = opts.sessionKey !== undefined
      ? this.sessionIds.get(opts.sessionKey) ?? null
      : this.sessionId;
    const args: string[] = ['-p', '--bare',
      '--output-format', 'stream-json', '--verbose',
      // v0.5.3: token-level deltas — without this flag the CLI buffers each
      // assistant message and emits ONE complete event (the whole answer
      // arrived as a single chunk at completion; the UI spun on dots for the
      // entire turn). stream_event blocks carry text deltas as they generate.
      '--include-partial-messages',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', ...this.allowedTools(),
      // HARD deny — allowedTools is only a hint; disallowedTools is the wall.
      // No shell, no web, no sub-agents, no notebooks: all data flows through
      // the policy-gated MCP registry.
      '--disallowedTools', 'Bash', 'WebSearch', 'WebFetch', 'Task', 'NotebookEdit',
    ];
    // MCP mount (Lionidas tools as REAL registry tools — policy-gated, audited —
    // instead of the model shelling out with Bash/sqlite3)
    const mcp = (this.cfg as { mcpConfigPath?: string }).mcpConfigPath;
    if (mcp) args.push('--mcp-config', mcp);
    if (activeSession) args.push('--resume', activeSession);

    // conversation → a single prompt (claude -p is turn-based; the system
    // role rides --append-system-prompt to keep it out of the user turn).
    // R2-F1: history must ride the prompt TEXT — claude -p is stateless without
    // --resume, and cross-provider turns (workflow skills) never share a claude
    // session, so transcript rows would otherwise vanish from context.
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n');
    if (system) args.push('--append-system-prompt', system);
    const userTurn = [...messages].reverse().find((m) => m.role === 'user');
    const priorTurns = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    const lastUserIdx = priorTurns.map((m) => m.role).lastIndexOf('user');
    const history = priorTurns.slice(0, lastUserIdx === -1 ? undefined : lastUserIdx);
    const historyBlock = history.length
      ? `## Conversation so far\n${history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content ?? ''}`).join('\n\n')}\n\n## Current message\n`
      : '';
    const prompt = `${historyBlock}${userTurn?.content ?? ''}`;

    return new Promise<ProviderResponse>((resolve, reject) => {
      const child = spawn(bin, [...args, prompt], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // GLM-via-claude: inject the Anthropic-protocol endpoint vars for THIS
        // subprocess only — never touches the host's ~/.claude/settings.json
        ...(this.cfg.env ? { env: { ...process.env, ...this.cfg.env } } : {}),
      });
      this.child = child;
      let buf = '';
      let stderr = '';
      const events: ClaudeCliEvent[] = [];
      let settled = false;
      // correlate tool_results to calls by ORDER (result blocks carry no name)
  const pendingCalls: string[] = [];
  const onLine = (line: string): void => {
        const t = line.trim();
        if (!t) return;
        let ev: ClaudeCliEvent;
        try { ev = JSON.parse(t) as ClaudeCliEvent; } catch { return; }
        events.push(ev);
        // lioclaw-style live trace: ⏵ tool + arg summary, ⎿ result head
        // v0.5.3 partial stream: text_delta events ARE the live token stream.
        // The final 'assistant' event below still fires with the complete text
        // — consumers must append, not replace (the transport's chunk rail is
        // append-only by design).
        if (ev.type === 'stream_event' && ev.stream_event) {
          const se = ev.stream_event;
          if (se.type === 'content_block_delta' && se.delta?.type === 'text_delta' && se.delta.text) {
            opts.onDelta?.(se.delta.text);
          }
          return; // infrastructure events; the full assistant message still arrives
        }
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const blk of ev.message.content) {
            if (blk.type === 'text' && blk.text) {
              if (!INTERNAL_PROGRESS.has(blk.text.trim())) opts.onDelta?.(blk.text);
            }
            if (blk.type === 'tool_use') {
              const sum = inputSummary(blk.input);
              const nm = blk.name ?? 'tool';
              pendingCalls.push(nm);
              if (sum) opts.onTool?.({ phase: 'call', name: nm, arg: sum });
              else opts.onTool?.({ phase: 'call', name: nm });
            }
          }
        }
        if (ev.type === 'user' && ev.message?.content) {
          for (const blk of ev.message.content) {
            if (blk.type !== 'tool_result') continue;
            const text = typeof blk.content === 'string' ? blk.content
              : Array.isArray(blk.content) ? (blk.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ') : '';
            const head = text.trim().split('\n')[0] ?? '';
            if (head) {
              const nm = pendingCalls.shift() ?? 'tool';
              if (blk.is_error) opts.onTool?.({ phase: 'result', name: nm, result: head.slice(0, 160), isError: true });
              else opts.onTool?.({ phase: 'result', name: nm, result: head.slice(0, 160) });
            }
          }
        }
      };

      const shutdown = (why: string): void => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGINT');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 2_000);
        void why;
      };
      // claude-cli is a HARNESS: one complete() spans its whole internal tool loop —
      // agentic turns routinely exceed 2min. Default 10min (matches the loop's wall
      // budget); the loop still clamps via remainingMs.
      const timer = setTimeout(() => shutdown('timeout'), Math.min(this.cfg.timeoutMs ?? 600_000, Math.max(1, opts.remainingMs)));

      child.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) onLine(l);
      });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', (err) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        reject(new ProviderError(`claude-cli spawn failed: ${err.message}`, 'PROVIDER_UNAVAILABLE'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return; settled = true;
        if (buf.trim()) onLine(buf); // final unterminated line
        const init = events.find((e) => e.type === 'system' && e.session_id);
        if (init?.session_id) {
          if (opts.sessionKey !== undefined) this.sessionIds.set(opts.sessionKey, init.session_id);
          else this.sessionId = init.session_id;
        }
        const result = events.find((e) => e.type === 'result');
        if (code !== 0 && !result) {
          reject(new ProviderError(`claude-cli exited ${code}: ${stderr.slice(0, 300)}`, 'PROVIDER_UNAVAILABLE', code ?? undefined, true));
          return;
        }
        if (!result) {
          reject(new ProviderError(`claude-cli produced no result event (exit ${code})`, 'PROVIDER_UNAVAILABLE', code ?? undefined, false));
          return;
        }
        if (result.error?.includes('session')) {
          this.sessionId = null;
          reject(new ProviderError(`claude-cli session lost: ${result.error}`, 'PROVIDER_BAD_REQUEST', undefined, true));
          return;
        }
        const text = result.result ?? '';
        const u = result.usage;
        resolve({
          message: { role: 'assistant', content: text || null },
          usage: u ? {
            promptTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
            completionTokens: u.output_tokens ?? 0,
          } : null,
          finishReason: 'stop',
        });
      });

      opts.signal?.addEventListener('abort', () => shutdown('abort'), { once: true });
    });
  }

  /** last claude session id (for --resume continuity) */
  get claudeSessionId(): string | null { return this.sessionId; }

  async close(): Promise<void> {
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGINT');
      await new Promise((r) => setTimeout(r, 100));
      try { this.child.kill('SIGKILL'); } catch { /* gone */ }
    }
  }
}

export function claudeCliProvider(cfg: ExecutorConfig & { binPath?: string; policyClass?: 'read' | 'draft' | 'act'; env?: Record<string, string>; mcpConfigPath?: string }): Provider {
  return new ClaudeCliProvider(cfg);
}
