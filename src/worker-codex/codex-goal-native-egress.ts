import { AccessBoundary, LaunchPlanStatus, NetworkAccessMode } from "@vioxen/subscription-runtime/worker-core";
import { buildCodexGoalAccessLaunchPlan, type CodexGoalAccessConfig } from "./codex-goal-access-plan";
import type { CodexWorkerExecutionEngine } from "./file-backend-codex-runtime-factory";

export function codexGoalNativeEgressConfig(config: CodexGoalAccessConfig): CodexGoalAccessConfig {
  return {
    ...(config.accessBoundary === undefined ? {} : { accessBoundary: config.accessBoundary }),
    ...(config.projectAccessScope === undefined ? {} : { projectAccessScope: config.projectAccessScope }),
    ...(config.networkAccess === undefined ? {} : { networkAccess: config.networkAccess }),
  };
}

/** Select only the ordinary native boundary, never a hosted/TEST authority. */
export function hasUnrestrictedNativeProjectBoundary(
  config: CodexGoalAccessConfig & { readonly executionEngine?: CodexWorkerExecutionEngine },
): boolean {
  if (config.networkAccess !== undefined && config.networkAccess !== NetworkAccessMode.Unrestricted) return false;
  if (config.accessBoundary !== AccessBoundary.ReadOnly &&
      config.accessBoundary !== AccessBoundary.IsolatedWorkspaceWrite) return false;
  if (!config.projectAccessScope || !["app-server", "app-server-goal"].includes(config.executionEngine ?? "app-server-goal")) return false;
  return buildCodexGoalAccessLaunchPlan(config)?.status === LaunchPlanStatus.Ready;
}
