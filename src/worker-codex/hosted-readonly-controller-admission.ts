import { codexProviderEgressPolicy, egressBoundCodexProcessFactory } from "@vioxen/subscription-runtime/provider-codex";
import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import { admitHostedTestEgress } from "./hosted-test-egress-admission";
import { admitHostedReadonlyInputs } from "./hosted-readonly-admission";

/** Host authority is read here, never supplied by MCP/profile arguments. Call
 * before immutable state binding, and again before account/session effects. */
export async function admitHostedControllerLaunch(launch: CodexGoalLaunchInput) {
  const config = launch.config;
  const identity = {
    jobId: config.jobId ?? config.taskId,
    jobRootDir: config.jobRootDir,
    workspacePath: config.workspacePath,
    ...(config.executionEngine ? { executionEngine: config.executionEngine } : {}),
    sourceEnv: config.sourceEnv ?? process.env,
  };
  const policy = codexProviderEgressPolicy((await admitHostedTestEgress(identity)).profileId);
  const factory = admitHostedReadonlyInputs({ ...identity, providerEgressPolicy: policy });
  return { policy, processFactory: egressBoundCodexProcessFactory(policy, factory) };
}
