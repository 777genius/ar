import assert from "node:assert/strict";
import { test } from "vitest";
import { ScopedTerminationExtent, parseScopedOrdinaryReaderFinalReceipt } from "@vioxen/subscription-runtime/core";
import { HostedActivationPhase, assertHostedActivationSuccessor, parseHostedActivation } from "../domain/hosted-installation-activation";
import { HostedCustodyReservationState } from "../domain/hosted-custody-epoch";
const root="/var/lib/subscription-runtime-host-policy",readerId="11111111-1111-1111-1111-111111111111",providerId="22222222-2222-2222-2222-222222222222";
const ref=(path:string)=>({path,identity:{dev:"1",ino:"2"},sha256:"a".repeat(64)});
function fixture() {
  const reader={startId:readerId,unit:`subscription-runtime-ordinary-${readerId}.service`,creatorId:"actual-creator",originSha256:"a".repeat(64),generation:2,state:HostedCustodyReservationState.Reserved};
  const provider={...reader,startId:providerId,unit:`subscription-runtime-hosted-${providerId}.service`,generation:3,state:HostedCustodyReservationState.Terminal};
  const prior=parseHostedActivation({schemaVersion:1,installationId:"installation",hostId:"host",bootId:"boot",supervisorId:"123:456",generation:4,
    phase:HostedActivationPhase.Ordinary,ordinaryOriginsSha256:"b".repeat(64),exclusiveEnrollmentSha256:null,ordinaryStarts:[reader,provider]});
  const member=(r:typeof reader)=>({startId:r.startId,unit:r.unit,creatorId:r.creatorId,originSha256:r.originSha256,generation:r.generation,start:ref(`${root}/ordinary-starts/${r.startId}.json`)});
  const receipt=parseScopedOrdinaryReaderFinalReceipt({schemaVersion:3,extent:ScopedTerminationExtent.OrdinaryReaderFinal,publicationGeneration:5,
    identity:{installationId:"installation",hostId:"host",bootId:"boot",supervisorId:"123:456",runtimeSha:"c".repeat(40)},reader:member(reader),
    attempt:{attemptId:"33333333-3333-3333-3333-333333333333",epoch:7,grantDigest:"d".repeat(64)},preclaim:ref(`${root}/dependency-reader-starts/${readerId}.json`),
    completion:ref(`${root}/dependency-ordinary-reader-completions/${readerId}.json`),providers:[{member:member(provider),
      completion:ref(`${root}/dependency-ordinary-provider-completions/${providerId}.json`),relation:ref(`${root}/dependency-provider-attempts/${providerId}.json`)}]});
  const next={...prior,generation:5,ordinaryStarts:[{...reader,state:HostedCustodyReservationState.Terminal},provider]};
  return {prior,next,receipt};
}
// The former schema1 extent required a keyed actor/account chain and could not
// honestly terminalize this non-keyed parent. These are pure scheduling facts;
// fixtures never acquire original origin/FDA/native/owner-release authority.
test("closed final-reader extent changes only its parent after every candidate is Terminal",()=>{
  const {prior,next,receipt}=fixture();assert.doesNotThrow(()=>assertHostedActivationSuccessor(prior,next,receipt));
  assert.equal(next.ordinaryStarts[1]!.state,prior.ordinaryStarts[1]!.state);
  assert.throws(()=>assertHostedActivationSuccessor(prior,{...next,ordinaryStarts:prior.ordinaryStarts},receipt));
});
test("final reader refuses omitted/live provider and sibling or identity retarget",()=>{
  const {prior,next,receipt}=fixture();
  assert.throws(()=>assertHostedActivationSuccessor(prior,next,{...receipt,providers:[]}));
  const live={...prior,ordinaryStarts:[prior.ordinaryStarts[0]!,{...prior.ordinaryStarts[1]!,state:HostedCustodyReservationState.Reserved}]};
  assert.throws(()=>assertHostedActivationSuccessor(live,next,receipt));
  assert.throws(()=>assertHostedActivationSuccessor(prior,{...next,ordinaryStarts:[next.ordinaryStarts[0]!,{...next.ordinaryStarts[1]!,creatorId:"other"}]},receipt));
  assert.throws(()=>assertHostedActivationSuccessor(prior,next,{...receipt,identity:{...receipt.identity,bootId:"foreign"}}));
  assert.throws(()=>assertHostedActivationSuccessor(prior,next,{...receipt,reader:{...receipt.reader,startId:providerId,unit:`subscription-runtime-ordinary-${providerId}.service`}}));
});
test("final reader uses fresh exact publication generation and rejects legacy/unknown extent bytes",()=>{
  const {prior,next,receipt}=fixture();
  assert.throws(()=>assertHostedActivationSuccessor(prior,next,{...receipt,publicationGeneration:4}));
  assert.throws(()=>parseScopedOrdinaryReaderFinalReceipt({...receipt,schemaVersion:4}));
  assert.throws(()=>parseScopedOrdinaryReaderFinalReceipt({...receipt,identity:{...receipt.identity,accountId:"invented"}}));
  assert.throws(()=>parseScopedOrdinaryReaderFinalReceipt({...receipt,providers:[receipt.providers[0],receipt.providers[0]]}));
  assert.throws(()=>parseScopedOrdinaryReaderFinalReceipt({...receipt,reader:{...receipt.reader,startId:readerId+"\n"}}));
  const appended={...prior,generation:5},fresh={...receipt,publicationGeneration:6};
  assert.doesNotThrow(()=>assertHostedActivationSuccessor(appended,{...next,generation:6},fresh));
});
