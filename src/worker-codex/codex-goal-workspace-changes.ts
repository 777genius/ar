import { resolveManagedDependencyGitContext, runManagedDependencyGitBuffer,
  type HostedDependencyRootPurposeContext } from "./managed-dependency-git";
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
  managedContext?: HostedDependencyRootPurposeContext,
): Promise<{
  readonly changedFiles: readonly string[];
  readonly warning?: string;
}> {
  const context = resolveManagedDependencyGitContext(workspacePath, managedContext);
  if (context !== undefined) {
    const { stdout } = await runManagedDependencyGitBuffer(context,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], { timeoutMs: gitStatusTimeoutMs });
    const records = stdout.toString("utf8").split("\0").filter(Boolean), changedFiles: string[] = [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!;
      if (record.length < 4 || record[2] !== " ") throw new Error("dependency_host_git_status_invalid");
      changedFiles.push(record.slice(3));
      if (record.slice(0, 2).includes("R") || record.slice(0, 2).includes("C")) {
        if (records[++index] === undefined) throw new Error("dependency_host_git_status_invalid");
      }
    }
    return { changedFiles };
  }
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      workspacePath,
      "status",
      "--porcelain",
      "--untracked-files=all",
    ], { timeout: gitStatusTimeoutMs });
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
