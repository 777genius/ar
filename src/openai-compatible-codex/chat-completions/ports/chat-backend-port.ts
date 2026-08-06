import type {
  OpenAiBridgeOutputIdentity,
  OpenAiBridgeRequestIdentity,
  OpenAiBridgeJsonSchemaResponseFormat,
  OpenAiBridgeRuntimeSelection,
  OpenAiBridgeUsage,
} from "../domain/openai-chat-contracts.js";

export type OpenAiBridgeChatBackendInput = {
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly model: string;
  readonly requestId: string;
  readonly requestedOutputTokenLimit?: number;
  readonly responseFormat?: OpenAiBridgeJsonSchemaResponseFormat;
  readonly requestIdentity: OpenAiBridgeRequestIdentity;
  readonly abortSignal: AbortSignal;
};

export type OpenAiBridgeChatBackendResult = {
  readonly text: string;
  readonly model: string;
  readonly usage: OpenAiBridgeUsage;
  readonly runtimeSelection: OpenAiBridgeRuntimeSelection;
  readonly outputIdentity: OpenAiBridgeOutputIdentity;
  readonly attestationHmacSha256: string;
};

export interface OpenAiBridgeChatBackend {
  complete(
    input: OpenAiBridgeChatBackendInput,
  ): Promise<OpenAiBridgeChatBackendResult>;
}
