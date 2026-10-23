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
  const path = await mkdtemp(join(tmpdir(), "codex-resume-claim-abort-"));
  workspaces.push(path);
  return path;
}

function threadResumeCount(factory: FakeAppServerFactory): number {
  return factory.requests.filter((r) => r.method === "thread/resume").length;
}

// Where the abort lands in one resume: during the pre-claim snapshot read or
// during the claim I/O.
type AbortPoint = "snapshot" | "claim";

// Real store I/O is a macrotask window, so the in-flight store call completes
// anyway and only then does the runner see the signal. Waiting writes after
// the slot is ready can be lost, which models a failed compensation.
function storeWindowHarness(abort: AbortController, input: {
  readonly abortAt: AbortPoint;
  readonly loseLateWaitingWrites?: boolean;
}) {
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
  let slotReady = false;
  pool.ensureSlot = async (...args: unknown[]) => {
    const slot = await originalEnsureSlot(...args);
    slotReady = true;
    return slot;
  };
  // The engine validates before the slot exists, so the first read after the
  // slot is ready is the runner's pre-claim snapshot.
  const originalGet = runStore.get.bind(runStore);
  runStore.get = async (getInput) => {
    const read = originalGet(getInput);
    if (input.abortAt === "snapshot" && slotReady) abort.abort();
    return await read;
  };
  let claims = 0;
  const originalResume = runStore.resume.bind(runStore);
  runStore.resume = async (resumeInput) => {
    claims += 1;
    const claimed = originalResume(resumeInput);
    if (input.abortAt === "claim") abort.abort();
    return await claimed;
  };
  const originalSaveWaitingInput = runStore.saveWaitingInput.bind(runStore);
  runStore.saveWaitingInput = async (saveInput) => {
    if (input.loseLateWaitingWrites && slotReady) throw new Error("managed_run_store_unavailable");
    return await originalSaveWaitingInput(saveInput);
  };
  return { factory, engine, runStore, claims: () => claims };
}

async function waitingRun(runStore: InMemoryManagedRunStore, home: string, abortSignal: AbortSignal) {
  const resumeHandle = {
    runId: "claim-abort-run",
    providerId: "codex",
    agentId: "codex-json",
    workspacePath: home,
    threadId: "claim-abort-thread",
  };
  const request = {
    id: "claim-abort-request",
    kind: "decision_required" as const,
    audience: "user" as const,
    question: "Continue the claim abort run?",
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
      sessionHash: "resume-claim-abort-session", release: async () => undefined,
    },
    workspacePath: home,
    runner: new StaticRunner(""),
    redactor: new DefaultRedactor(),
    model: "gpt-test",
    reasoningEffort: "low" as const,
    abortSignal,
  };
}

describe("bug H: abort during the claim I/O must not consume the answer", () => {
  it("leaves the run waiting when the signal aborts while the claim is in flight", async () => {
    const home = await workspace();
    const abort = new AbortController();
    const { factory, engine, runStore } = storeWindowHarness(abort, { abortAt: "claim" });
    try {
      const resumeInput = await waitingRun(runStore, home, abort.signal);
      const first = await engine.resume(resumeInput).then(() => null, (error: unknown) => error);
      expect(String(first)).toMatch(/abort/i);
      expect(threadResumeCount(factory)).toBe(0);
      const record = await runStore.get({ runId: resumeInput.runId });
      expect(record?.status).toBe("waiting_for_input");
      expect(record?.request?.id).toBe(resumeInput.requestId);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);

  // Binding test for the fence order: the snapshot read is store I/O too, and
  // a fence ahead of it would let this abort claim and lean on compensation.
  it("never claims when the signal aborts during the pre-claim snapshot read", async () => {
    const home = await workspace();
    const abort = new AbortController();
    const { factory, engine, runStore, claims } = storeWindowHarness(abort, {
      abortAt: "snapshot",
      loseLateWaitingWrites: true,
    });
    try {
      const resumeInput = await waitingRun(runStore, home, abort.signal);
      const first = await engine.resume(resumeInput).then(() => null, (error: unknown) => error);
      expect(String(first)).toMatch(/abort/i);
      expect(claims()).toBe(0);
      expect(threadResumeCount(factory)).toBe(0);
      const record = await runStore.get({ runId: resumeInput.runId });
      expect(record?.status).toBe("waiting_for_input");
      expect(record?.request?.id).toBe(resumeInput.requestId);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);
});
