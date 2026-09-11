import { createHash } from "node:crypto";
import { assertReadonlyEnrollmentProfile } from "./hosted-readonly-custody";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { admitHostedOrdinaryIdentity, isHostedOrdinaryRuntime } from "./hosted-installation-activation";
import {
  codexProviderApiEgressPolicy,
  codexProviderEgressPolicy,
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

export async function admitHostedTestEgress(
  input: HostedTestEgressIdentity & {
    readonly executionEngine?: CodexWorkerExecutionEngine;
    readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  },
): Promise<CodexProviderEgressPolicy> {
  // Namespace/local non-root callers never read host-private authority or gain
  // TEST egress from a marker. Actual ordinary-runtime membership still denies
  // a wrong principal before entering its selected route.
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    if (isHostedOrdinaryRuntime()) admitHostedOrdinaryIdentity(input);
    return codexProviderApiEgressPolicy();
  }
  const hosted = requiresHostedProcessAdmission(input.sourceEnv ?? process.env);
  if (hosted && isHostedOrdinaryRuntime()) {
    const profile = admitHostedOrdinaryIdentity(input);
    if (profile === CodexProviderEgressProfileId.TestNpmQualification &&
        ((input.executionEngine ?? "app-server-goal") !== "app-server-goal" ||
          input.sourceEnv?.SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== "hosted-codex-job")) throw new Error("hosted_test_egress_engine_unsupported");
    return codexProviderEgressPolicy(profile);
  }
  let grant;
  try {
    grant = await readHostedTestEgressGrantFile(hostedTestEgressGrantRoot, input);
  } catch {
    throw new Error("hosted_test_egress_admission_invalid");
  }
  assertReadonlyEnrollmentProfile(input.jobId, grant?.profileId === CodexProviderEgressProfileId.TestManagedQualification);
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
