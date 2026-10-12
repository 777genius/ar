import type { HostedInventoryLaunch } from "../host-infrastructure/host-inventory";

/** Worker-owned stored-plan mechanics supplied by trusted composition. These
 * configuration facts never replace origin, binding, fence or FD admission. */
export interface DependencyParentRecipeReader {
  readStoredLaunch(launch: HostedInventoryLaunch, job: string, workspace: string): HostedInventoryLaunch;
  readProjectAccessScope(json: string): Readonly<{
    registryRoot?: string;
    workspaceRoots?: readonly string[];
  }> | undefined;
}
