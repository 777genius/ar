import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../../codex-app-server-execution-engine";
import {
  FakeAppServerFactory,
  type FakeAppServerFactoryOptions,
} from "../../app-server/testing/fake-app-server";
import { StaticRunner } from "../codex-provider-test-support";

// Load and failure storms through the synthetic fake app-server: no model calls,
// no official Codex package, deterministic request counters instead of wall-clock.

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true }),
  ));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-load-scenarios-"));
  workspaces.push(path);
  return path;
}

function sessionFor(home: string) {
  return {
    home,
    codexHome: home,
    env: { CODEX_HOME: home },
    sessionHash: "load-session",
    release: async () => undefined,
  };
}

function engineFor(
  factory: FakeAppServerFactory,
  options: { timeoutMs?: number; cleanThreadPrewarm?: boolean } = {},
): CodexAppServerExecutionEngine {
  return new CodexAppServerExecutionEngine({
    codexBinaryPath: "/fake/codex",
    processFactory: factory.create,
    cleanThreadPrewarm: options.cleanThreadPrewarm ?? false,
    timeoutMs: options.timeoutMs ?? 5000,
  });
}

function run(
  engine: CodexAppServerExecutionEngine,
  home: string,
  prompt: string,
  abortSignal = new AbortController().signal,
) {
  return engine.run({
    session: sessionFor(home),
    workspacePath: home,
    model: "gpt-test",
    reasoningEffort: "low",
    runner: new StaticRunner(""),
    redactor: new DefaultRedactor(),
    abortSignal,
    prompt,
  });
}

function outputOf(result: unknown): string {
  return String((result as { outputText?: unknown }).outputText ?? "");
}

function warningCodesOf(result: unknown): readonly string[] {
  const warnings = (result as { warnings?: readonly { code?: unknown }[] }).warnings ?? [];
  return warnings.map((warning) => String(warning.code ?? ""));
}

function reasonMessage(outcome: PromiseSettledResult<unknown>): string {
  return outcome.status === "rejected"
    ? String((outcome.reason as Error)?.message ?? outcome.reason)
    : "";
}

describe("app-server load scenarios without model calls", () => {
  it("completes eight concurrent isolated runs with their own outputs and leaves no processes", async () => {
    const homes = await Promise.all(Array.from({ length: 8 }, () => workspace()));
    const factory = new FakeAppServerFactory();
    const engine = engineFor(factory);
    try {
      const results = await Promise.all(
        homes.map((home, index) => run(engine, home, `load-prompt-${index}`)),
      );
      results.forEach((result, index) => {
        expect(outputOf(result)).toContain(`load-prompt-${index}`);
      });
      expect(factory.spawnCount).toBe(8);
      await engine.dispose();
      expect(factory.processes.filter((process) => !process.isExited())).toHaveLength(0);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("routes four concurrent runs sharing one slot to their own prompts", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory();
    const engine = engineFor(factory);
    try {
      const prompts = ["shared-a", "shared-b", "shared-c", "shared-d"];
      const results = await Promise.all(
        prompts.map((prompt) => run(engine, home, `cross-talk:${prompt}`)),
      );
      results.forEach((result, index) => {
        const output = outputOf(result);
        expect(output).toContain(`cross-talk:${prompts[index]}`);
        prompts.forEach((prompt, other) => {
          if (other !== index) expect(output).not.toContain(`cross-talk:${prompt}`);
        });
      });
      expect(factory.spawnCount).toBe(1);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("settles every run in a mixed failure storm and isolates the successes", async () => {
    const homes = await Promise.all(Array.from({ length: 8 }, () => workspace()));
    const failing = new Map<string, FakeAppServerFactoryOptions>([
      [homes[5]!, { emitTopLevelErrorOnTurn: "synthetic provider failure" }],
      [homes[6]!, { emitProcessErrorOnTurn: true }],
      [homes[7]!, { failThreadStart: true }],
    ]);
    const factories: FakeAppServerFactory[] = [];
    const engine = new CodexAppServerExecutionEngine({
      codexBinaryPath: "/fake/codex",
      processFactory: (input) => {
        const factory = new FakeAppServerFactory({
          availableModels: [{ model: "gpt-test" }],
          ...(failing.get(input.env.CODEX_HOME ?? "") ?? {}),
        });
        factories.push(factory);
        return factory.create(input);
      },
      cleanThreadPrewarm: false,
      timeoutMs: 5000,
    });
    try {
      const settled = await Promise.allSettled(
        homes.map((home, index) => run(engine, home, `storm-prompt-${index}`)),
      );
      settled.slice(0, 5).forEach((outcome, index) => {
        expect(outcome.status).toBe("fulfilled");
        if (outcome.status === "fulfilled") {
          expect(outputOf(outcome.value)).toContain(`storm-prompt-${index}`);
        }
      });
      expect(settled[5]?.status).toBe("rejected");
      expect(settled[6]?.status).toBe("rejected");
      expect(settled[7]?.status).toBe("rejected");
      expect(reasonMessage(settled[5]!)).toMatch(/codex_app_server_error/);
      expect(reasonMessage(settled[6]!)).toMatch(/codex_app_server_turn_error:fake app-server process failed/);
      expect(reasonMessage(settled[7]!)).toMatch(/codex_app_server_thread_start_failed/);
    } finally {
      await engine.dispose();
      factories.forEach((factory) => factory.processes.forEach((process) => process.kill()));
    }
  }, 20000);

  it("isolates a failing run from concurrent siblings sharing one process", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      failTurnStartNumbers: [2],
      turnStartError: "synthetic sibling turn start failure",
    });
    const engine = engineFor(factory);
    try {
      const prompts = ["sibling-a", "sibling-b", "sibling-c", "sibling-d"];
      const settled = await Promise.allSettled(
        prompts.map((prompt) => run(engine, home, `sibling:${prompt}`)),
      );
      const rejected = settled.filter((outcome) => outcome.status === "rejected");
      const fulfilled = settled.filter(
        (outcome) => outcome.status === "fulfilled",
      ) as PromiseFulfilledResult<Awaited<ReturnType<typeof run>>>[];
      expect(rejected).toHaveLength(1);
      expect(reasonMessage(rejected[0]!)).toMatch(/codex_app_server_turn_start_failed/);
      expect(fulfilled).toHaveLength(3);
      const outputs = fulfilled.map((outcome) => outputOf(outcome.value));
      outputs.forEach((output) => {
        expect(prompts.filter((prompt) => output.includes(`sibling:${prompt}`))).toHaveLength(1);
      });
      const matched = prompts.filter((prompt) =>
        outputs.some((output) => output.includes(`sibling:${prompt}`)));
      expect(matched).toHaveLength(3);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("retries a rejected prepared-thread turn exactly once with a fresh thread", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      failTurnStartNumbers: [1],
      turnStartError: "synthetic turn start rejection",
    });
    const engine = engineFor(factory, { cleanThreadPrewarm: true });
    try {
      await engine.prewarm({
        session: sessionFor(home),
        workspacePath: home,
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        model: "gpt-test",
        reasoningEffort: "low",
        abortSignal: new AbortController().signal,
      });
      const result = await run(engine, home, "prepared-retry-prompt");
      expect(outputOf(result)).toContain("prepared-retry-prompt");
      const turnStarts = factory.requests.filter((request) => request.method === "turn/start");
      expect(turnStarts).toHaveLength(2);
      const turnThreadIds = turnStarts.map((request) =>
        String((request.params as { threadId?: unknown } | undefined)?.threadId ?? ""));
      expect(new Set(turnThreadIds).size).toBe(2);
      expect(warningCodesOf(result)).toContain("codex_app_server_prepared_thread_failed");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("stops after one retry when the fresh thread turn start is rejected too", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      failTurnStartNumbers: [1, 2, 3],
      turnStartError: "synthetic turn start rejection",
    });
    const engine = engineFor(factory, { cleanThreadPrewarm: true });
    try {
      await engine.prewarm({
        session: sessionFor(home),
        workspacePath: home,
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        model: "gpt-test",
        reasoningEffort: "low",
        abortSignal: new AbortController().signal,
      });
      await expect(run(engine, home, "storm-bound-prompt")).rejects.toThrow(
        /codex_app_server_turn_start_failed/,
      );
      expect(factory.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("aborts half the runs mid-turn while the rest finish with their own outputs", async () => {
    const homes = await Promise.all(Array.from({ length: 6 }, () => workspace()));
    const controllers = new Map<string, AbortController>();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      onPrompt: (prompt) => {
        if (prompt.startsWith("abort-prompt")) controllers.get(prompt)?.abort();
      },
    });
    const engine = engineFor(factory);
    try {
      const settled = await Promise.allSettled(
        homes.map((home, index) => {
          const prompt = index % 2 === 0 ? `abort-prompt-${index}` : `keep-prompt-${index}`;
          const controller = new AbortController();
          controllers.set(prompt, controller);
          return run(engine, home, prompt, controller.signal);
        }),
      );
      settled.forEach((outcome, index) => {
        if (index % 2 === 0) {
          expect(outcome.status).toBe("rejected");
          expect(reasonMessage(outcome)).toMatch(/codex_app_server_aborted|codex_app_server_turn_aborted/);
        } else {
          expect(outcome.status).toBe("fulfilled");
          if (outcome.status === "fulfilled") {
            expect(outputOf(outcome.value)).toContain(`keep-prompt-${index}`);
          }
        }
      });
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("rejects a turn that never completes with a turn timeout", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      suppressTurnCompletion: true,
    });
    const engine = engineFor(factory, { timeoutMs: 750 });
    try {
      const outcome = await Promise.allSettled([run(engine, home, "hang-prompt")]);
      expect(outcome[0]?.status).toBe("rejected");
      expect(reasonMessage(outcome[0]!)).toMatch(/codex_app_server_turn_timeout/);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("rejects a turn whose final output is lost", async () => {
    const home = await workspace();
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      suppressOutputTurnNumbers: [1],
    });
    const engine = engineFor(factory);
    try {
      await expect(run(engine, home, "lost-output-prompt")).rejects.toThrow(
        /codex_app_server_final_message_missing/,
      );
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);
});
