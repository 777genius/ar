import { createHash } from "node:crypto";
import { join } from "node:path";
import { HostedCustodyLaunchKind, HostedCustodySupervisor } from "@vioxen/subscription-runtime/worker-core";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { admitHostedOrdinaryIdentity, isHostedOrdinaryRuntime } from "./hosted-installation-activation";
import { admittedReadonlyCodexProcessFactory, CodexProviderEgressProfileId, requiresHostedProcessAdmission,
  type CodexAppServerProcessFactory, type CodexProviderEgressPolicy } from "@vioxen/subscription-runtime/provider-codex";
import type { HostedTestEgressIdentity } from "./hosted-test-egress-contract";
import { assertReadonlyHostOperator, decodePrivateJson, readReadonlyManagedGrant,
  readReadonlyReview, readonlyIdentityName } from "./hosted-readonly-authority";
import { readHostedPrivateBytes, readHostedReadonlyPolicy } from "./hosted-readonly-inputs";
import { readonlyCustodyRoot, readonlyCustodySnapshot, readonlyRevokedRoot,
  createReadonlyPrivateRecord, readonlyServiceRoot, withReadonlyCustodyLock } from "./hosted-readonly-custody";

import type { CodexWorkerExecutionEngine } from "./file-backend-codex-runtime-factory";

const guardedFactories = new WeakMap<CodexAppServerProcessFactory, string>();

export function assertReadonlyAdmittedFactory(factory: CodexAppServerProcessFactory | undefined, workspacePath: string | undefined): void {
  if (!factory || guardedFactories.get(factory) !== workspacePath || workspacePath === undefined) throw new Error("hosted_readonly_admitted_factory_required");
}

/** One trusted production path. No injectable process implementation or authority
 * callback: only the real node adapter runs after fresh synchronous checks.
 */
export function admitHostedReadonlyInputs(input: HostedTestEgressIdentity & {
  readonly providerEgressPolicy: CodexProviderEgressPolicy;
  readonly executionEngine?: CodexWorkerExecutionEngine;
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
}): CodexAppServerProcessFactory | undefined {
  const managed = input.providerEgressPolicy.profileId === CodexProviderEgressProfileId.TestManagedQualification;
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    if (managed || isHostedOrdinaryRuntime()) throw new Error("hosted_readonly_host_operator_required");
    return undefined;
  }
  const hosted = requiresHostedProcessAdmission(input.sourceEnv);
  if (hosted && isHostedOrdinaryRuntime()) {
    const profile = admitHostedOrdinaryIdentity(input);
    if (managed || input.providerEgressPolicy.profileId !== profile ||
        (profile === CodexProviderEgressProfileId.TestNpmQualification &&
          ((input.executionEngine ?? "app-server-goal") !== "app-server-goal" ||
            input.sourceEnv.SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== "hosted-codex-job"))) throw new Error("hosted_readonly_engine_unsupported");
    return undefined; // Genuine default factory performs its own fresh fenced admission.
  }
  const name = readonlyIdentityName(input.jobId);
  const initial = readHostedReadonlyPolicy(input.jobId);
  const leaseBytes = readHostedPrivateBytes(join(readonlyCustodyRoot, name), 4096);
  if (readHostedPrivateBytes(join(readonlyRevokedRoot, name), 4096)) throw new Error("hosted_readonly_revoked");
  if (!managed) {
    if (initial || leaseBytes) throw new Error("hosted_readonly_managed_grant_required");
    if (hosted) throw new Error("hosted_activation_authority_required");
    return undefined;
  }
  if (!initial || !leaseBytes) throw new Error("hosted_readonly_policy_required");
  assertReadonlyHostOperator();
  if ((input.executionEngine ?? "app-server-goal") !== "app-server-goal" ||
      input.sourceEnv.SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== "hosted-codex-job") {
    throw new Error("hosted_readonly_engine_unsupported");
  }
  if (initial.policy.jobId !== input.jobId || initial.policy.jobRootDir !== input.jobRootDir ||
      initial.policy.workspacePath !== input.workspacePath) throw new Error("hosted_readonly_policy_binding_mismatch");
  const identity = Object.freeze({ jobId: input.jobId, jobRootDir: input.jobRootDir, workspacePath: input.workspacePath });
  const grantBytes = readReadonlyManagedGrant(identity);
  const review = readReadonlyReview(initial.policy);
  const snapshot = readonlyCustodySnapshot(initial.policy);
  const expectedLease = JSON.stringify({ schemaVersion: 1, jobId: identity.jobId,
    policySha256: hash(initial.bytes), reviewSha256: hash(review.reviewBytes),
    stageSha256: hash(review.stageBytes), snapshot });
  if (JSON.stringify(decodePrivateJson(leaseBytes)) !== expectedLease) throw new Error("hosted_readonly_custody_lease_invalid");
  const host = new HostedReadonlySupervisorHost();
  const admittedEpoch = host.assertManagedAdmission(identity, input.providerEgressPolicy.profileId);
  const supervisor = new HostedCustodySupervisor(host);
  const spawn = admittedReadonlyCodexProcessFactory({
    jobId: identity.jobId,
    workspacePath: identity.workspacePath,
    readonlyPaths: initial.policy.readonlyPaths,
  }, (unit, submit) => {
    const startId = unit.slice("subscription-runtime-hosted-".length, -".service".length);
    const reservation = { startId, unit, creatorId: startId };
    return supervisor.start(HostedCustodyLaunchKind.ManagedProvider, admittedEpoch.identity, admittedEpoch.generation, reservation, () => {
      // Reserve before starting systemd-run. An absent unit can still be pending;
      // this durable record is never removed merely because its proxy exited.
      createReadonlyPrivateRecord(join(readonlyServiceRoot, name, unit + ".json"),
        Buffer.from(JSON.stringify({ schemaVersion: 1, jobId: identity.jobId, unit }) + "\n"));
      const child = submit();
      child.on("exit", (code, signal) => {
        // Normal --wait completion, including acknowledged service termination.
        // A signaled proxy or ambiguous CLI failure (e.g. exit 1) is not proof.
        if (signal === null && code === 0) {
          try { host.recordWaitCompletion(reservation, code); }
          catch { /* Retained reservation prevents another spawn on ambiguity. */ }
        }
      });
      return child;
    });
  });
  const factory: CodexAppServerProcessFactory = launch => withReadonlyCustodyLock(identity.jobId, () => {
    assertReadonlyHostOperator();
    const fresh = readHostedReadonlyPolicy(identity.jobId);
    if (readHostedPrivateBytes(join(readonlyRevokedRoot, name), 4096) || !fresh ||
        !fresh.bytes.equals(initial.bytes) ||
        !readHostedPrivateBytes(join(readonlyCustodyRoot, name), 4096)?.equals(leaseBytes) ||
        !readReadonlyManagedGrant(identity).equals(grantBytes)) throw new Error("hosted_readonly_admission_changed");
    const currentReview = readReadonlyReview(fresh.policy);
    if (!currentReview.reviewBytes.equals(review.reviewBytes) || !currentReview.stageBytes.equals(review.stageBytes) ||
        readonlyCustodySnapshot(fresh.policy) !== snapshot) throw new Error("hosted_readonly_custody_changed");
    return spawn(launch);
  });
  guardedFactories.set(factory, identity.workspacePath);
  return factory;
}
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
