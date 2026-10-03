import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../codex-app-server-execution-engine";
import type { CodexAppServerClient } from "../app-server/application/app-server-client";
import { AppServerAdmissionError } from "../app-server/application/app-server-admission";
import { AppServerTokenUsageTracker } from "../app-server/application/app-server-turn-usage";
import { createTurnState } from "../app-server/application/app-server-turn-state";
import { usageFromError } from "../app-server/domain/app-server-usage-error";
import { isAppServerExecutionReplayUnsafe } from "../app-server/domain/app-server-execution-safety";
import { FakeAppServerFactory, type FakeAppServerRequest } from "../app-server/testing/fake-app-server";
import { RecordingJsonEngine, StaticRunner } from "./codex-provider-test-support";

const measured = { inputTokens: 100, outputTokens: 25, totalTokens: 125 };

async function setup(options: { lostAck?: boolean; overflowWithAck?: boolean; timeoutMs?: number; goalMode?: boolean; prewarm?: boolean } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "codex-admission-usage-test-"));
  const factory = new FakeAppServerFactory();
  const fallback = new RecordingJsonEngine("must not replay");
  const starts: FakeAppServerRequest[] = [];
  const engine = new CodexAppServerExecutionEngine({
    codexBinaryPath: "/bin/codex-test", cleanThreadPrewarm: options.prewarm ?? false,
    goalMode: options.goalMode ?? false, timeoutMs: options.timeoutMs ?? 5_000, fallback,
    processFactory: (input) => {
      const child = factory.create(input);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk) => {
        const request = JSON.parse(String(chunk)) as FakeAppServerRequest;
        if (request.method !== "turn/start") return write(chunk);
        starts.push(request);
        const turnId = `manual-${request.id}`;
        const emit = (packet: unknown) => child.stdout.emit("data", `${JSON.stringify(packet)}\n`);
        if (options.overflowWithAck) {
          child.stdout.emit("data", [
            { id: request.id, result: { turn: { id: turnId } } },
            { method: "turn/started", params: { threadId: request.params?.threadId, turn: { id: turnId } } },
            { method: "thread/tokenUsage/updated", params: {
              threadId: request.params?.threadId, turnId, tokenUsage: { total: measured, last: measured },
            } },
          ].map((packet) => JSON.stringify(packet)).join("\n") + "\n" + "x".repeat(5 * 1024 * 1024));
          return true;
        }
        if (!options.lostAck) emit({ id: request.id, result: { turn: { id: turnId } } });
        emit({ method: "turn/started", params: { threadId: request.params?.threadId, turn: { id: turnId } } });
        return true;
      };
      return child;
    },
  });
  const input = {
    session: { home: workspace, codexHome: workspace, env: { CODEX_HOME: workspace }, sessionHash: "synthetic", release: async () => undefined },
    workspacePath: workspace, model: "gpt-test", reasoningEffort: "low" as const,
    runner: new StaticRunner(""), redactor: new DefaultRedactor(),
    abortSignal: new AbortController().signal, prompt: "synthetic bounded admission",
  };
  await engine.prewarm(input);
  const slots = (engine as unknown as { slotPool: { slots: Map<string, { client: CodexAppServerClient }> } }).slotPool.slots;
  const client = [...slots.values()][0]!.client;
  const child = factory.processes[0]!;
  const emit = (packet: unknown) => child.stdout.emit("data", `${JSON.stringify(packet)}\n`);
  // `total` is the thread's cumulative counter; `last` is this turn's exact usage.
  const usage = (index: number, total = measured, last = total) => {
    const request = starts[index]!;
    emit({ method: "thread/tokenUsage/updated", params: {
      threadId: request.params?.threadId, turnId: `manual-${request.id}`, tokenUsage: { total, last },
    } });
  };
  const complete = (index: number) => {
    const turnId = `manual-${starts[index]!.id}`;
    emit({ method: "item/agentMessage/delta", params: { turnId, delta: "synthetic complete" } });
    emit({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });
  };
  return { engine, input, client, factory, fallback, starts, child, emit, usage, complete,
    close: async () => { await engine.dispose(); await rm(workspace, { recursive: true, force: true }); },
  };
}

const outcome = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));
async function waitForStarts(starts: readonly unknown[], count: number): Promise<void> {
  await expect.poll(() => starts.length, { timeout: 2_000, interval: 5 }).toBe(count);
}

describe("Codex usage and local admission", () => {
  it.each(["timeout", "protocol overflow"])("retains measured usage without turn/start ACK after %s", async (failure) => {
    const test = await setup({ lostAck: true, timeoutMs: 100 });
    try {
      const run = outcome(test.engine.run(test.input));
      await waitForStarts(test.starts, 1);
      test.usage(0);
      test.usage(0); // Replayed cumulative snapshot must not double bill.
      if (failure === "protocol overflow") test.child.stdout.emit("data", "x".repeat(5 * 1024 * 1024));
      const result = await run;
      expect(result).toHaveProperty("error");
      if (!("error" in result)) throw new Error("expected failure");
      expect(usageFromError(result.error)).toEqual(measured);
      expect(isAppServerExecutionReplayUnsafe(result.error)).toBe(true);
      expect(test.fallback.prompts).toEqual([]);
    } finally { await test.close(); }
  });

  it("retains usage when ACK, usage and overflow arrive in one synchronous chunk", async () => {
    const test = await setup({ overflowWithAck: true });
    try {
      const result = await outcome(test.engine.run(test.input));
      if (!("error" in result)) throw new Error("expected protocol failure");
      expect(usageFromError(result.error)).toEqual(measured);
      expect(isAppServerExecutionReplayUnsafe(result.error)).toBe(true);
      expect(test.fallback.prompts).toEqual([]);
      expect(test.starts).toHaveLength(1);
    } finally { await test.close(); }
  });

  it("keeps pre-ACK parallel usage separate, including unknown usage, through terminal cleanup", async () => {
    const test = await setup({ lostAck: true });
    try {
      const runs = [0, 1, 2].map(() => outcome(test.engine.run(test.input)));
      await waitForStarts(test.starts, 3);
      test.usage(0);
      test.usage(1, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
      // A mismatched thread/turn tuple must not allocate another request's usage.
      test.emit({ method: "thread/tokenUsage/updated", params: {
        threadId: test.starts[2]!.params?.threadId, turnId: `manual-${test.starts[0]!.id}`, tokenUsage: { total: measured },
      } });
      test.child.stdout.emit("data", "x".repeat(5 * 1024 * 1024));
      const results = await Promise.all(runs);
      expect(results.map((result) => "error" in result ? usageFromError(result.error) : null)).toEqual([
        measured, { inputTokens: 7, outputTokens: 3, totalTokens: 10 }, undefined,
      ]);
      expect(results.every((result) => "error" in result && isAppServerExecutionReplayUnsafe(result.error))).toBe(true);
    } finally { await test.close(); }
  });

  it("admits only 128 of 300 public runs, preserves active work and reuses released capacity", async () => {
    const test = await setup({ prewarm: true });
    try {
      const runs = Array.from({ length: 300 }, () => outcome(test.engine.run(test.input)));
      await waitForStarts(test.starts, 128);
      const rejected = await Promise.all(runs.slice(128));
      expect(rejected.every((result) => "error" in result && result.error instanceof AppServerAdmissionError)).toBe(true);
      expect(test.factory.spawnCount).toBe(1);
      expect(test.child.isExited()).toBe(false);
      expect(test.fallback.prompts).toEqual([]);
      expect(test.factory.requests.filter((request) => request.method === "thread/start").length).toBeLessThanOrEqual(128);
      // Flood idle thread registrations while all admitted baselines are live.
      for (let index = 0; index < 150; index += 1) await test.client.startThread({ ...test.input, timeoutMs: 5_000 });
      for (let index = 0; index < 128; index += 1) { test.usage(index); test.complete(index); }
      const active = await Promise.all(runs.slice(0, 128));
      expect(active.every((result) => "value" in result && result.value.usage?.totalTokens === 125)).toBe(true);
      const reused = outcome(test.engine.run(test.input));
      await waitForStarts(test.starts, 129);
      test.usage(128); test.complete(128);
      expect(await reused).toMatchObject({ value: { usage: measured } });
      expect(test.factory.spawnCount).toBe(1);
    } finally { await test.close(); }
  });

  it.each(["goal", "logical"])("rejects %s capacity before thread setup without disposing the slot", async (mode) => {
    const test = await setup({ goalMode: true });
    const leases = Array.from({ length: 128 }, () => test.client.acquireExecution());
    try {
      const operation = mode === "goal" ? test.engine.run(test.input) : test.engine.runLogicalThread(test.input);
      await expect(operation).rejects.toBeInstanceOf(AppServerAdmissionError);
      expect(test.starts).toHaveLength(0);
      expect(test.factory.requests.filter((request) => request.method === "thread/start")).toHaveLength(0);
      expect(test.child.isExited()).toBe(false);
      expect(test.fallback.prompts).toEqual([]);
      leases[0]!.release();
      const lease = test.client.acquireExecution();
      lease.release();
    } finally { leases.forEach((lease) => lease.release()); await test.close(); }
  });

  it("rejects overlapping turns on one thread and releases direct admission on abort and completion", async () => {
    const test = await setup();
    try {
      const threadId = await test.client.startThread({ ...test.input, timeoutMs: 5_000 });
      const abort = new AbortController();
      const direct = { ...test.input, threadId, timeoutMs: 5_000, abortSignal: abort.signal };
      const first = outcome(test.client.startTurn(direct));
      await waitForStarts(test.starts, 1);
      await expect(test.client.startTurn(direct)).rejects.toMatchObject({ reason: "thread_busy" });
      expect(test.starts).toHaveLength(1);
      test.usage(0); abort.abort();
      expect(await first).toHaveProperty("error");
      const second = outcome(test.client.startTurn({ ...direct, abortSignal: test.input.abortSignal }));
      await waitForStarts(test.starts, 2);
      // The thread's cumulative counter has advanced to 250, but this turn's
      // exact usage is `measured` — the exact field is what gets billed.
      test.usage(1, { inputTokens: 200, outputTokens: 50, totalTokens: 250 }, measured);
      test.complete(1);
      expect(await second).toMatchObject({ value: { usage: measured } });
      expect(test.child.isExited()).toBe(false);
    } finally { await test.close(); }
  });

  it("bounds direct client starts and releases capacity after turn errors", async () => {
    const test = await setup();
    try {
      const threads = await Promise.all(Array.from({ length: 129 }, () =>
        test.client.startThread({ ...test.input, timeoutMs: 5_000 })));
      const direct = { ...test.input, timeoutMs: 5_000 };
      const runs = threads.slice(0, 128).map((threadId) => outcome(test.client.startTurn({ ...direct, threadId })));
      await waitForStarts(test.starts, 128);
      await expect(test.client.startTurn({ ...direct, threadId: threads[128]! })).rejects.toMatchObject({ reason: "capacity" });
      expect(test.child.isExited()).toBe(false);
      test.emit({ method: "turn/completed", params: { turn: {
        id: `manual-${test.starts[0]!.id}`, status: "failed", error: { message: "synthetic failure" },
      } } });
      expect(await runs[0]).toMatchObject({ value: { error: expect.any(Error) } });
      const reused = outcome(test.client.startTurn({ ...direct, threadId: threads[128]! }));
      await waitForStarts(test.starts, 129);
      for (let index = 1; index < 129; index += 1) test.complete(index);
      expect((await Promise.all([...runs.slice(1), reused])).every((result) => "value" in result && result.value.completed)).toBe(true);
    } finally { await test.close(); }
  });

  it("pins admitted thread response baselines before any turn continuation", () => {
    const warnings: { code: string }[] = [];
    const tracker = new AppServerTokenUsageTracker((warning) => warnings.push(warning));
    const release = tracker.pin("fresh");
    tracker.registerThread("fresh", true);
    for (let index = 0; index < 300; index += 1) tracker.registerThread(`idle-${index}`, true);
    const state = createTurnState();
    tracker.observe({ threadId: "fresh", turnId: "turn", tokenUsage: { total: measured } },
      new Map([["fresh", "turn"]]), new Map(), new Map(), () => state);
    expect(state.usage).toEqual(measured);
    // Billed from the cumulative counter because the provider reported no
    // `tokenUsage.last`; the degraded path must announce itself.
    expect(warnings.map((warning) => warning.code)).toEqual(["codex_app_server_turn_usage_estimated"]);
    release();
  });
});
