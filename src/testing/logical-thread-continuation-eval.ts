import { AgentRuntimeThreadOutcome } from "../agent-runtime-task/index.js";

export enum LogicalThreadEvalCriterionId {
  RoundDepth = "round_depth",
  StableThreadIdentity = "stable_thread_identity",
  UniqueExecutionIdentity = "unique_execution_identity",
  ContinuationReceipts = "continuation_receipts",
  ExactContextRecall = "exact_context_recall",
  RestartContinuity = "restart_continuity",
  ExactReplayIdempotence = "exact_replay_idempotence",
  StaleWorkspaceFailsClosed = "stale_workspace_fails_closed",
  WorkspaceSnapshotIsolation = "workspace_snapshot_isolation",
  WorkspaceBoundary = "workspace_boundary",
}

export interface LogicalThreadContinuationEvalEvidence {
  readonly expectedRounds: number;
  readonly completedRounds: number;
  readonly threadIds: readonly string[];
  readonly executionIds: readonly string[];
  readonly outcomes: readonly AgentRuntimeThreadOutcome[];
  readonly exactContextRecallChecks: readonly boolean[];
  readonly runnerRestartCount: number;
  readonly exactReplayChecks: readonly boolean[];
  readonly exactReplayProviderSideEffects: number;
  readonly restoredEffectRecovered: boolean;
  readonly staleWorkspaceFailedClosed: boolean;
  readonly forbiddenTokensAbsentFromWorkspaceSnapshots: boolean;
  readonly longHorizonTokenAbsentFromRoundTwoOutput: boolean;
  readonly workspaceBoundaryPreserved: boolean;
}

export interface LogicalThreadEvalCriterion {
  readonly id: LogicalThreadEvalCriterionId;
  readonly weight: number;
  readonly passed: boolean;
}

export interface LogicalThreadContinuationEvalReport {
  readonly score: number;
  readonly maxScore: 10;
  readonly passed: boolean;
  readonly criteria: readonly LogicalThreadEvalCriterion[];
}

const MIN_EVAL_ROUNDS = 3;

export function evaluateLogicalThreadContinuation(
  evidence: LogicalThreadContinuationEvalEvidence,
): LogicalThreadContinuationEvalReport {
  const expectedRounds = Math.max(evidence.expectedRounds, MIN_EVAL_ROUNDS);
  const hasExpectedObservationCount = [
    evidence.threadIds.length,
    evidence.executionIds.length,
    evidence.outcomes.length,
  ].every((count) => count === expectedRounds);
  const stableThreadIdentity =
    evidence.threadIds.length === expectedRounds &&
    new Set(evidence.threadIds).size === 1 &&
    evidence.threadIds[0] !== "";
  const uniqueExecutionIdentity =
    evidence.executionIds.length === expectedRounds &&
    evidence.executionIds.every((id) => id !== "") &&
    new Set(evidence.executionIds).size === expectedRounds;
  const continuationReceipts =
    evidence.outcomes.length === expectedRounds &&
    evidence.outcomes[0] === AgentRuntimeThreadOutcome.StartedFresh &&
    evidence.outcomes.slice(1).every(
      (outcome) => outcome === AgentRuntimeThreadOutcome.Continued,
    );

  const criteria: readonly LogicalThreadEvalCriterion[] = [
    criterion(
      LogicalThreadEvalCriterionId.RoundDepth,
      10,
      expectedRounds >= MIN_EVAL_ROUNDS &&
        evidence.completedRounds === expectedRounds &&
        hasExpectedObservationCount,
    ),
    criterion(
      LogicalThreadEvalCriterionId.StableThreadIdentity,
      10,
      stableThreadIdentity,
    ),
    criterion(
      LogicalThreadEvalCriterionId.UniqueExecutionIdentity,
      10,
      uniqueExecutionIdentity,
    ),
    criterion(
      LogicalThreadEvalCriterionId.ContinuationReceipts,
      15,
      continuationReceipts,
    ),
    criterion(
      LogicalThreadEvalCriterionId.ExactContextRecall,
      20,
      evidence.exactContextRecallChecks.length === expectedRounds - 1 &&
        evidence.exactContextRecallChecks.every(Boolean),
    ),
    criterion(
      LogicalThreadEvalCriterionId.RestartContinuity,
      10,
      evidence.runnerRestartCount >= expectedRounds - 1,
    ),
    criterion(
      LogicalThreadEvalCriterionId.ExactReplayIdempotence,
      5,
      evidence.exactReplayChecks.length === expectedRounds &&
        evidence.exactReplayChecks.every(Boolean) &&
        evidence.exactReplayProviderSideEffects === 0 &&
        evidence.restoredEffectRecovered,
    ),
    criterion(
      LogicalThreadEvalCriterionId.StaleWorkspaceFailsClosed,
      5,
      evidence.staleWorkspaceFailedClosed,
    ),
    criterion(
      LogicalThreadEvalCriterionId.WorkspaceSnapshotIsolation,
      5,
      evidence.forbiddenTokensAbsentFromWorkspaceSnapshots &&
        evidence.longHorizonTokenAbsentFromRoundTwoOutput,
    ),
    criterion(
      LogicalThreadEvalCriterionId.WorkspaceBoundary,
      10,
      evidence.workspaceBoundaryPreserved,
    ),
  ];
  const points = criteria.reduce(
    (total, item) => total + (item.passed ? item.weight : 0),
    0,
  );
  const score = points / 10;
  return {
    score,
    maxScore: 10,
    passed: criteria.every((item) => item.passed),
    criteria,
  };
}

function criterion(
  id: LogicalThreadEvalCriterionId,
  weight: number,
  passed: boolean,
): LogicalThreadEvalCriterion {
  return { id, weight, passed };
}
