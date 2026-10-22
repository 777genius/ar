import type { CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { ScopedTerminationExtent, isDependencyCustodyObject, sameDependencyProtectedReference, parseScopedOrdinaryReaderFinalReceipt, type ScopedOrdinaryReaderFinalReceipt } from "@vioxen/subscription-runtime/core";
import { HostedCustodyReservationState, parseHostedOrdinaryStart } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readHostedOrdinaryReaderParentCompletion, readOriginalHostedOrdinaryReaderParentCompletion, readOriginalHostedConsumerReaderParentCompletion } from "./hosted-ordinary-reader-parent-completion";
import { readHostedOrdinaryProviderCompletionForFinal, readOriginalHostedOrdinaryProviderCompletionForFinal, readOriginalHostedConsumerProviderCompletionForFinal } from "./hosted-ordinary-provider-failure-recovery";
import { assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { readHostedInstallationActivation } from "./hosted-installation-origin-facts";
import { readonlySupervisorRoot } from "./hosted-readonly-custody";
const encoded=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
function invalid():never {throw new Error("hosted_activation_evidence_invalid");}
/** Fixed facts only; exported DTO is never an accepted publication grant. The
 * original store retains SAME physical result and consumes this under fence. */
export function readHostedOrdinaryReaderFinalFacts(fence:HostedActivationFence,startId:string):ScopedOrdinaryReaderFinalReceipt {
  return finalFacts(fence,startId);
}
export function readOriginalHostedOrdinaryReaderFinalFacts(fence:HostedActivationFence,startId:string,access:symbol):ScopedOrdinaryReaderFinalReceipt {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);return finalFacts(fence,startId,access);
}
export function readOriginalHostedConsumerReaderFinalFacts(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,startId:string,access:symbol):ScopedOrdinaryReaderFinalReceipt {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);return finalFacts(fence,startId,access,context);
}
function finalFacts(fence:HostedActivationFence,startId:string,access?:symbol,context?:CurrentHostedDependencyOrigin):ScopedOrdinaryReaderFinalReceipt {
    assertHostedActivationFence(fence);assertHostedActivationOperator();
    if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(startId)?.[0]!==startId) invalid();
    const original=pinReferenceFile(`${readonlySupervisorRoot}/ordinary-starts/${startId}.json`,16384);
    const parent=(access===undefined ? readHostedOrdinaryReaderParentCompletion(fence,startId,original.reference.sha256) : (context ? readOriginalHostedConsumerReaderParentCompletion(context,fence,startId,original.reference.sha256,access) : readOriginalHostedOrdinaryReaderParentCompletion(fence,startId,original.reference.sha256,access))),current=readHostedInstallationActivation().activation;
    const selectionPins:ReturnType<typeof pinReferenceFile>[]=[];
    const providers=current.ordinaryStarts.filter(row=>row.unit.startsWith("subscription-runtime-hosted-") && row.creatorId===parent.row.creatorId &&
      row.originSha256===parent.row.originSha256 && row.generation>parent.row.generation).filter(row=>{
      if(access===undefined)return true; // Original raw completion boundary is unchanged.
      const relation=pinReferenceFile(`${readonlySupervisorRoot}/dependency-provider-attempts/${row.startId}.json`,4096),v:unknown=JSON.parse(relation.bytes.toString("utf8")),
        start=pinReferenceFile(`${readonlySupervisorRoot}/ordinary-starts/${row.startId}.json`,16384),birth=parseHostedOrdinaryStart(JSON.parse(start.bytes.toString("utf8")));
      selectionPins.push(relation,start);
      if(!isDependencyCustodyObject(v,"attemptId,epoch,parentStartId,providerStartId,startDigest,unit,version") || v.version!==1 || !relation.bytes.equals(encoded(v)) ||
          v.providerStartId!==row.startId || v.unit!==row.unit || v.startDigest!==start.reference.sha256 ||
          typeof v.parentStartId!=="string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.parentStartId) ||
          typeof v.attemptId!=="string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.attemptId) ||
          typeof v.epoch!=="number" || !Number.isSafeInteger(v.epoch) || v.epoch<1 || birth.unit!==row.unit || birth.activationGeneration!==row.generation ||
          birth.creatorId!==row.creatorId || birth.originSha256!==row.originSha256)invalid();
      const owner=current.ordinaryStarts.find(r=>r.startId===v.parentStartId);
      if(!owner || owner.unit!==`subscription-runtime-ordinary-${owner.startId}.service` || owner.creatorId!==row.creatorId ||
          owner.originSha256!==row.originSha256 || owner.generation>=row.generation)invalid();
      if(v.parentStartId!==startId)return false;
      if(v.attemptId!==parent.attempt.attemptId || v.epoch!==parent.attempt.epoch)invalid();return true;
    }).map(row=>{
      if (row.state!==HostedCustodyReservationState.Terminal) invalid();
      const start=pinReferenceFile(`${readonlySupervisorRoot}/ordinary-starts/${row.startId}.json`,16384),proof=access===undefined ? readHostedOrdinaryProviderCompletionForFinal(fence,row.startId,start.reference.sha256) : (context ? readOriginalHostedConsumerProviderCompletionForFinal(context,fence,row.startId,start.reference.sha256,access) : readOriginalHostedOrdinaryProviderCompletionForFinal(fence,row.startId,start.reference.sha256,access));
      if (proof.parent.startId!==startId || proof.attempt.attemptId!==parent.attempt.attemptId || proof.attempt.epoch!==parent.attempt.epoch) invalid();
      return {member:proof.provider,completion:proof.completion,relation:pinReferenceFile(`${readonlySupervisorRoot}/dependency-provider-attempts/${row.startId}.json`,4096).reference};
    });
    assertHostedDependencyInstallerAttemptDrained(parent.attempt);parent.kernel.drainOrdinaryQueue(parent.row);parent.kernel.confirmOrdinaryDescendants(parent.row);
    if(access===undefined)readHostedOrdinaryReaderParentCompletion(fence,startId,parent.startPin.reference.sha256);
    else if(context)readOriginalHostedConsumerReaderParentCompletion(context,fence,startId,parent.startPin.reference.sha256,access);
    else readOriginalHostedOrdinaryReaderParentCompletion(fence,startId,parent.startPin.reference.sha256,access);
    if (!encoded(readHostedInstallationActivation().activation).equals(encoded(current))) invalid();
    for(const pin of selectionPins)if(!sameDependencyProtectedReference(pinReferenceFile(pin.reference.path,pin.bytes.length).reference,pin.reference))invalid();
    return parseScopedOrdinaryReaderFinalReceipt({schemaVersion:3,extent:ScopedTerminationExtent.OrdinaryReaderFinal,publicationGeneration:current.generation+1,
      identity:{installationId:parent.actual.installation.installationId,hostId:current.hostId,bootId:current.bootId,supervisorId:current.supervisorId,runtimeSha:parent.actual.installation.runtimeSha},
      reader:{startId,unit:parent.row.unit,creatorId:parent.row.creatorId,originSha256:parent.row.originSha256,generation:parent.row.generation,start:parent.startPin.reference},attempt:{attemptId:parent.attempt.attemptId,epoch:parent.attempt.epoch,grantDigest:parent.attempt.launch.grantDigest},
      preclaim:parent.producer.reference,completion:parent.completion,providers});
  }
