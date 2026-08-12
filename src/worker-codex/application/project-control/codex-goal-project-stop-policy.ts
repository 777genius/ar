import type { WorkerHealthSnapshot } from "@vioxen/subscription-runtime/worker-core";
import type { ProjectPreStartAdmissionLaunchWorkspaceMode } from "./codex-goal-project-pre-start-admission-types";

export type CodexGoalProjectStopPolicyInput = Pick<
  WorkerHealthSnapshot,
  "alive" | "silentStale" | "heartbeatOnlyNoOutput"
> & {
  readonly terminalCapacityPause?: boolean;
};

export type CodexGoalProjectStopPolicyDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "project_control_fresh_worker_stop_denied";
      readonly requiredState: "silent_stale_or_heartbeat_only_no_output";
      readonly safeMessage: string;
    };

export function isCodexGoalProjectTerminalCapacityPause(
  workspaceMode: ProjectPreStartAdmissionLaunchWorkspaceMode | undefined,
): boolean {
  return workspaceMode === "admitted_input_patch_continuation" ||
    workspaceMode === "admitted_input_patch_runtime_continuation" ||
    workspaceMode === "clean_capacity_continuation";
}

/**
 * Project controllers may retire stale or no-output workers, but they must not
 * turn a fresh healthy attempt into failed_no_output. Emergency cancellation of
 * a healthy attempt belongs to the operator/runtime boundary, not orchestration.
 */
export function decideCodexGoalProjectStop(
  input: CodexGoalProjectStopPolicyInput,
): CodexGoalProjectStopPolicyDecision {
  if (
    !input.alive ||
    input.silentStale ||
    input.heartbeatOnlyNoOutput ||
    input.terminalCapacityPause === true
  ) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: "project_control_fresh_worker_stop_denied",
    requiredState: "silent_stale_or_heartbeat_only_no_output",
    safeMessage:
      "ProjectScopedControl cannot stop an alive worker until stale or heartbeat-only no-output state is proven. A model-supplied force flag grants no kill authority.",
  };
}
