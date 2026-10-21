import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

import {
  codexGoalAccountSlots,
  runCodexGoal,
  type CodexGoalRunConfig,
} from "../codex-goal-runner";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

it("fails closed when a capacity pause cannot preserve raw-secret output", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-goal-continuation-fingerprint-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const config: CodexGoalRunConfig = {
    jobRootDir: join(root, "job"),
    authRootDir: join(root, "auth"),
    workspacePath,
    promptPath: join(root, "prompt.md"),
    taskId: "task-continuation-fingerprint",
    accounts: codexGoalAccountSlots(["account-a"]),
    outputPath: join(root, "job", "result.json"),
  };
  await mkdir(config.jobRootDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(config.promptPath, "Continue the sandbox task.\n");
  await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "init", "--quiet"], { cwd: workspacePath });
  await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "config", "user.email", "test@example.com"], {
    cwd: workspacePath,
  });
  await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "config", "user.name", "Test"], {
    cwd: workspacePath,
  });
  await writeFile(join(workspacePath, "README.md"), "fixture\n");
  await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "add", "README.md"], { cwd: workspacePath });
  await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture"], {
    cwd: workspacePath,
  });
  const secret = ["sk-", "z".repeat(24)].join("");

  await expect(runCodexGoal(config, {
    createExecutor: () => ({
      async run() {
        await writeFile(join(workspacePath, "provider-output.txt"), secret);
        return {
          status: "partial",
          reason: "account_unavailable",
          attempts: [{ changedFiles: ["provider-output.txt"] }],
          task: { outputText: "capacity pause" },
        } as never;
      },
      async dispose() {},
    }),
  })).rejects.toThrow(
    "dirty_terminal_handoff_unavailable:handoff_raw_secret_rejected",
  );
  await expect(readFile(config.outputPath!, "utf8")).rejects.toThrow();
});
