import type {
  OpenAiBridgeOutputIdentity,
  OpenAiBridgeRequestIdentity,
  OpenAiBridgeRuntimeSelection,
  OpenAiBridgeUsage,
} from "./openai-chat-contracts.js";

export type OpenAiBridgeRuntimeAttestationInput = {
  readonly outputIdentity: OpenAiBridgeOutputIdentity;
  readonly requestIdentity: OpenAiBridgeRequestIdentity;
  readonly selection: OpenAiBridgeRuntimeSelection;
  readonly usage: OpenAiBridgeUsage;
  readonly requestedOutputTokenLimit?: number;
};

/**
 * Public v2 receipt contract. UTF-8 JSON bytes use this fixed top-level order:
 * schema_version, attestation_level, usage_source, runtime_selection,
 * request_identity, output_identity, usage, output_token_limit. Nested fields
 * follow the source order below. Missing requested output tokens serialize as
 * JSON null. No prompt, completion text, account subject, or secret is included.
 */
export function openAiBridgeRuntimeAttestationCanonicalBytes(
  input: OpenAiBridgeRuntimeAttestationInput,
): Uint8Array {
  const payload = {
    schema_version: 2,
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
      execution_profile: input.selection.execution_profile,
      base_instructions_sha256:
        input.selection.base_instructions_sha256,
    },
    request_identity: {
      public_model: input.requestIdentity.public_model,
      client_requested_model: input.requestIdentity.client_requested_model,
      configured_codex_model: input.requestIdentity.configured_codex_model,
      requested_codex_model: input.requestIdentity.requested_codex_model,
      request_body_sha256: input.requestIdentity.request_body_sha256,
      response_format_type: input.requestIdentity.response_format_type,
      response_format_sha256: input.requestIdentity.response_format_sha256,
      response_schema_sha256: input.requestIdentity.response_schema_sha256,
    },
    output_identity: {
      output_text_sha256: input.outputIdentity.output_text_sha256,
      terminal_status: input.outputIdentity.terminal_status,
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
