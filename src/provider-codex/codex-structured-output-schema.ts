import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

type JsonSchema = Readonly<Record<string, unknown>>;

export type CodexStructuredOutputSchemaPlan = {
  readonly providerSchema: JsonSchema;
  readonly codexSchema: JsonSchema;
  normalize(value: unknown): unknown;
};

const supportedKeywords = new Set([
  "$schema",
  "$ref",
  "$defs",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "anyOf",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

const supportedTypes = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

export function prepareCodexStructuredOutputSchema(
  schema: unknown,
): CodexStructuredOutputSchemaPlan {
  const providerSchema = cloneSchema(schema, "$");
  assertSupportedSchema(providerSchema, providerSchema, "$", new Set());
  assertRootObject(providerSchema, providerSchema);

  const validators = createValidators(providerSchema);
  const validateProviderOutput = validators.forSchema(providerSchema);
  const codexSchema = deepFreeze(
    strictSchema(providerSchema, providerSchema, "$", validators),
  );
  deepFreeze(providerSchema);

  return Object.freeze({
    providerSchema,
    codexSchema,
    normalize(value: unknown): unknown {
      const normalized = normalizeNode(
        providerSchema,
        value,
        providerSchema,
        "$",
        validators,
        0,
      );
      if (!validateProviderOutput(normalized)) {
        invalidOutput(validationDetail(validateProviderOutput));
      }
      return normalized;
    },
  });
}

export function normalizeCodexStructuredOutput(
  plan: CodexStructuredOutputSchemaPlan,
  value: unknown,
): unknown {
  return plan.normalize(value);
}

function strictSchema(
  schema: JsonSchema,
  root: JsonSchema,
  path: string,
  validators: SchemaValidators,
): JsonSchema {
  const entries: [string, unknown][] = [];
  if (typeof schema.title === "string") entries.push(["title", schema.title]);
  if (typeof schema.description === "string") {
    entries.push(["description", schema.description]);
  }
  if (typeof schema.$ref === "string") entries.push(["$ref", schema.$ref]);

  const definitions = schema.$defs;
  if (isRecord(definitions)) {
    entries.push(["$defs", Object.fromEntries(
      Object.keys(definitions).sort().map((key) => [
        key,
        strictSchema(
          readSchema(definitions[key], `${path}.$defs.${key}`),
          root,
          `${path}.$defs.${key}`,
          validators,
        ),
      ]),
    )]);
  }
  if (schema.type !== undefined) {
    entries.push(["type", canonicalType(schema.type)]);
  }
  if (schema.const !== undefined) entries.push(["const", cloneJson(schema.const)]);
  if (Array.isArray(schema.enum)) {
    entries.push(["enum", schema.enum.map(cloneJson)]);
  }

  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) {
    entries.push(["anyOf", alternatives.map((branch, index) =>
      strictSchema(
        readSchema(branch, `${path}.alternatives[${index}]`),
        root,
        `${path}.alternatives[${index}]`,
        validators,
      ))]);
  }

  const properties = optionalSchemaMap(schema.properties, `${path}.properties`);
  if (properties) {
    const required = new Set(readRequired(schema.required, path));
    const propertyNames = Object.keys(properties).sort();
    entries.push(["properties", Object.fromEntries(propertyNames.map((key) => {
      const propertyPath = `${path}.properties.${key}`;
      const original = readSchema(properties[key], propertyPath);
      const transformed = strictSchema(original, root, propertyPath, validators);
      return [
        key,
        required.has(key) || validators.accepts(original, null)
          ? transformed
          : { anyOf: [transformed, { type: "null" }] },
      ];
    }))]);
    entries.push(["required", propertyNames]);
    entries.push(["additionalProperties", false]);
  }

  if (schema.items !== undefined) {
    entries.push(["items", strictSchema(
      readSchema(schema.items, `${path}.items`),
      root,
      `${path}.items`,
      validators,
    )]);
  }
  for (const keyword of [
    "minItems",
    "maxItems",
    "uniqueItems",
    "minLength",
    "maxLength",
    "pattern",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
  ]) {
    if (Object.hasOwn(schema, keyword)) entries.push([keyword, schema[keyword]]);
  }
  return Object.fromEntries(entries);
}

function normalizeNode(
  schema: JsonSchema,
  value: unknown,
  root: JsonSchema,
  path: string,
  validators: SchemaValidators,
  depth: number,
): unknown {
  if (depth > 256) invalidOutput(`${path}:schema_depth_exceeded`);
  if (typeof schema.$ref === "string") {
    return normalizeNode(
      resolveLocalRef(root, schema.$ref),
      value,
      root,
      path,
      validators,
      depth + 1,
    );
  }

  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) {
    const candidates: unknown[] = [];
    for (const branchValue of alternatives) {
      const branch = readSchema(branchValue, `${path}.alternative`);
      try {
        const candidate = normalizeNode(
          branch,
          value,
          root,
          path,
          validators,
          depth + 1,
        );
        if (validators.accepts(branch, candidate)) candidates.push(candidate);
      } catch (error) {
        if (isFatalNormalization(error)) throw error;
        // A different alternative can still be the unique valid branch.
      }
    }
    if (candidates.length === 0) invalidOutput(`${path}:no_valid_alternative`);
    const unique = new Map(candidates.map((candidate) => [
      canonicalJson(candidate),
      candidate,
    ]));
    if (unique.size > 1) invalidOutput(`${path}:ambiguous_alternatives`);
    return unique.values().next().value;
  }

  const types = readTypes(schema.type, path);
  if (types.includes("object") && value !== null) {
    if (!isRecord(value)) return value;
    const properties = optionalSchemaMap(schema.properties, `${path}.properties`) ?? {};
    const required = new Set(readRequired(schema.required, path));
    const entries: [string, unknown][] = [];
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        entries.push([key, value[key]]);
        continue;
      }
      const propertySchema = readSchema(
        properties[key],
        `${path}.properties.${key}`,
      );
      const propertyValue = value[key];
      if (propertyValue === null && !required.has(key) &&
        !validators.accepts(propertySchema, null)) {
        continue;
      }
      entries.push([key, normalizeNode(
        propertySchema,
        propertyValue,
        root,
        `${path}.${key}`,
        validators,
        depth + 1,
      )]);
    }
    return Object.fromEntries(entries);
  }

  if (types.includes("array") && Array.isArray(value)) {
    const items = readSchema(schema.items, `${path}.items`);
    return value.map((item, index) => normalizeNode(
      items,
      item,
      root,
      `${path}[${index}]`,
      validators,
      depth + 1,
    ));
  }
  return value;
}

type SchemaValidators = {
  forSchema(schema: JsonSchema): ValidateFunction;
  accepts(schema: JsonSchema, value: unknown): boolean;
};

function createValidators(root: JsonSchema): SchemaValidators {
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    ownProperties: true,
    strict: true,
    validateFormats: false,
  });
  const cache = new WeakMap<JsonSchema, ValidateFunction>();
  const forSchema = (schema: JsonSchema): ValidateFunction => {
    const cached = cache.get(schema);
    if (cached) return cached;
    const compilationSchema = schema === root
      ? schema
      : schemaWithRootDefinitions(schema, root);
    let validator: ValidateFunction;
    try {
      validator = ajv.compile(compilationSchema);
    } catch (error) {
      invalidSchema(`$:ajv_compile:${safeError(error)}`);
    }
    cache.set(schema, validator);
    return validator;
  };
  return {
    forSchema,
    accepts(schema, value) {
      return forSchema(schema)(value) === true;
    },
  };
}

function schemaWithRootDefinitions(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const entries: [string, unknown][] = [];
  if (typeof root.$schema === "string") entries.push(["$schema", root.$schema]);
  if (isRecord(root.$defs)) entries.push(["$defs", root.$defs]);
  for (const key of Object.keys(schema)) {
    if (key !== "$schema" && key !== "$defs") entries.push([key, schema[key]]);
  }
  return Object.fromEntries(entries);
}

function assertSupportedSchema(
  schema: JsonSchema,
  root: JsonSchema,
  path: string,
  visitedRefs: Set<string>,
): void {
  for (const keyword of Object.keys(schema)) {
    if (!supportedKeywords.has(keyword)) {
      invalidSchema(`${path}.${keyword}:unsupported_keyword`);
    }
  }
  if (schema.$schema !== undefined && schema.$schema !==
    "https://json-schema.org/draft/2020-12/schema") {
    invalidSchema(`${path}.$schema:unsupported_dialect`);
  }

  const children: [JsonSchema, string][] = [];
  const types = readTypes(schema.type, path);
  const definitions = optionalSchemaMap(schema.$defs, `${path}.$defs`);
  if (definitions) {
    for (const key of Object.keys(definitions)) {
      children.push([
        readSchema(definitions[key], `${path}.$defs.${key}`),
        `${path}.$defs.${key}`,
      ]);
    }
  }
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string") {
      invalidSchema(`${path}.$ref:expected_string`);
    }
    const siblings = Object.keys(schema).filter((key) =>
      key !== "$ref" && key !== "$defs" && key !== "$schema" &&
      key !== "title" && key !== "description"
    );
    if (siblings.length > 0) invalidSchema(`${path}.$ref:unsupported_siblings`);
    const referenced = resolveLocalRef(root, schema.$ref);
    if (!visitedRefs.has(schema.$ref)) {
      children.push([referenced, schema.$ref]);
      visitedRefs = new Set(visitedRefs).add(schema.$ref);
    }
  } else if (schema.anyOf !== undefined || schema.oneOf !== undefined) {
    if (schema.anyOf !== undefined && schema.oneOf !== undefined) {
      invalidSchema(`${path}:multiple_composites`);
    }
    const keyword = schema.anyOf === undefined ? "oneOf" : "anyOf";
    const alternatives = schema[keyword];
    if (!Array.isArray(alternatives) || alternatives.length === 0) {
      invalidSchema(`${path}.${keyword}:expected_non_empty_array`);
    }
    const siblings = Object.keys(schema).filter((key) =>
      key !== keyword && key !== "title" && key !== "description"
    );
    if (siblings.length > 0) invalidSchema(`${path}.${keyword}:unsupported_siblings`);
    alternatives.forEach((branch, index) => children.push([
      readSchema(branch, `${path}.${keyword}[${index}]`),
      `${path}.${keyword}[${index}]`,
    ]));
  } else if (types.includes("object")) {
    const properties = optionalSchemaMap(schema.properties, `${path}.properties`);
    if (!properties) invalidSchema(`${path}.properties:required`);
    if (schema.additionalProperties !== false) {
      invalidSchema(`${path}.additionalProperties:must_be_false`);
    }
    for (const key of Object.keys(properties)) {
      children.push([
        readSchema(properties[key], `${path}.properties.${key}`),
        `${path}.properties.${key}`,
      ]);
    }
  } else if (types.includes("array")) {
    if (schema.items === undefined || Array.isArray(schema.items)) {
      invalidSchema(`${path}.items:single_schema_required`);
    }
    children.push([readSchema(schema.items, `${path}.items`), `${path}.items`]);
  }

  for (const [child, childPath] of children) {
    assertSupportedSchema(child, root, childPath, visitedRefs);
  }
}

function assertRootObject(schema: JsonSchema, root: JsonSchema): void {
  let resolved = schema;
  const visited = new Set<string>();
  while (typeof resolved.$ref === "string") {
    if (visited.has(resolved.$ref)) invalidSchema("$:cyclic_root_ref");
    visited.add(resolved.$ref);
    resolved = resolveLocalRef(root, resolved.$ref);
  }
  if (resolved.type !== "object" || resolved.anyOf !== undefined ||
    resolved.oneOf !== undefined) {
    invalidSchema("$:root_must_be_exact_object");
  }
}

function resolveLocalRef(root: JsonSchema, reference: string): JsonSchema {
  if (!reference.startsWith("#/$defs/")) {
    invalidSchema(`$ref:unsupported_reference:${reference}`);
  }
  let current: unknown = root;
  for (const encoded of reference.slice(2).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(current) || !Object.hasOwn(current, key)) {
      invalidSchema(`$ref:unresolved_reference:${reference}`);
    }
    current = current[key];
  }
  return readSchema(current, reference);
}

function readTypes(value: unknown, path: string): readonly string[] {
  if (value === undefined) return [];
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || values.length === 0 ||
    values.some((entry) => typeof entry !== "string" ||
      !supportedTypes.has(entry)) || new Set(values).size !== values.length) {
    invalidSchema(`${path}.type:unsupported_type`);
  }
  if (values.length > 1 &&
    (values.length !== 2 || !values.includes("null"))) {
    invalidSchema(`${path}.type:only_nullable_unions_supported`);
  }
  return values as readonly string[];
}

function canonicalType(value: unknown): string | readonly string[] {
  const values = readTypes(value, "$canonical");
  return values.length === 1 ? values[0]! : [...values].sort();
}

function readRequired(value: unknown, path: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string") ||
    new Set(value).size !== value.length) {
    invalidSchema(`${path}.required:expected_unique_string_array`);
  }
  return value as readonly string[];
}

function optionalSchemaMap(
  value: unknown,
  path: string,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) invalidSchema(`${path}:expected_object`);
  return value;
}

function readSchema(value: unknown, path: string): JsonSchema {
  if (!isRecord(value)) invalidSchema(`${path}:expected_schema_object`);
  return value;
}

function cloneSchema(value: unknown, path: string): JsonSchema {
  const cloned = cloneJsonValue(value, path);
  return readSchema(cloned, path);
}

function cloneJson(value: unknown): unknown {
  return cloneJsonValue(value, "$clone");
}

function cloneJsonValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" ||
    typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidSchema(`${path}:non_json_number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => cloneJsonValue(entry, `${path}[${index}]`));
  }
  if (!isRecord(value)) invalidSchema(`${path}:non_json_value`);
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalidSchema(`${path}:symbol_key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      invalidSchema(`${path}.${key}:non_data_property`);
    }
    entries.push([key, cloneJsonValue(descriptor.value, `${path}.${key}`)]);
  }
  return Object.fromEntries(entries);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validationDetail(validator: ValidateFunction): string {
  const first = validator.errors?.[0];
  return first
    ? `${first.instancePath || "$"}:${first.keyword}`
    : "$:schema_validation_failed";
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/\s+/g, " ").slice(0, 300)
    : "unknown";
}

function isFatalNormalization(error: unknown): boolean {
  return error instanceof Error &&
    error.message.includes("codex_structured_output_invalid:") &&
    (error.message.endsWith(":ambiguous_alternatives") ||
      error.message.endsWith(":schema_depth_exceeded"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidSchema(detail: string): never {
  throw new Error(`codex_output_schema_invalid:${detail}`);
}

function invalidOutput(detail: string): never {
  throw new Error(`codex_structured_output_invalid:${detail}`);
}
