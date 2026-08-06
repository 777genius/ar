import type {
  OpenAiBridgeRuntimeSelection,
  OpenAiBridgeUsage,
} from "./openai-chat-contracts.js";

export function openAiBridgeRuntimeAttestationCanonicalBytes(input: {
  readonly selection: OpenAiBridgeRuntimeSelection;
  readonly usage: OpenAiBridgeUsage;
  readonly requestedOutputTokenLimit?: number;
}): Uint8Array {
  const payload = {
    schema_version: 1,
    attestation_level: "provider_receipt",
    usage_source: "codex_thread_token_usage_updated",
    runtime_selection: {
      account_binding_hmac_sha256:
        input.selection.account_binding_hmac_sha256,
      thread_id: input.selection.thread_id,
      turn_id: input.selection.turn_id,
      model: input.selection.model,
      model_provider: input.selection.model_provider,
      reasoning_effort: input.selection.reasoning_effort,
      service_tier: input.selection.service_tier,
    },
    usage: {
      prompt_tokens: input.usage.prompt_tokens,
      prompt_tokens_details: {
        cached_tokens: input.usage.prompt_tokens_details?.cached_tokens ?? 0,
        ...(input.usage.prompt_tokens_details?.cache_write_tokens === undefined
          ? {}
          : { cache_write_tokens: input.usage.prompt_tokens_details.cache_write_tokens }),
      },
      completion_tokens: input.usage.completion_tokens,
      completion_tokens_details: {
        reasoning_tokens:
          input.usage.completion_tokens_details?.reasoning_tokens ?? 0,
      },
      total_tokens: input.usage.total_tokens,
    },
    output_token_limit: {
      requested_tokens: input.requestedOutputTokenLimit ?? null,
      enforced: false,
    },
  } as const;
  return new TextEncoder().encode(JSON.stringify(payload));
}
