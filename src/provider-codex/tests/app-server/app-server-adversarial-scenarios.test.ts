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
import { isManagedRunResumeValidationError } from "../../app-server/application/app-server-managed-run-mapper";

// Adversarial no-model-call scenarios: stale frames, late terminal frames and
// resume races must never corrupt output or take down healthy sibling runs.

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true }),
  ));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-adversarial-"));
  workspaces.push(path);
  return path;
}

function sessionFor(home: string) {
  return {
    home,
    codexHome: home,
    env: { CODEX_HOME: home },
    sessionHash: "adversarial-session",
    release: async () => undefined,
  };
}

function engineFor(
  factory: FakeAppServerFactory,
  options: { goalMode?: boolean; runStore?: InMemoryManagedRunStore } = {},
): CodexAppServerExecutionEngine {
  return new CodexAppServerExecutionEngine({
    codexBinaryPath: "/fake/codex",
    processFactory: factory.create,
    cleanThreadPrewarm: false,
    timeoutMs: 5000,
    ...(options.goalMode === undefined ? {} : { goalMode: options.goalMode }),
    ...(options.runStore === undefined ? {} : { runStore: options.runStore }),
  });
}

function run(
  engine: CodexAppServerExecutionEngine,
  home: string,
  prompt: string,
  onTextDelta?: (text: string) => void,
) {
  return engine.run({
    session: sessionFor(home),
    workspacePath: home,
    model: "gpt-test",
    reasoningEffort: "low",
    runner: new StaticRunner(""),
    redactor: new DefaultRedactor(),
    abortSignal: new AbortController().signal,
    ...(onTextDelta === undefined ? {} : { onTextDelta }),
    prompt,
  });
}

function outputOf(result: unknown): string {
  return String((result as { outputText?: unknown }).outputText ?? "");
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDeltas(deltas: string[], expected: string): Promise<void> {
  for (let waited = 0; waited < 2000; waited += 5) {
    if (deltas.join("").includes(expected)) return;
    await pause(5);
  }
  throw new Error(`synthetic deltas never reached ${expected}`);
}

describe("app-server adversarial scenarios without model calls", () => {
  it("ignores a stale-frame flood instead of killing the live turn", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      emitTurnEventsWithStartResponse: true,
      suppressTurnCompletion: true,
      agentMessageDeltas: ["original-output"],
    });
    const engine = engineFor(factory);
    try {
      const deltas: string[] = [];
      const pending = run(engine, home, "flood-target", (text) => deltas.push(text));
      await waitForDeltas(deltas, "original-output");
      // 130 junk frames with unknown turn ids while the real turn is open.
      for (let index = 0; index < 130; index += 1) {
        factory.processes[0]!.stdout.emit(
          "data",
          `${JSON.stringify({
            method: "item/agentMessage/delta",
            params: { turnId: `stale-${index}`, delta: "junk" },
          })}\n`,
        );
      }
      factory.processes[0]!.stdout.emit(
        "data",
        `${JSON.stringify({
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: { type: "completed" } } },
        })}\n`,
      );
      const result = await pending;
      expect(outputOf(result)).toContain("original-output");
      expect(outputOf(result)).not.toContain("junk");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("keeps early deltas that arrive before turn/started on an aliased id", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      mismatchTurnStartResponseId: true,
      reuseActualTurnId: "actual-turn-1",
      emitDeltaBeforeTurnStarted: true,
      agentMessageDeltas: ["early-delta ", "later-delta"],
    });
    const engine = engineFor(factory);
    try {
      const result = await run(engine, home, "alias-early");
      const output = outputOf(result);
      expect(output).toContain("early-delta");
      expect(output).toContain("later-delta");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("fences output mutations and text deltas after turn/completed", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      emitTurnEventsWithStartResponse: true,
      suppressTurnCompletion: true,
      agentMessageDeltas: ["original-output"],
    });
    const engine = engineFor(factory);
    const deltas: string[] = [];
    try {
      const pending = run(engine, home, "fence-target", (text) => deltas.push(text));
      await waitForDeltas(deltas, "original-output");
      factory.processes[0]!.stdout.emit(
        "data",
        [
          JSON.stringify({
            method: "turn/completed",
            params: { turn: { id: "turn-1", status: { type: "completed" } } },
          }),
          JSON.stringify({
            method: "item/agentMessage/delta",
            params: { turnId: "turn-1", delta: "late-garbage" },
          }),
          JSON.stringify({
            method: "item/completed",
            params: {
              turnId: "turn-1",
              item: {
                type: "agentMessage",
                content: [{ type: "output_text", text: "late-replacement" }],
              },
            },
          }),
        ].join("\n") + "\n",
      );
      const result = await pending;
      const output = outputOf(result);
      expect(output).toContain("original-output");
      expect(output).not.toContain("late-garbage");
      expect(output).not.toContain("late-replacement");
      expect(deltas.join("")).not.toContain("late-garbage");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("keeps the shared session alive when a duplicate resume loses the store race", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      initialGoals: {
        "resume-race-thread": { objective: "resume race", status: "active" },
      },
    });
    const runStore = new InMemoryManagedRunStore();
    const resumeHandle = {
      runId: "adversarial-resume-run",
      providerId: "codex",
      agentId: "codex-json",
      workspacePath: home,
      threadId: "resume-race-thread",
    };
    const request = {
      id: "adversarial-resume-request",
      kind: "decision_required" as const,
      audience: "user" as const,
      question: "Continue the resume-race run?",
    };
    await runStore.saveWaitingInput({
      runId: resumeHandle.runId,
      resumeHandle,
      request,
      now: new Date(),
    });
    const engine = engineFor(factory, { goalMode: true, runStore });
    const resumeOnce = () =>
      engine
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
        .then(() => "ok" as const, (error: unknown) => error as Error);
    try {
      const [first, second] = await Promise.all([resumeOnce(), resumeOnce()]);
      const outcomes = [first, second];
      const winners = outcomes.filter((outcome) => outcome === "ok");
      const losers = outcomes.filter(
        (outcome): outcome is Error => outcome instanceof Error,
      );
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      // The loser lost a store race before anything reached the provider, so its
      // failure is a caller-side validation error and must not tear the session down.
      expect(isManagedRunResumeValidationError(losers[0]!)).toBe(true);
      expect(factory.spawnCount).toBe(1);
      expect(factory.processes[0]!.isExited()).toBe(false);
      const followUp = await run(engine, home, "resume-race-followup");
      expect(outputOf(followUp)).toContain("resume-race-followup");
      expect(factory.spawnCount).toBe(1);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("ignores a junk turn/started alias flood instead of killing the live turn", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      emitTurnEventsWithStartResponse: true,
      suppressTurnCompletion: true,
      agentMessageDeltas: ["original-output"],
    });
    const engine = engineFor(factory);
    const deltas: string[] = [];
    try {
      const pending = run(engine, home, "alias-flood-target", (text) =>
        deltas.push(text),
      );
      await waitForDeltas(deltas, "original-output");
      const turnStart = factory.requests.find(
        (request) => request.method === "turn/start",
      );
      const threadId = String(
        (turnStart?.params as { threadId?: unknown } | undefined)?.threadId ?? "",
      );
      // 130 junk turn/started frames with unique ids while the real turn is open.
      for (let index = 0; index < 130; index += 1) {
        factory.processes[0]!.stdout.emit(
          "data",
          `${JSON.stringify({
            method: "turn/started",
            params: {
              threadId,
              turn: { id: `stale-${index}`, status: "inProgress" },
            },
          })}\n`,
        );
      }
      factory.processes[0]!.stdout.emit(
        "data",
        `${JSON.stringify({
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: { type: "completed" } } },
        })}\n`,
      );
      const result = await pending;
      expect(outputOf(result)).toContain("original-output");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("ignores an unattributable turn/aborted instead of failing every live turn", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      emitTurnEventsWithStartResponse: true,
      suppressTurnCompletion: true,
    });
    const engine = engineFor(factory);
    const deltas: string[] = [];
    const collect = (text: string) => deltas.push(text);
    try {
      const first = run(engine, home, "abort-first", collect);
      const second = run(engine, home, "abort-second", collect);
      await waitForDeltas(deltas, "abort-first");
      await waitForDeltas(deltas, "abort-second");
      const turnStarts = factory.requests.filter(
        (request) => request.method === "turn/start",
      );
      const firstThreadId = String(
        (
          turnStarts.find((request) =>
            JSON.stringify(request.params).includes("abort-first"),
          )?.params as { threadId?: unknown } | undefined
        )?.threadId ?? "",
      );
      factory.processes[0]!.stdout.emit(
        "data",
        [
          JSON.stringify({
            method: "turn/aborted",
            params: { threadId: firstThreadId, reason: "thread-only-abort" },
          }),
          JSON.stringify({
            method: "turn/aborted",
            params: { reason: "unattributable-abort" },
          }),
        ].join("\n") + "\n",
      );
      factory.processes[0]!.stdout.emit(
        "data",
        [
          JSON.stringify({
            method: "turn/completed",
            params: { turn: { id: "turn-1", status: { type: "completed" } } },
          }),
          JSON.stringify({
            method: "turn/completed",
            params: { turn: { id: "turn-2", status: { type: "completed" } } },
          }),
        ].join("\n") + "\n",
      );
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(outputOf(firstResult)).toContain("abort-first");
      expect(outputOf(secondResult)).toContain("abort-second");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);
});
