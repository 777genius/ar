import { createHash } from "node:crypto";
import {
  OpenAiBridgeResponseFormatType,
  type OpenAiBridgeJsonSchemaResponseFormat,
} from "./openai-chat-contracts.js";

const responseFormatNamePattern = /^[A-Za-z0-9_-]{1,64}$/;
const allowedSchemaTypes = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const allowedSchemaKeys = new Set([
  "additionalProperties",
  "description",
  "enum",
  "items",
  "properties",
  "required",
  "type",
]);
const maxSchemaDepth = 8;
const maxSchemaProperties = 100;
const maxCanonicalSchemaBytes = 64 * 1024;

export type OpenAiBridgeResponseFormatIdentity = {
  readonly response_format_type: OpenAiBridgeResponseFormatType.Text
    | OpenAiBridgeResponseFormatType.JsonSchema;
  readonly response_format_sha256: string;
  readonly response_schema_sha256: string | null;
};

/**
 * Parse the complete provider text as one JSON value and validate it recursively
 * against the already-supported strict schema subset. This never extracts JSON
 * from prose, markdown fences, prefixes, or trailing non-whitespace content.
 */
export function assertExactJsonSchemaOutput(
  outputText: string,
  responseFormat: OpenAiBridgeJsonSchemaResponseFormat,
): void {
  const snapshot = snapshotJsonSchemaResponseFormat(responseFormat);
  let value: unknown;
  try {
    value = JSON.parse(outputText);
  } catch {
    throw new Error("openai_bridge_structured_output_invalid_json");
  }
  if (!matchesSchema(value, snapshot.json_schema.schema)) {
    throw new Error("openai_bridge_structured_output_schema_mismatch");
  }
}

export function assertSupportedJsonSchemaResponseFormat(
  value: OpenAiBridgeJsonSchemaResponseFormat,
): void {
  if (!responseFormatNamePattern.test(value.json_schema.name)) {
    throw new Error("response_format.json_schema.name is invalid.");
  }
  assertSchemaNode(value.json_schema.schema, 0, true);
  if (canonicalBytes(value.json_schema.schema).byteLength > maxCanonicalSchemaBytes) {
    throw new Error("response_format.json_schema.schema is too large.");
  }
}

export function snapshotJsonSchemaResponseFormat(
  value: OpenAiBridgeJsonSchemaResponseFormat,
): OpenAiBridgeJsonSchemaResponseFormat {
  const snapshot: OpenAiBridgeJsonSchemaResponseFormat = deepFreeze({
    type: OpenAiBridgeResponseFormatType.JsonSchema as const,
    json_schema: {
      name: value.json_schema.name,
      schema: cloneJsonValue(value.json_schema.schema) as Readonly<
        Record<string, unknown>
      >,
      strict: true as const,
    },
  });
  assertSupportedJsonSchemaResponseFormat(snapshot);
  return snapshot;
}

/**
 * Canonical semantic identity: object keys are recursively sorted, array order
 * is retained, and UTF-8 JSON is SHA-256 hashed. The format hash binds
 * type/name/strict/schema; the schema hash binds the schema alone. Text mode
 * uses a null schema hash. Raw request bytes remain a separate identity field.
 */
export function responseFormatIdentity(
  value: OpenAiBridgeJsonSchemaResponseFormat | undefined,
): OpenAiBridgeResponseFormatIdentity {
  if (value === undefined) {
    return {
      response_format_type: OpenAiBridgeResponseFormatType.Text,
      response_format_sha256: sha256({ type: OpenAiBridgeResponseFormatType.Text }),
      response_schema_sha256: null,
    };
  }
  assertSupportedJsonSchemaResponseFormat(value);
  return {
    response_format_type: OpenAiBridgeResponseFormatType.JsonSchema,
    response_format_sha256: sha256(value),
    response_schema_sha256: sha256(value.json_schema.schema),
  };
}

function assertSchemaNode(
  value: unknown,
  depth: number,
  root: boolean,
): asserts value is Readonly<Record<string, unknown>> {
  if (!isExactRecord(value) || depth > maxSchemaDepth) {
    throw new Error("response_format.json_schema.schema is malformed.");
  }
  if (Object.keys(value).some((key) => !allowedSchemaKeys.has(key))) {
    throw new Error("response_format.json_schema.schema uses unsupported keywords.");
  }
  const type = value.type;
  if (typeof type !== "string" || !allowedSchemaTypes.has(type)) {
    throw new Error("response_format.json_schema.schema type is unsupported.");
  }
  if (root && type !== "object") {
    throw new Error("response_format.json_schema.schema root must be an object.");
  }
  if (Object.hasOwn(value, "description") && typeof value.description !== "string") {
    throw new Error("response_format.json_schema.schema description is invalid.");
  }
  if (type === "object") {
    assertObjectSchema(value, depth);
    return;
  }
  if (type === "array") {
    if (value.items === undefined) {
      throw new Error("response_format.json_schema.schema array items are required.");
    }
    rejectPresent(value, ["properties", "required", "additionalProperties", "enum"]);
    assertSchemaNode(value.items, depth + 1, false);
    return;
  }
  rejectPresent(value, ["properties", "required", "additionalProperties", "items"]);
  if (Object.hasOwn(value, "enum")) assertPrimitiveEnum(value.enum, type);
}

function assertObjectSchema(
  value: Readonly<Record<string, unknown>>,
  depth: number,
): void {
  if (
    !isExactRecord(value.properties) ||
    value.additionalProperties !== false ||
    !Array.isArray(value.required)
  ) {
    throw new Error(
      "response_format.json_schema.schema objects require properties, required, and additionalProperties:false.",
    );
  }
  rejectPresent(value, ["items", "enum"]);
  const propertyNames = Object.keys(value.properties);
  const required = value.required as readonly unknown[];
  if (propertyNames.length > maxSchemaProperties) {
    throw new Error("response_format.json_schema.schema has too many properties.");
  }
  if (
    required.some((item) => typeof item !== "string") ||
    new Set(required).size !== required.length ||
    required.length !== propertyNames.length ||
    propertyNames.some((name) => !required.includes(name))
  ) {
    throw new Error(
      "response_format.json_schema.schema required must list every property exactly once.",
    );
  }
  for (const property of Object.values(value.properties)) {
    assertSchemaNode(property, depth + 1, false);
  }
}

function assertPrimitiveEnum(value: unknown, type: string): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error("response_format.json_schema.schema enum is invalid.");
  }
  const valid = value.every((item) => {
    if (type === "string") return typeof item === "string";
    if (type === "boolean") return typeof item === "boolean";
    if (type === "null") return item === null;
    if (type === "integer") return Number.isSafeInteger(item);
    if (type === "number") return typeof item === "number" && Number.isFinite(item);
    return false;
  });
  if (!valid) throw new Error("response_format.json_schema.schema enum is invalid.");
}

function rejectPresent(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): void {
  if (keys.some((key) => Object.hasOwn(value, key))) {
    throw new Error("response_format.json_schema.schema keyword combination is unsupported.");
  }
}

function isExactRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalValue(value)));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isExactRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (!isExactRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

function matchesSchema(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
): boolean {
  switch (schema.type) {
    case "object": {
      if (!isExactRecord(value) || !isExactRecord(schema.properties)) return false;
      const properties = schema.properties as Readonly<Record<string, unknown>>;
      const expectedKeys = Object.keys(properties);
      const actualKeys = Object.keys(value);
      if (
        actualKeys.length !== expectedKeys.length ||
        expectedKeys.some((key) => !Object.hasOwn(value, key))
      ) {
        return false;
      }
      return expectedKeys.every((key) => {
        const propertySchema = properties[key];
        return isExactRecord(propertySchema) &&
          matchesSchema(
            (value as Readonly<Record<string, unknown>>)[key],
            propertySchema,
          );
      });
    }
    case "array":
      return Array.isArray(value) && isExactRecord(schema.items) &&
        value.every((item) => matchesSchema(item, schema.items as Readonly<Record<string, unknown>>));
    case "string":
      return typeof value === "string" && matchesEnum(value, schema.enum);
    case "boolean":
      return typeof value === "boolean" && matchesEnum(value, schema.enum);
    case "null":
      return value === null && matchesEnum(value, schema.enum);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value) &&
        matchesEnum(value, schema.enum);
    case "number":
      return typeof value === "number" && Number.isFinite(value) &&
        matchesEnum(value, schema.enum);
    default:
      return false;
  }
}

function matchesEnum(value: unknown, candidate: unknown): boolean {
  return candidate === undefined ||
    (Array.isArray(candidate) && candidate.some((item) => Object.is(item, value)));
}
