import { createHash, createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DefaultRedactor,
  type ProcessResult,
  type RunnerPort,
  type RunnerCapabilities,
} from "../../core/index.js";
import {
  assertExactJsonSchemaOutput,
  OpenAiBridgeChatCompletionUseCase,
  OpenAiBridgeErrorCode,
  OpenAiBridgeObjectKind,
  OpenAiBridgeRequestError,
  OpenAiBridgeResponseFormatType,
  OpenAiBridgeRole,
  CodexOpenAiBridgeBackend,
  openAiBridgeRequestBodySha256,
  parseChatCompletionRequest,
  renderOpenAiBridgeChat,
  startOpenAiBridgeHttpServer,
  type OpenAiBridgeChatBackend,
} from "../index.js";
import {
  PackagedCodexJsonExecutionEngine,
  codexProviderApiEgressProfileId,
  codexProviderEgressProfileEnvVar,
  resolveCodexExecutionProfile,
} from "../../provider-codex/index.js";
import {
  FakeAppServerFactory,
  type FakeAppServerFactoryOptions,
} from "../../provider-codex/app-server/testing/fake-app-server.js";
import { AppServerProviderReceiptTracker } from "../../provider-codex/app-server/application/app-server-provider-receipt-tracker.js";
import { readAppServerThreadExecutionReceipt } from "../../provider-codex/app-server/protocol/app-server-thread-receipt.js";
import { openAiBridgeRuntimeAttestationCanonicalBytes } from "../chat-completions/domain/runtime-attestation.js";
import { responseFormatIdentity } from "../chat-completions/domain/response-format-policy.js";

const attestationSecret = "test-attestation-secret-that-is-at-least-32-bytes";
const locomoJudgeResponseFormat = {
  type: OpenAiBridgeResponseFormatType.JsonSchema,
  json_schema: {
    name: "locomo_judge",
    strict: true,
    schema: {
      type: "object",
      properties: {
        reasoning: { type: "string" },
        label: { type: "string", enum: ["CORRECT", "WRONG"] },
      },
      required: ["reasoning", "label"],
      additionalProperties: false,
    },
  },
} as const;


describe("OpenAI-compatible Codex response-format domain", () => {
  it("renders typed json_schema requests into a JSON-only system prompt", () => {
    const rendered = renderOpenAiBridgeChat({
      messages: [
        { role: OpenAiBridgeRole.System, content: "Extract memories." },
        { role: OpenAiBridgeRole.User, content: "Dana keeps the blue checklist." },
        { role: OpenAiBridgeRole.Assistant, content: "Earlier response." },
      ],
      response_format: locomoJudgeResponseFormat,
    });

    expect(rendered.systemPrompt).toContain("Extract memories.");
    expect(rendered.systemPrompt).toContain("Return one valid JSON object only");
    expect(rendered.prompt).toContain("<message role=\"user\">");
  });

  it("preserves a direct system-user prompt pair byte-for-byte", () => {
    const systemPrompt = "  Official system prompt.\nKeep spacing.  ";
    const userPrompt = "  Official user prompt.\nEvidence follows.  ";
    const rendered = renderOpenAiBridgeChat({
      messages: [
        { role: OpenAiBridgeRole.System, content: systemPrompt },
        { role: OpenAiBridgeRole.User, content: userPrompt },
      ],
      response_format: locomoJudgeResponseFormat,
    });

    expect(rendered).toEqual({
      systemPrompt,
      prompt: userPrompt,
    });
  });

  it("preserves the four pinned Mem0 benchmark prompt shapes", () => {
    const locomoJudgeSystemPrompt =
      "You are evaluating conversational AI memory recall. Return JSON only with the format requested.";
    const shapes = [
      {
        name: "LoCoMo answer",
        systemPrompt: "",
        userPrompt: "LOCOMO answer generation prompt",
        responseFormat: undefined,
      },
      {
        name: "LoCoMo judge",
        systemPrompt: locomoJudgeSystemPrompt,
        userPrompt: "LOCOMO category judge prompt",
        responseFormat: locomoJudgeResponseFormat,
      },
      {
        name: "LongMemEval answer",
        systemPrompt: "",
        userPrompt: "LongMemEval answer generation prompt",
        responseFormat: undefined,
      },
      {
        name: "LongMemEval judge",
        systemPrompt: "",
        userPrompt: "LongMemEval yes/no judge prompt",
        responseFormat: undefined,
      },
    ] as const;

    for (const shape of shapes) {
      const rendered = renderOpenAiBridgeChat({
        messages: [
          { role: OpenAiBridgeRole.System, content: shape.systemPrompt },
          { role: OpenAiBridgeRole.User, content: shape.userPrompt },
        ],
        ...(shape.responseFormat === undefined
          ? {}
          : { response_format: shape.responseFormat }),
      });
      expect(rendered, shape.name).toEqual({
        prompt: shape.userPrompt,
        ...(shape.systemPrompt
          ? { systemPrompt: shape.systemPrompt }
          : {}),
      });
    }
    expect(renderOpenAiBridgeChat({
      messages: [
        { role: OpenAiBridgeRole.User, content: "single-user official answer prompt" },
      ],
    })).toEqual({ prompt: "single-user official answer prompt" });
  });

  it("accepts the strict LoCoMo judge json_schema and rejects generic JSON mode", () => {
    const parsed = parseChatCompletionRequest({
      messages: [{ role: "user", content: "Judge this answer." }],
      response_format: locomoJudgeResponseFormat,
    });
    expect(parsed.response_format).toEqual(locomoJudgeResponseFormat);
    expect(() => parseChatCompletionRequest({
      messages: [{ role: "user", content: "Judge this answer." }],
      response_format: { type: "json_object" },
    })).toThrow(/strict json_schema/);
  });

  it("snapshots typed schema before asynchronous backend dispatch", () => {
    const mutableLabels = ["CORRECT", "WRONG"];
    const responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "locomo_judge",
        strict: true,
        schema: {
          type: "object",
          properties: {
            reasoning: { type: "string" },
            label: { type: "string", enum: mutableLabels },
          },
          required: ["reasoning", "label"],
          additionalProperties: false,
        },
      },
    };
    const parsed = parseChatCompletionRequest({
      messages: [{ role: "user", content: "Judge this answer." }],
      response_format: responseFormat,
    });
    mutableLabels.splice(0, mutableLabels.length, "WRONG");
    expect(parsed.response_format).toEqual(locomoJudgeResponseFormat);
    expect(Object.isFrozen(parsed.response_format)).toBe(true);
    expect(Object.isFrozen(
      parsed.response_format?.type === OpenAiBridgeResponseFormatType.JsonSchema
        ? parsed.response_format.json_schema.schema
        : null,
    )).toBe(true);
  });

  it.each([
    ["missing strict", {
      type: "json_schema",
      json_schema: {
        name: "locomo_judge",
        schema: locomoJudgeResponseFormat.json_schema.schema,
      },
    }],
    ["open object", {
      type: "json_schema",
      json_schema: {
        name: "locomo_judge",
        strict: true,
        schema: {
          ...locomoJudgeResponseFormat.json_schema.schema,
          additionalProperties: true,
        },
      },
    }],
    ["incomplete required", {
      type: "json_schema",
      json_schema: {
        name: "locomo_judge",
        strict: true,
        schema: {
          ...locomoJudgeResponseFormat.json_schema.schema,
          required: ["label"],
        },
      },
    }],
    ["unsupported keyword", {
      type: "json_schema",
      json_schema: {
        name: "locomo_judge",
        strict: true,
        schema: {
          ...locomoJudgeResponseFormat.json_schema.schema,
          oneOf: [],
        },
      },
    }],
    ["wrong enum type", {
      type: "json_schema",
      json_schema: {
        name: "locomo_judge",
        strict: true,
        schema: {
          ...locomoJudgeResponseFormat.json_schema.schema,
          properties: {
            ...locomoJudgeResponseFormat.json_schema.schema.properties,
            label: { type: "string", enum: [1, 2] },
          },
        },
      },
    }],
  ])("rejects malformed or unsupported json_schema: %s", (_name, responseFormat) => {
    expect(() => parseChatCompletionRequest({
      messages: [{ role: "user", content: "Judge this answer." }],
      response_format: responseFormat,
    })).toThrow(OpenAiBridgeRequestError);
  });

  it.each([
    ["missing required", '{"label":"CORRECT"}'],
    ["extra property", '{"reasoning":"ok","label":"CORRECT","score":1}'],
    ["wrong enum", '{"reasoning":"ok","label":"MAYBE"}'],
    ["wrong type", '{"reasoning":"ok","label":1}'],
    ["invalid JSON", '{"reasoning":'],
    ["prose prefix", 'Result: {"reasoning":"ok","label":"CORRECT"}'],
    ["trailing prose", '{"reasoning":"ok","label":"CORRECT"} done'],
  ])("rejects exact structured output violation: %s", (_name, outputText) => {
    expect(() => assertExactJsonSchemaOutput(
      outputText,
      locomoJudgeResponseFormat,
    )).toThrow(/structured_output/);
  });

  it("accepts the exact strict LoCoMo judge output", () => {
    expect(() => assertExactJsonSchemaOutput(
      '{"reasoning":"Evidence matches.","label":"CORRECT"}',
      locomoJudgeResponseFormat,
    )).not.toThrow();
  });

  it("validates nested closed objects and arrays recursively", () => {
    const nestedFormat = {
      type: OpenAiBridgeResponseFormatType.JsonSchema,
      json_schema: {
        name: "nested_judge",
        strict: true,
        schema: {
          type: "object",
          properties: {
            verdict: {
              type: "object",
              properties: {
                label: { type: "string", enum: ["CORRECT", "WRONG"] },
                citations: { type: "array", items: { type: "integer" } },
              },
              required: ["label", "citations"],
              additionalProperties: false,
            },
          },
          required: ["verdict"],
          additionalProperties: false,
        },
      },
    } as const;
    expect(() => assertExactJsonSchemaOutput(
      '{"verdict":{"label":"CORRECT","citations":[1,2]}}',
      nestedFormat,
    )).not.toThrow();
    expect(() => assertExactJsonSchemaOutput(
      '{"verdict":{"label":"CORRECT","citations":[1,"2"]}}',
      nestedFormat,
    )).toThrow("openai_bridge_structured_output_schema_mismatch");
  });

});
