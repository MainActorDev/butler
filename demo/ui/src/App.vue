<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';

// ── types (API shapes only — the UI is a consumer like any other) ──
interface SessionRow { id: string; title: string | null; status: string; tokens_in: number; tokens_out: number; created_at: number }
interface MessageRow { role: string; content: string | null; tool_calls_json: string | null; created_at: number }
interface DocRow { sha256: string; uri: string; title: string; kind: string; fetched_at: number }
interface NoteRow { id: string; scope_key: string; kind: string; content: string; source_ref: string; created_at: number }
interface TurnEventMsg { type: string; sessionId: string; hop?: number; detail?: { name?: string; id?: string; bytes?: number; answer?: string; finishReason?: string | null } }

const sessions = ref<SessionRow[]>([]);
const sessionId = ref<string | null>(null);
const messages = ref<MessageRow[]>([]);
const events = ref<Array<{ t: number; e: TurnEventMsg }>>([]);
const docs = ref<DocRow[]>([]);
const notes = ref<NoteRow[]>([]);
const input = ref('');
const busy = ref(false);
const wsState = ref('connecting');
const providerLive = ref(true);
const tab = ref<'chat' | 'sessions' | 'documents' | 'notes'>('chat');
let ws: WebSocket | null = null;

const state = reactive({ error: '' });

async function refreshSessions(): Promise<void> {
  const r = await fetch('/api/agent/sessions');
  if (r.ok) sessions.value = ((await r.json()) as { sessions: SessionRow[] }).sessions;
}
async function refreshDocs(): Promise<void> {
  const r = await fetch('/api/agent/documents');
  if (r.ok) docs.value = ((await r.json()) as { documents: DocRow[] }).documents;
}
async function refreshNotes(): Promise<void> {
  const r = await fetch('/api/agent/notes');
  if (r.ok) notes.value = ((await r.json()) as { notes: NoteRow[] }).notes;
}

async function newSession(): Promise<void> {
  const r = await fetch('/api/agent/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: `session ${new Date().toLocaleTimeString()}` }) });
  const { session } = (await r.json()) as { session: SessionRow };
  sessionId.value = session.id;
  messages.value = [];
  events.value = [];
  await refreshSessions();
}

async function openSession(id: string): Promise<void> {
  sessionId.value = id;
  const r = await fetch(`/api/agent/sessions/${id}`);
  if (r.ok) {
    const body = (await r.json()) as { messages: MessageRow[] };
    messages.value = body.messages ?? [];
  }
  tab.value = 'chat';
}

async function send(): Promise<void> {
  if (!sessionId.value || !input.value.trim() || busy.value) return;
  const content = input.value;
  input.value = '';
  busy.value = true;
  messages.value.push({ role: 'user', content, tool_calls_json: null, created_at: Date.now() });
  try {
    const r = await fetch(`/api/agent/sessions/${sessionId.value}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const { turn } = (await r.json()) as { turn: { ok: boolean; answer?: string; error?: string; tokens?: { in: number; out: number } } };
    messages.value.push({
      role: 'assistant',
      content: turn.ok ? (turn.answer ?? '') : `✗ ${turn.error ?? 'turn failed'}`,
      tool_calls_json: null,
      created_at: Date.now(),
    });
  } catch (err) {
    state.error = String(err);
  } finally {
    busy.value = false;
  }
}

async function abortTurn(): Promise<void> {
  if (!sessionId.value) return;
  await fetch(`/api/agent/sessions/${sessionId.value}/abort`, { method: 'POST' });
}

function connectWs(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { wsState.value = 'live'; };
  ws.onclose = () => { wsState.value = 'down'; setTimeout(connectWs, 2000); };
  ws.onerror = () => { wsState.value = 'down'; };
  ws.onmessage = (m) => {
    try {
      const e = JSON.parse(String(m.data)) as TurnEventMsg;
      if (sessionId.value && e.sessionId !== sessionId.value) return; // only this session's turns
      events.value.push({ t: Date.now(), e });
    } catch { /* not ours */ }
  };
}

onMounted(async () => {
  connectWs();
  await Promise.all([refreshSessions(), refreshDocs(), refreshNotes()]);
  // provider banner: ask the demo (cheap heuristic — the demo logs provider in its boot; probe via a headers trick is overkill; default live)
  providerLive.value = true;
});
onUnmounted(() => ws?.close());
</script>

<template>
  <div class="app">
    <header>
      <span class="brand">🤵 butler demo</span>
      <span class="ws" :class="wsState">events: {{ wsState }}</span>
      <nav>
        <button :class="{ active: tab === 'chat' }" @click="tab = 'chat'">chat</button>
        <button :class="{ active: tab === 'sessions' }" @click="tab = 'sessions'; refreshSessions()">sessions</button>
        <button :class="{ active: tab === 'documents' }" @click="tab = 'documents'; refreshDocs()">documents</button>
        <button :class="{ active: tab === 'notes' }" @click="tab = 'notes'; refreshNotes()">notes</button>
      </nav>
    </header>

    <main>
      <!-- CHAT -->
      <section v-if="tab === 'chat'" class="chat">
        <div class="sessionbar">
          <select :model-value="sessionId ?? ''" @change="openSession(($event.target as HTMLSelectElement).value)">
            <option value="" disabled>— pick a session —</option>
            <option v-for="s in sessions" :key="s.id" :value="s.id">{{ s.title ?? s.id }} · {{ s.status }} · {{ s.tokens_in + s.tokens_out }} tok</option>
          </select>
          <button @click="newSession">new session</button>
          <button :disabled="!busy" @click="abortTurn">abort</button>
        </div>

        <div class="cols">
          <div class="thread">
            <div v-if="!sessionId" class="empty">Create a session and try: “Draft a spec for DEMO-101, validate it, and cite the sha256 you used.”</div>
            <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
              <span class="who">{{ m.role }}</span>
              <span class="body">{{ m.content ?? '(tool call)' }}</span>
            </div>
            <div v-if="busy" class="msg assistant pending">… thinking (watch the feed →)</div>
          </div>

          <div class="feed">
            <div class="feedtitle">live feed — tool calls & verdicts as they happen</div>
            <div v-for="(ev, i) in events.slice().reverse()" :key="i" class="evt" :class="ev.e.type">
              <span class="etype">{{ ev.e.type }}</span>
              <span v-if="ev.e.detail?.name" class="ename">{{ ev.e.detail.name }}</span>
              <span v-if="ev.e.hop" class="ehop">hop {{ ev.e.hop }}</span>
            </div>
          </div>
        </div>

        <form class="composer" @submit.prevent="send">
          <input v-model="input" :disabled="!sessionId || busy" placeholder="ask the agent…" />
          <button :disabled="!sessionId || busy || !input.trim()">send</button>
        </form>
      </section>

      <!-- SESSIONS -->
      <section v-else-if="tab === 'sessions'" class="table">
        <table>
          <thead><tr><th>id</th><th>title</th><th>status</th><th>tokens in/out</th><th>created</th><th></th></tr></thead>
          <tbody>
            <tr v-for="s in sessions" :key="s.id">
              <td class="mono">{{ s.id.slice(0, 17) }}</td>
              <td>{{ s.title }}</td>
              <td :class="s.status">{{ s.status }}</td>
              <td>{{ s.tokens_in }}/{{ s.tokens_out }}</td>
              <td>{{ new Date(s.created_at).toLocaleTimeString() }}</td>
              <td><button @click="openSession(s.id); tab = 'chat'">open</button></td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- DOCUMENTS -->
      <section v-else-if="tab === 'documents'" class="table">
        <p class="hint">ingested sources — content-addressed by sha256 (the agent cites these)</p>
        <table>
          <thead><tr><th>title</th><th>uri</th><th>kind</th><th>sha256</th></tr></thead>
          <tbody>
            <tr v-for="d in docs" :key="d.sha256">
              <td>{{ d.title }}</td>
              <td class="mono">{{ d.uri }}</td>
              <td>{{ d.kind }}</td>
              <td class="mono">{{ d.sha256.slice(0, 16) }}…</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- NOTES -->
      <section v-else class="table">
        <p class="hint">distilled knowledge — provenance-stamped, supersession (never deleted)</p>
        <table>
          <thead><tr><th>kind</th><th>scope</th><th>content</th><th>source (provenance)</th></tr></thead>
          <tbody>
            <tr v-for="n in notes" :key="n.id">
              <td>{{ n.kind }}</td>
              <td class="mono">{{ n.scope_key }}</td>
              <td>{{ n.content }}</td>
              <td class="mono">{{ n.source_ref }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>
  </div>
</template>

<style scoped>
.app { font-family: ui-monospace, 'SF Mono', Menlo, monospace; color: #e6edf3; background: #0d1117; min-height: 100vh; display: flex; flex-direction: column; }
header { display: flex; align-items: center; gap: 16px; padding: 10px 16px; border-bottom: 1px solid #30363d; }
.brand { font-weight: 700; }
.ws { font-size: 12px; }
.ws.live { color: #3fb950; }
.ws.down, .ws.connecting { color: #d29922; }
nav { margin-left: auto; display: flex; gap: 6px; }
nav button { background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-family: inherit; }
nav button.active { border-color: #58a6ff; color: #58a6ff; }
main { flex: 1; padding: 16px; overflow: auto; }
.chat { display: flex; flex-direction: column; height: calc(100vh - 120px); }
.sessionbar { display: flex; gap: 8px; margin-bottom: 10px; }
.sessionbar select { flex: 1; background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 6px; font-family: inherit; }
button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-family: inherit; }
button:disabled { opacity: 0.45; cursor: default; }
.cols { flex: 1; display: grid; grid-template-columns: 1.4fr 1fr; gap: 12px; min-height: 0; }
.thread, .feed { background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow-y: auto; padding: 10px; }
.feedtitle { color: #8b949e; font-size: 11px; margin-bottom: 6px; }
.empty { color: #8b949e; padding: 20px; text-align: center; }
.msg { margin-bottom: 8px; }
.msg .who { color: #8b949e; font-size: 10px; display: block; }
.msg.user .body { color: #58a6ff; }
.msg.assistant .body { white-space: pre-wrap; }
.msg.pending { color: #d29922; }
.evt { display: flex; gap: 8px; font-size: 12px; padding: 3px 0; border-bottom: 1px dashed #21262d; }
.etype { color: #8b949e; min-width: 120px; }
.evt.tool-call .etype { color: #39c5cf; }
.evt.tool-result .etype { color: #3fb950; }
.evt.turn-error .etype { color: #f85149; }
.ename { color: #e6edf3; }
.ehop { color: #6e7681; margin-left: auto; }
.composer { display: flex; gap: 8px; margin-top: 10px; }
.composer input { flex: 1; background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 8px; font-family: inherit; }
.table table { width: 100%; border-collapse: collapse; }
.table th, .table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #21262d; font-size: 13px; }
.table th { color: #8b949e; font-size: 11px; text-transform: uppercase; }
.mono { font-size: 12px; color: #8b949e; }
.hint { color: #8b949e; font-size: 12px; margin-bottom: 10px; }
tr.active td, td.active { color: #3fb950; }
tr.error td, td.error { color: #f85149; }
</style>
