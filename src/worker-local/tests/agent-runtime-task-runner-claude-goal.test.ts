import { describe, expect, it } from "vitest";
import type {
  AgentRuntimeTaskRequestV2,
} from "@vioxen/subscription-runtime/agent-runtime-task";
import {
  AgentRuntimeAccessBoundary,
  AgentRuntimeBudgetMetric,
  AgentRuntimeExecutionMode,
  AgentRuntimeFailureCode,
  AgentRuntimeTool,
  AgentRuntimeUnsupportedControlPolicy,
} from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeTaskProvider,
  ClaudeAgentRuntimeBackend,
  createLocalAgentRuntimeTaskRunner,
  type AgentRuntimeTaskWorkerFactory,
  type AgentRuntimeTaskWorkerJob,
} from "../agent-runtime-task-runner";

describe("local Claude Goal runner", () => {
  it("runs a hard-bounded Goal through the Agent SDK backend", async () => {
    const calls: { job?: AgentRuntimeTaskWorkerJob } = {};
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      claudeBackend: ClaudeAgentRuntimeBackend.AgentSdk,
      workerFactory: successfulFactory(calls),
    });

    const result = await runner.run(claudeGoalRequest());

    expect(result).toMatchObject({ status: "completed" });
    expect(calls.job).toMatchObject({
      execution: {
        mode: AgentRuntimeExecutionMode.Goal,
        completionCondition: "value.txt contains exactly 42 followed by one newline",
      },
      controls: {
        maxTurns: 8,
        budget: {
          metric: AgentRuntimeBudgetMetric.Usd,
          limit: 1,
        },
      },
    });
  });

  it("rejects a Goal when its hard USD budget is missing", async () => {
    let factoryCalled = false;
    const runner = rejectingRunner({
      workerFactory: () => {
        factoryCalled = true;
        throw new Error("should not construct");
      },
    });
    const result = await runner.run(claudeGoalRequestWithoutBudget());

    expect(factoryCalled).toBe(false);
    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: AgentRuntimeFailureCode.TaskRequestInvalid,
        safeMessage: "Claude Goal execution requires an explicit USD budget.",
      },
    });
  });

  it("keeps the Background backend fail-closed", async () => {
    let factoryCalled = false;
    const runner = rejectingRunner({
      claudeBackend: ClaudeAgentRuntimeBackend.Background,
      workerFactory: () => {
        factoryCalled = true;
        throw new Error("should not construct");
      },
    });

    const result = await runner.run(claudeGoalRequest());

    expect(factoryCalled).toBe(false);
    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: AgentRuntimeFailureCode.TaskModeUnsupported,
        details: {
          control: "execution",
          provider: AgentRuntimeTaskProvider.Claude,
        },
      },
    });
  });
});

function claudeGoalRequest(): AgentRuntimeTaskRequestV2 {
  return {
    protocolVersion: 2 as const,
    runId: "claude-goal",
    timeoutMs: 30_000,
    task: {
      kind: "structured-prompt" as const,
      prompt: "correct the fixture",
      execution: {
        mode: AgentRuntimeExecutionMode.Goal,
        completionCondition: "value.txt contains exactly 42 followed by one newline",
      },
      controls: {
        maxTurns: 8,
        accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
        toolPolicy: {
          allow: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.EditFile],
          onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
        },
        budget: {
          metric: AgentRuntimeBudgetMetric.Usd,
          limit: 1,
          onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
        },
      },
    },
  };
}

function claudeGoalRequestWithoutBudget(): AgentRuntimeTaskRequestV2 {
  const request = claudeGoalRequest();
  const { budget: _budget, ...controls } = request.task.controls ?? {};
  return {
    ...request,
    task: {
      ...request.task,
      controls,
    },
  };
}

function rejectingRunner(input: {
  readonly claudeBackend?: ClaudeAgentRuntimeBackend;
  readonly workerFactory: AgentRuntimeTaskWorkerFactory;
}) {
  return createLocalAgentRuntimeTaskRunner({
    provider: AgentRuntimeTaskProvider.Claude,
    stateRootDir: "/tmp/runtime-state",
    encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    workspaceRoot: process.cwd(),
    env: {},
    ...(input.claudeBackend ? { claudeBackend: input.claudeBackend } : {}),
    workerFactory: input.workerFactory,
  });
}

function successfulFactory(
  calls: { job?: AgentRuntimeTaskWorkerJob },
): AgentRuntimeTaskWorkerFactory {
  return () => ({
    async start() {},
    async run(job) {
      calls.job = job;
      return { outputText: "completed", warnings: [] };
    },
    async dispose() {},
  });
}
