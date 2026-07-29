import { describe, expect, it } from "vitest";
import {
  AgentRuntimeAccessBoundary,
  AgentRuntimeBudgetMetric,
  AgentRuntimeExecutionMode,
  AgentRuntimeFailureCode,
  AgentRuntimeTool,
  AgentRuntimeUnsupportedControlPolicy,
} from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeFailureLifecycleState,
  AgentRuntimePendingAuthority,
} from "@vioxen/subscription-runtime/agent-runtime-task";
import {
  AgentRuntimeTaskProvider,
  createLocalAgentRuntimeTaskRunner,
  type AgentRuntimeTaskWorker,
  type AgentRuntimeTaskWorkerFactory,
  type AgentRuntimeTaskWorkerFactoryInput,
  type AgentRuntimeTaskWorkerJob,
} from "../agent-runtime-task-runner";

describe("local AgentRuntimeTaskRunner Goal lifecycle", () => {
  it("compiles a bounded v2 Codex Goal into one native app-server execution", async () => {
    const calls: {
      factory?: AgentRuntimeTaskWorkerFactoryInput;
      job?: AgentRuntimeTaskWorkerJob;
    } = {};
    const probed: string[] = [];
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      codexRuntimeFeatureProbe: {
        supports: async ({ feature }) => {
          probed.push(feature);
          return true;
        },
      },
      workerFactory: fakeFactory(calls),
    });

    const result = await runner.run({
      protocolVersion: 2,
      timeoutMs: 60_000,
      task: {
        kind: "structured-prompt",
        prompt: "Fix the deterministic fixture.",
        execution: {
          mode: AgentRuntimeExecutionMode.Goal,
          completionCondition: "The fixture requirement is fully implemented.",
        },
        controls: {
          maxTurns: 20,
          accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
          toolPolicy: {
            allow: [
              AgentRuntimeTool.ReadFile,
              AgentRuntimeTool.SearchFiles,
              AgentRuntimeTool.EditFile,
              AgentRuntimeTool.WriteFile,
            ],
            deny: [AgentRuntimeTool.Shell, AgentRuntimeTool.WebAccess],
            onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
          },
          budget: {
            metric: AgentRuntimeBudgetMetric.WeightedTokens,
            limit: 100_000,
            onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
          },
        },
      },
    });

    expect(result).toMatchObject({ protocolVersion: 2, status: "completed" });
    expect(probed).toEqual(["goals", "rollout_budget"]);
    expect(calls.factory?.codexExecutionPlan).toMatchObject({
      execution: {
        mode: AgentRuntimeExecutionMode.Goal,
        goalObjective: "The fixture requirement is fully implemented.",
        maxGoalTurns: 20,
      },
      rolloutBudget: { weightedTokenLimit: 100_000 },
    });
    expect(calls.job?.execution).toEqual({
      mode: AgentRuntimeExecutionMode.Goal,
      completionCondition: "The fixture requirement is fully implemented.",
    });
    expect(calls.job?.metadata).toBeUndefined();
  });

  it("fails a v2 Goal before provider start when hard bounds are absent", async () => {
    let factoryCalls = 0;
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      codexRuntimeFeatureProbe: { supports: async () => false },
      workerFactory: () => {
        factoryCalls += 1;
        throw new Error("should not construct");
      },
    });

    const result = await runner.run({
      protocolVersion: 2,
      task: {
        kind: "structured-prompt",
        prompt: "Fix this.",
        execution: {
          mode: AgentRuntimeExecutionMode.Goal,
          completionCondition: "The fix is complete.",
        },
      },
    });
    expect(result).toMatchObject({
      protocolVersion: 2,
      status: "failed",
      failure: { code: AgentRuntimeFailureCode.TaskRequestInvalid },
      lifecycle: {
        state: AgentRuntimeFailureLifecycleState.PreflightFailed,
        taskStarted: false,
      },
    });
    expect(factoryCalls).toBe(0);
  });

  it("lets cleanup uncertainty dominate a v2 provider success", async () => {
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      cleanupTimeoutMs: 25,
      workerFactory: hangingDisposeWorker,
    });

    const result = await runner.run({
      protocolVersion: 2,
      task: {
        kind: "structured-prompt",
        prompt: "Inspect only.",
        execution: { mode: AgentRuntimeExecutionMode.SingleRun },
      },
    });

    expect(result).toMatchObject({
      protocolVersion: 2,
      status: "failed",
      failure: {
        code: AgentRuntimeFailureCode.CleanupUnconfirmed,
        details: { cleanup: "worker_dispose_unconfirmed" },
      },
      lifecycle: {
        state: AgentRuntimeFailureLifecycleState.CleanupUnconfirmed,
        taskStarted: true,
        pendingAuthorities: [
          AgentRuntimePendingAuthority.ProviderProcess,
          AgentRuntimePendingAuthority.ProviderSession,
        ],
      },
    });
  });

  it("reports a pending tool server only for a bounded Codex tool surface", async () => {
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      cleanupTimeoutMs: 25,
      workerFactory: hangingDisposeWorker,
    });

    const result = await runner.run({
      protocolVersion: 2,
      task: {
        kind: "structured-prompt",
        prompt: "Inspect only.",
        execution: { mode: AgentRuntimeExecutionMode.SingleRun },
        controls: {
          accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
          toolPolicy: {
            allow: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.EditFile],
            onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
          },
        },
      },
    });

    expect(result).toMatchObject({
      protocolVersion: 2,
      status: "failed",
      lifecycle: {
        state: AgentRuntimeFailureLifecycleState.CleanupUnconfirmed,
        pendingAuthorities: [
          AgentRuntimePendingAuthority.ProviderProcess,
          AgentRuntimePendingAuthority.ProviderSession,
          AgentRuntimePendingAuthority.ToolServer,
        ],
      },
    });
  });
});

function fakeFactory(calls: {
  factory?: AgentRuntimeTaskWorkerFactoryInput;
  job?: AgentRuntimeTaskWorkerJob;
}): AgentRuntimeTaskWorkerFactory {
  return (input) => {
    calls.factory = input;
    return {
      async start() {},
      async run(job) {
        calls.job = job;
        return { outputText: `worker:${job.prompt}`, warnings: [] };
      },
      async dispose() {},
    } satisfies AgentRuntimeTaskWorker;
  };
}

function hangingDisposeWorker(): AgentRuntimeTaskWorker {
  return {
    async start() {},
    async run() {
      return { outputText: "done", warnings: [] };
    },
    async dispose() {
      await new Promise<void>(() => {});
    },
  };
}
