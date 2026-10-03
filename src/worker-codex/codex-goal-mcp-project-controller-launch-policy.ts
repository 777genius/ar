import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "./codex-goal-jobs";
import { projectControlWorkspaceLocks } from "./codex-goal-project-workspace-lock";
import { controllerScopeLockIdentity } from "./codex-goal-mcp-project-control-ledger-epoch";

/** Scope lock precedes workspace and activity leases, matching scope updates. */
export async function withCurrentControllerLaunchPolicy<T>(input: {
  readonly registryRootDir: string;
  readonly controllerJobId: string;
  readonly expectedScope: ProjectAccessScope;
  readonly loadCurrentController: () => Promise<{
    readonly registryRootDir: string;
    readonly controller: CodexGoalJobManifest;
    readonly scope: ProjectAccessScope;
  }>;
  readonly effect: (controller: CodexGoalJobManifest) => Promise<T>;
}): Promise<T> {
  const locks = projectControlWorkspaceLocks(input.registryRootDir);
  const lease = await locks.acquire({
    workspacePath: controllerScopeLockIdentity(input.registryRootDir, input.controllerJobId),
    owner: `controller-child-launch:${input.controllerJobId}`,
  });
  try {
    const current = await input.loadCurrentController();
    if (current.registryRootDir !== input.registryRootDir ||
      current.controller.jobId !== input.controllerJobId ||
      JSON.stringify(current.scope) !== JSON.stringify(input.expectedScope)) {
      throw new Error("project_control_controller_scope_drift");
    }
    // The caller includes preflight, admission, and committed/scheduled start.
    return await input.effect(current.controller);
  } finally {
    await locks.release(lease);
  }
}
