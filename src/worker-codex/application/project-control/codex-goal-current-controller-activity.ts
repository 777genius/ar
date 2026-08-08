import {
  assertLocalControllerMaintenanceFenceOpen,
  withLocalControllerActivityLease,
} from "@vioxen/subscription-runtime/store-local-file";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";

export async function withCurrentControllerScopeActivity<T>(input: {
  readonly controllerJobRootDir: string;
  readonly owner: string;
  readonly expectedScope: ProjectAccessScope;
  readonly loadCurrentScope: () => Promise<ProjectAccessScope>;
  readonly effect: () => Promise<T>;
}): Promise<T> {
  return await withLocalControllerActivityLease({
    controllerJobRootDir: input.controllerJobRootDir,
    owner: input.owner,
    effect: async () => {
      const currentScope = await input.loadCurrentScope();
      if (JSON.stringify(currentScope) !== JSON.stringify(input.expectedScope)) {
        throw new Error("project_control_controller_scope_drift");
      }
      return await input.effect();
    },
  });
}

export { assertLocalControllerMaintenanceFenceOpen };
