/** Exact serialized-char length + a tokenizer-free token estimate (chars/4).
 * chars is the primary comparable metric (mirrors the usage log's result_chars);
 * tokensEst is a consistent relative proxy — swap in a real tokenizer if needed. */
export function measurePayload(payload: unknown): { chars: number; tokensEst: number } {
  const chars = JSON.stringify(payload ?? null).length;
  return { chars, tokensEst: Math.ceil(chars / 4) };
}
