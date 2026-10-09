import { createHash } from "node:crypto";
import { assertReadonlyEnrollmentProfile } from "./hosted-readonly-custody";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { admitHostedOrdinaryIdentity, isHostedOrdinaryRuntime } from "./hosted-installation-activation";
import {
  codexProviderApiEgressPolicy,
  codexHostedDefaultEgressPolicy,
  codexProviderEgressPolicy,
  codexMimoTokenPlanEgressPolicy,
  CodexModelBackend,
  type CodexProviderEgressPolicy,
  CodexProviderEgressProfileId,
  requiresHostedProcessAdmission,
} from "@vioxen/subscription-runtime/provider-codex";
import {
  assertHostedTestEgressOperator,
  hostedTestEgressGrantRoot,
  readHostedTestEgressGrantFile,
} from "./hosted-test-egress-files";
import type { CodexWorkerExecutionEngine } from "./file-backend-codex-runtime-factory";
import type { HostedTestEgressIdentity } from "./hosted-test-egress-contract";
import { admitResearchRuntime, assertResearchRuntimeEngine } from "./research-launch-admission";
import { assertHostedBaselineIdentity, isHostedContainment } from "../provider-codex/app-server/adapters/hosted-host-policy";

export async function admitHostedTestEgress(
  input: HostedTestEgressIdentity & {
    readonly executionEngine?: CodexWorkerExecutionEngine;
    readonly modelBackend?: CodexModelBackend;
    readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  },
): Promise<CodexProviderEgressPolicy> {
  const mimo = input.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan;
  const research = admitResearchRuntime(input);
  if (research) {
    assertResearchRuntimeEngine(input);
    return codexProviderEgressPolicy(research);
  }
  const contained = isHostedContainment(input.sourceEnv ?? process.env);
  if (contained && mimo) throw new Error("hosted_mimo_activation_closed");
  // Namespace/local non-root callers never read host-private authority or gain
  // TEST egress from a marker. Actual ordinary-runtime membership still denies
  // a wrong principal before entering its selected route.
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    if (isHostedOrdinaryRuntime()) {
      const profile = admitHostedOrdinaryIdentity(input);
      if (mimo || profile === CodexProviderEgressProfileId.MimoTokenPlan) {
        if (!mimo || profile !== CodexProviderEgressProfileId.MimoTokenPlan ||
            input.executionEngine !== "app-server-goal" ||
            input.sourceEnv?.SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== "hosted-codex-job") {
          throw new Error("hosted_mimo_admission_invalid");
        }
        throw new Error("hosted_mimo_activation_closed");
      }
      return codexProviderEgressPolicy(profile);
    }
    return mimo ? codexMimoTokenPlanEgressPolicy() : codexProviderApiEgressPolicy();
  }
  const hosted = requiresHostedProcessAdmission(input.sourceEnv ?? process.env);
  if (!hosted) {
    assertHostedBaselineIdentity(input.jobId);
    if (contained && !["app-server", "app-server-goal"].includes(input.executionEngine ?? "app-server-goal")) {
      throw new Error("hosted_permission_profiles_engine_unsupported");
    }
    return mimo ? codexMimoTokenPlanEgressPolicy() :
      contained ? codexHostedDefaultEgressPolicy() : codexProviderApiEgressPolicy();
  }
  if (hosted && isHostedOrdinaryRuntime()) {
    const profile = admitHostedOrdinaryIdentity(input);
    if (mimo || profile === CodexProviderEgressProfileId.MimoTokenPlan) {
      if (!mimo || profile !== CodexProviderEgressProfileId.MimoTokenPlan ||
          input.executionEngine !== "app-server-goal" ||
          input.sourceEnv?.SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== "hosted-codex-job") {
        throw new Error("hosted_mimo_admission_invalid");
      }
      throw new Error("hosted_mimo_activation_closed");
    }
    if ((profile === CodexProviderEgressProfileId.TestNpmQualification ||
         profile === CodexProviderEgressProfileId.PublicResearchV1) &&
        ((input.executionEngine ?? "app-server-goal") !== "app-server-goal" ||
          input.sourceEnv?.SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== "hosted-codex-job")) throw new Error("hosted_test_egress_engine_unsupported");
    if (profile === CodexProviderEgressProfileId.FullInternetV1 &&
        !["app-server", "app-server-goal"].includes(input.executionEngine ?? "app-server-goal")) {
      throw new Error("hosted_permission_profiles_engine_unsupported");
    }
    return codexProviderEgressPolicy(profile);
  }
  let grant;
  try {
    grant = await readHostedTestEgressGrantFile(hostedTestEgressGrantRoot, input);
  } catch {
    throw new Error("hosted_test_egress_admission_invalid");
  }
  assertReadonlyEnrollmentProfile(input.jobId, grant?.profileId === CodexProviderEgressProfileId.TestManagedQualification);
  // Research is production authority tied to the installed ordinary origin,
  // not a standalone TEST grant or a namespace/environment classification.
  if (grant?.profileId === CodexProviderEgressProfileId.PublicResearchV1) {
    throw new Error("hosted_research_ordinary_admission_required");
  }
  if (mimo) {
    if (hosted || grant) {
      if (grant?.profileId !== CodexProviderEgressProfileId.MimoTokenPlan ||
          input.executionEngine !== "app-server-goal" ||
          input.sourceEnv?.SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== "hosted-codex-job") {
        throw new Error("hosted_mimo_admission_invalid");
      }
      throw new Error("hosted_mimo_activation_closed");
    }
    return codexMimoTokenPlanEgressPolicy();
  }
  if (grant?.profileId === CodexProviderEgressProfileId.MimoTokenPlan) throw new Error("hosted_mimo_admission_invalid");
  if (hosted) {
    new HostedReadonlySupervisorHost().assertManagedAdmission(input, grant?.profileId ?? CodexProviderEgressProfileId.ProviderApi);
  }
  if (!grant) return codexProviderApiEgressPolicy();
  await assertHostedTestEgressOperator();
  if ((input.executionEngine ?? "app-server-goal") !== "app-server-goal" ||
      input.sourceEnv?.SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== "hosted-codex-job") {
    throw new Error("hosted_test_egress_engine_unsupported");
  }
  return codexProviderEgressPolicy(grant.profileId);
}

/** Safe observability only; these fields never participate in admission. */
export function hostedTestEgressEvidence(
  identity: Omit<HostedTestEgressIdentity, "jobId"> & { readonly jobId?: string; readonly taskId: string },
  policy: CodexProviderEgressPolicy,
): { providerEgressProfileId: CodexProviderEgressProfileId; providerEgressAdmissionDigest: string } {
  return {
    providerEgressProfileId: policy.profileId,
    providerEgressAdmissionDigest: createHash("sha256").update(JSON.stringify([
      identity.jobId ?? identity.taskId, identity.jobRootDir, identity.workspacePath, policy.profileId,
    ])).digest("hex"),
  };
}
