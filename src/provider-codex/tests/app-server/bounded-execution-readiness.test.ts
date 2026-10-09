import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine, AppServerExecutionLifetime, AppServerExecutionReadiness,
  type AppServerExecutionReadyEvent } from "../../codex-app-server-execution-engine";
import type { CodexAppServerProcessFactory } from "../../app-server/application/app-server-process-port";
import { StaticRunner } from "../codex-provider-test-support";

import { CodexModelBackend } from "../../codex-model-backend";
import type { HostedControllerDynamicToolAdapter, HostedControllerToolResult } from "../../app-server/domain/hosted-controller-dynamic-tools";
import { ControlledPeer } from "./controlled-readiness-peer";

function fixture(onReadiness?: (event: AppServerExecutionReadyEvent) => void, tools?: HostedControllerDynamicToolAdapter) {
  const peer = new ControlledPeer(), events: AppServerExecutionReadyEvent[] = [];
  let submissions = 0, envReads = 0;
  const lifetime = new AppServerExecutionLifetime({ deadlineEpochMs: Date.now() + 1_000, maxGoalTurns: 2,
    binding: { allocationId: "TEST-allocation", incarnationId: "TEST-incarnation" },
    onReadiness: event => { events.push(event); onReadiness?.(event); } });
  const factory: CodexAppServerProcessFactory = () => { submissions++; return peer; };
  const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/controlled-peer", processFactory: factory,
    ...(tools ? { modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, hostedControllerTools: tools } : {}),
    executionLifetime: lifetime, goalMode: true, maxGoalTurns: 2, cleanThreadPrewarm: false,
    nativeToolSurface: "disabled", timeoutMs: 10_000, startupTimeoutMs: 10_000 });
  const abort = new AbortController();
  const input = { prompt: "TEST prompt", model: "TEST-model", reasoningEffort: "high" as const,
    workspacePath: "/TEST/bounded-execution", redactor: new DefaultRedactor(), runner: new StaticRunner(""),
    abortSignal: abort.signal, session: { home: "/TEST/home", codexHome: "/TEST/codex-home", env: {
      get TEST_ENV_VALUE() { envReads++; return "TEST"; } }, release: async () => undefined } };
  return { peer, events, engine, lifetime, input, abort, submissions: () => submissions, envReads: () => envReads };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("original allocation deadline and actual execution readiness", () => {
  it("preserves the startup failure before cleanup closes the execution lifetime", async () => {
    const f = fixture();
    const result = f.engine.run(f.input).catch((error: unknown) => error);
    try {
      f.peer.fail(await f.peer.next("initialize"));
      expect(await result).toMatchObject({ message: "codex_app_server_initialize_failed:TEST failure" });
      expect(f.lifetime.signal.reason).toMatchObject({ message: "codex_app_server_initialize_failed:TEST failure" });
      expect(f.events.some(event => event.state === AppServerExecutionReadiness.Ready)).toBe(false);
    } finally {
      await f.engine.dispose();
    }
    expect(f.peer.ended).toBe(true);
  });

  it("publishes READY only after the actual thread and ACTIVE GoalAPI, and resolves env once", async () => {
    const f = fixture(), result = f.engine.run(f.input);
    try {
      await f.peer.initialize();
      expect(f.events.map(e => e.state)).toEqual([AppServerExecutionReadiness.Starting]);
      const thread = await f.peer.next("thread/start");
      expect(f.events.at(-1)?.state).toBe(AppServerExecutionReadiness.Initialized);
      f.peer.reply(thread, { thread: { id: "actual-TEST-thread" } });
      const goal = await f.peer.next("thread/goal/set");
      expect(f.events.some(e => e.state === AppServerExecutionReadiness.Ready)).toBe(false);
      f.peer.reply(goal, f.peer.goal());
      await f.peer.next("turn/start");
      expect(f.events.at(-1)).toEqual({ allocationId: "TEST-allocation", incarnationId: "TEST-incarnation",
        state: AppServerExecutionReadiness.Ready, threadId: "actual-TEST-thread" });
      await f.peer.finish();
      expect((await result).outputText).toBe("TEST result");
      expect(f.peer.requests.filter(r => r.method === "thread/start")).toHaveLength(1);
      expect(f.envReads()).toBe(1);
    } finally { await f.engine.dispose(); }
  });

  it.each(["initialize", "thread/start", "thread/goal/set"])("fences stalled %s and rejects late completion", async stage => {
    vi.useFakeTimers();
    const f = fixture(), settled = f.engine.run(f.input).then(() => "completed", () => "failed");
    if (stage !== "initialize") await f.peer.initialize();
    if (stage === "thread/goal/set") await f.peer.thread();
    const request = await f.peer.next(stage);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await settled).toBe("failed");
    const writes = f.peer.requests.length;
    f.peer.reply(request, stage === "initialize" ? {} : stage === "thread/start"
      ? { thread: { id: "late-TEST-thread" } } : f.peer.goal());
    await Promise.resolve();
    expect(f.peer.requests).toHaveLength(writes);
    expect(f.events.some(e => e.state === AppServerExecutionReadiness.Ready)).toBe(false);
    expect(f.peer.ended).toBe(true);
    await f.engine.dispose();
  });

  it.each(["initialize", "thread/start", "thread/goal/set"])("failure of %s never publishes READY", async stage => {
    const f = fixture(), settled = f.engine.run(f.input).then(() => "completed", () => "failed");
    if (stage !== "initialize") await f.peer.initialize();
    if (stage === "thread/goal/set") await f.peer.thread();
    f.peer.fail(await f.peer.next(stage));
    expect(await settled).toBe("failed");
    expect(f.events.some(e => e.state === AppServerExecutionReadiness.Ready)).toBe(false);
    await f.engine.dispose();
  });

  it("rejects a non-ACTIVE setup response", async () => {
    const f = fixture(), settled = f.engine.run(f.input).then(() => "completed", () => "failed");
    await f.peer.initialize(); await f.peer.thread();
    f.peer.reply(await f.peer.next("thread/goal/set"), f.peer.goal("paused"));
    expect(await settled).toBe("failed");
    expect(f.events.some(e => e.state === AppServerExecutionReadiness.Ready)).toBe(false);
    expect(f.peer.requests.some(r => r.method === "turn/start")).toBe(false);
    await f.engine.dispose();
  });

  it("spends startup time from thread, goal, turn and result waits", async () => {
    vi.useFakeTimers();
    const f = fixture(), settled = f.engine.run(f.input).then(() => "completed", () => "failed");
    await f.peer.next("initialize"); await vi.advanceTimersByTimeAsync(750);
    await f.peer.initialize(); await f.peer.thread(); await f.peer.activate();
    const turn = await f.peer.next("turn/start");
    await vi.advanceTimersByTimeAsync(251);
    expect(await settled).toBe("failed");
    const writes = f.peer.requests.length;
    f.peer.reply(turn, { turn: { id: "late-TEST-turn" } });
    expect(f.peer.requests).toHaveLength(writes);
    expect(f.peer.requests.some(r => r.method === "thread/goal/get")).toBe(false);
    await f.engine.dispose();
  });

  it("rejects expiry between the GoalAPI event and its continuation", async () => {
    vi.useFakeTimers();
    const f = fixture(), settled = f.engine.run(f.input).then(() => "completed", () => "failed");
    await f.peer.initialize(); await f.peer.thread();
    f.peer.reply(await f.peer.next("thread/goal/set"), f.peer.goal());
    vi.setSystemTime(Date.now() + 1_001);
    expect(await settled).toBe("failed");
    expect(f.events.some(e => e.state === AppServerExecutionReadiness.Ready)).toBe(false);
    expect(f.peer.requests.some(r => r.method === "turn/start")).toBe(false);
    await f.engine.dispose();
  });

  it("denies work after rollback, death, abort and callback-triggered closure", async () => {
    for (const fault of ["rollback", "death", "abort", "callback"]) {
      vi.useFakeTimers();
      const f = fixture(event => { if (fault === "callback" && event.state === AppServerExecutionReadiness.Initialized) f.abort.abort(new Error("TEST callback abort")); });
      const settled = f.engine.run(f.input).then(() => "completed", () => "failed");
      const initialize = await f.peer.next("initialize");
      if (fault === "rollback") vi.setSystemTime(Date.now() - 1);
      if (fault === "death") f.peer.emit("exit", 1, null);
      if (fault === "abort") f.abort.abort(new Error("TEST abort"));
      f.peer.reply(initialize, {});
      expect(await settled).toBe("failed");
      expect(f.events.some(e => e.state === AppServerExecutionReadiness.Ready)).toBe(false);
      expect(f.peer.requests.some(r => r.method === "thread/start")).toBe(false);
      await f.engine.dispose(); vi.useRealTimers();
    }
  });

  it("denies a second invocation, prewarm, resume and fork without provider effects", async () => {
    const f = fixture();
    const result = f.engine.run(f.input);
    await f.peer.initialize(); await f.peer.thread(); await f.peer.activate(); await f.peer.finish(); await result;
    await expect(f.engine.run(f.input)).rejects.toThrow("invocation_consumed");
    await expect(f.engine.prewarm(f.input)).rejects.toThrow("prewarm_denied");
    await expect(f.engine.runLogicalThread(f.input)).rejects.toThrow("continuation_denied");
    expect(f.submissions()).toBe(1);
    expect(f.peer.requests.filter(r => r.method === "thread/start")).toHaveLength(1);
    await f.engine.dispose();
  });
  it("cancels an actual dynamic request on expiry and never writes its late reply", async () => {
    vi.useFakeTimers();
    let resolve!: (result: HostedControllerToolResult) => void;
    let entered!: () => void;
    const called = new Promise<void>(r => { entered = r; });
    const pending = new Promise<HostedControllerToolResult>(r => { resolve = r; });
    let callSignal: AbortSignal | undefined;
    const f = fixture(undefined, { dispatch: (_call, signal) => { callSignal = signal; entered(); return pending; } });
    const result = f.engine.run(f.input).then(() => "completed", () => "failed");
    await f.peer.initialize(); await f.peer.thread(); await f.peer.activate();
    f.peer.reply(await f.peer.next("turn/start"), { turn: { id: "actual-TEST-turn" } });
    // Independent peer reports a turn/call on the actual retained thread.
    f.peer.stdout.emit("data", JSON.stringify({ method: "turn/started", params: {
      threadId: "actual-TEST-thread", turn: { id: "actual-TEST-turn" } } }) + "\n");
    f.peer.stdout.emit("data", JSON.stringify({ id: 900, method: "item/tool/call", params: {
      arguments: { handle: "TEST-handle" }, callId: "TEST-call", namespace: null,
      threadId: "actual-TEST-thread", tool: "observe", turnId: "actual-TEST-turn" } }) + "\n");
    await called;
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await result).toBe("failed");
    expect(callSignal?.aborted).toBe(true);
    resolve({ status: "unavailable" });
    await Promise.resolve(); await Promise.resolve();
    expect(f.peer.responses).toEqual([]);
    await f.engine.dispose();
  });

  it("bounds final GoalAPI observation and rejects a late COMPLETE result", async () => {
    vi.useFakeTimers();
    const f = fixture(), result = f.engine.run(f.input).then(() => "completed", () => "failed");
    await f.peer.initialize(); await f.peer.thread(); await f.peer.activate(); await f.peer.finishTurn();
    const observation = await f.peer.next("thread/goal/get");
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await result).toBe("failed");
    const writes = f.peer.requests.length;
    f.peer.reply(observation, f.peer.goal("complete"));
    await Promise.resolve();
    expect(f.peer.requests).toHaveLength(writes);
    await f.engine.dispose();
  });

  it("allows exactly N=2 unfinished turns with no third write or provider replacement", async () => {
    const f = fixture(), result = f.engine.run(f.input).then(() => "completed", () => "failed");
    await f.peer.initialize(); await f.peer.thread(); await f.peer.activate();
    for (let occurrence = 1; occurrence <= 2; occurrence++) {
      await f.peer.finishTurn(occurrence);
      f.peer.reply(await f.peer.next("thread/goal/get", occurrence), f.peer.goal("active"));
    }
    expect(await result).toBe("failed");
    expect(f.peer.requests.filter(r => r.method === "turn/start")).toHaveLength(2);
    expect(f.submissions()).toBe(1);
    await expect(f.engine.run(f.input)).rejects.toThrow();
    expect(f.submissions()).toBe(1);
    await f.engine.dispose();
  });

  // RED: failed-session cleanup closes the shared lifetime with a generic error,
  // winning the result race and erasing the actual post-turn GoalAPI failure.
  it("retains the original GoalAPI failure through cleanup and fences another invocation", async () => {
    const f = fixture(), result = f.engine.run(f.input).catch((error: unknown) => error);
    try {
      await f.peer.initialize(); await f.peer.thread(); await f.peer.activate(); await f.peer.finishTurn();
      f.peer.fail(await f.peer.next("thread/goal/get"));
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("Expected the rejected TEST GoalAPI result");
      expect(error.message).toBe("codex_app_server_goal_get_failed:TEST failure");
      expect(f.lifetime.signal.aborted).toBe(true);
      expect(f.lifetime.signal.reason).toBe(error);
      await f.engine.dispose();
      expect(f.peer.ended).toBe(true);
      await expect(f.engine.run(f.input)).rejects.toBe(error);
      expect(f.submissions()).toBe(1);
      expect(f.peer.requests.filter(r => r.method === "turn/start")).toHaveLength(1);
    } finally { await f.engine.dispose(); }
  });

  it("expires by original monotonic elapsed time while wall time remains unchanged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const wall = Date.now(), f = fixture();
    vi.spyOn(Date, "now").mockReturnValue(wall);
    let settled = false;
    const result = f.engine.run(f.input).then(() => "completed", () => "failed").then(value => { settled = true; return value; });
    try {
      await f.peer.next("initialize");
      await vi.advanceTimersByTimeAsync(1_001);
      expect(settled).toBe(true);
      expect(await result).toBe("failed");
      expect(f.events.some(e => e.state === AppServerExecutionReadiness.Ready)).toBe(false);
    } finally { await f.engine.dispose(); }
  });

});
