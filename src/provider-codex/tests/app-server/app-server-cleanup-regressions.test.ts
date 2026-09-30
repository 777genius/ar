import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../../codex-app-server-execution-engine";
import { AppServerSlotPool } from "../../app-server/application/app-server-slot-pool";
import { AppServerProcessCleanupError } from "../../app-server/application/app-server-process-stopper";
import { isCodexAppServerBudgetExceededError } from "../../app-server/domain/app-server-errors";
import { signalCodexAppServerChildGroup } from "../../app-server/adapters/node-app-server-process";
import { FakeAppServerFactory, type FakeAppServerFactoryOptions } from "../../app-server/testing/fake-app-server";
import { InMemoryManagedRunStore } from "../../codex-app-server-managed-run-store";
import { resolveCodexExecutionProfile } from "../../codex-execution-profile";
import { RecordingJsonEngine, StaticRunner } from "../codex-provider-test-support";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// Only the kernel is simulated: production pool, client, stopper and ordinary
// signaler run unchanged. Birth belongs to the kernel, independently of child.pid.
async function fixture(initializeError?: string, runtimeOptions: FakeAppServerFactoryOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "pr5-cleanup-TEST-"));
  const factory = new FakeAppServerFactory({ ...runtimeOptions, ...(initializeError ? { initializeError } : {}) });
  const options = { codexBinaryPath: "/fake/codex", sourceEnv: {}, cleanThreadPrewarm: false,
    processFactory: (input: Parameters<typeof factory.create>[0]) => {
      const child = factory.create(input);
      Object.defineProperty(child, "pid", { value: 812345 });
      return child;
    } };
  const session = { home, codexHome: home, env: { CODEX_HOME: home }, sessionHash: "original",
    release: async () => undefined };
  const input = { session, workspacePath: home, abortSignal: new AbortController().signal,
    runner: new StaticRunner(""), redactor: new DefaultRedactor(), model: "gpt-test",
    reasoningEffort: "low" as const, prompt: "synthetic cleanup regression" };
  let birth = "owned-original";
  const signals: { pid: number; signal: Parameters<typeof process.kill>[1]; birth: string }[] = [];
  let onSignal = (_signal: Parameters<typeof process.kill>[1]) => {};
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    signals.push({ pid, signal, birth });
    onSignal(signal);
    return true;
  });
  return { home, factory, options, input, signals,
    changeBirth: () => { birth = "unrelated-replacement"; },
    onSignal: (handler: typeof onSignal) => { onSignal = handler; },
    remove: () => rm(home, { recursive: true, force: true }) };
}

it("never signals a reused ordinary group on post-exit retry and retains its obligation", async () => {
  const f = await fixture();
  const pool = new AppServerSlotPool({ ...f.options, signalChildProcess: signalCodexAppServerChildGroup,
    runStore: new InMemoryManagedRunStore(), executionProfile: resolveCodexExecutionProfile(undefined),
    maxOutputBytes: 100_000 });
  try {
    await pool.ensureSlot(f.input);
    const child = f.factory.processes[0]!;
    f.onSignal(signal => {
      if (signal === "SIGTERM") {
        child.emit("error", new Error("synthetic observation failure"));
        child.emit("exit", 0, null);
      }
    });
    await expect(pool.disposeSessionSlot(f.input.session)).rejects.toBeInstanceOf(AppServerProcessCleanupError);
    expect(f.signals.map(s => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    // The old group is now gone and its number has independently been reused.
    f.changeBirth();
    f.onSignal(() => {});
    for (let retry = 0; retry < 2; retry++) {
      const error = await pool.disposeSessionSlot(f.input.session).catch((error: unknown) => error);
      expect(f.signals.filter(s => s.birth === "unrelated-replacement")).toEqual([]);
      expect(error).toMatchObject({
        name: "AppServerProcessCleanupUnresolvedError",
        cause: new Error("codex_app_server_process_ownership_unverified"),
      });
      await expect(pool.ensureSlot({ ...f.input, session: { ...f.input.session, sessionHash: "replacement" } }))
        .rejects.toThrow("cleanup_pending");
    }
    expect(child.pid).toBe(812345);
    expect(child.listenerCount("exit")).toBeGreaterThan(0);
    expect(f.factory.spawnCount).toBe(1);
    await expect(pool.dispose()).rejects.toBeInstanceOf(AggregateError);
    await expect(pool.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(f.signals.filter(s => s.birth === "unrelated-replacement")).toEqual([]);
  } finally { await f.remove(); }
});

it.each(["abort", "budget", "quota", "model"] as const)("keeps %s errors and blocks renewal while cleanup is unresolved", async kind => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const runtimeOptions: FakeAppServerFactoryOptions = kind === "abort"
    ? { onRequest: request => { if (request.method === "turn/start") abort.abort(); } }
    : kind === "budget"
    ? { completeTurnWithError: { message: "synthetic budget exhausted", codexErrorInfo: "sessionBudgetExceeded" } }
    : kind === "quota"
    ? { emitTopLevelErrorOnTurn: "You've hit your usage limit." }
    : { failThreadStart: true, threadStartError: "unsupported model", availableModels: [{ model: "gpt-other" }] };
  const f = await fixture(undefined, runtimeOptions);
  const fallback = new RecordingJsonEngine("must not run");
  const engine = new CodexAppServerExecutionEngine({ ...f.options, fallback });
  try {
    const outcome = engine.run({ ...f.input, abortSignal: abort.signal }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_005); // Includes the fake transport's 5ms turn event.
    const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError);
    const [original, cleanup] = (error as AggregateError).errors;
    expect(original.message).toMatch(kind === "abort" ? /aborted/ : kind === "budget" ? /budget exhausted/
      : kind === "quota" ? /usage limit/ : /unavailable/);
    if (kind === "budget") expect(isCodexAppServerBudgetExceededError(original)).toBe(true);
    if (kind === "model") expect(original.name).toBe("CodexModelUnavailableError");
    expect(cleanup).toBeInstanceOf(AppServerProcessCleanupError);
    expect(cleanup.cause).toEqual(new Error("codex_app_server_stop_timeout"));
    const requests = f.factory.requests.length;
    const again = engine.run(f.input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await again).toBeInstanceOf(AggregateError);
    expect(f.factory.requests).toHaveLength(requests);
    expect(f.factory.spawnCount).toBe(1);
    expect(fallback.prompts).toEqual([]);
    const disposal = engine.dispose().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await disposal).toBeInstanceOf(AggregateError);
    expect(vi.getTimerCount()).toBe(0);
  } finally { await f.remove(); }
});

it("preserves initialization, initial cleanup and retry cleanup failures through the real engine", async () => {
  vi.useFakeTimers();
  const f = await fixture("synthetic initialization failure");
  const observation = new Error("synthetic initial cleanup failure");
  let termCount = 0;
  f.onSignal(signal => {
    if (signal === "SIGTERM" && ++termCount === 1) f.factory.processes[0]!.emit("error", observation);
  });
  const fallback = new RecordingJsonEngine("must not run");
  const engine = new CodexAppServerExecutionEngine({ ...f.options, fallback });
  try {
    const result = engine.run(f.input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await result;
    expect(error).toBeInstanceOf(AggregateError);
    const [startup, retry] = (error as AggregateError).errors;
    expect(startup).toBeInstanceOf(AggregateError);
    expect(startup.errors[0].message).toContain("synthetic initialization failure");
    expect(startup.errors[1]).toBeInstanceOf(AppServerProcessCleanupError);
    expect(startup.errors[1].cause).toBe(observation);
    expect(retry).toBeInstanceOf(AppServerProcessCleanupError);
    expect(retry.cause).toEqual(new Error("codex_app_server_stop_timeout"));
    expect(termCount).toBe(2);
    // Neither the caller nor a subsequent run can renew provider effects.
    const again = engine.run({ ...f.input, session: { ...f.input.session, sessionHash: "replacement" } })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await again).toBeInstanceOf(AggregateError);
    expect((await again as AggregateError).errors[0].message).toContain("cleanup_pending");
    expect(f.factory.spawnCount).toBe(1);
    expect(f.factory.requests.map(r => r.method)).not.toContain("thread/start");
    expect(fallback.prompts).toEqual([]);
    const disposal = engine.dispose().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await disposal).toBeInstanceOf(AggregateError);
    expect(vi.getTimerCount()).toBe(0);
  } finally { await f.remove(); }
});
