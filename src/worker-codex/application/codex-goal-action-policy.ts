import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";

export type CodexGoalRecommendedAction =
  | "start_worker"
  | "wait_for_worker"
  | "review_completed"
  | "continue_after_capacity"
  | "continue_after_timeout"
  | "continue_after_provider_output"
  | "ask_user"
  | "inspect_dirty_workspace"
  | "inspect_dirty_failure"
  | "inspect_failure"
  | "check_log_or_result";

export enum CodexGoalNativeLifecycle {
  Active = "active",
  Terminal = "terminal",
  Uncertain = "uncertain",
}

export function recommendCodexGoalAction(input: {
  readonly nativeLifecycle?: CodexGoalNativeLifecycle;
  readonly tmuxAlive?: boolean;
  readonly resultStatus?: string;
  readonly resultReason?: string;
  readonly progressStatus?: string;
  readonly workspaceExists?: boolean;
  readonly workspaceDirty?: boolean;
  readonly resultExists?: boolean;
  readonly accessBoundary?: AccessBoundary;
}): CodexGoalRecommendedAction {
  if (input.nativeLifecycle === CodexGoalNativeLifecycle.Active) return "wait_for_worker";
  if (input.nativeLifecycle === CodexGoalNativeLifecycle.Uncertain) return "check_log_or_result";
  if (input.nativeLifecycle === CodexGoalNativeLifecycle.Terminal && !input.resultExists) return "check_log_or_result";
  if (input.tmuxAlive) return "wait_for_worker";
  if (input.workspaceExists === false) return "inspect_failure";
  if (input.progressStatus === "maintenance_paused") return "start_worker";
  if (input.resultStatus === "done" || input.resultStatus === "completed") {
    return "review_completed";
  }
  if (input.resultStatus === "waiting_capacity") {
    return "continue_after_capacity";
  }
  if (
    input.accessBoundary === AccessBoundary.ProjectScopedControl &&
    !input.resultExists
  ) {
    return "check_log_or_result";
  }
  if (!input.resultExists) {
    return input.workspaceDirty ? "inspect_dirty_workspace" : "start_worker";
  }
  if (
    input.resultReason === "quota_limited" ||
    input.resultReason === "capacity_unavailable" ||
    input.resultReason === "account_unavailable" ||
    input.resultReason === "reconnect_required"
  ) {
    return "continue_after_capacity";
  }
  if (input.resultReason === "task_timeout") return "continue_after_timeout";
  if (input.resultReason === "provider_output_invalid") {
    return input.workspaceDirty
      ? "inspect_dirty_failure"
      : "continue_after_provider_output";
  }
  if (input.resultStatus === "blocked") return "ask_user";
  if (
    input.resultStatus === "partial" ||
    input.resultStatus === "failed" ||
    input.resultStatus === "aborted"
  ) {
    return input.workspaceDirty ? "inspect_dirty_failure" : "inspect_failure";
  }
  return "check_log_or_result";
}
