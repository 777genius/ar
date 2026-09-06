import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../codex-app-server-execution-engine";
import { FakeAppServerFactory } from "../app-server/testing/fake-app-server";
import { RecordingJsonEngine, StaticRunner } from "./codex-provider-test-support";

type StreamFilter = (packet: Record<string, unknown>) => Record<string, unknown> | null;

function filteredFactory(factory: FakeAppServerFactory, filter: StreamFilter) {
  return (input: Parameters<FakeAppServerFactory["create"]>[0]) => {
    const child = factory.create(input);
    const emit = child.stdout.emit.bind(child.stdout);
    child.stdout.emit = ((event: string, ...args: unknown[]) => {
      if (event !== "data") return emit(event, ...args);
      const packet = JSON.parse(String(args[0])) as Record<string, unknown>;
      const filtered = filter(packet);
      return filtered === null
        ? true
        : emit(event, `${JSON.stringify(filtered)}\n`);
    }) as typeof child.stdout.emit;
    return child;
  };
}

async function runFake(input: {
  readonly factory: FakeAppServerFactory;
  readonly processFactory?: ReturnType<typeof filteredFactory>;
  readonly fallback?: RecordingJsonEngine;
  readonly goalMode?: boolean;
  readonly cleanThreadPrewarm?: boolean;
}) {
  const workspace = await mkdtemp(join(tmpdir(), "codex-app-replay-safety-"));
  const engine = new CodexAppServerExecutionEngine({
    codexBinaryPath: "/bin/codex-test",
    processFactory: input.processFactory ?? input.factory.create,
    ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
    ...(input.goalMode === undefined ? {} : { goalMode: input.goalMode }),
    ...(input.cleanThreadPrewarm === undefined
      ? {}
      : { cleanThreadPrewarm: input.cleanThreadPrewarm }),
    timeoutMs: 100,
  });
  const execution = {
    session: {
      home: workspace,
      codexHome: workspace,
      env: { CODEX_HOME: workspace },
      sessionHash: "synthetic",
      release: async () => undefined,
    },
    workspacePath: workspace,
    model: "gpt-test",
    reasoningEffort: "low" as const,
    runner: new StaticRunner(""),
    redactor: new DefaultRedactor(),
    abortSignal: new AbortController().signal,
    prompt: "Synthetic replay-safety task",
  };
  return { engine, execution, workspace };
}

async function disposeFake(input: {
  readonly engine: CodexAppServerExecutionEngine;
  readonly factory: FakeAppServerFactory;
  readonly workspace: string;
}) {
  await input.engine.dispose();
  input.factory.processes.forEach((process) => process.kill());
  await rm(input.workspace, { recursive: true, force: true });
}

describe("Codex app-server replay safety", () => {
  it("does not fallback after an accepted turn times out", async () => {
    const factory = new FakeAppServerFactory();
    const fallback = new RecordingJsonEngine("duplicate fallback");
    const processFactory = filteredFactory(factory, (packet) =>
      packet.method === "turn/completed" ? null : packet,
    );
    const test = await runFake({ factory, processFactory, fallback });
    try {
      await expect(test.engine.run(test.execution)).rejects.toThrow();
      expect(fallback.prompts).toEqual([]);
    } finally {
      await disposeFake({ ...test, factory });
    }
  });

  it("does not fallback when turn-start acknowledgement is lost without events", async () => {
    const factory = new FakeAppServerFactory();
    const fallback = new RecordingJsonEngine("duplicate fallback");
    const processFactory = filteredFactory(factory, (packet) => {
      const request = factory.requests.find((entry) => entry.id === packet.id);
      if (request?.method === "turn/start") return null;
      return ["turn/started", "item/agentMessage/delta", "turn/completed"].includes(
        String(packet.method),
      ) ? null : packet;
    });
    const test = await runFake({ factory, processFactory, fallback });
    try {
      await expect(test.engine.run(test.execution)).rejects.toThrow();
      expect(fallback.prompts).toEqual([]);
    } finally {
      await disposeFake({ ...test, factory });
    }
  });

  it("does not retry a prepared turn after an accepted timeout without a callback", async () => {
    const factory = new FakeAppServerFactory();
    const processFactory = filteredFactory(factory, (packet) =>
      packet.method === "turn/completed" ? null : packet,
    );
    const test = await runFake({ factory, processFactory, cleanThreadPrewarm: true });
    try {
      await test.engine.prewarm(test.execution);
      await expect(test.engine.run(test.execution)).rejects.toThrow();
      expect(factory.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    } finally {
      await disposeFake({ ...test, factory });
    }
  });

  it("does not fallback after an accepted empty completion", async () => {
    const factory = new FakeAppServerFactory({ suppressOutputTurnNumbers: [1] });
    const fallback = new RecordingJsonEngine("duplicate fallback");
    const test = await runFake({ factory, fallback });
    try {
      await expect(test.engine.run(test.execution)).rejects.toThrow();
      expect(fallback.prompts).toEqual([]);
    } finally {
      await disposeFake({ ...test, factory });
    }
  });

  it("does not fallback when goal control fails after a turn", async () => {
    const factory = new FakeAppServerFactory();
    const fallback = new RecordingJsonEngine("duplicate fallback");
    const processFactory = filteredFactory(factory, (packet) => {
      const request = factory.requests.find((entry) => entry.id === packet.id);
      return request?.method === "thread/goal/get"
        ? { id: packet.id, error: { message: "synthetic goal lookup failed" } }
        : packet;
    });
    const test = await runFake({ factory, processFactory, fallback, goalMode: true });
    try {
      await expect(test.engine.run(test.execution)).rejects.toThrow();
      expect(fallback.prompts).toEqual([]);
    } finally {
      await disposeFake({ ...test, factory });
    }
  });

  it("falls back after an explicit thread-start rejection", async () => {
    const factory = new FakeAppServerFactory({ failThreadStart: true });
    const fallback = new RecordingJsonEngine("fallback output");
    const test = await runFake({ factory, fallback });
    try {
      await expect(test.engine.run(test.execution)).resolves.toMatchObject({ outputText: "fallback output" });
      expect(fallback.prompts).toEqual([test.execution.prompt]);
    } finally {
      await disposeFake({ ...test, factory });
    }
  });

  it("retries a prepared turn after an explicit start rejection", async () => {
    const factory = new FakeAppServerFactory();
    let rejected = false;
    const processFactory = filteredFactory(factory, (packet) => {
      const request = factory.requests.find((entry) => entry.id === packet.id);
      if (!rejected && request?.method === "turn/start") {
        rejected = true;
        return { id: packet.id, error: { message: "synthetic turn rejection" } };
      }
      return packet;
    });
    const test = await runFake({ factory, processFactory, cleanThreadPrewarm: true });
    try {
      await test.engine.prewarm(test.execution);
      await expect(test.engine.run(test.execution)).resolves.toMatchObject({
        outputText: "app-server output:Synthetic replay-safety task",
      });
      expect(factory.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
    } finally {
      await disposeFake({ ...test, factory });
    }
  });
});
