import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexGoalJobManifest, CodexGoalJobSummary } from
  "../codex-goal-jobs";

export function manifestFor(
  jobId: string,
  workspacePath: string,
  jobRootDir: string,
): CodexGoalJobManifest {
  return {
    schemaVersion: 1,
    jobId,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    jobRootDir,
    workspacePath,
    promptPath: join(jobRootDir, "prompt.md"),
    taskId: jobId,
    accounts: ["account-a"],
    projectAccessScope: { projectId: "p0" },
  };
}

export async function writeManifest(
  registry: string,
  manifest: CodexGoalJobManifest,
) {
  const root = join(registry, manifest.jobId);
  await mkdir(root, { recursive: true });
  const path = join(root, "job.json");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

export function summaryFor(
  manifest: CodexGoalJobManifest,
  manifestPath: string,
): CodexGoalJobSummary {
  return {
    jobId: manifest.jobId,
    tags: [],
    taskId: manifest.taskId,
    workspacePath: manifest.workspacePath,
    promptPath: manifest.promptPath,
    accountNames: manifest.accounts,
    updatedAt: manifest.updatedAt,
    manifestPath,
  };
}

export function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
