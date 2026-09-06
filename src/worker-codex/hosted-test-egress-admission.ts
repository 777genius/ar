import { createHash } from "node:crypto";
import {
  codexProviderApiEgressPolicy,
  codexProviderEgressPolicy,
  type CodexProviderEgressPolicy,
  type CodexProviderEgressProfileId,
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
  // Non-root callers cannot receive this host-root authorization. Decide before
  // touching its inaccessible parents; eligible callers still fail closed on errors.
  if (process.platform !== "linux" || process.getuid?.() !== 0) return codexProviderApiEgressPolicy();
  let grant;
  try {
    grant = await readHostedTestEgressGrantFile(hostedTestEgressGrantRoot, input);
  } catch {
    throw new Error("hosted_test_egress_admission_invalid");
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
