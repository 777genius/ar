import { ScopedTerminationExtent, parseScopedOrdinaryReaderFinalReceipt, type ScopedOrdinaryReaderFinalReceipt } from "@vioxen/subscription-runtime/core";
import { HostedCustodyReservationState } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readHostedOrdinaryReaderParentCompletion } from "./hosted-ordinary-reader-parent-completion";
import { readHostedOrdinaryProviderCompletionForFinal } from "./hosted-ordinary-provider-failure-recovery";
import { assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { readHostedInstallationActivation } from "./hosted-installation-origin-facts";
import { readonlySupervisorRoot } from "./hosted-readonly-custody";
const encoded=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
function invalid():never {throw new Error("hosted_activation_evidence_invalid");}
/** Fixed facts only; exported DTO is never an accepted publication grant. The
 * original store retains SAME physical result and consumes this under fence. */
export function readHostedOrdinaryReaderFinalFacts(fence:HostedActivationFence,startId:string):ScopedOrdinaryReaderFinalReceipt {
    assertHostedActivationFence(fence);assertHostedActivationOperator();
    if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(startId)?.[0]!==startId) invalid();
    const original=pinReferenceFile(`${readonlySupervisorRoot}/ordinary-starts/${startId}.json`,16384);
    const parent=readHostedOrdinaryReaderParentCompletion(fence,startId,original.reference.sha256),current=readHostedInstallationActivation().activation;
    const providers=current.ordinaryStarts.filter(row=>row.unit.startsWith("subscription-runtime-hosted-") && row.creatorId===parent.row.creatorId &&
      row.originSha256===parent.row.originSha256 && row.generation>parent.row.generation).map(row=>{
      if (row.state!==HostedCustodyReservationState.Terminal) invalid();
      const start=pinReferenceFile(`${readonlySupervisorRoot}/ordinary-starts/${row.startId}.json`,16384),proof=readHostedOrdinaryProviderCompletionForFinal(fence,row.startId,start.reference.sha256);
      if (proof.parent.startId!==startId || proof.attempt.attemptId!==parent.attempt.attemptId || proof.attempt.epoch!==parent.attempt.epoch) invalid();
      return {member:proof.provider,completion:proof.completion,relation:pinReferenceFile(`${readonlySupervisorRoot}/dependency-provider-attempts/${row.startId}.json`,4096).reference};
    });
    assertHostedDependencyInstallerAttemptDrained(parent.attempt);parent.kernel.drainOrdinaryQueue(parent.row);parent.kernel.confirmOrdinaryDescendants(parent.row);
    readHostedOrdinaryReaderParentCompletion(fence,startId,parent.startPin.reference.sha256);
    if (!encoded(readHostedInstallationActivation().activation).equals(encoded(current))) invalid();
    return parseScopedOrdinaryReaderFinalReceipt({schemaVersion:3,extent:ScopedTerminationExtent.OrdinaryReaderFinal,publicationGeneration:current.generation+1,
      identity:{installationId:parent.actual.installation.installationId,hostId:current.hostId,bootId:current.bootId,supervisorId:current.supervisorId,runtimeSha:parent.actual.installation.runtimeSha},
      reader:{startId,unit:parent.row.unit,creatorId:parent.row.creatorId,originSha256:parent.row.originSha256,generation:parent.row.generation,start:parent.startPin.reference},attempt:{attemptId:parent.attempt.attemptId,epoch:parent.attempt.epoch,grantDigest:parent.attempt.launch.grantDigest},
      preclaim:parent.producer.reference,completion:parent.completion,providers});
  }
