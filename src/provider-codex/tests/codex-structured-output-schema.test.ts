import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  codexOutputSchemaPayload,
  normalizeCodexStructuredOutputForSchema,
  prepareCodexOutputSchemaPlan,
} from "../codex-json-execution-engine";

const hibModuleResultSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    resultSchemaVersion: { type: "number", const: 1 },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["info", "minor", "major", "blocking"],
          },
          file: { type: "string", minLength: 1 },
          line: {
            type: "integer",
            exclusiveMinimum: 0,
            maximum: 9_007_199_254_740_991,
          },
          title: { type: "string", minLength: 1 },
          body: { type: "string", minLength: 1 },
          defer: {
            type: "object",
            properties: {
              reason: { type: "string", minLength: 1 },
              issueLabel: { type: "string", minLength: 1 },
            },
            required: ["reason"],
            additionalProperties: false,
          },
        },
        required: ["severity", "file", "line", "title", "body"],
        additionalProperties: false,
      },
    },
    summary: { type: "string", minLength: 1 },
    verdict: {
      type: "string",
      enum: ["APPROVE", "CONDITIONAL_APPROVE", "NEEDS_WORK", "BLOCKED", "NO_NEW_FINDINGS"],
    },
    verdictLabel: {
      type: "string",
      enum: ["APPROVE", "CONDITIONAL_APPROVE", "NEEDS_WORK", "BLOCKED", "NO_NEW_FINDINGS"],
    },
    tldr: { type: "string", minLength: 1 },
    noFindingsReason: { type: "string" },
    structuredBookkeepingFallback: { type: "boolean" },
    usedJsonRetry: { type: "boolean" },
    blastRadius: {
      type: "object",
      properties: {
        score: { type: "integer", minimum: 0, maximum: 10 },
        paragraph: { type: "string", minLength: 1 },
      },
      required: ["score", "paragraph"],
      additionalProperties: false,
    },
    risks: {
      type: "object",
      properties: {
        sensitiveFunctions: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
        migrationTouched: { type: "boolean" },
      },
      additionalProperties: false,
    },
    relatedPRs: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    resolutionLog: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          evidence: { type: "string", minLength: 1 },
          id: { type: "string", minLength: 1 },
          fingerprint: { type: "string", minLength: 1 },
          evidenceRef: { type: "string", minLength: 1 },
          deferralType: { type: "string", minLength: 1 },
        },
        required: ["evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["resultSchemaVersion", "findings", "summary"],
  additionalProperties: false,
} as const;

describe("Codex strict structured-output schema adapter", () => {
  it("recursively requires every object property without mutating provider schema identity", () => {
    const originalBytes = JSON.stringify(hibModuleResultSchema);
    const originalDigest = sha256(originalBytes);

    const codexSchema = codexOutputSchemaPayload({
      name: "hib-module-result",
      schema: hibModuleResultSchema,
    });

    expect(codexSchema).toBeDefined();
    expect(JSON.stringify(hibModuleResultSchema)).toBe(originalBytes);
    expect(sha256(JSON.stringify(hibModuleResultSchema))).toBe(originalDigest);
    expect(codexOutputSchemaPayload({
      name: "hib-module-result",
      schema: hibModuleResultSchema,
    })).toEqual(codexSchema);
    assertStrictObjects(codexSchema);

    const root = codexSchema as Record<string, unknown>;
    expect(root).not.toHaveProperty("$schema");
    const properties = root.properties as Record<string, unknown>;
    expect(properties.verdict).toEqual({
      anyOf: [hibModuleResultSchema.properties.verdict, { type: "null" }],
    });
    expect(properties.structuredBookkeepingFallback).toEqual({
      anyOf: [{ type: "boolean" }, { type: "null" }],
    });
  });

  it("removes Codex-only null sentinels and retains provider-semantic nulls", () => {
    const normalized = normalizeCodexStructuredOutputForSchema(
      { name: "hib-module-result", schema: hibModuleResultSchema },
      {
        resultSchemaVersion: 1,
        findings: [{
          severity: "major",
          file: "src/reviewer.ts",
          line: 42,
          title: "Causal issue",
          body: "The evidence is reproducible.",
          defer: { reason: "Tracked separately", issueLabel: null },
        }],
        summary: "One finding",
        verdict: null,
        verdictLabel: "NEEDS_WORK",
        tldr: null,
        noFindingsReason: null,
        structuredBookkeepingFallback: null,
        usedJsonRetry: false,
        blastRadius: { score: 4, paragraph: "Reviewer boundary only" },
        risks: { sensitiveFunctions: null, migrationTouched: false },
        relatedPRs: ["vioxen/subscription-runtime#121"],
        resolutionLog: [{
          evidence: "focused tests pass",
          id: null,
          fingerprint: "abc123",
          evidenceRef: null,
          deferralType: null,
        }],
      },
    );

    expect(normalized).toEqual({
      resultSchemaVersion: 1,
      findings: [{
        severity: "major",
        file: "src/reviewer.ts",
        line: 42,
        title: "Causal issue",
        body: "The evidence is reproducible.",
        defer: { reason: "Tracked separately" },
      }],
      summary: "One finding",
      verdictLabel: "NEEDS_WORK",
      usedJsonRetry: false,
      blastRadius: { score: 4, paragraph: "Reviewer boundary only" },
      risks: { migrationTouched: false },
      relatedPRs: ["vioxen/subscription-runtime#121"],
      resolutionLog: [{
        evidence: "focused tests pass",
        fingerprint: "abc123",
      }],
    });

    expect(normalizeCodexStructuredOutputForSchema({
      type: "object",
      properties: {
        legitimateNull: { anyOf: [{ type: "string" }, { type: "null" }] },
        nullableObject: {
          type: ["object", "null"],
          properties: { optionalLabel: { type: "string" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    }, {
      legitimateNull: null,
      nullableObject: { optionalLabel: null },
    })).toEqual({ legitimateNull: null, nullableObject: {} });
  });

  it("preserves local refs and normalizes optional ref values causally", () => {
    const schema = {
      type: "object",
      properties: {
        requiredEvidence: { $ref: "#/$defs/evidence" },
        optionalEvidence: { $ref: "#/$defs/evidence" },
      },
      required: ["requiredEvidence"],
      additionalProperties: false,
      $defs: {
        evidence: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1 },
            label: { type: "string", minLength: 1 },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
    } as const;
    const payload = codexOutputSchemaPayload(schema) as Record<string, unknown>;
    assertStrictObjects(payload);
    expect((payload.properties as Record<string, unknown>).optionalEvidence)
      .toEqual({
        anyOf: [{ $ref: "#/$defs/evidence" }, { type: "null" }],
      });
    expect(normalizeCodexStructuredOutputForSchema(schema, {
      requiredEvidence: { text: "proof", label: null },
      optionalEvidence: null,
    })).toEqual({ requiredEvidence: { text: "proof" } });
  });

  it("resolves a ref root to exactly one object schema", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $ref: "#/$defs/result",
      $defs: {
        result: {
          type: "object",
          properties: { score: { type: "number", multipleOf: 2 } },
          required: ["score"],
          additionalProperties: false,
        },
      },
    } as const;
    const plan = prepareCodexOutputSchemaPlan(schema)!;
    expect(plan.codexSchema).toMatchObject({ $ref: "#/$defs/result" });
    expect(plan.normalize({ score: 4 })).toEqual({ score: 4 });
    expect(() => plan.normalize({ score: 3 })).toThrow(
      "codex_structured_output_invalid:/score:multipleOf",
    );
    expect(() => prepareCodexOutputSchemaPlan({
      ...schema,
      $defs: {
        result: {
          type: ["object", "null"],
          properties: {},
          additionalProperties: false,
        },
      },
    })).toThrow("codex_output_schema_invalid:$:root_must_be_exact_object");
  });

  it.each([
    {
      type: "object",
      properties: { value: { type: "string" } },
      required: [],
    },
    {
      type: "object",
      properties: { value: { type: "string", format: "uri" } },
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { value: { allOf: [{ type: "string" }] } },
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { value: { $ref: "https://example.com/schema" } },
      additionalProperties: false,
    },
  ])("fails closed for a schema Codex cannot preserve: %#", (schema) => {
    expect(() => codexOutputSchemaPayload(schema)).toThrow(
      "codex_output_schema_invalid",
    );
  });

  it.each(["anyOf", "oneOf"] as const)(
    "fails closed when %s branches normalize differently",
    (keyword) => {
      const schema = {
        type: "object",
        properties: {
          choice: {
            [keyword]: [
              {
                type: "object",
                properties: { label: { type: "string" } },
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  label: { anyOf: [{ type: "string" }, { type: "null" }] },
                },
                required: ["label"],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["choice"],
        additionalProperties: false,
      };
      expect(() => normalizeCodexStructuredOutputForSchema(
        schema,
        { choice: { label: null } },
      )).toThrow("codex_structured_output_invalid:$.choice:ambiguous_alternatives");
    },
  );

  it.each(["anyOf", "oneOf"] as const)(
    "preserves schema_depth_exceeded through recursive %s alternatives",
    (keyword) => {
      const schema = {
        type: "object",
        properties: { choice: { $ref: "#/$defs/recursive" } },
        required: ["choice"],
        additionalProperties: false,
        $defs: {
          recursive: {
            [keyword]: [
              { $ref: "#/$defs/recursive" },
              { type: "null" },
            ],
          },
        },
      };
      const plan = prepareCodexOutputSchemaPlan(schema)!;
      expect(() => plan.normalize({ choice: "not-null" })).toThrow(
        "codex_structured_output_invalid:$.choice:schema_depth_exceeded",
      );
    },
  );

  it("clones, freezes and compiles one provider schema plan", () => {
    const callerSchema = structuredClone(hibModuleResultSchema) as Record<string, any>;
    const plan = prepareCodexOutputSchemaPlan(callerSchema)!;
    callerSchema.properties.summary.minLength = 99;
    callerSchema.properties.injected = { type: "string" };

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.providerSchema)).toBe(true);
    expect(Object.isFrozen(plan.codexSchema)).toBe(true);
    expect(plan.providerSchema).not.toHaveProperty("properties.injected");
    expect(plan.normalize({
      resultSchemaVersion: 1,
      findings: [],
      summary: "valid",
    })).toEqual({ resultSchemaVersion: 1, findings: [], summary: "valid" });
  });

  it("does not accept inherited output fields as own JSON properties", () => {
    const plan = prepareCodexOutputSchemaPlan(hibModuleResultSchema)!;
    const inheritedSummary = Object.assign(
      Object.create({ summary: "not an own field" }),
      { resultSchemaVersion: 1, findings: [] },
    );
    expect(() => plan.normalize(inheritedSummary)).toThrow(
      "codex_structured_output_invalid:$:required",
    );
  });

  it("fails closed when provider output violates the original constraints", () => {
    expect(() => normalizeCodexStructuredOutputForSchema(
      hibModuleResultSchema,
      {
        resultSchemaVersion: 1,
        findings: [],
        summary: "",
        verdict: null,
        verdictLabel: null,
        tldr: null,
        noFindingsReason: null,
        structuredBookkeepingFallback: null,
        usedJsonRetry: null,
        blastRadius: null,
        risks: null,
        relatedPRs: null,
        resolutionLog: null,
      },
    )).toThrow("codex_structured_output_invalid:/summary:minLength");
  });
});

function assertStrictObjects(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertStrictObjects);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "object") {
    const properties = record.properties as Record<string, unknown>;
    expect(record.additionalProperties).toBe(false);
    expect(record.required).toEqual(Object.keys(properties).sort());
  }
  Object.values(record).forEach(assertStrictObjects);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
