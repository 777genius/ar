import { describe, expect, it } from "vitest";
import type { RuntimeResultEnvelope } from "../../runtime-result";
import type { SafeExecutionTaskRecord } from "../../safe-execution/domain/safe-execution-task";
import { selectTerminalAttempt, TerminalSelectionRefusal } from "../domain/select-terminal-attempt";

const start = new Date("2026-09-23T00:00:00.000Z");
const finish = new Date("2026-09-23T00:00:01.000Z");
const journal: SafeExecutionTaskRecord = {
  taskId: "test-task", workspaceRunId: "test-workspace", workspacePath: "/tmp/test-workspace",
  executionGeneration: "test-generation", effectMode: "read_only", provider: "codex",
  status: "completed", startedAt: start, updatedAt: finish, completedAt: finish,
  attempts: [{ taskId: "test-task", attemptNumber: 1, provider: "codex",
    startedAt: start, finishedAt: finish, status: "completed", workspaceDirtyBefore: false,
    changedFiles: [] }],
};
const result: RuntimeResultEnvelope = {
  schemaVersion: 1, status: "done", runId: "test-job", taskId: "test-task",
  changedFiles: [], evidence: [], blockers: [], nextAction: "review_completed",
  details: { executionGeneration: "test-generation", attemptNumber: "1" },
  updatedAt: "2026-09-23T00:00:02.000Z",
};
const events = [
  { event: "runner_starting", timestamp: start.toISOString(),
    attributes: { jobId: "test-job", executionGeneration: "test-generation" } },
  { event: "runner_disposed", timestamp: "2026-09-23T00:00:03.000Z",
    attributes: { jobId: "test-job", executionGeneration: "test-generation" } },
];
const input = { jobId: "test-job", taskId: "test-task", executionGeneration: "test-generation",
  attemptNumber: 1, journal, result, events, ownershipComplete: true };

describe("actual safe-execution journal terminal selection", () => {
  it("selects matching rewritten task and attempt evidence", () => {
    expect(selectTerminalAttempt(input)).toMatchObject({ attemptNumber: 1,
      executionGeneration: "test-generation" });
  });
  it("rejects partial, mismatched generation, disposal and unknown ownership", () => {
    expect(() => selectTerminalAttempt({ ...input, journal: { ...journal, status: "partial" } }))
      .toThrow(TerminalSelectionRefusal.Journal);
    expect(() => selectTerminalAttempt({ ...input, result: { ...result,
      details: { executionGeneration: "other", attemptNumber: "1" } } }))
      .toThrow(TerminalSelectionRefusal.Generation);
    expect(() => selectTerminalAttempt({ ...input, events: events.slice(0, 1) }))
      .toThrow(TerminalSelectionRefusal.Disposal);
    expect(() => selectTerminalAttempt({ ...input, ownershipComplete: false }))
      .toThrow(TerminalSelectionRefusal.Ownership);
  });
});
