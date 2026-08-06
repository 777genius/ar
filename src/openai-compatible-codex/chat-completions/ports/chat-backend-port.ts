import type {
  OpenAiBridgeRuntimeSelection,
  OpenAiBridgeUsage,
} from "../domain/openai-chat-contracts.js";

export type OpenAiBridgeChatBackendInput = {
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly model: string;
  readonly requestId: string;
  readonly requestedOutputTokenLimit?: number;
  readonly abortSignal: AbortSignal;
};

export type OpenAiBridgeChatBackendResult = {
  readonly text: string;
  readonly model: string;
  readonly usage: OpenAiBridgeUsage;
  readonly runtimeSelection: OpenAiBridgeRuntimeSelection;
  readonly attestationHmacSha256: string;
};

export interface OpenAiBridgeChatBackend {
  complete(
    input: OpenAiBridgeChatBackendInput,
  ): Promise<OpenAiBridgeChatBackendResult>;
}
