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

// The abort fires while the durable claim is in flight: real claim I/O is a
// macrotask window, so the claim commits anyway and only then does the runner
// see the signal. The answer never reached the provider, so the claim must be
// compensated back to waiting_for_input instead of consuming the answer.
function claimWindowHarness(abort: AbortController) {
  const factory = new FakeAppServerFactory({
    availableModels: [{ model: "gpt-test" }],
    emitTurnEventsWithStartResponse: true,
    suppressTurnCompletion: true,
  });
  const runStore = new InMemoryManagedRunStore();
  const originalResume = runStore.resume.bind(runStore);
  runStore.resume = async (input) => {
    const claimed = originalResume(input);
    abort.abort();
    return await claimed;
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

describe("bug H: abort during the claim I/O must not consume the answer", () => {
  it("leaves the run waiting when the signal aborts while the claim is in flight", async () => {
    const home = await workspace();
    const abort = new AbortController();
    const { factory, engine, runStore } = claimWindowHarness(abort);
    try {
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
      const resumeInput = {
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
        abortSignal: abort.signal,
      };
      const first = await engine.resume(resumeInput).then(() => null, (error: unknown) => error);
      expect(String(first)).toMatch(/abort/i);
      expect(threadResumeCount(factory)).toBe(0);
      const record = await runStore.get({ runId: resumeHandle.runId });
      expect(record?.status).toBe("waiting_for_input");
      expect(record?.request?.id).toBe(request.id);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 20000);
});
