import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalFileSafeExecutionStores } from "../safe-execution/adapters/local-safe-execution-state-store";
import { LocalTerminalCheckpointAdmission } from "../terminal-checkpoint/local-terminal-checkpoint-admission";

const identity = { projectId: "test-project", workstreamId: "test-workstream",
  jobId: "test-job", taskId: "test-task", executionGeneration: "test-generation-1",
  attemptNumber: 1, ownershipEpoch: 1, runtimeSha: "a".repeat(40),
  registryRevisionSha256: "b".repeat(64) };

describe("real rewritten safe-execution journal admission", () => {
  it("persists the execution generation and rejects a write under a terminal claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "test-checkpoint-journal-"));
    try {
      const journal = createLocalFileSafeExecutionStores({
        rootDir: join(root, "state"), terminalCheckpointJobRootDir: root,
        executionGeneration: "test-generation-1",
      }).journal;
      const now = new Date("2026-09-23T00:00:00.000Z");
      await journal.startTask({ taskId: "test-task", workspaceRunId: "test-run",
        workspacePath: join(root, "workspace"), effectMode: "read_only", provider: "codex", now });
      expect((await journal.readTask({ taskId: "test-task" }))?.executionGeneration)
        .toBe("test-generation-1");
      const gate = new LocalTerminalCheckpointAdmission(root);
      const claim = await gate.claim("test-checkpoint-1", identity);
      await expect(journal.completeTask({ taskId: "test-task", result: {}, now }))
        .rejects.toThrow("job_fenced");
      expect((await journal.readTask({ taskId: "test-task" }))?.status).toBe("running");
      await gate.release(claim, false);
      await journal.completeTask({ taskId: "test-task", result: {}, now });
      expect((await journal.readTask({ taskId: "test-task" }))?.status).toBe("completed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
