import { createHash, randomUUID } from "node:crypto";
import { renderOpenAiBridgeChat } from "../domain/chat-prompt-renderer.js";
import {
  OpenAiBridgeFinishReason,
  OpenAiBridgeObjectKind,
  OpenAiBridgeRole,
  type OpenAiBridgeChatCompletionResponse,
} from "../domain/openai-chat-contracts.js";
import type { OpenAiBridgeChatBackend } from "../ports/chat-backend-port.js";
import { parseChatCompletionRequest } from "./parse-chat-completion-request.js";

export type OpenAiBridgeChatCompletionUseCaseOptions = {
  readonly backend: OpenAiBridgeChatBackend;
  readonly publicModel: string;
  readonly codexModel: string;
  readonly clock?: () => Date;
};

export class OpenAiBridgeChatCompletionUseCase {
  private readonly now: () => Date;
  private readonly systemFingerprint: string;

  constructor(private readonly options: OpenAiBridgeChatCompletionUseCaseOptions) {
    this.now = options.clock ?? (() => new Date());
    this.systemFingerprint = `subscription-runtime-codex-bridge-v3:${createHash("sha256")
      .update(JSON.stringify(["codex-app-server", options.publicModel, options.codexModel]))
      .digest("hex")}`;
  }

  async complete(input: {
    readonly request: unknown;
    readonly abortSignal: AbortSignal;
  }): Promise<OpenAiBridgeChatCompletionResponse> {
    const request = parseChatCompletionRequest(input.request);
    const rendered = renderOpenAiBridgeChat(request);
    const backendResult = await this.options.backend.complete({
      prompt: rendered.prompt,
      ...(rendered.systemPrompt ? { systemPrompt: rendered.systemPrompt } : {}),
      model: this.options.codexModel,
      requestId: randomUUID(),
      ...(request.requestedOutputTokenLimit === undefined
        ? {}
        : { requestedOutputTokenLimit: request.requestedOutputTokenLimit }),
      abortSignal: input.abortSignal,
    });
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
      system_fingerprint: this.systemFingerprint,
      subscription_runtime: {
        schema_version: 1,
        attestation_level: "provider_receipt",
        usage_source: "codex_thread_token_usage_updated",
        runtime_selection: backendResult.runtimeSelection,
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
