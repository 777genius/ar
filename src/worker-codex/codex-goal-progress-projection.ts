import type { SafeExecutionRunResult } from "@vioxen/subscription-runtime/worker-core";
import type { FileBackendCodexWorkerResult } from "./file-backend-codex-worker";
import type { CodexGoalProgressSnapshot, CodexGoalProgressStatus } from "./codex-goal-runner";

export function progressFromResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): Omit<CodexGoalProgressSnapshot, "schemaVersion" | "taskId" | "updatedAt" | "pid"> {
  const attempts = attemptsFromResult(result);
  const lastAttempt = attempts.at(-1);
  return {
    status: progressStatusFromResult(result.status),
    resultStatus: result.status,
    ...("reason" in result && typeof result.reason === "string"
      ? { reason: result.reason }
      : {}),
    attemptCount: attempts.length,
    ...(lastAttempt && "accountId" in lastAttempt && typeof lastAttempt.accountId === "string"
      ? { currentAccount: lastAttempt.accountId }
      : {}),
  };
}

function attemptsFromResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
) {
  const attempts = "attempts" in result && Array.isArray(result.attempts)
    ? result.attempts
    : [];
  return attempts;
}

export function attemptCountFromResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): number {
  return attemptsFromResult(result).length;
}

export function currentAccountFromResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): string | undefined {
  const lastAttempt = attemptsFromResult(result).at(-1);
  return lastAttempt && "accountId" in lastAttempt &&
    typeof lastAttempt.accountId === "string"
    ? lastAttempt.accountId
    : undefined;
}

function progressStatusFromResult(status: string): CodexGoalProgressStatus {
  if (status === "completed") return "completed";
  if (status === "waiting_capacity") return "blocked";
  if (status === "partial") return "partial";
  if (status === "failed") return "failed";
  if (status === "aborted") return "aborted";
  return "failed";
}
