import { readCodexGoalJob, codexGoalJobToArgs } from "../codex-goal-jobs";
import { goalLaunchInput } from "../application/codex-goal-launch-input";
import { collectRegisteredCodexGoalJobStatus } from "../application/codex-goal-registered-job-observation";

enum Stage { Manifest = "manifest", Launch = "launch", Status = "registered_status", Complete = "status_complete" }
enum Failure { Error = "error", Type = "type_error", Range = "range_error", Other = "other" }
/** TEST-only bounded re-observation. Report finite facts, never raw failure
 * text, stack, paths, provider payloads or auth contents. No launch is made. */
export async function sdkControllerStatusDiagnostic(registryRootDir: string, jobId: string) {
  let stage = Stage.Manifest;
  try {
    const manifest = await readCodexGoalJob({ registryRootDir, jobId });
    stage = Stage.Launch;
    const launch = await goalLaunchInput(codexGoalJobToArgs(manifest));
    stage = Stage.Status;
    await collectRegisteredCodexGoalJobStatus({ registryRootDir, launch });
    return { stage: Stage.Complete };
  } catch (error) {
    const failure = error instanceof TypeError ? Failure.Type : error instanceof RangeError ? Failure.Range : error instanceof Error ? Failure.Error : Failure.Other;
    const code = error instanceof Error && "code" in error && typeof error.code === "string" && ["ENOENT", "EACCES", "EPERM", "EINVAL", "EBADF"].includes(error.code) ? error.code : "unclassified";
    const sites = ["hosted-readonly-authority", "protected-job-birth", "research-writer-observation", "codex-goal-status-files", "codex-goal-storage-paths", "codex-goal-registered-job-observation"];
    const site = error instanceof Error ? sites.find(name => error.stack?.includes("/" + name + ".")) ?? "unclassified" : "unclassified";
    return { stage, failure, code, site };
  }
}
