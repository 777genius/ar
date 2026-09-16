import { sdkClaudeTelemetry } from "../process/claude-agent-sdk-telemetry";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentRuntimeTurnLimitEnforcement, DefaultRedactor, type RunnerPort } from "@vioxen/subscription-runtime/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeTaskAgentDriver, sessionArtifactFromClaudeOAuth, type ClaudeTaskExecutionEngine } from "../index";
import { resultFromSdkMessage } from "../process/claude-agent-sdk-result";
import { createClaudeAgentSdkSafeDiagnostics } from "../process/claude-agent-sdk-safe-diagnostics";
import { claudeTelemetryFromError, ClaudeTaskTelemetryError } from "../protocol/task-telemetry";
import { classifyClaudeFailure } from "../protocol/failure-classifier";

const numeric = { durationMs: 30, turns: 2, cost: { amount: 1.25, currency: "USD" }, usage: { inputTokens: 150, outputTokens: 20, totalTokens: 170, cachedInputTokens: 40, cacheWriteInputTokens: 10 } };
function message(overrides: Record<string, unknown> = {}): SDKResultMessage {
  return { type: "result", subtype: "success", is_error: false, result: "done", duration_ms: 30, num_turns: 2, total_cost_usd: 1.25, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 }, permission_denials: [], session_id: "private-session", ...overrides } as unknown as SDKResultMessage;
}
let workspace: string;
beforeAll(async () => { workspace = await mkdtemp(join(tmpdir(), "claude-telemetry-test-")); });
afterAll(async () => { await rm(workspace, { recursive: true, force: true }); });
function input() {
  return { session: sessionArtifactFromClaudeOAuth({ oauthToken: "fake-secret", configDir: workspace }), task: { kind: "structured-prompt" as const, prompt: "fake" }, workspace: { path: workspace }, runner: {} as RunnerPort, redactor: new DefaultRedactor(), abortSignal: new AbortController().signal };
}
function driver(sdkMessage: SDKResultMessage, stream = false): ClaudeTaskAgentDriver {
  const engine: ClaudeTaskExecutionEngine = {
    kind: "fake", capabilities: { supportsStreaming: stream, supportsToolCalls: false, supportsUsage: true, supportsProviderRunId: false, supportsCleanup: false, turnLimitEnforcement: AgentRuntimeTurnLimitEnforcement.ProviderNative },
    async run(input) { return resultFromSdkMessage(sdkMessage, input, new Set(), createClaudeAgentSdkSafeDiagnostics()); },
    ...(stream ? { async *stream(input: Parameters<ClaudeTaskExecutionEngine["run"]>[0]) { const result = await this.run(input); yield { type: "completed" as const, occurredAt: new Date(), result: { status: "completed" as const, ...result } }; } } : {}),
  };
  return new ClaudeTaskAgentDriver({ engine, outputSchemas: { object: { type: "object" } } });
}

describe("Claude SDK task telemetry", () => {
  it("normalizes inclusive input totals without counting cache twice", async () => {
    const result = await driver(message()).runTask(input());
    expect(result.telemetry).toMatchObject(numeric);
    expect(result.status).toBe("completed");
  });
  it.each(["error_max_turns", "error_max_budget_usd", "error_during_execution", "error_max_structured_output_retries"])("preserves %s measurements and safe failure classification", async (subtype) => {
    const result = await driver(message({ subtype, errors: ["fake failure"] })).runTask(input());
    expect(result).toMatchObject({ status: "failed", failure: { causeCategory: subtype }, telemetry: { ...numeric, finishReason: "provider_error" } });
    expect(result.telemetry).not.toHaveProperty("providerSessionId");
  });
  it("preserves success is_error usage", async () => {
    const result = await driver(message({ is_error: true })).runTask(input());
    expect(result).toMatchObject({ status: "failed", telemetry: numeric });
  });
  it("preserves structured output validation failure usage", async () => {
    const result = await driver(message()).runTask({ ...input(), task: { kind: "structured-prompt", prompt: "fake", outputSchemaName: "object" } });
    expect(result).toMatchObject({ status: "failed", telemetry: numeric });
  });
  it("preserves SDK result sanitizer failure usage", async () => {
    const redactor = new DefaultRedactor();
    const original = redactor.assertNoKnownSecret.bind(redactor);
    redactor.assertNoKnownSecret = (value, context) => {
      if (context === "claude-agent-sdk-result") throw new Error("provider output invalid");
      original(value, context);
    };
    const result = await driver(message()).runTask({ ...input(), redactor });
    expect(result).toMatchObject({ status: "failed", telemetry: numeric });
  });
  it("preserves logical checkpoint callback failure usage without its checkpoint", async () => {
    const result = await driver(message()).runTask({ ...input(), logicalThread: { threadId: "fake-thread", onCheckpoint() { throw new Error("fake callback failure"); } } });
    expect(result).toMatchObject({ status: "failed", telemetry: numeric });
    expect(result.telemetry).not.toHaveProperty("providerSessionId");
  });
  it("preserves SDK failures in streaming execution", async () => {
    const events = [];
    for await (const event of driver(message({ subtype: "error_max_turns", errors: [] }), true).streamTask(input())) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "completed", result: { status: "failed", telemetry: numeric } });
  });
  it("prefers whole-query model totals exactly once over overlapping main-loop usage", () => {
    const telemetry = sdkClaudeTelemetry(message({ modelUsage: {
      one: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 40, cacheCreationInputTokens: 10, costUSD: 99 },
      two: { inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 20, cacheCreationInputTokens: 0, costUSD: 99 },
    } }));
    expect(telemetry).toEqual({ ...numeric, usage: { inputTokens: 220, outputTokens: 25, totalTokens: 245, cachedInputTokens: 60, cacheWriteInputTokens: 10 } });
  });
  it.each([undefined, {}, null, [], { bad: null }, { bad: { inputTokens: 2 } }, { bad: { inputTokens: Infinity, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }])("falls back for absent, empty or malformed model maps %j", (modelUsage) => {
    expect(sdkClaudeTelemetry(message({ modelUsage }))).toEqual(numeric);
  });
  it("does not invent absent or invalid fields", () => {
    expect(sdkClaudeTelemetry(message({ duration_ms: -1, total_cost_usd: Infinity, num_turns: NaN, usage: {} }))).toEqual({});
    expect(sdkClaudeTelemetry(message({ usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: -1, cache_creation_input_tokens: NaN } })).usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    expect(sdkClaudeTelemetry(message({ usage: { cache_read_input_tokens: 40 } })).usage).toEqual({ cachedInputTokens: 40 });
  });
  it("preserves usage across causes and terminates cause cycles", () => {
    const error = new ClaudeTaskTelemetryError(new Error("fake"), sdkClaudeTelemetry(message()));
    expect(claudeTelemetryFromError(new Error("outer", { cause: error }))).toEqual(numeric);
    const cycle = new Error("cycle"); cycle.cause = cycle;
    expect(claudeTelemetryFromError(cycle)).toBeUndefined();
    error.cause = error;
    expect(classifyClaudeFailure(error).code).toBe("unknown_runtime_failure");
  });
});
