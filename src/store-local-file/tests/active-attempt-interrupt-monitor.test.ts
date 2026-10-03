import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActiveAttemptInterruptMonitor } from "../../worker-core/control/active-attempt-interrupt-monitor";
import { InMemoryActiveAttemptRegistry } from "../../worker-core/control/active-attempt-registry";
import { WorkerControlService } from "../../worker-core/control/worker-control-service";
import { LocalFileWorkerControlInboxStore } from "../worker-control-inbox/adapters/local-worker-control-inbox-store";

describe("durable interrupt target isolation", () => {
  it.each([
    { signalScope: { attemptId: "attempt-1" }, expected: false },
    { signalScope: { providerSessionId: "session-1" }, expected: false },
    { signalScope: { attemptId: "attempt-2", providerSessionId: "session-1" }, expected: false },
    { signalScope: { attemptId: "attempt-2" }, expected: true },
    { signalScope: { providerSessionId: "session-2" }, expected: true },
    { signalScope: {}, expected: true },
    { signalScope: { providerSessionId: "session-2" }, expected: false, missingSession: true },
  ])("preserves signal scope $signalScope", async ({ signalScope, expected, missingSession }) => {
    const rootDir = await mkdtemp(join(tmpdir(), "interrupt-scope-test-"));
    const target = { jobId: "test-job", taskId: "test-task", workspaceId: rootDir };
    const control = new WorkerControlService({ store: new LocalFileWorkerControlInboxStore({ rootDir }) });
    const registry = new InMemoryActiveAttemptRegistry();
    const abortController = new AbortController();
    const lease = registry.register({
      taskId: target.taskId, attemptNumber: 2, provider: "codex", workspacePath: rootDir,
      target: { ...target, attemptId: "attempt-2", ...(missingSession ? {} : { providerSessionId: "session-2" }) },
      startedAt: new Date(), abortController,
    });
    let polls = 0;
    const monitor = new ActiveAttemptInterruptMonitor({
      control: { listSignals: async (query) => { const result = await control.listSignals(query); polls++; return result; } },
      activeAttemptRegistry: registry, pollIntervalMs: 5,
    });
    try {
      await control.enqueueSignal({ target: { ...target, ...signalScope }, intent: "guidance", deliveryMode: "interrupt_then_continue", body: "Test guidance" });
      monitor.start(target);
      await waitUntil(() => polls >= 3);
      expect(abortController.signal.aborted).toBe(expected);
    } finally { await monitor.stop(); lease.release(); await rm(rootDir, { recursive: true, force: true }); }
  });

  it("keeps the monitor scope for broad signals and does not interrupt a replacement twice", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "interrupt-lifecycle-test-"));
    const target = { jobId: "test-job", taskId: "test-task" };
    const control = new WorkerControlService({ store: new LocalFileWorkerControlInboxStore({ rootDir }) });
    const registry = new InMemoryActiveAttemptRegistry();
    const register = (attemptId: string, controller: AbortController) => registry.register({
      taskId: target.taskId, attemptNumber: 2, provider: "codex", workspacePath: rootDir,
      target: { ...target, attemptId }, startedAt: new Date(), abortController: controller,
    });
    const unrelated = new AbortController();
    const unrelatedLease = register("attempt-1", unrelated);
    let polls = 0;
    const monitor = new ActiveAttemptInterruptMonitor({
      control: { listSignals: async (query) => { const result = await control.listSignals(query); polls++; return result; } },
      activeAttemptRegistry: registry, pollIntervalMs: 5,
    });
    try {
      await control.enqueueSignal({ target: { jobId: target.jobId }, intent: "guidance", deliveryMode: "interrupt_then_continue", body: "Test lifecycle" });
      monitor.start({ ...target, attemptId: "attempt-2" });
      await waitUntil(() => polls >= 3);
      expect(unrelated.signal.aborted).toBe(false);
      const matching = new AbortController();
      const lease = register("attempt-2", matching);
      await waitUntil(() => matching.signal.aborted);
      lease.release();
      const replacement = new AbortController();
      const replacementLease = register("attempt-2", replacement);
      const before = polls;
      await waitUntil(() => polls >= before + 3);
      expect(replacement.signal.aborted).toBe(false);
      replacementLease.release();
    } finally { await monitor.stop(); unrelatedLease.release(); await rm(rootDir, { recursive: true, force: true }); }
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition_not_met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
