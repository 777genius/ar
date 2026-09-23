import "./hosted-test-egress-default-fixture";
import "./unmanaged-goal-host-fixture";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalTerminalCheckpointAdmission } from "@vioxen/subscription-runtime/store-local-file";
import { codexGoalAccountSlots, codexGoalRuntimeEventsPath, runCodexGoal,
  type CodexGoalRunConfig } from "../codex-goal-runner";

const identity = { projectId: "test-project", workstreamId: "test-workstream",
  jobId: "test-job", taskId: "test-task", executionGeneration: "test-generation",
  attemptNumber: 1, ownershipEpoch: 1, runtimeSha: "a".repeat(40),
  registryRevisionSha256: "b".repeat(64) };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "test-checkpoint-runner-"));
  const config: CodexGoalRunConfig = {
    jobId: "test-job", taskId: "test-task", jobRootDir: join(root, "job"),
    stateRootDir: join(root, "job", "state"), authRootDir: join(root, "auth"),
    workspacePath: join(root, "workspace"), promptPath: join(root, "prompt.md"),
    accounts: codexGoalAccountSlots(["test-account"]),
  };
  await mkdir(config.jobRootDir); await mkdir(config.workspacePath);
  await writeFile(config.promptPath, "Synthetic fake executor only.\n");
  return { root, config, gate: new LocalTerminalCheckpointAdmission(config.jobRootDir),
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("terminal checkpoint runner admission with fake executor", () => {
  it("rejects a new launch before constructing its executor while the job is claimed", async () => {
    const f = await fixture();
    const claim = await f.gate.claim("test-checkpoint-before-launch", identity);
    let constructed = false;
    try {
      await expect(runCodexGoal(f.config, { createExecutor: () => {
        constructed = true;
        throw new Error("test-executor-must-not-start");
      } })).rejects.toThrow("terminal_checkpoint_job_fenced");
      expect(constructed).toBe(false);
    } finally { await f.gate.release(claim, false); await f.cleanup(); }
  });

  it("holds writer admission through successful disposal", async () => {
    const f = await fixture();
    let finishRun!: () => void;
    let entered!: () => void;
    const release = new Promise<void>((resolve) => { finishRun = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    try {
      const running = runCodexGoal(f.config, { createExecutor: () => ({
        async run() { entered(); await release; return {
          status: "completed", attempts: [], task: { outputText: "done" },
        } as never; },
        async dispose() {},
      }) });
      await started;
      await expect(f.gate.claim("test-checkpoint-runner", identity))
        .rejects.toThrow("writers_active");
      finishRun(); await running;
      const events = await readFile(codexGoalRuntimeEventsPath(f.config), "utf8");
      expect(events).toContain("runner_disposed");
      const claim = await f.gate.claim("test-checkpoint-runner", identity);
      await f.gate.release(claim, false);
    } finally { finishRun(); await f.cleanup(); }
  });

  it("does not emit successful disposal when the fake executor disposal fails", async () => {
    const f = await fixture();
    try {
      await expect(runCodexGoal(f.config, { createExecutor: () => ({
        async run() { return { status: "completed", attempts: [],
          task: { outputText: "done" } } as never; },
        async dispose() { throw new Error("test-dispose-failed"); },
      }) })).rejects.toThrow("test-dispose-failed");
      const events = await readFile(codexGoalRuntimeEventsPath(f.config), "utf8");
      expect(events).not.toContain("runner_disposed");
    } finally { await f.cleanup(); }
  });
});
