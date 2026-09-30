import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../../codex-app-server-execution-engine";
import type { CodexAppServerProcessFactory } from "../../app-server/application/app-server-process-port";
import { FakeAppServerFactory } from "../../app-server/testing/fake-app-server";
import { AppServerSlotPool } from "../../app-server/application/app-server-slot-pool";
import { resolveCodexExecutionProfile } from "../../codex-execution-profile";
import { InMemoryManagedRunStore } from "../../codex-app-server-managed-run-store";
import { StaticRunner } from "../codex-provider-test-support";

type DelayedInitialize = {
  readonly processFactory: CodexAppServerProcessFactory;
  readonly release: () => void;
};

function delayedInitialize(factory: FakeAppServerFactory): DelayedInitialize {
  const pending: Array<() => void> = [];
  return {
    processFactory: (input) => {
      const child = factory.create(input);
      const emit = child.stdout.emit.bind(child.stdout);
      child.stdout.emit = ((event: string, ...args: unknown[]) => {
        if (event !== "data") return emit(event, ...args);
        const packet = JSON.parse(String(args[0])) as { readonly id?: number };
        const request = factory.requests.find((entry) => entry.id === packet.id);
        if (request?.method !== "initialize") return emit(event, ...args);
        pending.push(() => emit(event, ...args));
        return true;
      }) as typeof child.stdout.emit;
      return child;
    },
    release: () => {
      for (const response of pending.splice(0)) response();
    },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("AppServerSlotPool", () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map(async (workspace) =>
      await rm(workspace, { recursive: true, force: true }),
    ));
  });

  async function workspace(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "codex-slot-pool-test-"));
    workspaces.push(path);
    return path;
  }

  function run(
    engine: CodexAppServerExecutionEngine,
    home: string,
    abortSignal = new AbortController().signal,
  ): Promise<unknown> {
    return engine.run({
      session: {
        home,
        codexHome: home,
        env: { CODEX_HOME: home },
        sessionHash: "slot-session",
        release: async () => undefined,
      },
      workspacePath: home,
      model: "gpt-test",
      reasoningEffort: "low",
      runner: new StaticRunner(""),
      redactor: new DefaultRedactor(),
      abortSignal,
      prompt: "fake slot turn",
    });
  }

  it("shares concurrent same-session startup and leaves no child after dispose", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory();
    const engine = new CodexAppServerExecutionEngine({
      codexBinaryPath: "/fake/codex",
      processFactory: factory.create,
      cleanThreadPrewarm: false,
    });

    try {
      await Promise.all([run(engine, home), run(engine, home)]);
      expect(factory.spawnCount).toBe(1);
      await engine.dispose();
      expect(factory.processes.filter((process) => !process.isExited())).toHaveLength(0);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  });

  it("shares a concurrent startup failure and allows a later retry", async () => {
    const home = await workspace();
    const failingFactory = new FakeAppServerFactory({
      initializeError: "fake initialize failure",
    });
    const succeedingFactory = new FakeAppServerFactory();
    let starts = 0;
    const engine = new CodexAppServerExecutionEngine({
      codexBinaryPath: "/fake/codex",
      processFactory: (input) => {
        starts += 1;
        return starts === 1
          ? failingFactory.create(input)
          : succeedingFactory.create(input);
      },
      cleanThreadPrewarm: false,
    });

    try {
      const failures = await Promise.allSettled([run(engine, home), run(engine, home)]);
      expect(failures.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(starts).toBe(1);
      await expect(run(engine, home)).resolves.toBeTruthy();
      expect(starts).toBe(2);
    } finally {
      await engine.dispose();
      [...failingFactory.processes, ...succeedingFactory.processes].forEach((process) => process.kill());
    }
  });

  it("starts different CODEX_HOME slots in parallel", async () => {
    const firstHome = await workspace();
    const secondHome = await workspace();
    const factory = new FakeAppServerFactory();
    const delayed = delayedInitialize(factory);
    const engine = new CodexAppServerExecutionEngine({
      codexBinaryPath: "/fake/codex",
      processFactory: delayed.processFactory,
      cleanThreadPrewarm: false,
    });

    try {
      const runs = [run(engine, firstHome), run(engine, secondHome)];
      await waitFor(() => factory.spawnCount === 2);
      delayed.release();
      await Promise.all(runs);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  });

  it("cancels startup before dispose can publish a late child", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory();
    const delayed = delayedInitialize(factory);
    const engine = new CodexAppServerExecutionEngine({
      codexBinaryPath: "/fake/codex",
      processFactory: delayed.processFactory,
      cleanThreadPrewarm: false,
      startupTimeoutMs: 500,
    });

    try {
      const task = run(engine, home);
      await waitFor(() => factory.spawnCount === 1);
      const disposal = engine.dispose();
      delayed.release();
      await disposal;
      await expect(task).rejects.toThrow("codex_app_server");
      expect(factory.processes.filter((process) => !process.isExited())).toHaveLength(0);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  });

  it("cancels an unshared startup but keeps an existing slot for an already-aborted caller", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory();
    const delayed = delayedInitialize(factory);
    const engine = new CodexAppServerExecutionEngine({
      codexBinaryPath: "/fake/codex",
      processFactory: delayed.processFactory,
      cleanThreadPrewarm: false,
    });

    try {
      const controller = new AbortController();
      const startup = run(engine, home, controller.signal);
      await waitFor(() => factory.spawnCount === 1);
      controller.abort();
      await expect(startup).rejects.toThrow("codex_app_server_aborted_before_slot_acquired");
      expect(factory.processes[0]?.isExited()).toBe(true);

      const ready = run(engine, home);
      await waitFor(() => factory.spawnCount === 2);
      delayed.release();
      await ready;

      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      await expect(run(engine, home, alreadyAborted.signal)).rejects.toThrow(
        "codex_app_server_aborted_before_slot_acquired",
      );
      expect(factory.spawnCount).toBe(2);
      expect(factory.processes[1]?.isExited()).toBe(false);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  });

  it("does not cancel a shared startup when one waiting caller aborts", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory();
    const delayed = delayedInitialize(factory);
    const engine = new CodexAppServerExecutionEngine({
      codexBinaryPath: "/fake/codex",
      processFactory: delayed.processFactory,
      cleanThreadPrewarm: false,
    });

    try {
      const cancelled = new AbortController();
      const first = run(engine, home, cancelled.signal);
      await waitFor(() => factory.spawnCount === 1);
      const second = run(engine, home);
      cancelled.abort();
      await expect(first).rejects.toThrow("codex_app_server_aborted_before_slot_acquired");
      expect(factory.processes[0]?.isExited()).toBe(false);
      delayed.release();
      await second;
      expect(factory.spawnCount).toBe(1);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  });

  it("stops startup when the last caller aborts just after initialize resolves", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory();
    const controller = new AbortController();
    const engine = new CodexAppServerExecutionEngine({
      codexBinaryPath: "/fake/codex",
      processFactory: (input) => {
        const child = factory.create(input);
        const emit = child.stdout.emit.bind(child.stdout);
        child.stdout.emit = ((event: string, ...args: unknown[]) => {
          if (event !== "data") return emit(event, ...args);
          const packet = JSON.parse(String(args[0])) as { readonly id?: number };
          const request = factory.requests.find((entry) => entry.id === packet.id);
          const result = emit(event, ...args);
          if (request?.method === "initialize") controller.abort();
          return result;
        }) as typeof child.stdout.emit;
        return child;
      },
      cleanThreadPrewarm: false,
    });

    try {
      await expect(run(engine, home, controller.signal)).rejects.toThrow(
        "codex_app_server_aborted_before_slot_acquired",
      );
      expect(factory.processes.filter((process) => !process.isExited())).toHaveLength(0);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  });
  function cleanupFixture(initializeError?: string, delay = false) {
    const factory = new FakeAppServerFactory({ ...(initializeError ? { initializeError } : {}) });
    const delayed = delayedInitialize(factory);
    let fail = true;
    let stops = 0;
    const pool = new AppServerSlotPool({
      codexBinaryPath: "/fake/codex", sourceEnv: {}, processFactory: delay ? delayed.processFactory : factory.create,
      signalChildProcess: (child, signal) => {
        if (signal === "SIGTERM") stops += 1;
        if (fail) throw new Error("fake owned signal failure");
        child.kill(signal);
      },
      runStore: new InMemoryManagedRunStore(),
      executionProfile: resolveCodexExecutionProfile(undefined),
      cleanThreadPrewarm: false, maxOutputBytes: 100_000,
    });
    const session = (home: string, sessionHash = "first") => ({
      home, codexHome: home, env: { CODEX_HOME: home }, sessionHash,
      release: async () => undefined,
    });
    const acquire = (home: string, hash = "first") => pool.ensureSlot({
      session: session(home, hash), workspacePath: home,
      abortSignal: new AbortController().signal,
    });
    return { pool, factory, session, acquire, release: delayed.release, allowStop: () => { fail = false; }, stops: () => stops };
  }

  it("retains failed session cleanup, fences reuse and replacement, and retries the same child", async () => {
    const home = await workspace();
    const f = cleanupFixture();
    await f.acquire(home);
    await expect(f.pool.disposeSessionSlot(f.session(home))).rejects.toThrow();
    expect(f.factory.processes[0]?.isExited()).toBe(false);
    await expect(f.acquire(home)).rejects.toThrow();
    await expect(f.acquire(home, "replacement")).rejects.toThrow();
    expect(f.factory.spawnCount).toBe(1);
    f.allowStop();
    await f.pool.disposeSessionSlot(f.session(home));
    expect(f.stops()).toBe(2);
    expect(f.factory.processes[0]?.isExited()).toBe(true);
    await f.acquire(home, "replacement");
    expect(f.factory.spawnCount).toBe(2);
    await f.pool.dispose();
  });

  it("does not lose the old child when replacement cleanup fails", async () => {
    const home = await workspace();
    const f = cleanupFixture();
    await f.acquire(home);
    await expect(f.acquire(home, "replacement")).rejects.toThrow();
    await expect(f.acquire(home, "replacement")).rejects.toThrow();
    expect(f.factory.spawnCount).toBe(1);
    expect(f.factory.processes[0]?.isExited()).toBe(false);
    f.allowStop();
    await f.pool.dispose();
    expect(f.factory.processes[0]?.isExited()).toBe(true);
  });

  it("retains startup cleanup failures and exposes both failures", async () => {
    const home = await workspace();
    const f = cleanupFixture("fake initialize failure");
    const error = await f.acquire(home).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect(f.factory.processes[0]?.isExited()).toBe(false);
    await expect(f.acquire(home)).rejects.toThrow();
    expect(f.factory.spawnCount).toBe(1);
    f.allowStop();
    await f.pool.dispose();
    expect(f.stops()).toBe(2);
    expect(f.factory.processes[0]?.isExited()).toBe(true);
  });

  it("aggregates independent global cleanup failures and retries every retained child", async () => {
    const homes = [await workspace(), await workspace()];
    const f = cleanupFixture();
    await Promise.all(homes.map((home) => f.acquire(home)));
    const error = await f.pool.dispose().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect(f.stops()).toBe(2);
    expect(f.factory.processes.every((child) => !child.isExited())).toBe(true);
    f.allowStop();
    await f.pool.dispose();
    expect(f.stops()).toBe(4);
    expect(f.factory.processes.every((child) => child.isExited())).toBe(true);
  });

  it("retains disposed-during-start cleanup failure and retries without publishing a child", async () => {
    const home = await workspace();
    const f = cleanupFixture(undefined, true);
    const startup = f.acquire(home).catch((error: unknown) => error);
    await waitFor(() => f.factory.spawnCount === 1);
    await expect(f.pool.disposeSessionSlot(f.session(home))).rejects.toThrow();
    expect(await startup).toBeInstanceOf(AggregateError);
    expect(f.factory.processes[0]?.isExited()).toBe(false);
    await expect(f.acquire(home)).rejects.toThrow("cleanup_pending");
    expect(f.factory.spawnCount).toBe(1);
    f.allowStop();
    await f.pool.dispose();
    expect(f.factory.processes[0]?.isExited()).toBe(true);
  });

  it("orders concurrent disposal and acquire behind observable exit without duplicate starts", async () => {
    const home = await workspace();
    const f = cleanupFixture();
    f.allowStop();
    const original = await f.acquire(home);
    expect(await f.acquire(home)).toBe(original);
    const child = f.factory.processes[0]!;
    const kill = child.kill.bind(child);
    child.kill = () => true;
    const disposal = f.pool.disposeSessionSlot(f.session(home));
    const next = f.acquire(home);
    await waitFor(() => f.stops() === 1);
    expect(f.factory.spawnCount).toBe(1);
    expect(child.isExited()).toBe(false);
    kill();
    await disposal;
    await next;
    expect(f.factory.spawnCount).toBe(2);
    expect(child.isExited()).toBe(true);
    await f.pool.dispose();
  });

  it("retains a no-exit timeout through repeated disposal and stops the original process", async () => {
    vi.useFakeTimers();
    try {
      const home = await workspace();
      const f = cleanupFixture();
      f.allowStop();
      await f.acquire(home);
      const child = f.factory.processes[0]!;
      const kill = child.kill.bind(child);
      child.kill = () => true;
      const first = f.pool.disposeSessionSlot(f.session(home)).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await first).toBeInstanceOf(Error);
      expect(child.isExited()).toBe(false);
      const second = f.pool.disposeSessionSlot(f.session(home)).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await second).toBeInstanceOf(Error);
      expect(f.stops()).toBe(2);
      expect(f.factory.spawnCount).toBe(1);
      child.kill = kill;
      await f.pool.disposeSessionSlot(f.session(home));
      expect(child.isExited()).toBe(true);
      expect(f.stops()).toBe(3);
      await f.pool.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes independent owned cleanup before reporting global failure", async () => {
    const homes = [await workspace(), await workspace()];
    const f = cleanupFixture();
    f.allowStop();
    await Promise.all(homes.map((home) => f.acquire(home)));
    const failed = f.factory.processes[0]!;
    const waiting = f.factory.processes[1]!;
    const killFailed = failed.kill.bind(failed);
    const killWaiting = waiting.kill.bind(waiting);
    failed.kill = () => { throw new Error("fake one-child signal failure"); };
    waiting.kill = () => true;
    let settled = false;
    const disposal = f.pool.dispose().catch((error: unknown) => { settled = true; return error; });
    await waitFor(() => f.stops() === 2);
    expect(settled).toBe(false);
    expect(waiting.isExited()).toBe(false);
    killWaiting();
    expect(await disposal).toBeInstanceOf(AggregateError);
    expect(waiting.isExited()).toBe(true);
    expect(failed.isExited()).toBe(false);
    failed.kill = killFailed;
    await f.pool.dispose();
    expect(failed.isExited()).toBe(true);
    expect(f.stops()).toBe(3);
  });

  it("retains a failed final signal after parent exit without reusing its identity", async () => {
    const home = await workspace();
    const f = cleanupFixture();
    f.allowStop();
    await f.acquire(home);
    const child = f.factory.processes[0]!;
    const kill = child.kill.bind(child);
    let finalSignals = 0;
    let failFinal = true;
    child.kill = (signal?: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        finalSignals += 1;
        if (failFinal) throw new Error("fake surviving group signal failure");
      }
      return kill();
    };
    await expect(f.pool.disposeSessionSlot(f.session(home))).rejects.toThrow();
    expect(child.isExited()).toBe(true);
    await expect(f.pool.disposeSessionSlot(f.session(home))).rejects.toMatchObject({
      name: "AppServerProcessCleanupUnresolvedError",
    });
    expect(finalSignals).toBe(1);
    await expect(f.acquire(home)).rejects.toThrow("cleanup_pending");
    // Making signalling available again is not positive ownership proof.
    failFinal = false;
    await expect(f.pool.disposeSessionSlot(f.session(home))).rejects.toThrow();
    await expect(f.acquire(home, "replacement")).rejects.toThrow("cleanup_pending");
    expect(finalSignals).toBe(1);
    expect(f.factory.spawnCount).toBe(1);
    await expect(f.pool.dispose()).rejects.toBeInstanceOf(AggregateError);
    await expect(f.pool.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(finalSignals).toBe(1);
  });

});
