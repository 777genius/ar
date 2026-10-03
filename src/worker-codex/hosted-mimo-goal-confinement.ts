import { CodexModelBackend, codexMimoApiKeyEnvVarDefault, codexMimoDefaultModel } from "@vioxen/subscription-runtime/provider-codex";
import type { CodexGoalRunConfig } from "./codex-goal-runner";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";

/** Validate effective goal inputs before either worker admission reader runs. */
export function assertHostedMimoGoalConfinement(config: CodexGoalRunConfig): void {
  const sourceEnv = config.sourceEnv ?? process.env;
  if (sourceEnv.SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== "hosted-codex-job" ||
      config.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan) return;
  if ((config.executionEngine ?? "app-server-goal") !== "app-server-goal" ||
      (config.model ?? codexMimoDefaultModel) !== codexMimoDefaultModel ||
      config.providerSandboxMode === "danger-full-access" ||
      config.accessBoundary === AccessBoundary.DangerFullAccess ||
      config.allowDangerFullAccess === true ||
      config.accounts.length !== 1 || config.accounts[0]?.name !== "account-q" ||
      config.accounts[0].authJsonPath !== undefined ||
      (config.accounts[0].envVarName ?? codexMimoApiKeyEnvVarDefault) !== codexMimoApiKeyEnvVarDefault ||
      (config.mimoAccounts ?? []).some(slot => slot.name !== "account-q" ||
        (slot.envVarName ?? codexMimoApiKeyEnvVarDefault) !== codexMimoApiKeyEnvVarDefault) ||
      (config.mimoAccounts?.length ?? 0) > 1 ||
      sourceEnv.SUBSCRIPTION_RUNTIME_MIMO_KEY_FILE !== undefined ||
      sourceEnv[codexMimoApiKeyEnvVarDefault] !== undefined) {
    throw new Error("hosted_mimo_effective_confinement_required");
  }
}
