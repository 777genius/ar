import {
  CodexModelBackend,
  codexMimoTokenPlanEgressPolicy,
  codexProviderEgressPolicy,
  egressBoundCodexProcessFactory,
} from "@vioxen/subscription-runtime/provider-codex";
import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import { admitHostedTestEgress } from "./hosted-test-egress-admission";
import { codexGoalNativeEgressConfig } from "./codex-goal-native-egress";
import { admitHostedReadonlyInputs } from "./hosted-readonly-admission";
import { assertHostedMimoGoalConfinement } from "./hosted-mimo-goal-confinement";

/** Host authority is read here, never supplied by MCP/profile arguments.
 * Project controllers publish their admitted state location before this possible
 * allocation boundary, then recheck admission before account/session effects. */
export async function admitHostedControllerLaunch(launch: CodexGoalLaunchInput) {
  const config = launch.config;
  assertHostedMimoGoalConfinement(config);
  const identity = {
    jobId: config.jobId ?? config.taskId,
    jobRootDir: config.jobRootDir,
    workspacePath: config.workspacePath,
    ...(config.executionEngine ? { executionEngine: config.executionEngine } : {}),
    sourceEnv: config.sourceEnv ?? process.env,
  };
  const admitted = await admitHostedTestEgress({ ...identity,
    ...codexGoalNativeEgressConfig(config),
    ...(config.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan
      ? { modelBackend: CodexModelBackend.XiaomiMimoTokenPlan } : {}) });
  const policy = config.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan
    ? codexMimoTokenPlanEgressPolicy()
    : codexProviderEgressPolicy(admitted.profileId);
  if (policy.profileId !== admitted.profileId) throw new Error("hosted_mimo_admission_invalid");
  const factory = admitHostedReadonlyInputs({ ...identity, providerEgressPolicy: policy });
  return { policy, processFactory: egressBoundCodexProcessFactory(policy, factory) };
}
