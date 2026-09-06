import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../index";
import { FakeAppServerFactory } from "../app-server/testing/fake-app-server";
import { StaticRunner } from "./codex-provider-test-support";

async function setup(input: Record<string, unknown> = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "codex-app-protocol-safety-"));
  const { factory: suppliedFactory, ...options } = input;
  const factory = suppliedFactory instanceof FakeAppServerFactory ? suppliedFactory : new FakeAppServerFactory();
  const engine = new CodexAppServerExecutionEngine({
    codexBinaryPath: "/bin/codex-test", processFactory: factory.create,
    cleanThreadPrewarm: false, ...options,
  });
  const runInput = {
    session: { home: workspace, codexHome: workspace, env: { CODEX_HOME: workspace }, sessionHash: "test", release: async () => undefined },
    workspacePath: workspace, model: "gpt-test", reasoningEffort: "low" as const,
    runner: new StaticRunner(""), redactor: new DefaultRedactor(),
    abortSignal: new AbortController().signal, prompt: "protocol safety",
  };
  await engine.prewarm(runInput);
  const slots = (engine as unknown as { readonly slotPool: { readonly slots: Map<string, { readonly client: unknown }> } }).slotPool.slots;
  const client = (Array.from(slots.values())[0]! as { readonly client: {
    readonly turns: Map<string, unknown>;
    readonly earlyTurnIdsByThread: Map<string, string>;
    readonly startingTurnThreads: Set<string>;
  } }).client;
  const child = factory.processes[0]!;
  const emit = (message: unknown) => child.stdout.emit("data", `${JSON.stringify(message)}\n`);
  return {
    engine, factory, client, child, emit, runInput,
    close: async () => { await engine.dispose(); await rm(workspace, { recursive: true, force: true }); },
  };
}

describe("Codex app-server protocol state bounds", () => {
  it("ignores idle unknown started and delta floods without poisoning a warm slot", async () => {
    const test = await setup();
    try {
      for (let id = 0; id < 1_000; id += 1) {
        test.emit({ method: "turn/started", params: { threadId: `idle-${id}`, turn: { id: `idle-${id}` } } });
        test.emit({ method: "item/agentMessage/delta", params: { turnId: `idle-${id}`, delta: "x".repeat(512) } });
      }
      expect(test.client.turns.size).toBe(0);
      expect(test.client.earlyTurnIdsByThread.size).toBe(0);
      await expect(test.engine.run(test.runInput)).resolves.toMatchObject({ outputText: expect.stringContaining("protocol safety") });
    } finally { await test.close(); }
  });

  it("does not retain late events for completed turn IDs", async () => {
    const test = await setup();
    try {
      for (let id = 1; id <= 50; id += 1) {
        await expect(test.engine.run(test.runInput)).resolves.toMatchObject({ outputText: expect.stringContaining("protocol safety") });
        test.emit({ method: "item/agentMessage/delta", params: { turnId: `turn-${id}`, delta: "late" } });
        test.emit({ method: "turn/completed", params: { turn: { id: `turn-${id}`, status: "completed" } } });
      }
      expect(test.client.turns.size).toBe(0);
    } finally { await test.close(); }
  });

  it("clears unknown events observed during an active turn after completion", async () => {
    const factory = new FakeAppServerFactory();
    let injected = false;
    const test = await setup({ processFactory: (input: Parameters<typeof factory.create>[0]) => {
      const child = factory.create(input);
      const emit = child.stdout.emit.bind(child.stdout);
      child.stdout.emit = ((event: string | symbol, ...args: unknown[]) => {
        if (event === "data" && !injected && String(args[0]).includes("item/agentMessage/delta")) {
          injected = true;
          for (let id = 0; id < 40; id += 1) emit("data", `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: `orphan-${id}`, delta: "x" } })}\n`);
        }
        return emit(event, ...args);
      }) as typeof child.stdout.emit;
      return child;
    }, factory });
    try {
      await expect(test.engine.run(test.runInput)).resolves.toMatchObject({ outputText: expect.stringContaining("protocol safety") });
      expect(test.client.turns.size).toBe(0);
      expect(test.client.startingTurnThreads.size).toBe(0);
    } finally { await test.close(); }
  });

  it("stops immediately when a protocol failure races a hung rate-limit handler", async () => {
    let release: () => void = () => undefined;
    let refreshStarted = false;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const factory = new FakeAppServerFactory();
    const test = await setup({ factory, processFactory: (input: Parameters<typeof factory.create>[0]) => {
      const child = factory.create(input);
      const write = child.stdin.write;
      child.stdin.write = (chunk) => {
        const request = JSON.parse(String(chunk)) as { readonly id: number; readonly method?: string };
        if (request.method === "account/rateLimits/read") {
          child.stdout.emit("data", `${JSON.stringify({ id: request.id, result: {} })}\n`);
        }
        return write(chunk);
      };
      return child;
    }, rateLimitsSnapshotHandler: async (input: { readonly source: string }) => {
      if (input.source === "notification_refetch") {
        refreshStarted = true;
        await barrier;
      }
      return { status: "admitted" as const };
    } });
    try {
      test.emit({ method: "account/rateLimits/updated", params: {} });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(refreshStarted).toBe(true);
      test.child.stdout.emit("data", "x".repeat(5 * 1024 * 1024));
      let timeout: NodeJS.Timeout | undefined;
      await expect(Promise.race([
        test.engine.dispose(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("protocol shutdown stuck")), 200); }),
      ])).resolves.toBeUndefined();
      if (timeout) clearTimeout(timeout);
      expect(test.child.isExited()).toBe(true);
    } finally {
      release();
      await test.close();
    }
  });
});
