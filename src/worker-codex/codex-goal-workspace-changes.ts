import { isHostedDependencyWorkspace } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { managedDependencyGitEnvironment, managedDependencyGitFlags } from "./managed-dependency-git";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SafeExecutionRunResult } from "@vioxen/subscription-runtime/worker-core";
import type { FileBackendCodexWorkerResult } from "./file-backend-codex-worker";

const execFileAsync = promisify(execFile);
const gitStatusTimeoutMs = 5_000;

export function changedFilesFromSafeExecutionResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): readonly string[] {
  return uniqueStrings(result.attempts.flatMap((attempt) => attempt.changedFiles));
}

export async function changedFilesFromWorkspace(
  workspacePath: string,
): Promise<{
  readonly changedFiles: readonly string[];
  readonly warning?: string;
}> {
  try {
    const { stdout } = await execFileAsync(isHostedDependencyWorkspace(workspacePath) ? "/usr/bin/git" : "git", [
      ...(isHostedDependencyWorkspace(workspacePath) ? managedDependencyGitFlags : []),
      "-C",
      workspacePath,
      "status",
      "--porcelain",
      "--untracked-files=all",
    ], { timeout: gitStatusTimeoutMs, ...(isHostedDependencyWorkspace(workspacePath) ? { env: managedDependencyGitEnvironment() } : {}) });
    const changedFiles = stdout
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => statusPorcelainPath(line))
      .filter((path) => path.length > 0);
    return { changedFiles };
  } catch {
    return {
      changedFiles: [],
      warning: "workspace_changed_files_unavailable",
    };
  }
}

export function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function statusPorcelainPath(line: string): string {
  const path = line.length > 3 ? line.slice(3).trim() : line.trim();
  const renameTarget = path.split(" -> ").at(-1);
  return renameTarget?.trim() ?? path;
}
