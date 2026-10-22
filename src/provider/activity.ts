/** chat-reliability F2 — text BLOCK lifecycle (the glued-narration fix).
 *  Streams of per-token deltas concatenate into ONE block per assistant
 *  message (hop); without explicit start/end boundaries a replayed log glues
 *  consecutive hops' narration together ("…checked.develop…"). This module is
 *  the minimal typed contract plus a stateful tracker the loop feeds; the
 *  transport derives durable block metadata from it (chunk-rail enrichment).
 *
 *  Byte-exactness contract: the tracker forwards ONLY the delta bytes it is
 *  given — it never joins, pads, trims, or injects whitespace. Chunk splits
 *  inside a block (de + velop) concatenate byte-exactly. */

/** One activity per block boundary or delta. `native` carries the provider's
 *  own block identity (e.g. an Anthropic content-block id) when one exists;
 *  blockId is the loop-allocated durable identity. `text` is the delta text
 *  for start/delta and the FULL block text for end. */
export type TextBlockActivity = { type: 'text.start' | 'text.delta' | 'text.end'; hop: number; blockId: string; native?: string; text: string };

/** Stateful per-run block tracker. One assistant message per hop = ONE block:
 *  - first delta of a hop → text.start (with the allocated blockId), then
 *    text.delta for that same chunk
 *  - every delta (including the first) → text.delta
 *  - onMessageComplete(hop, fullText) → text.end with the FULL block text
 *  - a hop with no deltas emits NOTHING (no phantom blocks) */
export function createBlockTracker(
  emit: (a: TextBlockActivity) => void,
  allocBlockId: (hop: number) => string,
): { onDelta(hop: number, delta: string): void; onMessageComplete(hop: number, fullText: string): void } {
  let open: { hop: number; blockId: string } | null = null;
  return {
    onDelta(hop: number, delta: string): void {
      if (!open || open.hop !== hop) {
        // a fresh hop opens a fresh block; an unclosed prior block is simply
        // left unterminated — its deltas are already durable downstream.
        open = { hop, blockId: allocBlockId(hop) };
        emit({ type: 'text.start', hop, blockId: open.blockId, text: delta });
      }
      emit({ type: 'text.delta', hop, blockId: open.blockId, text: delta });
    },
    onMessageComplete(hop: number, fullText: string): void {
      if (!open || open.hop !== hop) return; // no deltas streamed → no block → nothing to end
      emit({ type: 'text.end', hop, blockId: open.blockId, text: fullText });
      open = null;
    },
  };
}
