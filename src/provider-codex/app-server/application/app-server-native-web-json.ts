import { createHash } from "node:crypto";

/** Stream a bounded prefix of JSON reserialization in insertion order. Transport
 * has already parsed JSON under the decoder's 4 MiB default / 64 MiB maximum.
 * No large stringify allocation; depth and output budgets also bound traversal.
 * Prefix bytes may end within a UTF-8 codepoint or escape, and are not JSON. */
export function boundedNativeWebJson(value: unknown, budget: number): {
  readonly bytes: number; readonly sha256: string; readonly complete: boolean;
} {
  const hash = createHash("sha256");
  let bytes = 0;
  const stop = Symbol();
  function emit(text: string): void {
    const buffer = Buffer.from(text);
    const take = Math.min(buffer.length, budget - bytes);
    if (take > 0) hash.update(buffer.subarray(0, take));
    bytes += take;
    if (take !== buffer.length) throw stop;
  }
  function string(text: string): void {
    emit('"');
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      // Serialize pairs together; JSON.stringify escapes unpaired surrogates.
      const pair = unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff;
      const token = text.slice(i, i + (pair ? 2 : 1));
      emit(JSON.stringify(token).slice(1, -1));
      if (pair) i++;
    }
    emit('"');
  }
  function visit(input: unknown, depth: number): void {
    if (depth > 128) throw stop;
    if (typeof input === 'string') { string(input); return; }
    if (typeof input === 'number' && !Number.isFinite(input)) throw stop;
    if (input === null || typeof input === 'boolean' || typeof input === 'number') { emit(JSON.stringify(input)); return; }
    if (Array.isArray(input)) {
      emit('[');
      for (let i = 0; i < input.length; i++) { if (i) emit(','); visit(input[i], depth + 1); }
      emit(']'); return;
    }
    if (input && typeof input === 'object') {
      emit('{'); let first = true;
      for (const key in input) {
        if (!Object.hasOwn(input, key)) continue;
        if (!first) emit(','); first = false;
        string(key); emit(':'); visit((input as Record<string, unknown>)[key], depth + 1);
      }
      emit('}'); return;
    }
    throw stop; // Only parsed transport JSON is supported; do not invent completion.
  }
  let complete = true;
  try { visit(value, 0); } catch (error) { if (error !== stop) throw error; complete = false; }
  return { bytes, sha256: hash.digest('hex'), complete };
}
