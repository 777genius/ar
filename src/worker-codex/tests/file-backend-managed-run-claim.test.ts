import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../../provider-codex/codex-app-server-execution-engine";
import { FakeAppServerFactory } from "../../provider-codex/app-server/testing/fake-app-server";
import { codexHostedDefaultEgressPolicy } from "../../provider-codex/codex-provider-egress-policy";
import { LocalFileManagedRunStore } from "../file-backend-codex-managed-run-store";
import { StaticRunner } from "./file-backend-codex-worker-test-support";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true }),
  ));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-claim-race-"));
  workspaces.push(path);
  return path;
}

function threadResumeCount(factory: FakeAppServerFactory): number {
  return factory.requests.filter((r) => r.method === "thread/resume").length;
}

function isMismatch(error: unknown): boolean {
  return String(error).includes("codex_managed_run_request_mismatch");
}

async function seedWaitingRun(
  store: LocalFileManagedRunStore,
  root: string,
  requestId: string,
): Promise<void> {
  await store.saveWaitingInput({
    runId: "claim-race-run",
    resumeHandle: {
      runId: "claim-race-run",
      providerId: "codex",
      agentId: "codex-json",
      workspacePath: root,
      threadId: "claim-race-thread",
    },
    request: {
      id: requestId,
      kind: "decision_required",
      audience: "user",
      question: "Continue the claim race run?",
    },
    now: new Date(),
  });
}

function claimInput(requestId: string) {
  return { runId: "claim-race-run", requestId, answer: "continue", now: new Date() };
}

describe("bug G: the durable run claim must be exclusive", () => {
  it("claims a waiting run exactly once when two store resumes race", async () => {
    const root = await workspace();
    const store = new LocalFileManagedRunStore(root, new DefaultRedactor());
    await seedWaitingRun(store, root, "claim-race-request");
    const input = claimInput("claim-race-request");
    const results = await Promise.allSettled([
      store.resume(input),
      store.resume(input),
    ]);
    const winners = results.filter((result) => result.status === "fulfilled");
    const losers = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(isMismatch(losers[0]!.reason)).toBe(true);
    expect((await store.get({ runId: "claim-race-run" }))?.status).toBe("active");
  });

  it("keeps claiming after a duplicate loses the claim on the same store", async () => {
    const root = await workspace();
    const store = new LocalFileManagedRunStore(root, new DefaultRedactor());
    await seedWaitingRun(store, root, "claim-race-request");
    const input = claimInput("claim-race-request");
    await Promise.allSettled([store.resume(input), store.resume(input)]);
    // A long-lived worker reuses one store: the loser's rejection must not
    // wedge the chain, or the run's next pause could never be resumed again.
    await seedWaitingRun(store, root, "claim-next-request");
    await expect(store.resume(claimInput("claim-next-request"))).resolves
      .toMatchObject({ status: "active" });
  });

  it("sends a single thread/resume when two engine resumes race on one run", async () => {
    const home = await workspace();
    const store = new LocalFileManagedRunStore(home, new DefaultRedactor());
    const factory = new FakeAppServerFactory({
      availableModels: [{ model: "gpt-test" }],
      emitTurnEventsWithStartResponse: true,
      suppressTurnCompletion: true,
    });
    const engine = new CodexAppServerExecutionEngine({
      codexBinaryPath: "/fake/codex",
      processFactory: factory.create,
      cleanThreadPrewarm: false,
      timeoutMs: 1000,
      runStore: store,
      goalMode: true,
      providerEgressPolicy: codexHostedDefaultEgressPolicy(),
    });
    try {
      const resumeHandle = {
        runId: "wire-race-run",
        providerId: "codex",
        agentId: "codex-json",
        workspacePath: home,
        threadId: "wire-race-thread",
      };
      await store.saveWaitingInput({
        runId: resumeHandle.runId,
        resumeHandle,
        request: {
          id: "wire-race-request",
          kind: "decision_required",
          audience: "user",
          question: "Continue the wire race run?",
        },
        now: new Date(),
      });
      const resumeInput = {
        runId: resumeHandle.runId,
        requestId: "wire-race-request",
        answer: "continue",
        resumeHandle,
        session: {
          home, codexHome: home, env: { CODEX_HOME: home },
          sessionHash: "wire-race-session", release: async () => undefined,
        },
        workspacePath: home,
        runner: new StaticRunner({ exitCode: 0, stdout: "", stderr: "" }),
        redactor: new DefaultRedactor(),
        model: "gpt-test",
        reasoningEffort: "low" as const,
        abortSignal: new AbortController().signal,
      };
      const results = await Promise.allSettled([
        engine.resume(resumeInput),
        engine.resume(resumeInput),
      ]);
      // Exactly one caller may lose the claim; both proceeding would put two
      // thread/resume side effects on the wire for one consumed answer.
      expect(results.filter((result) =>
        result.status === "rejected" && isMismatch((result as PromiseRejectedResult).reason),
      )).toHaveLength(1);
      expect(threadResumeCount(factory)).toBe(1);
    } finally {
      await engine.dispose();
      factory.processes.forEach((process) => process.kill());
    }
  }, 15000);
});
