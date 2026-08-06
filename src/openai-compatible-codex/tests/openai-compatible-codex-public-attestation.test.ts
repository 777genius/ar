import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OpenAiBridgeResponseFormatType,
  openAiBridgeRuntimeAttestationCanonicalBytes,
  responseFormatIdentity,
  verifyOpenAiBridgeRuntimeAttestationHmac,
  type OpenAiBridgeRuntimeAttestationInput,
} from "@vioxen/subscription-runtime/openai-compatible-codex";

const secret = "external-consumer-attestation-secret-32-bytes-minimum";

describe("public OpenAI bridge attestation contract", () => {
  it("verifies schema-v2 canonical bytes through the public package subpath", () => {
    const attestation = testAttestation();
    const canonicalBytes = openAiBridgeRuntimeAttestationCanonicalBytes(attestation);
    const expectedHmacSha256 = createHmac("sha256", secret)
      .update(canonicalBytes)
      .digest("hex");

    expect(verifyOpenAiBridgeRuntimeAttestationHmac({
      attestationSecret: secret,
      expectedHmacSha256,
      attestation,
    })).toBe(true);
    expect(verifyOpenAiBridgeRuntimeAttestationHmac({
      attestationSecret: `${secret}-wrong`,
      expectedHmacSha256,
      attestation,
    })).toBe(false);

    const serialized = new TextDecoder().decode(canonicalBytes);
    expect(Object.keys(JSON.parse(serialized))).toEqual([
      "schema_version",
      "attestation_level",
      "usage_source",
      "runtime_selection",
      "request_identity",
      "output_identity",
      "usage",
      "output_token_limit",
    ]);
    expect(JSON.parse(serialized).output_token_limit.requested_tokens).toBeNull();
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private completion");
    expect(serialized).not.toContain(secret);
  });

  it("canonicalizes response-format object keys while binding schema semantics", () => {
    const first = responseFormatIdentity({
      type: OpenAiBridgeResponseFormatType.JsonSchema,
      json_schema: {
        name: "public_judge",
        strict: true,
        schema: {
          type: "object",
          properties: {
            label: { type: "string", enum: ["CORRECT", "WRONG"] },
          },
          required: ["label"],
          additionalProperties: false,
        },
      },
    });
    const reordered = responseFormatIdentity({
      json_schema: {
        strict: true,
        schema: {
          additionalProperties: false,
          required: ["label"],
          properties: {
            label: { enum: ["CORRECT", "WRONG"], type: "string" },
          },
          type: "object",
        },
        name: "public_judge",
      },
      type: OpenAiBridgeResponseFormatType.JsonSchema,
    });
    const changed = responseFormatIdentity({
      type: OpenAiBridgeResponseFormatType.JsonSchema,
      json_schema: {
        name: "public_judge",
        strict: true,
        schema: {
          type: "object",
          properties: {
            label: { type: "string", enum: ["CORRECT"] },
          },
          required: ["label"],
          additionalProperties: false,
        },
      },
    });

    expect(reordered).toEqual(first);
    expect(changed.response_format_sha256).not.toBe(first.response_format_sha256);
    expect(changed.response_schema_sha256).not.toBe(first.response_schema_sha256);
  });
});

function testAttestation(): OpenAiBridgeRuntimeAttestationInput {
  return {
    requestIdentity: {
      public_model: "subscription-codex",
      client_requested_model: "subscription-codex",
      configured_codex_model: "gpt-5.5",
      requested_codex_model: "gpt-5.5",
      request_body_sha256: "1".repeat(64),
      response_format_type: OpenAiBridgeResponseFormatType.Text,
      response_format_sha256: "2".repeat(64),
      response_schema_sha256: null,
    },
    outputIdentity: {
      output_text_sha256: "3".repeat(64),
      terminal_status: "completed",
    },
    selection: {
      account_binding_hmac_sha256: "4".repeat(64),
      thread_id: "thread-public",
      turn_id: "turn-public",
      model: "gpt-5.5",
      model_provider: "openai",
      reasoning_effort: "high",
      service_tier: "default",
      execution_profile: "stateless-completion",
      base_instructions_sha256: "5".repeat(64),
    },
    usage: {
      prompt_tokens: 10,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens: 4,
      completion_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 14,
    },
  };
}
