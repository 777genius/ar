import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../../codex-app-server-execution-engine";
import { FakeAppServerFactory } from "../../app-server/testing/fake-app-server";
import { StaticRunner } from "../codex-provider-test-support";

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

function startRun(
  engine: CodexAppServerExecutionEngine,
  home: string,
  prompt: string,
  deltas: string[],
) {
  return engine.run({
    session: {
      home, codexHome: home, env: { CODEX_HOME: home },
      sessionHash: "drain-session", release: async () => undefined,
    },
    workspacePath: home,
    model: "gpt-test",
    reasoningEffort: "low",
    runner: new StaticRunner(""),
    redactor: new DefaultRedactor(),
    abortSignal: new AbortController().signal,
    onTextDelta: (text: string) => deltas.push(text),
    prompt,
  });
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
