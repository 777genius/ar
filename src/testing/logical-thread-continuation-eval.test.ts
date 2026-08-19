import { describe, expect, it } from "vitest";

import { AgentRuntimeThreadOutcome } from "../agent-runtime-task/index.js";
import {
  evaluateLogicalThreadContinuation,
  LogicalThreadEvalCriterionId,
  type LogicalThreadContinuationEvalEvidence,
} from "./logical-thread-continuation-eval.js";

describe("logical-thread continuation eval", () => {
  it("scores complete three-round continuation evidence at 10/10", () => {
    const report = evaluateLogicalThreadContinuation(passingEvidence());

    expect(report).toMatchObject({ score: 10, maxScore: 10, passed: true });
    expect(report).not.toHaveProperty("threshold");
    expect(report.criteria).toHaveLength(10);
    expect(report.criteria.every((criterion) => criterion.passed)).toBe(true);
  });

  it("fails when an exact context criterion misses", () => {
    const report = evaluateLogicalThreadContinuation({
      ...passingEvidence(),
      exactContextRecallChecks: [true, false],
    });

    expect(report.score).toBe(8);
    expect(report.passed).toBe(false);
    expect(report.criteria).toContainEqual(expect.objectContaining({
      id: LogicalThreadEvalCriterionId.ExactContextRecall,
      passed: false,
    }));
  });

  it("does not accept two rounds as a continuation-depth eval", () => {
    const report = evaluateLogicalThreadContinuation({
      ...passingEvidence(),
      expectedRounds: 2,
      completedRounds: 2,
      threadIds: ["thread-1", "thread-1"],
      executionIds: ["execution-1", "execution-2"],
      outcomes: [
        AgentRuntimeThreadOutcome.StartedFresh,
        AgentRuntimeThreadOutcome.Continued,
      ],
      exactContextRecallChecks: [true],
      exactReplayChecks: [true, true],
    });

    expect(report.passed).toBe(false);
    expect(report.criteria).toContainEqual(expect.objectContaining({
      id: LogicalThreadEvalCriterionId.RoundDepth,
      passed: false,
    }));
  });

  it("requires exact replay even when the diagnostic score is 9.5/10", () => {
    const report = evaluateLogicalThreadContinuation({
      ...passingEvidence(),
      exactReplayChecks: [true, false, true],
    });

    expect(report).toMatchObject({ score: 9.5, passed: false });
  });

  it("requires fail-closed stale-workspace evidence", () => {
    const report = evaluateLogicalThreadContinuation({
      ...passingEvidence(),
      staleWorkspaceFailedClosed: false,
    });

    expect(report).toMatchObject({ score: 9.5, passed: false });
    expect(report.criteria).toContainEqual(expect.objectContaining({
      id: LogicalThreadEvalCriterionId.StaleWorkspaceFailsClosed,
      passed: false,
    }));
  });

  it("requires exact replay recovery after restoring the workspace effect", () => {
    const report = evaluateLogicalThreadContinuation({
      ...passingEvidence(),
      restoredEffectRecovered: false,
    });

    expect(report).toMatchObject({ score: 9.5, passed: false });
    expect(report.criteria).toContainEqual(expect.objectContaining({
      id: LogicalThreadEvalCriterionId.ExactReplayIdempotence,
      passed: false,
    }));
  });
});

function passingEvidence(): LogicalThreadContinuationEvalEvidence {
  return {
    expectedRounds: 3,
    completedRounds: 3,
    threadIds: ["thread-1", "thread-1", "thread-1"],
    executionIds: ["execution-1", "execution-2", "execution-3"],
    outcomes: [
      AgentRuntimeThreadOutcome.StartedFresh,
      AgentRuntimeThreadOutcome.Continued,
      AgentRuntimeThreadOutcome.Continued,
    ],
    exactContextRecallChecks: [true, true],
    runnerRestartCount: 5,
    exactReplayChecks: [true, true, true],
    exactReplayProviderSideEffects: 0,
    restoredEffectRecovered: true,
    staleWorkspaceFailedClosed: true,
    forbiddenTokensAbsentFromWorkspaceSnapshots: true,
    longHorizonTokenAbsentFromRoundTwoOutput: true,
    workspaceBoundaryPreserved: true,
  };
}
