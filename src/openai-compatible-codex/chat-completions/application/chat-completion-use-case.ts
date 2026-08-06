import { createHash, randomUUID } from "node:crypto";
import { renderOpenAiBridgeChat } from "../domain/chat-prompt-renderer.js";
import {
  OpenAiBridgeFinishReason,
  OpenAiBridgeObjectKind,
  OpenAiBridgeResponseFormatType,
  OpenAiBridgeRole,
  type OpenAiBridgeChatCompletionResponse,
  type OpenAiBridgeRequestIdentity,
} from "../domain/openai-chat-contracts.js";
import type { OpenAiBridgeChatBackend } from "../ports/chat-backend-port.js";
import {
  assertExactJsonSchemaOutput,
  responseFormatIdentity,
} from "../domain/response-format-policy.js";
import { parseChatCompletionRequest } from "./parse-chat-completion-request.js";

export type OpenAiBridgeChatCompletionUseCaseOptions = {
  readonly backend: OpenAiBridgeChatBackend;
  readonly publicModel: string;
  readonly codexModel: string;
  readonly clock?: () => Date;
};

export class OpenAiBridgeChatCompletionUseCase {
  private readonly now: () => Date;

  constructor(private readonly options: OpenAiBridgeChatCompletionUseCaseOptions) {
    this.now = options.clock ?? (() => new Date());
  }

  async complete(input: {
    readonly request: unknown;
    readonly requestBodySha256: string;
    readonly abortSignal: AbortSignal;
  }): Promise<OpenAiBridgeChatCompletionResponse> {
    assertSha256(input.requestBodySha256);
    const request = parseChatCompletionRequest(input.request);
    const rendered = renderOpenAiBridgeChat(request);
    const typedResponseFormat =
      request.response_format?.type === OpenAiBridgeResponseFormatType.JsonSchema
        ? request.response_format
        : undefined;
    const requestIdentity: OpenAiBridgeRequestIdentity = {
      public_model: this.options.publicModel,
      client_requested_model: request.model ?? this.options.publicModel,
      configured_codex_model: this.options.codexModel,
      requested_codex_model: this.options.codexModel,
      request_body_sha256: input.requestBodySha256,
      ...responseFormatIdentity(typedResponseFormat),
    };
    const backendResult = await this.options.backend.complete({
      prompt: rendered.prompt,
      ...(rendered.systemPrompt ? { systemPrompt: rendered.systemPrompt } : {}),
      model: this.options.codexModel,
      requestId: randomUUID(),
      requestIdentity,
      ...(request.requestedOutputTokenLimit === undefined
        ? {}
        : { requestedOutputTokenLimit: request.requestedOutputTokenLimit }),
      ...(typedResponseFormat === undefined
        ? {}
        : { responseFormat: typedResponseFormat }),
      abortSignal: input.abortSignal,
    });
    if (typedResponseFormat !== undefined) {
      assertExactJsonSchemaOutput(backendResult.text, typedResponseFormat);
    }
    const outputTextSha256 = createHash("sha256")
      .update(backendResult.text, "utf8")
      .digest("hex");
    if (backendResult.outputIdentity.terminal_status !== "completed") {
      throw new Error("openai_bridge_output_terminal_status_invalid");
    }
    if (backendResult.outputIdentity.output_text_sha256 !== outputTextSha256) {
      throw new Error("openai_bridge_output_identity_mismatch");
    }
    return {
      id: `chatcmpl-${randomUUID()}`,
      object: OpenAiBridgeObjectKind.ChatCompletion,
      created: Math.floor(this.now().getTime() / 1000),
      model: backendResult.model,
      choices: [
        {
          index: 0,
          message: {
            role: OpenAiBridgeRole.Assistant,
            content: backendResult.text,
          },
          finish_reason: OpenAiBridgeFinishReason.Stop,
        },
      ],
      usage: backendResult.usage,
      system_fingerprint: `subscription-runtime-codex-bridge-v4:${createHash(
        "sha256",
      )
        .update(JSON.stringify([
          "codex-app-server",
          this.options.publicModel,
          this.options.codexModel,
          backendResult.runtimeSelection.execution_profile,
          backendResult.runtimeSelection.base_instructions_sha256,
        ]))
        .digest("hex")}`,
      subscription_runtime: {
        schema_version: 2,
        attestation_level: "provider_receipt",
        usage_source: "codex_thread_token_usage_updated",
        runtime_selection: backendResult.runtimeSelection,
        request_identity: requestIdentity,
        output_identity: backendResult.outputIdentity,
        output_token_limit: {
          ...(request.requestedOutputTokenLimit === undefined
            ? {}
            : { requested_tokens: request.requestedOutputTokenLimit }),
          enforced: false,
        },
        receipt_hmac_sha256: backendResult.attestationHmacSha256,
      },
    };
  }
}

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("openai_bridge_request_body_sha256_invalid");
  }
}
