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
async function fixture(initializeError?: string, runtimeOptions: FakeAppServerFactoryOptions = {}, pid = 812345) {
  const home = await mkdtemp(join(tmpdir(), "pr5-cleanup-TEST-"));
  const factory = new FakeAppServerFactory({ ...runtimeOptions, ...(initializeError ? { initializeError } : {}) });
  const options = { codexBinaryPath: "/fake/codex", sourceEnv: {}, cleanThreadPrewarm: false,
    processFactory: (input: Parameters<typeof factory.create>[0]) => {
      const child = factory.create(input);
      Object.defineProperty(child, "pid", { value: pid });
      return child;
    } };
  const session = { home, codexHome: home, env: { CODEX_HOME: home }, sessionHash: "original",
    release: async () => undefined };
  const input = { session, workspacePath: home, abortSignal: new AbortController().signal,
    runner: new StaticRunner(""), redactor: new DefaultRedactor(), model: "gpt-test",
    reasoningEffort: "low" as const, prompt: "synthetic cleanup regression" };
  let birth = "owned-original";
  let groupEmpty = false;
  let probeError: string | undefined;
  const probes: number[] = [];
  const signals: { pid: number; signal: Parameters<typeof process.kill>[1]; birth: string }[] = [];
  let onSignal = (_signal: Parameters<typeof process.kill>[1]) => {};
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === 0) {
      probes.push(pid);
      if (probeError) throw Object.assign(new Error("TEST probe failure"), { code: probeError });
      if (groupEmpty) throw Object.assign(new Error("TEST group absent"), { code: "ESRCH" });
      return true;
    }
    signals.push({ pid, signal, birth });
    onSignal(signal);
    return true;
  });
  return { home, factory, options, input, signals, probes,
    emptyGroup: () => { groupEmpty = true; },
    occupyGroup: () => { groupEmpty = false; },
    failProbe: (code: string) => { probeError = code; },
    changeBirth: () => { birth = "unrelated-replacement"; },
    onSignal: (handler: typeof onSignal) => { onSignal = handler; },
    remove: () => rm(home, { recursive: true, force: true }) };
}

it.each(["TERM", "stdin", "before-stop"] as const)("completes ordinary %s exit with an empty group, cached stop and replacement", async edge => {
  const f = await fixture();
  const pool = new AppServerSlotPool({ ...f.options, signalChildProcess: signalCodexAppServerChildGroup,
    runStore: new InMemoryManagedRunStore(), executionProfile: resolveCodexExecutionProfile(undefined),
    maxOutputBytes: 100_000 });
  const exitOriginal = () => { f.emptyGroup(); f.factory.processes.at(-1)!.emit("exit", 0, null); };
  f.onSignal(signal => { if (signal === "SIGTERM") queueMicrotask(exitOriginal); });
  try {
    const slot = await pool.ensureSlot(f.input);
    if (edge === "stdin") f.factory.processes[0]!.stdin.end = exitOriginal;
    if (edge === "before-stop") exitOriginal();
    await expect(slot.client.stop()).resolves.toBeUndefined();
    await expect(slot.client.stop()).resolves.toBeUndefined();
    await expect(pool.disposeSessionSlot(f.input.session)).resolves.toBeUndefined();
    expect(f.probes).toContain(-812345);
    expect(f.signals.map(s => s.signal)).toEqual(edge === "TERM" ? ["SIGTERM"] : []);
    f.occupyGroup();
    await expect(pool.ensureSlot({ ...f.input, session: { ...f.input.session, sessionHash: "replacement" } }))
      .resolves.toMatchObject({ sessionHash: "replacement" });
    expect(f.factory.spawnCount).toBe(2);
    await expect(pool.dispose()).resolves.toBeUndefined();
    expect(f.signals.map(s => s.signal)).not.toContain("SIGKILL");
  } finally { await f.remove(); }
});

it.each(["live", "EPERM", "EIO"])("retains %s group observations after graceful exit without foreign signals", async observation => {
  const f = await fixture();
  const pool = new AppServerSlotPool({ ...f.options, signalChildProcess: signalCodexAppServerChildGroup,
    runStore: new InMemoryManagedRunStore(), executionProfile: resolveCodexExecutionProfile(undefined),
    maxOutputBytes: 100_000 });
  try {
    const slot = await pool.ensureSlot(f.input);
    f.onSignal(signal => {
      if (signal === "SIGTERM") {
        f.factory.processes[0]!.emit("exit", 0, null);
        f.changeBirth();
        if (observation !== "live") f.failProbe(observation);
      }
    });
    await expect(slot.client.stop()).rejects.toMatchObject({ name: "AppServerProcessCleanupUnresolvedError" });
    await expect(pool.disposeSessionSlot(f.input.session)).rejects.toMatchObject({ name: "AppServerProcessCleanupUnresolvedError" });
    await expect(pool.disposeSessionSlot(f.input.session)).rejects.toMatchObject({ name: "AppServerProcessCleanupUnresolvedError" });
    await expect(pool.ensureSlot({ ...f.input, session: { ...f.input.session, sessionHash: "replacement" } }))
      .rejects.toThrow("cleanup_pending");
    expect(f.factory.spawnCount).toBe(1);
    expect(f.probes).toContain(-812345);
    await expect(pool.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(f.signals.filter(s => s.birth === "unrelated-replacement")).toEqual([]);
  } finally { await f.remove(); }
});

it("reconciles a retained local cleanup only after original exit and independent group emptiness", async () => {
  const f = await fixture();
  const pool = new AppServerSlotPool({ ...f.options, signalChildProcess: signalCodexAppServerChildGroup,
    runStore: new InMemoryManagedRunStore(), executionProfile: resolveCodexExecutionProfile(undefined),
    maxOutputBytes: 100_000 });
  try {
    await pool.ensureSlot(f.input);
    f.onSignal(signal => {
      if (signal === "SIGTERM") {
        f.factory.processes[0]!.emit("error", new Error("TEST observation failure"));
        f.factory.processes[0]!.emit("exit", 0, null);
      }
    });
    await expect(pool.disposeSessionSlot(f.input.session)).rejects.toBeInstanceOf(AppServerProcessCleanupError);
    await expect(pool.ensureSlot(f.input)).rejects.toThrow("cleanup_pending");
    f.emptyGroup();
    await expect(pool.disposeSessionSlot(f.input.session)).resolves.toBeUndefined();
    expect(f.signals.map(s => s.signal)).toEqual(["SIGTERM"]);
    expect(f.probes).toContain(-812345);
    await expect(pool.dispose()).resolves.toBeUndefined();
  } finally { await f.remove(); }
});

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
    expect(f.signals.map(s => s.signal)).toEqual(["SIGTERM"]);
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

it("retains ownership loss observed after retry begins, before escalation, across all cleanup edges", async () => {
  vi.useFakeTimers();
  const f = await fixture(undefined, {}, 812346);
  const pool = new AppServerSlotPool({ ...f.options, signalChildProcess: signalCodexAppServerChildGroup,
    runStore: new InMemoryManagedRunStore(), executionProfile: resolveCodexExecutionProfile(undefined),
    maxOutputBytes: 100_000 });
  try {
    await pool.ensureSlot(f.input);
    const child = f.factory.processes[0]!;
    f.onSignal(signal => {
      if (signal === "SIGTERM") child.emit("error", new Error("synthetic initial observation failure"));
    });
    await expect(pool.disposeSessionSlot(f.input.session)).rejects.toBeInstanceOf(AppServerProcessCleanupError);
    f.onSignal(() => {});
    const retry = pool.disposeSessionSlot(f.input.session).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.signals.map(s => s.signal)).toEqual(["SIGTERM", "SIGKILL", "SIGTERM"]);
    // Independent kernel observation, after the retry's TERM, before its KILL.
    child.emit("exit", 0, null);
    f.changeBirth();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.signals.filter(s => s.birth === "unrelated-replacement")).toEqual([]);
    expect(await retry).toMatchObject({ name: "AppServerProcessCleanupUnresolvedError" });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(pool.disposeSessionSlot(f.input.session)).rejects.toMatchObject({
        name: "AppServerProcessCleanupUnresolvedError",
      });
      await expect(pool.ensureSlot({ ...f.input, session: { ...f.input.session, sessionHash: "replacement" } }))
        .rejects.toThrow("cleanup_pending");
    }
    expect(child.listenerCount("exit")).toBeGreaterThan(0);
    expect(f.factory.spawnCount).toBe(1);
    await expect(pool.dispose()).rejects.toBeInstanceOf(AggregateError);
    await expect(pool.dispose()).rejects.toBeInstanceOf(AggregateError);
    await expect(pool.ensureSlot(f.input)).rejects.toThrow("pool_disposed");
    expect(f.signals.filter(s => s.birth === "unrelated-replacement")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
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

it.each(["run", "prewarm", "resume"] as const)("preserves initialization, initial cleanup and retry cleanup failures through real engine %s", async path => {
  vi.useFakeTimers();
  const f = await fixture("synthetic initialization failure");
  const observation = new Error("synthetic initial cleanup failure");
  let termCount = 0;
  f.onSignal(signal => {
    if (signal === "SIGTERM" && ++termCount === 1) f.factory.processes[0]!.emit("error", observation);
  });
  const fallback = new RecordingJsonEngine("must not run");
  const runStore = new InMemoryManagedRunStore();
  const resumeHandle = { runId: "cleanup-TEST-run", providerId: "codex", agentId: "codex-json",
    workspacePath: f.home, threadId: "cleanup-TEST-thread" };
  const request = { id: "cleanup-TEST-request", kind: "decision_required" as const,
    audience: "user" as const, question: "Continue synthetic TEST run?" };
  if (path === "resume") await runStore.saveWaitingInput({
    runId: resumeHandle.runId, resumeHandle, request, now: new Date(),
  });
  const engine = new CodexAppServerExecutionEngine({ ...f.options, fallback, runStore,
    ...(path === "resume" ? { goalMode: true } : {}) });
  const invoke = (input: typeof f.input) => path === "resume"
    ? engine.resume({ ...input, runId: resumeHandle.runId, requestId: request.id,
        answer: "continue TEST", resumeHandle })
    : engine[path](input);
  try {
    const result = invoke(f.input).catch((error: unknown) => error);
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
    const requests = f.factory.requests.length;
    const again = invoke({ ...f.input, session: { ...f.input.session, sessionHash: "replacement" } })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await again).toBeInstanceOf(AggregateError);
    expect((await again as AggregateError).errors[0].message).toContain("cleanup_pending");
    expect(f.factory.spawnCount).toBe(1);
    expect(f.factory.requests).toHaveLength(requests);
    expect(f.factory.requests.map(r => r.method)).not.toContain("thread/start");
    expect(fallback.prompts).toEqual([]);
    const disposal = engine.dispose().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await disposal).toBeInstanceOf(AggregateError);
    expect(vi.getTimerCount()).toBe(0);
  } finally { await f.remove(); }
});
