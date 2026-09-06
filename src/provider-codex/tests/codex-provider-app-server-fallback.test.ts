import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DefaultRedactor,
  providerTaskSystemPromptMaxBytes,
} from "@vioxen/subscription-runtime/core";
import {
  agentDriverContract,
  providerSessionDriverContract,
} from "../../core/testing/contracts";
import type {
  ManagedRunInputRequest,
  ManagedRunRecord,
  ManagedRunResumeHandle,
  ManagedRunStorePort,
  ProcessResult,
  ProviderFailure,
  RunnerPort,
  RunnerCapabilities,
} from "@vioxen/subscription-runtime/core";
import {
  CodexCliAgentDriver,
  CodexCliProviderDriver,
  CodexCliSessionDriver,
  CodexWorkerCacheSessionMaterializer,
  CodexWorkerCacheSessionPoolMaterializer,
  CodexAppServerExecutionEngine,
  CodexJsonAgentDriver,
  PackagedCodexJsonExecutionEngine,
  buildCodexJsonExecArgs,
  classifyCodexFailure,
  codexAgentCapabilities,
  codexEnvironmentPolicy,
  codexJsonAgentCapabilities,
  codexProviderManifest,
  codexSessionCapabilities,
  defaultCodexModel,
  sessionArtifactFromCodexAuthJson,
  validateCodexSessionArtifact,
} from "../index";
import type { CodexExecutionEngine } from "../codex-json-execution-engine";
import type { CodexSessionMaterializer } from "../codex-session-materializer";
import {
  classifyCodexRuntimeFailure,
  pruneCodexChildEnv,
} from "../codex-cli-domain";
import { isTransientCodexTempCleanupError } from "../codex-cli-temp-cleanup";
import {
  extractFakePrompt,
  FakeAppServerFactory,
} from "../app-server/testing/fake-app-server";
import {
  RecordingJsonEngine,
  RecordingManagedRunStore,
  RefreshingRunner,
  SlowRecordingJsonEngine,
  StaticRunner,
  expectFencedCodexPrompt,
  refreshedAuthJson,
  validAuthJson,
} from "./codex-provider-test-support";

describe("Codex provider app-server adapter", () => {
  it("never falls back after native rollout budget exhaustion", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-budget-no-fallback-"));
    const fakeFactory = new FakeAppServerFactory({
      emitCodexErrorOnTurn: {
        message: "Session rollout budget was exhausted.",
        codexErrorInfo: "sessionBudgetExceeded",
      },
    });
    const fallback = new RecordingJsonEngine("must not run");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
        rolloutBudget: { weightedTokenLimit: 100 },
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "respect budget" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: { code: "budget_exceeded", retryable: false },
      });
      expect(fallback.prompts).toEqual([]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports the account model catalog and skips fallback for unavailable models", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-model-catalog-test-"));
    const fakeFactory = new FakeAppServerFactory({
      failThreadStart: true,
      threadStartError:
        "The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account",
      availableModels: [
        {
          model: "gpt-5.6-sol",
          supportedReasoningEfforts: ["high", "xhigh"],
          isDefault: true,
        },
        {
          model: "gpt-5.5",
          supportedReasoningEfforts: ["medium", "high", "xhigh"],
        },
      ],
    });
    const fallback = new RecordingJsonEngine("fallback must not run");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
      }),
      model: "gpt-5.6",
      reasoningEffort: "xhigh",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "inspect model availability" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "model_unavailable",
          retryable: true,
          safeMessage:
            'Codex model "gpt-5.6" is unavailable for this account. Available models: gpt-5.6-sol, gpt-5.5.',
          details: {
            requestedModel: "gpt-5.6",
            availableModels: "gpt-5.6-sol,gpt-5.5",
            availableModelProfiles:
              "gpt-5.6-sol[high|xhigh],gpt-5.5[medium|high|xhigh]",
          },
        },
      });
      expect(fallback.prompts).toEqual([]);
      expect(fakeFactory.requests.map((request) => request.method)).toContain(
        "model/list",
      );
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("falls back to packaged Codex exec when app-server fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-fallback-test-"));
    const fakeFactory = new FakeAppServerFactory({
      failThreadStart: true,
    });
    const fallback = new RecordingJsonEngine("fallback output");
    const outputSchema = {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
      additionalProperties: false,
    } as const;
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
      outputSchemas: { verdict: outputSchema },
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "review",
          prompt: "fallback please",
          outputSchemaName: "verdict",
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "fallback output",
      });
      expect(result.warnings.map((warning) => warning.code)).toContain(
        "codex_app_server_fallback",
      );
      expect(fallback.prompts).toEqual(["fallback please"]);
      expect(fallback.outputSchemaPlans).toHaveLength(1);
      expect(fallback.outputSchemaPlans[0]?.providerSchema).toEqual(outputSchema);
      expect(Object.isFrozen(fallback.outputSchemaPlans[0])).toBe(true);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("redacts an app-server failure before exposing the fallback warning without replaying it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-fallback-warning-redaction-test-"));
    const secret = "app-server-fallback-warning-canary";
    const fakeFactory = new FakeAppServerFactory({
      failThreadStart: true,
      threadStartError: secret,
    });
    const fallback = new RecordingJsonEngine("fallback output");
    const redactor = new DefaultRedactor();
    redactor.registerSecret(secret, "fallback-test");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "redact fallback warning" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor,
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({ status: "completed", outputText: "fallback output" });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(fallback.prompts).toEqual(["redact fallback warning"]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not replay when app-server errors after turn start responds", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-turn-error-fallback-test-"));
    const fakeFactory = new FakeAppServerFactory({
      emitProcessErrorAfterTurnStartResponse: true,
    });
    const fallback = new RecordingJsonEngine("fallback output");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
        timeoutMs: 1_000,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "fallback after turn start" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({ status: "failed" });
      expect(fallback.prompts).toEqual([]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not replay when writing a turn-start request fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-write-failure-test-"));
    const fakeFactory = new FakeAppServerFactory({
      throwOnRequestMethod: "turn/start",
    });
    const fallback = new RecordingJsonEngine("fallback output");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
        timeoutMs: 1_000,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "fallback after write failure" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({ status: "failed" });
      expect(fallback.prompts).toEqual([]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not replay when responding to an unsupported app-server request fails", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-server-response-failure-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      emitUnsupportedServerRequestOnTurn: true,
      throwOnUnsupportedServerResponse: true,
    });
    const fallback = new RecordingJsonEngine("fallback output");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
        timeoutMs: 1_000,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "fallback after response failure" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({ status: "failed" });
      expect(fallback.prompts).toEqual([]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not replay when the app-server stdin stream errors", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-stdin-stream-error-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      emitStdinErrorAfterTurnStartResponse: true,
    });
    const fallback = new RecordingJsonEngine("fallback output");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
        timeoutMs: 1_000,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "fallback after stdin error" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({ status: "failed" });
      expect(fallback.prompts).toEqual([]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not fall back to packaged Codex exec after abort", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-abort-test-"));
    const fakeFactory = new FakeAppServerFactory();
    const fallback = new RecordingJsonEngine("fallback output");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });
    const controller = new AbortController();
    controller.abort();

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "must not fallback" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: controller.signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "task_cancelled",
        },
        telemetry: {
          finishReason: "cancelled",
        },
      });
      expect(fallback.prompts).toEqual([]);
      expect(fakeFactory.spawnCount).toBe(0);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("cancels a pending app-server initialize and stops the child", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-init-abort-test-"));
    const controller = new AbortController();
    const fakeFactory = new FakeAppServerFactory({
      suppressInitializeResponse: true,
      onRequest: (request) => {
        if (request.method === "initialize") controller.abort();
      },
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        timeoutMs: 250,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "cancel initialize" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: controller.signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "task_cancelled",
        },
        telemetry: {
          finishReason: "cancelled",
        },
      });
      expect(fakeFactory.spawnCount).toBe(1);
      expect(fakeFactory.processes[0]?.isExited()).toBe(true);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses a bounded app-server startup timeout separate from task timeout", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-init-timeout-test-"));
    const fakeFactory = new FakeAppServerFactory({
      suppressInitializeResponse: true,
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        timeoutMs: 60_000,
        startupTimeoutMs: 25,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "timeout initialize" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "task_timeout",
          safeMessage: "Codex task timed out.",
        },
      });
      expect(fakeFactory.spawnCount).toBe(1);
      expect(fakeFactory.processes[0]?.isExited()).toBe(true);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("classifies app-server initialize usage limits as quota limited", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-init-quota-test-"));
    const fakeFactory = new FakeAppServerFactory({
      initializeError: "You've hit your usage limit.",
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        startupTimeoutMs: 250,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "quota initialize" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "quota_limited",
          safeMessage: "Codex quota or billing limit was reached.",
        },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("waits through transient app-server reconnect progress errors", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-reconnect-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      emitTransientTopLevelErrorOnTurn: "Reconnecting... 2/5",
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        reconnectGraceMs: 50,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "survive reconnect" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "app-server output:survive reconnect",
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("classifies top-level app-server error messages", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-error-test-"));
    const fakeFactory = new FakeAppServerFactory({
      emitTopLevelErrorOnTurn: "You've hit your usage limit.",
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "fail clearly" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "quota_limited",
          safeMessage: "Codex quota or billing limit was reached.",
        },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails active app-server turns immediately when the child process errors", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-process-error-test-"));
    const fakeFactory = new FakeAppServerFactory({
      emitProcessErrorOnTurn: true,
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        timeoutMs: 250,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "process fails mid-turn" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "unknown_runtime_failure",
        },
        telemetry: {
          finishReason: "provider_error",
        },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails app-server turns when the process errors after turn start responds", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-early-process-error-test-"));
    const fakeFactory = new FakeAppServerFactory({
      emitProcessErrorAfterTurnStartResponse: true,
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        timeoutMs: 1_000,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "process fails before turn event" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "unknown_runtime_failure",
        },
        telemetry: {
          finishReason: "provider_error",
        },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("prewarms and reuses worker-cache CODEX_HOME across tasks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-worker-cache-test-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-worker-cache-root-"));
    const engine = new RecordingJsonEngine();
    const materializer = new CodexWorkerCacheSessionMaterializer({
      cacheKey: "provider-account:codex-test:slot:0",
      rootDir: cacheRoot,
    });
    const driver = new CodexJsonAgentDriver({
      engine,
      sessionMaterializer: materializer,
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const prewarm = await driver.prewarmSession({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        redactor: new DefaultRedactor(),
      });
      expect(prewarm.reusable).toBe(true);

      const first = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "first" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });
      const second = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "second" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(first.status).toBe("completed");
      expect(second.status).toBe("completed");
      expect(engine.codexHomes).toHaveLength(2);
      expect(engine.codexHomes[0]).toBe(prewarm.codexHome);
      expect(engine.codexHomes[1]).toBe(prewarm.codexHome);

      await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(refreshedAuthJson),
        task: { kind: "review", prompt: "rotated" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(engine.codexHomes[2]).toBe(prewarm.codexHome);
      await expect(
        readFile(join(prewarm.codexHome, "auth.json"), "utf8"),
      ).resolves.toContain(["refreshed", "refresh", "token"].join("-"));

      await driver.dispose();
      await expect(
        readFile(join(prewarm.codexHome, "auth.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("retains thread state but scrubs auth across a durable cache restart", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-durable-cache-root-"));
    const options = {
      cacheKey: "provider-account:codex-test:slot:durable",
      rootDir: cacheRoot,
      preserveOnDispose: true,
      scrubAuthOnDispose: true,
    } as const;
    const session = sessionArtifactFromCodexAuthJson(validAuthJson);
    const first = new CodexWorkerCacheSessionMaterializer(options);
    let second: CodexWorkerCacheSessionMaterializer | undefined;

    try {
      const initial = await first.materialize({
        session,
        redactor: new DefaultRedactor(),
      });
      const codexHome = initial.codexHome;
      const threadStatePath = join(codexHome, "threads", "thread-1.json");
      await mkdir(join(codexHome, "threads"), { recursive: true, mode: 0o700 });
      await writeFile(threadStatePath, "durable thread state\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      await initial.release();
      await first.dispose();

      await expect(readFile(threadStatePath, "utf8")).resolves.toBe(
        "durable thread state\n",
      );
      await expect(readFile(join(codexHome, "auth.json"), "utf8")).rejects.toThrow();

      const sameInstanceRestored = await first.materialize({
        session,
        redactor: new DefaultRedactor(),
      });
      expect(sameInstanceRestored.codexHome).toBe(codexHome);
      await expect(readFile(threadStatePath, "utf8")).resolves.toBe(
        "durable thread state\n",
      );
      await expect(readFile(join(codexHome, "auth.json"), "utf8")).resolves.toBe(
        validAuthJson,
      );
      await sameInstanceRestored.release();
      await first.dispose();
      await expect(readFile(join(codexHome, "auth.json"), "utf8")).rejects.toThrow();

      second = new CodexWorkerCacheSessionMaterializer(options);
      const restored = await second.materialize({
        session,
        redactor: new DefaultRedactor(),
      });
      expect(restored.codexHome).toBe(codexHome);
      await expect(readFile(threadStatePath, "utf8")).resolves.toBe(
        "durable thread state\n",
      );
      await expect(readFile(join(codexHome, "auth.json"), "utf8")).resolves.toBe(
        validAuthJson,
      );
      await restored.release();
      await second.dispose();
      await expect(readFile(join(codexHome, "auth.json"), "utf8")).rejects.toThrow();
    } finally {
      await first.dispose();
      await second?.dispose();
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("preserves custom worker-cache config across reused tasks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-custom-cache-test-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-custom-cache-root-"));
    const configToml = [
      'cli_auth_credentials_store = "file"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      "",
      "[features]",
      "shell_tool = false",
      "",
    ].join("\n");
    const materializer = new CodexWorkerCacheSessionMaterializer({
      cacheKey: "provider-account:codex-test:slot:custom-config",
      rootDir: cacheRoot,
      configToml,
    });
    const driver = new CodexJsonAgentDriver({
      engine: new RecordingJsonEngine(),
      sessionMaterializer: materializer,
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const prewarm = await driver.prewarmSession({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        redactor: new DefaultRedactor(),
      });

      for (const prompt of ["first", "second"]) {
        const result = await driver.runTask({
          session: sessionArtifactFromCodexAuthJson(validAuthJson),
          task: { kind: "review", prompt },
          workspace: { path: workspace },
          runner: new StaticRunner(""),
          redactor: new DefaultRedactor(),
          abortSignal: new AbortController().signal,
        });
        expect(result.status).toBe("completed");
      }

      await expect(
        readFile(join(prewarm.codexHome, "config.toml"), "utf8"),
      ).resolves.toBe(configToml);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("captures Codex auth changes written during task execution", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-task-update-test-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-task-update-root-"));
    const engine = new (class extends RecordingJsonEngine {
      override async run(input: Parameters<CodexExecutionEngine["run"]>[0]) {
        await writeFile(join(input.session.codexHome, "auth.json"), refreshedAuthJson);
        return super.run(input);
      }
    })();
    const driver = new CodexJsonAgentDriver({
      engine,
      sessionMaterializer: new CodexWorkerCacheSessionMaterializer({
        cacheKey: "provider-account:codex-test:slot:snapshot",
        rootDir: cacheRoot,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "capture auth update" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result.status).toBe("completed");
      if (result.status === "completed") {
        expect(result.sessionUpdate).toBeTruthy();
        expect(new TextDecoder().decode(result.sessionUpdate!.bytes)).toContain(
          ["refreshed", "refresh", "token"].join("-"),
        );
      }
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("serializes concurrent worker-cache use for one warmed worker slot", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-worker-lock-test-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-worker-lock-root-"));
    const engine = new SlowRecordingJsonEngine();
    const driver = new CodexJsonAgentDriver({
      engine,
      sessionMaterializer: new CodexWorkerCacheSessionMaterializer({
        cacheKey: "provider-account:codex-test:slot:1",
        rootDir: cacheRoot,
      }),
    });

    try {
      const run = (prompt: string) =>
        driver.runTask({
          session: sessionArtifactFromCodexAuthJson(validAuthJson),
          task: { kind: "review", prompt },
          workspace: { path: workspace },
          runner: new StaticRunner(""),
          redactor: new DefaultRedactor(),
          abortSignal: new AbortController().signal,
        });

      await Promise.all([run("one"), run("two")]);
      expect(engine.maxActive).toBe(1);
      expect(engine.codexHomes[0]).toBe(engine.codexHomes[1]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
});
