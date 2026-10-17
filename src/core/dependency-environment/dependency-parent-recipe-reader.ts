import type { HostedInventoryLaunch } from "../host-infrastructure/host-inventory";

/** Normalized read-only writer roots selected by the trusted worker recipe.
 * These facts never replace origin, binding, fence or FD admission. */
export type DependencyParentRecipeOriginalRoots = Readonly<{
  auth: string;
  capacity: string;
  registry: string;
  handoff: string;
  state: string;
  progress: string;
  log: string;
}>;

/** Worker-owned stored-plan mechanics supplied by trusted composition. These
 * configuration facts never replace origin, binding, fence or FD admission. */
export interface DependencyParentRecipeReader {
  readStoredLaunch(launch: HostedInventoryLaunch, job: string, workspace: string): HostedInventoryLaunch;
  readProjectAccessScope(json: string): Readonly<{
    registryRoot?: string;
    workspaceRoots?: readonly string[];
  }> | undefined;
  readOriginalUsableParentRoots(launch: HostedInventoryLaunch, job: string, workspace: string):
    DependencyParentRecipeOriginalRoots | undefined;
}
