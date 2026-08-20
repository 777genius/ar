import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Options,
  Query,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  AgentRuntimeEditMode,
  AgentRuntimeExecutionMode,
  DefaultRedactor,
  type ProcessResult,
  type RunnerCapabilities,
  type RunnerPort,
} from "@vioxen/subscription-runtime/core";
import { describe, expect, it } from "vitest";
import {
  ClaudeAgentSdkTaskExecutionEngine,
  type ClaudeTaskEngineInput,
} from "../index";

describe("ClaudeAgentSdkTaskExecutionEngine structured results", () => {
  it("recovers a schema-valid structured result from the SDK result text", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-schema-"));
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => successResultTextQuery('{"verdict":"APPROVE"}'),
        }),
      });

      await expect(engine.run(taskInput(workspace, {
        outputSchema: {
          type: "object",
          properties: { verdict: { const: "APPROVE" } },
          required: ["verdict"],
          additionalProperties: false,
        },
      }))).resolves.toMatchObject({
        outputText: '{"verdict":"APPROVE"}',
        structuredOutput: { verdict: "APPROVE" },
        warnings: [{ code: "claude_structured_output_text_fallback" }],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("validates draft 2020-12 prefixItems in structured result text", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-schema-"));
    const outputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "array",
      prefixItems: [
        { const: "APPROVE" },
        { type: "integer" },
      ],
      items: false,
      minItems: 2,
      maxItems: 2,
    } as const;
    try {
      const validEngine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => successResultTextQuery('["APPROVE",2]'),
        }),
      });
      await expect(validEngine.run(taskInput(workspace, { outputSchema })))
        .resolves.toMatchObject({ structuredOutput: ["APPROVE", 2] });

      const invalidEngine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => successResultTextQuery('["APPROVE","2"]'),
        }),
      });
      await expect(invalidEngine.run(taskInput(workspace, { outputSchema })))
        .rejects.toMatchObject({
          failure: {
            code: "provider_output_invalid",
            details: { sdkErrors: "fallback_schema_mismatch" },
          },
        });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("validates draft 2020-12 union types in structured result text", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-schema-"));
    const outputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: ["string", "null"],
    } as const;
    try {
      const stringEngine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => successResultTextQuery('"APPROVE"'),
        }),
      });
      await expect(stringEngine.run(taskInput(workspace, { outputSchema })))
        .resolves.toMatchObject({ structuredOutput: "APPROVE" });

      const nullEngine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({ query: () => successResultTextQuery("null") }),
      });
      await expect(nullEngine.run(taskInput(workspace, { outputSchema })))
        .resolves.toMatchObject({ structuredOutput: null });

      const numberEngine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({ query: () => successResultTextQuery("42") }),
      });
      await expect(numberEngine.run(taskInput(workspace, { outputSchema })))
        .rejects.toMatchObject({
          failure: {
            code: "provider_output_invalid",
            details: { sdkErrors: "fallback_schema_mismatch" },
          },
        });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts schema annotations without bypassing canonical constraints", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-schema-"));
    const outputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $comment: "provider-facing annotation",
      examples: [{ verdict: "APPROVE" }],
      "x-provider-annotation": { owner: "hib" },
      type: "object",
      properties: { verdict: { const: "APPROVE" } },
      required: ["verdict"],
      additionalProperties: false,
    } as const;
    try {
      const validEngine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => successResultTextQuery('{"verdict":"APPROVE"}'),
        }),
      });
      await expect(validEngine.run(taskInput(workspace, { outputSchema })))
        .resolves.toMatchObject({
          structuredOutput: { verdict: "APPROVE" },
          warnings: [{ code: "claude_structured_output_text_fallback" }],
        });

      const mismatchEngine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => successResultTextQuery('{"verdict":"NEEDS_WORK"}'),
        }),
      });
      await expect(mismatchEngine.run(taskInput(workspace, { outputSchema })))
        .rejects.toMatchObject({
          failure: {
            code: "provider_output_invalid",
            details: { sdkErrors: "fallback_schema_mismatch" },
          },
        });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    ["empty", "", "fallback_empty"],
    ["non-JSON", "completed", "fallback_non_json"],
    ["schema mismatch", '{"verdict":"NEEDS_WORK"}', "fallback_schema_mismatch"],
    ["additional property", '{"verdict":"APPROVE","__proto__":{}}', "fallback_schema_mismatch"],
  ])("fails closed for %s SDK result text without structured output", async (
    _case,
    resultText,
    expectedReason,
  ) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-schema-"));
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({ query: () => successResultTextQuery(resultText) }),
      });

      await expect(engine.run(taskInput(workspace, {
        outputSchema: {
          type: "object",
          properties: { verdict: { const: "APPROVE" } },
          required: ["verdict"],
          additionalProperties: false,
        },
      }))).rejects.toMatchObject({
        name: "ClaudeProviderFailureError",
        failure: {
          code: "provider_output_invalid",
          causeCategory: "success_without_structured_output",
          details: {
            sdkSubtype: "success",
            sdkErrors: expectedReason,
            permissionDenials: "0",
            hostPolicyDenials: "none",
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed when fallback schema formats have no validator", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-schema-"));
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => successResultTextQuery('"not-an-email"'),
        }),
      });

      await expect(engine.run(taskInput(workspace, {
        outputSchema: { type: "string", format: "email" },
      }))).rejects.toMatchObject({
        name: "ClaudeProviderFailureError",
        failure: {
          code: "provider_output_invalid",
          details: { sdkErrors: "fallback_schema_compile" },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    ["quota text", "You've hit your usage limit", "quota_limited", false],
    ["OAuth text", "OAuth token expired", "needs_reconnect", true],
  ])("classifies success plus is_error %s before structured output", async (
    _case,
    resultText,
    expectedCode,
    reconnectRequired,
  ) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-api-error-"));
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => sdkMessageQuery({
            ...sdkSuccessMessage({ verdict: "APPROVE" }),
            is_error: true,
            result: resultText,
          }),
        }),
      });

      await expect(engine.run(taskInput(workspace, {
        outputSchema: { type: "object" },
      }))).rejects.toMatchObject({
        name: "ClaudeProviderFailureError",
        failure: {
          code: expectedCode,
          reconnectRequired,
          details: {
            sdkSubtype: "success",
            sdkErrors: "success_is_error",
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("redacts unknown success plus is_error output from the serialized failure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-api-error-"));
    const redactor = new DefaultRedactor();
    const sentinel = "hib-sensitive-sentinel-value";
    redactor.registerSecret(sentinel, "synthetic");
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => sdkMessageQuery({
            ...sdkSuccessMessage(),
            is_error: true,
            result: `unclassified provider failure ${sentinel}`,
          }),
        }),
      });

      const failure = await engine.run(taskInput(workspace, { redactor }))
        .then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({
        name: "ClaudeProviderFailureError",
        failure: {
          code: "unknown_runtime_failure",
          causeCategory: "sdk_success_is_error",
          details: { sdkErrors: "success_is_error" },
        },
      });
      expect(JSON.stringify(failure)).not.toContain(sentinel);
      expect(JSON.stringify(failure)).not.toContain("unclassified provider failure");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("bounds success diagnostics to fixed fields and redacted denied tool names", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-api-error-"));
    const redactor = new DefaultRedactor();
    const sentinel = "hib-denied-tool-sensitive-sentinel";
    redactor.registerSecret(sentinel, "synthetic");
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: ({ options }: { options: Options }) =>
            successErrorAfterPolicyDenialQuery(options, {
              ...sdkSuccessMessage(),
              is_error: true,
              result: "temporary service failure",
              permission_denials: [
                { tool_name: `Read-${sentinel}`, tool_use_id: "tool-1", tool_input: {} },
                { tool_name: `Read-${sentinel}`, tool_use_id: "tool-2", tool_input: {} },
              ],
            }),
        }),
      });

      const failure = await engine.run(taskInput(workspace, {
        redactor,
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
        editMode: AgentRuntimeEditMode.ReadOnly,
      })).then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({
        failure: {
          details: {
            sdkSubtype: "success",
            sdkErrors: "success_is_error",
            permissionDenials: "2",
            hostPolicyDenials: "outside_policy",
            deniedTools: "Read-[redacted:synthetic]",
          },
        },
      });
      expect(JSON.stringify(failure)).not.toContain(sentinel);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("normalizes and bounds non-success policy diagnostics without leaking secrets or IDs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-error-"));
    const redactor = new DefaultRedactor();
    const toolSentinel = "hib-error-denied-tool-secret";
    const auditSentinel = "hib-error-policy-audit-secret";
    const errorSentinel = "hib-error-message-secret";
    const rawToolUseId = "raw-tool-use-id-must-not-leak";
    redactor.registerSecret(toolSentinel, "synthetic-tool");
    redactor.registerSecret(auditSentinel, "synthetic-audit");
    redactor.registerSecret(errorSentinel, "synthetic-error");
    const deniedTool = `${toolSentinel}-${"x".repeat(1_200)},malicious:audit`;
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: ({ options }: { options: Options }) =>
            errorAfterPolicyDenialQuery(
              options,
              `Audit-${auditSentinel},forged:invalid_path`,
              rawToolUseId,
              {
                ...sdkExecutionErrorMessage(),
                errors: [`provider failure ${errorSentinel}`],
                permission_denials: [{
                  tool_name: deniedTool,
                  tool_use_id: rawToolUseId,
                  tool_input: { untrusted: toolSentinel },
                }],
                uuid: `result-${errorSentinel}`,
                session_id: `session-${errorSentinel}`,
              } as Exclude<SDKResultMessage, { readonly subtype: "success" }>,
            ),
        }),
      });

      const failure = await engine.run(taskInput(workspace, {
        redactor,
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
        editMode: AgentRuntimeEditMode.ReadOnly,
      })).then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({
        failure: {
          causeCategory: "error_during_execution",
          details: {
            permissionDenials: "1",
            hostPolicyDenials: "outside_policy",
            sdkErrors: "provider failure [redacted:synthetic-error]",
          },
        },
      });
      const details = providerFailureDetails(failure);
      expect(details.deniedTools).toHaveLength(1_000);
      expect(details.deniedTools).toMatch(/^\[redacted:synthetic-tool\]-x+$/);
      const serialized = JSON.stringify(failure);
      expect(serialized).not.toContain(toolSentinel);
      expect(serialized).not.toContain(auditSentinel);
      expect(serialized).not.toContain(errorSentinel);
      expect(serialized).not.toContain(rawToolUseId);
      expect(serialized).not.toContain("forged:invalid_path");
      expect(serialized).not.toContain("tool_input");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("surfaces only the latest safe observed diagnostics beside terminal status", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-diagnostics-"));
    const redactor = new DefaultRedactor();
    const sentinel = "hib-provider-sensitive-sentinel";
    redactor.registerSecret(sentinel, "synthetic");
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => sdkSequenceQuery(
            sdkApiRetryMessage("authentication_failed", 401),
            sdkApiRetryMessage("overloaded", 529),
            sdkAssistantErrorMessage("billing_error", sentinel),
            sdkRateLimitMessage({
              status: "allowed_warning",
              rateLimitType: "five_hour",
              overageStatus: "allowed",
              overageDisabledReason: "overage_not_provisioned",
            }),
            sdkRateLimitMessage({
              status: "rejected",
              rateLimitType: "overage",
              overageStatus: "rejected",
              errorCode: "credits_required",
              utilization: sentinel,
              canUserPurchaseCredits: sentinel,
            }),
            {
              ...sdkSuccessMessage(),
              is_error: true,
              result: `unclassified provider failure ${sentinel}`,
              api_error_status: 429,
              terminal_reason: "api_error",
            } as SDKResultMessage,
          ),
        }),
      });

      const failure = await engine.run(taskInput(workspace, { redactor }))
        .then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({
        failure: {
          code: "unknown_runtime_failure",
          details: {
            sdkSubtype: "success",
            sdkErrors: "success_is_error",
            permissionDenials: "0",
            hostPolicyDenials: "none",
            apiRetryCount: "2",
            apiErrorHttpStatus: "http_429",
            terminalReason: "api_error",
            lastObservedApiRetryError: "overloaded",
            lastObservedApiRetryHttpStatus: "http_529",
            lastObservedAssistantError: "billing_error",
            lastObservedRateLimitStatus: "rejected",
            lastObservedRateLimitType: "overage",
            lastObservedOverageStatus: "rejected",
            lastObservedRateLimitReason: "credits_required",
          },
        },
      });
      expect(JSON.stringify(failure)).not.toContain(sentinel);
      expect(JSON.stringify(failure)).not.toContain("utilization");
      expect(JSON.stringify(failure)).not.toContain("canUserPurchaseCredits");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    [401, "http_401"],
    [429, "http_429"],
    [529, "http_529"],
    [null, "no_http_response"],
    [undefined, "absent"],
    [99, "invalid_http_status"],
    [600, "invalid_http_status"],
    ["401", "invalid_http_status"],
  ])("normalizes terminal API status %s", async (status, expected) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-status-"));
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => sdkMessageQuery({
            ...sdkSuccessMessage(),
            is_error: true,
            result: "temporary service failure",
            api_error_status: status,
          } as unknown as SDKResultMessage),
        }),
      });

      await expect(engine.run(taskInput(workspace, {}))).rejects.toMatchObject({
        failure: {
          details: {
            apiRetryCount: "0",
            apiErrorHttpStatus: expected,
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("maps malicious enum casts to unknown without retaining extra content", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-enums-"));
    const sentinel = "hib-malicious-enum-sentinel";
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => sdkSequenceQuery(
            sdkApiRetryMessage(sentinel, undefined),
            sdkAssistantErrorMessage(sentinel, sentinel),
            sdkRateLimitMessage({
              status: sentinel,
              rateLimitType: sentinel,
              overageStatus: sentinel,
              overageDisabledReason: sentinel,
              reason: sentinel,
              content: sentinel,
              resetsAt: sentinel,
              overageResetsAt: sentinel,
              utilization: sentinel,
              isUsingOverage: sentinel,
              overageInUse: sentinel,
              canUserPurchaseCredits: sentinel,
              hasChargeableSavedPaymentMethod: sentinel,
            }),
            {
              ...sdkSuccessMessage(),
              is_error: true,
              result: "temporary service failure",
              api_error_status: { sentinel },
              terminal_reason: sentinel,
              provider_payload: sentinel,
              user_message_uuid: sentinel,
              request_sent_wall_ms: sentinel,
              uuid: sentinel,
              session_id: sentinel,
            } as unknown as SDKResultMessage,
          ),
        }),
      });

      const failure = await engine.run(taskInput(workspace, {}))
        .then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({
        failure: {
          details: {
            apiRetryCount: "1",
            apiErrorHttpStatus: "invalid_http_status",
            terminalReason: "unknown",
            lastObservedApiRetryError: "unknown",
            lastObservedApiRetryHttpStatus: "absent",
            lastObservedAssistantError: "unknown",
            lastObservedRateLimitStatus: "unknown",
            lastObservedRateLimitType: "unknown",
            lastObservedOverageStatus: "unknown",
            lastObservedRateLimitReason: "unknown",
          },
        },
      });
      expect(JSON.stringify(failure)).not.toContain(sentinel);
      const details = providerFailureDetails(failure);
      expect(Object.keys(details)).not.toContain("reason");
      expect(Object.keys(details)).not.toContain("content");
      expect(Object.keys(details)).not.toContain("provider_payload");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("saturates retry count and does not attach observations to non-success failures", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-retries-"));
    try {
      const retries = Array.from(
        { length: 1_005 },
        () => sdkApiRetryMessage("server_error", null),
      );
      const successEngine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => sdkSequenceQuery(...retries, {
            ...sdkSuccessMessage(),
            is_error: true,
            result: "temporary service failure",
          }),
        }),
      });
      await expect(successEngine.run(taskInput(workspace, {}))).rejects
        .toMatchObject({ failure: { details: { apiRetryCount: "999" } } });

      const earlyFailureEngine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => sdkSequenceQuery(
            sdkApiRetryMessage("server_error", 529),
            sdkExecutionErrorMessage(),
          ),
        }),
      });
      const failure = await earlyFailureEngine.run(taskInput(workspace, {}))
        .then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({
        failure: { causeCategory: "error_during_execution" },
      });
      const details = providerFailureDetails(failure);
      expect(details).not.toHaveProperty("apiRetryCount");
      expect(details).not.toHaveProperty(
        "lastObservedApiRetryError",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("transports the exact structured-output policy through the real SDK wrapper", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-transport-"));
    const receiptPath = join(workspace, "argv.json");
    const fakeClaudePath = join(workspace, "fake-claude.cjs");
    const schema = {
      type: "object",
      properties: {
        verdict: { enum: ["APPROVE", "NEEDS_WORK"] },
        findings: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { severity: { const: "HIGH" } },
            required: ["severity"],
            additionalProperties: false,
          },
        },
      },
      required: ["verdict"],
      additionalProperties: false,
    } as const;
    try {
      await writeFile(
        fakeClaudePath,
        `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(23);\n`,
        { mode: 0o700 },
      );
      await chmod(fakeClaudePath, 0o700);
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        binaryPath: fakeClaudePath,
      });

      await expect(engine.run(taskInput(workspace, {
        model: "claude-opus-4-8",
        outputSchema: schema,
        workspaceInstructionPolicy: "deny_project_instructions_v1",
        allowedTools: ["Read", "Grep", "Glob"],
        editMode: AgentRuntimeEditMode.ReadOnly,
      }))).rejects.toBeDefined();

      const argv = JSON.parse(await readFile(receiptPath, "utf8")) as string[];
      expect(optionValue(argv, "--model")).toBe("claude-opus-4-8");
      expect(JSON.parse(optionValue(argv, "--json-schema"))).toEqual(schema);
      expect(optionValue(argv, "--tools")).toBe("Read,Grep,Glob,StructuredOutput");
      expect(optionValue(argv, "--allowedTools"))
        .toBe("Read,Grep,Glob,StructuredOutput");
      expect(argv).toContain("--safe-mode");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function taskInput(
  workspacePath: string,
  overrides: Partial<ClaudeTaskEngineInput>,
): ClaudeTaskEngineInput {
  return {
    abortSignal: new AbortController().signal,
    model: "claude-test",
    execution: { mode: AgentRuntimeExecutionMode.SingleRun },
    prompt: "Fix the test fixture.",
    redactor: new DefaultRedactor(),
    runner: new StaticRunner(),
    session: {
      authMode: "oauth",
      configDir: join(workspacePath, ".claude"),
      oauthToken: "oauth-secret",
    },
    workspacePath,
    ...overrides,
  };
}

function successResultTextQuery(result: string): Query {
  return sdkMessageQuery({ ...sdkSuccessMessage(), result });
}

function sdkMessageQuery(message: SDKResultMessage): Query {
  const stream = (async function* () {
    yield message;
  })();
  return Object.assign(stream, { close() {} }) as Query;
}

function sdkSequenceQuery(...messages: readonly SDKMessage[]): Query {
  const stream = (async function* () {
    for (const message of messages) yield message;
  })();
  return Object.assign(stream, { close() {} }) as Query;
}

function sdkApiRetryMessage(error: unknown, errorStatus: unknown): SDKMessage {
  return {
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 3,
    retry_delay_ms: 1,
    error_status: errorStatus,
    error,
    uuid: String(error),
    session_id: String(error),
  } as unknown as SDKMessage;
}

function sdkAssistantErrorMessage(error: unknown, content: string): SDKMessage {
  return {
    type: "assistant",
    error,
    message: {
      id: content,
      content: [{ type: "text", text: content }],
      model: content,
      role: "assistant",
      stop_reason: null,
      stop_sequence: null,
      type: "message",
      usage: {},
    },
    parent_tool_use_id: null,
    request_id: content,
    uuid: content,
    session_id: content,
  } as unknown as SDKMessage;
}

function sdkRateLimitMessage(
  rateLimitInfo: Readonly<Record<string, unknown>>,
): SDKMessage {
  const untrustedMetadata = typeof rateLimitInfo.content === "string"
    ? rateLimitInfo.content
    : "rate-1";
  return {
    type: "rate_limit_event",
    rate_limit_info: rateLimitInfo,
    uuid: untrustedMetadata,
    session_id: untrustedMetadata,
  } as unknown as SDKMessage;
}

function sdkExecutionErrorMessage(): SDKResultMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    errors: [],
    uuid: "result-error-1",
    session_id: "session-1",
  } as unknown as SDKResultMessage;
}

function providerFailureDetails(error: unknown): Readonly<Record<string, string>> {
  return (error as {
    readonly failure: {
      readonly details: Readonly<Record<string, string>>;
    };
  }).failure.details;
}

function successErrorAfterPolicyDenialQuery(
  options: Options,
  message: Extract<SDKResultMessage, { readonly subtype: "success" }>,
): Query {
  const stream = (async function* () {
    await options.hooks?.PreToolUse?.[0]?.hooks[0]?.({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {},
      tool_use_id: "tool-denied",
      cwd: options.cwd ?? "/workspace",
      session_id: "session-1",
      transcript_path: "",
      permission_mode: options.permissionMode ?? "default",
    }, "tool-denied", { signal: new AbortController().signal });
    yield message;
  })();
  return Object.assign(stream, { close() {} }) as Query;
}

function errorAfterPolicyDenialQuery(
  options: Options,
  toolName: string,
  toolUseId: string,
  message: Exclude<SDKResultMessage, { readonly subtype: "success" }>,
): Query {
  const stream = (async function* () {
    await options.hooks?.PreToolUse?.[0]?.hooks[0]?.({
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: {},
      tool_use_id: toolUseId,
      cwd: options.cwd ?? "/workspace",
      session_id: "session-1",
      transcript_path: "",
      permission_mode: options.permissionMode ?? "default",
    }, toolUseId, { signal: new AbortController().signal });
    yield message;
  })();
  return Object.assign(stream, { close() {} }) as Query;
}

function optionValue(argv: readonly string[], option: string): string {
  const index = argv.indexOf(option);
  if (index < 0 || index + 1 >= argv.length) {
    throw new Error(`missing ${option} in SDK transport argv`);
  }
  return argv[index + 1]!;
}

function sdkSuccessMessage(
  structuredOutput?: unknown,
): Extract<SDKResultMessage, { readonly subtype: "success" }> {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 2,
    result: "completed",
    stop_reason: "end_turn",
    session_id: "session-1",
    total_cost_usd: 0.1,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    ...(structuredOutput === undefined ? {} : { structured_output: structuredOutput }),
    uuid: "result-1",
  } as unknown as Extract<SDKResultMessage, { readonly subtype: "success" }>;
}

const runnerCapabilities: RunnerCapabilities = {
  runnerId: "unused-test-runner",
  supportsEnvAllowlist: true,
  supportsWorkingDirectory: true,
  supportsTimeout: true,
  supportsAbortSignal: true,
  supportsOutputRedaction: true,
  supportsReadOnlySandbox: true,
  readOnlyFilesystem: false,
  platform: "node-process",
};

class StaticRunner implements RunnerPort {
  readonly runnerId = runnerCapabilities.runnerId;
  readonly capabilities = runnerCapabilities;

  async run(): Promise<ProcessResult> {
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
  }
}
