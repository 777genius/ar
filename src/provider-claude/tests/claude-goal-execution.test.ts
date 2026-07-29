import type {
  Options,
  Query,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  AgentRuntimeBudgetMetric,
  AgentRuntimeEditMode,
  AgentRuntimeExecutionMode,
  AgentRuntimeProviderSandboxMode,
  DefaultRedactor,
  type ProcessResult,
  type RunnerCapabilities,
  type RunnerPort,
} from "@vioxen/subscription-runtime/core";
import { describe, expect, it } from "vitest";
import {
  ClaudeAgentSdkTaskExecutionEngine,
  ClaudeTaskAgentDriver,
  sessionArtifactFromClaudeOAuth,
} from "../index";
import {
  createClaudeAgentSdkGoalProtocol,
} from "../process/claude-agent-sdk-goal-protocol";

describe("Claude Goal execution", () => {
  it("maps Goal to one native Agent SDK loop with hard bounds", async () => {
    let captured: Options | undefined;
    let capturedPrompt: string | AsyncIterable<unknown> | undefined;
    const engine = new ClaudeAgentSdkTaskExecutionEngine({
      sdkLoader: async () => ({
        query: ({ prompt, options }: { prompt: string | AsyncIterable<unknown>; options: Options }) => {
          capturedPrompt = prompt;
          captured = options;
          return successfulQuery(options);
        },
      }),
    });
    const driver = new ClaudeTaskAgentDriver({
      appendSystemPrompt: "default system",
      engine,
    });

    const result = await driver.runTask({
      session: sessionArtifactFromClaudeOAuth({
        oauthToken: "claude-oauth-secret",
        configDir: "/tmp/claude-goal-config",
        refreshedAt: "2026-07-17T00:00:00.000Z",
      }),
      task: {
        kind: "structured-prompt",
        prompt: "correct the fixture",
        execution: {
          mode: AgentRuntimeExecutionMode.Goal,
          completionCondition: "value.txt contains exactly 42 followed by one newline",
        },
        controls: {
          maxTurns: 8,
          allowedTools: ["Read", "Edit"],
          editMode: AgentRuntimeEditMode.AllowEdits,
          providerSandboxMode: AgentRuntimeProviderSandboxMode.WorkspaceWrite,
          budget: {
            metric: AgentRuntimeBudgetMetric.Usd,
            limit: 1,
          },
        },
      },
      workspace: { path: "/tmp/claude-goal-workspace" },
      runner: new StaticRunner(),
      redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: "completed" });
    expect(driver.capabilities.taskExecutionCapabilities).toContainEqual({
      mode: AgentRuntimeExecutionMode.Goal,
      maxCompletionConditionChars: 4_000,
    });
    expect(captured).toMatchObject({
      maxTurns: 8,
      maxBudgetUsd: 1,
      persistSession: false,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
      },
    });
    expect(capturedPrompt).toBe(
      "correct the fixture\n\nGoal completion condition:\n\n" +
        "value.txt contains exactly 42 followed by one newline",
    );
    expect(captured?.systemPrompt).toMatchObject({
      append: expect.stringContaining("Agent Runtime execution mode: Goal."),
    });
    expect(captured?.systemPrompt).toMatchObject({
      append: expect.stringContaining("Do not stop after only describing a plan."),
    });
  });

  it("blocks a normal stop until the completion report tool is called", async () => {
    const protocol = createClaudeAgentSdkGoalProtocol({
      completionCondition: "value.txt contains exactly 42",
    });
    const hookInput = {
      hook_event_name: "Stop" as const,
      stop_hook_active: false,
    };

    await expect(
      protocol.stopHook(
        hookInput as Parameters<typeof protocol.stopHook>[0],
        undefined,
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ decision: "block" });

    await reportGoalCompletion({
      mcpServers: protocol.mcpServers,
    } as Options);

    await expect(
      protocol.stopHook(
        hookInput as Parameters<typeof protocol.stopHook>[0],
        undefined,
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ continue: true });
  });
});

function successfulQuery(options: Options): Query {
  const stream = (async function* () {
    await reportGoalCompletion(options);
    yield {
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
      uuid: "result-1",
    } as unknown as SDKResultMessage;
  })();
  return Object.assign(stream, { close() {} }) as Query;
}

async function reportGoalCompletion(options: Options): Promise<void> {
  const server = options.mcpServers?.agent_runtime_goal as unknown as {
    readonly instance: {
      readonly _registeredTools: Readonly<Record<string, {
        readonly handler: (
          input: { readonly evidence: string },
          extra: unknown,
        ) => Promise<unknown>;
      }>>;
    };
  } | undefined;
  const handler = server?.instance._registeredTools.report_completion?.handler;
  if (!handler) throw new Error("goal completion tool missing");
  await handler({ evidence: "value.txt was inspected after the edit" }, {});
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
