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


describe("OpenAI-compatible Codex HTTP application boundary", () => {
  it("returns an OpenAI-compatible chat completion response", async () => {
    let backendCalls = 0;
    const backend: OpenAiBridgeChatBackend = {
      async complete(input) {
        expect(input.model).toBe("gpt-5.5");
        expect(input.requestedOutputTokenLimit).toBe(41);
        expect(input.systemPrompt).toBeUndefined();
        expect(input.requestIdentity).toEqual(
          backendCalls === 0
            ? testRequestIdentity({
                client_requested_model: "gpt-4o-mini",
                request_body_sha256: requestBodySha256(firstRequest),
                ...responseFormatIdentity(locomoJudgeResponseFormat),
              })
            : testRequestIdentity({
                request_body_sha256: requestBodySha256(secondRequest),
                ...responseFormatIdentity(locomoJudgeResponseFormat),
              }),
        );
        expect(input.responseFormat).toEqual(locomoJudgeResponseFormat);
        return {
          text: '{"reasoning":"Evidence matches.","label":"CORRECT"}',
          model: input.model,
          usage: {
            prompt_tokens: 123,
            completion_tokens: 17,
            total_tokens: 140,
          },
          runtimeSelection: {
            account_binding_hmac_sha256: "a".repeat(64),
            thread_id: "thread-1",
            turn_id: "turn-1",
            model: input.model,
            model_provider: "openai",
            reasoning_effort: "high",
            service_tier: "default",
            execution_profile: "stateless-completion",
            base_instructions_sha256: "d".repeat(64),
          },
          outputIdentity: {
            output_text_sha256: createHash("sha256")
              .update('{"reasoning":"Evidence matches.","label":"CORRECT"}', "utf8")
              .digest("hex"),
            terminal_status: "completed",
          },
          attestationHmacSha256: (backendCalls++ === 0 ? "b" : "c").repeat(64),
        };
      },
    };
    const useCase = new OpenAiBridgeChatCompletionUseCase({
      backend,
      publicModel: "subscription-codex",
      codexModel: "gpt-5.5",
      clock: () => new Date("2026-07-02T20:00:00.000Z"),
    });

    const firstRequest = {
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: "Extract: Dana keeps the blue checklist." },
      ],
      response_format: locomoJudgeResponseFormat,
      max_completion_tokens: 41,
    };
    const response = await useCase.complete({
      request: firstRequest,
      requestBodySha256: requestBodySha256(firstRequest),
      abortSignal: new AbortController().signal,
    });

    expect(response.object).toBe(OpenAiBridgeObjectKind.ChatCompletion);
    expect(response.model).toBe("gpt-5.5");
    expect(response.choices[0]?.message.content).toBe(
      '{"reasoning":"Evidence matches.","label":"CORRECT"}',
    );
    expect(response.usage).toEqual({
      prompt_tokens: 123,
      completion_tokens: 17,
      total_tokens: 140,
    });
    expect(response.system_fingerprint).toMatch(
      /^subscription-runtime-codex-bridge-v4:[a-f0-9]{64}$/,
    );
    expect(response.subscription_runtime).toEqual({
      usage_source: "codex_thread_token_usage_updated",
      runtime_selection: {
        account_binding_hmac_sha256: "a".repeat(64),
        thread_id: "thread-1",
        turn_id: "turn-1",
        model: "gpt-5.5",
        model_provider: "openai",
        reasoning_effort: "high",
        service_tier: "default",
        execution_profile: "stateless-completion",
        base_instructions_sha256: "d".repeat(64),
      },
      request_identity: testRequestIdentity({
        client_requested_model: "gpt-4o-mini",
        request_body_sha256: requestBodySha256(firstRequest),
        ...responseFormatIdentity(locomoJudgeResponseFormat),
      }),
      output_identity: {
        output_text_sha256: createHash("sha256")
          .update('{"reasoning":"Evidence matches.","label":"CORRECT"}', "utf8")
          .digest("hex"),
        terminal_status: "completed",
      },
      output_token_limit: { requested_tokens: 41, enforced: false },
      receipt_hmac_sha256: "b".repeat(64),
      schema_version: 2,
      attestation_level: "provider_receipt",
    });
    expect(response.system_fingerprint).not.toContain("b".repeat(64));
    const secondRequest = {
      messages: [{ role: "user", content: "A second turn." }],
      response_format: locomoJudgeResponseFormat,
      max_completion_tokens: 41,
    };
    const secondResponse = await useCase.complete({
      request: secondRequest,
      requestBodySha256: requestBodySha256(secondRequest),
      abortSignal: new AbortController().signal,
    });
    expect(secondResponse.system_fingerprint).toBe(response.system_fingerprint);
    expect(secondResponse.subscription_runtime.receipt_hmac_sha256).toBe("c".repeat(64));
  });

  it.each([
    ["terminal status", "failed", testOutputIdentity("test completion").output_text_sha256,
      "openai_bridge_output_terminal_status_invalid"],
    ["output hash", "completed", "f".repeat(64),
      "openai_bridge_output_identity_mismatch"],
  ] as const)("rejects malformed backend %s", async (
    _name,
    terminalStatus,
    outputTextSha256,
    expectedError,
  ) => {
    const backend: OpenAiBridgeChatBackend = {
      async complete(input) {
        return {
          text: "test completion",
          model: input.model,
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
          runtimeSelection: {
            account_binding_hmac_sha256: "a".repeat(64),
            thread_id: "thread-malformed-port",
            turn_id: "turn-malformed-port",
            model: input.model,
            model_provider: "openai",
            reasoning_effort: "high",
            service_tier: "default",
            execution_profile: "stateless-completion",
            base_instructions_sha256: "d".repeat(64),
          },
          outputIdentity: {
            output_text_sha256: outputTextSha256,
            terminal_status: terminalStatus as "completed",
          },
          attestationHmacSha256: "b".repeat(64),
        };
      },
    };
    const useCase = new OpenAiBridgeChatCompletionUseCase({
      backend,
      publicModel: "subscription-codex",
      codexModel: "gpt-5.5",
    });
    const request = {
      messages: [{ role: "user", content: "Reply." }],
    };
    await expect(useCase.complete({
      request,
      requestBodySha256: requestBodySha256(request),
      abortSignal: new AbortController().signal,
    })).rejects.toThrow(expectedError);
  });

  it("parses and forwards strict json_schema through the production HTTP path", async () => {
    let received: Parameters<OpenAiBridgeChatBackend["complete"]>[0] | undefined;
    const outputText = '{"reasoning":"Evidence matches.","label":"CORRECT"}';
    const backend: OpenAiBridgeChatBackend = {
      async complete(input) {
        received = input;
        return {
          text: outputText,
          model: input.model,
          usage: {
            prompt_tokens: 20,
            completion_tokens: 8,
            total_tokens: 28,
          },
          runtimeSelection: {
            account_binding_hmac_sha256: "a".repeat(64),
            thread_id: "thread-http",
            turn_id: "turn-http",
            model: input.model,
            model_provider: "openai",
            reasoning_effort: "high",
            service_tier: "default",
            execution_profile: "stateless-completion",
            base_instructions_sha256: "d".repeat(64),
          },
          outputIdentity: testOutputIdentity(outputText),
          attestationHmacSha256: "b".repeat(64),
        };
      },
    };
    const request = {
      model: "subscription-codex",
      messages: [
        { role: "system", content: "Official LoCoMo judge system prompt." },
        { role: "user", content: "Official LoCoMo judge user prompt." },
      ],
      response_format: locomoJudgeResponseFormat,
      max_tokens: 4_096,
      temperature: 0,
    };
    const rawBody = JSON.stringify(request);
    const server = await startOpenAiBridgeHttpServer({
      host: "127.0.0.1",
      port: 0,
      publicModel: "subscription-codex",
      requestBodyMaxBytes: 64 * 1024,
      chatCompletion: new OpenAiBridgeChatCompletionUseCase({
        backend,
        publicModel: "subscription-codex",
        codexModel: "gpt-5.5",
      }),
      health: () => ({ ok: true }),
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test_server_address");
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: rawBody,
        },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        choices: [{ message: { content: outputText } }],
      });
      expect(received?.systemPrompt).toBe(request.messages[0]?.content);
      expect(received?.prompt).toBe(request.messages[1]?.content);
      expect(received?.responseFormat).toEqual(locomoJudgeResponseFormat);
      expect(received?.requestIdentity).toMatchObject({
        request_body_sha256: openAiBridgeRequestBodySha256(
          new TextEncoder().encode(rawBody),
        ),
        ...responseFormatIdentity(locomoJudgeResponseFormat),
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("rejects schema-invalid backend JSON before HTTP 200", async () => {
    const invalidOutput = '{"label":"CORRECT"}';
    const backend: OpenAiBridgeChatBackend = {
      async complete(input) {
        return {
          text: invalidOutput,
          model: input.model,
          usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
          runtimeSelection: {
            account_binding_hmac_sha256: "a".repeat(64),
            thread_id: "thread-invalid-json",
            turn_id: "turn-invalid-json",
            model: input.model,
            model_provider: "openai",
            reasoning_effort: "high",
            service_tier: "default",
            execution_profile: "stateless-completion",
            base_instructions_sha256: "d".repeat(64),
          },
          outputIdentity: testOutputIdentity(invalidOutput),
          attestationHmacSha256: "b".repeat(64),
        };
      },
    };
    const request = {
      messages: [{ role: "user", content: "Judge." }],
      response_format: locomoJudgeResponseFormat,
    };
    const server = await startOpenAiBridgeHttpServer({
      host: "127.0.0.1",
      port: 0,
      publicModel: "subscription-codex",
      requestBodyMaxBytes: 64 * 1024,
      chatCompletion: new OpenAiBridgeChatCompletionUseCase({
        backend,
        publicModel: "subscription-codex",
        codexModel: "gpt-5.5",
      }),
      health: () => ({}),
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test_server_address");
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        },
      );
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: OpenAiBridgeErrorCode.ProviderUnavailable },
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("normalizes both OpenAI output token limit fields", () => {
    expect(parseChatCompletionRequest({
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 77,
    }).requestedOutputTokenLimit).toBe(77);
    expect(parseChatCompletionRequest({
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 88,
    }).requestedOutputTokenLimit).toBe(88);
    expect(parseChatCompletionRequest({
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 99,
      max_completion_tokens: 99,
    }).requestedOutputTokenLimit).toBe(99);
  });

});

function requestBodySha256(request: unknown): string {
  return openAiBridgeRequestBodySha256(
    new TextEncoder().encode(JSON.stringify(request)),
  );
}

function testRequestIdentity(
  overrides: Partial<{
    readonly public_model: string;
    readonly client_requested_model: string;
    readonly configured_codex_model: string;
    readonly requested_codex_model: string;
    readonly request_body_sha256: string;
    readonly response_format_type: OpenAiBridgeResponseFormatType.Text
      | OpenAiBridgeResponseFormatType.JsonSchema;
    readonly response_format_sha256: string;
    readonly response_schema_sha256: string | null;
  }> = {},
) {
  return {
    public_model: "subscription-codex",
    client_requested_model: "subscription-codex",
    configured_codex_model: "gpt-5.5",
    requested_codex_model: "gpt-5.5",
    request_body_sha256: requestBodySha256({
      messages: [{ role: "user", content: "Reply OK" }],
    }),
    ...responseFormatIdentity(undefined),
    ...overrides,
  } as const;
}

function testOutputIdentity(outputText = "test completion") {
  return {
    output_text_sha256: createHash("sha256")
      .update(outputText, "utf8")
      .digest("hex"),
    terminal_status: "completed",
  } as const;
}
