import { AgentRuntimeExecutionMode, type ProviderTask } from "@vioxen/subscription-runtime/core";

export function readTaskGoalObjective(task: ProviderTask): string | null {
  if (task.execution?.mode === AgentRuntimeExecutionMode.Goal) {
    return task.execution.completionCondition;
  }
  const value = task.metadata?.codexGoalObjective;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function readTaskManagedRunId(task: ProviderTask): string | null {
  const value = task.metadata?.codexManagedRunId ?? task.metadata?.runId;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
