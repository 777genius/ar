import { randomUUID } from "node:crypto";

/** Safe transport facts. No request/response text, headers or provider IDs. */
export enum ProviderCallState {
  Dispatched = "dispatched", Completed = "completed", Failed = "failed", Cancelled = "cancelled", Unknown = "unknown",
}
export enum ProviderCallProtocol { Responses = "responses", AnthropicMessages = "anthropic_messages" }
export interface ProviderCallObservation {
  readonly schemaVersion: 1;
  readonly callId: string;
  readonly revision: number;
  readonly requestedModel: string;
  readonly occurredAt: string;
  readonly state: ProviderCallState;
  readonly dispatchEffect: "dispatched" | "effect_unknown";
  readonly actualModel: string | null;
  readonly durationMs: number | null;
  readonly httpStatus: number | null;
  readonly tokens: Readonly<{ inputTotal: number | null; outputTotal: number | null; cacheRead: number | null; cacheWrite: number | null; reasoning: number | null; total: number | null }>;
  readonly completeness: "complete" | "partial" | "unknown";
}
export type ProviderCallObserver = (fact: ProviderCallObservation) => void | Promise<void>;

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const count = (v: unknown): number | null => Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : null;

/** One instance per actual upstream fetch, never per successful review. */
export function createProviderCallObservation(model: string, observer?: ProviderCallObserver, protocol = ProviderCallProtocol.Responses) {
  const callId = randomUUID(), occurredAt = new Date().toISOString(), started = performance.now();
  let revision = 0, terminal = false, status: number | null = null;
  let state = ProviderCallState.Unknown;
  let responseReceived = false, actualModel: string | null = null;
  let anthropicInput: number | null = null, anthropicRead: number | null = null, anthropicWrite: number | null = null;
  let tokens: ProviderCallObservation["tokens"] = { inputTotal: null, outputTotal: null, cacheRead: null, cacheWrite: null, reasoning: null, total: null };
  const emit = async (next: ProviderCallState) => {
    // Analytics errors cannot trigger another inference or replace its outcome.
    try { await observer?.({ schemaVersion: 1, callId, revision: ++revision, requestedModel: model, occurredAt,
      state: next, dispatchEffect: responseReceived ? "dispatched" : "effect_unknown", actualModel,
      durationMs: next === ProviderCallState.Dispatched ? null : Math.max(0, Math.floor(performance.now() - started)),
      httpStatus: status, tokens, completeness: [ProviderCallState.Completed, ProviderCallState.Failed].includes(next) && tokens.inputTotal !== null && tokens.outputTotal !== null ? "complete" :
        Object.values(tokens).some(v => v !== null) ? "partial" : "unknown" }); } catch { /* Producer reports its own delivery coverage. */ }
  };
  return {
    dispatched: () => emit(ProviderCallState.Dispatched),
    status(value: number) { responseReceived = true; status = value; if (value < 200 || value >= 300) state = ProviderCallState.Failed; },
    observe(value: unknown) {
      const frame = record(value), response = record(frame?.response) ?? record(frame?.message) ?? frame;
      if (typeof response?.model === "string" && /^[A-Za-z0-9._:/@+-]{1,200}$/.test(response.model)) actualModel = response.model;
      if (frame?.type === "message_stop" || Array.isArray(frame?.choices) && frame.choices.some(c => record(c)?.finish_reason != null)) state = ProviderCallState.Completed;
      if (response?.status === "completed" || frame?.type === "response.completed") state = ProviderCallState.Completed;
      if (["failed", "incomplete"].includes(String(response?.status)) || ["response.failed", "response.incomplete"].includes(String(frame?.type))) state = ProviderCallState.Failed;
      const usage = record(response?.usage); if (!usage) return;
      if (protocol === ProviderCallProtocol.AnthropicMessages) {
        if (Object.hasOwn(usage, "input_tokens")) anthropicInput = count(usage.input_tokens);
        if (Object.hasOwn(usage, "cache_read_input_tokens")) anthropicRead = count(usage.cache_read_input_tokens);
        if (Object.hasOwn(usage, "cache_creation_input_tokens")) anthropicWrite = count(usage.cache_creation_input_tokens);
        const inputTotal = anthropicInput !== null && anthropicRead !== null && anthropicWrite !== null ? count(anthropicInput + anthropicRead + anthropicWrite) : null;
        const outputTotal = Object.hasOwn(usage, "output_tokens") ? count(usage.output_tokens) : tokens.outputTotal;
        tokens = { inputTotal, outputTotal, cacheRead: anthropicRead, cacheWrite: anthropicWrite, reasoning: null,
          total: inputTotal !== null && outputTotal !== null ? count(inputTotal + outputTotal) : null };
        return;
      }
      const inputTotal = count(usage.input_tokens);
      const outputTotal = count(usage.output_tokens);
      const cached = count(record(usage.input_tokens_details)?.cached_tokens), reasoning = count(record(usage.output_tokens_details)?.reasoning_tokens);
      const cache = cached;
      tokens = { inputTotal, outputTotal, cacheRead: cache !== null && inputTotal !== null && cache <= inputTotal ? cache : null,
        cacheWrite: null,
        reasoning: reasoning !== null && outputTotal !== null && reasoning <= outputTotal ? reasoning : null,
        total: inputTotal !== null && outputTotal !== null && Number.isSafeInteger(inputTotal + outputTotal) ? inputTotal + outputTotal : null };
    },
    async finish(failed: boolean, aborted: boolean) {
      if (terminal) return; terminal = true;
      await emit(aborted ? ProviderCallState.Cancelled : failed ? ProviderCallState.Failed : state);
    },
  };
}
