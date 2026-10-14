import type { RuntimeResultEnvelope } from "../../runtime-result";
import type { SafeExecutionTaskRecord } from "../../safe-execution/domain/safe-execution-task";

export enum TerminalSelectionRefusal {
  Identity = "checkpoint_identity_mismatch",
  Generation = "checkpoint_generation_mismatch",
  Journal = "checkpoint_journal_not_terminal",
  Result = "checkpoint_result_not_terminal",
  Disposal = "checkpoint_disposal_unproved",
  Ownership = "checkpoint_process_ownership_unproved",
}

export type TerminalAttemptSelection = {
  readonly jobId: string;
  readonly taskId: string;
  readonly executionGeneration: string;
  readonly attemptNumber: number;
  readonly terminalAt: string;
};

/** Pure selection over the actual rewritten SafeExecutionTaskRecord schema. */
export function selectTerminalAttempt(input: {
  readonly jobId: string;
  readonly taskId: string;
  readonly executionGeneration: string;
  readonly attemptNumber: number;
  readonly journal: SafeExecutionTaskRecord;
  readonly result: RuntimeResultEnvelope;
  readonly events: readonly Readonly<{
    event: string;
    timestamp: string;
    attributes?: Readonly<Record<string, string | number | boolean>>;
  }>[];
  /** Supplied only by an authoritative owner adapter after descendant completion. */
  readonly ownershipComplete: boolean;
}): TerminalAttemptSelection {
  const { journal, result } = input;
  if (result.runId !== input.jobId || result.taskId !== input.taskId ||
      journal.taskId !== input.taskId || !Number.isSafeInteger(input.attemptNumber) ||
      input.attemptNumber < 1) throw new Error(TerminalSelectionRefusal.Identity);
  if (!input.executionGeneration || journal.executionGeneration !== input.executionGeneration ||
      result.details?.executionGeneration !== input.executionGeneration ||
      result.details?.attemptNumber !== String(input.attemptNumber)) {
    throw new Error(TerminalSelectionRefusal.Generation);
  }
  const selected = journal.attempts.at(-1);
  if (!selected || selected.attemptNumber !== input.attemptNumber ||
      selected.taskId !== input.taskId || !selected.finishedAt ||
      selected.status === "running" || selected.status === "blocked" ||
      journal.status === "running" || journal.status === "partial" ||
      journal.status === "waiting_capacity" || journal.status === "aborted" ||
      !journal.completedAt && journal.status === "completed") {
    throw new Error(TerminalSelectionRefusal.Journal);
  }
  if (!((result.status === "done" && journal.status === "completed" && selected.status === "completed") ||
        (result.status === "failed" && journal.status === "failed" && selected.status === "failed"))) {
    throw new Error(TerminalSelectionRefusal.Result);
  }
  const matching = input.events.filter((event) =>
    event.attributes?.jobId === input.jobId &&
    event.attributes.executionGeneration === input.executionGeneration);
  const start = matching.find((event) => event.event === "runner_starting");
  const disposed = matching.at(-1);
  const startAt = Date.parse(start?.timestamp ?? "");
  const disposedAt = Date.parse(disposed?.timestamp ?? "");
  const resultAt = Date.parse(result.updatedAt ?? "");
  const attemptFinishedAt = selected.finishedAt.getTime();
  if (disposed?.event !== "runner_disposed" || !Number.isFinite(startAt) ||
      !Number.isFinite(disposedAt) || !Number.isFinite(resultAt) ||
      startAt > attemptFinishedAt || attemptFinishedAt > resultAt ||
      resultAt > disposedAt) throw new Error(TerminalSelectionRefusal.Disposal);
  if (!input.ownershipComplete) throw new Error(TerminalSelectionRefusal.Ownership);
  return {
    jobId: input.jobId, taskId: input.taskId,
    executionGeneration: input.executionGeneration,
    attemptNumber: input.attemptNumber,
    terminalAt: disposed!.timestamp,
  };
}
