import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceChangedFilesWarning } from "../codex-goal-changed-files-report";

const state = vi.hoisted(() => ({ warnings: [] as string[] }));
vi.mock("../codex-goal-ops", async original => ({ ...await original<object>(),
  collectCodexGoalStatus: async () => ({ tmuxAlive: true, resultExists: false, workspaceExists: true, workspaceDirty: true, changedFiles: [], logExists: false, warnings: state.warnings }) }));
vi.mock("../project-control-scope-guard", async original => ({ ...await original<object>(),
  projectControlGenericToolDenial: () => undefined, projectControlGenericScopeDenial: async () => undefined }));
import { stopStoredJobLifecycle } from "../application/codex-goal-job-lifecycle-use-cases";
import { stopDirectCodexGoalRun } from "../application/codex-goal-direct-run-stop-use-case";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "TEST-stop-changed-files-")); state.warnings = [WorkspaceChangedFilesWarning.OutputLimit]; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function launchFor(tmuxSession?: string) {
  const jobRootDir = join(root, "job"), workspacePath = join(root, "workspace"), logPath = join(jobRootDir, "task-1.log");
  await mkdir(jobRootDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(logPath, "x\n");
  return { cwd: workspacePath, logPath, cliCommand: ["subscription-runtime-codex-goal"], ...(tmuxSession ? { tmuxSession } : {}),
    config: { jobId: "worker-1", jobRootDir, authRootDir: join(root, "auth"), workspacePath, promptPath: join(jobRootDir, "prompt.md"), taskId: "task-1", accounts: [] } } as never;
}
const skipped = { status: "skipped", reason: "changed_files_unavailable" };

describe("stop of a worker whose changed files cannot be listed", () => {
  // The worker has already stopped and the stop event is written: the stop must not be reported as an error.
  it("reports a skipped reconcile for a forced tmux stop", async () => {
    const launch = await launchFor("TEST-session");
    const result = await stopStoredJobLifecycle({ registryRootDir: root, jobId: "worker-1", confirmStop: true, forceStop: true },
      { loadJobLaunch: async () => ({ manifest: { jobId: "worker-1" }, launch, registryRootDir: root }),
        stopTmux: async () => ({ preview: "TEST stop", launchState: "stopped" }),
        materializeHandoff: async () => ({ packetPath: join(root, "packet"), manifestSha256: "a".repeat(64), artifacts: [] }) } as never);
    expect(result).toMatchObject({ ok: true, mode: "stop", resultReconciliation: skipped });
  });
  it("reports a skipped reconcile for a direct run that is not alive", async () => {
    const launch = await launchFor();
    const result = await stopDirectCodexGoalRun({ manifest: { jobId: "worker-1" } as never, launch,
      status: { warnings: [WorkspaceChangedFilesWarning.OutputLimit], workspaceDirty: true, changedFiles: [] } as never,
      brief: { workerAlive: false, silentStale: false, heartbeatOnlyNoOutput: false }, confirmStop: true });
    expect(result).toMatchObject({ ok: true, reason: "direct_run_not_alive_reconciled", resultReconciliation: skipped });
  });
});
