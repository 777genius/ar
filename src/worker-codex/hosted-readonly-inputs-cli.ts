#!/usr/bin/env node
import { createHash } from "node:crypto";
import { join } from "node:path";
import { HostedCustodyPhase } from "@vioxen/subscription-runtime/worker-core";
import { HostedInstallationActivationStore } from "./hosted-installation-activation";
import { HostedReadonlyEpochStore } from "./hosted-readonly-epoch-store";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { assertHostedTestEgressDirectory, canonicalHostedTestIdentity } from "./hosted-test-egress-files";
import { assertReadonlyHostOperator, decodePrivateJson, readReadonlyManagedGrant,
  readReadonlyReview, readonlyIdentityName } from "./hosted-readonly-authority";
import { hostedReadonlyPolicyRoot, parseHostedReadonlyPolicy, readHostedPrivateBytes, type HostedReadonlyPolicy } from "./hosted-readonly-inputs";
import { createReadonlyPrivateRecord, inspectReadonlyInputs, readonlyCustodyRoot,
  readonlyCustodySnapshot, readonlyRevokedRoot, readonlyServiceRoot, withReadonlyCustodyLock } from "./hosted-readonly-custody";

const [operation, operand, ...extra] = process.argv.slice(2);
async function runReadonlyOperator(): Promise<void> {
  assertReadonlyHostOperator();
  if (["install-host", "install-managed-host", "enroll-ordinary", "resume-ordinary", "enter-exclusive", "leave-exclusive", "finish-exclusive", "finish-closed"].includes(operation ?? "")) {
    if (extra.length || (operation === "enroll-ordinary" ? !operand : operand !== undefined)) throw new Error();
    for (const root of ["/var/lib/subscription-runtime-host-policy", "/var/lib/subscription-runtime-host-policy/ordinary-origins",
      "/var/lib/subscription-runtime-host-policy/ordinary-starts", "/var/lib/subscription-runtime-host-policy/ordinary-completed", readonlyCustodyRoot, readonlyRevokedRoot, hostedReadonlyPolicyRoot]) {
      await assertHostedTestEgressDirectory(root, true);
    }
    const store = new HostedInstallationActivationStore();
    if (operation === "enter-exclusive" || operation === "leave-exclusive") {
      if (operation === "enter-exclusive") store.enterExclusive(); else store.leaveExclusive();
      process.stdout.write(JSON.stringify({ operation, phase: store.read().phase, reconciliationRequired: true }) + "\n");
      return;
    }
    const result = operation === "install-managed-host" ? store.installManaged() : operation === "finish-exclusive" ? store.finishExclusive() : operation === "finish-closed" ? store.finishClosed() : operation === "install-host" ? store.install() : operation === "resume-ordinary" ? store.resumeOrdinary() : store.enrollOrdinary(operand!);
    process.stdout.write(JSON.stringify({ operation, ...( "phase" in result ? { phase: result.phase, generation: result.generation } : { jobId: result.jobId }) }) + "\n");
    return;
  }
  if (extra.length || !operand || !["enroll", "admit", "recover", "revoke"].includes(operation ?? "")) throw new Error();
  if ((operation === "revoke" || operation === "recover") && (operand.length > 256 || /[\u0000-\u001f\u007f]/.test(operand))) throw new Error();
  const epochStore = new HostedReadonlyEpochStore();
  if (operation === "recover") {
    // No restoration from backup or stale-lock removal. The application first
    // persists CLOSED, rotates generation, then obtains fresh terminal/material
    // evidence. An ambiguous creator remains held for independent reconciliation.
    new HostedInstallationActivationStore().withExclusivePreparation(fence => {
      const identity = epochStore.enrolledIdentity(operand);
      new HostedReadonlySupervisorHost().recoverWithHeldFence(fence, identity);
    }, true);
    process.stdout.write(JSON.stringify({ operation, jobId: operand,
      generation: epochStore.readEpoch().generation, phase: HostedCustodyPhase.Ready }) + "\n");
    return;
  }
  for (const root of [hostedReadonlyPolicyRoot, readonlyCustodyRoot, readonlyRevokedRoot, readonlyServiceRoot]) {
    await assertHostedTestEgressDirectory(root, true);
  }
  if (operation === "admit" || operation === "enroll") {
    const input = readHostedPrivateBytes(operand, 64 * 1024);
    if (!input) throw new Error();
    const policy = parseHostedReadonlyPolicy(decodePrivateJson(input));
    await canonicalHostedTestIdentity(policy);
    await assertHostedTestEgressDirectory(join(readonlyServiceRoot, readonlyIdentityName(policy.jobId)), true);
    const receipt = new HostedInstallationActivationStore().withExclusivePreparation(fence => {
      if (operation === "enroll") {
        const { expected } = reviewedMaterial(policy);
        epochStore.enrollWithHeldFence(fence, expected, new HostedReadonlySupervisorHost().session());
      }
      return epochStore.withHeldFence(fence, () => withReadonlyCustodyLock(policy.jobId, () => {
        const name = readonlyIdentityName(policy.jobId);
        if (readHostedPrivateBytes(join(readonlyRevokedRoot, name), 4096)) throw new Error("hosted_readonly_revoked");
        const { review, bytes, expected } = reviewedMaterial(policy);
        const epoch = epochStore.readEpoch();
        if (epoch.revoked || Object.keys(expected).some(key => expected[key as keyof typeof expected] !==
          epoch.identity[key as keyof typeof expected])) throw new Error("hosted_custody_enrollment_mismatch");
        // Lease publication precedes policy publication. Partial enrollment remains
        // held, never becomes an ordinary job, and can only replay identical bytes.
        createReadonlyPrivateRecord(join(readonlyCustodyRoot, name), Buffer.from(JSON.stringify({
          schemaVersion: 1, jobId: policy.jobId,
          policySha256: hash(bytes), reviewSha256: hash(review.reviewBytes),
          stageSha256: hash(review.stageBytes), snapshot: readonlyCustodySnapshot(policy),
        }) + "\n"));
        createReadonlyPrivateRecord(join(hostedReadonlyPolicyRoot, name), bytes);
        return { jobId: policy.jobId, policySha256: hash(bytes), reviewReference: review.reviewReference, custodyReference: review.custodyReference };
      }));
    });
    process.stdout.write(JSON.stringify({ operation, ...receipt, custodyLeaseRetained: true }) + "\n");
  } else {
    // Durable tombstones prevent silent de-enrollment even if a policy and grant
    // are subsequently deleted. Keep custody and policy until service recovery
    // positively establishes terminal descendants; do not trust proxy exit.
    const reservedServices = new HostedInstallationActivationStore().revokeManaged(operand);
    process.stdout.write(JSON.stringify({ operation, jobId: operand, revoked: true,
      custodyLeaseRetained: true, reservedServices, serviceReconciliationRequired: true }) + "\n");
  }
}
try { await runReadonlyOperator(); }
catch {
  process.stderr.write("hosted_readonly_operator_action_failed\n");
  process.exitCode = 1;
}
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function reviewedMaterial(policy: HostedReadonlyPolicy) {
  const grantBytes = readReadonlyManagedGrant(policy), review = readReadonlyReview(policy);
  inspectReadonlyInputs(policy, review.corepackShim);
  const bytes = Buffer.from(JSON.stringify(policy) + "\n");
  const expected = { jobId: policy.jobId, jobRootDir: policy.jobRootDir, workspacePath: policy.workspacePath,
    runtimeSha: policy.runtimeSha, runtimeManifestSha256: policy.runtimeManifestSha256,
    issuerDeploymentDigest: policy.issuerDeploymentDigest, policySha256: hash(bytes),
    reviewSha256: hash(review.reviewBytes), stageSha256: hash(review.stageBytes), grantSha256: hash(grantBytes) };
  return { review, bytes, expected };
}
