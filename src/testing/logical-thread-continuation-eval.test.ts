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

    expect(report).toMatchObject({ score: 10, maxScore: 10, threshold: 9.5, passed: true });
    expect(report.criteria).toHaveLength(10);
    expect(report.criteria.every((criterion) => criterion.passed)).toBe(true);
  });

  it("fails a high aggregate score when a required context criterion fails", () => {
    const report = evaluateLogicalThreadContinuation({
      ...passingEvidence(),
      exactContextRecallChecks: [true, false],
    });

    expect(report.score).toBe(8);
    expect(report.passed).toBe(false);
    expect(report.criteria).toContainEqual(expect.objectContaining({
      id: LogicalThreadEvalCriterionId.ExactContextRecall,
      required: true,
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

  it("allows one optional resilience miss at the 9.5/10 threshold", () => {
    const report = evaluateLogicalThreadContinuation({
      ...passingEvidence(),
      exactReplayChecks: [true, false, true],
    });

    expect(report).toMatchObject({ score: 9.5, passed: true });
  });

  it("requires fail-closed stale-workspace evidence even at the score threshold", () => {
    const report = evaluateLogicalThreadContinuation({
      ...passingEvidence(),
      staleWorkspaceFailedClosed: false,
    });

    expect(report).toMatchObject({ score: 9.5, threshold: 9.5, passed: false });
    expect(report.criteria).toContainEqual(expect.objectContaining({
      id: LogicalThreadEvalCriterionId.StaleWorkspaceFailsClosed,
      required: true,
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
    staleWorkspaceFailedClosed: true,
    contextStayedOutOfWorkspaceUntilRequested: true,
    workspaceBoundaryPreserved: true,
  };
}
