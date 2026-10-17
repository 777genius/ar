import { resolve } from "node:path";

import {
  consumedOutputRecordFor,
  type ActiveWriterRiskKind,
  type ConsumedOutputLedger,
  type ConsumedOutputRecord,
} from "@vioxen/subscription-runtime/worker-core";
import { freshCleanGitWorkspace } from "./codex-goal-project-workspace-history";

const DIRTY_OUTPUT_TERMINAL_STATUSES = new Set([
  "integrated",
  "rejected",
  "duplicate",
  "superseded",
  "archived",
]);

const CLEAN_NO_OUTPUT_TERMINAL_STATUS = "failed_no_output";
const RETAINED_NONQUALIFIED_TERMINAL_STATUS = "retained_nonqualified";

export async function stoppedWorkspaceTerminalConsumption(input: {
  readonly ledger: ConsumedOutputLedger;
  readonly jobId: string;
  readonly workerAlive: boolean;
  readonly workerExplicitlyStopped: boolean;
  /**
   * retained_nonqualified consumes a stopped workspace only after the caller
   * re-verified the exact retained originals (receipt, manifest, original
   * lifecycle state and workspace inventory) against the present disk.
   */
  readonly retainedNonqualifiedVerified?: boolean;
  readonly workspaceDirty: boolean | undefined;
  readonly workspacePath: string | undefined;
  readonly resolvedWorkspacePath: string | undefined;
}): Promise<ConsumedOutputRecord | undefined> {
  if (
    input.workerAlive ||
    !input.workerExplicitlyStopped ||
    !input.workspacePath
  ) return undefined;
  const record = consumedOutputRecordFor({
    ledger: input.ledger,
    jobId: input.jobId,
    workspacePath: input.workspacePath,
    ...(input.resolvedWorkspacePath
      ? { resolvedWorkspacePath: input.resolvedWorkspacePath }
      : {}),
  });
  if (
    record?.jobId !== input.jobId ||
    record?.structurallyValid !== true ||
    !DIRTY_OUTPUT_TERMINAL_STATUSES.has(record.status) &&
    !(record.status === RETAINED_NONQUALIFIED_TERMINAL_STATUS &&
      record.valid === true &&
      input.retainedNonqualifiedVerified === true) &&
    !(record.status === CLEAN_NO_OUTPUT_TERMINAL_STATUS &&
      record.valid === true &&
      input.workspaceDirty === false &&
      record.hasAuthoredOutput === false &&
      record.backupWorkspaceDirty === false)
  ) {
    return undefined;
  }
  const currentPaths = new Set([
    resolve(input.workspacePath),
    ...(input.resolvedWorkspacePath
      ? [resolve(input.resolvedWorkspacePath)]
      : []),
  ]);
  const recordPaths = [record.workspace, record.resolvedWorkspace]
    .filter((path): path is string => path !== undefined)
    .map((path) => resolve(path));
  if (!recordPaths.some((path) => currentPaths.has(path))) return undefined;
  if (record.status === CLEAN_NO_OUTPUT_TERMINAL_STATUS &&
    !await freshCleanGitWorkspace(input.workspacePath)) return undefined;
  return record;
}

export function terminalConsumptionCoversStoppedRisk(
  record: ConsumedOutputRecord | undefined,
  value: unknown,
): boolean {
  if (!record) return false;
  if (typeof value !== "string") return false;
  if (record.status === CLEAN_NO_OUTPUT_TERMINAL_STATUS) {
    return value === "none";
  }
  return value === "none" || value === "dirty_workspace_without_worker";
}

const activeWriterRiskKinds = new Set<string>([
  "none",
  "active_worker",
  "stale_live_worker",
  "dirty_workspace_without_worker",
  "state_mismatch",
  "unknown",
] satisfies readonly ActiveWriterRiskKind[]);

export function hasBlockingActiveWriterRisk(
  value: unknown,
  workerAlive: boolean,
): boolean {
  // Keep accepting the former boolean overview shape while current status
  // views publish a typed risk kind. A healthy active worker is only a conflict
  // when admission targets its workspace; uncertain states still fail closed.
  if (value === true) return true;
  const kind = typeof value === "string" && value.trim() ? value : undefined;
  if (kind === undefined) return false;
  if (!activeWriterRiskKinds.has(kind)) return true;
  if (kind === "none") return false;
  if (kind === "active_worker") return !workerAlive;
  return true;
}
