import {
  AgentRuntimeAccessBoundary,
  AgentRuntimeBudgetEnforcement,
  AgentRuntimeBudgetMetric,
  AgentRuntimeExecutionMode,
  AgentRuntimeTool,
  AgentRuntimeTurnLimitEnforcement,
  type AgentCapabilities,
  type AgentRuntimeToolName,
  type ProviderTask,
} from "@vioxen/subscription-runtime/core";
import { codexAgentCapabilities } from "@vioxen/subscription-runtime/provider-codex";
import { isBoundedWorkspaceTool } from "../../worker-codex/workspace-tools/bounded-workspace-tool-policy";

export type CodexExecutionPlan = {
  readonly execution: {
    readonly mode: AgentRuntimeExecutionMode;
    readonly goalObjective?: string;
    readonly maxGoalTurns?: number;
  };
  readonly workspaceToolPolicy?: {
    readonly allowedTools: readonly AgentRuntimeToolName[];
  };
  readonly rolloutBudget?: {
    readonly weightedTokenLimit: number;
  };
};

export function compileCodexExecutionPlan(
  task: ProviderTask,
): CodexExecutionPlan | undefined {
  const execution = task.execution ?? {
    mode: AgentRuntimeExecutionMode.SingleRun,
  };
  const workspaceToolPolicy = compileWorkspaceToolPolicy(task);
  const rolloutBudget = task.controls?.budget?.metric ===
      AgentRuntimeBudgetMetric.WeightedTokens
    ? { weightedTokenLimit: task.controls.budget.limit }
    : undefined;
  if (
    execution.mode === AgentRuntimeExecutionMode.SingleRun &&
    !workspaceToolPolicy &&
    !rolloutBudget
  ) return undefined;
  return {
    execution: execution.mode === AgentRuntimeExecutionMode.Goal
      ? {
          mode: AgentRuntimeExecutionMode.Goal,
          goalObjective: execution.completionCondition,
          ...(task.controls?.maxTurns === undefined
            ? {}
            : { maxGoalTurns: task.controls.maxTurns }),
        }
      : { mode: AgentRuntimeExecutionMode.SingleRun },
    ...(workspaceToolPolicy ? { workspaceToolPolicy } : {}),
    ...(rolloutBudget ? { rolloutBudget } : {}),
  };
}

function compileWorkspaceToolPolicy(
  task: ProviderTask,
): { readonly allowedTools: readonly AgentRuntimeToolName[] } | undefined {
  const controls = task.controls;
  const policy = controls?.toolPolicy;
  if (!policy || policy.allow === undefined) return undefined;
  if (
    (policy.allowProviderTools?.length ?? 0) > 0 ||
    (policy.denyProviderTools?.length ?? 0) > 0
  ) {
    return undefined;
  }
  if (
    controls.accessBoundary === AgentRuntimeAccessBoundary.ProjectScopedControl ||
    controls.accessBoundary === AgentRuntimeAccessBoundary.DangerFullAccess
  ) {
    return undefined;
  }

  const denied = new Set(policy.deny ?? []);
  const allowedTools = [...new Set(policy.allow)]
    .filter((tool) => !denied.has(tool))
    .sort();
  if (allowedTools.some((tool) => !isBoundedWorkspaceTool(tool))) {
    return undefined;
  }

  const writesWorkspace = allowedTools.some((tool) =>
    tool === AgentRuntimeTool.EditFile || tool === AgentRuntimeTool.WriteFile
  );
  if (
    writesWorkspace &&
    controls.accessBoundary !== AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite
  ) {
    return undefined;
  }
  return { allowedTools };
}

export function codexCapabilitiesForExecutionPlan(
  plan: CodexExecutionPlan | undefined,
): AgentCapabilities {
  if (!plan) return codexAgentCapabilities;
  const workspaceToolPolicy = plan.workspaceToolPolicy;
  return {
    ...codexAgentCapabilities,
    ...(workspaceToolPolicy
      ? {
          toolPolicyMode: "host-filtered" as const,
          accessBoundaryMode: "host-scoped" as const,
          supportsToolCalling: true,
          requiresWritableWorkspace: workspaceToolPolicy.allowedTools.some(
            (tool) =>
              tool === AgentRuntimeTool.EditFile ||
              tool === AgentRuntimeTool.WriteFile,
          ),
        }
      : {}),
    ...(plan.rolloutBudget
      ? {
          budgetCapabilities: [
            {
              metric: AgentRuntimeBudgetMetric.WeightedTokens,
              enforcement: AgentRuntimeBudgetEnforcement.ProviderNative,
            },
          ],
        }
      : {}),
    taskExecutionCapabilities: [
      { mode: AgentRuntimeExecutionMode.SingleRun },
      ...(plan.execution.mode === AgentRuntimeExecutionMode.Goal
        ? [{
            mode: AgentRuntimeExecutionMode.Goal,
            maxCompletionConditionChars: 4_000,
          } as const]
        : []),
    ],
    turnLimitEnforcement: plan.execution.mode === AgentRuntimeExecutionMode.Goal
      ? AgentRuntimeTurnLimitEnforcement.ProviderNative
      : codexAgentCapabilities.turnLimitEnforcement ??
        AgentRuntimeTurnLimitEnforcement.Unsupported,
  };
}
