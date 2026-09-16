import {
  safeExecutionDetailTail,
  safeExecutionErrorMessage,
  type SafeExecutionFailureClassification,
} from "../domain/safe-execution-policy";
import type {
  AttemptPatchStats,
  AttemptRecord,
  AttemptUsage,
  WorkspaceDiffFileStat,
  WorkspaceSnapshot,
} from "../domain/safe-execution-task";
import type { SafeExecutionRunInput } from "./safe-execution-runner-contracts";
import { hashText } from "./safe-execution-workspace";

export function completeAttemptRecord<Job, Result>(input: {
  readonly input: SafeExecutionRunInput<Job, Result>;
  readonly attemptNumber: number;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly before: WorkspaceSnapshot;
  readonly after: WorkspaceSnapshot;
  readonly metadata?: {
    readonly workerId?: string;
    readonly accountId?: string;
  };
  readonly usage?: AttemptUsage;
  readonly outputSummary?: string;
}): AttemptRecord {
  const patch = patchStatsBetween(input.before, input.after);
  return {
    taskId: input.input.taskId,
    attemptNumber: input.attemptNumber,
    ...(input.metadata?.workerId === undefined
      ? {}
      : { workerId: input.metadata.workerId }),
    ...(input.metadata?.accountId === undefined
      ? {}
      : { accountId: input.metadata.accountId }),
    provider: input.input.provider,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: "completed",
    workspaceDirtyBefore: input.before.dirty,
    workspaceDirtyAfter: input.after.dirty,
    changedFiles: changedFilesBetween(input.before, input.after),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.usage === undefined
      ? {}
      : { usageSource: "provider_structured" as const }),
    ...(patch === undefined ? {} : { patch }),
    ...(input.outputSummary === undefined
      ? {}
      : { lastOutputSummary: input.outputSummary }),
  };
}

export function failedAttemptRecord<Job, Result>(input: {
  readonly input: SafeExecutionRunInput<Job, Result>;
  readonly attemptNumber: number;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly before: WorkspaceSnapshot;
  readonly after: WorkspaceSnapshot;
  readonly classification: SafeExecutionFailureClassification;
  readonly failureMessage: string;
  readonly metadata?: {
    readonly workerId?: string;
    readonly accountId?: string;
  };
  readonly usage?: AttemptUsage;
}): AttemptRecord {
  const patch = patchStatsBetween(input.before, input.after);
  return {
    taskId: input.input.taskId,
    attemptNumber: input.attemptNumber,
    ...(input.metadata?.workerId === undefined
      ? {}
      : { workerId: input.metadata.workerId }),
    ...(input.metadata?.accountId === undefined
      ? {}
      : { accountId: input.metadata.accountId }),
    provider: input.input.provider,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: input.classification.retryable ? "blocked" : "failed",
    failureReason: input.classification.reason,
    failureMessage: input.failureMessage,
    ...(input.classification.details === undefined
      ? {}
      : { failureDetails: input.classification.details }),
    workspaceDirtyBefore: input.before.dirty,
    workspaceDirtyAfter: input.after.dirty,
    changedFiles: changedFilesBetween(input.before, input.after),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.usage === undefined
      ? {}
      : { usageSource: "provider_structured" as const }),
    ...(patch === undefined ? {} : { patch }),
  };
}

export function workspaceChanged(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): boolean {
  return before.fingerprint !== after.fingerprint || after.dirty;
}

export function interruptedWorkspaceDetails(
  snapshot: WorkspaceSnapshot,
): Readonly<Record<string, string>> {
  return {
    workspaceMode: snapshot.mode,
    changedFileCount: String(snapshot.changedFiles.length),
    changedFiles: snapshot.changedFiles.slice(0, 20).join(","),
  };
}

export function unavailableWorkspaceSnapshot(input: {
  readonly workspacePath: string;
  readonly error: unknown;
}): WorkspaceSnapshot {
  const capturedAt = new Date();
  const message = safeExecutionErrorMessage(input.error);
  return {
    mode: "unavailable",
    workspacePath: input.workspacePath,
    capturedAt,
    dirty: true,
    changedFiles: [],
    fingerprint: `unavailable:${hashText(
      `${input.workspacePath}:${capturedAt.toISOString()}:${message}`,
    )}`,
    summary: `Workspace snapshot unavailable: ${safeExecutionDetailTail(
      message || "unknown error",
    )}`,
    warnings: ["workspace_snapshot_unavailable"],
  };
}

function changedFilesBetween(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): readonly string[] {
  return changedFilesDelta(before.changedFiles, after.changedFiles);
}

function patchStatsBetween(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): AttemptPatchStats | undefined {
  if (!before.diffNumstat || !after.diffNumstat) return undefined;
  const beforeByPath = diffNumstatByPath(before.diffNumstat);
  let additions = 0;
  let deletions = 0;
  for (const next of after.diffNumstat) {
    if (next.binary) continue;
    const previous = beforeByPath.get(next.path);
    additions += Math.max(0, next.additions - (previous?.additions ?? 0));
    deletions += Math.max(0, next.deletions - (previous?.deletions ?? 0));
  }
  if (additions === 0 && deletions === 0) return undefined;
  return {
    additions,
    deletions,
    source: before.dirty
      ? "git_numstat_delta_dirty_baseline"
      : "git_numstat_delta",
  };
}

function diffNumstatByPath(
  stats: readonly WorkspaceDiffFileStat[],
): Map<string, WorkspaceDiffFileStat> {
  const byPath = new Map<string, WorkspaceDiffFileStat>();
  for (const stat of stats) {
    byPath.set(stat.path, stat);
  }
  return byPath;
}

function changedFilesDelta(
  before: readonly string[],
  after: readonly string[],
): readonly string[] {
  const beforeFiles = new Set(before);
  return after
    .filter((file) => !beforeFiles.has(file))
    .sort((left, right) => left.localeCompare(right));
}
