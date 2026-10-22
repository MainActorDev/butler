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
  message?: { content?: Array<{ type: string; text?: string; name?: string; id?: string; tool_use_id?: string; input?: unknown; is_error?: boolean; content?: unknown }> };
  error?: string;
  /** v0.5.3 --include-partial-messages: Anthropic SSE events wrapped by the CLI
   *  as {type:'stream_event', event:{...}}. content_block_delta carries
   *  text_delta (the answer tokens) and thinking_delta (reasoning, pre-answer). */
  stream_event?: never;
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
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


/** v0.5.5 cold-start serialization: the claude CLI has a boot race when two
 *  instances spawn at the same instant — both MCP handshakes stick 'pending'
 *  and the models see ZERO tools (probed: solo=54 tools, simultaneous=0,
 *  3s-staggered=54). The CLI contends on ~/.claude state during cold start;
 *  serializing the SPAWN window (not the whole run) sidesteps it. Module-level:
 *  applies across provider instances in one process. */
let coldStartChain: Promise<void> = Promise.resolve();
function serializeColdStart(gapMs: number): () => void {
  const prev = coldStartChain;
  let release!: () => void;
  coldStartChain = new Promise<void>((r) => { release = r; });
  void prev.then(() => { setTimeout(release, gapMs); });
  return release;
}

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
    // v0.6.2 editor mode (cwd set = worktree turn): grant native file editing so
    // the model applies edits inside the worktree — Bash/git stay HARD-denied;
    // the host owns all git operations. Non-cwd turns stay read-only.
    const cwd = (this.cfg as { cwd?: string }).cwd;
    if (cwd) return ['Read', 'Grep', 'Glob', 'LS', 'Edit', 'Write', 'NotebookRead', 'mcp__lionidas'];
    return ['Read', 'Grep', 'Glob', 'LS', 'mcp__lionidas'];
  }

  async complete(
    messages: ProviderMessage[],
    _tools: ProviderTool[],
    opts: { remainingMs: number; signal?: AbortSignal | undefined; onDelta?: (delta: string) => void; onTool?: (e: { phase: 'call' | 'result'; name: string; invocationId?: string; arg?: string; result?: string; isError?: boolean }) => void; sessionKey?: string },
  ): Promise<ProviderResponse> {
    // v0.5.5: the CLI cold-start race leaves MCP servers 'pending' at init —
    // the model would see zero tools (sess_88de6757). Serialization prevents
    // most races; VERIFY+RETRY covers the rest: completeOnce throws
    // MCP_PENDING (retryable) when its init event shows a pending server;
    // kill the child and respawn on a cleared lane (max 3 attempts).
    const mcp = (this.cfg as { mcpConfigPath?: string }).mcpConfigPath;
    const maxAttempts = mcp ? 3 : 1;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.completeOnce(messages, _tools, opts);
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof ProviderError && err.code === 'MCP_PENDING';
        if (!retryable || attempt === maxAttempts) throw err;
        // brief settle so the next boot starts from a calm state
        await new Promise((r) => setTimeout(r, 1_500));
      }
    }
    throw lastErr;
  }

  private async completeOnce(
    messages: ProviderMessage[],
    _tools: ProviderTool[],
    opts: { remainingMs: number; signal?: AbortSignal | undefined; onDelta?: (delta: string) => void; onTool?: (e: { phase: 'call' | 'result'; name: string; invocationId?: string; arg?: string; result?: string; isError?: boolean }) => void; sessionKey?: string },
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
      // v0.5.5: take the cold-start lane BEFORE spawning — concurrent CLI boots
      // race their MCP handshakes into 'pending' (zero tools). Released on the
      // init event (handshake done) or after 20s, whichever comes first.
      const releaseColdStart = serializeColdStart(3_000);
      // v0.5.5 hardening: --mcp-config is VARIADIC — an explicit terminator
      // keeps the trailing PROMPT from being eaten as another config path.
      const child = spawn(bin, [...args, '--', prompt], {
        cwd: (this.cfg as { cwd?: string }).cwd, // v0.6.1: worktree-mode spawns edit there
        stdio: ['ignore', 'pipe', 'pipe'],
        // GLM-via-claude: inject the Anthropic-protocol endpoint vars for THIS
        // subprocess only — never touches the host's ~/.claude/settings.json
        ...(this.cfg.env ? { env: { ...process.env, ...this.cfg.env } } : {}),
      });
      this.child = child;
      let coldStartFreed = false;
      const freeColdStart = (): void => { if (!coldStartFreed) { coldStartFreed = true; releaseColdStart(); } };
      setTimeout(freeColdStart, 20_000); // backstop: never hold the lane forever
      let buf = '';
      let stderr = '';
      const events: ClaudeCliEvent[] = [];
      let settled = false;
  // correlate tool_results to calls by ORDER (result blocks carry no name);
  // chat-reliability F2(b): entries keep the provider-NATIVE tool_use id so
  // results correlate to the same invocation the durable rail keyed.
  const pendingCalls: Array<{ name: string; id?: string }> = [];
  // F2(a): text_delta bytes streamed since the last assistant snapshot — the
  // completed snapshot must REPLACE/complete the streamed block, never
  // re-emit bytes the stream already delivered (duplicated narration).
  let streamedSinceSnapshot = '';
  const onLine = (line: string): void => {
        const t = line.trim();
        if (!t) return;
        let ev: ClaudeCliEvent;
        try { ev = JSON.parse(t) as ClaudeCliEvent; } catch { return; }
        events.push(ev);
        // v0.5.5: init event with a non-pending MCP server = handshake won —
        // free the cold-start lane for the next concurrent spawn
        if (ev.type === 'system' && ev.subtype === 'init') {
          // v0.5.5 verify+retry, STRONG oracle: the init event carries the REAL
          // tool list. If mcp servers were configured but ZERO mcp__* tools are
          // present (or any server is still pending), this boot lost the race —
          // the model would see no data tools. Kill + throw MCP_PENDING;
          // complete() respawns on a cleared lane.
          const servers = (ev as unknown as { mcp_servers?: Array<{ name?: string; status?: string }> }).mcp_servers ?? [];
          const initTools = (ev as unknown as { tools?: string[] }).tools ?? [];
          const mcpTools = initTools.filter((t) => t.startsWith('mcp__')).length;
          const anyPending = servers.some((sv) => sv.status === 'pending' || sv.status === 'connecting');
          if (servers.length > 0 && (anyPending || mcpTools === 0)) {
            child.kill('SIGKILL');
            if (!settled) { settled = true; reject(new ProviderError(`claude-cli MCP boot incomplete (pending=${anyPending}, mcpTools=${mcpTools}) — cold-start race, retrying`, 'MCP_PENDING', undefined, true)); }
            return;
          }
          freeColdStart();
        }
        if (ev.type === 'assistant') freeColdStart(); // model is running: fully booted
        // lioclaw-style live trace: ⏵ tool + arg summary, ⎿ result head
        // v0.5.3 partial stream: text_delta events ARE the live token stream.
        // The final 'assistant' event below still fires with the complete text
        // — consumers must append, not replace (the transport's chunk rail is
        // append-only by design).
        if (ev.type === 'stream_event') {
          const se = ev.event;
          if (se?.type === 'content_block_delta' && se.delta?.type === 'text_delta' && se.delta.text) {
            streamedSinceSnapshot += se.delta.text;
            opts.onDelta?.(se.delta.text); // the answer tokens, live
          }
          return; // thinking_delta & infrastructure events; the full assistant message still arrives
        }
        if (ev.type === 'assistant' && ev.message?.content) {
          // F2(a): the completed assistant message is the SNAPSHOT of the block
          // the stream (if any) already delivered. Never re-emit streamed bytes:
          //  - nothing streamed → snapshot-only mode: the blocks ARE the stream
          //  - snapshot extends the stream (cut mid-block) → emit only the tail
          //  - snapshot already streamed → emit nothing; its completion lands
          //    as the loop's text.end, not as duplicated deltas
          const textBlocks = (ev.message.content ?? [])
            .filter((b) => b.type === 'text' && b.text && !INTERNAL_PROGRESS.has(b.text.trim()))
            .map((b) => b.text as string);
          const snapshot = textBlocks.join('\n\n');
          if (streamedSinceSnapshot === '') {
            for (const t of textBlocks) opts.onDelta?.(t);
          } else if (snapshot.startsWith(streamedSinceSnapshot) && snapshot.length > streamedSinceSnapshot.length) {
            opts.onDelta?.(snapshot.slice(streamedSinceSnapshot.length));
          }
          streamedSinceSnapshot = '';
          for (const blk of ev.message.content) {
            if (blk.type === 'tool_use') {
              const sum = inputSummary(blk.input);
              const nm = blk.name ?? 'tool';
              pendingCalls.push({ name: nm, ...(blk.id !== undefined ? { id: blk.id } : {}) });
              if (sum) opts.onTool?.({ phase: 'call', name: nm, arg: sum, ...(blk.id !== undefined ? { invocationId: blk.id } : {}) });
              else opts.onTool?.({ phase: 'call', name: nm, ...(blk.id !== undefined ? { invocationId: blk.id } : {}) });
            }
          }
        }
        if (ev.type === 'user' && ev.message?.content) {
          for (const blk of ev.message.content) {
            if (blk.type !== 'tool_result') continue;
            const text = typeof blk.content === 'string' ? blk.content
              : Array.isArray(blk.content) ? (blk.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ') : '';
            // F2(c): FULL results — no first-line reduction, no 160-char clip,
            // and EMPTY results are recorded honestly (result:'', isError:false)
            // instead of being dropped from the trace.
            const pending = pendingCalls.shift() ?? { name: 'tool' };
            const invocationId = blk.tool_use_id ?? pending.id;
            opts.onTool?.({
              phase: 'result',
              name: pending.name,
              ...(invocationId !== undefined ? { invocationId } : {}),
              result: text,
              isError: Boolean(blk.is_error),
            });
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
        // butler#8: an interrupted CLI exits 0 with a result event carrying
        // EMPTY text — resolving that made the caller's abort look like an
        // empty answer (turn.failed) instead of the clean ABORTED outcome.
        // The caller aborted: reject, let the loop's signal-aware catch map it.
        if (opts.signal?.aborted) {
          reject(new ProviderError(`claude-cli aborted by caller (exit ${code})`, 'ABORTED', undefined, false));
          return;
        }
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
        // v0.5.4 (the million-token silent-empty bug, sess_e2e40228): a turn can
        // burn its whole context mid-agentic-run and the harness still reports
        // success with an EMPTY result string — the narration that streamed live
        // (assistant text blocks on this same stdout) is the partial work. Fall
        // back to it: partial content beats a silent empty completion.
        const streamedText = events
          .filter((e) => e.type === 'assistant' && e.message?.content)
          .flatMap((e) => (e.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? ''))
          .join('\n\n')
          .trim();
        const finalText = text.trim() ? text : streamedText;
        const u = result.usage;
        resolve({
          message: { role: 'assistant', content: finalText || null },
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

export function claudeCliProvider(cfg: ExecutorConfig & { binPath?: string; policyClass?: 'read' | 'draft' | 'act'; env?: Record<string, string>; mcpConfigPath?: string; cwd?: string }): Provider {
  return new ClaudeCliProvider(cfg);
}
