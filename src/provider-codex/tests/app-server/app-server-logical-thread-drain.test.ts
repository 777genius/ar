import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../../codex-app-server-execution-engine";
import { FakeAppServerFactory } from "../../app-server/testing/fake-app-server";
import { StaticRunner } from "../codex-provider-test-support";
import { InMemoryManagedRunStore } from "../../codex-app-server-managed-run-store";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true }),
  ));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-logical-drain-"));
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

function startInput(
  _engine: CodexAppServerExecutionEngine,
  home: string,
  prompt: string,
  deltas?: string[],
) {
  return {
    session: {
      home, codexHome: home, env: { CODEX_HOME: home },
      sessionHash: "logical-drain-session", release: async () => undefined,
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
function completeFakeGoal(factory: FakeAppServerFactory, processIndex: number, threadId: string): void {
  factory.processes[processIndex]!.stdin.write(
    `${JSON.stringify({
      id: 97531,
      method: "thread/goal/set",
      params: { threadId, objective: "probe", status: "complete" },
    })}\n`,
  );
}

async function waitForDelta(deltas: string[], prompt: string): Promise<void> {
  await waitUntil(
    () => deltas.join("").includes(`app-server output:${prompt}`),
    `delta for ${prompt}`,
  );
}

function turnStarted(factory: FakeAppServerFactory, prompt: string, fromIndex = 0): boolean {
  return factory.requests.slice(fromIndex).some((request) =>
    request.method === "turn/start" && JSON.stringify(request.params).includes(prompt));
}

function threadIdFor(factory: FakeAppServerFactory, prompt: string): string {
  const request = factory.requests.find((candidate) =>
    candidate.method === "turn/start" && JSON.stringify(candidate.params).includes(prompt));
  return String((request?.params as { threadId?: unknown } | undefined)?.threadId ?? "");
}

describe("bug D seams: logical-thread call site", () => {
  it("keeps the sibling draining through a failed logical thread", async () => {
    const home = await workspace();
    const { factory, engine } = seamHarness(true);
    try {
      const deltas: string[] = [];
      const failing = engine
        .runLogicalThread(startInput(engine, home, "logical-fail"))
        .then(() => null, (error: unknown) => error);
      // The logical-thread runner does not forward onTextDelta; wait for its
      // turn/start request instead.
      await waitUntil(() => turnStarted(factory, "logical-fail"), "logical-fail turn started");
      const sibling = engine.run(startInput(engine, home, "sib-logical", deltas));
      sibling.catch(() => undefined);
      await waitForDelta(deltas, "sib-logical");
      emit(factory, 0, failFrame(turnIdFrom(factory, 0, "logical-fail"), "logical-boom"));
      expectOwnError(await failing, "logical-boom");
      completeFakeGoal(factory, 0, threadIdFor(factory, "sib-logical"));
      emit(factory, 0, doneFrame(turnIdFrom(factory, 0, "sib-logical")));
      const result = await sibling;
      expect(outputOf(result)).toContain("app-server output:sib-logical");
      const boundary = factory.requests.length;
      const third = engine.run(startInput(engine, home, "after-logical-seam", deltas));
      third.catch(() => undefined);
      await waitUntil(() => factory.processes.length === 2, "fresh process after logical drain");
      await waitForDelta(deltas, "after-logical-seam");
      completeFakeGoal(factory, 1, threadIdFor(factory, "after-logical-seam"));
      emit(factory, 1, doneFrame(turnIdFrom(factory, boundary, "after-logical-seam")));
      expect(outputOf(await third)).toContain("app-server output:after-logical-seam");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("gates a logical thread that arrives while the poisoned session drains", async () => {
    const home = await workspace();
    const { factory, engine } = seamHarness(true);
    try {
      const deltas: string[] = [];
      const failing = engine
        .run(startInput(engine, home, "drain-run-fail", deltas))
        .then(() => null, (error: unknown) => error);
      const sibling = engine.run(startInput(engine, home, "drain-run-sibling", deltas));
      sibling.catch(() => undefined);
      await waitForDelta(deltas, "drain-run-fail");
      await waitForDelta(deltas, "drain-run-sibling");
      emit(factory, 0, failFrame(turnIdFrom(factory, 0, "drain-run-fail"), "drain-run-boom"));
      expectOwnError(await failing, "drain-run-boom");
      const boundary = factory.requests.length;
      const late = engine.runLogicalThread(startInput(engine, home, "logical-during-drain"));
      late.catch(() => undefined);
      // The pool hands out a live slot within microtasks, so an ungated thread
      // would already have started on the poisoned process by now.
      await pause(20);
      expect(factory.requests.slice(boundary).map((request) => request.method)).toEqual([]);
      completeFakeGoal(factory, 0, threadIdFor(factory, "drain-run-sibling"));
      emit(factory, 0, doneFrame(turnIdFrom(factory, 0, "drain-run-sibling")));
      expect(outputOf(await sibling)).toContain("app-server output:drain-run-sibling");
      await waitUntil(() => factory.processes.length === 2, "late logical thread on a fresh process");
      await waitUntil(() => turnStarted(factory, "logical-during-drain", boundary), "late logical turn started");
      completeFakeGoal(factory, 1, threadIdFor(factory, "logical-during-drain"));
      emit(factory, 1, doneFrame(turnIdFrom(factory, boundary, "logical-during-drain")));
      expect(outputOf(await late)).toContain("app-server output:logical-during-drain");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);
});
