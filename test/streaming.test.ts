import { describe, it, expect } from 'vitest';
import { OpenAICompatProvider } from '../src/provider/openai-compat.ts';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('openai-compat streaming (onDelta)', () => {
  it('accumulates delta.content, calls onDelta live, returns full message + usage', async () => {
    const seen: string[] = [];
    const fetchImpl = (async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" wor"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ld"}}],"usage":null}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ])) as unknown as typeof fetch;
    const p = new OpenAICompatProvider({ baseUrl: 'http://x', apiKey: 'k', model: 'm' }, { fetchImpl });
    const res = await p.complete([{ role: 'user', content: 'hi' }], [], { remainingMs: 5_000, onDelta: (d) => seen.push(d) });
    expect(seen).toEqual(['Hello', ' wor', 'ld']);
    expect(res.message.content).toBe('Hello world');
    expect(res.finishReason).toBe('stop');
    expect(res.usage).toEqual({ promptTokens: 7, completionTokens: 3 });
  });

  it('accumulates fragmented tool calls across chunks', async () => {
    const fetchImpl = (async () => sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"cases","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".li"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"st"}}]}}]}\n\n',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ])) as unknown as typeof fetch;
    const p = new OpenAICompatProvider({ baseUrl: 'http://x', apiKey: 'k', model: 'm' }, { fetchImpl });
    const res = await p.complete([{ role: 'user', content: 'hi' }], [], { remainingMs: 5_000, onDelta: () => {} });
    expect(res.message.content).toBeNull();
    expect(res.message.tool_calls?.[0]?.function.name).toBe('cases');
    expect(res.message.tool_calls?.[0]?.function.arguments).toBe('.list');
  });

  it('non-streaming path unchanged when onDelta is absent', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'plain' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })) as unknown as typeof fetch;
    const p = new OpenAICompatProvider({ baseUrl: 'http://x', apiKey: 'k', model: 'm' }, { fetchImpl });
    const res = await p.complete([{ role: 'user', content: 'hi' }], [], { remainingMs: 5_000 });
    expect(res.message.content).toBe('plain');
  });
});
