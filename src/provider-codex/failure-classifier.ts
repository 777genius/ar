import { ChildLifetimeError } from "@vioxen/subscription-runtime/core";
import { AppServerUsageError } from "./app-server/domain/app-server-usage-error";
import { AppServerTurnCheckpointError } from "./app-server/application/app-server-turn-checkpoint";
import type { ProviderFailure } from "@vioxen/subscription-runtime/core";
import { classifyCodexRuntimeFailure } from "./codex-cli-domain";
import { CodexAppServerTurnError } from "./app-server/application/app-server-client";
import { CodexAppServerThreadForkError } from "./app-server/application/app-server-thread-fork-error";
import { codexAppServerBudgetExceededError } from "./app-server/domain/app-server-errors";
import { isCodexModelUnavailableError } from "./app-server/domain/model-catalog";
import { isCodexAppServerRateLimitsRejectedError } from "./app-server/application/app-server-rate-limits-monitor";

export function classifyCodexFailure(error: unknown): ProviderFailure {
  const seen = new Set<Error>();
  for (let cause = error; cause instanceof Error && !seen.has(cause); cause = cause.cause) {
    if (cause instanceof ChildLifetimeError) return {
      code: "budget_exceeded", retryable: false, reconnectRequired: false,
      safeMessage: "Child lifetime authority is exhausted; scoped cleanup was requested.",
      causeCategory: cause.reason, details: { childLifetimeReason: cause.reason },
    };
    seen.add(cause);
  }
  if (error instanceof AppServerTurnCheckpointError) {
    const reason = error.cause instanceof Error &&
      ["handoff_base_commit_mismatch", "handoff_head_changed_during_materialization", "checkpoint_head_moved_during_publish"].includes(error.cause.message)
      ? "head_moved" : "checkpoint_unprotected";
    return {
      code: "checkpoint_unprotected",
      retryable: false,
      reconnectRequired: false,
      safeMessage: "Completed Codex turn was not acknowledged offsite; inspect the local checkpoint and publisher before recovery. Do not replay this turn automatically.",
      causeCategory: "checkpoint_unprotected",
      details: { checkpointReason: reason },
    };
  }
  if (
    error instanceof AppServerUsageError &&
    error.constructor === AppServerUsageError &&
    error.cause instanceof Error
  ) {
    return classifyCodexFailure(error.cause);
  }
  if (
    isCodexAppServerRateLimitsRejectedError(error) &&
    error.reason === "quota_limited"
  ) {
    return {
      code: "quota_limited",
      retryable: true,
      reconnectRequired: false,
      safeMessage: "Codex quota or billing limit was reached.",
      causeCategory: "quota_limited",
    };
  }
  const budgetExceededError = codexAppServerBudgetExceededError(error);
  if (budgetExceededError) {
    return {
      code: "budget_exceeded",
      retryable: false,
      reconnectRequired: false,
      safeMessage: "Codex task exhausted its weighted-token budget.",
      causeCategory: budgetExceededError.kind,
    };
  }
  if (isCodexModelUnavailableError(error)) {
    return {
      code: "model_unavailable",
      retryable: true,
      reconnectRequired: false,
      safeMessage: error.message,
      causeCategory: "model_unavailable",
      details: error.details(),
    };
  }
  const message = codexFailureMessage(error);
  if (error instanceof CodexAppServerTurnError &&
      error.failureDetails.phase !== "turn_start_rejected" &&
      /Incomplete response returned, reason: max_output_tokens(?=:details=|$)/.test(message)) {
    return {
      code: "budget_exceeded", retryable: false, reconnectRequired: false,
      safeMessage: "Provider response exhausted its output-token limit; retained output is incomplete. Do not replay this turn automatically.",
      causeCategory: "max_output_tokens",
      details: { ...codexFailureDetails(error, message), incompleteReason: "max_output_tokens" },
    };
  }
  const state = classifyCodexRuntimeFailure(message);
  const details = codexFailureDetails(error, message);

  switch (state) {
    case "task_cancelled":
      return {
        code: "task_cancelled",
        retryable: false,
        reconnectRequired: false,
        safeMessage: "Codex task was cancelled.",
        causeCategory: state,
        ...(details === undefined ? {} : { details }),
      };
    case "task_timeout":
      return {
        code: "task_timeout",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex task timed out.",
        causeCategory: state,
        ...(details === undefined ? {} : { details }),
      };
    case "provider_output_invalid":
      return {
        code: "provider_output_invalid",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex provider output was invalid.",
        causeCategory: state,
        ...(details === undefined ? {} : { details }),
      };
    case "needs_reconnect":
      return {
        code: "needs_reconnect",
        retryable: false,
        reconnectRequired: true,
        safeMessage: "Codex session needs reconnect.",
        causeCategory: state,
        ...(details === undefined ? {} : { details }),
      };
    case "provider_session_invalid":
      return {
        code: "provider_session_invalid",
        retryable: false,
        reconnectRequired: true,
        safeMessage: "Codex session is invalid.",
        causeCategory: state,
        ...(details === undefined ? {} : { details }),
      };
    case "quota_limited":
      return {
        code: "quota_limited",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex quota or billing limit was reached.",
        causeCategory: state,
        ...(details === undefined ? {} : { details }),
      };
    case "backend_unavailable":
      return {
        code: "backend_unavailable",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex app-server goal backend is temporarily blocked.",
        causeCategory: state,
        ...(details === undefined ? {} : { details }),
      };
    case "goal_slice_exhausted":
      return {
        code: "goal_slice_exhausted",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex app-server goal slice exhausted.",
        causeCategory: state,
        ...(details === undefined ? {} : { details }),
      };
    case "budget_exceeded":
      return {
        code: "budget_exceeded",
        retryable: false,
        reconnectRequired: false,
        safeMessage: "Codex task exhausted its weighted-token budget.",
        causeCategory: state,
        ...(details === undefined ? {} : { details }),
      };
    case "permission_required":
      return {
        code: "permission_required",
        retryable: false,
        reconnectRequired: false,
        safeMessage: "Codex permission is required.",
        causeCategory: state,
        ...(details === undefined ? {} : { details }),
      };
    default:
      return {
        code: "unknown_runtime_failure",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex runtime failed.",
        causeCategory: state,
        ...(details === undefined ? {} : { details }),
      };
  }
}

function codexFailureMessage(error: unknown): string {
  const process = processFailureLike(error);
  if (process) return [process.stdout, process.stderr].filter(Boolean).join("\n");
  return error instanceof Error ? error.message : String(error);
}

function codexFailureDetails(
  error: unknown,
  message: string,
): Readonly<Record<string, string>> | undefined {
  if (error instanceof CodexAppServerThreadForkError) {
    return {
      sourceThreadUnavailable: String(error.sourceThreadUnavailable),
    };
  }
  const details: Record<string, string> =
    error instanceof CodexAppServerTurnError ? { ...error.details() } : {};
  const process = processFailureLike(error);
  if (process?.exitCode !== undefined) {
    details.exitCode = String(process.exitCode);
  }
  if (process?.stderr) {
    details.stderrTail = safeTail(process.stderr);
  }
  if (process?.stdout) {
    details.stdoutTail = safeTail(process.stdout);
  }
  const lastOutputText = lastOutputTextFromError(error);
  if (lastOutputText) {
    details.lastOutputTail = safeTail(lastOutputText);
  }

  const parsed = parseProcessFailureMessage(message);
  if (details.exitCode === undefined && parsed?.exitCode !== undefined) {
    details.exitCode = parsed.exitCode;
  }
  if (details.stderrTail === undefined && parsed?.stderrTail) {
    details.stderrTail = parsed.stderrTail;
  }
  if (message.trim()) {
    details.rawCause = safeTail(message);
  }

  return Object.keys(details).length === 0 ? undefined : details;
}

function lastOutputTextFromError(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as { readonly lastOutputText?: unknown }).lastOutputText;
  return typeof value === "string" && value.trim() ? value : null;
}

function processFailureLike(error: unknown): {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
} | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as {
    readonly exitCode?: unknown;
    readonly stdout?: unknown;
    readonly stderr?: unknown;
  };
  const exitCode =
    typeof record.exitCode === "number" && Number.isInteger(record.exitCode)
      ? record.exitCode
      : undefined;
  const stdout = typeof record.stdout === "string" ? record.stdout : undefined;
  const stderr = typeof record.stderr === "string" ? record.stderr : undefined;
  if (exitCode === undefined && stdout === undefined && stderr === undefined) {
    return null;
  }
  return {
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
  };
}

function parseProcessFailureMessage(
  message: string,
): { readonly exitCode: string; readonly stderrTail: string } | null {
  const match =
    /\b(?:node_process_runner_failed|codex_json_exec_failed|codex_cli_exec_failed):(\d+):(.*)$/s.exec(
      message,
    );
  if (!match) return null;
  return {
    exitCode: match[1]!,
    stderrTail: safeTail(match[2] ?? ""),
  };
}

function safeTail(value: string): string {
  // Bound the original bytes before any transform. Normalizing whitespace can
  // shrink an oversized secret-bearing message or change a multiline secret
  // before the store's exact-secret redactor sees it.
  return value.length > 1000 ? "[redacted:oversized-provider-detail]" : value;
}

export function codexFinishReasonForFailure(
  code: ProviderFailure["code"],
):
  | "completed"
  | "waiting_for_input"
  | "max_turns"
  | "cancelled"
  | "timeout"
  | "budget_exceeded"
  | "provider_error" {
  if (code === "task_cancelled") return "cancelled";
  if (code === "task_timeout") return "timeout";
  if (code === "goal_slice_exhausted") return "max_turns";
  if (code === "budget_exceeded") return "budget_exceeded";
  return "provider_error";
}
