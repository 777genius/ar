import { describe, expect, it } from "vitest";
import {
  AgentRuntimeAccessBoundary,
  AgentRuntimeBudgetMetric,
  AgentRuntimeFailureCode,
  AgentRuntimeExecutionMode,
  AgentRuntimeTool,
  AgentRuntimeUnsupportedControlPolicy,
} from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeTaskProvider,
  AuthSourceKind,
  ClaudeAgentRuntimeBackend,
  createLocalAgentRuntimeTaskRunner,
  type AgentRuntimeTaskWorker,
  type AgentRuntimeTaskWorkerFactory,
  type AgentRuntimeTaskWorkerFactoryInput,
  type AgentRuntimeTaskWorkerJob,
} from "../agent-runtime-task-runner";

describe("local AgentRuntimeTaskRunner module API", () => {
  it.each([undefined, 3])(
    "rejects protocol version %s without constructing a provider worker",
    async (protocolVersion) => {
      let factoryCalls = 0;
      const runner = createLocalAgentRuntimeTaskRunner({
        provider: AgentRuntimeTaskProvider.Claude,
        stateRootDir: "/tmp/runtime-state",
        encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        workspaceRoot: process.cwd(),
        env: {},
        workerFactory: () => {
          factoryCalls += 1;
          throw new Error("should not construct");
        },
      });
      const request = {
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
        task: { kind: "structured-prompt", prompt: "must not run" },
      };

      await expect(runner.run(request as never)).rejects.toMatchObject({
        name: "AgentRuntimeTaskProtocolError",
        code: "agent_runtime_task_protocol_version_invalid",
      });
      expect(factoryCalls).toBe(0);
      await runner.dispose();
    },
  );

  it("runs through a worker and forwards normalized tool policy controls", async () => {
    const calls: {
      factory?: AgentRuntimeTaskWorkerFactoryInput;
      seed?: string;
      job?: AgentRuntimeTaskWorkerJob;
    } = {};
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {
        PATH: "/usr/bin",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-leak",
        SECRET_TOKEN: "must-not-leak",
      },
      authSource: {
        kind: AuthSourceKind.ClaudeOAuthToken,
        oauthToken: "claude-token",
      },
      workerFactory: fakeFactory(calls),
    });

    const result = await runner.run({
      protocolVersion: 1,
      runId: "run-1",
      task: {
        kind: "structured-prompt",
        prompt: "fix this",
        controls: {
          toolPolicy: {
            allow: [
              AgentRuntimeTool.ReadFile,
              AgentRuntimeTool.SearchFiles,
            ],
            deny: [AgentRuntimeTool.Shell],
            onUnsupported: "fail",
          },
          accessBoundary: "read_only",
        },
      },
    });

    expect(result).toMatchObject({
      status: "completed",
      outputText: "worker:fix this",
    });
    expect(calls.factory).toMatchObject({
      provider: AgentRuntimeTaskProvider.Claude,
      providerInstanceId: "claude:default",
      env: {
        PATH: "/usr/bin",
      },
    });
    expect(calls.factory?.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(calls.factory?.env).not.toHaveProperty("SECRET_TOKEN");
    expect(calls.seed).toBe("claude-token");
    expect(calls.job?.controls).toMatchObject({
      allowedTools: ["Read", "Grep", "Glob"],
      disallowedTools: ["Bash"],
      toolPolicy: {
        allow: [
          AgentRuntimeTool.ReadFile,
          AgentRuntimeTool.SearchFiles,
        ],
        deny: [AgentRuntimeTool.Shell],
        onUnsupported: "fail",
      },
    });
  });

  it("maps provider-neutral worktree controls to Claude worktree tools", async () => {
    const calls: {
      job?: AgentRuntimeTaskWorkerJob;
    } = {};
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      workerFactory: fakeFactory(calls),
    });

    const result = await runner.run({
      protocolVersion: 1,
      runId: "run-worktree-policy",
      task: {
        kind: "structured-prompt",
        prompt: "fix this in the current worktree",
        controls: {
          toolPolicy: {
            deny: [AgentRuntimeTool.WorktreeControl],
            onUnsupported: "fail",
          },
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(calls.job?.controls?.disallowedTools).toEqual([
      "EnterWorktree",
      "ExitWorktree",
    ]);
  });

  it("returns a structured failure when the provider runtime is unavailable", async () => {
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      claudeBackend: ClaudeAgentRuntimeBackend.Background,
      claudeRuntimeDistDir: "/tmp/missing-claude-runtime-dist",
    });

    const result = await runner.run({
      protocolVersion: 1,
      task: {
        kind: "structured-prompt",
        prompt: "fix this",
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "provider_runtime_unavailable",
        details: {
          provider: AgentRuntimeTaskProvider.Claude,
          missing: "claude-runtime",
        },
      },
    });
  });

  it("fails before constructing a background Claude worker when a USD budget is required", async () => {
    let factoryCalled = false;
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      claudeBackend: ClaudeAgentRuntimeBackend.Background,
      workerFactory: () => {
        factoryCalled = true;
        throw new Error("should not construct");
      },
    });

    const result = await runner.run({
      protocolVersion: 1,
      task: {
        kind: "structured-prompt",
        prompt: "fix this",
        controls: {
          budget: {
            metric: AgentRuntimeBudgetMetric.Usd,
            limit: 1,
            onUnsupported: "fail",
          },
        },
      },
    });

    expect(factoryCalled).toBe(false);
    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "task_mode_unsupported",
      },
      warnings: [
        {
          code: "agent_runtime_task_control_unsupported",
          details: {
            control: "budget",
            provider: AgentRuntimeTaskProvider.Claude,
          },
        },
      ],
    });
  });

  it("compiles bounded Codex file tools into a host-filtered execution plan", async () => {
    const calls: {
      factory?: AgentRuntimeTaskWorkerFactoryInput;
      job?: AgentRuntimeTaskWorkerJob;
    } = {};
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      workerFactory: fakeFactory(calls),
    });

    const result = await runner.run({
      protocolVersion: 1,
      task: {
        kind: "structured-prompt",
        prompt: "fix this",
        controls: {
          toolPolicy: {
            allow: [
              AgentRuntimeTool.ReadFile,
              AgentRuntimeTool.EditFile,
              AgentRuntimeTool.Shell,
            ],
            deny: [AgentRuntimeTool.Shell],
            onUnsupported: "fail",
          },
          accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
        },
      },
    });

    expect(result).toMatchObject({ status: "completed" });
    expect(calls.factory?.codexExecutionPlan).toEqual({
      execution: { mode: AgentRuntimeExecutionMode.SingleRun },
      workspaceToolPolicy: {
        allowedTools: [AgentRuntimeTool.EditFile, AgentRuntimeTool.ReadFile],
      },
    });
    expect(calls.job?.controls).toMatchObject({
      toolPolicy: {
        allow: [
          AgentRuntimeTool.ReadFile,
          AgentRuntimeTool.EditFile,
          AgentRuntimeTool.Shell,
        ],
        deny: [AgentRuntimeTool.Shell],
      },
    });
  });

  it("fails closed when Codex is given an unenforceable max-turn limit", async () => {
    let factoryCalled = false;
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      workerFactory: () => {
        factoryCalled = true;
        throw new Error("should not construct");
      },
    });

    const result = await runner.run({
      protocolVersion: 1,
      task: {
        kind: "structured-prompt",
        prompt: "fix this",
        controls: { maxTurns: 5 },
      },
    });

    expect(factoryCalled).toBe(false);
    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: AgentRuntimeFailureCode.TaskModeUnsupported,
        details: {
          control: "maxTurns",
          provider: AgentRuntimeTaskProvider.Codex,
        },
      },
    });
  });

  it("still fails before worker construction for non-file Codex tools", async () => {
    let factoryCalled = false;
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      workerFactory: () => {
        factoryCalled = true;
        throw new Error("should not construct");
      },
    });

    const result = await runner.run({
      protocolVersion: 1,
      task: {
        kind: "structured-prompt",
        prompt: "run this",
        controls: {
          toolPolicy: {
            allow: [AgentRuntimeTool.Shell],
            onUnsupported: "fail",
          },
          accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
        },
      },
    });

    expect(factoryCalled).toBe(false);
    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "task_mode_unsupported",
        details: {
          control: "toolPolicy",
          provider: AgentRuntimeTaskProvider.Codex,
        },
      },
    });
  });

  it("fails before worker construction when Codex receives an unsupported USD budget", async () => {
    let factoryCalled = false;
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      workerFactory: () => {
        factoryCalled = true;
        throw new Error("should not construct");
      },
    });

    const result = await runner.run({
      protocolVersion: 1,
      task: {
        kind: "structured-prompt",
        prompt: "fix this",
        controls: {
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
    });

    expect(factoryCalled).toBe(false);
    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "task_mode_unsupported",
        details: {
          control: "budget",
          provider: AgentRuntimeTaskProvider.Codex,
        },
      },
    });
  });

  it("warns and continues when an unsupported budget metric is explicitly soft", async () => {
    const calls: { job?: AgentRuntimeTaskWorkerJob } = {};
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      workerFactory: fakeFactory(calls),
    });

    const result = await runner.run({
      protocolVersion: 1,
      task: {
        kind: "structured-prompt",
        prompt: "fix this",
        controls: {
          budget: {
            metric: AgentRuntimeBudgetMetric.Usd,
            limit: 1,
            onUnsupported: "warn",
          },
        },
      },
    });

    expect(calls.job?.controls).toMatchObject({
      budget: {
        metric: AgentRuntimeBudgetMetric.Usd,
        limit: 1,
        onUnsupported: "warn",
      },
    });
    expect(result).toMatchObject({
      status: "completed",
      warnings: [
        {
          code: "agent_runtime_task_control_unsupported",
          details: {
            control: "budget",
            provider: AgentRuntimeTaskProvider.Codex,
          },
        },
      ],
    });
  });

  it("compiles a native Codex weighted-token budget into the execution plan", async () => {
    const calls: { factory?: AgentRuntimeTaskWorkerFactoryInput } = {};
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      codexRuntimeFeatureProbe: { supports: async () => true },
      workerFactory: fakeFactory(calls),
    });

    const result = await runner.run({
      protocolVersion: 1,
      task: {
        kind: "structured-prompt",
        prompt: "inspect this",
        controls: {
          budget: {
            metric: AgentRuntimeBudgetMetric.WeightedTokens,
            limit: 100_000,
            onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
          },
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(calls.factory?.codexExecutionPlan).toEqual({
      execution: { mode: AgentRuntimeExecutionMode.SingleRun },
      rolloutBudget: { weightedTokenLimit: 100_000 },
    });
  });

  it("prunes the environment before probing Codex runtime features", async () => {
    const calls: { factory?: AgentRuntimeTaskWorkerFactoryInput } = {};
    let probeEnv: Readonly<Record<string, string | undefined>> | undefined;
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        CODEX_HOME: "/tmp/codex-home",
        GH_TOKEN: "must-not-leak",
        OPENAI_API_KEY: "must-not-leak",
        SECRET_TOKEN: "must-not-leak",
      },
      codexRuntimeFeatureProbe: {
        supports: async (input) => {
          probeEnv = input.env;
          return true;
        },
      },
      workerFactory: fakeFactory(calls),
    });

    const result = await runner.run({
      protocolVersion: 1,
      task: {
        kind: "structured-prompt",
        prompt: "inspect this",
        controls: {
          budget: {
            metric: AgentRuntimeBudgetMetric.WeightedTokens,
            limit: 100_000,
            onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
          },
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(probeEnv).toMatchObject({
      PATH: expect.any(String),
      HOME: "/tmp/home",
      CODEX_HOME: "/tmp/codex-home",
    });
    expect(probeEnv).not.toHaveProperty("GH_TOKEN");
    expect(probeEnv).not.toHaveProperty("OPENAI_API_KEY");
    expect(probeEnv).not.toHaveProperty("SECRET_TOKEN");
  });

  it("applies the task wall-clock timeout to Codex capability probing", async () => {
    let factoryCalled = false;
    let probeSignal: AbortSignal | undefined;
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      codexRuntimeFeatureProbe: {
        supports: async ({ signal }) => {
          probeSignal = signal;
          return await new Promise<boolean>(() => {});
        },
      },
      workerFactory: () => {
        factoryCalled = true;
        throw new Error("should not construct");
      },
    });

    const startedAt = Date.now();
    const result = await runner.run({
      protocolVersion: 1,
      timeoutMs: 25,
      task: {
        kind: "structured-prompt",
        prompt: "inspect this",
        controls: {
          budget: {
            metric: AgentRuntimeBudgetMetric.WeightedTokens,
            limit: 100_000,
            onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
          },
        },
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(probeSignal?.aborted).toBe(true);
    expect(factoryCalled).toBe(false);
    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: AgentRuntimeFailureCode.TaskTimeout,
        safeMessage: "Agent runtime task timed out after 25ms.",
      },
    });
  });

  it("fails before worker construction when Codex lacks native rollout budgets", async () => {
    let factoryCalled = false;
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      codexRuntimeFeatureProbe: { supports: async () => false },
      workerFactory: () => {
        factoryCalled = true;
        throw new Error("should not construct");
      },
    });

    const result = await runner.run({
      protocolVersion: 1,
      task: {
        kind: "structured-prompt",
        prompt: "inspect this",
        controls: {
          budget: {
            metric: AgentRuntimeBudgetMetric.WeightedTokens,
            limit: 100_000,
            onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
          },
        },
      },
    });

    expect(factoryCalled).toBe(false);
    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "task_mode_unsupported",
        details: { control: "budget", provider: "codex" },
      },
    });
  });

  it("reports an unavailable Codex binary when capability probing cannot start", async () => {
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      codexRuntimeFeatureProbe: {
        supports: async () => {
          throw new Error("spawn codex ENOENT");
        },
      },
      workerFactory: () => {
        throw new Error("should not construct");
      },
    });

    const result = await runner.run({
      protocolVersion: 1,
      task: {
        kind: "structured-prompt",
        prompt: "inspect this",
        controls: {
          budget: {
            metric: AgentRuntimeBudgetMetric.WeightedTokens,
            limit: 100_000,
            onUnsupported: AgentRuntimeUnsupportedControlPolicy.Fail,
          },
        },
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "provider_runtime_unavailable",
        safeMessage:
          "Codex runtime capability probing failed before task execution.",
      },
    });
  });

  it("validates module requests before constructing a worker", async () => {
    let factoryCalled = false;
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      workerFactory: () => {
        factoryCalled = true;
        throw new Error("should not construct");
      },
    });

    const result = await runner.run({
      protocolVersion: 1,
      task: {
        kind: "structured-prompt",
      },
    } as never);

    expect(factoryCalled).toBe(false);
    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "task_request_invalid",
        safeMessage: "request.task.prompt must be a string",
      },
    });
  });

  it("uses explicit authSource credentials without borrowing unrelated legacy auth", async () => {
    const calls: {
      seed?: string;
      factory?: AgentRuntimeTaskWorkerFactoryInput;
      job?: AgentRuntimeTaskWorkerJob;
    } = {};
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      authSource: {
        kind: AuthSourceKind.CodexAuthJsonFile,
        path: "/tmp/codex-auth.json",
      },
      workerFactory: fakeFactory(calls),
    });

    const result = await runner.run({
      protocolVersion: 1,
      task: {
        kind: "structured-prompt",
        prompt: "fix this",
      },
    });

    expect(result).toMatchObject({ status: "completed" });
    expect(calls.seed).toBe("/tmp/codex-auth.json");
  });

  it("honors already-aborted cancellation before constructing a worker", async () => {
    let factoryCalled = false;
    const abortController = new AbortController();
    abortController.abort();
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      workerFactory: () => {
        factoryCalled = true;
        throw new Error("should not construct");
      },
    });

    const result = await runner.run(
      {
        protocolVersion: 1,
        task: {
          kind: "structured-prompt",
          prompt: "fix this",
        },
      },
      { signal: abortController.signal },
    );

    expect(factoryCalled).toBe(false);
    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "task_cancelled",
      },
    });
  });

  it("cancels active runs and waits for worker disposal", async () => {
    let markStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let workerDisposed = false;
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      workerFactory: () => ({
        async start() {},
        async run(job) {
          markStarted();
          return await new Promise((_, reject) => {
            job.abortSignal?.addEventListener(
              "abort",
              () => reject(new Error("cancelled by runner disposal")),
              { once: true },
            );
          });
        },
        async dispose() {
          workerDisposed = true;
        },
      }),
    });

    const run = runner.run({
      protocolVersion: 1,
      task: {
        kind: "structured-prompt",
        prompt: "wait for cancellation",
      },
    });
    await started;
    await runner.dispose();

    await expect(run).resolves.toMatchObject({
      status: "failed",
      failure: { code: "task_cancelled" },
    });
    expect(workerDisposed).toBe(true);
  });
});

function fakeFactory(calls: {
  factory?: AgentRuntimeTaskWorkerFactoryInput;
  seed?: string;
  job?: AgentRuntimeTaskWorkerJob;
}): AgentRuntimeTaskWorkerFactory {
  return (input) => {
    calls.factory = input;
    const worker: AgentRuntimeTaskWorker = {
      async start() {},
      async seedClaudeOAuth(seed) {
        calls.seed = seed.oauthToken;
      },
      async seedCodexAuthJsonFile(path) {
        calls.seed = path;
      },
      async run(job) {
        calls.job = job;
        return {
          outputText: `worker:${job.prompt}`,
          structuredOutput: { ok: true },
          telemetry: { finishReason: "completed" },
          warnings: [],
        };
      },
      async dispose() {},
    };
    return worker;
  };
}
