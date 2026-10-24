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
import { codexHostedDefaultEgressPolicy } from "../../codex-provider-egress-policy";
import { InMemoryManagedRunStore } from "../../codex-app-server-managed-run-store";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true }),
  ));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-resume-claim-"));
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

// The durable claim (runStore.resume) is the at-most-once fence for the
// thread/resume side effect: nothing may reach the wire before it, and once it
// holds, a failure past it must never hand the run back as retryable.
function resumeHarness(input: {
  readonly factory?: Partial<FakeAppServerFactoryOptions>;
  readonly resumeFailures?: number;
  readonly failWriteError?: Error;
} = {}) {
  const factory = new FakeAppServerFactory({
    availableModels: [{ model: "gpt-test" }],
    emitTurnEventsWithStartResponse: true,
    suppressTurnCompletion: true,
    ...input.factory,
  });
  const runStore = new InMemoryManagedRunStore();
  const originalResume = runStore.resume.bind(runStore);
  let resumeFailures = input.resumeFailures ?? 0;
  (runStore as unknown as { resume: typeof runStore.resume }).resume = async (resumeInput) => {
    if (resumeFailures > 0) {
      resumeFailures -= 1;
      throw new Error("store-flip-boom");
    }
    return await originalResume(resumeInput);
  };
  const failWriteError = input.failWriteError;
  if (failWriteError) {
    (runStore as unknown as { fail: typeof runStore.fail }).fail = async () => {
      throw failWriteError;
    };
  }
  const engine = new CodexAppServerExecutionEngine({
    codexBinaryPath: "/fake/codex",
    processFactory: factory.create,
    cleanThreadPrewarm: false,
    timeoutMs: 5000,
    runStore,
    goalMode: true,
    providerEgressPolicy: codexHostedDefaultEgressPolicy(),
  });
  return { factory, engine, runStore };
}

async function waitingRun(runStore: InMemoryManagedRunStore, home: string) {
  const resumeHandle = {
    runId: "claim-run",
    providerId: "codex",
    agentId: "codex-json",
    workspacePath: home,
    threadId: "claim-thread",
  };
  const request = {
    id: "claim-request",
    kind: "decision_required" as const,
    audience: "user" as const,
    question: "Continue the claim run?",
  };
  await runStore.saveWaitingInput({
    runId: resumeHandle.runId,
    resumeHandle,
    request,
    now: new Date(),
  });
  return {
    runId: resumeHandle.runId,
    requestId: request.id,
    answer: "continue",
    resumeHandle,
    session: {
      home, codexHome: home, env: { CODEX_HOME: home },
      sessionHash: "resume-claim-session", release: async () => undefined,
    },
    workspacePath: home,
    runner: new StaticRunner(""),
    redactor: new DefaultRedactor(),
    model: "gpt-test",
    reasoningEffort: "low" as const,
    abortSignal: new AbortController().signal,
  };
}

function threadResumeCount(factory: FakeAppServerFactory): number {
  return factory.requests.filter((r) => r.method === "thread/resume").length;
}

describe("bug E: resume must claim the run before reopening the thread", () => {
  it("never re-executes thread/resume after a failed store flip", async () => {
    const home = await workspace();
    const { factory, engine, runStore } = resumeHarness({ resumeFailures: 1 });
    try {
      const resumeInput = await waitingRun(runStore, home);
      const first = await engine.resume(resumeInput).then(() => null, (error: unknown) => error);
      expect(String(first)).toContain("store-flip-boom");
      // The claim must run before any side effect: a failed claim leaves the
      // record waiting and the thread untouched.
      expect(threadResumeCount(factory)).toBe(0);
      expect((await runStore.get({ runId: resumeInput.runId }))?.status).toBe("waiting_for_input");
      const retryFrom = factory.requests.length;
      const retry = engine.resume(resumeInput).then(() => null, (error: unknown) => error);
      // Let the retry reach whatever it reaches, then settle it one way or another.
      await waitUntil(
        () => factory.requests.filter((r) => r.method === "thread/resume").length > 1 ||
          factory.requests.some((r) => r.method === "turn/start"),
        "retry side effect observed",
      );
      // The failed claim poisoned the first slot, so the retry runs on a fresh
      // process; settle its turn there instead of waiting out the turn timeout.
      emit(factory, factory.processes.length - 1, failFrame(turnIdFrom(factory, retryFrom, "continue"), "end-probe"));
      expect(String(await retry)).toContain("end-probe");
      // The durable claim must prevent a second thread/resume side effect.
      expect(threadResumeCount(factory)).toBe(1);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("fails a claimed run whose thread/resume broke instead of stranding it active", async () => {
    const home = await workspace();
    const { factory, engine, runStore } = resumeHarness({
      factory: { throwOnRequestMethod: "thread/resume" },
    });
    try {
      const resumeInput = await waitingRun(runStore, home);
      const first = await engine.resume(resumeInput).then(() => null, (error: unknown) => error);
      expect(String(first)).toContain("fake app-server stdin write failed");
      // Whether the broken request reached the server is unknown, so the claim
      // stays spent: the run is terminal, never handed back as waiting.
      const record = await runStore.get({ runId: resumeInput.runId });
      expect(record?.status).toBe("failed");
      expect(record?.failure?.code).toBe("unknown_runtime_failure");
      const spawned = factory.spawnCount;
      const retry = await engine.resume(resumeInput).then(() => null, (error: unknown) => error);
      expect(String(retry)).toContain("codex_managed_run_not_waiting_for_input");
      expect(factory.spawnCount).toBe(spawned);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  it("surfaces the original failure when the best-effort fail write is lost", async () => {
    const home = await workspace();
    const { factory, engine, runStore } = resumeHarness({
      factory: { throwOnRequestMethod: "thread/resume" },
      failWriteError: new Error("fail-write-boom"),
    });
    try {
      const resumeInput = await waitingRun(runStore, home);
      const first = await engine.resume(resumeInput).then(() => null, (error: unknown) => error);
      expect(String(first)).toContain("fake app-server stdin write failed");
      // The lost fail write leaves the claim in place, which still fences the
      // side effect: a retry is refused before any process is touched.
      expect((await runStore.get({ runId: resumeInput.runId }))?.status).toBe("active");
      const spawned = factory.spawnCount;
      const retry = await engine.resume(resumeInput).then(() => null, (error: unknown) => error);
      expect(String(retry)).toContain("codex_managed_run_not_waiting_for_input");
      expect(factory.spawnCount).toBe(spawned);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);
});
