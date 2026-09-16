import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function abortAfterTurnStartResponse(
  factory: FakeAppServerFactory,
  controller: AbortController,
) {
  return (input: Parameters<typeof factory.create>[0]) => {
    const child = factory.create(input);
    const emit = child.stdout.emit.bind(child.stdout);
    child.stdout.emit = ((event: string | symbol, ...args: unknown[]) => {
      const emitted = emit(event, ...args);
      if (event === "data" && factory.requests.at(-1)?.method === "turn/start") {
        controller.abort();
      }
      return emitted;
    }) as typeof child.stdout.emit;
    return child;
  };
}

describe("Codex provider app-server adapter", () => {
  it("runs Codex JSON tasks through reusable app-server slots", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-server-test-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-app-server-root-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        executionProfile: "stateless-completion",
      }),
      sessionMaterializer: new CodexWorkerCacheSessionPoolMaterializer({
        cacheKey: "provider-account:codex-test",
        slots: 2,
        rootDir: cacheRoot,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
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

      const [first, second] = await Promise.all([run("one"), run("two")]);

      expect(first).toMatchObject({
        status: "completed",
        outputText: "app-server output:one",
      });
      expect(second).toMatchObject({
        status: "completed",
        outputText: "app-server output:two",
      });
      expect(fakeFactory.spawnCount).toBe(2);
      expect(new Set(fakeFactory.codexHomes)).toHaveLength(2);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("propagates app-server turn usage into provider telemetry", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-server-usage-test-"));
    const fakeFactory = new FakeAppServerFactory({
      turnUsage: {
        input_tokens: 123,
        output_tokens: 45,
      },
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "usage please" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result.status).toBe("completed");
      if (result.status !== "completed") throw new Error("expected completed");
      expect(result.telemetry?.usage).toEqual({
        inputTokens: 123,
        outputTokens: 45,
        totalTokens: 168,
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("disposes app-server clients when stdin close emits exit first", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-stdin-exit-test-"));
    const fakeFactory = new FakeAppServerFactory({
      exitOnStdinEnd: true,
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "exit on stdin end" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "app-server output:exit on stdin end",
      });
      await driver.dispose();
      expect(fakeFactory.spawnCount).toBe(1);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reads app-server agent messages from completed content parts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-content-test-"));
    const fakeFactory = new FakeAppServerFactory({
      completedAgentMessageContentOnly: true,
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "content parts" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "app-server output:content parts",
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not replenish streamed output allowance after completed-message replacement", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-replacement-stream-limit-test-"));
    const delta = "x".repeat(1_000);
    const fakeFactory = new FakeAppServerFactory({
      agentMessageDeltas: Array.from({ length: 20 }, () => delta),
      completedAgentMessageAfterEachDelta: "x",
      suppressTurnCompletion: true,
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        maxOutputBytes: 1_024,
        timeoutMs: 250,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });
    const delivered: string[] = [];

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "replacement stream limit" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
        onTextDelta: (text) => delivered.push(text),
      });

      expect(result.status).toBe("failed");
      expect(Buffer.byteLength(delivered.join(""), "utf8")).toBeLessThanOrEqual(1_024);
      expect(fakeFactory.prompts).toEqual(["replacement stream limit"]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts an exact-limit delta followed by its completed-message replacement", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-replacement-exact-limit-test-"));
    const delta = "é".repeat(512);
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: new FakeAppServerFactory({
          agentMessageDeltas: [delta],
          completedAgentMessageAfterEachDelta: delta,
        }).create,
        cleanThreadPrewarm: false,
        maxOutputBytes: 1_024,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "replacement exact limit" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({ status: "completed", outputText: delta });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves an exact byte limit when an early turn aliases to its response id", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-alias-limit-test-"));
    const delta = "é".repeat(256);
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: new FakeAppServerFactory({
          mismatchTurnStartResponseId: true,
          emitDeltaBeforeTurnStarted: true,
          agentMessageDeltas: [delta, delta],
        }).create,
        cleanThreadPrewarm: false,
        maxOutputBytes: 1_024,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "alias stream limit" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({ status: "completed", outputText: delta.repeat(2) });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves the early turn's streamed budget after alias replacement", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-alias-replacement-limit-test-"));
    const delta = "x".repeat(1_000);
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: new FakeAppServerFactory({
          mismatchTurnStartResponseId: true,
          emitDeltaBeforeTurnStarted: true,
          completedAgentMessageAfterEarlyDelta: "x",
          agentMessageDeltas: [delta, delta],
          suppressTurnCompletion: true,
        }).create,
        cleanThreadPrewarm: false,
        maxOutputBytes: 1_024,
        timeoutMs: 250,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "alias replacement limit" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result.status).toBe("failed");
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects early same-chunk overflow despite a later completion notification", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-early-stream-limit-test-"));
    const delta = "x".repeat(1_024);
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: new FakeAppServerFactory({
          emitTurnEventsWithStartResponse: true,
          mismatchTurnStartResponseId: true,
          agentMessageDeltas: [delta, delta],
        }).create,
        cleanThreadPrewarm: false,
        maxOutputBytes: 1_024,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "early stream limit" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result.status).toBe("failed");
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects oversized completed agent-message replacement", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-completed-limit-test-"));
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: new FakeAppServerFactory({
          completedAgentMessageContentOnly: true,
          completedAgentMessageText: "🧪".repeat(300),
        }).create,
        cleanThreadPrewarm: false,
        maxOutputBytes: 1_024,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "completed limit" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result.status).toBe("failed");
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("parses app-server structured output from completed content parts", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-content-structured-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      completedAgentMessageContentOnly: true,
      appendCompletedAgentMessageToolContent: true,
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: JSON.stringify({ verdict: "APPROVE" }),
          controls: {
            outputSchemaName: "review-verdict",
          },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        structuredOutput: { verdict: "APPROVE" },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("handles app-server turn events emitted before the turn waiter is registered", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-early-turn-test-"));
    const controller = new AbortController();
    const fakeFactory = new FakeAppServerFactory({
      emitTurnEventsWithStartResponse: true,
      mismatchTurnStartResponseId: true,
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: abortAfterTurnStartResponse(fakeFactory, controller),
        cleanThreadPrewarm: false,
        timeoutMs: 250,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "early turn events" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: controller.signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "app-server output:early turn events",
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("cancels when turn/start responds before the turn waiter is registered", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-start-abort-test-"));
    const controller = new AbortController();
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: abortAfterTurnStartResponse(fakeFactory, controller),
        cleanThreadPrewarm: false,
        timeoutMs: 250,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "cancel after turn start" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: controller.signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: { code: "task_cancelled" },
        telemetry: { finishReason: "cancelled" },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("cancels a waiting turn when its output callback aborts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-output-abort-test-"));
    const controller = new AbortController();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: new FakeAppServerFactory().create,
        cleanThreadPrewarm: false,
        timeoutMs: 250,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "cancel from output callback" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: controller.signal,
        onTextDelta: () => controller.abort(),
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: { code: "task_cancelled" },
        telemetry: { finishReason: "cancelled" },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("streams early app-server text deltas through the redacted task boundary", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-delta-test-"));
    const fakeFactory = new FakeAppServerFactory({
      emitTurnCompletionBeforeStarted: true,
      mismatchTurnStartResponseId: true,
    });
    const redactor = new DefaultRedactor();
    redactor.registerSecret("voice-secret", "voice-test");
    const deltas: string[] = [];
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "voice-secret" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor,
        abortSignal: new AbortController().signal,
        onTextDelta: (text) => {
          deltas.push(text);
        },
      });

      expect(deltas.join("")).toBe(
        "app-server output:[redacted:voice-test]",
      );
      expect(result).toMatchObject({
        status: "completed",
        outputText: "app-server output:[redacted:voice-test]",
      });
      expect(JSON.stringify({ deltas, result })).not.toContain("voice-secret");
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails the turn when the text-delta sink rejects streamed output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-delta-sink-test-"));
    const fakeFactory = new FakeAppServerFactory({
      emitTurnEventsWithStartResponse: true,
      mismatchTurnStartResponseId: true,
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "reject streamed output" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
        onTextDelta: () => {
          throw new Error("bounded_delta_queue_full");
        },
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "unknown_runtime_failure",
          details: {
            rawCause: "bounded_delta_queue_full",
          },
        },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not keep stale aliases when early app-server turn ids are reused", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-reused-turn-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      emitTurnEventsWithStartResponse: true,
      mismatchTurnStartResponseId: true,
      reuseActualTurnId: "turn-reused",
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        timeoutMs: 250,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
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

      await expect(run("first reused turn")).resolves.toMatchObject({
        status: "completed",
        outputText: "app-server output:first reused turn",
      });
      await expect(run("second reused turn")).resolves.toMatchObject({
        status: "completed",
        outputText: "app-server output:second reused turn",
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("handles app-server turn completion emitted before turn started", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-complete-before-started-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      emitTurnCompletionBeforeStarted: true,
      mismatchTurnStartResponseId: true,
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        timeoutMs: 250,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "complete before started" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "app-server output:complete before started",
      });
      const nextResult = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "next turn after late started" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(nextResult).toMatchObject({
        status: "completed",
        outputText: "app-server output:next turn after late started",
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts prefixed structured output from Codex app-server execution", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-structured-test-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: JSON.stringify({ verdict: "APPROVE" }),
          controls: {
            outputSchemaName: "review-verdict",
          },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        structuredOutput: { verdict: "APPROVE" },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("passes registered output schemas to Codex app-server turns", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-native-schema-test-"));
    const fakeFactory = new FakeAppServerFactory();
    const reviewVerdictSchema = {
      type: "object",
      properties: {
        verdict: { type: "string" },
        tldr: { type: "string" },
      },
      required: ["verdict"],
      additionalProperties: false,
    };
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
      outputSchemas: {
        "review-verdict": reviewVerdictSchema,
      },
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: JSON.stringify({ verdict: "APPROVE", tldr: null }),
          controls: {
            outputSchemaName: "review-verdict",
          },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        structuredOutput: { verdict: "APPROVE" },
      });
      const turnStart = fakeFactory.requests.find(
        (request) => request.method === "turn/start",
      );
      expect(turnStart?.params?.outputSchema).toEqual({
        type: "object",
        properties: {
          tldr: { anyOf: [{ type: "string" }, { type: "null" }] },
          verdict: { type: "string" },
        },
        required: ["tldr", "verdict"],
        additionalProperties: false,
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("passes registered output schemas to Codex app-server goal turns", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-goal-native-schema-test-"));
    const fakeFactory = new FakeAppServerFactory();
    const workerReportSchema = {
      type: "object",
      properties: {
        outcome: { type: "string" },
      },
      required: ["outcome"],
      additionalProperties: false,
    };
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        goalMode: true,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
      outputSchemas: {
        "worker-report": workerReportSchema,
      },
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: JSON.stringify({ outcome: "done" }),
          controls: {
            outputSchemaName: "worker-report",
          },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        structuredOutput: { outcome: "done" },
      });
      const turnStart = fakeFactory.requests.find(
        (request) => request.method === "turn/start",
      );
      expect(turnStart?.params?.outputSchema).toEqual(workerReportSchema);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
