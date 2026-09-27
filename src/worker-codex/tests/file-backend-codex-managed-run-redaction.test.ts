import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultRedactor,
  type RunnerPort,
  type SessionStorePort,
} from "@vioxen/subscription-runtime/core";
import { describe, expect, it } from "vitest";
import { FileBackendCodexManagedRunCoordinator } from "../file-backend-codex-managed-run-recovery";
import { LocalFileManagedRunStore } from "../file-backend-codex-managed-run-store";

describe("managed run recovery persistence", () => {
  it("redacts registered secrets throughout the durable recovery packet", async () => {
    // Before the fix, the returned provider result could be redacted while the
    // original prompt, answer preview and provider state still leaked to disk.
    const rootDir = await mkdtemp(join(tmpdir(), "managed-run-redaction-"));
    const secret = "SYNTHETIC_SECRET_REDACTION_CANARY";
    const redactor = new DefaultRedactor();
    redactor.registerSecret(secret, "test-canary");
    const managedRunStore = new LocalFileManagedRunStore(rootDir);
    const coordinator = new FileBackendCodexManagedRunCoordinator({
      providerInstanceId: "test-provider",
      workerId: "test-worker",
      agentDriver: null,
      sessionStore: {} as SessionStorePort,
      managedRunStore,
      runner: {} as RunnerPort,
      redactor,
      clock: { now: () => new Date("2026-09-27T00:00:00Z"), monotonicMs: () => 0 },
      recordFailure: () => {},
      recordSuccessfulRun: () => {},
      exportAuthJsonFileQuietly: async () => {},
      runRecoveryJob: async () => { throw new Error("not used"); },
    });

    try {
      await coordinator.taskResultToOutput({
        status: "waiting_for_input",
        runId: "synthetic-run",
        outputText: `output ${secret}`,
        request: {
          id: "synthetic-request",
          kind: "missing_context",
          audience: "orchestrator",
          question: `question ${secret}`,
          contextSummary: `context ${secret}`,
          suggestedAnswers: [`choice ${secret}`],
        },
        resumeHandle: {
          runId: "synthetic-run",
          providerId: "codex",
          workspacePath: "/tmp/synthetic-workspace",
          providerState: { opaque: `state ${secret}` },
        },
        warnings: [],
      }, {
        kind: "run",
        runId: "synthetic-run",
        attempt: 1,
        job: { prompt: `original ${secret}`, metadata: { note: `metadata ${secret}` } },
      });

      const paths = await readdir(rootDir);
      expect(paths).toHaveLength(1);
      const persisted = await readFile(join(rootDir, paths[0]!), "utf8");
      expect(persisted).not.toContain(secret);
      expect(persisted).toContain("[redacted:test-canary]");
      const record = await managedRunStore.get({ runId: "synthetic-run" });
      expect(record?.recoveryPacket?.originalPrompt).toBe("original [redacted:test-canary]");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
