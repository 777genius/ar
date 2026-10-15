import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
import { readHostedDependencyPendingPreservations, readHostedDependencyPreservationRelease } from "./hosted-dependency-preservation-handoff";
import type { CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { parseDependencyGenerationContinuityInvalidation } from "@vioxen/subscription-runtime/core";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { DependencyGenerationContinuityKind as Continuity, DependencyOwnerKind, DependencyOwnerPhase,
  DependencyReceiptState as State, DependencyUnverifiedReason, parseDependencyOwner,
  sameDependencyProtectedReference, type DependencyOwnerRecord } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { readOriginalHostedDependencyMaintenanceAuthority, claimOriginalHostedDependencyPreservationMaintenance,
  readOriginalHostedDependencyMaintenanceIdle, readOriginalHostedDependencyPreservationActiveHistory } from "./hosted-dependency-active-maintenance";
import { readOriginalHostedDependencyCIdleGeneration } from "./hosted-dependency-generation-source-closure";
import { readOriginalHostedDependencyRIdleGeneration, captureOriginalHostedUnverifiedRPreservationIdle,
  readOriginalHostedUnverifiedRPreservationHistory, readOriginalHostedConsumerUnverifiedRPreservationHistory,
  readOriginalHostedUnverifiedRPreservationCensusHistory } from "./hosted-dependency-generation-r-source-closure";
import { captureOriginalHostedUnverifiedCPreservationIdle, readOriginalHostedUnverifiedCPreservationHistory } from "./hosted-dependency-preservation-c-history";
import { readOriginalHostedDependencyOperatorNativeCensus } from "./hosted-dependency-generation-native-census";
import { hostedDependencyOwnerRoot } from "./hosted-dependency-workspace";
import { hostedDependencyReceiptHistoryRoot, ensureHostedDependencyDirectory, readHostedDependencyEstablishedReceipt,
  readHostedDependencyExistingCommittedReady, readHostedDependencyExistingCommittedUnverified } from "./hosted-dependency-receipts";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import { pinReferenceFile, encodeReference as encode } from "./hosted-dependency-legacy-reference-records";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { hostedDependencyPreservationRoot, hostedDependencyQuarantineRoot, readHostedDependencyCommittedPreservation, hostedDependencyPreservationPath } from "./hosted-dependency-preservation";
import { HostedDependencyPreservationLineageKind as Kind, HostedDependencyPreservationRequestKind,
  hostedDependencyPreservationSelectionPath, hostedDependencyPreservationSelectionIndexPath,
  readHostedDependencyPreservationSelection, readHostedDependencyPreservationSelections,
  readHostedDependencyActivatedPreservationSelections,
  type HostedDependencyPreservationSelection as Selection } from "./hosted-dependency-preservation-selection";
const equal=(a:unknown,b:unknown)=>encode(a).equals(encode(b));
function held():never {throw new Error("hosted_dependency_preservation_operator_held");}
function writeRecord(path:string,value:unknown):void {
  const bytes=encode(value);if(bytes.length>65536)held();createReadonlyPrivateRecord(path,bytes);
  if(!pinReferenceFile(path,65536).bytes.equals(bytes))held();
}
const owners=()=>LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
function owner(s:Selection) {const store=owners();try{return store.read(s.binding.workspace);}finally{store.close();}}
function boundary(fence:HostedActivationFence,access:symbol):void {assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);}
function publish(fence:HostedActivationFence,previous:DependencyOwnerRecord,next:DependencyOwnerRecord,access:symbol):void {
  boundary(fence,access);const exact=({previousOwner,proposedOwner}:{previousOwner:DependencyOwnerRecord;proposedOwner:DependencyOwnerRecord})=>{
    boundary(fence,access);if(!equal(previousOwner,previous) || !equal(proposedOwner,next))held();};
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384,
    generationBaselineVerifier:{assertGenerationBaselineTransition:exact},generationRetirementVerifier:{assertGenerationRetirement:exact}});
  try{if(!equal(store.compareAndSwap(previous.workspace,previous.revision,next),next) || !equal(store.read(previous.workspace),next))held();}finally{store.close();}
}
export function readOriginalHostedDependencyPreservationHistory(fence:HostedActivationFence,s:Selection,access:symbol,context?:CurrentHostedDependencyOrigin) {
  boundary(fence,access);const selected=readHostedDependencyPreservationSelection(s.binding,s.operationId);
  if(!equal(selected.header,s))held();
  const indexed=readHostedDependencyPreservationSelections(s.binding).find(v=>v.header.operationId===s.operationId);
  if(!indexed || !sameDependencyProtectedReference(indexed.reference,selected.reference))held();
  if(s.lineage.kind===Kind.Active) {
    const original=readOriginalHostedDependencyPreservationActiveHistory(fence,s.binding.jobId,s.operationId,access);
    if(!equal(original.previous,s.prior.owner) || !equal(original.claimed,s.claimedOwner) ||
      !sameDependencyProtectedReference(original.idle,s.lineage.idle) || !sameDependencyProtectedReference(original.sourceClosed,s.lineage.sourceClosed))held();
    return [] as readonly string[];
  }
  if(s.lineage.kind===Kind.OrdinaryUnverified)return readOriginalHostedUnverifiedCPreservationHistory(fence,s,access,context).units;
  return (context?readOriginalHostedConsumerUnverifiedRPreservationHistory(context,fence,s.operationId,access):readOriginalHostedUnverifiedRPreservationHistory(fence,s.operationId,access)).units;
}
/** Native census consumes only activated fixed historical selections. It never
 * reconstructs SourceClosed from a missing file or grants a mutable scope. */
export function readOriginalHostedDependencyPreservationDischargedUnits(fence:HostedActivationFence,access:symbol,context?:CurrentHostedDependencyOrigin):readonly string[] {
  boundary(fence,access);const units=new Set<string>();
  for(const selected of readHostedDependencyActivatedPreservationSelections()) {
    if(selected.header.lineage.kind===Kind.Active)continue; // Original SourceClosed reader owns this classification.
    if(selected.header.lineage.kind===Kind.ReadonlyUnverified) {
      const s=selected.header,lineage=selected.header.lineage,history=readOriginalHostedUnverifiedRPreservationCensusHistory(fence,s.operationId,access,context);
      if(!equal(history.binding,s.binding) || !equal(history.previous,s.prior.owner) ||
          !sameDependencyProtectedReference(history.release,lineage.release) || !sameDependencyProtectedReference(history.fda,lineage.fda))held();
      for(const unit of history.units)units.add(unit);
    }else for(const unit of readOriginalHostedDependencyPreservationHistory(fence,selected.header,access,context))units.add(unit);
  }
  if(units.size>256)held();boundary(fence,access);return Object.freeze([...units]);
}
function committedPrior(fence:HostedActivationFence,s:Selection,access:symbol) {
  boundary(fence,access);const prior=s.prior.receipt,r=prior.receipt;
  const actual=r.state===State.Ready?readHostedDependencyExistingCommittedReady(fence,s.binding,r.revision):readHostedDependencyExistingCommittedUnverified(fence,s.binding,r.revision);
  if(!equal(actual,prior))held();return actual;
}
export function readOriginalHostedDependencyPreservationRetired(fence:HostedActivationFence,s:Selection,access:symbol) {
  committedPrior(fence,s,access);const prior=s.prior.receipt;
  const retired=readHostedDependencyExistingCommittedUnverified(fence,s.binding,prior.receipt.revision+1);
  if(!equal(retired.receipt,{version:1,revision:prior.receipt.revision+1,generation:prior.receipt.generation,workspace:prior.receipt.workspace,
    coverageRevision:prior.receipt.coverageRevision,state:State.Unverified,tree:s.sourceTree,reason:DependencyUnverifiedReason.ExplicitOperatorReinstallation}))held();
  return retired;
}
function retiredOwner(fence:HostedActivationFence,s:Selection,access:symbol) {
  const retired=readOriginalHostedDependencyPreservationRetired(fence,s,access),prior=s.prior.receipt;
  if(prior.receipt.state===State.Unverified)return s.claimedOwner;
  const slot=parseDependencyGenerationContinuityInvalidation({version:1,kind:Continuity.RetiredReadyV1,operationId:s.operationId,
    generation:prior.receipt.generation,readyRevision:prior.receipt.revision,unverifiedRevision:retired.receipt.revision,
    previousReady:prior.reference,retiredUnverified:retired.reference});
  return parseDependencyOwner({...s.claimedOwner,revision:s.claimedOwner.revision+1,generationContinuity:slot});
}
/** Actual explicit request association is durable before claim CAS and before
 * Ready retirement. Replay resumes only its exact predecessor/own successor. */
export function beginOriginalHostedDependencyPreservation(fence:HostedActivationFence,jobId:string,recover:boolean,access:symbol):Selection {
  boundary(fence,access);const a=readOriginalHostedDependencyMaintenanceAuthority(fence,jobId,access),store=owners();let previous;
  try{previous=store.read(a.binding.workspace);}finally{store.close();}
  if(!previous || previous.version===1 || a.binding.version!==2)held();
  const pending=readHostedDependencyPendingPreservations(fence,a.binding);
  if(recover) {
    const candidates=pending.filter(v=>equal(v.header.prior.owner,previous) || previous.owner?.kind===DependencyOwnerKind.Maintenance && previous.owner.attempt.operationId===v.header.operationId ||
      readHostedPrivateBytes(hostedDependencyPreservationSelectionPath(v.header.operationId)+".release.json",32768) && equal(readHostedDependencyPreservationRelease(fence,v.header).released,previous));
    if(candidates.length!==1)held();const s=candidates[0]!.header;
    if(equal(previous,s.prior.owner)) {
      // Before-claim replay reauthenticates the exact native idle predecessor.
      capture(fence,a,previous,access,s);
      const attempt=claimOriginalHostedDependencyPreservationMaintenance(fence,jobId,s.operationId,access);
      if(!equal(attempt,s.claimedOwner.owner?.attempt) || !equal(owner(s),s.claimedOwner))held();
    }
    if(readHostedPrivateBytes(hostedDependencyPreservationSelectionPath(s.operationId)+".release.json",32768)) {
      const release=readHostedDependencyPreservationRelease(fence,s);
      if(equal(previous,release.fenced) || equal(previous,release.released)) {releaseOriginalHostedDependencyPreservation(fence,s,access);return s;}
    }
    retire(fence,s,access);return s;
  }
  if(previous.owner || pending.length)held();
  const receipt=readHostedDependencyEstablishedReceipt(a.binding);
  if(!receipt || receipt.state!==State.Ready && receipt.state!==State.Unverified)held();
  ensureHostedDependencyDirectory(hostedDependencyPreservationRoot);ensureHostedDependencyDirectory(hostedDependencyQuarantineRoot);ensureHostedDependencyDirectory("/var/lib/subscription-runtime-host-policy/dependency-transactions");
  const parent=lstatSync(hostedDependencyQuarantineRoot,{bigint:true});if(!parent.isDirectory() || parent.uid!==0n || (parent.mode&0o7777n)!==0o700n || String(parent.dev)!==a.binding.workspace.dev)held();
  const operationId=randomUUID(),attempt={operationId,epoch:previous.epoch+1,host:{installationId:a.installation.installationId,
    bootId:a.session.bootId,supervisorId:a.session.supervisorId,runtimeSha:a.installation.runtimeSha,inventoryDigest:a.installation.inventorySha256,grantDigest:a.binding.grantDigest}},
    claimedOwner=parseDependencyOwner({...previous,revision:previous.revision+1,epoch:attempt.epoch,owner:{kind:DependencyOwnerKind.Maintenance,phase:DependencyOwnerPhase.ExclusiveMutation,attempt}}),
    prior=receipt.state===State.Ready?readHostedDependencyExistingCommittedReady(fence,a.binding,receipt.revision):readHostedDependencyExistingCommittedUnverified(fence,a.binding,receipt.revision),
    lineage=capture(fence,a,previous,access);
  const s:Selection={version:1,kind:HostedDependencyPreservationRequestKind.ExplicitReinstallation,operationId,binding:a.binding,
    prior:{owner:previous,receipt:prior},claimedOwner,sourceTree:(()=>{const p=readHostedDependencyRootDirectoryPin(a.binding.workspace.canonicalPath+"/node_modules");return {dev:p.dev,ino:p.ino};})(),destinationParent:{canonicalPath:hostedDependencyQuarantineRoot,dev:String(parent.dev),ino:String(parent.ino)},lineage};
  writeRecord(hostedDependencyPreservationSelectionPath(operationId),s);
  const selected=readHostedDependencyPreservationSelection(a.binding,operationId);
  if(!equal(selected.header,s) || !equal(owner(s),previous))held();capture(fence,a,previous,access,s);
  writeRecord(hostedDependencyPreservationSelectionIndexPath(a.binding,receipt.revision),{version:1,selection:selected.reference});
  if(!equal(owner(s),previous))held();const granted=claimOriginalHostedDependencyPreservationMaintenance(fence,jobId,operationId,access);
  if(!equal(granted,attempt) || !equal(owner(s),claimedOwner))held();
  retire(fence,s,access);return s;
}
function capture(fence:HostedActivationFence,a:ReturnType<typeof readOriginalHostedDependencyMaintenanceAuthority>,previous:DependencyOwnerRecord,access:symbol,expected?:Selection):Selection["lineage"] {
  boundary(fence,access);if(previous.version===1 || previous.owner)held();let lineage:Selection["lineage"];
  const historicalIdle=`/var/lib/subscription-runtime-host-policy/dependency-generation-idle-closures/${a.binding.workspace.dev}-${a.binding.workspace.ino}/${previous.revision}.json`;
  const closedRetired=previous.generationContinuity?.kind===Continuity.RetiredReadyV1 && !!readHostedPrivateBytes(historicalIdle,16384);
  if(previous.generationContinuity?.kind===Continuity.BaselineAuthenticatedV1 || closedRetired) {
    const idle=readOriginalHostedDependencyMaintenanceIdle(fence,a.binding.workspace,access) ??
      (previous.version===2?readOriginalHostedDependencyCIdleGeneration(fence,a.binding.jobId,access):readOriginalHostedDependencyRIdleGeneration(fence,access));
    if(!equal(idle.previous,previous))held();lineage={kind:Kind.Active,idle:idle.idle,sourceClosed:idle.sourceClosed};
  }else if(previous.version===3) {
    const idle=captureOriginalHostedUnverifiedRPreservationIdle(fence,access);if(!equal(idle.binding,a.binding) || !equal(idle.previous,previous))held();
    lineage={kind:Kind.ReadonlyUnverified,release:idle.release,fda:idle.fda};
  }else {
    const idle=captureOriginalHostedUnverifiedCPreservationIdle(fence,a.binding,previous,access);lineage={kind:Kind.OrdinaryUnverified,start:idle.start,final:idle.final};
  }
  if(expected){if(!equal(expected.lineage,lineage))held();assertSource(expected);}return lineage;
}
function assertSource(s:Selection):void {
  try{const source=readHostedDependencyRootDirectoryPin(s.binding.workspace.canonicalPath+"/node_modules");if(source.dev!==s.sourceTree.dev || source.ino!==s.sourceTree.ino)held();}
  catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;
    const r=s.prior.receipt.receipt.revision+1,prefix=hostedDependencyPreservationPath(s.binding,r);
    if(!readHostedPrivateBytes(prefix+".prepared.json",32768))held();
    const target=readHostedDependencyRootDirectoryPin(`${hostedDependencyQuarantineRoot}/dependency-${s.operationId}`);
    if(target.dev!==s.sourceTree.dev || target.ino!==s.sourceTree.ino)held();
  }
}
function retire(fence:HostedActivationFence,s:Selection,access:symbol):void {
  boundary(fence,access);const current=owner(s);if(!current || current.owner?.kind!==DependencyOwnerKind.Maintenance || current.owner.attempt.operationId!==s.operationId)held();
  readOriginalHostedDependencyPreservationHistory(fence,s,access);committedPrior(fence,s,access);
  const old=s.prior.receipt,receipt=readHostedDependencyEstablishedReceipt(s.binding),next={version:1 as const,revision:old.receipt.revision+1,generation:old.receipt.generation,
    workspace:old.receipt.workspace,coverageRevision:old.receipt.coverageRevision,state:State.Unverified as const,tree:s.sourceTree,reason:DependencyUnverifiedReason.ExplicitOperatorReinstallation};
  if(equal(receipt,old.receipt)) {
    if(!equal(current,s.claimedOwner))held();assertSource(s);
    if(!readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();
    const receipts=LocalDependencyReceiptStore.open({rootPath:hostedDependencyReceiptHistoryRoot,maxRecordBytes:16384,maxHistorySteps:2048,
      explicitReinstallationVerifier:{assertExplicitReinstallation({previousReceipt,previousReference,proposedUnverified}){
        boundary(fence,access);if(!equal(previousReceipt,old.receipt) || !sameDependencyProtectedReference(previousReference,old.reference) || !equal(proposedUnverified,next))held();}}});
    try{receipts.retireForExplicitReinstallation(s.binding.workspace,old.receipt.revision,old.reference,next);}finally{receipts.close();}
  }else if(!equal(receipt,next))held();
  const successor=retiredOwner(fence,s,access),selected=readHostedDependencyPreservationSelection(s.binding,s.operationId);
  // Exact selection and both old/new receipt associations remain durable even
  // when an older RetiredReady slot must retain its original adjacent history.
  writeRecord(hostedDependencyPreservationSelectionPath(s.operationId)+".retired.json",{version:1,selection:selected.reference,previous:s.claimedOwner,retired:successor});
  readOriginalHostedDependencyPreservationHistory(fence,s,access);assertSource(s);
  if(equal(current,s.claimedOwner) && !equal(current,successor))publish(fence,current,successor,access);
  else if(!equal(current,successor))held();
  assertOriginalHostedDependencyPreservation(fence,s,access);
}

export function assertOriginalHostedDependencyPreservation(fence:HostedActivationFence,s:Selection,access:symbol) {
  boundary(fence,access);const a=readOriginalHostedDependencyMaintenanceAuthority(fence,s.binding.jobId,access);
  if(!equal(a.binding,s.binding) || !equal(owner(s),retiredOwner(fence,s,access)) ||
      !equal(readHostedDependencyEstablishedReceipt(s.binding),readOriginalHostedDependencyPreservationRetired(fence,s,access).receipt))held();
  readOriginalHostedDependencyPreservationHistory(fence,s,access);assertSource(s);
  if(!readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();return a;
}
export function releaseOriginalHostedDependencyPreservation(fence:HostedActivationFence,s:Selection,access:symbol):void {
  boundary(fence,access);const previous=retiredOwner(fence,s,access),retired=readOriginalHostedDependencyPreservationRetired(fence,s,access);
  if(!readHostedDependencyCommittedPreservation(s.binding,retired.receipt,s.operationId) || previous.owner?.kind!==DependencyOwnerKind.Maintenance)held();
  const fenced=parseDependencyOwner({...previous,revision:previous.revision+1,owner:{...previous.owner,phase:DependencyOwnerPhase.Fenced}}),released=parseDependencyOwner({...fenced,revision:fenced.revision+1,owner:null}),
    selection=readHostedDependencyPreservationSelection(s.binding,s.operationId);
  writeRecord(hostedDependencyPreservationSelectionPath(s.operationId)+".release.json",{version:1,selection:selection.reference,previous,fenced,released});
  const actual=owner(s);readOriginalHostedDependencyPreservationHistory(fence,s,access);
  if(!readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();
  if(equal(actual,previous)){assertOriginalHostedDependencyPreservation(fence,s,access);publish(fence,previous,fenced,access);}
  else if(!equal(actual,fenced) && !equal(actual,released))held();
  readOriginalHostedDependencyPreservationHistory(fence,s,access);
  if(!readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();if(!equal(owner(s),released))publish(fence,fenced,released,access);
  readOriginalHostedDependencyPreservationHistory(fence,s,access);if(!equal(owner(s),released))held();
}
export function isOriginalHostedDependencyPreservationReleased(fence:HostedActivationFence,s:Selection,access:symbol):boolean {
  boundary(fence,access);if(!readHostedPrivateBytes(hostedDependencyPreservationSelectionPath(s.operationId)+".release.json",32768))return false;
  const release=readHostedDependencyPreservationRelease(fence,s);if(!equal(owner(s),release.released))return false;
  readOriginalHostedDependencyPreservationHistory(fence,s,access);if(!readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();return true;
}
