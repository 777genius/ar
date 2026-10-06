/** Inactive nearest native assertions. Only the installed ORIGINAL issuer
 * writes authority. Caller fixture selection never grants profile/account/use.
 * Real isolated readonly policy-directory faults must supply the two partial
 * scenarios; this module creates no mount, binding, grant or prepared relation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { HostedActivationPhase, DependencyReceiptState } from "../../dist/worker-core/index.js";
import { CodexProviderEgressProfileId } from "../../dist/provider-codex/index.js";
import { withHostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import { HostedDependencyReferenceKind, readHostedDependencyBinding, hostedDependencyBindingName }
  from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { writeHostedTestEgressGrant, hostedTestEgressGrantRoot, hostedTestEgressGrantName }
  from "../../dist/worker-codex/hosted-test-egress-files.js";
import { readHostedReadonlyHostInventory } from "../../dist/worker-codex/hosted-readonly-host-kernel.js";
import { HostedInstallationActivationStore, readHostedInstallationActivation, readHostedOrdinaryBirth }
  from "../../dist/worker-codex/hosted-installation-activation.js";
import { pinReferenceFile, referencePath } from "../../dist/worker-codex/hosted-dependency-legacy-reference-records.js";
import { assertHostedLegacyReferenceReservationPrepared } from "../../dist/worker-codex/hosted-dependency-legacy-reference.js";
import { readHostedDependencyEstablishedReceipt } from "../../dist/worker-codex/hosted-dependency-receipts.js";

export enum ReferenceEnrollmentPublication { Complete = "complete", BindingOnly = "binding_only", BindingAndAbsence = "binding_and_absence" }
const fixedRoot = "/var/lib/subscription-runtime-host-policy";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function absent(path: string): void {
  assert.throws(() => lstatSync(path), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
}
function selected(jobId: string) {
  const rows = readHostedReadonlyHostInventory().ordinaryCreators.filter(row => row.jobId === jobId);
  assert.equal(rows.length, 1); return rows[0]!;
}
function retained(jobId: string) {
  const binding = readHostedDependencyBinding(jobId); assert(binding && binding.version === 3);
  return { binding, bytes: pinReferenceFile(fixedRoot + "/" + hostedDependencyBindingName(jobId)).bytes };
}
/** Call ONCE in each newly registered CLOSED comparison fixture, never in the
 * completed-cold/hot candidate. Prefix expectations observe real failed writes
 * caused by that fixture's fixed readonly policy directory, not fabricated JSON. */
export async function enrollReferenceAndAssert(candidateJobId: string, referenceJobId: string, publication: ReferenceEnrollmentPublication): Promise<void> {
  assert(Object.values(ReferenceEnrollmentPublication).includes(publication));
  assert.equal(readHostedInstallationActivation().activation.phase, HostedActivationPhase.Closed);
  const candidate = readHostedDependencyBinding(candidateJobId); assert(candidate && candidate.version === 2);
  const candidateBytes = pinReferenceFile(fixedRoot + "/" + hostedDependencyBindingName(candidateJobId)).bytes;
  const creator = selected(referenceJobId), stat = lstatSync(creator.workspacePath, { bigint: true });
  const grant = { schemaVersion: 1 as const, jobId: creator.jobId, jobRootDir: creator.jobRootDir,
    workspacePath: creator.workspacePath, profileId: CodexProviderEgressProfileId.TestNpmQualification };
  const target = hostedTestEgressGrantRoot + "/" + hostedTestEgressGrantName(referenceJobId);
  const absence = fixedRoot + `/dependency-fresh-absence/${stat.dev}-${stat.ino}.json`;
  absent(fixedRoot + "/" + hostedDependencyBindingName(referenceJobId)); absent(target); absent(absence);
  const issue = () => writeHostedTestEgressGrant(grant, undefined, { candidateJobId, kind: HostedDependencyReferenceKind.LegacyLocalNoLifecycleV1 });
  if (publication === ReferenceEnrollmentPublication.Complete) await issue(); else await assert.rejects(issue);
  const actual = retained(referenceJobId), binding = actual.binding;
  assert.equal(binding.reference.kind, HostedDependencyReferenceKind.LegacyLocalNoLifecycleV1);
  assert.match(binding.reference.operationId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(Object.keys(binding).sort(), ["grantDigest","installationId","jobId","jobRootDir","reference","runtimeSha","version","workspace"]);
  assert.equal(binding.installationId, candidate.installationId); assert.equal(binding.runtimeSha, candidate.runtimeSha);
  assert.deepEqual(binding.workspace, { canonicalPath: creator.workspacePath, dev: String(stat.dev), ino: String(stat.ino) });
  assert.notEqual(binding.workspace.canonicalPath, candidate.workspace.canonicalPath);
  assert(binding.workspace.dev !== candidate.workspace.dev || binding.workspace.ino !== candidate.workspace.ino);
  assert.equal(binding.grantDigest, hash(encode(grant)));
  if (publication === ReferenceEnrollmentPublication.BindingOnly) absent(absence);
  else assert(pinReferenceFile(absence).bytes.equals(encode({ version: 1, workspace: binding.workspace, coverageRevision: hash(actual.bytes) })));
  if (publication === ReferenceEnrollmentPublication.Complete) assert(pinReferenceFile(target, 4096).bytes.equals(encode(grant))); else absent(target);
  for (const suffix of ["reference","reference-start","reference-entry","reference-result","reference-release","comparison"] as const)
    absent(referencePath(binding.reference.operationId, suffix));
  await assert.rejects(issue, /hosted_dependency_reference_fresh_closed_enrollment_required/);
  assert(retained(referenceJobId).bytes.equals(actual.bytes));
  assert(pinReferenceFile(fixedRoot + "/" + hostedDependencyBindingName(candidateJobId)).bytes.equals(candidateBytes));
  withHostedActivationFence(fence => assert.throws(() => assertHostedLegacyReferenceReservationPrepared(fence, binding), /dependency_legacy_reference_unresolved/));
}
/** After ORIGINAL birth enrollment/resume on the same real partial fixture,
 * generic reservation and comparison both refuse without any new start/owner
 * or reference operation. No failure is accepted merely because birth is absent. */
export async function assertPartialReferenceConsumersRefuse(candidateJobId: string, referenceJobId: string): Promise<void> {
  const before = readHostedInstallationActivation(); assert.equal(before.activation.phase, HostedActivationPhase.Ordinary);
  readHostedOrdinaryBirth(candidateJobId); readHostedOrdinaryBirth(referenceJobId);
  const actual = retained(referenceJobId), creator = selected(referenceJobId), authority = new HostedInstallationActivationStore();
  absent(hostedTestEgressGrantRoot + "/" + hostedTestEgressGrantName(referenceJobId));
  const ownerPath = fixedRoot + `/dependency-owners/${actual.binding.workspace.dev}-${actual.binding.workspace.ino}.json`; absent(ownerPath);
  withHostedActivationFence(fence => {
    authority.dependencyMaintenanceAuthority(fence, candidateJobId); // positive genuine candidate join first
    assert.throws(() => authority.reserveOrdinaryRuntime(fence, creator.launch.command, creator.launch.args, creator.launch.cwd), /dependency_legacy_reference_unresolved/);
  });
  await assert.rejects(authority.compareLegacyDependency({ candidateJobId, referenceJobId, expectedRevision: null }), /hosted_activation_evidence_invalid/);
  assert.deepEqual(readHostedInstallationActivation(), before); assert(retained(referenceJobId).bytes.equals(actual.bytes)); absent(ownerPath);
  for (const suffix of ["reference","reference-start","reference-entry","reference-result","reference-release","comparison"] as const)
    absent(referencePath(actual.binding.reference.operationId, suffix));
}

/** A separate genuine completed-cold C is a negative selection fixture. Its
 * Ready/provenance stays unchanged; reference enrollment cannot force an
 * AlreadyReady tree to become a LegacyCompared proof. */
export async function assertReadyCandidateEnrollmentRefuses(candidateJobId: string, referenceJobId: string): Promise<void> {
  assert.equal(readHostedInstallationActivation().activation.phase, HostedActivationPhase.Closed);
  const candidate = readHostedDependencyBinding(candidateJobId); assert(candidate && candidate.version === 2);
  const receipt = readHostedDependencyEstablishedReceipt(candidate); assert(receipt && receipt.state === DependencyReceiptState.Ready);
  const creator = selected(referenceJobId), stat = lstatSync(creator.workspacePath, { bigint: true });
  const target = hostedTestEgressGrantRoot + "/" + hostedTestEgressGrantName(referenceJobId);
  const bindingPath = fixedRoot + "/" + hostedDependencyBindingName(referenceJobId);
  const absence = fixedRoot + `/dependency-fresh-absence/${stat.dev}-${stat.ino}.json`;
  absent(bindingPath); absent(target); absent(absence);
  await assert.rejects(writeHostedTestEgressGrant({ schemaVersion: 1, jobId: creator.jobId, jobRootDir: creator.jobRootDir,
    workspacePath: creator.workspacePath, profileId: CodexProviderEgressProfileId.TestNpmQualification }, undefined,
    { candidateJobId, kind: HostedDependencyReferenceKind.LegacyLocalNoLifecycleV1 }), /hosted_dependency_reference_fresh_closed_enrollment_required/);
  assert.deepEqual(readHostedDependencyEstablishedReceipt(candidate), receipt);
  absent(bindingPath); absent(target); absent(absence);
}
