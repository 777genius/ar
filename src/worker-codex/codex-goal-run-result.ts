import { parseNativeWebEvidence, type NativeWebEvidence } from "@vioxen/subscription-runtime/core";
import { ManagedRunNativeWebError } from "./file-backend-codex-managed-run-recovery";
import {
  isSubscriptionWorkerError,
  normalizeWorkerReport,
  type RuntimeRecommendedAction,
  type RuntimeResultStatus,
  type SafeExecutionRunResult,
  type WorkerReport,
} from "@vioxen/subscription-runtime/worker-core";
import type { FileBackendCodexWorkerResult } from "./file-backend-codex-worker";

export function codexRunnerExceptionFailure(error: unknown): {
  readonly reason: string;
  readonly safeMessage: string;
  readonly evidence: string;
  readonly errorCode?: string;
} {
  for (const item of errorCauseChain(error)) {
    if (!isSubscriptionWorkerError(item)) continue;
    if (item.code === "subscription_worker_prewarm_failed") {
      return {
        reason: "prewarm_failed",
        safeMessage: "Codex provider prewarm failed before task execution.",
        evidence: "provider prewarm failed before any task attempt",
        errorCode: item.code,
      };
    }
    if (
      item.code === "subscription_worker_start_failed" ||
      item.code === "subscription_worker_start_timeout"
    ) {
      return {
        reason: "provider_start_failed",
        safeMessage: "Codex provider failed to start before task execution.",
        evidence: "provider start failed before any task attempt",
        errorCode: item.code,
      };
    }
  }
  return {
    reason: "runner_exception",
    safeMessage: error instanceof Error ? error.message : "Runner failed.",
    evidence: "runner threw before returning a safe execution result",
  };
}

function errorCauseChain(error: unknown): readonly unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = typeof current === "object" && "cause" in current
      ? (current as { readonly cause?: unknown }).cause
      : undefined;
  }
  return chain;
}

export function runtimeResultDetails(input: {
  readonly failureDetails?: Readonly<Record<string, string>>;
  readonly baseCommit?: string;
  readonly nativeWeb?: NativeWebEvidence;
  readonly handoffDetails: Readonly<Record<string, string>>;
}): Readonly<Record<string, string>> | undefined {
  const details = {
    ...Object.fromEntries(Object.entries(input.failureDetails ?? {}).filter(([key]) => key !== 'nativeWeb')),
    ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
    ...input.handoffDetails,
    ...(input.nativeWeb === undefined ? {} : { nativeWeb: JSON.stringify(parseNativeWebEvidence(input.nativeWeb)) }),
  };
  return Object.keys(details).length === 0 ? undefined : details;
}

export function runtimeStatusFromSafeExecutionResult(input: {
  readonly resultStatus: SafeExecutionRunResult<FileBackendCodexWorkerResult>["status"];
  readonly changedFilesCount: number;
}): RuntimeResultStatus {
  if (input.resultStatus === "completed") return "done";
  if (input.resultStatus === "waiting_capacity") return "blocked";
  if (input.resultStatus === "partial") return "partial";
  if (input.resultStatus === "aborted" && input.changedFilesCount > 0) {
    return "partial";
  }
  return "failed";
}

export function runtimeActionFromSafeExecutionResult(input: {
  readonly status: RuntimeResultStatus;
  readonly resultStatus?: SafeExecutionRunResult<FileBackendCodexWorkerResult>["status"];
  readonly reason?: string | undefined;
  readonly changedFilesCount: number;
}): RuntimeRecommendedAction {
  if (input.status === "done") return "review_completed";
  if (input.resultStatus === "waiting_capacity") return "wait";
  if (
    input.reason === "quota_limited" ||
    input.reason === "capacity_unavailable" ||
    input.reason === "account_unavailable" ||
    input.reason === "reconnect_required"
  ) {
    return "switch_account";
  }
  if (input.reason === "goal_slice_exhausted") return "launch_next_slice";
  if (input.reason === "permission_required") return "ask_user";
  if (input.changedFilesCount > 0) return "preserve_patch";
  return input.status === "failed" ? "recover" : "continue";
}

export function runtimeEvidenceFromSafeExecutionResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): readonly string[] {
  const evidence = [`safe_execution_status:${result.status}`];
  if (result.task.outputSummary) {
    evidence.push(`output_summary:${result.task.outputSummary}`);
  }
  if (result.attempts.length > 0) {
    evidence.push(`attempt_count:${result.attempts.length}`);
  }
  return evidence;
}

export function runtimeBlockersFromSafeExecutionResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): readonly string[] {
  if (result.status === "completed") return [];
  const blockers: string[] = "reason" in result ? [result.reason] : [];
  if ("safeMessage" in result && result.safeMessage) {
    blockers.push(result.safeMessage);
  }
  return blockers;
}

export function workerReportFromSafeExecutionResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): WorkerReport | undefined {
  if (result.status !== "completed") return undefined;
  if (!("result" in result) || result.result === undefined) return undefined;
  return normalizeWorkerReport(result.result.structuredOutput);
}

/** Host reads only the managed provider result/error channel, never model output,
 * workspace JSON, telemetry counts, or failure detail strings. */
export function nativeWebFromManagedError(error: unknown): NativeWebEvidence | undefined {
  for (const item of errorCauseChain(error)) {
    if (item instanceof ManagedRunNativeWebError) return parseNativeWebEvidence(item.nativeWeb);
  }
  return undefined;
}
export function nativeWebFromSafeExecutionResult(result: SafeExecutionRunResult<FileBackendCodexWorkerResult>): NativeWebEvidence | undefined {
  if ('result' in result && result.result?.nativeWeb !== undefined) return parseNativeWebEvidence(result.result.nativeWeb);
  return 'error' in result ? nativeWebFromManagedError(result.error) : undefined;
}
