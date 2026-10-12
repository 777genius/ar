import type { ProviderFailure } from "@vioxen/subscription-runtime/core";

export function finishReasonForFailure(
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
