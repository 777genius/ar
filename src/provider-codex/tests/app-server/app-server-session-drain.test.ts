import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../../codex-app-server-execution-engine";
import { FakeAppServerFactory } from "../../app-server/testing/fake-app-server";
import { RecordingJsonEngine, StaticRunner } from "../codex-provider-test-support";
import { InMemoryManagedRunStore } from "../../codex-app-server-managed-run-store";
import { isReplaySafeTurnStartRejection } from "../../app-server/application/app-server-turn-failure";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true }),
  ));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-drain-"));
  workspaces.push(path);
  return path;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  for (let waited = 0; waited < 4000; waited += 5) {
    if (check()) return;
    await pause(5);
  }
  throw new Error(`condition never reached: ${what}`);
}

function outputOf(result: unknown): string {
  return String((result as { outputText?: unknown }).outputText ?? "");
}

// The fake generates turn ids per process as turn-N in request-handling order
// (fake-app-server.ts: nextTurnId), and turn/start params carry no turn id.
function turnIdFrom(
  factory: FakeAppServerFactory,
  fromIndex: number,
  prompt: string,
): string {
  let count = 0;
  for (let index = fromIndex; index < factory.requests.length; index += 1) {
    const request = factory.requests[index]!;
    if (request.method !== "turn/start") continue;
    count += 1;
    if (JSON.stringify(request.params).includes(prompt)) return `turn-${count}`;
  }
  throw new Error(`no turn/start request for prompt ${prompt} after ${fromIndex}`);
}

function expectOwnError(error: unknown, needle: string): void {
  const text = String(error);
  expect(text).toContain(needle);
  expect(text).not.toContain("codex_app_server_stopped");
}

function harness() {
  const factory = new FakeAppServerFactory({
    availableModels: [{ model: "gpt-test" }],
    emitTurnEventsWithStartResponse: true,
    suppressTurnCompletion: true,
  });
  const engine = new CodexAppServerExecutionEngine({
    codexBinaryPath: "/fake/codex",
    processFactory: factory.create,
    cleanThreadPrewarm: false,
    timeoutMs: 5000,
  });
  return { factory, engine };
}

function startInput(
  _engine: CodexAppServerExecutionEngine,
  home: string,
  prompt: string,
  deltas?: string[],
) {
  return {
    session: {
      home, codexHome: home, env: { CODEX_HOME: home },
      sessionHash: "drain-session", release: async () => undefined,
    },
    workspacePath: home,
    model: "gpt-test",
    reasoningEffort: "low" as const,
    runner: new StaticRunner(""),
    redactor: new DefaultRedactor(),
    abortSignal: new AbortController().signal,
    ...(deltas === undefined ? {} : { onTextDelta: (text: string) => deltas.push(text) }),
    prompt,
  };
}

function startRun(
  engine: CodexAppServerExecutionEngine,
  home: string,
  prompt: string,
  deltas: string[],
) {
  return engine.run(startInput(engine, home, prompt, deltas));
}

async function waitForDelta(deltas: string[], prompt: string): Promise<void> {
  await waitUntil(
    () => deltas.join("").includes(`app-server output:${prompt}`),
    `delta for ${prompt}`,
  );
}

function emit(
  factory: FakeAppServerFactory,
  processIndex: number,
  frame: unknown,
): void {
  factory.processes[processIndex]!.stdout.emit(
    "data",
    `${JSON.stringify(frame)}\n`,
  );
}

function failFrame(turnId: string, message: string): unknown {
  return {
    method: "turn/completed",
    params: {
      turn: {
        id: turnId,
        status: { type: "failed" },
        error: { message },
      },
    },
  };
}

function doneFrame(turnId: string): unknown {
  return {
    method: "turn/completed",
    params: { turn: { id: turnId, status: { type: "completed" } } },
  };
}

describe("bug D: run failure must not kill healthy siblings", () => {
  it("lets the sibling finish and never reuses the poisoned session", async () => {
    const home = await workspace();
    const { factory, engine } = harness();
    try {
      const deltas: string[] = [];
      const failing = startRun(engine, home, "fail-me", deltas);
      const sibling = startRun(engine, home, "survive-me", deltas);
      await waitForDelta(deltas, "fail-me");
      await waitForDelta(deltas, "survive-me");
      emit(factory, 0, failFrame(turnIdFrom(factory, 0, "fail-me"), "boom"));
      const failError = await failing.then(() => null, (error: unknown) => error);
      expectOwnError(failError, "boom");
      emit(factory, 0, doneFrame(turnIdFrom(factory, 0, "survive-me")));
      const result = await sibling;
      expect(outputOf(result)).toContain("app-server output:survive-me");
      // The poisoned session is not handed out again: a fresh process spawns.
      const boundary = factory.requests.length;
      const third = startRun(engine, home, "after-drain", deltas);
      await waitUntil(() => factory.processes.length === 2, "fresh process spawned");
      await waitForDelta(deltas, "after-drain");
      emit(factory, 1, doneFrame(turnIdFrom(factory, boundary, "after-drain")));
      const thirdResult = await third;
      expect(outputOf(thirdResult)).toContain("app-server output:after-drain");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("keeps the shared session when a goal-thread turn start rejection is replay-safe", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      failTurnStartNumbers: [1],
      turnStartError: "synthetic logical turn start rejection",
    });
    const engine = new CodexAppServerExecutionEngine({
      codexBinaryPath: "/fake/codex",
      processFactory: factory.create,
      cleanThreadPrewarm: false,
      goalMode: true,
      timeoutMs: 5000,
    });
    try {
      const rejected = await engine
        .runLogicalThread(startInput(engine, home, "logical-reject"))
        .then(() => null, (error: unknown) => error);
      expect(String(rejected)).toMatch(/turn_start/);
      expect(isReplaySafeTurnStartRejection(rejected)).toBe(true);
      expect(factory.spawnCount).toBe(1);
      expect(factory.processes[0]!.isExited()).toBe(false);
      const result = await engine.run(startInput(engine, home, "logical-sibling"));
      expect(outputOf(result)).toContain("app-server output:logical-sibling");
      expect(factory.spawnCount).toBe(1);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("still disposes eagerly when a solo run fails", async () => {
    const home = await workspace();
    const { factory, engine } = harness();
    try {
      const deltas: string[] = [];
      const solo = startRun(engine, home, "solo-fail", deltas);
      await waitForDelta(deltas, "solo-fail");
      emit(factory, 0, failFrame(turnIdFrom(factory, 0, "solo-fail"), "solo-boom"));
      const soloError = await solo.then(() => null, (error: unknown) => error);
      expectOwnError(soloError, "solo-boom");
      const boundary = factory.requests.length;
      const after = startRun(engine, home, "after-solo", deltas);
      await waitUntil(() => factory.processes.length === 2, "fresh process after solo dispose");
      await waitForDelta(deltas, "after-solo");
      emit(factory, 1, doneFrame(turnIdFrom(factory, boundary, "after-solo")));
      expect(outputOf(await after)).toContain("app-server output:after-solo");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("gives each of two concurrent failures its own error and recovers", async () => {
    const home = await workspace();
    const { factory, engine } = harness();
    try {
      const deltas: string[] = [];
      const first = startRun(engine, home, "fail-a", deltas);
      const second = startRun(engine, home, "fail-b", deltas);
      await waitForDelta(deltas, "fail-a");
      await waitForDelta(deltas, "fail-b");
      emit(factory, 0, failFrame(turnIdFrom(factory, 0, "fail-a"), "boom-a"));
      const firstError = await first.then(() => null, (error: unknown) => error);
      expectOwnError(firstError, "boom-a");
      emit(factory, 0, failFrame(turnIdFrom(factory, 0, "fail-b"), "boom-b"));
      const secondError = await second.then(() => null, (error: unknown) => error);
      expectOwnError(secondError, "boom-b");
      const boundary = factory.requests.length;
      const third = startRun(engine, home, "after-storm", deltas);
      await waitUntil(() => factory.processes.length === 2, "fresh process after storm");
      await waitForDelta(deltas, "after-storm");
      emit(factory, 1, doneFrame(turnIdFrom(factory, boundary, "after-storm")));
      expect(outputOf(await third)).toContain("app-server output:after-storm");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("serves a run that arrives while the poisoned session drains", async () => {
    const home = await workspace();
    const { factory, engine } = harness();
    try {
      const deltas: string[] = [];
      const failing = startRun(engine, home, "drain-fail", deltas);
      const sibling = startRun(engine, home, "drain-survive", deltas);
      await waitForDelta(deltas, "drain-fail");
      await waitForDelta(deltas, "drain-survive");
      emit(factory, 0, failFrame(turnIdFrom(factory, 0, "drain-fail"), "drain-boom"));
      const failError = await failing.then(() => null, (error: unknown) => error);
      expectOwnError(failError, "drain-boom");
      // Arrives while the sibling is still draining the poisoned session.
      const boundary = factory.requests.length;
      const late = startRun(engine, home, "during-drain", deltas);
      emit(factory, 0, doneFrame(turnIdFrom(factory, 0, "drain-survive")));
      expect(outputOf(await sibling)).toContain("app-server output:drain-survive");
      await waitUntil(() => factory.processes.length === 2, "late run on a fresh process");
      await waitForDelta(deltas, "during-drain");
      emit(factory, 1, doneFrame(turnIdFrom(factory, boundary, "during-drain")));
      expect(outputOf(await late)).toContain("app-server output:during-drain");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);
});

function turnStartCount(factory: FakeAppServerFactory): number {
  return factory.requests.filter((request) => request.method === "turn/start").length;
}

// The fake numbers turns per process as turn-N in request-handling order, so
// the concurrent sibling is turn-1 and the failing phase turn is turn-2.
async function failSecondTurn(factory: FakeAppServerFactory, message: string): Promise<void> {
  await waitUntil(() => turnStartCount(factory) >= 2, "second turn started");
  await pause(10);
  emit(factory, 0, failFrame("turn-2", message));
}

function seamHarness(goalMode: boolean) {
  const factory = new FakeAppServerFactory({
    availableModels: [{ model: "gpt-test" }],
    emitTurnEventsWithStartResponse: true,
    suppressTurnCompletion: true,
  });
  const runStore = new InMemoryManagedRunStore();
  const engine = new CodexAppServerExecutionEngine({
    codexBinaryPath: "/fake/codex",
    processFactory: factory.create,
    cleanThreadPrewarm: false,
    timeoutMs: 5000,
    runStore,
    goalMode,
  });
  return { factory, engine, runStore };
}

// Manual turn completion bypasses the fake's goal marking, and the goal runner
// linearizes on the thread/goal/get response, so the fake's goal state is set
// through its stdin request loop (the client ignores unknown response ids).
function goalThreadIdOf(factory: FakeAppServerFactory, last = false): string {
  const requests = factory.requests.filter((request) => request.method === "thread/goal/set");
  const request = last ? requests[requests.length - 1] : requests[0];
  if (!request) throw new Error("no thread/goal/set request");
  return String((request.params as { threadId?: unknown } | undefined)?.threadId ?? "");
}

function completeFakeGoal(factory: FakeAppServerFactory, processIndex: number, threadId: string): void {
  factory.processes[processIndex]!.stdin.write(
    `${JSON.stringify({
      id: 97531,
      method: "thread/goal/set",
      params: { threadId, objective: "probe", status: "complete" },
    })}\n`,
  );
}

describe("bug D seams: resume and prewarm phases", () => {
  it("keeps the sibling draining through a failed resume", async () => {
    const home = await workspace();
    const { factory, engine, runStore } = seamHarness(true);
    try {
      const deltas: string[] = [];
      const sibling = engine.run(startInput(engine, home, "sib-resume", deltas));
      await waitForDelta(deltas, "sib-resume");
      const resumeHandle = {
        runId: "drain-resume-run",
        providerId: "codex",
        agentId: "codex-json",
        workspacePath: home,
        threadId: "drain-resume-thread",
      };
      const request = {
        id: "drain-resume-request",
        kind: "decision_required" as const,
        audience: "user" as const,
        question: "Continue the drain run?",
      };
      await runStore.saveWaitingInput({
        runId: resumeHandle.runId,
        resumeHandle,
        request,
        now: new Date(),
      });
      const resumePromise = engine
        .resume({
          runId: resumeHandle.runId,
          requestId: request.id,
          answer: "continue",
          resumeHandle,
          session: startInput(engine, home, "ignored").session,
          workspacePath: home,
          runner: new StaticRunner(""),
          redactor: new DefaultRedactor(),
          model: "gpt-test",
          reasoningEffort: "low",
          abortSignal: new AbortController().signal,
        })
        .then(() => null, (error: unknown) => error);
      await failSecondTurn(factory, "resume-boom");
      expectOwnError(await resumePromise, "resume-boom");
      completeFakeGoal(factory, 0, goalThreadIdOf(factory));
      emit(factory, 0, doneFrame("turn-1"));
      const result = await sibling;
      expect(outputOf(result)).toContain("app-server output:sib-resume");
      const third = engine.run(startInput(engine, home, "after-resume-seam", deltas));
      await waitUntil(() => factory.processes.length === 2, "fresh process after resume drain");
      await waitForDelta(deltas, "after-resume-seam");
      await pause(10);
      completeFakeGoal(factory, 1, goalThreadIdOf(factory, true));
      emit(factory, 1, doneFrame("turn-1"));
      expect(outputOf(await third)).toContain("app-server output:after-resume-seam");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("keeps the sibling draining through a failed prewarm", async () => {
    const home = await workspace();
    const { factory, engine } = seamHarness(false);
    try {
      const deltas: string[] = [];
      const sibling = engine.run(startInput(engine, home, "sib-prewarm", deltas));
      await waitForDelta(deltas, "sib-prewarm");
      const prewarmPromise = engine
        .prewarm({
          session: startInput(engine, home, "ignored").session,
          workspacePath: home,
          runner: new StaticRunner(""),
          redactor: new DefaultRedactor(),
          model: "gpt-test",
          reasoningEffort: "low",
          warmupPrompt: "warmup-seam",
          abortSignal: new AbortController().signal,
        })
        .then(() => null, (error: unknown) => error);
      await failSecondTurn(factory, "prewarm-boom");
      expectOwnError(await prewarmPromise, "prewarm-boom");
      emit(factory, 0, doneFrame("turn-1"));
      const result = await sibling;
      expect(outputOf(result)).toContain("app-server output:sib-prewarm");
      const third = engine.run(startInput(engine, home, "after-prewarm-seam", deltas));
      await waitUntil(() => factory.processes.length === 2, "fresh process after prewarm drain");
      await waitForDelta(deltas, "after-prewarm-seam");
      await pause(10);
      emit(factory, 1, doneFrame("turn-1"));
      expect(outputOf(await third)).toContain("app-server output:after-prewarm-seam");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);
});

describe("app-server dispose race boundary", () => {
  it("settles an in-flight run with its own stopped error on engine.dispose()", async () => {
    const home = await workspace();
    const { factory, engine } = seamHarness(false);
    const deltas: string[] = [];
    const running = engine.run(startInput(engine, home, "dispose-race", deltas));
    await waitForDelta(deltas, "dispose-race");
    await engine.dispose();
    const error = await running.then(() => null, (err: unknown) => err);
    expect(String(error)).toContain("codex_app_server_stopped");
    factory.processes.forEach((process) => process.kill());
  }, 20000);
});

function interruptsOf(factory: FakeAppServerFactory): { threadId: string; turnId: string }[] {
  return factory.requests
    .filter((request) => request.method === "turn/interrupt")
    .map((request) => ({
      threadId: String((request.params as { threadId?: unknown } | undefined)?.threadId ?? ""),
      turnId: String((request.params as { turnId?: unknown } | undefined)?.turnId ?? ""),
    }));
}

function threadIdFor(factory: FakeAppServerFactory, prompt: string): string {
  const request = factory.requests.find((candidate) =>
    candidate.method === "turn/start" && JSON.stringify(candidate.params).includes(prompt));
  return String((request?.params as { threadId?: unknown } | undefined)?.threadId ?? "");
}

// A deferred dispose keeps the shared process alive, so a turn the failing run
// stopped waiting on keeps executing on the provider unless it is interrupted.
describe("bug D seams: abandoned turns on a draining session", () => {
  it("interrupts the aborted run's turn while the sibling keeps running", async () => {
    const home = await workspace();
    const { factory, engine } = harness();
    try {
      const deltas: string[] = [];
      const victimAbort = new AbortController();
      const victim = engine
        .run({ ...startInput(engine, home, "abort-victim", deltas), abortSignal: victimAbort.signal })
        .then(() => null, (error: unknown) => error);
      const sibling = startRun(engine, home, "abort-sibling", deltas);
      sibling.catch(() => undefined);
      await waitForDelta(deltas, "abort-victim");
      await waitForDelta(deltas, "abort-sibling");
      const victimTurn = turnIdFrom(factory, 0, "abort-victim");
      const siblingTurn = turnIdFrom(factory, 0, "abort-sibling");
      victimAbort.abort();
      expect(String(await victim)).toContain("codex_app_server_turn_aborted");
      expect(factory.processes[0]!.isExited()).toBe(false);
      expect(interruptsOf(factory)).toEqual([
        { threadId: threadIdFor(factory, "abort-victim"), turnId: victimTurn },
      ]);
      emit(factory, 0, doneFrame(siblingTurn));
      expect(outputOf(await sibling)).toContain("app-server output:abort-sibling");
      expect(interruptsOf(factory).map((entry) => entry.turnId)).not.toContain(siblingTurn);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("interrupts a timed-out run's turn while the sibling keeps running", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      emitTurnEventsWithStartResponse: true,
      suppressTurnCompletion: true,
    });
    const engine = new CodexAppServerExecutionEngine({
      codexBinaryPath: "/fake/codex",
      processFactory: factory.create,
      cleanThreadPrewarm: false,
      timeoutMs: 1500,
    });
    try {
      const deltas: string[] = [];
      const victim = startRun(engine, home, "timeout-victim", deltas)
        .then(() => null, (error: unknown) => error);
      await waitForDelta(deltas, "timeout-victim");
      await pause(700);
      const sibling = startRun(engine, home, "timeout-sibling", deltas);
      sibling.catch(() => undefined);
      await waitForDelta(deltas, "timeout-sibling");
      const victimTurn = turnIdFrom(factory, 0, "timeout-victim");
      const siblingTurn = turnIdFrom(factory, 0, "timeout-sibling");
      expect(String(await victim)).toContain("codex_app_server_turn_timeout");
      expect(factory.processes[0]!.isExited()).toBe(false);
      expect(interruptsOf(factory)).toEqual([
        { threadId: threadIdFor(factory, "timeout-victim"), turnId: victimTurn },
      ]);
      emit(factory, 0, doneFrame(siblingTurn));
      expect(outputOf(await sibling)).toContain("app-server output:timeout-sibling");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);
});

describe("bug D seams: runs gated on a draining session", () => {
  it("settles an aborted gated run without waiting for the drain, and leaks no ref", async () => {
    const home = await workspace();
    const { factory, engine } = harness();
    try {
      const deltas: string[] = [];
      const failing = startRun(engine, home, "gate-fail", deltas);
      const sibling = startRun(engine, home, "gate-sibling", deltas);
      sibling.catch(() => undefined);
      await waitForDelta(deltas, "gate-fail");
      await waitForDelta(deltas, "gate-sibling");
      emit(factory, 0, failFrame(turnIdFrom(factory, 0, "gate-fail"), "gate-boom"));
      expectOwnError(await failing.then(() => null, (error: unknown) => error), "gate-boom");
      const gatedAbort = new AbortController();
      const gated = engine
        .run({ ...startInput(engine, home, "gate-aborted", deltas), abortSignal: gatedAbort.signal })
        .then(() => null, (error: unknown) => error);
      await pause(20);
      gatedAbort.abort();
      const settled = await Promise.race([gated, pause(1000).then(() => "still-gated" as const)]);
      expect(settled).not.toBe("still-gated");
      expect(String(settled)).toContain("codex_app_server_aborted_before_slot_acquired");
      expect(turnStartCount(factory)).toBe(2);
      emit(factory, 0, doneFrame(turnIdFrom(factory, 0, "gate-sibling")));
      expect(outputOf(await sibling)).toContain("app-server output:gate-sibling");
      // A ref leaked by the aborted waiter would hold the poisoned session forever.
      const boundary = factory.requests.length;
      const after = startRun(engine, home, "gate-after", deltas);
      await waitUntil(() => factory.processes.length === 2, "fresh process after gated abort");
      await waitForDelta(deltas, "gate-after");
      emit(factory, 1, doneFrame(turnIdFrom(factory, boundary, "gate-after")));
      expect(outputOf(await after)).toContain("app-server output:gate-after");
      // With a leaked ref this solo failure would defer forever and gate every later run.
      const solo = startRun(engine, home, "gate-solo-fail", deltas);
      await waitForDelta(deltas, "gate-solo-fail");
      emit(factory, 1, failFrame(turnIdFrom(factory, boundary, "gate-solo-fail"), "gate-solo-boom"));
      expectOwnError(await solo.then(() => null, (error: unknown) => error), "gate-solo-boom");
      const finalBoundary = factory.requests.length;
      const final = startRun(engine, home, "gate-final", deltas);
      await waitUntil(() => factory.processes.length === 3, "fresh process after solo failure");
      await waitForDelta(deltas, "gate-final");
      emit(factory, 2, doneFrame(turnIdFrom(factory, finalBoundary, "gate-final")));
      expect(outputOf(await final)).toContain("app-server output:gate-final");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);
});

class GatedFallback extends RecordingJsonEngine {
  entered = false;
  release!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });

  override async run(input: Parameters<RecordingJsonEngine["run"]>[0]) {
    this.entered = true;
    await this.gate;
    return await super.run(input);
  }
}

describe("bug D seams: fallback after a poisoned failure", () => {
  it("does not hold the drain while the failing run executes its fallback", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      emitTurnEventsWithStartResponse: true,
      suppressTurnCompletion: true,
      failThreadStartNumbers: [2],
    });
    const fallback = new GatedFallback("fallback-output");
    const engine = new CodexAppServerExecutionEngine({
      codexBinaryPath: "/fake/codex",
      processFactory: factory.create,
      cleanThreadPrewarm: false,
      timeoutMs: 5000,
      fallback,
    });
    try {
      const deltas: string[] = [];
      const sibling = startRun(engine, home, "fb-sibling", deltas);
      sibling.catch(() => undefined);
      await waitForDelta(deltas, "fb-sibling");
      const failing = startRun(engine, home, "fb-fail", deltas);
      failing.catch(() => undefined);
      await waitUntil(() => fallback.entered, "failing run inside its fallback");
      emit(factory, 0, doneFrame(turnIdFrom(factory, 0, "fb-sibling")));
      expect(outputOf(await sibling)).toContain("app-server output:fb-sibling");
      // The fallback never touches the app-server slot, so it must not gate the home.
      const boundary = factory.requests.length;
      const third = startRun(engine, home, "fb-third", deltas);
      third.catch(() => undefined);
      await waitUntil(() => factory.processes.length === 2, "fresh process while the fallback runs");
      await waitForDelta(deltas, "fb-third");
      emit(factory, 1, doneFrame(turnIdFrom(factory, boundary, "fb-third")));
      expect(outputOf(await third)).toContain("app-server output:fb-third");
      expect(fallback.prompts).toEqual([]);
      fallback.release();
      expect(outputOf(await failing)).toContain("fallback-output");
    } finally {
      fallback.release();
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);
});

const deadSlotResumeThreadId = "dead-slot-resume-thread";

class GatedGetRunStore extends InMemoryManagedRunStore {
  armed = false;
  entered = false;
  release!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });

  override async get(input: { readonly runId: string }) {
    if (this.armed) {
      this.armed = false;
      this.entered = true;
      await this.gate;
    }
    return await super.get(input);
  }
}

async function parkResume(
  engine: CodexAppServerExecutionEngine,
  runStore: GatedGetRunStore,
  home: string,
): Promise<{ runId: string; settled: Promise<unknown> }> {
  const resumeHandle = {
    runId: "dead-slot-resume-run",
    providerId: "codex",
    agentId: "codex-json",
    workspacePath: home,
    threadId: deadSlotResumeThreadId,
  };
  const request = {
    id: "dead-slot-resume-request",
    kind: "decision_required" as const,
    audience: "user" as const,
    question: "Continue after the shared process died?",
  };
  await runStore.saveWaitingInput({ runId: resumeHandle.runId, resumeHandle, request, now: new Date() });
  runStore.armed = true;
  const settled = engine
    .resume({
      runId: resumeHandle.runId,
      requestId: request.id,
      answer: "continue",
      resumeHandle,
      session: startInput(engine, home, "ignored").session,
      workspacePath: home,
      runner: new StaticRunner(""),
      redactor: new DefaultRedactor(),
      model: "gpt-test",
      reasoningEffort: "low",
      abortSignal: new AbortController().signal,
    })
    .then((result) => result, (error: unknown) => error);
  // Parked in the store read after acquire, before ensureSlot: it holds a drain ref.
  await waitUntil(() => runStore.entered, "resume parked holding a drain ref");
  return { runId: resumeHandle.runId, settled };
}

async function finishResumeOnFreshProcess(
  factory: FakeAppServerFactory,
  runStore: GatedGetRunStore,
  resume: { runId: string; settled: Promise<unknown> },
): Promise<void> {
  const boundary = factory.requests.length;
  runStore.release();
  await waitUntil(() => factory.processes.length === 2, "resume on a fresh process");
  await waitUntil(
    () => factory.requests.slice(boundary).some((request) => request.method === "turn/start"),
    "resume turn on the fresh process",
  );
  await pause(10);
  completeFakeGoal(factory, 1, deadSlotResumeThreadId);
  emit(factory, 1, doneFrame("turn-1"));
  const outcome = await resume.settled;
  expect(String(outcome)).not.toContain("Error");
  expect((await runStore.get({ runId: resume.runId }))?.status).not.toBe("failed");
}

describe("bug D seams: a dead shared process is never drained", () => {
  function deadSlotHarness() {
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      emitTurnEventsWithStartResponse: true,
      suppressTurnCompletion: true,
      initialGoals: { [deadSlotResumeThreadId]: { objective: "dead slot resume", status: "active" } },
    });
    const runStore = new GatedGetRunStore();
    const engine = new CodexAppServerExecutionEngine({
      codexBinaryPath: "/fake/codex",
      processFactory: factory.create,
      cleanThreadPrewarm: false,
      timeoutMs: 5000,
      runStore,
      goalMode: true,
    });
    return { factory, engine, runStore };
  }

  it("hands a ref holder a fresh process when the shared one died before the poison", async () => {
    const home = await workspace();
    const { factory, engine, runStore } = deadSlotHarness();
    try {
      const deltas: string[] = [];
      const sibling = engine.run(startInput(engine, home, "dead-sibling", deltas))
        .then(() => null, (error: unknown) => error);
      await waitForDelta(deltas, "dead-sibling");
      const resume = await parkResume(engine, runStore, home);
      factory.processes[0]!.kill();
      expect(String(await sibling)).toContain("codex_app_server_exited");
      await finishResumeOnFreshProcess(factory, runStore, resume);
    } finally {
      runStore.release();
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("stops a drained session at once when its process dies mid-drain", async () => {
    const home = await workspace();
    const { factory, engine, runStore } = deadSlotHarness();
    try {
      const deltas: string[] = [];
      const failing = engine.run(startInput(engine, home, "mid-fail", deltas))
        .then(() => null, (error: unknown) => error);
      const survivor = engine.run(startInput(engine, home, "mid-survivor", deltas))
        .then(() => null, (error: unknown) => error);
      await waitForDelta(deltas, "mid-fail");
      await waitForDelta(deltas, "mid-survivor");
      const resume = await parkResume(engine, runStore, home);
      // A turn-level failure on a live process defers the dispose for the siblings.
      emit(factory, 0, failFrame(turnIdFrom(factory, 0, "mid-fail"), "mid-boom"));
      expectOwnError(await failing, "mid-boom");
      expect(factory.processes[0]!.isExited()).toBe(false);
      factory.processes[0]!.kill();
      expect(String(await survivor)).toContain("codex_app_server_exited");
      await finishResumeOnFreshProcess(factory, runStore, resume);
    } finally {
      runStore.release();
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);
});
