export enum OpenAiBridgeObjectKind {
  ChatCompletion = "chat.completion",
  Model = "model",
  ModelList = "list",
}

export enum OpenAiBridgeRole {
  System = "system",
  User = "user",
  Assistant = "assistant",
  Tool = "tool",
}

export enum OpenAiBridgeFinishReason {
  Stop = "stop",
  Length = "length",
}

export enum OpenAiBridgeErrorCode {
  InvalidRequest = "invalid_request_error",
  Unauthorized = "unauthorized",
  ProviderUnavailable = "provider_unavailable",
  UnsupportedFeature = "unsupported_feature",
}

export enum OpenAiBridgeResponseFormatType {
  JsonObject = "json_object",
  JsonSchema = "json_schema",
  Text = "text",
}

export enum OpenAiBridgeContentPartType {
  Text = "text",
}

export type OpenAiBridgeTextContentPart = {
  readonly type: OpenAiBridgeContentPartType.Text;
  readonly text: string;
};

export type OpenAiBridgeMessage = {
  readonly role: OpenAiBridgeRole;
  readonly content?: string | readonly OpenAiBridgeTextContentPart[] | null;
  readonly name?: string;
};

export type OpenAiBridgeJsonSchemaResponseFormat = {
  readonly type: OpenAiBridgeResponseFormatType.JsonSchema;
  readonly json_schema: {
    readonly name: string;
    readonly schema: Readonly<Record<string, unknown>>;
    readonly strict: true;
  };
};

export type OpenAiBridgeChatCompletionRequest = {
  readonly model?: string;
  readonly messages: readonly OpenAiBridgeMessage[];
  readonly stream?: boolean;
  readonly n?: number;
  readonly response_format?:
    | { readonly type?: OpenAiBridgeResponseFormatType.Text }
    | OpenAiBridgeJsonSchemaResponseFormat;
  readonly tools?: readonly unknown[];
  readonly tool_choice?: unknown;
  readonly temperature?: number;
  readonly requestedOutputTokenLimit?: number;
};

export type OpenAiBridgeUsage = {
  readonly prompt_tokens: number;
  readonly prompt_tokens_details?: {
    readonly cached_tokens: number;
    readonly cache_write_tokens?: number;
  };
  readonly completion_tokens: number;
  readonly completion_tokens_details?: {
    readonly reasoning_tokens: number;
  };
  readonly total_tokens: number;
};

export type OpenAiBridgeRuntimeSelection = {
  readonly account_binding_hmac_sha256: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly model: string;
  readonly model_provider: string;
  readonly reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly service_tier: string;
  readonly execution_profile: "stateless-completion";
  readonly base_instructions_sha256: string;
};

export type OpenAiBridgeRequestIdentity = {
  readonly public_model: string;
  readonly client_requested_model: string;
  readonly configured_codex_model: string;
  readonly requested_codex_model: string;
  readonly request_body_sha256: string;
  readonly response_format_type: OpenAiBridgeResponseFormatType.Text
    | OpenAiBridgeResponseFormatType.JsonSchema;
  readonly response_format_sha256: string;
  readonly response_schema_sha256: string | null;
};

export type OpenAiBridgeOutputIdentity = {
  readonly output_text_sha256: string;
  readonly terminal_status: "completed";
};

export type OpenAiBridgeRuntimeMetadata = {
  readonly schema_version: 2;
  readonly attestation_level: "provider_receipt";
  readonly usage_source: "codex_thread_token_usage_updated";
  readonly runtime_selection: OpenAiBridgeRuntimeSelection;
  readonly request_identity: OpenAiBridgeRequestIdentity;
  readonly output_identity: OpenAiBridgeOutputIdentity;
  readonly output_token_limit: {
    readonly requested_tokens?: number;
    readonly enforced: false;
  };
  readonly receipt_hmac_sha256: string;
};

export type OpenAiBridgeChatCompletionResponse = {
  readonly id: string;
  readonly object: OpenAiBridgeObjectKind.ChatCompletion;
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly index: number;
    readonly message: {
      readonly role: OpenAiBridgeRole.Assistant;
      readonly content: string;
    };
    readonly finish_reason: OpenAiBridgeFinishReason;
  }[];
  readonly usage: OpenAiBridgeUsage;
  readonly system_fingerprint: string;
  readonly subscription_runtime: OpenAiBridgeRuntimeMetadata;
};

export type OpenAiBridgeModelListResponse = {
  readonly object: OpenAiBridgeObjectKind.ModelList;
  readonly data: readonly {
    readonly id: string;
    readonly object: OpenAiBridgeObjectKind.Model;
    readonly created: number;
    readonly owned_by: string;
  }[];
};

export type OpenAiBridgeErrorResponse = {
  readonly error: {
    readonly message: string;
    readonly type: OpenAiBridgeErrorCode;
    readonly code: OpenAiBridgeErrorCode;
  };
};

export class OpenAiBridgeRequestError extends Error {
  constructor(
    message: string,
    readonly code: OpenAiBridgeErrorCode,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}
