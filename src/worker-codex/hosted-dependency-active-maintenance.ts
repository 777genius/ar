import { DependencyGenerationContinuityKind as Continuity, DependencyOwnerKind, DependencyOwnerPhase,
  isDependencyCustodyObject, isDependencyProtectedReference, parseDependencyOwner, sameDependencyMaintenanceAttempt,
  sameDependencyProtectedReference, type DependencyOwnerRecord, type DependencyMaintenanceAttempt } from "@vioxen/subscription-runtime/core";
import { HostedActivationPhase, HostedCustodyPhase, DependencyReceiptState as State, claimDependencyMaintenance,
  releaseDependencyMaintenance } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedDependencyOwnerRoot, readHostedDependencyBinding, parseHostedDependencyBinding, assertHostedDependencyPhysicalWorkspace,
  assertHostedDependencyQualifiedInventory } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { assertOriginalHostedDependencyOperatorDescriptors, assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { HostedInstallationActivationStore } from "./hosted-installation-activation";
import { readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
import { readHostedInstallationActivation } from "./hosted-installation-origin-facts";
import { assertInspectedInstallation, assertActivationSession } from "./hosted-installation-physical-facts";
import { HostedReadonlyHostKernel, HostedReadonlyRuntimeRole } from "./hosted-readonly-host-kernel";
import { HostedReadonlyEpochStore } from "./hosted-readonly-epoch-store";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { readHostedReadonlyDependencyMaterial } from "./hosted-readonly-dependency-records";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { readOriginalHostedDependencyCIdleGeneration } from "./hosted-dependency-generation-source-closure";
import { readOriginalHostedDependencyRIdleGeneration, readOriginalHostedDependencyPriorRSourceClosure } from "./hosted-dependency-generation-r-source-closure";
import { readOriginalHostedDependencyOperatorPriorCSourceClosure } from "./hosted-dependency-generation-prior-closure";
import { readOriginalHostedDependencyOperatorNativeCensus } from "./hosted-dependency-generation-native-census";
import { readHostedDependencyActiveActorFacts, readHostedDependencyActiveReferenceUnits } from "./hosted-dependency-active-actor-facts";
import { readHostedDependencyEstablishedReceipt, readHostedDependencyExistingCommittedReady,
  readHostedDependencyExistingCommittedEvicting } from "./hosted-dependency-receipts";
import { ensureHostedDependencyDirectory, readHostedDependencyCommittedAbsent } from "./hosted-dependency-receipts";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { pinReferenceFile, writeReferenceOnce, encodeReference as encode } from "./hosted-dependency-legacy-reference-records";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
const root="/var/lib/subscription-runtime-host-policy",records=root+"/dependency-generation-maintenance";
function held():never{throw new Error("hosted_dependency_active_maintenance_held");}
function equal(a:unknown,b:unknown):boolean{return encode(a).equals(encode(b));}
function boundary(fence:HostedActivationFence,access:symbol,closedDescriptors=true):void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);assertHostedActivationOperator();
  if(new HostedReadonlyHostKernel().runtimeRole()!==HostedReadonlyRuntimeRole.Supervisor)held();
  if(closedDescriptors)assertOriginalHostedDependencyOperatorDescriptors(fence,access);
}
/** Actual R controller selection is separate from ordinary birth. It never
 * creates a Consumer or treats permanent structural custody as source-close. */
export function readOriginalHostedDependencyMaintenanceAuthority(fence:HostedActivationFence,jobId:string,access:symbol) {
  return selectedAuthority(fence,jobId,access,false);
}
function selectedAuthority(fence:HostedActivationFence,jobId:string,access:symbol,historicalClaim:boolean) {
  boundary(fence,access,false);const actual=readHostedInstallationActivation(),kernel=new HostedReadonlyHostKernel(),session=kernel.operatorSession();
  assertInspectedInstallation(actual.installation);assertActivationSession(actual.activation,session);
  if(actual.activation.phase===HostedActivationPhase.Ordinary)
    return new HostedInstallationActivationStore().dependencyMaintenanceAuthority(fence,jobId);
  if(actual.activation.phase!==HostedActivationPhase.Exclusive)held();
  const epoch=new HostedReadonlyEpochStore().readEpoch();
  if((epoch.phase!==HostedCustodyPhase.Closed && !(historicalClaim && epoch.phase===HostedCustodyPhase.Ready)) || epoch.revoked || epoch.bootId!==session.bootId || epoch.supervisorId!==session.supervisorId)held();
  new HostedReadonlySupervisorHost().verifyReadonlyMaterial(epoch.identity);
  const material=readHostedReadonlyDependencyMaterial(fence,epoch.identity),binding=readHostedDependencyBinding(jobId);
  if(!binding || binding.version!==2 || material.evidence.candidate.jobId!==jobId || !equal(material.evidence.workspace,binding.workspace) ||
      binding.installationId!==actual.installation.installationId || binding.runtimeSha!==actual.installation.runtimeSha)held();
  assertHostedDependencyQualifiedInventory();assertHostedDependencyPhysicalWorkspace(binding);
  boundary(fence,access,false);return {...actual,binding,session};
}
export type OriginalHostedDependencyMaintenanceAuthority=ReturnType<typeof readOriginalHostedDependencyMaintenanceAuthority>;
function owner(workspace:DependencyOwnerRecord["workspace"]) {
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try{return store.read(workspace);}finally{store.close();}
}
function path(operationId:string):string {
  if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(operationId)?.[0]!==operationId)held();return `${records}/${operationId}.json`;
}
function selected(fence:HostedActivationFence,jobId:string,operationId:string,access:symbol) {
  boundary(fence,access,false);const authority=selectedAuthority(fence,jobId,access,true),pin=pinReferenceFile(path(operationId),65536),v:unknown=JSON.parse(pin.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(v,"binding,claimed,idle,previous,sourceClosed,version") || v.version!==1 || !pin.bytes.equals(encode(v)) ||
      !equal(v.binding,authority.binding) || !isDependencyProtectedReference(v.idle) || !isDependencyProtectedReference(v.sourceClosed))held();
  const previous=parseDependencyOwner(v.previous),claimed=parseDependencyOwner(v.claimed);
  if(previous.version===1 || claimed.version!==previous.version || previous.owner || previous.generationContinuity?.kind!==Continuity.BaselineAuthenticatedV1 ||
      claimed.owner?.kind!==DependencyOwnerKind.Maintenance || claimed.owner.phase!==DependencyOwnerPhase.ExclusiveMutation ||
      claimed.owner.attempt.operationId!==operationId || !equal(claimed,parseDependencyOwner({...previous,revision:previous.revision+1,epoch:previous.epoch+1,owner:claimed.owner})) ||
      !sameDependencyMaintenanceAttempt(claimed.owner.attempt,{...claimed.owner.attempt,host:host(authority)}))held();
  const idle=pinReferenceFile(v.idle.path,16384),idleValue:unknown=JSON.parse(idle.bytes.toString("utf8")),closed=pinReferenceFile(v.sourceClosed.path,65536);
  const consumerIdle=isDependencyCustodyObject(idleValue,"attempt,binding,previousOwnerSha256,releasedOwner,releasedOwnerSha256,sourceClosed,version") &&
    equal(idleValue.releasedOwner,previous) && equal(idleValue.sourceClosed,v.sourceClosed) && equal(idleValue.binding,v.binding);
  const maintenanceIdle=isDependencyCustodyObject(idleValue,"fenced,operation,released,version") && equal(idleValue.released,previous) && isDependencyProtectedReference(idleValue.operation);
  if(!consumerIdle && !maintenanceIdle || !sameDependencyProtectedReference(idle.reference,v.idle) || !sameDependencyProtectedReference(closed.reference,v.sourceClosed))held();
  return {authority,pin,previous,claimed,idle:idle.reference,sourceClosed:closed.reference};
}
function host(a:OriginalHostedDependencyMaintenanceAuthority):DependencyMaintenanceAttempt["host"] {
  return {installationId:a.installation.installationId,bootId:a.session.bootId,supervisorId:a.session.supervisorId,
    runtimeSha:a.installation.runtimeSha,inventoryDigest:a.installation.inventorySha256,grantDigest:a.binding.grantDigest};
}
/** Historical SourceClosed is independently reauthenticated after Maintenance
 * advances the epoch. It never borrows the current Consumer's owner slot. */
function native(fence:HostedActivationFence,proof:ReturnType<typeof selected>,access:symbol):void {
  boundary(fence,access);const match=/\/dependency-generation-source-closures\/([a-f0-9-]{36})\.json$/.exec(proof.sourceClosed.path);
  if(!match)held();const id=match[1]!,prior=proof.previous.version===2 ?
    readOriginalHostedDependencyOperatorPriorCSourceClosure(fence,`subscription-runtime-ordinary-${id}.service`,access) :
    readOriginalHostedDependencyPriorRSourceClosure(fence,`subscription-runtime-outer-${id}.service`,access);
  if(!prior || !sameDependencyProtectedReference(pinReferenceFile(proof.sourceClosed.path,65536).reference,proof.sourceClosed) ||
      !sameDependencyProtectedReference(pinReferenceFile(proof.idle.path,16384).reference,proof.idle) || !readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();
  const slot=proof.previous.generationContinuity;
  if(slot?.kind!==Continuity.BaselineAuthenticatedV1)held();
  const baseline=pinReferenceFile(slot.baseline.path,65536),v:unknown=JSON.parse(baseline.bytes.toString("utf8")),actors=readHostedDependencyActiveActorFacts(fence,access);
  if(!sameDependencyProtectedReference(baseline.reference,slot.baseline) || !isDependencyCustodyObject(v,"actors,attempt,barrier,binding,inputClosureDigest,installerMappingSha256,ready,readyReference,version") ||
      !actors || !equal(v.actors,actors) || !sameDependencyProtectedReference(pinReferenceFile(slot.writerBarrier.path,16384).reference,slot.writerBarrier))held();
  boundary(fence,access);
}
function publish(fence:HostedActivationFence,previous:DependencyOwnerRecord,next:DependencyOwnerRecord,access:symbol):void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384,generationBaselineVerifier:{
    assertGenerationBaselineTransition({previousOwner,proposedOwner}) {
      assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
      if(!equal(previousOwner,previous) || !equal(proposedOwner,next))held();
    },
  }});
  try{if(!equal(store.compareAndSwap(previous.workspace,previous.revision,next),next) || !equal(store.read(previous.workspace),next))held();}
  finally{store.close();}
}
/** Fixed operator claim. A caller operation ID chooses neither source lineage
 * nor an owner: the current authentic idle predecessor supplies both. */
export function claimOriginalHostedDependencyMaintenance(fence:HostedActivationFence,jobId:string,operationId:string,access:symbol):DependencyMaintenanceAttempt {
  boundary(fence,access);const a=readOriginalHostedDependencyMaintenanceAuthority(fence,jobId,access),previous=owner(a.binding.workspace);
  if(previous?.version!==1 && previous?.generationContinuity?.kind===Continuity.BaselineAuthenticatedV1) {
    const idle=readOriginalHostedDependencyMaintenanceIdle(fence,a.binding.workspace,access) ??
      (previous.version===2 ? readOriginalHostedDependencyCIdleGeneration(fence,jobId,access) : readOriginalHostedDependencyRIdleGeneration(fence,access));
    if(!equal(idle.binding,a.binding) || !equal(idle.previous,previous))held();
    const attempt:DependencyMaintenanceAttempt={operationId,epoch:previous.epoch+1,host:host(a)},claimed=parseDependencyOwner({...previous,revision:previous.revision+1,epoch:attempt.epoch,
      owner:{kind:DependencyOwnerKind.Maintenance,phase:DependencyOwnerPhase.ExclusiveMutation,attempt}});
    ensureHostedDependencyDirectory(records);
    writeReferenceOnce(path(operationId),{version:1,binding:a.binding,previous,claimed,idle:idle.idle,sourceClosed:idle.sourceClosed});
    const proof=selected(fence,jobId,operationId,access);native(fence,proof,access);publish(fence,previous,claimed,access);native(fence,proof,access);return attempt;
  }
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try{return claimDependencyMaintenance(store,a.binding.workspace,host(a),operationId);}finally{store.close();}
}
/** Before retirement, native census is mandatory with no physical operation
 * descriptors open. After retirement, exact owner/history checks remain and
 * the existing fixed effect's real reference-session veto owns FD inspection. */
export function assertOriginalHostedDependencyMaintenance(fence:HostedActivationFence,jobId:string,attempt:DependencyMaintenanceAttempt,access:symbol) {
  const a=readOriginalHostedDependencyMaintenanceAuthority(fence,jobId,access),current=owner(a.binding.workspace);
  if(!current || current.owner?.kind!==DependencyOwnerKind.Maintenance || (current.owner.phase!==DependencyOwnerPhase.ExclusiveMutation && current.owner.phase!==DependencyOwnerPhase.Fenced) ||
      !sameDependencyMaintenanceAttempt(current.owner.attempt,attempt) || !sameDependencyMaintenanceAttempt(attempt,{...attempt,host:host(a)}))held();
  if(current.version!==1 && (current.generationContinuity?.kind===Continuity.BaselineAuthenticatedV1 || current.generationContinuity?.kind===Continuity.RetiredEvictingV1)) {
    const proof=selected(fence,jobId,attempt.operationId,access);
    if(current.generationContinuity.kind===Continuity.BaselineAuthenticatedV1){if(!equal(current,proof.claimed))held();native(fence,proof,access);}
    else {const evicting=readHostedDependencyExistingCommittedEvicting(fence,a.binding,current.generationContinuity.evictingRevision);
      const receipt=readHostedDependencyEstablishedReceipt(a.binding);
      if(evicting.receipt.operationId!==attempt.operationId || !sameDependencyProtectedReference(evicting.reference,current.generationContinuity.retiredEvicting) ||
          !(equal(receipt,evicting.receipt) || receipt?.state===State.Absent && receipt.operationId===attempt.operationId && receipt.revision===evicting.receipt.revision+1))held();
      if(current.owner.phase===DependencyOwnerPhase.Fenced && receipt?.state!==State.Absent)held();}
  }
  boundary(fence,access,false);return a;
}
/** Retired effect factual coverage. The actual SourceClosed chain replaces
 * legacy zero-only creator rereads; every native/queue/recursive join remains.
 * These group names grant no effect and never select caller-supplied units. */
export function readOriginalHostedDependencyMaintenanceDischargedGroups(fence:HostedActivationFence,jobId:string,attempt:DependencyMaintenanceAttempt,access:symbol):readonly string[] {
  const a=assertOriginalHostedDependencyMaintenance(fence,jobId,attempt,access),current=owner(a.binding.workspace);
  if(!current || current.version===1 || current.generationContinuity?.kind!==Continuity.RetiredEvictingV1)held();
  const proof=selected(fence,jobId,attempt.operationId,access);native(fence,proof,access);
  const initial=readHostedInstallationActivation(),epoch=initial.activation.phase===HostedActivationPhase.Exclusive?new HostedReadonlyEpochStore().readEpoch():undefined,groups=new Set(readHostedReadonlyHostInventory().units.map(v=>v.controlGroup));
  const references=new Set(readHostedDependencyActiveReferenceUnits(fence,access));
  for(const row of initial.activation.ordinaryStarts) {
    if(!references.has(row.unit) && !readOriginalHostedDependencyOperatorPriorCSourceClosure(fence,row.unit,access))held();
    groups.add(`/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${row.unit}`);
  }
  if(epoch?.outerRuntime) {
    if(!readOriginalHostedDependencyPriorRSourceClosure(fence,epoch.outerRuntime.unit,access))held();
    groups.add(`/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${epoch.outerRuntime.unit}`);
  }
  for(const row of epoch?.reservations ?? []) {
    if(!readOriginalHostedDependencyPriorRSourceClosure(fence,row.unit,access))held();
    groups.add(`/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${row.unit}`);
  }
  if(groups.size>256 || !equal(readHostedInstallationActivation(),initial) || epoch && !equal(new HostedReadonlyEpochStore().readEpoch(),epoch))held();
  boundary(fence,access);return Object.freeze([...groups]);
}
/** Only the actual already-committed Evicting successor retires Active. The
 * caller cannot supply a reason/ref/tree or turn a Ready DTO into retirement. */
export function retireOriginalHostedDependencyEviction(fence:HostedActivationFence,jobId:string,attempt:DependencyMaintenanceAttempt,access:symbol):void {
  const a=assertOriginalHostedDependencyMaintenance(fence,jobId,attempt,access),previous=owner(a.binding.workspace);
  if(!previous || previous.version===1 || previous.generationContinuity?.kind!==Continuity.BaselineAuthenticatedV1)return;
  const proof=selected(fence,jobId,attempt.operationId,access);native(fence,proof,access);
  const slot=previous.generationContinuity,ready=readHostedDependencyExistingCommittedReady(fence,a.binding,slot.readyRevision),
    evicting=readHostedDependencyExistingCommittedEvicting(fence,a.binding,slot.readyRevision+1);
  if(!sameDependencyProtectedReference(ready.reference,slot.previousReady) || evicting.receipt.operationId!==attempt.operationId ||
      evicting.receipt.generation!==slot.generation || !equal(evicting.receipt.tree,ready.receipt.tree))held();
  const next=parseDependencyOwner({...previous,revision:previous.revision+1,generationContinuity:{version:1,kind:Continuity.RetiredEvictingV1,
    operationId:attempt.operationId,generation:slot.generation,readyRevision:slot.readyRevision,evictingRevision:evicting.receipt.revision,
    previousReady:slot.previousReady,retiredEvicting:evicting.reference,baseline:slot.baseline,writerBarrier:slot.writerBarrier}});
  native(fence,proof,access);publish(fence,previous,next,access);
  if(!equal(owner(a.binding.workspace),next))held();assertOriginalHostedDependencyMaintenance(fence,jobId,attempt,access);
}
/** null publication happens after physical operation descriptors close. A
 * skipped pre-effect operation may preserve Active only with the original
 * native/source proof; successful eviction requires the real Absent commit. */
export function releaseOriginalHostedDependencyMaintenance(fence:HostedActivationFence,jobId:string,attempt:DependencyMaintenanceAttempt,access:symbol):void {
  boundary(fence,access);const a=readOriginalHostedDependencyMaintenanceAuthority(fence,jobId,access),previous=owner(a.binding.workspace);
  if(previous?.version!==1 && (previous?.generationContinuity?.kind===Continuity.BaselineAuthenticatedV1 || previous?.generationContinuity?.kind===Continuity.RetiredEvictingV1)) {
    if(!previous.owner) {
      const idle=readOriginalHostedDependencyMaintenanceIdle(fence,a.binding.workspace,access);
      if(!idle || idle.attempt.operationId!==attempt.operationId)held();return;
    }
    if(previous.owner.kind!==DependencyOwnerKind.Maintenance || !sameDependencyMaintenanceAttempt(previous.owner.attempt,attempt))held();
    const proof=selected(fence,jobId,attempt.operationId,access);native(fence,proof,access);const receipt=readHostedDependencyEstablishedReceipt(a.binding),slot=previous.generationContinuity;
    if(slot.kind===Continuity.BaselineAuthenticatedV1) {const ready=readHostedDependencyExistingCommittedReady(fence,a.binding,slot.readyRevision);if(!equal(receipt,ready.receipt))held();}
    else {
      if(receipt?.state!==State.Absent || receipt.operationId!==attempt.operationId || receipt.revision!==slot.evictingRevision+1)held();
      if(!equal(readHostedDependencyCommittedAbsent(a.binding,receipt.revision).receipt,receipt))held();
    }
    const fenced=previous.owner.phase===DependencyOwnerPhase.Fenced ? previous : parseDependencyOwner({...previous,revision:previous.revision+1,owner:{...previous.owner,phase:DependencyOwnerPhase.Fenced}});
    if(!equal(previous,fenced)){publish(fence,previous,fenced,access);native(fence,proof,access);}
    const next=parseDependencyOwner({...fenced,revision:fenced.revision+1,owner:null});
    const idlePath=`${records}/${a.binding.workspace.dev}-${a.binding.workspace.ino}-${next.revision}.idle.json`;
    writeReferenceOnce(idlePath,{version:1,operation:proof.pin.reference,fenced,released:next});
    native(fence,proof,access);publish(fence,fenced,next,access);native(fence,proof,access);if(!equal(owner(a.binding.workspace),next))held();return;
  }
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try{releaseDependencyMaintenance(store,a.binding.workspace,attempt);}finally{store.close();}
}
/** Fixed exact own Maintenance null predecessor for a later C/R Consumer.
 * No store-current null or old Consumer leaf alone reconstructs this history. */
export function readOriginalHostedDependencyMaintenanceIdle(fence:HostedActivationFence,workspace:DependencyOwnerRecord["workspace"],access:symbol) {
  boundary(fence,access);const previous=owner(workspace);if(!previous || previous.version===1 || previous.owner)return undefined;
  const path=`${records}/${workspace.dev}-${workspace.ino}-${previous.revision}.idle.json`,bytes=readHostedPrivateBytes(path,16384);
  if(!bytes)return undefined;const pin=pinReferenceFile(path,16384),v:unknown=JSON.parse(pin.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(v,"fenced,operation,released,version") || v.version!==1 || !pin.bytes.equals(encode(v)) ||
      !equal(parseDependencyOwner(v.released),previous) || !isDependencyProtectedReference(v.operation))held();
  const fenced=parseDependencyOwner(v.fenced);
  if(fenced.owner?.kind!==DependencyOwnerKind.Maintenance || fenced.owner.phase!==DependencyOwnerPhase.Fenced ||
      !equal(parseDependencyOwner({...fenced,revision:fenced.revision+1,owner:null}),previous) || v.operation.path!==`${records}/${fenced.owner.attempt.operationId}.json`)held();
  const operation=pinReferenceFile(v.operation.path,65536),o:unknown=JSON.parse(operation.bytes.toString("utf8"));
  if(!sameDependencyProtectedReference(operation.reference,v.operation) || !isDependencyCustodyObject(o,"binding,claimed,idle,previous,sourceClosed,version"))held();
  const binding=parseHostedDependencyBinding(o.binding),proof=selected(fence,binding.jobId,fenced.owner.attempt.operationId,access);
  native(fence,proof,access);
  if(previous.generationContinuity?.kind===Continuity.BaselineAuthenticatedV1) {
    if(!equal(fenced,parseDependencyOwner({...proof.claimed,revision:proof.claimed.revision+1,owner:{...proof.claimed.owner,phase:DependencyOwnerPhase.Fenced}})))held();
    const ready=readHostedDependencyExistingCommittedReady(fence,proof.authority.binding,previous.generationContinuity.readyRevision);
    if(!equal(readHostedDependencyEstablishedReceipt(proof.authority.binding),ready.receipt))held();
  }else if(previous.generationContinuity?.kind===Continuity.RetiredEvictingV1) {
    const receipt=readHostedDependencyEstablishedReceipt(proof.authority.binding);
    if(receipt?.state!==State.Absent || receipt.operationId!==fenced.owner.attempt.operationId || receipt.revision!==previous.generationContinuity.evictingRevision+1 ||
        !equal(readHostedDependencyCommittedAbsent(proof.authority.binding,receipt.revision).receipt,receipt))held();
  }else held();
  if(!sameDependencyProtectedReference(pinReferenceFile(path,16384).reference,pin.reference) || !equal(owner(workspace),previous))held();
  boundary(fence,access);return {binding:proof.authority.binding,previous,idle:pin.reference,sourceClosed:proof.sourceClosed,attempt:fenced.owner.attempt};
}
