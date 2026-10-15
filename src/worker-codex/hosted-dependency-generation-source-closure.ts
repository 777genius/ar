import { readOriginalHostedDependencyRetiredInterval } from "./hosted-dependency-retired-interval-facts";
import { readOriginalHostedDependencyOperatorNativeCensus } from "./hosted-dependency-generation-native-census";
import { HostedDependencySourceRuntimeClosureKind as ClosureKind } from "./hosted-dependency-generation-state";
import { createHash } from "node:crypto";
import { DependencyGenerationContinuityKind, DependencyOwnerPhase, isDependencyConsumerOwner,
  isDependencyCustodyObject, parseScopedOrdinaryReaderFinalReceipt, sameDependencyAttempt, sameDependencyProtectedReference,
  isDependencyProtectedReference, parseDependencyOwner, type DependencyAttempt, type DependencyGenerationBaseline } from "@vioxen/subscription-runtime/core";
import { dependencyToolQualificationRecordName } from "../core/dependency-environment/dependency-tool-profile";
import { HostedCustodyReservationState } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { hostedDependencyOwnerRoot, readHostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { readHostedOrdinaryReaderFinalFacts } from "./hosted-ordinary-reader-final-facts";
import { readHostedOrdinaryReaderParentCompletion } from "./hosted-ordinary-reader-parent-completion";
import { readHostedInstallationActivation, readHostedOrdinaryBirth } from "./hosted-installation-origin-facts";
import { readHostedDependencyActiveActorFacts } from "./hosted-dependency-active-actor-facts";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { ensureHostedDependencyDirectory } from "./hosted-dependency-receipts";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";

const root="/var/lib/subscription-runtime-host-policy", encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
const hash=(v:Uint8Array)=>createHash("sha256").update(v).digest("hex");
function invalid():never {throw new Error("hosted_dependency_source_closure_unresolved");}
function boundary(fence:HostedActivationFence,access:symbol):void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);assertHostedActivationOperator();assertHostedProcessDescriptors();
}
function path(startId:string):string {
  if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(startId)?.[0]!==startId)invalid();
  return `${root}/dependency-generation-source-closures/${startId}.json`;
}
function idlePath(dev:string,ino:string,revision:number):string {
  if(/^[1-9][0-9]{0,29}$/.exec(dev)?.[0]!==dev || /^[1-9][0-9]{0,29}$/.exec(ino)?.[0]!==ino ||
      !Number.isSafeInteger(revision) || revision<1)invalid();
  return `${root}/dependency-generation-idle-closures/${dev}-${ino}/${revision}.json`;
}
/** Select the actual completed C attempt, not a caller home/use/status DTO.
 * Called only by the original lexical operator release composition. Existing
 * current-owner and native-final readers retain their strict live joins. */
function completedC(fence:HostedActivationFence,startId:string,access:symbol,allowReleased=false) {
  boundary(fence,access);path(startId);
  const original=pinReferenceFile(`${root}/ordinary-starts/${startId}.json`,16384),
    parent=readHostedOrdinaryReaderParentCompletion(fence,startId,original.reference.sha256),
    final=readHostedOrdinaryReaderFinalFacts(fence,startId);
  if(parent.row.state!==HostedCustodyReservationState.Terminal || final.reader.startId!==startId ||
      final.attempt.attemptId!==parent.attempt.attemptId || final.attempt.epoch!==parent.attempt.epoch ||
      !sameDependencyProtectedReference(final.reader.start,parent.startPin.reference))invalid();
  const binding=readHostedDependencyBinding(parent.start.jobId);
  if(!binding || binding.version!==2 || !encode(binding).equals(encode(parent.binding)))invalid();
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let previous:ReturnType<LocalDependencyOwnerStore["read"]>;
  try{previous=store.read(binding.workspace);}finally{store.close();}
  if(!previous || previous.version===1 || previous.epoch!==parent.attempt.epoch ||
      (previous.owner===null ? !allowReleased :
        !isDependencyConsumerOwner(previous.owner) || previous.owner.phase!==DependencyOwnerPhase.Fenced || !sameDependencyAttempt(previous.owner.attempt,parent.attempt)) ||
      (previous.generationContinuity?.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1 && previous.generationContinuity?.kind!==DependencyGenerationContinuityKind.RetiredReadyV1))invalid();
  const slot=previous.generationContinuity.kind===DependencyGenerationContinuityKind.BaselineAuthenticatedV1 ? previous.generationContinuity :
      readOriginalHostedDependencyRetiredInterval(fence,parent.attempt,binding,previous,access).slot,pins=baselinePins(parent.attempt,binding,slot),
    retirement=pinReferenceFile(`${root}/dependency-generation-source-retirements/${startId}.json`,16384),r:unknown=JSON.parse(retirement.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(r,"attempt,barrier,baseline,binding,lifecycle,pending,qualification,version") || r.version!==1 ||
      !encode(r.attempt).equals(encode(parent.attempt)) || !encode(r.binding).equals(encode(binding)) || !encode(r.pending).equals(encode(pins.pending.reference)) ||
      !encode(r.barrier).equals(encode(slot.writerBarrier)) || !encode(r.baseline).equals(encode(slot.baseline)) ||
      (r.lifecycle!==ClosureKind.RuntimeNeverConfigured && r.lifecycle!==ClosureKind.ConfiguredRuntimeDischarged) || !retirement.bytes.equals(encode(r)))invalid();
  if(!isDependencyProtectedReference(r.qualification) || r.qualification.path!==`${root}/${dependencyToolQualificationRecordName(startId)}` ||
      !sameDependencyProtectedReference(pinReferenceFile(r.qualification.path,16384).reference,r.qualification))invalid();
  const actors=readHostedDependencyActiveActorFacts(fence,access);
  if(!actors || !encode(actors).equals(encode(pins.baseline.actors)))invalid();
  // The actual final-reader already proved every related provider, installer,
  // future-attempt fence, queue and recursive descendant drain. All of its and
  // our temporary FDs have closed before this strict physical boundary.
  boundary(fence,access);
  if(!encode(readHostedOrdinaryReaderFinalFacts(fence,startId)).equals(encode(final)) ||
      !encode(readHostedInstallationActivation().activation).equals(encode(parent.actual.activation)))invalid();
  boundary(fence,access);return {parent,final,binding,previous,slot,pins,retirement};
}
export function readOriginalHostedDependencyGenerationBaselinePins(attempt:DependencyAttempt,binding:unknown,slot:DependencyGenerationBaseline,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);return baselinePins(attempt,binding,slot);
}
function baselinePins(attempt:DependencyAttempt,binding:unknown,slot:DependencyGenerationBaseline) {
  const pending=pinReferenceFile(`${root}/dependency-generation-barriers/pending/${attempt.attemptId}.json`,16384),
    barrier=pinReferenceFile(`${root}/dependency-generation-barriers/${slot.operationId}.json`,16384),
    baseline=pinReferenceFile(`${root}/dependency-generation-baselines/${slot.operationId}.json`,65536),
    originalPending=pinReferenceFile(`${root}/dependency-generation-barriers/pending/${slot.operationId}.json`,16384);
  const p:unknown=JSON.parse(pending.bytes.toString("utf8")),b:unknown=JSON.parse(barrier.bytes.toString("utf8")),
    v:unknown=JSON.parse(baseline.bytes.toString("utf8")),initial:unknown=JSON.parse(originalPending.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(p,"actors,attempt,bindingSha256,version") || p.version!==1 || !encode(p.attempt).equals(encode(attempt)) ||
      p.bindingSha256!==hash(encode(binding)) || !pending.bytes.equals(encode(p)) ||
      !isDependencyCustodyObject(initial,"actors,attempt,bindingSha256,version") || initial.version!==1 || !originalPending.bytes.equals(encode(initial)) ||
      !isDependencyCustodyObject(b,"actors,attempt,bindingSha256,pending,tree,version,workspace") || b.version!==1 ||
      b.bindingSha256!==p.bindingSha256 || !encode(b.actors).equals(encode(p.actors)) ||
      !sameDependencyProtectedReference(barrier.reference,slot.writerBarrier) || !encode(b.pending).equals(encode(originalPending.reference)) ||
      !barrier.bytes.equals(encode(b)) || !isDependencyCustodyObject(v,"actors,attempt,barrier,binding,inputClosureDigest,installerMappingSha256,ready,readyReference,version") ||
      v.version!==1 || !isDependencyCustodyObject(v.attempt,"attemptId,epoch,launch") || v.attempt.attemptId!==slot.operationId ||
      !encode(v.attempt).equals(encode(b.attempt)) || !encode(v.attempt).equals(encode(initial.attempt)) || initial.bindingSha256!==p.bindingSha256 ||
      !encode(v.binding).equals(encode(binding)) || !encode(v.actors).equals(encode(p.actors)) || !encode(initial.actors).equals(encode(p.actors)) ||
      !encode(v.barrier).equals(encode(barrier.reference)) || !encode(v.readyReference).equals(encode(slot.previousReady)) ||
      !sameDependencyProtectedReference(baseline.reference,slot.baseline) || !baseline.bytes.equals(encode(v)))invalid();
  return {pending,barrier,baselinePin:baseline,originalPending,baseline:v};
}
/** A fixed per-attempt physical discharge fact. This is not final credential/
 * HOME/use release and cannot authorize SourceCleanup or a future baseline.
 * The original module alone supplies access; no public receipt publisher,
 * callback, selectable reason, path, facts or closure token enters here. */
export function publishOriginalHostedDependencyCSourceClosure(fence:HostedActivationFence,startId:string,access:symbol):void {
  closeC(fence,startId,access);
}
function closeC(fence:HostedActivationFence,startId:string,access:symbol,allowReleased=false) {
  const before=completedC(fence,startId,access,allowReleased),bytes=encode({version:1,attempt:before.parent.attempt,
    binding:before.binding,pending:before.pins.pending.reference,barrier:before.slot.writerBarrier,baseline:before.slot.baseline,retirement:before.retirement.reference,
    final:before.final});
  if(bytes.length>65536)invalid();
  const existing=readHostedPrivateBytes(path(startId),65536);
  if(existing) {
    const old:unknown=JSON.parse(existing.toString("utf8"));
    if(!isDependencyCustodyObject(old,"attempt,barrier,baseline,binding,final,pending,retirement,version") || old.version!==1 || !existing.equals(encode(old)))invalid();
    const final=parseScopedOrdinaryReaderFinalReceipt(old.final);
    if(final.publicationGeneration>before.final.publicationGeneration || !encode(old).equals(encode({version:1,attempt:before.parent.attempt,binding:before.binding,
      pending:before.pins.pending.reference,barrier:before.slot.writerBarrier,baseline:before.slot.baseline,retirement:before.retirement.reference,
      final:{...before.final,publicationGeneration:final.publicationGeneration}})))invalid();
  }else {
    // Released retry can only consume its already-published immutable chain.
    // A missing record cannot be recreated from present-day process absence.
    if(!before.previous.owner)invalid();
    ensureHostedDependencyDirectory(`${root}/dependency-generation-source-closures`);createReadonlyPrivateRecord(path(startId),bytes);
  }
  const written=pinReferenceFile(path(startId),65536);if(!written.bytes.equals(existing??bytes))invalid();
  const after=completedC(fence,startId,access,allowReleased);
  if(!encode(after.previous).equals(encode(before.previous)) || !encode(after.final).equals(encode(before.final)) ||
      !sameDependencyProtectedReference(pinReferenceFile(path(startId),65536).reference,written.reference))invalid();
  boundary(fence,access);
  return {selected:after,closure:written.reference};
}

/** Actual operator release of this exact C attempt. The store callback only
 * compares its OWN predecessor with privately pre-captured proof. No physical
 * census, recursive owner read, callback permit or returned grant runs there. */
export function releaseOriginalHostedDependencyCSourceOwner(fence:HostedActivationFence,startId:string,access:symbol):void {
  const proof=closeC(fence,startId,access,true),before=proof.selected,previous=before.previous;
  if(!previous.owner)return;
  const idle=idlePath(before.binding.workspace.dev,before.binding.workspace.ino,previous.revision+1),retained=readHostedPrivateBytes(idle,16384);
  let released:ReturnType<typeof parseDependencyOwner>|undefined;
  if(retained) {
    const v:unknown=JSON.parse(retained.toString("utf8"));
    if(!isDependencyCustodyObject(v,"attempt,binding,previousOwnerSha256,releasedOwner,releasedOwnerSha256,sourceClosed,version") ||
        v.version!==1 || !retained.equals(encode(v)) || v.previousOwnerSha256!==hash(encode(previous)) ||
        !encode(v.attempt).equals(encode(before.parent.attempt)) || !encode(v.binding).equals(encode(before.binding)) ||
        !isDependencyProtectedReference(v.sourceClosed) || !sameDependencyProtectedReference(v.sourceClosed,proof.closure))invalid();
    released=parseDependencyOwner(v.releasedOwner);
    if(v.releasedOwnerSha256!==hash(encode(released)))invalid();
  }
  const atMs=released?.activity?.lastRelease?.atMs ?? String(Date.now());
  const activity=previous.activity?.lastEntry?.epoch===before.parent.attempt.epoch ? {
    lastEntry:previous.activity.lastEntry,lastRelease:{epoch:before.parent.attempt.epoch,atMs}} : undefined;
  const expected=parseDependencyOwner({...previous,revision:previous.revision+1,owner:null,...(activity?{activity}:{})});
  if(released && !encode(released).equals(encode(expected)))invalid();
  // Exact successor is immutable BEFORE CAS. A retry reuses its original
  // release time/bytes; it cannot invent another revision, timestamp or UUID.
  const bytes=encode({version:1,attempt:before.parent.attempt,binding:before.binding,previousOwnerSha256:hash(encode(previous)),
    releasedOwner:expected,releasedOwnerSha256:hash(encode(expected)),sourceClosed:proof.closure});
  if(retained && !retained.equals(bytes))invalid();
  ensureHostedDependencyDirectory(idle.slice(0,idle.lastIndexOf("/")));createReadonlyPrivateRecord(idle,bytes);
  const idlePin=pinReferenceFile(idle,16384);if(!idlePin.bytes.equals(bytes))invalid();
  const ready=completedC(fence,startId,access,true);
  if(!encode(ready.previous).equals(encode(previous)) || !encode(ready.final).equals(encode(before.final)) ||
      !readOriginalHostedDependencyOperatorNativeCensus(fence,access))invalid();
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384,generationBaselineVerifier:{
    assertGenerationBaselineTransition({previousOwner,proposedOwner}) {
      assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
      if(!encode(previousOwner).equals(encode(previous)) || !encode(proposedOwner).equals(encode(expected)))invalid();
    },
  }});
  try {const written=store.compareAndSwap(before.binding.workspace,previous.revision,expected);
    if(!encode(written).equals(encode(expected)) || !encode(store.read(before.binding.workspace)).equals(encode(expected)))invalid();
  }finally{store.close();}
  const after=completedC(fence,startId,access,true);
  if(!encode(after.previous).equals(encode(expected)) || !encode(after.final).equals(encode(before.final)) ||
      !sameDependencyProtectedReference(pinReferenceFile(path(startId),65536).reference,proof.closure) ||
      !sameDependencyProtectedReference(pinReferenceFile(idle,16384).reference,idlePin.reference))invalid();
  boundary(fence,access);
}

/** Fresh fixed operator read of the current exact idle revision. Neither a
 * new process nor an old baseline can invent the prior attempt's discharge. */
export function readOriginalHostedDependencyCIdleGeneration(fence:HostedActivationFence,jobId:string,access:symbol) {
  boundary(fence,access);const actual=readHostedOrdinaryBirth(jobId),binding=readHostedDependencyBinding(jobId);
  if(!binding || binding.version!==2 || actual.birth.workspacePath!==binding.workspace.canonicalPath ||
      actual.birth.jobRootDir!==binding.jobRootDir || actual.installation.installationId!==binding.installationId ||
      actual.installation.runtimeSha!==binding.runtimeSha)invalid();
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let previous:ReturnType<LocalDependencyOwnerStore["read"]>;
  try{previous=store.read(binding.workspace);}finally{store.close();}
  if(!previous || previous.version!==2 || previous.owner || previous.generationContinuity?.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1)invalid();
  const pin=pinReferenceFile(idlePath(binding.workspace.dev,binding.workspace.ino,previous.revision),16384),v:unknown=JSON.parse(pin.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(v,"attempt,binding,previousOwnerSha256,releasedOwner,releasedOwnerSha256,sourceClosed,version") || v.version!==1 ||
      v.releasedOwnerSha256!==hash(encode(previous)) || !encode(parseDependencyOwner(v.releasedOwner)).equals(encode(previous)) || typeof v.previousOwnerSha256!=="string" || /^[a-f0-9]{64}$/.exec(v.previousOwnerSha256)?.[0]!==v.previousOwnerSha256 ||
      !encode(v.binding).equals(encode(binding)) || !pin.bytes.equals(encode(v)) || !isDependencyCustodyObject(v.attempt,"attemptId,epoch,launch") ||
      !isDependencyCustodyObject(v.attempt.launch,"bootId,grantDigest,installationId,runtimeSha,startId,unit") || typeof v.attempt.launch.startId!=="string" ||
      !isDependencyProtectedReference(v.sourceClosed) || v.sourceClosed.path!==path(v.attempt.launch.startId))invalid();
  const proof=closeC(fence,v.attempt.launch.startId,access,true);
  if(!encode(proof.selected.previous).equals(encode(previous)) || !encode(proof.selected.parent.attempt).equals(encode(v.attempt)) ||
      !sameDependencyProtectedReference(proof.closure,v.sourceClosed) || !sameDependencyProtectedReference(pinReferenceFile(pin.reference.path,16384).reference,pin.reference))invalid();
  boundary(fence,access);return Object.freeze({binding,previous,idle:pin.reference,sourceClosed:proof.closure,attempt:proof.selected.parent.attempt,slot:proof.selected.slot});
}
