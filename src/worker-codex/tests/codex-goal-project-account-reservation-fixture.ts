import { join } from "node:path";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";

export function singleAccountFixture(
  root: string,
  jobId: string,
): ReturnType<typeof fixture> {
  const value = fixture(root, jobId);
  return {
    manifest: { ...value.manifest, accounts: ["account-a"] },
    launch: {
      ...value.launch,
      config: {
        ...value.launch.config,
        accounts: [{ name: "account-a" }],
      },
    },
  };
}

export function fixture(
  root: string,
  jobId: string,
  reasoningEffort: "xhigh" | "high" = "xhigh",
): {
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
} {
  const jobRootDir = join(root, jobId);
  const manifest: CodexGoalJobManifest = {
    schemaVersion: 1,
    jobId,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    jobRootDir,
    workspacePath: join(root, "workspace"),
    promptPath: join(jobRootDir, "prompt.md"),
    taskId: `${jobId}-task`,
    accounts: ["account-a", "account-b"],
  };
  return {
    manifest,
    launch: {
      config: {
        jobId,
        jobRootDir,
        authRootDir: join(root, "auth"),
        workspacePath: manifest.workspacePath,
        promptPath: manifest.promptPath,
        taskId: manifest.taskId,
        accounts: [{ name: "account-a" }, { name: "account-b" }],
        model: "gpt-5.6-sol",
        reasoningEffort,
        serviceTier: "fast",
        taskTimeoutMs: 60_000,
      },
      tmuxSession: `${jobId}-tmux`,
      cwd: manifest.workspacePath,
      logPath: join(jobRootDir, "worker.log"),
      cliCommand: ["node", "runtime.js"],
    },
  };
}
