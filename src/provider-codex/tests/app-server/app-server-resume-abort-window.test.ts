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
  const path = await mkdtemp(join(tmpdir(), "codex-resume-abort-"));
  workspaces.push(path);
  return path;
}

function threadResumeCount(factory: FakeAppServerFactory): number {
  return factory.requests.filter((r) => r.method === "thread/resume").length;
}

// The abort fires in the slot-ready-to-claim window: the slot resolves, then
// the signal aborts before the durable claim runs. Nothing checks the signal
// in that window, so the claim must not flip the run.
function abortWindowHarness(abort: AbortController) {
  const factory = new FakeAppServerFactory({
    availableModels: [{ model: "gpt-test" }],
    emitTurnEventsWithStartResponse: true,
    suppressTurnCompletion: true,
  });
  const runStore = new InMemoryManagedRunStore();
  const engine = new CodexAppServerExecutionEngine({
    codexBinaryPath: "/fake/codex",
    processFactory: factory.create,
    cleanThreadPrewarm: false,
    timeoutMs: 5000,
    runStore,
    goalMode: true,
    providerEgressPolicy: codexHostedDefaultEgressPolicy(),
  });
  const pool = (engine as unknown as {
    slotPool: { ensureSlot: (...args: unknown[]) => Promise<unknown> };
  }).slotPool;
  const originalEnsureSlot = pool.ensureSlot.bind(pool);
  let armed = true;
  pool.ensureSlot = async (...args: unknown[]) => {
    const slot = await originalEnsureSlot(...args);
    if (armed) {
      armed = false;
      abort.abort();
    }
    return slot;
  };
  return { factory, engine, runStore };
}

describe("bug F: abort before the claim must not flip the run", () => {
  it("leaves the run waiting when the signal aborts between slot ready and claim", async () => {
    const home = await workspace();
    const abort = new AbortController();
    const { factory, engine, runStore } = abortWindowHarness(abort);
    try {
      const resumeHandle = {
        runId: "abort-window-run",
        providerId: "codex",
        agentId: "codex-json",
        workspacePath: home,
        threadId: "abort-window-thread",
      };
      const request = {
        id: "abort-window-request",
        kind: "decision_required" as const,
        audience: "user" as const,
        question: "Continue the abort window run?",
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
          sessionHash: "resume-abort-session", release: async () => undefined,
        },
        workspacePath: home,
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        model: "gpt-test",
        reasoningEffort: "low" as const,
        abortSignal: abort.signal,
      };
      const first = await engine.resume(resumeInput).then(() => null, (error: unknown) => error);
      expect(String(first)).toMatch(/abort/i);
      // Nothing may reach the wire before the claim, and the claim itself
      // must never run for an aborted signal.
      expect(threadResumeCount(factory)).toBe(0);
      expect((await runStore.get({ runId: resumeHandle.runId }))?.status).toBe("waiting_for_input");
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);
});
