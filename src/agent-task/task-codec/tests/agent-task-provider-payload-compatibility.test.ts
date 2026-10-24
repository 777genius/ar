import { describe, expect, it } from "vitest";
import {
  parseAgentTaskResult,
  providerTaskResultToAgentTaskResult,
  agentTaskResultToProviderTaskResult,
  parseAgentTaskEvent,
} from "../../codec";

describe("agent-task provider payload compatibility", () => {
  const protocolVersion = 1;
  const completed = (telemetry?: unknown) => ({
    protocolVersion,
    status: "completed",
    outputText: "done",
    warnings: [],

    ...(telemetry === undefined ? {} : { telemetry }),
  });

  it("round-trips provider payloads without expanding the persisted contract", () => {
    const telemetry = {
      providerRunId: "run-1",
      providerSessionId: "session-1",
      durationMs: 0,
      turns: 1,
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        cachedInputTokens: 3,
        cacheWriteInputTokens: 2,
        reasoningOutputTokens: 1,
      },
      cost: { amount: 0, currency: "USD" },
      toolCalls: [
        {
          id: "tool-1",
          name: "read_file",
          status: "completed",
          safeInput: { path: "README.md", nested: { missing: undefined } },
          safeInputPreview: "README.md",
          safeOutputPreview: "contents",
          ignored: "legacy extra field",
        },
      ],
      nativeWeb: { turns: [], truncated: false },
      finishReason: "completed",
      ignored: "legacy extra field",
    } as const;
    const { ignored: _ignored, ...knownTelemetry } = telemetry;
    const expected = {
      ...knownTelemetry,
      toolCalls: [{
        id: "tool-1",
        name: "read_file",
        status: "completed" as const,
        safeInput: { path: "README.md", nested: {} },
        safeInputPreview: "README.md",
        safeOutputPreview: "contents",
      }],
    };

    const parsed = parseAgentTaskResult(completed(telemetry));
    expect(parsed.telemetry).toEqual(expected);
    expect(parseAgentTaskResult(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(agentTaskResultToProviderTaskResult(parsed).telemetry).toEqual(expected);
    const converted = providerTaskResultToAgentTaskResult({
      status: "completed",
      outputText: "done",
      warnings: [],
      telemetry: expected,
    });
    expect(converted.telemetry).toEqual(expected);
  });

  it("distinguishes absent optionals from explicit empty payloads", () => {
    expect(parseAgentTaskResult(completed())).not.toHaveProperty("telemetry");
    expect(parseAgentTaskResult(completed({
      providerRunId: undefined,
      usage: { inputTokens: undefined },
      toolCalls: [],
    })).telemetry).toEqual({ usage: {}, toolCalls: [] });
    expect(parseAgentTaskResult(completed({ toolCalls: [{ name: "" }] }))
      .telemetry?.toolCalls).toEqual([{ name: "" }]);
  });

  it.each([
    ["null telemetry", null, "request", "result.telemetry must be an object"],
    ["null usage", { usage: null }, "request", "result.telemetry.usage must be an object"],
    ["zero usage", { usage: { inputTokens: 0 } }, "request", "result.telemetry.usage.inputTokens must be a positive integer"],
    ["fractional usage", { usage: { outputTokens: 1.5 } }, "request", "result.telemetry.usage.outputTokens must be a positive integer"],
    ["infinite usage", { usage: { totalTokens: Infinity } }, "request", "result.telemetry.usage.totalTokens must be a positive integer"],
    ["zero turns", { turns: 0 }, "request", "result.telemetry.turns must be a positive integer"],
    ["negative duration", { durationMs: -1 }, "result", "result.telemetry.durationMs must be a non-negative finite number"],
    ["infinite duration", { durationMs: Infinity }, "result", "result.telemetry.durationMs must be a non-negative finite number"],
    ["negative cost", { cost: { amount: -1, currency: "USD" } }, "result", "result.telemetry.cost.amount must be a non-negative finite number"],
    ["NaN cost", { cost: { amount: NaN, currency: "USD" } }, "result", "result.telemetry.cost.amount must be a non-negative finite number"],
    ["unsupported currency", { cost: { amount: 1, currency: "EUR" } }, "result", "result.telemetry.cost.currency must be USD"],
    ["null provider id", { providerRunId: null }, "request", "result.telemetry.providerRunId must be a string"],
    ["non-array tools", { toolCalls: {} }, "result", "result.telemetry.toolCalls must be an array"],
    ["null tool", { toolCalls: [null] }, "request", "result.telemetry.toolCalls[0] must be an object"],
    ["unknown tool status", { toolCalls: [{ name: "read", status: "unknown" }] }, "result", "result.telemetry.toolCalls[0].status is unsupported"],
    ["non-string tool status", { toolCalls: [{ name: "read", status: 1 }] }, "request", "result.telemetry.toolCalls[0].status must be a string"],
    ["array safe input", { toolCalls: [{ name: "read", safeInput: [] }] }, "json", "result.telemetry.toolCalls[0].safeInput must be a JSON object"],
    ["nonfinite safe input", { toolCalls: [{ name: "read", safeInput: { count: NaN } }] }, "json", "result.telemetry.toolCalls[0].safeInput.count must be a finite JSON number"],
    ["unknown finish reason", { finishReason: "unknown" }, "result", "result.telemetry.finishReason is unsupported"],
    ["malformed native web", { nativeWeb: {} }, "result", "result.telemetry.nativeWeb must contain finite validated transport observations"],
  ])("preserves error identity and path for %s", (_label, telemetry, category, message) => {
    expect(() => parseAgentTaskResult(completed(telemetry))).toThrowError(
      expect.objectContaining({ code: `agent_task_${category}_invalid`, message }),
    );
  });

  it("keeps event-specific paths for telemetry, usage and tool validation", () => {
    const event = {
      protocolVersion,
      occurredAt: "2026-01-01T00:00:00.000Z",
    };
    expect(() => parseAgentTaskEvent({
      ...event,
      type: "started",
      telemetry: { cost: { amount: Infinity, currency: "USD" } },
    })).toThrowError(expect.objectContaining({
      code: "agent_task_result_invalid",
      message: "event.telemetry.cost.amount must be a non-negative finite number",
    }));
    expect(() => parseAgentTaskEvent({
      ...event,
      type: "usage",
      usage: { cachedInputTokens: 0 },
    })).toThrowError(expect.objectContaining({
      code: "agent_task_request_invalid",
      message: "event.usage.cachedInputTokens must be a positive integer",
    }));
    expect(() => parseAgentTaskEvent({
      ...event,
      type: "tool_call",
      toolCall: { name: "read", safeInput: null },
    })).toThrowError(expect.objectContaining({
      code: "agent_task_json_invalid",
      message: "event.toolCall.safeInput must be a JSON object",
    }));
  });

  it("keeps the frozen legacy finish-reason allowlist", () => {
    expect(() => parseAgentTaskResult(completed({ finishReason: "budget_exceeded" })))
      .toThrowError(expect.objectContaining({
        code: "agent_task_result_invalid",
        message: "result.telemetry.finishReason is unsupported",
      }));
  });
});

describe("agent-task resume compatibility", () => {
  const protocolVersion = 1;
  const waiting = (resumeHandle: unknown) => ({
    protocolVersion,
    status: "waiting_for_input",
    runId: "run-1",
    outputText: "Need input.",
    request: { id: "input-1", kind: "decision_required", question: "Continue?", audience: "user" },
    resumeHandle,
    warnings: [],
  });

  it("preserves optional resume state while normalizing required identities", () => {
    const resumeHandle = {
      runId: "  run-1  ",
      providerId: "  provider-1  ",
      workspacePath: "  /workspace  ",
      providerInstanceId: "",
      agentId: "agent-1",
      workerId: "worker-1",
      threadId: " thread-1 ",
      providerState: { cursor: "", page: "2" },
      ignored: "legacy extra field",
    };
    const parsed = parseAgentTaskResult(waiting(resumeHandle));
    expect(parsed).toMatchObject({
      resumeHandle: {
        runId: "run-1",
        providerId: "provider-1",
        workspacePath: "/workspace",
        providerInstanceId: "",
        agentId: "agent-1",
        workerId: "worker-1",
        threadId: " thread-1 ",
        providerState: { cursor: "", page: "2" },
      },
    });
    expect(parsed).not.toHaveProperty("resumeHandle.ignored");
    expect(parseAgentTaskResult(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it.each([
    [{ runId: "", providerId: "provider", workspacePath: "/workspace" }, "result.resumeHandle.runId must be a non-empty string"],
    [{ runId: "run", providerId: "provider", workspacePath: "/workspace", providerState: { cursor: 1 } }, "result.resumeHandle.providerState.cursor must be a string"],
    [{ runId: "run", providerId: "provider", workspacePath: "/workspace", threadId: null }, "result.resumeHandle.threadId must be a string"],
  ])("keeps malformed resume-state errors local to the protocol", (resumeHandle, message) => {
    expect(() => parseAgentTaskResult(waiting(resumeHandle))).toThrowError(
      expect.objectContaining({ code: "agent_task_request_invalid", message }),
    );
  });
});
