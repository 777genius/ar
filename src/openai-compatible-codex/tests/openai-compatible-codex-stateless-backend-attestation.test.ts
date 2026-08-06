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


describe("OpenAI-compatible Codex stateless backend attestation", () => {
  it("uses the stateless completion profile without changing the official system prompt", async () => {
    const officialSystemPrompt =
      "Answer the LoCoMo question from the supplied conversation evidence only.";
    const expectedProfile = resolveCodexExecutionProfile(
      "stateless-completion",
    );
    const expectedBaseInstructionsSha256 = createHash("sha256")
      .update(expectedProfile.baseInstructions ?? "", "utf8")
      .digest("hex");
    await withStrongBridgeBackend(
      { turnUsage: observedTurnUsage() },
      async (backend, factory) => {
        const first = await backend.complete({
          ...strongBridgeRequest(),
          systemPrompt: officialSystemPrompt,
        });
        const second = await backend.complete({
          ...strongBridgeRequest(),
          requestId: "strong-bridge-test-2",
          systemPrompt: officialSystemPrompt,
        });
        const threadStarts = factory.requests.filter(
          (request) => request.method === "thread/start",
        );

        expect(threadStarts).toHaveLength(2);
        for (const threadStart of threadStarts) {
          expect(threadStart.params).toMatchObject({
            model: "gpt-5.5",
            serviceTier: "priority",
            ephemeral: true,
            baseInstructions: expectedProfile.baseInstructions,
            developerInstructions: officialSystemPrompt,
            environments: [],
            dynamicTools: [],
            config: {
              model_reasoning_effort: "high",
              service_tier: "priority",
            },
          });
          expect(String(threadStart.params?.baseInstructions)).toHaveLength(185);
        }
        expect(expectedProfile.baseInstructions).not.toContain(
          officialSystemPrompt,
        );
        expect(first.runtimeSelection).toMatchObject({
          thread_id: "thread-1",
          turn_id: "turn-1",
          model: "gpt-5.5",
          reasoning_effort: "high",
          service_tier: "priority",
          execution_profile: "stateless-completion",
          base_instructions_sha256:
            expectedBaseInstructionsSha256,
        });
        expect(second.runtimeSelection).toMatchObject({
          thread_id: "thread-2",
          turn_id: "turn-2",
          model: "gpt-5.5",
          reasoning_effort: "high",
          service_tier: "priority",
          execution_profile: "stateless-completion",
          base_instructions_sha256:
            expectedBaseInstructionsSha256,
        });
        expect(second.attestationHmacSha256).not.toBe(
          first.attestationHmacSha256,
        );
        const canonicalAttestation = JSON.parse(
          new TextDecoder().decode(
            openAiBridgeRuntimeAttestationCanonicalBytes({
              outputIdentity: testOutputIdentity(),
              requestIdentity: testRequestIdentity(),
              selection: first.runtimeSelection,
              usage: first.usage,
            }),
          ),
        ) as Record<string, unknown>;
        expect(canonicalAttestation).toMatchObject({
          runtime_selection: {
            execution_profile: "stateless-completion",
            base_instructions_sha256:
              expectedBaseInstructionsSha256,
          },
        });
      },
      { reasoningEffort: "high", serviceTier: "priority" },
    );
  });

  it("fails closed when typed response-format semantics differ from request identity", async () => {
    await withStrongBridgeBackend(
      { turnUsage: observedTurnUsage() },
      async (backend, factory) => {
        await expect(backend.complete({
          ...strongBridgeRequest(),
          responseFormat: locomoJudgeResponseFormat,
          requestIdentity: testRequestIdentity(),
        })).rejects.toThrow("codex_bridge_response_format_identity_mismatch");
        expect(factory.requests).toHaveLength(0);
      },
    );
  });

  it("rejects prose-wrapped structured output before publishing a signed result", async () => {
    await withStrongBridgeBackend(
      {
        turnUsage: observedTurnUsage(),
        agentMessageText:
          'Result: {"reasoning":"Evidence matches.","label":"CORRECT"}',
      },
      async (backend) => {
        await expect(backend.complete({
          ...strongBridgeRequest(),
          responseFormat: locomoJudgeResponseFormat,
          requestIdentity: testRequestIdentity({
            ...responseFormatIdentity(locomoJudgeResponseFormat),
          }),
        })).rejects.toMatchObject({
          code: OpenAiBridgeErrorCode.ProviderUnavailable,
        });
      },
    );
  });

  it("preserves official judge and empty-system answer prompts through app-server", async () => {
    const officialSystemPrompt =
      "You are evaluating conversational AI memory recall. Return JSON only with the format requested.";
    const officialJudgePrompt =
      "Question: Which checklist did Dana keep?\nCandidate: The blue checklist.";
    const officialAnswerPrompt =
      "Context:\nDana keeps the blue checklist.\n\nQuestion: Which checklist did Dana keep?";
    const judgeRequest = {
      model: "subscription-codex",
      messages: [
        { role: "system", content: officialSystemPrompt },
        { role: "user", content: officialJudgePrompt },
      ],
      response_format: locomoJudgeResponseFormat,
      max_tokens: 4_096,
      temperature: 0,
    };
    const answerRequest = {
      model: "subscription-codex",
      messages: [
        { role: "system", content: "" },
        { role: "user", content: officialAnswerPrompt },
      ],
      max_tokens: 4_096,
      temperature: 0,
    };

    await withStrongBridgeBackend(
      {
        turnUsage: observedTurnUsage(),
        agentMessageText: '{"reasoning":"Evidence matches.","label":"CORRECT"}',
      },
      async (backend, factory) => {
        const useCase = new OpenAiBridgeChatCompletionUseCase({
          backend,
          publicModel: "subscription-codex",
          codexModel: "gpt-5.5",
        });
        const judgeResponse = await useCase.complete({
          request: judgeRequest,
          requestBodySha256: requestBodySha256(judgeRequest),
          abortSignal: new AbortController().signal,
        });
        const answerResponse = await useCase.complete({
          request: answerRequest,
          requestBodySha256: requestBodySha256(answerRequest),
          abortSignal: new AbortController().signal,
        });
        const threadStarts = factory.requests.filter(
          (item) => item.method === "thread/start",
        );
        const turnStarts = factory.requests.filter(
          (item) => item.method === "turn/start",
        );

        expect(threadStarts).toHaveLength(2);
        expect(threadStarts[0]?.params).toMatchObject({
          model: "gpt-5.5",
          baseInstructions: resolveCodexExecutionProfile(
            "stateless-completion",
          ).baseInstructions,
          developerInstructions: officialSystemPrompt,
          ephemeral: true,
          environments: [],
          dynamicTools: [],
        });
        expect(threadStarts[1]?.params).toMatchObject({
          model: "gpt-5.5",
          developerInstructions: null,
          ephemeral: true,
          environments: [],
          dynamicTools: [],
        });
        expect(factory.prompts).toEqual([
          officialJudgePrompt,
          officialAnswerPrompt,
        ]);
        expect(turnStarts[0]?.params).toMatchObject({
          model: "gpt-5.5",
          outputSchema: locomoJudgeResponseFormat.json_schema.schema,
          environments: [],
        });
        expect(turnStarts[1]?.params).toMatchObject({
          model: "gpt-5.5",
          outputSchema: null,
          environments: [],
        });
        expect(judgeResponse.choices[0]?.message.content).toBe(
          '{"reasoning":"Evidence matches.","label":"CORRECT"}',
        );
        expect(answerResponse.choices[0]?.message.content).toBe(
          '{"reasoning":"Evidence matches.","label":"CORRECT"}',
        );
        expect(judgeResponse.subscription_runtime.request_identity)
          .toMatchObject({
            request_body_sha256: requestBodySha256(judgeRequest),
          });
        expect(answerResponse.subscription_runtime.request_identity)
          .toMatchObject({
            request_body_sha256: requestBodySha256(answerRequest),
          });
        expect(judgeResponse.subscription_runtime.output_identity)
          .toEqual(testOutputIdentity(
            '{"reasoning":"Evidence matches.","label":"CORRECT"}',
          ));
        expect(answerResponse.subscription_runtime.output_identity)
          .toEqual(testOutputIdentity(
            '{"reasoning":"Evidence matches.","label":"CORRECT"}',
          ));
      },
    );
  });

  it("binds models and exact request-body mutations into the v2 receipt HMAC", () => {
    const baseRequest = {
      model: "subscription-codex",
      messages: [
        { role: "system", content: "Official system prompt." },
        { role: "user", content: "Official user prompt." },
      ],
      max_tokens: 512,
    };
    const systemMutation = {
      ...baseRequest,
      messages: [
        { role: "system", content: "Changed system prompt." },
        baseRequest.messages[1],
      ],
    };
    const userMutation = {
      ...baseRequest,
      messages: [
        baseRequest.messages[0],
        { role: "user", content: "Changed user prompt." },
      ],
    };
    const maxTokensMutation = { ...baseRequest, max_tokens: 513 };
    const baseIdentity = testRequestIdentity({
      request_body_sha256: requestBodySha256(baseRequest),
    });
    const requestMutationIdentities = [
      systemMutation,
      userMutation,
      maxTokensMutation,
    ].map((request) => testRequestIdentity({
      request_body_sha256: requestBodySha256(request),
    }));

    expect(new Set([
      baseIdentity.request_body_sha256,
      ...requestMutationIdentities.map((item) => item.request_body_sha256),
    ]).size).toBe(4);

    const typedIdentity = testRequestIdentity({
      ...baseIdentity,
      ...responseFormatIdentity(locomoJudgeResponseFormat),
    });
    const schemaMutationIdentity = testRequestIdentity({
      ...baseIdentity,
      ...responseFormatIdentity({
        ...locomoJudgeResponseFormat,
        json_schema: {
          ...locomoJudgeResponseFormat.json_schema,
          schema: {
            ...locomoJudgeResponseFormat.json_schema.schema,
            properties: {
              ...locomoJudgeResponseFormat.json_schema.schema.properties,
              label: { type: "string", enum: ["CORRECT"] },
            },
          },
        },
      }),
    });

    const identities = [
      baseIdentity,
      typedIdentity,
      schemaMutationIdentity,
      testRequestIdentity({
        ...baseIdentity,
        public_model: "different-public-model",
      }),
      testRequestIdentity({
        ...baseIdentity,
        client_requested_model: "different-client-model",
      }),
      testRequestIdentity({
        ...baseIdentity,
        configured_codex_model: "gpt-different",
      }),
      testRequestIdentity({
        ...baseIdentity,
        requested_codex_model: "gpt-different-request",
      }),
      ...requestMutationIdentities,
    ];
    const hmacs = identities.map((requestIdentity) =>
      testAttestationHmac(requestIdentity));
    const outputMutationHmac = testAttestationHmac(
      baseIdentity,
      testOutputIdentity("changed completion"),
    );

    expect(new Set(hmacs).size).toBe(identities.length);
    expect(outputMutationHmac).not.toBe(hmacs[0]);
    const canonicalPayload = new TextDecoder().decode(
      testAttestationBytes(baseIdentity),
    );
    expect(canonicalPayload).not.toContain("Official system prompt.");
    expect(canonicalPayload).not.toContain("Official user prompt.");
    expect(JSON.parse(canonicalPayload)).toMatchObject({
      schema_version: 2,
      request_identity: baseIdentity,
    });
  });

});

function observedTurnUsage(): Record<string, number> {
  return {
    input_tokens: 21,
    cached_input_tokens: 8,
    cache_write_input_tokens: 0,
    output_tokens: 5,
    reasoning_output_tokens: 3,
    total_tokens: 26,
  };
}

function strongBridgeRequest() {
  return {
    prompt: "Reply OK",
    model: "gpt-5.5",
    requestId: "strong-bridge-test",
    requestIdentity: testRequestIdentity(),
    abortSignal: new AbortController().signal,
  } as const;
}

async function withStrongBridgeBackend(
  options:
    | FakeAppServerFactoryOptions
    | ((authPath: string) => FakeAppServerFactoryOptions),
  run: (
    backend: CodexOpenAiBridgeBackend,
    factory: FakeAppServerFactory,
    isolatedAuthPath: string,
  ) => Promise<void>,
  backendOptions: {
    readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    readonly serviceTier?: string;
  } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "subscription-runtime-strong-bridge-"));
  const authRoot = join(root, "auth");
  const accountHome = join(authRoot, "account-a");
  const authPath = join(accountHome, "auth.json");
  await mkdir(accountHome, { recursive: true });
  await writeFile(authPath, JSON.stringify({
    tokens: {
      access_token: "test-token",
      account_id: "physical-account-a",
    },
  }));
  const stateDir = join(root, "state");
  const isolatedAuthPath = join(
    stateDir,
    "codex-home",
    "account-a",
    "auth.json",
  );
  const fakeOptions = typeof options === "function"
    ? options(isolatedAuthPath)
    : options;
  const factory = new FakeAppServerFactory(fakeOptions);
  const backend = new CodexOpenAiBridgeBackend({
    codexBinaryPath: "/bin/codex-test",
    authRootDir: authRoot,
    stateDir,
    accountNames: ["account-a"],
    timeoutMs: 250,
    quotaCooldownMs: 1_000,
    maxAccountCycles: 1,
    maxConcurrentRequests: 1,
    reasoningEffort: backendOptions.reasoningEffort ?? "low",
    ...(backendOptions.serviceTier === undefined
      ? {}
      : { serviceTier: backendOptions.serviceTier }),
    attestationSecret,
    processFactory: factory.create,
  });
  try {
    await run(backend, factory, isolatedAuthPath);
  } finally {
    await backend.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

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

function testAttestationBytes(
  requestIdentity: ReturnType<typeof testRequestIdentity>,
  outputIdentity = testOutputIdentity(),
): Uint8Array {
  return openAiBridgeRuntimeAttestationCanonicalBytes({
    requestIdentity,
    outputIdentity,
    selection: {
      account_binding_hmac_sha256: "a".repeat(64),
      thread_id: "thread-1",
      turn_id: "turn-1",
      model: "gpt-5.5",
      model_provider: "openai",
      reasoning_effort: "high",
      service_tier: "priority",
      execution_profile: "stateless-completion",
      base_instructions_sha256: "d".repeat(64),
    },
    usage: {
      prompt_tokens: 21,
      prompt_tokens_details: { cached_tokens: 8 },
      completion_tokens: 5,
      completion_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 26,
    },
    requestedOutputTokenLimit: 512,
  });
}

function testAttestationHmac(
  requestIdentity: ReturnType<typeof testRequestIdentity>,
  outputIdentity = testOutputIdentity(),
): string {
  return createHmac("sha256", attestationSecret)
    .update(testAttestationBytes(requestIdentity, outputIdentity))
    .digest("hex");
}
