import {
  AccessBoundary,
  NetworkAccessMode,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexProviderApiAndNpmRegistryEgressProfileId,
  codexProviderApiEgressProfileId,
  type CodexProviderEgressProfileId,
} from "@vioxen/subscription-runtime/provider-codex";

const projectControlBrokeredStartEnvVar =
  "SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START";

export type CodexGoalTaskEgressProfileInput = {
  readonly accessBoundary?: AccessBoundary;
  readonly networkAccess?: NetworkAccessMode.Disabled | NetworkAccessMode.Restricted;
  readonly projectAccessScope?: ProjectAccessScope;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
};

/** Keeps ProjectScopedControl policy selection outside provider adapters. */
export function codexGoalTaskEgressProfile(
  input: CodexGoalTaskEgressProfileInput,
): CodexProviderEgressProfileId {
  if (
    input.sourceEnv?.[projectControlBrokeredStartEnvVar] === "1" &&
    input.accessBoundary === AccessBoundary.IsolatedWorkspaceWrite &&
    input.networkAccess === NetworkAccessMode.Restricted &&
    input.projectAccessScope !== undefined
  ) {
    return codexProviderApiAndNpmRegistryEgressProfileId;
  }
  return codexProviderApiEgressProfileId;
}
