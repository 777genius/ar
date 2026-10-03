import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import { loadProjectPreStartObservation } from
  "../codex-goal-project-continuation-runtime";

const execFileAsync = promisify(execFile);

it("defaults a legacy continuation handoff root from its registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-goal-legacy-continuation-"));
  const registryRootDir = join(root, "registry");
  const workspacePath = join(root, "workspace");
  const jobRootDir = join(root, "job");
  try {
    await mkdir(workspacePath, { recursive: true });
    await mkdir(jobRootDir, { recursive: true });
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspacePath });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: workspacePath,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: workspacePath,
    });
    await writeFile(join(workspacePath, "README.md"), "fixture\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: workspacePath });
    await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], {
      cwd: workspacePath,
    });
    const manifest: CodexGoalJobManifest = {
      schemaVersion: 1,
      jobId: "legacy-project-worker",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
      jobRootDir,
      workspacePath,
      promptPath: join(jobRootDir, "prompt.md"),
      taskId: "legacy-project-worker",
      accounts: ["account-a"],
    };

    const loaded = await loadProjectPreStartObservation(
      manifest,
      undefined,
      registryRootDir,
    );

    expect(loaded.launch.config.durableHandoffRootDir).toBe(
      join(registryRootDir, "durable-handoffs"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
