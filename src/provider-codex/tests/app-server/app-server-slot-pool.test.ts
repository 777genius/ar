import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../../codex-app-server-execution-engine";
import type { CodexAppServerProcessFactory } from "../../app-server/application/app-server-process-port";
import { FakeAppServerFactory } from "../../app-server/testing/fake-app-server";
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
});
