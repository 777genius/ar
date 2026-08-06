import {
  OpenAiBridgeContentPartType,
  OpenAiBridgeErrorCode,
  OpenAiBridgeRequestError,
  OpenAiBridgeResponseFormatType,
  OpenAiBridgeRole,
  type OpenAiBridgeChatCompletionRequest,
} from "../domain/openai-chat-contracts.js";
import { snapshotJsonSchemaResponseFormat } from "../domain/response-format-policy.js";

export function parseChatCompletionRequest(
  input: unknown,
): OpenAiBridgeChatCompletionRequest {
  if (!input || typeof input !== "object") {
    throw invalidRequest("Request body must be a JSON object.");
  }
  const record = input as Record<string, unknown>;
  const messages = parseMessages(record.messages);
  const stream = parseOptionalBoolean(record.stream, "stream");
  if (stream === true) {
    throw new OpenAiBridgeRequestError(
      "Streaming chat completions are not supported by this bridge yet.",
      OpenAiBridgeErrorCode.UnsupportedFeature,
      400,
    );
  }
  const n = parseOptionalNumber(record.n, "n");
  if (n !== undefined && n !== 1) {
    throw new OpenAiBridgeRequestError(
      "Only n=1 is supported.",
      OpenAiBridgeErrorCode.UnsupportedFeature,
      400,
    );
  }
  const tools = parseOptionalArray(record.tools, "tools");
  if (tools !== undefined && tools.length > 0) {
    throw new OpenAiBridgeRequestError(
      "Tool calls are not supported by this bridge.",
      OpenAiBridgeErrorCode.UnsupportedFeature,
      400,
    );
  }
  if (record.tool_choice !== undefined && record.tool_choice !== "none") {
    throw new OpenAiBridgeRequestError(
      "Tool choice is not supported by this bridge.",
      OpenAiBridgeErrorCode.UnsupportedFeature,
      400,
    );
  }
  const temperature = parseOptionalNumber(record.temperature, "temperature");
  const maxTokens = parseOptionalPositiveInteger(record.max_tokens, "max_tokens");
  const maxCompletionTokens = parseOptionalPositiveInteger(
    record.max_completion_tokens,
    "max_completion_tokens",
  );
  if (
    maxTokens !== undefined &&
    maxCompletionTokens !== undefined &&
    maxTokens !== maxCompletionTokens
  ) {
    throw invalidRequest(
      "max_tokens and max_completion_tokens must match when both are provided.",
    );
  }
  const requestedOutputTokenLimit = maxCompletionTokens ?? maxTokens;

  return {
    messages,
    ...(typeof record.model === "string" && record.model.trim()
      ? { model: record.model.trim() }
      : {}),
    ...(stream === undefined ? {} : { stream }),
    ...(n === undefined ? {} : { n }),
    ...(parseResponseFormat(record.response_format)),
    ...(tools === undefined ? {} : { tools }),
    ...(record.tool_choice === undefined
      ? {}
      : { tool_choice: record.tool_choice }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(requestedOutputTokenLimit === undefined
      ? {}
      : { requestedOutputTokenLimit }),
  };
}

function parseMessages(
  value: unknown,
): OpenAiBridgeChatCompletionRequest["messages"] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidRequest("Request messages must be a non-empty array.");
  }
  if (value.length > 200) {
    throw invalidRequest("Request messages array is too large.");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw invalidRequest("Each message must be an object.");
    }
    const record = item as Record<string, unknown>;
    const role = parseRole(record.role);
    const content = parseContent(record.content);
    return {
      role,
      ...(content === undefined ? {} : { content }),
      ...(typeof record.name === "string" ? { name: record.name } : {}),
    };
  });
}

function parseRole(value: unknown): OpenAiBridgeRole {
  if (value === OpenAiBridgeRole.System) return OpenAiBridgeRole.System;
  if (value === OpenAiBridgeRole.User) return OpenAiBridgeRole.User;
  if (value === OpenAiBridgeRole.Assistant) return OpenAiBridgeRole.Assistant;
  if (value === OpenAiBridgeRole.Tool) return OpenAiBridgeRole.Tool;
  throw invalidRequest("Unsupported message role.");
}

function parseContent(
  value: unknown,
): OpenAiBridgeChatCompletionRequest["messages"][number]["content"] | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string") return value;
  if (!Array.isArray(value)) {
    throw invalidRequest("Message content must be a string, null, or text parts.");
  }
  return value.map((part) => {
    if (!part || typeof part !== "object") {
      throw invalidRequest("Message content part must be an object.");
    }
    const record = part as Record<string, unknown>;
    if (
      record.type !== OpenAiBridgeContentPartType.Text ||
      typeof record.text !== "string"
    ) {
      throw new OpenAiBridgeRequestError(
        "Only text content parts are supported.",
        OpenAiBridgeErrorCode.UnsupportedFeature,
        400,
      );
    }
    return { type: OpenAiBridgeContentPartType.Text, text: record.text };
  });
}

function parseResponseFormat(value: unknown): Pick<
  OpenAiBridgeChatCompletionRequest,
  "response_format"
> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object") {
    throw invalidRequest("response_format must be an object.");
  }
  const type = (value as Record<string, unknown>).type;
  if (type === undefined) return { response_format: {} };
  if (type === OpenAiBridgeResponseFormatType.Text) {
    assertExactKeys(value as Record<string, unknown>, ["type"], "response_format");
    return { response_format: { type: OpenAiBridgeResponseFormatType.Text } };
  }
  if (type === OpenAiBridgeResponseFormatType.JsonObject) {
    throw invalidRequest(
      "response_format.type=json_object is unsupported; provide a strict json_schema.",
    );
  }
  if (type === OpenAiBridgeResponseFormatType.JsonSchema) {
    const format = value as Record<string, unknown>;
    assertExactKeys(format, ["type", "json_schema"], "response_format");
    const jsonSchema = format.json_schema;
    if (!jsonSchema || typeof jsonSchema !== "object" || Array.isArray(jsonSchema)) {
      throw invalidRequest("response_format.json_schema must be an object.");
    }
    const envelope = jsonSchema as Record<string, unknown>;
    assertExactKeys(
      envelope,
      ["name", "schema", "strict"],
      "response_format.json_schema",
    );
    if (
      typeof envelope.name !== "string" ||
      envelope.strict !== true ||
      !envelope.schema ||
      typeof envelope.schema !== "object" ||
      Array.isArray(envelope.schema)
    ) {
      throw invalidRequest(
        "response_format.json_schema requires name, schema, and strict:true.",
      );
    }
    try {
      return {
        response_format: snapshotJsonSchemaResponseFormat({
          type: OpenAiBridgeResponseFormatType.JsonSchema,
          json_schema: {
            name: envelope.name,
            schema: envelope.schema as Readonly<Record<string, unknown>>,
            strict: true,
          },
        }),
      };
    } catch (error) {
      throw invalidRequest(
        error instanceof Error ? error.message : "response_format.json_schema is invalid.",
      );
    }
  }
  throw invalidRequest("Unsupported response_format.type.");
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  fieldName: string,
): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw invalidRequest(`${fieldName} contains unsupported fields.`);
  }
}

function parseOptionalBoolean(
  value: unknown,
  fieldName: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw invalidRequest(`${fieldName} must be a boolean.`);
  }
  return value;
}

function parseOptionalNumber(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidRequest(`${fieldName} must be a finite number.`);
  }
  return value;
}

function parseOptionalPositiveInteger(
  value: unknown,
  fieldName: string,
): number | undefined {
  const parsed = parseOptionalNumber(value, fieldName);
  if (parsed === undefined) return undefined;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw invalidRequest(`${fieldName} must be a positive safe integer.`);
  }
  return parsed;
}

function parseOptionalArray(
  value: unknown,
  fieldName: string,
): readonly unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw invalidRequest(`${fieldName} must be an array.`);
  }
  return value;
}

function invalidRequest(message: string): OpenAiBridgeRequestError {
  return new OpenAiBridgeRequestError(
    message,
    OpenAiBridgeErrorCode.InvalidRequest,
    400,
  );
}
