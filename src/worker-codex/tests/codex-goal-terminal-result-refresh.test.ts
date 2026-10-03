import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { LocalTerminalCheckpointAdmission } from "@vioxen/subscription-runtime/store-local-file";
import { reconcileCodexGoalRuntimeResult } from "../codex-goal-ops";
import { refreshCompletedCodexGoalResultArtifacts } from "../codex-goal-terminal-result-refresh";
import { ensureTerminalCodexGoalHandoffArtifacts } from "../application/ensure-codex-goal-handoff-artifacts";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

describe("completed Codex goal result refresh", () => {
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ));
  });

  it("fences the exported refresh before artifact or result publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "test-terminal-refresh-fence-"));
    cleanup.push(root);
    const gate = new LocalTerminalCheckpointAdmission(root);
    const claim = await gate.claim("test-refresh-fence", {
      projectId: "test-project", workstreamId: "test-workstream", jobId: "test-job",
      taskId: "test-task", executionGeneration: "test-generation", attemptNumber: 1,
      ownershipEpoch: 1, runtimeSha: "a".repeat(40), registryRevisionSha256: "b".repeat(64),
    });
    try {
      await expect(refreshCompletedCodexGoalResultArtifacts({
        config: { jobRootDir: root, jobId: "test-job", taskId: "test-task",
          workspacePath: join(root, "workspace") },
        outputPath: join(root, "test-task.latest-result.json"),
        existingResult: { status: "done", artifacts: [], evidence: [], blockers: [],
          nextAction: "review_completed" } as never,
        changedFiles: [], preservePatch: false,
      })).rejects.toThrow("terminal_checkpoint_job_fenced");
    } finally { await gate.release(claim, false); }
  });

  it("refreshes artifacts without downgrading a completed strict result", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "codex-terminal-refresh-")),
    );
    cleanup.push(root);
    const workspacePath = join(root, "workspace");
    const jobRootDir = join(root, "job");
    const outputPath = join(jobRootDir, "task-1.latest-result.json");
    await mkdir(workspacePath);
    await mkdir(jobRootDir);
    await git(workspacePath, ["init"]);
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await writeFile(join(workspacePath, "tracked.txt"), "before\n");
    await git(workspacePath, ["add", "tracked.txt"]);
    await git(workspacePath, ["commit", "-m", "test fixture"]);
    await writeFile(join(workspacePath, "tracked.txt"), "after\n");
    await writeFile(outputPath, `${JSON.stringify({
      status: "done",
      changedFiles: ["tracked.txt"],
      evidence: ["worker_completed"],
      blockers: [],
      nextAction: "review_completed",
      reason: "completed",
    })}\n`);

    const reconciliation = await reconcileCodexGoalRuntimeResult({
      config: {
        jobId: "job-1",
        jobRootDir,
        outputPath,
        taskId: "task-1",
        workspacePath,
      },
      status: {
        tmuxAlive: false,
        resultExists: true,
        resultStatus: "done",
        workspaceExists: true,
        workspaceDirty: true,
        changedFiles: ["./"],
        recommendedAction: "review_completed",
        warnings: [],
      },
      forceWrite: true,
    });
    const result = JSON.parse(await readFile(outputPath, "utf8")) as
      Record<string, unknown>;
    const canonicalJobRoot = await realpath(jobRootDir);
    const artifacts = result.artifacts as readonly Record<string, unknown>[];
    const patch = artifacts.find((artifact) => artifact.kind === "patch");
    const generation = String(patch?.path).match(
      /task-1\.([a-f0-9]{64})\.handoff\.patch$/,
    )?.[1];

    expect(reconciliation).toMatchObject({
      wrote: true,
      reason: "terminal_result_artifacts_refreshed",
      recommendedAction: "review_completed",
    });
    expect(result).toMatchObject({
      status: "done",
      reason: "completed",
      blockers: [],
      nextAction: "review_completed",
      changedFiles: ["tracked.txt"],
      artifacts: [
        { kind: "patch", sha256: generation },
        { kind: "summary" },
        { kind: "manifest" },
      ],
    });
    expect(generation).toMatch(/^[a-f0-9]{64}$/);
    expect(patch?.path).toBe(
      join(canonicalJobRoot, `task-1.${generation}.handoff.patch`),
    );
    expect(artifacts[1]?.path).toBe(
      join(canonicalJobRoot, `task-1.${generation}.handoff.summary.json`),
    );
    expect(artifacts[2]?.path).toBe(
      join(canonicalJobRoot, `task-1.${generation}.handoff.manifest.json`),
    );
    expect(result.evidence).toEqual(expect.arrayContaining([
      "worker_completed",
      "supervisor_refreshed_terminal_result_artifacts",
      `patch_preserved:${patch?.path}`,
    ]));
  });

  it("lazily backfills an already-completed untracked-only job for handoff review", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "codex-terminal-backfill-")),
    );
    cleanup.push(root);
    const workspacePath = join(root, "workspace");
    const jobRootDir = join(root, "worker-jobs", "worker-1");
    const outputPath = join(jobRootDir, "task-1.latest-result.json");
    await mkdir(workspacePath, { recursive: true });
    await mkdir(jobRootDir, { recursive: true });
    await git(workspacePath, ["init"]);
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await writeFile(join(workspacePath, "README.md"), "fixture\n");
    await git(workspacePath, ["add", "README.md"]);
    await git(workspacePath, ["commit", "-m", "fixture"]);
    await writeFile(join(workspacePath, "S0.md"), "completed output\n");
    await writeFile(outputPath, `${JSON.stringify({
      schemaVersion: 1,
      status: "done",
      changedFiles: ["S0.md"],
      evidence: ["worker_completed"],
      blockers: [],
      nextAction: "review_completed",
    })}\n`);

    const status = await ensureTerminalCodexGoalHandoffArtifacts({
      launch: {
        cwd: workspacePath,
        logPath: join(jobRootDir, "task-1.log"),
        cliCommand: ["subscription-runtime-codex-goal"],
        config: {
          jobId: "worker-1",
          jobRootDir,
          authRootDir: join(root, "auth"),
          workspacePath,
          promptPath: join(jobRootDir, "prompt.md"),
          taskId: "task-1",
          accounts: [],
          outputPath,
        },
      },
    });
    const result = JSON.parse(await readFile(outputPath, "utf8")) as
      Record<string, unknown>;
    const canonicalJobRoot = await realpath(jobRootDir);
    const artifacts = result.artifacts as readonly Record<string, unknown>[];
    const patch = artifacts.find((artifact) => artifact.kind === "patch");
    const generation = String(patch?.path).match(
      /task-1\.([a-f0-9]{64})\.handoff\.patch$/,
    )?.[1];

    expect(status).toMatchObject({
      resultStatus: "done",
      changedFiles: ["S0.md"],
    });
    expect(result).toMatchObject({
      status: "done",
      changedFiles: ["S0.md"],
      details: { baseCommit: expect.stringMatching(/^[a-f0-9]{40}$/) },
      artifacts: [{ kind: "patch", sha256: generation }, { kind: "summary" }, { kind: "manifest" }],
    });
    expect(generation).toMatch(/^[a-f0-9]{64}$/);
    expect(patch?.path).toBe(
      join(canonicalJobRoot, `task-1.${generation}.handoff.patch`),
    );
    expect(artifacts[1]?.path).toBe(
      join(canonicalJobRoot, `task-1.${generation}.handoff.summary.json`),
    );
    expect(artifacts[2]?.path).toBe(
      join(canonicalJobRoot, `task-1.${generation}.handoff.manifest.json`),
    );
  });
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}
