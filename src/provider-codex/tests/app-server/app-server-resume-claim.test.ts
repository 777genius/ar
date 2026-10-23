import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../../codex-app-server-execution-engine";
import { FakeAppServerFactory } from "../../app-server/testing/fake-app-server";
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

// A runStore.resume failure after the thread was already resumed must not
// leave the run retryable, or a retry re-executes thread/resume.
function claimHarness() {
  const factory = new FakeAppServerFactory({
    availableModels: [{ model: "gpt-test" }],
    emitTurnEventsWithStartResponse: true,
    suppressTurnCompletion: true,
  });
  const runStore = new InMemoryManagedRunStore();
  const originalResume = runStore.resume.bind(runStore);
  let resumeFailures = 1;
  (runStore as unknown as { resume: typeof runStore.resume }).resume = async (input) => {
    if (resumeFailures > 0) {
      resumeFailures -= 1;
      throw new Error("store-flip-boom");
    }
    return await originalResume(input);
  };
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

function threadResumeCount(factory: FakeAppServerFactory): number {
  return factory.requests.filter((r) => r.method === "thread/resume").length;
}

describe("bug E: resume must claim the run before reopening the thread", () => {
  it("never re-executes thread/resume after a failed store flip", async () => {
    const home = await workspace();
    const { factory, engine, runStore } = claimHarness();
    try {
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
      const resumeInput = {
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
      const first = await engine.resume(resumeInput).then(() => null, (error: unknown) => error);
      expect(String(first)).toContain("store-flip-boom");
      // The claim must run before any side effect: a failed claim leaves the
      // record waiting and the thread untouched.
      expect(threadResumeCount(factory)).toBe(0);
      expect((await runStore.get({ runId: resumeHandle.runId }))?.status).toBe("waiting_for_input");
      const retry = engine.resume(resumeInput).then(() => null, (error: unknown) => error);
      // Let the retry reach whatever it reaches, then settle it one way or another.
      await waitUntil(
        () => factory.requests.filter((r) => r.method === "thread/resume").length > 1 ||
          factory.requests.some((r) => r.method === "turn/start"),
        "retry side effect observed",
      );
      emit(factory, 0, failFrame(turnIdFrom(factory, 0, "continue"), "end-probe"));
      await retry;
      // The durable claim must prevent a second thread/resume side effect.
      expect(threadResumeCount(factory)).toBe(1);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);
});
