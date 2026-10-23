import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../../codex-app-server-execution-engine";
import {
  FakeAppServerFactory,
  type FakeAppServerFactoryOptions,
} from "../../app-server/testing/fake-app-server";
import { StaticRunner } from "../codex-provider-test-support";
import { InMemoryManagedRunStore } from "../../codex-app-server-managed-run-store";
import {
  isExplicitTurnStartRejection,
  isReplaySafeTurnStartRejection,
  turnFailureError,
} from "../../app-server/application/app-server-turn-failure";
import { AppServerRequestMayHaveReachedProviderError } from "../../app-server/domain/app-server-execution-safety";
import { AppServerUsageError } from "../../app-server/domain/app-server-usage-error";

// Load and failure storms through the synthetic fake app-server: no model calls,
// no official Codex package, deterministic request counters instead of wall-clock.

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true }),
  ));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-load-scenarios-"));
  workspaces.push(path);
  return path;
}

function sessionFor(home: string) {
  return {
    home,
    codexHome: home,
    env: { CODEX_HOME: home },
    sessionHash: "load-session",
    release: async () => undefined,
  };
}

function engineFor(
  factory: FakeAppServerFactory,
  options: {
    timeoutMs?: number;
    cleanThreadPrewarm?: boolean;
    reconnectGraceMs?: number;
    goalMode?: boolean;
    runStore?: InMemoryManagedRunStore;
  } = {},
): CodexAppServerExecutionEngine {
  return new CodexAppServerExecutionEngine({
    codexBinaryPath: "/fake/codex",
    processFactory: factory.create,
    cleanThreadPrewarm: options.cleanThreadPrewarm ?? false,
    timeoutMs: options.timeoutMs ?? 5000,
    ...(options.reconnectGraceMs === undefined
      ? {}
      : { reconnectGraceMs: options.reconnectGraceMs }),
    ...(options.goalMode === undefined ? {} : { goalMode: options.goalMode }),
    ...(options.runStore === undefined ? {} : { runStore: options.runStore }),
  });
}

function run(
  engine: CodexAppServerExecutionEngine,
  home: string,
  prompt: string,
  abortSignal = new AbortController().signal,
) {
  return engine.run({
    session: sessionFor(home),
    workspacePath: home,
    model: "gpt-test",
    reasoningEffort: "low",
    runner: new StaticRunner(""),
    redactor: new DefaultRedactor(),
    abortSignal,
    prompt,
  });
}

function outputOf(result: unknown): string {
  return String((result as { outputText?: unknown }).outputText ?? "");
}

function warningCodesOf(result: unknown): readonly string[] {
  const warnings = (result as { warnings?: readonly { code?: unknown }[] }).warnings ?? [];
  return warnings.map((warning) => String(warning.code ?? ""));
}

function reasonMessage(outcome: PromiseSettledResult<unknown>): string {
  return outcome.status === "rejected"
    ? String((outcome.reason as Error)?.message ?? outcome.reason)
    : "";
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTurnStarts(
  factory: FakeAppServerFactory,
  count: number,
): Promise<void> {
  for (let waited = 0; waited < 400; waited += 5) {
    if (
      factory.requests.filter((request) => request.method === "turn/start")
        .length >= count
    ) {
      return;
    }
    await pause(5);
  }
  throw new Error(`synthetic turn starts never reached ${count}`);
}

describe("app-server load scenarios without model calls", () => {
  it("completes eight concurrent isolated runs with their own outputs and leaves no processes", async () => {
    const homes = await Promise.all(Array.from({ length: 8 }, () => workspace()));
    const factory = new FakeAppServerFactory();
    const engine = engineFor(factory);
    try {
      const results = await Promise.all(
        homes.map((home, index) => run(engine, home, `load-prompt-${index}`)),
      );
      results.forEach((result, index) => {
        expect(outputOf(result)).toContain(`load-prompt-${index}`);
      });
      expect(factory.spawnCount).toBe(8);
      await engine.dispose();
      expect(factory.processes.filter((process) => !process.isExited())).toHaveLength(0);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("routes four concurrent runs sharing one slot to their own prompts", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory();
    const engine = engineFor(factory);
    try {
      const prompts = ["shared-a", "shared-b", "shared-c", "shared-d"];
      const results = await Promise.all(
        prompts.map((prompt) => run(engine, home, `cross-talk:${prompt}`)),
      );
      results.forEach((result, index) => {
        const output = outputOf(result);
        expect(output).toContain(`cross-talk:${prompts[index]}`);
        prompts.forEach((prompt, other) => {
          if (other !== index) expect(output).not.toContain(`cross-talk:${prompt}`);
        });
      });
      expect(factory.spawnCount).toBe(1);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("settles every run in a mixed failure storm and isolates the successes", async () => {
    const homes = await Promise.all(Array.from({ length: 8 }, () => workspace()));
    const failing = new Map<string, FakeAppServerFactoryOptions>([
      [homes[5]!, { emitTopLevelErrorOnTurn: "synthetic provider failure" }],
      [homes[6]!, { emitProcessErrorOnTurn: true }],
      [homes[7]!, { failThreadStart: true }],
    ]);
    const factories: FakeAppServerFactory[] = [];
    const engine = new CodexAppServerExecutionEngine({
      codexBinaryPath: "/fake/codex",
      processFactory: (input) => {
        const factory = new FakeAppServerFactory({
          availableModels: [{ model: "gpt-test" }],
          ...(failing.get(input.env.CODEX_HOME ?? "") ?? {}),
        });
        factories.push(factory);
        return factory.create(input);
      },
      cleanThreadPrewarm: false,
      timeoutMs: 5000,
    });
    try {
      const settled = await Promise.allSettled(
        homes.map((home, index) => run(engine, home, `storm-prompt-${index}`)),
      );
      settled.slice(0, 5).forEach((outcome, index) => {
        expect(outcome.status).toBe("fulfilled");
        if (outcome.status === "fulfilled") {
          expect(outputOf(outcome.value)).toContain(`storm-prompt-${index}`);
        }
      });
      expect(settled[5]?.status).toBe("rejected");
      expect(settled[6]?.status).toBe("rejected");
      expect(settled[7]?.status).toBe("rejected");
      expect(reasonMessage(settled[5]!)).toMatch(/codex_app_server_error/);
      expect(reasonMessage(settled[6]!)).toMatch(/codex_app_server_turn_error:fake app-server process failed/);
      expect(reasonMessage(settled[7]!)).toMatch(/codex_app_server_thread_start_failed/);
    } finally {
      await engine.dispose();
      factories.forEach((factory) => factory.processes.forEach((process) => process.kill()));
    }
  }, 20000);

  it("isolates a failing run from concurrent siblings sharing one process", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      failTurnStartNumbers: [2],
      turnStartError: "synthetic sibling turn start failure",
    });
    const engine = engineFor(factory);
    try {
      const prompts = ["sibling-a", "sibling-b", "sibling-c", "sibling-d"];
      const settled = await Promise.allSettled(
        prompts.map((prompt) => run(engine, home, `sibling:${prompt}`)),
      );
      const rejected = settled.filter((outcome) => outcome.status === "rejected");
      const fulfilled = settled.filter(
        (outcome) => outcome.status === "fulfilled",
      ) as PromiseFulfilledResult<Awaited<ReturnType<typeof run>>>[];
      expect(rejected).toHaveLength(1);
      expect(reasonMessage(rejected[0]!)).toMatch(/codex_app_server_turn_start_failed/);
      expect(fulfilled).toHaveLength(3);
      const outputs = fulfilled.map((outcome) => outputOf(outcome.value));
      outputs.forEach((output) => {
        expect(prompts.filter((prompt) => output.includes(`sibling:${prompt}`))).toHaveLength(1);
      });
      const matched = prompts.filter((prompt) =>
        outputs.some((output) => output.includes(`sibling:${prompt}`)));
      expect(matched).toHaveLength(3);
      expect(factory.spawnCount).toBe(1);
      expect(factory.processes[0]!.isExited()).toBe(false);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("retries a rejected prepared-thread turn exactly once with a fresh thread", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      failTurnStartNumbers: [1],
      turnStartError: "synthetic turn start rejection",
    });
    const engine = engineFor(factory, { cleanThreadPrewarm: true });
    try {
      await engine.prewarm({
        session: sessionFor(home),
        workspacePath: home,
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        model: "gpt-test",
        reasoningEffort: "low",
        abortSignal: new AbortController().signal,
      });
      const result = await run(engine, home, "prepared-retry-prompt");
      expect(outputOf(result)).toContain("prepared-retry-prompt");
      const turnStarts = factory.requests.filter((request) => request.method === "turn/start");
      expect(turnStarts).toHaveLength(2);
      const turnThreadIds = turnStarts.map((request) =>
        String((request.params as { threadId?: unknown } | undefined)?.threadId ?? ""));
      expect(new Set(turnThreadIds).size).toBe(2);
      expect(warningCodesOf(result)).toContain("codex_app_server_prepared_thread_failed");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("stops after one retry when the fresh thread turn start is rejected too", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      failTurnStartNumbers: [1, 2, 3],
      turnStartError: "synthetic turn start rejection",
    });
    const engine = engineFor(factory, { cleanThreadPrewarm: true });
    try {
      await engine.prewarm({
        session: sessionFor(home),
        workspacePath: home,
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        model: "gpt-test",
        reasoningEffort: "low",
        abortSignal: new AbortController().signal,
      });
      await expect(run(engine, home, "storm-bound-prompt")).rejects.toThrow(
        /codex_app_server_turn_start_failed/,
      );
      expect(factory.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("aborts half the runs mid-turn while the rest finish with their own outputs", async () => {
    const homes = await Promise.all(Array.from({ length: 6 }, () => workspace()));
    const controllers = new Map<string, AbortController>();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      onPrompt: (prompt) => {
        if (prompt.startsWith("abort-prompt")) controllers.get(prompt)?.abort();
      },
    });
    const engine = engineFor(factory);
    try {
      const settled = await Promise.allSettled(
        homes.map((home, index) => {
          const prompt = index % 2 === 0 ? `abort-prompt-${index}` : `keep-prompt-${index}`;
          const controller = new AbortController();
          controllers.set(prompt, controller);
          return run(engine, home, prompt, controller.signal);
        }),
      );
      settled.forEach((outcome, index) => {
        if (index % 2 === 0) {
          expect(outcome.status).toBe("rejected");
          expect(reasonMessage(outcome)).toMatch(/codex_app_server_aborted|codex_app_server_turn_aborted/);
        } else {
          expect(outcome.status).toBe("fulfilled");
          if (outcome.status === "fulfilled") {
            expect(outputOf(outcome.value)).toContain(`keep-prompt-${index}`);
          }
        }
      });
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("rejects a turn that never completes with a turn timeout", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      suppressTurnCompletion: true,
    });
    const engine = engineFor(factory, { timeoutMs: 750 });
    try {
      const outcome = await Promise.allSettled([run(engine, home, "hang-prompt")]);
      expect(outcome[0]?.status).toBe("rejected");
      expect(reasonMessage(outcome[0]!)).toMatch(/codex_app_server_turn_timeout/);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("rejects a turn whose final output is lost", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      suppressOutputTurnNumbers: [1],
    });
    const engine = engineFor(factory);
    try {
      await expect(run(engine, home, "lost-output-prompt")).rejects.toThrow(
        /codex_app_server_final_message_missing/,
      );
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("keeps the shared session alive when a prewarm warmup turn start is rejected", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      failTurnStartNumbers: [1],
      turnStartError: "synthetic warmup turn start failure",
    });
    const engine = engineFor(factory);
    try {
      await expect(engine.prewarm({
        session: sessionFor(home),
        workspacePath: home,
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        model: "gpt-test",
        reasoningEffort: "low",
        warmupPrompt: "warmup-prompt",
        abortSignal: new AbortController().signal,
      })).rejects.toThrow(/codex_app_server_turn_start_failed/);
      const result = await run(engine, home, "after-failed-prewarm");
      expect(outputOf(result)).toContain("after-failed-prewarm");
      expect(factory.spawnCount).toBe(1);
      expect(factory.processes[0]!.isExited()).toBe(false);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("recognizes a wrapped turn start rejection through the cause chain", () => {
    const rejection = turnFailureError(new Error("synthetic turn start failure"), {
      phase: "turn_start_rejected",
      turnNumber: 1,
      elapsedMs: 1,
    });
    expect(isExplicitTurnStartRejection(new AppServerUsageError(rejection))).toBe(true);
    expect(isExplicitTurnStartRejection(new Error("wrapped", { cause: rejection }))).toBe(true);
    expect(isReplaySafeTurnStartRejection(new AppServerUsageError(rejection))).toBe(true);
  });

  it("keeps disposing on a replay-unsafe turn start rejection", () => {
    const rejection = turnFailureError(new AppServerRequestMayHaveReachedProviderError(
      new Error("codex_app_server_turn_id_missing"),
      "turn/start",
    ), {
      phase: "turn_start_rejected",
      turnNumber: 1,
      elapsedMs: 1,
    });
    expect(isExplicitTurnStartRejection(rejection)).toBe(true);
    expect(isReplaySafeTurnStartRejection(rejection)).toBe(false);
  });

  it("keeps the shared session alive when a resume turn start is rejected", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      failTurnStartNumbers: [1],
      turnStartError: "synthetic resume turn start rejection",
    });
    const runStore = new InMemoryManagedRunStore();
    const resumeHandle = {
      runId: "load-resume-run",
      providerId: "codex",
      agentId: "codex-json",
      workspacePath: home,
      threadId: "load-resume-thread",
    };
    const request = {
      id: "load-resume-request",
      kind: "decision_required" as const,
      audience: "user" as const,
      question: "Continue the load-scenario run?",
    };
    await runStore.saveWaitingInput({
      runId: resumeHandle.runId,
      resumeHandle,
      request,
      now: new Date(),
    });
    const engine = engineFor(factory, { goalMode: true, runStore });
    try {
      const rejected = await engine
        .resume({
          runId: resumeHandle.runId,
          requestId: request.id,
          answer: "continue",
          resumeHandle,
          session: sessionFor(home),
          workspacePath: home,
          runner: new StaticRunner(""),
          redactor: new DefaultRedactor(),
          model: "gpt-test",
          reasoningEffort: "low",
          abortSignal: new AbortController().signal,
        })
        .then(() => null, (error: unknown) => error as Error);
      expect(rejected).toBeInstanceOf(AppServerUsageError);
      expect(rejected?.message).toMatch(/codex_app_server_turn_start_failed/);
      expect(isReplaySafeTurnStartRejection(rejected)).toBe(true);
      expect(factory.spawnCount).toBe(1);
      expect(factory.processes[0]!.isExited()).toBe(false);
      const result = await run(engine, home, "resume-sibling-prompt");
      expect(outputOf(result)).toContain("resume-sibling-prompt");
      expect(factory.spawnCount).toBe(1);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("still disposes the session when a resume turn start may have reached the provider", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      // An empty turn id in the turn/start response is the replay-unsafe
      // codex_app_server_turn_id_missing path: the request may have reached
      // the provider, so the shared session must be torn down.
      reuseActualTurnId: "",
    });
    const runStore = new InMemoryManagedRunStore();
    const resumeHandle = {
      runId: "load-veto-run",
      providerId: "codex",
      agentId: "codex-json",
      workspacePath: home,
      threadId: "load-veto-thread",
    };
    const request = {
      id: "load-veto-request",
      kind: "decision_required" as const,
      audience: "user" as const,
      question: "Continue the veto-scenario run?",
    };
    await runStore.saveWaitingInput({
      runId: resumeHandle.runId,
      resumeHandle,
      request,
      now: new Date(),
    });
    const engine = engineFor(factory, { goalMode: true, runStore });
    try {
      const rejected = await engine
        .resume({
          runId: resumeHandle.runId,
          requestId: request.id,
          answer: "continue",
          resumeHandle,
          session: sessionFor(home),
          workspacePath: home,
          runner: new StaticRunner(""),
          redactor: new DefaultRedactor(),
          model: "gpt-test",
          reasoningEffort: "low",
          abortSignal: new AbortController().signal,
        })
        .then(() => null, (error: unknown) => error as Error);
      expect(rejected?.message).toMatch(/codex_app_server_turn_id_missing/);
      expect(isReplaySafeTurnStartRejection(rejected)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(factory.processes[0]!.isExited()).toBe(true);
      await run(engine, home, "veto-followup-prompt").catch(() => undefined);
      expect(factory.spawnCount).toBe(2);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("keeps the shared session alive when goal mode wraps a turn start rejection", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      failTurnStartNumbers: [1],
      turnStartError: "synthetic goal turn start rejection",
    });
    const engine = engineFor(factory, { goalMode: true });
    try {
      const rejected = await run(engine, home, "goal-wrap-prompt").then(
        () => null,
        (error: unknown) => error as Error,
      );
      expect(rejected).toBeInstanceOf(AppServerUsageError);
      expect(rejected?.message).toMatch(/codex_app_server_turn_start_failed/);
      expect(isReplaySafeTurnStartRejection(rejected)).toBe(true);
      expect(factory.spawnCount).toBe(1);
      expect(factory.processes[0]!.isExited()).toBe(false);
      const result = await run(engine, home, "goal-sibling-prompt");
      expect(outputOf(result)).toContain("goal-sibling-prompt");
      expect(factory.spawnCount).toBe(1);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("settles a reconnect storm: live turns outlast the grace window and only silence times out", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      emitTurnEventsWithStartResponse: true,
      suppressTurnCompletion: true,
      agentMessageDeltas: [],
    });
    const engine = engineFor(factory, { reconnectGraceMs: 250 });
    const turnIds = ["turn-1", "turn-2", "turn-3", "turn-4"];
    const emit = (frame: unknown) => {
      factory.processes[0]!.stdout.emit("data", `${JSON.stringify(frame)}\n`);
    };
    const reconnecting = (turnId: string) =>
      emit({
        method: "error",
        params: { turnId, error: { message: "Reconnecting... 1/8" }, willRetry: true },
      });
    try {
      const pending = turnIds.map((_, index) =>
        run(engine, home, `reconnect-storm-${index}`).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: Error) => ({ status: "rejected" as const, error }),
        ),
      );
      await waitForTurnStarts(factory, 4);
      await pause(80);
      // A network drop defers every in-flight turn onto its reconnect grace timer.
      for (const turnId of turnIds) reconnecting(turnId);
      await pause(100);
      // Each turn shows activity, which must clear its grace timer...
      const turnStarts = factory.requests.filter(
        (request) => request.method === "turn/start",
      );
      for (const [index, turnId] of turnIds.entries()) {
        const threadId = String(
          (turnStarts[index]?.params as { threadId?: unknown } | undefined)
            ?.threadId ?? "",
        );
        emit({
          method: "item/started",
          params: { turnId, threadId, item: { type: "commandExecution", id: `cmd-${turnId}` } },
        });
      }
      // ...and is still working well past the grace window before it finishes.
      await pause(300);
      for (const turnId of turnIds) {
        emit({
          method: "item/completed",
          params: {
            turnId,
            item: { type: "agentMessage", content: [{ type: "output_text", text: `reconnected:${turnId}` }] },
          },
        });
        emit({ method: "turn/completed", params: { turn: { id: turnId, status: { type: "completed" } } } });
      }
      const outcomes = await Promise.all(pending);
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(rejected).toHaveLength(0);
      const outputs = outcomes.map((outcome) =>
        outputOf((outcome as { value: unknown }).value),
      );
      expect(new Set(outputs)).toEqual(
        new Set(turnIds.map((turnId) => `reconnected:${turnId}`)),
      );
      // A turn that reconnects and then goes silent must time out on its own.
      const silent = run(engine, home, "reconnect-silent-prompt").then(
        () => null,
        (error: Error) => error as Error,
      );
      await waitForTurnStarts(factory, 5);
      await pause(80);
      reconnecting("turn-5");
      const timedOut = await silent;
      expect(timedOut?.message).toMatch(/codex_app_server_reconnect_timeout/);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);
});
