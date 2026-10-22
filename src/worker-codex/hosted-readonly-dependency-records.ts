import { readHostedReadonlyColdCustodyHistory } from "./hosted-readonly-cold-custody-history";
import { parseDependencyLegacyComparisonRecord } from "../worker-core/dependency-environment/domain/dependency-legacy-comparison";
import type { DependencyCommittedReadyReceipt } from "../worker-core/dependency-environment/ports/dependency-receipt-store";
import { createHash } from "node:crypto";
import { DependencyCustodyEvidenceKind, sameDependencyProtectedReference, sameDependencyWorkspace,
  type DependencyReadonlyAdoptionEvidence, type DependencyReadonlyColdBaselineAdoptionEvidence, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { DependencyInstallProofKind, parseHostedInstallation, type HostedCustodyIdentity } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, readHostedActivationBytes, decodeHostedActivationBytes, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readHostedDependencyBinding, hostedDependencyBindingName, assertHostedDependencyPhysicalWorkspace } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedReadonlyDependencyAssociation, type HostedReadonlyDependencyAssociation } from "../provider-codex/app-server/adapters/hosted-dependency-origin";
import { readHostedDependencyCommittedReady } from "./hosted-dependency-receipts";
import { assertHostedDependencyLegacyComparedReady } from "./hosted-dependency-legacy-comparison-record";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { parseHostedReadonlyPolicy, readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { readonlyIdentityName } from "./hosted-readonly-authority";

const root = "/var/lib/subscription-runtime-host-policy";
const transportRoot = "/run/user/0/subscription-runtime-host-policy";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function invalid(): never { throw new Error("hosted_readonly_dependency_custody_unresolved"); }
function reference(expected: DependencyProtectedReference, fixedPath: string, maxBytes = 16384) {
  if (expected.path !== fixedPath || !readHostedPrivateBytes(fixedPath, maxBytes)) invalid();
  const pin = pinReferenceFile(fixedPath, maxBytes);
  if (!sameDependencyProtectedReference(pin.reference, expected)) invalid(); return pin;
}
/** Fixed path/reference selection before IO. This yields protected historical
 * facts only; it cannot publish an association, adopt a workspace or permit a
 * new current consumer. The original C binding and source pins remain intact. */
export function readHostedReadonlyDependencyMaterial(fence: HostedActivationFence, identity: HostedCustodyIdentity): Readonly<HostedReadonlyDependencyAssociation & { ready: DependencyCommittedReadyReceipt }> {
  assertHostedActivationFence(fence);
  const candidateJobId = identity.jobRootDir.slice(identity.jobRootDir.lastIndexOf("/") + 1);
  const binding = readHostedDependencyBinding(candidateJobId);
  if (!binding || binding.version !== 2 || binding.jobRootDir !== identity.jobRootDir || binding.workspace.canonicalPath !== identity.workspacePath) invalid();
  assertHostedDependencyPhysicalWorkspace(binding);
  const selected = readHostedReadonlyDependencyAssociation(fence, binding.workspace);
  if (!selected) invalid();
  const a = selected.evidence;
  if (a.candidate.jobId !== binding.jobId || a.readonlyCustody.jobId !== identity.jobId ||
      a.readonlyCustody.jobRootDir !== identity.jobRootDir || a.readonlyCustody.workspacePath !== identity.workspacePath ||
      !sameDependencyWorkspace(a.workspace,binding.workspace) || a.installation.installationId !== binding.installationId ||
      a.installation.runtimeSha !== binding.runtimeSha || identity.runtimeSha !== binding.runtimeSha) invalid();
  reference(a.candidate.binding, `${root}/${hostedDependencyBindingName(binding.jobId)}`);
  const installationBytes = readHostedActivationBytes("host-installation.json");
  if (!installationBytes) invalid();
  const installed = parseHostedInstallation(decodeHostedActivationBytes(installationBytes));
  if (installed.installationId !== a.installation.installationId || installed.runtimeSha !== a.installation.runtimeSha ||
      installed.inventorySha256 !== a.installation.inventoryDigest) invalid();
  const name = readonlyIdentityName(identity.jobId);
  const grant = reference(a.readonlyCustody.grant, `${transportRoot}/codex-egress/${name}`);
  const policy = reference(a.readonlyCustody.policy, `${transportRoot}/codex-readonly/${name}`);
  const declaredPolicy = parseHostedReadonlyPolicy(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(policy.bytes)));
  const authored = ["packages/live", "packages/packed", "TEST-readonly-local-custody"].map(p => `${identity.workspacePath}/${p}`).sort();
  if (JSON.stringify([...declaredPolicy.readonlyPaths].sort()) !== JSON.stringify(authored)) invalid();
  const review = reference(a.readonlyCustody.review, `${transportRoot}/codex-readonly-reviewed/${name}`);
  const stage = reference(a.readonlyCustody.stage, `${transportRoot}/codex-readonly-stages/${readonlyIdentityName(installed.runtimeDirectory)}`);
  reference(a.readonlyCustody.lease, `${root}/codex-readonly-custody/${name}`);
  if (hash(grant.bytes) !== identity.grantSha256 || hash(policy.bytes) !== identity.policySha256 ||
      hash(review.bytes) !== identity.reviewSha256 || hash(stage.bytes) !== identity.stageSha256) invalid();
  // Authenticate the original compared-local chain through its real committed
  // receipt. Cold/current output selection is added by B2, never synthesized.
  // Adoption is immutable HISTORY, not a requirement that current output still
  // be this original compared generation after cold install or legal retirement.
  let committed: DependencyCommittedReadyReceipt;
  if(a.kind===DependencyCustodyEvidenceKind.ReadonlyColdBaselineAdoptionV2) {
    committed=readHostedReadonlyColdCustodyHistory(fence,binding,a);
  }else {
  const comparisonPath = a.candidate.comparison.path;
  if (!new RegExp("^" + root + "/dependency-transactions/[a-f0-9-]{36}\\.comparison\\.json$").test(comparisonPath)) invalid();
  const originalComparison = reference(a.candidate.comparison,comparisonPath,65536);
  const originalRecord = parseDependencyLegacyComparisonRecord(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(originalComparison.bytes)));
  if (originalRecord.version !== 2 || comparisonPath !== `${root}/dependency-transactions/${originalRecord.operationId}.comparison.json`) invalid();
  committed = readHostedDependencyCommittedReady(binding,originalRecord.original.receipt.revision+1);
  const receipt = committed.receipt;
  if (receipt.provenance.kind !== DependencyInstallProofKind.LegacyCompared) invalid();
  const compared = assertHostedDependencyLegacyComparedReady({ ...receipt, provenance: receipt.provenance });
  if (compared.version !== 2) invalid();
  reference(a.candidate.comparison, `${root}/dependency-transactions/${compared.operationId}.comparison.json`);
  if (!sameDependencyProtectedReference(a.candidate.sourceMapping, compared.candidateSourceBinding)) invalid();
  reference(a.candidate.sourceMapping, compared.candidateSourceBinding.path,262144);
  }
  assertHostedDependencyPhysicalWorkspace(binding);
  const reselected = readHostedReadonlyDependencyAssociation(fence, binding.workspace);
  if (!reselected || !sameDependencyProtectedReference(reselected.reference, selected.reference)) invalid();
  return Object.freeze({ ...selected, ready: committed });
}
/** Addresses derive from the independently authenticated material, never from
 * arguments/env. R cache authority is still its independent policy/review. */
export function readonlyDependencyMaterialDigests(a: DependencyReadonlyAdoptionEvidence | DependencyReadonlyColdBaselineAdoptionEvidence) {
  return { grantDigest: a.readonlyCustody.grant.sha256, policyDigest: a.readonlyCustody.policy.sha256,
    reviewDigest: a.readonlyCustody.review.sha256, stageDigest: a.readonlyCustody.stage.sha256, leaseDigest: a.readonlyCustody.lease.sha256 };
}
