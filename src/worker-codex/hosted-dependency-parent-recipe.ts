import { parseCodexGoalProjectAccessScopeJson } from "./codex-goal-access-plan";
import type { DependencyParentRecipeReader } from "../core/dependency-environment/dependency-parent-recipe-reader";
import type { HostedInventoryLaunch } from "../core/host-infrastructure/host-inventory";
import { resolveStoredProjectStartPlan } from "./stored-start-planning";
import { buildCodexGoalForegroundArgv } from "./application/codex-goal-foreground-command";
import { readHostedOriginalUsableParentRoots } from "./hosted-original-usable-parent-recipe";
import { readHostedDependencyParentRecipe as readProviderRecipe,
  assertHostedDependencyParentRecipe as assertProviderRecipe } from "../provider-codex/app-server/adapters/hosted-dependency-parent-recipe";
export { assertHostedDependencyParentEnvironment } from "../provider-codex/app-server/adapters/hosted-dependency-parent-recipe";

/** Trusted worker composition retains the original stored-plan resolution and
 * foreground launch guards. Provider code consumes only this read-only port. */
export const hostedDependencyParentRecipeReader: DependencyParentRecipeReader = Object.freeze({
  readStoredLaunch(launch: HostedInventoryLaunch, job: string, workspace: string): HostedInventoryLaunch {
    const args = launch.args;
    const plan = resolveStoredProjectStartPlan(args[4]!, workspace);
    if (plan.jobRoot !== job || plan.workspace !== workspace || launch.command !== process.execPath ||
        plan.launch.cliCommand[0] !== launch.command || plan.launch.cliCommand[1] !== args[0]) fail();
    const argv = buildCodexGoalForegroundArgv(plan.launch);
    if (argv[0] !== launch.command || argv[1] !== args[0]) fail();
    return Object.freeze({ command: launch.command, args: Object.freeze(argv.slice(1)), cwd: launch.cwd });
  },
  readProjectAccessScope: parseCodexGoalProjectAccessScopeJson,
  readOriginalUsableParentRoots: readHostedOriginalUsableParentRoots,
});
export function readHostedDependencyParentRecipe(launch: HostedInventoryLaunch, job: string, workspace: string): HostedInventoryLaunch {
  return readProviderRecipe(launch, job, workspace, hostedDependencyParentRecipeReader);
}
export function assertHostedDependencyParentRecipe(args: readonly string[], job: string, workspace: string): void {
  assertProviderRecipe(args, job, workspace, hostedDependencyParentRecipeReader);
}
function fail(): never { throw new Error("hosted_dependency_parent_recipe_unsupported"); }
