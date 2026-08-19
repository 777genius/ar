import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { materializeCodexGoalHandoffArtifacts } from "../codex-goal-handoff-artifacts";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import { localReviewedWorkerOutputDeps } from "../reviewed-worker-output";
import { git, gitInitRepository } from "./codex-goal-mcp-test-support";

export async function recoveryFixture(roots: string[]) {
  const root = await mkdtemp(
    join(tmpdir(), "subscription-runtime-terminal-recovery-pinned-"),
  );
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const jobRootDir = join(root, "job");
  const jobId = "project-worker";
  await Promise.all([
    mkdir(workspacePath, { recursive: true }),
    mkdir(jobRootDir, { recursive: true }),
  ]);
  await gitInitRepository(workspacePath);
  await writeFile(join(workspacePath, "owned.ts"), "export const value = 1;\n");
  await git(workspacePath, ["add", "owned.ts"]);
  await git(workspacePath, ["commit", "-m", "test: base"]);
  await writeFile(join(workspacePath, "owned.ts"), "export const value = 2;\n");
  const handoff = await materializeCodexGoalHandoffArtifacts({
    workerJobId: jobId,
    taskId: jobId,
    workspacePath,
    jobRootDir,
  });
  if (!handoff) throw new Error("expected handoff");
  await writeTerminalResult(jobRootDir, jobId, handoff);
  const producer = {
    jobId,
    taskId: jobId,
    workspacePath,
    jobRootDir,
  } as CodexGoalJobManifest;
  const snapshotter = localReviewedWorkerOutputDeps({
    rootDir: join(root, "reviewed-output"),
  }).snapshotter;
  return {
    workspacePath,
    jobRootDir,
    jobId,
    verifyInput: { producer, workspacePath, snapshotter },
  };
}

export async function writeTerminalResult(
  jobRootDir: string,
  taskId: string,
  handoff: NonNullable<
    Awaited<ReturnType<typeof materializeCodexGoalHandoffArtifacts>>
  >,
): Promise<void> {
  await writeFile(
    join(jobRootDir, `${taskId}.latest-result.json`),
    `${JSON.stringify({
      status: "done",
      changedFiles: handoff.changedPaths,
      evidence: [],
      blockers: [],
      nextAction: "review_completed",
      artifacts: handoff.artifacts,
      details: { baseCommit: handoff.baseCommit },
    })}\n`,
  );
}
