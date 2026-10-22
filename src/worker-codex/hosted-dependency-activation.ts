import { withHostedActivationFence as withProviderFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedDependencyParentRecipeReader } from "./hosted-dependency-parent-recipe";
export function withHostedActivationFence<T>(action: (fence: HostedActivationFence) => T): T {
  return withProviderFence(action, hostedDependencyParentRecipeReader);
}
