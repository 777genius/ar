import { assertHostedDependencyQualifiedInventory as assertProviderInventory, readHostedDependencyAttempt as readProviderAttempt } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { hostedDependencyParentRecipeReader } from "./hosted-dependency-parent-recipe";
export * from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
export function assertHostedDependencyQualifiedInventory(): void {
  assertProviderInventory(hostedDependencyParentRecipeReader);
}
export function readHostedDependencyAttempt(...args: Parameters<typeof readProviderAttempt>) {
  return readProviderAttempt(args[0], args[1], args[2], args[3], hostedDependencyParentRecipeReader);
}
