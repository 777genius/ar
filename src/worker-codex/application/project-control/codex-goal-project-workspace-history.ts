import { resolve } from "node:path";
import { stringValue } from "../codex-goal-input-values";
import { optionalRealPathForAdmission } from "./codex-goal-project-admission-paths";
import {
  defaultProjectControlGitPort,
  type ProjectControlGitPort,
} from "./adapters/host-command-adapters";

type JsonObject = Readonly<Record<string, unknown>>;

export async function duplicateWorkspaceIdentityJobIds(
  items: readonly JsonObject[],
): Promise<ReadonlySet<string>> {
  const jobsByWorkspaceIdentity = new Map<string, string[]>();
  for (const item of items) {
    const jobId = stringValue(item.jobId);
    const workspacePath = stringValue(item.workspacePath);
    if (!jobId || !workspacePath) continue;
    // A clean completed run no longer competes for its registered workspace.
    // Explicit result evidence distinguishes it from a not-yet-launched job;
    // review markers and workerAlive:false alone cannot prove completion.
    // Only omit duplicate participation: ordinary debt/risk checks still run.
    if (
      item.ok === true &&
      item.workerAlive === false &&
      item.workspaceDirty === false &&
      item.resultExists === true &&
      // Result documents project "done"; runtime observation also supports
      // legacy "completed". Progress completion alone is not result evidence.
      (item.resultStatus === "done" || item.resultStatus === "completed") &&
      item.activeWriterRisk === "none" &&
      item.workspaceConflict !== true
    ) {
      // Overview projects failed Git reads as workspaceDirty:false. Require a
      // successful fresh observation, not existence or a warning heuristic.
      const status = await gitStatusShort(workspacePath);
      if (status.ok && status.lines.length === 0) continue;
    }
    const identity = await optionalRealPathForAdmission(workspacePath) ??
      resolve(workspacePath);
    const jobs = jobsByWorkspaceIdentity.get(identity) ?? [];
    jobs.push(jobId);
    jobsByWorkspaceIdentity.set(identity, jobs);
  }
  return new Set(
    [...jobsByWorkspaceIdentity.values()]
      .filter((jobIds) => jobIds.length > 1)
      .flat(),
  );
}
async function gitStatusShort(
  path: string,
  git: ProjectControlGitPort = defaultProjectControlGitPort,
): Promise<
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly error: string }
> {
  try {
    const result = await git.run({
      args: ["-C", path, "status", "--short", "--untracked-files=all"],
      timeoutMs: 8_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      ok: true,
      lines: result.stdout.split(/\n/).filter((line) => line.length > 0),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
