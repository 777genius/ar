import { createHash } from "node:crypto";
import { DependencyReceiptState } from "@vioxen/subscription-runtime/worker-core";
import { sameDependencyProtectedReference, type DependencyAttempt } from "@vioxen/subscription-runtime/core";
import { parseDependencyToolAdmissionQualification } from "../core/dependency-environment/dependency-tool-execution";
import type { HostedDependencyRootPreparationRecord } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import type { HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { assertHostedActivationFence, assertHostedActivationOperator, decodeHostedActivationBytes,
  type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertRootQualificationFacts } from "./hosted-dependency-root-provenance-facts";
import { readHostedDependencyExistingCommittedReady, readHostedDependencyExistingCommittedUnverified } from "./hosted-dependency-receipts";
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
function held():never {throw new Error("hosted_dependency_recovery_admission_unresolved");}
/** Fixed historical facts, no creator authority, current execution grant or
 * provider registration. Consumers independently authenticate original birth,
 * immutable record references, native completion and all physical drains.
 * No directory is created and retained history FDs close before return.
 */
export function readHostedDependencyRecoveryAdmissionFacts(fence:HostedActivationFence,binding:HostedDependencyBinding,
  attempt:DependencyAttempt,record:HostedDependencyRootPreparationRecord,qualificationBytes:Buffer) {
  assertHostedActivationFence(fence);assertHostedActivationOperator();
  const q=parseDependencyToolAdmissionQualification(decodeHostedActivationBytes(qualificationBytes));
  if(!encode(q).equals(qualificationBytes))held();
  if(record.version===2 || record.version===3) {
    const committed=readHostedDependencyExistingCommittedReady(fence,binding,record.readyRevision);
    if(q.version!==1 || !sameDependencyProtectedReference(record.ready,committed.reference) ||
      q.installationId!==binding.installationId || q.runtimeSha!==binding.runtimeSha || q.grantDigest!==binding.grantDigest ||
      q.installKey!==committed.receipt.installKey || q.manifestDigest!==committed.receipt.manifestDigest)held();
    assertRootQualificationFacts(record,binding,attempt,q,committed.receipt);
    assertHostedActivationFence(fence);
    return {version:1 as const,ready:committed.reference,readyRevision:committed.receipt.revision};
  }
  if(record.version===6 || record.version===7) {
    const committed=readHostedDependencyExistingCommittedReady(fence,binding,record.baselineReadyRevision);
    if(q.version!==3 || !sameDependencyProtectedReference(record.baselineReady,committed.reference) ||
        q.execution.bindingSha256!==createHash("sha256").update(encode(binding)).digest("hex"))held();
    assertRootQualificationFacts(record,binding,attempt,q,committed.receipt);assertHostedActivationFence(fence);
    return {version:3 as const,execution:q.execution,baselineReady:committed.reference,baselineReadyRevision:committed.receipt.revision};
  }
  const committed=readHostedDependencyExistingCommittedUnverified(fence,binding,record.unverifiedRevision);
  if(q.version!==2 || committed.receipt.state!==DependencyReceiptState.Unverified ||
    !sameDependencyProtectedReference(record.unverified,committed.reference) ||
    q.execution.bindingSha256!==createHash("sha256").update(encode(binding)).digest("hex"))held();
  assertRootQualificationFacts(record,binding,attempt,q,committed.receipt);
  assertHostedActivationFence(fence);
  return {version:2 as const,execution:q.execution,unverified:committed.reference,unverifiedRevision:committed.receipt.revision};
}
