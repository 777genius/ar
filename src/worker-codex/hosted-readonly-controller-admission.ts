import { JobStorageCapabilityUnavailableError, JobStorageUnavailableCapability } from "@vioxen/subscription-runtime/worker-core";
import { recordRawGoalStateOrigin } from "./application/project-control/codex-goal-controller-state-location";
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
  return admitLaunch(launch, false);
}

/** Raw routes share admission, but must settle creation history before allocation. */
export async function admitHostedRawGoalLaunch(launch: CodexGoalLaunchInput) {
  return admitLaunch(launch, true);
}

async function admitLaunch(launch: CodexGoalLaunchInput, raw: boolean) {
  const config = launch.config;
  // This transport has no admitted storage lease. Its raw entry cannot publish
  // history for a NEW layout before the runner's native lifetime admission.
  if (raw && config.storage) throw new JobStorageCapabilityUnavailableError(JobStorageUnavailableCapability.NativeLifetime);
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
  if (raw) recordRawGoalStateOrigin(config.jobRootDir);
  const factory = admitHostedReadonlyInputs({ ...identity, providerEgressPolicy: policy });
  return { policy, processFactory: egressBoundCodexProcessFactory(policy, factory) };
}
