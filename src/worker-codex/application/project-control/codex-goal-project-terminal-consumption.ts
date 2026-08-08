import { resolve } from "node:path";

import {
  consumedOutputRecordFor,
  type ActiveWriterRiskKind,
  type ConsumedOutputLedger,
  type ConsumedOutputRecord,
} from "@vioxen/subscription-runtime/worker-core";

const DIRTY_OUTPUT_TERMINAL_STATUSES = new Set([
  "integrated",
  "rejected",
  "duplicate",
  "superseded",
  "archived",
]);

export function stoppedWorkspaceTerminalConsumption(input: {
  readonly ledger: ConsumedOutputLedger;
  readonly jobId: string;
  readonly workerAlive: boolean;
  readonly workerExplicitlyStopped: boolean;
  readonly workspacePath: string | undefined;
  readonly resolvedWorkspacePath: string | undefined;
}): ConsumedOutputRecord | undefined {
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
    !DIRTY_OUTPUT_TERMINAL_STATUSES.has(record.status)
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
  return recordPaths.some((path) => currentPaths.has(path)) ? record : undefined;
}

export function terminalConsumptionCoversStoppedRisk(
  record: ConsumedOutputRecord | undefined,
  value: unknown,
): boolean {
  if (!record) return false;
  if (typeof value !== "string") return false;
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
