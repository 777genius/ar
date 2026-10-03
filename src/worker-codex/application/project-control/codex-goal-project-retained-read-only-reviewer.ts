import { resolve } from "node:path";
import type { ConsumedOutputLedger } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest, CodexGoalJobSummary } from "../../codex-goal-jobs";
import { stringValue } from "../codex-goal-input-values";
import { admissionWorkspacePathsMatch } from "./codex-goal-project-admission-paths";
import { stringArrayArg } from "./codex-goal-project-utils";

type JsonObject = Readonly<Record<string, unknown>>;

export async function retainedTerminalReadOnlyReviewer(input: {
  readonly item: JsonObject;
  readonly summary: CodexGoalJobSummary | undefined;
  readonly ledger: ConsumedOutputLedger;
  readonly registryRootDir: string;
  readonly readJob: ((input: { readonly registryRootDir: string; readonly jobId: string; }) => Promise<CodexGoalJobManifest>) | undefined;
  readonly resolvedWorkspacePath: string | undefined;
}): Promise<boolean> {
  const { item, summary } = input;
  const workspacePath = stringValue(item.workspacePath);
  const reviewerOnly = (tags: readonly string[]) => {
    const roles = tags.filter((tag) => tag.startsWith("worker-role-"));
    return roles.length === 1 && roles[0] === "worker-role-reviewer";
  };
  if (
    !summary || !input.readJob || !workspacePath ||
    item.workerAlive !== false || item.workspaceDirty !== true ||
    item.resultExists !== true ||
    (item.resultStatus !== "done" && item.resultStatus !== "completed") ||
    item.recommendedAction !== "review_completed" ||
    !reviewerOnly(safeStringArray(item.tags)) || !reviewerOnly(summary.tags) ||
    item.workspaceConflict === true ||
    (item.activeWriterRisk !== "none" &&
      item.activeWriterRisk !== "dirty_workspace_without_worker") ||
    input.ledger.byJobId.has(summary.jobId)
  ) return false;
  // Terminal result and the read-only manifest establish no writer ownership.
  // A review approval marker is deliberately not required or manufactured:
  // this exception retains the producer output, it does not approve its code.
  const record = input.ledger.byWorkspace.get(resolve(workspacePath)) ??
    (input.resolvedWorkspacePath
      ? input.ledger.byWorkspace.get(resolve(input.resolvedWorkspacePath))
      : undefined);
  if (
    !record?.valid || record.jobId === summary.jobId ||
    !["integrated", "rejected", "duplicate", "superseded", "archived"]
      .includes(record.status)
  ) return false;
  try {
    const manifest = await input.readJob({
      registryRootDir: input.registryRootDir,
      jobId: summary.jobId,
    });
    return manifest.jobId === summary.jobId &&
      manifest.editMode === "read-only" &&
      reviewerOnly(manifest.tags ?? []) &&
      await admissionWorkspacePathsMatch(manifest.workspacePath, workspacePath) &&
      await admissionWorkspacePathsMatch(summary.workspacePath, workspacePath);
  } catch {
    return false;
  }
}

function safeStringArray(value: unknown): readonly string[] {
  try {
    return stringArrayArg(value);
  } catch {
    return [];
  }
}
