import { readHostedDependencyCompletedPreservation } from "./hosted-dependency-preservation-handoff";
import { HostedDependencyPreservationLineageKind, readHostedDependencyPreservationSelection } from "./hosted-dependency-preservation-selection";
import { readOriginalHostedDependencyColdCustodyTransfer } from "./hosted-dependency-cold-custody-transfer";
import { readOriginalHostedDependencyMaintenanceIdle } from "./hosted-dependency-active-maintenance";
import { readOriginalHostedDependencyRetiredInterval } from "./hosted-dependency-retired-interval-facts";
import { readOriginalHostedDependencyOperatorNativeCensus } from "./hosted-dependency-generation-native-census";
import { readOriginalHostedDependencyRemoverScope } from "./hosted-dependency-removal-context";
import { readHostedDependencyActiveActorFacts } from "./hosted-dependency-active-actor-facts";
import { readOriginalHostedDependencyGenerationNativeScope } from "./hosted-dependency-generation-native-scope";
import { createHash } from "node:crypto";
import { DependencyGenerationContinuityKind, DependencyOwnerKind, DependencyOwnerPhase, isDependencyConsumerOwner,
  isDependencyCustodyObject, isDependencyProtectedReference, parseDependencyOwner, sameDependencyAttempt,
  sameDependencyProtectedReference, isDependencyCustodyLaunch, DependencyConsumerLaunchKind, DependencyCustodyEvidenceKind, type DependencyOwnerRecord } from "@vioxen/subscription-runtime/core";
import { fenceDependencyConsumer, HostedCustodyPhase, HostedCustodyReservationState, parseHostedCustodyEpoch, parseHostedOrdinaryStart, type HostedCustodyEpoch, type HostedCustodyOuterRuntime } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedForegroundResult, readHostedForegroundLaunchObservation, type HostedForegroundResult } from "../provider-codex/app-server/adapters/hosted-fd-launch";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { hostedDependencyOwnerRoot, readHostedDependencyBinding, hostedDependencyBindingName } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedReadonlyDependencyStart } from "../provider-codex/app-server/adapters/hosted-dependency-origin";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { dependencyToolQualificationRecordName } from "../core/dependency-environment/dependency-tool-profile";
import { CurrentHostedDependencyOriginKind, assertOriginalHostedDependencyOperatorDescriptors, assertOriginalHostedDependencyPhysicalRecordAccess, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { HostedDependencySourceRuntimeClosureKind as ClosureKind } from "./hosted-dependency-generation-state";
import { readOriginalHostedDependencyGenerationBaselinePins } from "./hosted-dependency-generation-source-closure";
import { readOriginalHostedManagedProviderCreator, readOriginalHostedManagedProviderDischargedReceipt, readOriginalHostedManagedConsumerProviderDischargedReceipt } from "./hosted-managed-provider-failure-recovery";
import { readHostedReadonlyDependencyMaterial } from "./hosted-readonly-dependency-records";
import { HostedReadonlyEpochStore } from "./hosted-readonly-epoch-store";
import { HostedReadonlyHostKernel, HostedReadonlyRuntimeRole, completionPath, completionBytes } from "./hosted-readonly-host-kernel";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { ensureHostedDependencyDirectory, readHostedDependencyExistingCommittedReady, readHostedDependencyExistingCommittedUnverified, readHostedDependencyEstablishedReceipt } from "./hosted-dependency-receipts";
import { parseRootPreparationFacts } from "./hosted-dependency-root-provenance-facts";
import { readHostedDependencyRecoveryAdmissionFacts } from "./hosted-dependency-recovery-admission-facts";
import { DependencyReceiptState, DependencyUnverifiedReason } from "../worker-core/dependency-environment/domain/dependency-receipt";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
const root="/var/lib/subscription-runtime-host-policy",encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n"),
  hash=(v:unknown)=>createHash("sha256").update(encode(v)).digest("hex");
function held():never{throw new Error("hosted_dependency_readonly_source_release_held");}
function boundary(fence:HostedActivationFence,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);assertHostedActivationOperator();
  const kernel=new HostedReadonlyHostKernel();
  if(kernel.runtimeRole()!==HostedReadonlyRuntimeRole.Supervisor)held();
  const session=kernel.operatorSession();assertHostedProcessDescriptors();return {kernel,session};
}
function hasActiveOwner(fence:HostedActivationFence,access:symbol):boolean {
  boundary(fence,access);const epoch=new HostedReadonlyEpochStore().readEpoch(),material=readHostedReadonlyDependencyMaterial(fence,epoch.identity),
    binding=readHostedDependencyBinding(material.evidence.candidate.jobId);if(!binding || binding.version!==2)held();
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try{const owner=store.read(binding.workspace);return !!owner && owner.version===3 && (owner.generationContinuity?.kind===DependencyGenerationContinuityKind.BaselineAuthenticatedV1 ||
    owner.generationContinuity?.kind===DependencyGenerationContinuityKind.RetiredReadyV1 && !!epoch.outerRuntime &&
    !!readHostedPrivateBytes(`${root}/dependency-generation-retired-intervals/${epoch.outerRuntime.startId}.json`,16384));}
  finally{store.close();}
}
enum UnverifiedObservationPhase { Live = "live", RevokedTerminal = "revoked_terminal" }
function selected(fence:HostedActivationFence,access:symbol,startId?:string,unverified=false,phase=UnverifiedObservationPhase.Live) {
  const {kernel,session}=boundary(fence,access),epoch=new HostedReadonlyEpochStore().readEpoch();
  let outer=epoch.outerRuntime;
  if(startId && outer?.startId!==startId) {
    if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(startId)?.[0]!==startId)held();
    const pin=pinReferenceFile(`${root}/dependency-generation-source-closures/${startId}.json`,65536),v:unknown=JSON.parse(pin.bytes.toString("utf8"));
    if(!isDependencyCustodyObject(v,"attempt,barrier,baseline,binding,identity,outer,parent,pending,providers,retirement,version") ||
        v.version!==2 || !pin.bytes.equals(encode(v)) || !encode(v.identity).equals(encode(epoch.identity)))held();
    outer=parseHostedCustodyEpoch({...epoch,outerRuntime:v.outer}).outerRuntime;
    if(outer?.startId!==startId)held();
  }
  if((phase===UnverifiedObservationPhase.Live ? epoch.revoked : !epoch.revoked || epoch.phase!==HostedCustodyPhase.Closed ||
      epoch.reservations.some(row=>row.state!==HostedCustodyReservationState.Terminal)) ||
      !outer || outer.state!==HostedCustodyReservationState.Terminal || epoch.bootId!==session.bootId ||
      epoch.hostId!==session.hostId || epoch.supervisorId!==session.supervisorId)held();
  const parent=readHostedReadonlyDependencyStart(fence,outer.startId),material=readHostedReadonlyDependencyMaterial(fence,epoch.identity),
    binding=readHostedDependencyBinding(parent.value.candidateJobId);
  if(!binding || binding.version!==2 || parent.value.startId!==outer.startId || parent.value.unit!==outer.unit ||
      parent.value.creatorId!==outer.creatorId || parent.value.generation!==outer.generation || parent.value.hostId!==epoch.hostId ||
      parent.value.bootId!==epoch.bootId || parent.value.supervisorId!==epoch.supervisorId || parent.value.readonlyJobId!==epoch.identity.jobId ||
      !sameDependencyProtectedReference(parent.value.association,material.reference) || !encode(parent.value.workspace).equals(encode(binding.workspace)))held();
  const preclaim=pinReferenceFile(`${root}/dependency-reader-starts/${outer.startId}.json`,16384),claim:unknown=JSON.parse(preclaim.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(claim,"attempt,binding,custody,kind,origin,ownerRevision,ownerSha256,receipt,version,workspace") || claim.version!==1 ||
      !isDependencyProtectedReference(claim.origin) || !sameDependencyProtectedReference(claim.origin,parent.reference) ||
      !isDependencyProtectedReference(claim.custody) || !sameDependencyProtectedReference(claim.custody,material.reference) ||
      !encode(claim.workspace).equals(encode(binding.workspace)) || !preclaim.bytes.equals(encode(claim)))held();
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let previous:ReturnType<LocalDependencyOwnerStore["read"]>;
  try{previous=store.read(binding.workspace);}finally{store.close();}
  if(!previous || previous.version!==3 || !sameDependencyProtectedReference(previous.custodyBinding,material.reference) ||
      (unverified ? previous.generationContinuity && previous.generationContinuity.kind!==DependencyGenerationContinuityKind.RetiredReadyV1 :
        previous.generationContinuity?.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1 && previous.generationContinuity?.kind!==DependencyGenerationContinuityKind.RetiredReadyV1))held();
  const decoded=parseDependencyOwner({...previous,owner:{kind:DependencyOwnerKind.Consumer,phase:DependencyOwnerPhase.Fenced,attempt:claim.attempt}});
  if(!isDependencyConsumerOwner(decoded.owner))held();const attempt=decoded.owner.attempt;
  if(attempt.epoch!==previous.epoch || attempt.launch.startId!==outer.startId || attempt.launch.unit!==outer.unit ||
      attempt.launch.bootId!==epoch.bootId || attempt.launch.installationId!==binding.installationId || attempt.launch.runtimeSha!==binding.runtimeSha ||
      attempt.launch.grantDigest!==binding.grantDigest || previous.owner && (!isDependencyConsumerOwner(previous.owner) || !sameDependencyAttempt(previous.owner.attempt,attempt)))held();
  const entry=pinReferenceFile(`${root}/dependency-reader-entries/${outer.startId}.json`,4096);
  if(!entry.bytes.equals(encode({version:1,producer:preclaim.reference,attempt})))held();
  if(!unverified){kernel.fenceCreator(outer,epoch.bootId,fence);kernel.drainQueuedStart(outer);kernel.confirmTerminalDescendants(outer);}
  boundary(fence,access);return {epoch,outer,parent,material,binding,previous,attempt,preclaim,entry,kernel};
}
/** Real retained FDA foreground identity fences ONLY its own current R owner.
 * No completion/status DTO, absent PID, parent Runtime rename or borrowed C
 * context can publish this transition. Native discharge remains separately due. */
export function fenceOriginalHostedDependencyRSourceOwner(fence:HostedActivationFence,result:HostedForegroundResult,access:symbol):void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedForegroundResult(result);
  if(result.exitCode!==0)held();if(!hasActiveOwner(fence,access)){fenceUnverifiedR(fence,result,access);return;}const observed=readHostedForegroundLaunchObservation(result),facts=selected(fence,access),previous=facts.previous;
  if(!previous.owner){readOriginalHostedDependencyRIdleGeneration(fence,access);return;}
  if(observed.startId!==facts.outer.startId || observed.unit!==facts.outer.unit || !previous.owner || !isDependencyConsumerOwner(previous.owner))held();
  ensureHostedDependencyDirectory(root+"/dependency-attempt-fences");
  createReadonlyPrivateRecord(`${root}/dependency-attempt-fences/${facts.outer.startId}.json`,encode({version:1,startId:facts.outer.startId,attemptId:facts.attempt.attemptId,epoch:facts.attempt.epoch}));
  if(previous.owner.phase===DependencyOwnerPhase.Fenced)return;
  const expected=parseDependencyOwner({...previous,revision:previous.revision+1,owner:{...previous.owner,phase:DependencyOwnerPhase.Fenced}});
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384,generationBaselineVerifier:{
    assertGenerationBaselineTransition({previousOwner,proposedOwner}) {
      assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);assertHostedForegroundResult(result);
      if(!encode(previousOwner).equals(encode(previous)) || !encode(proposedOwner).equals(encode(expected)))held();
    },
  }});
  try{fenceDependencyConsumer(store,facts.binding.workspace,facts.attempt);
    if(!encode(store.read(facts.binding.workspace)).equals(encode(expected)))held();
  }finally{store.close();}
  const after=selected(fence,access);if(!encode(after.previous).equals(encode(expected)) || !encode(after.epoch).equals(encode(facts.epoch)))held();
  boundary(fence,access);
}

/** No-Active R is a real consumer, not a baseline or an ownership exemption.
 * These files are produced only by the SAME FDA success and drained supervisor
 * paths below. A null owner cannot synthesize a missing discharge on replay. */
const unverifiedReleases=root+"/dependency-unverified-r-releases",unverifiedFences=root+"/dependency-unverified-r-fences";
function unverifiedFacts(fence:HostedActivationFence,access:symbol,phase=UnverifiedObservationPhase.Live) {
  const facts=unverifiedSourceFacts(fence,selected(fence,access,undefined,true,phase));
  if(!encode(readHostedDependencyEstablishedReceipt(facts.binding)).equals(encode(facts.committed.receipt)))held();
  return facts;
}
/** Immutable original source facts only; no current owner/receipt substitution. */
function unverifiedSourceFacts(fence:HostedActivationFence,facts:ReturnType<typeof selected>) {
  const {previous,attempt,binding,material,outer}=facts;
  if(material.evidence.kind!==DependencyCustodyEvidenceKind.ReadonlyLocalAdoptionV1)held();
  if(!isDependencyCustodyLaunch(attempt.launch) || attempt.launch.kind!==DependencyConsumerLaunchKind.ManagedReadonlyLocalV1 ||
      !sameDependencyProtectedReference(attempt.launch.association,material.reference) ||
      !sameDependencyProtectedReference(attempt.launch.origin,facts.parent.reference) ||
      readHostedPrivateBytes(`${root}/dependency-generation-retired-intervals/${outer.startId}.json`,16384))held();
  const claim:unknown=JSON.parse(facts.preclaim.bytes.toString("utf8")),bindingPin=pinReferenceFile(`${root}/${hostedDependencyBindingName(binding.jobId)}`,16384);
  if(!isDependencyCustodyObject(claim,"attempt,binding,custody,kind,origin,ownerRevision,ownerSha256,receipt,version,workspace") ||
      claim.kind!==DependencyConsumerLaunchKind.ManagedReadonlyLocalV1 || typeof claim.ownerRevision!=="number" ||
      !Number.isSafeInteger(claim.ownerRevision) || claim.ownerRevision<1 || previous.revision<=claim.ownerRevision ||
      typeof claim.ownerSha256!=="string" || !/^[a-f0-9]{64}$/.test(claim.ownerSha256) ||
      !isDependencyProtectedReference(claim.binding) || !sameDependencyProtectedReference(claim.binding,bindingPin.reference) || !bindingPin.bytes.equals(encode(binding)))held();
  const preparation=pinReferenceFile(`${root}/dependency-root-preparations/${outer.startId}.json`,65536),
    prepared=parseRootPreparationFacts(preparation.bytes,attempt,material.reference);
  if(prepared.version!==4)held();
  const qualification=pinReferenceFile(`${root}/${dependencyToolQualificationRecordName(outer.startId)}`,16384);
  if(!sameDependencyProtectedReference(prepared.qualification,qualification.reference))held();
  const admitted=readHostedDependencyRecoveryAdmissionFacts(fence,binding,attempt,prepared,qualification.bytes);
  if(admitted.version!==2)held();
  const current=readHostedDependencyExistingCommittedUnverified(fence,binding,admitted.unverifiedRevision);
  if(!sameDependencyProtectedReference(current.reference,admitted.unverified))held();
  // A retired historical Ready without a native interval is legitimate only
  // through the exact factual BaselineMissing retirement, never lost Active.
  const slot=previous.generationContinuity;
  if(slot) {
    if(slot.kind!==DependencyGenerationContinuityKind.RetiredReadyV1)held();
    const ready=readHostedDependencyExistingCommittedReady(fence,binding,slot.readyRevision),
      current=readHostedDependencyExistingCommittedUnverified(fence,binding,slot.unverifiedRevision);
    if(!sameDependencyProtectedReference(ready.reference,slot.previousReady) ||
        !sameDependencyProtectedReference(current.reference,slot.retiredUnverified) ||
        !sameDependencyProtectedReference(current.reference,admitted.unverified) ||
        current.receipt.reason!==DependencyUnverifiedReason.BaselineMissing ||
        current.receipt.generation!==slot.generation || ready.receipt.generation!==slot.generation ||
        ready.receipt.tree.dev!==current.receipt.tree.dev || ready.receipt.tree.ino!==current.receipt.tree.ino)held();
  }
  const completion=pinReferenceFile(completionPath(outer),4096);
  if(!completion.bytes.equals(completionBytes(outer,0)))held();
  return {...facts,committed:current,preparation:preparation.reference,qualification:qualification.reference,completion:completion.reference};
}
function unverifiedIdentity(facts:ReturnType<typeof unverifiedFacts>) {
  return {version:1,attempt:facts.attempt,binding:facts.binding,identity:facts.epoch.identity,outer:facts.outer,
    parent:facts.parent.reference,material:facts.material.reference,preclaim:facts.preclaim.reference,entry:facts.entry.reference,
    preparation:facts.preparation,qualification:facts.qualification,completion:facts.completion};
}
function fenceUnverifiedR(fence:HostedActivationFence,result:HostedForegroundResult,access:symbol):void {
  assertHostedForegroundResult(result);if(result.exitCode!==0)held();
  const observed=readHostedForegroundLaunchObservation(result),facts=unverifiedFacts(fence,access),previous=facts.previous;
  if(observed.closeStatus!==0 || observed.startId!==facts.outer.startId || observed.unit!==facts.outer.unit ||
      result.startId!==facts.outer.startId || result.unit!==facts.outer.unit)held();
  if(!previous.owner){
    const prior=JSON.parse(pinReferenceFile(`${unverifiedFences}/${facts.outer.startId}.json`,65536).bytes.toString("utf8")) as Record<string,unknown>;
    if(prior.invocationId!==observed.invocationId || prior.proxyBirth!==observed.proxyBirth)held();
    verifyUnverifiedRelease(fence,access,facts);return;
  }
  if(!isDependencyConsumerOwner(previous.owner) || !sameDependencyAttempt(previous.owner.attempt,facts.attempt) ||
      (previous.owner.phase!==DependencyOwnerPhase.Running && previous.owner.phase!==DependencyOwnerPhase.Fenced))held();
  facts.kernel.fenceCreator(facts.outer,facts.epoch.bootId,fence);facts.kernel.drainQueuedStart(facts.outer);facts.kernel.confirmTerminalDescendants(facts.outer);
  const path=`${unverifiedFences}/${facts.outer.startId}.json`,bytes=encode({...unverifiedIdentity(facts),
    invocationId:observed.invocationId,proxyBirth:observed.proxyBirth});
  ensureHostedDependencyDirectory(unverifiedFences);createReadonlyPrivateRecord(path,bytes);
  if(!pinReferenceFile(path,65536).bytes.equals(bytes))held();
  const expected=parseDependencyOwner({...previous,revision:previous.revision+(previous.owner.phase===DependencyOwnerPhase.Fenced?0:1),
    owner:{...previous.owner,phase:DependencyOwnerPhase.Fenced}});
  const before=unverifiedFacts(fence,access);if(!encode(before).equals(encode(facts)))held();
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try{fenceDependencyConsumer(store,facts.binding.workspace,facts.attempt);
    if(!encode(store.read(facts.binding.workspace)).equals(encode(expected)))held();}finally{store.close();}
  const after=unverifiedFacts(fence,access);
  if(!encode(after.previous).equals(encode(expected)) || !encode(after.epoch).equals(encode(facts.epoch)) ||
      !pinReferenceFile(path,65536).bytes.equals(bytes))held();boundary(fence,access);
}
function readUnverifiedFDA(facts:ReturnType<typeof unverifiedSourceFacts>) {
  const pin=pinReferenceFile(`${unverifiedFences}/${facts.outer.startId}.json`,65536),v:unknown=JSON.parse(pin.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(v,"attempt,binding,completion,entry,identity,invocationId,material,outer,parent,preclaim,preparation,proxyBirth,qualification,version") ||
      !pin.bytes.equals(encode(v)) || typeof v.invocationId!=="string" || !/^[a-f0-9]{32}$/.test(v.invocationId) ||
      typeof v.proxyBirth!=="string" || !/^[1-9][0-9]*:[1-9][0-9]*$/.test(v.proxyBirth) ||
      !encode({...unverifiedIdentity(facts),invocationId:v.invocationId,proxyBirth:v.proxyBirth}).equals(pin.bytes))held();
  return pin;
}
function unverifiedReleaseFacts(fence:HostedActivationFence,access:symbol,facts:ReturnType<typeof unverifiedSourceFacts>,context?:CurrentHostedDependencyOrigin) {
  const path=`${unverifiedReleases}/${facts.outer.startId}.json`,pin=pinReferenceFile(path,65536),v:unknown=JSON.parse(pin.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(v,"fda,identity,previousOwner,previousOwnerSha256,providers,releasedOwner,version") || v.version!==1 || !pin.bytes.equals(encode(v)) ||
      !encode(v.identity).equals(encode(unverifiedIdentity(facts))) || !encode(v.releasedOwner).equals(encode(facts.previous)) || facts.previous.owner)held();
  const prior=parseDependencyOwner(v.previousOwner);
  if(v.previousOwnerSha256!==hash(prior) || prior.version!==3 || !isDependencyConsumerOwner(prior.owner) || prior.owner.phase!==DependencyOwnerPhase.Fenced ||
      !sameDependencyAttempt(prior.owner.attempt,facts.attempt))held();
  const activity=prior.activity?.lastEntry?.epoch===facts.attempt.epoch ? {lastEntry:prior.activity.lastEntry,
    lastRelease:{epoch:facts.attempt.epoch,atMs:facts.previous.activity?.lastRelease?.atMs}} : prior.activity;
  if(!encode({...prior,revision:prior.revision+1,owner:null,...(activity?{activity}:{})}).equals(encode(facts.previous)))held();
  const fda=readUnverifiedFDA(facts);
  if(!isDependencyProtectedReference(v.fda) || !sameDependencyProtectedReference(v.fda,fda.reference))held();
  drainHistoricalOuter(context,fence,access,facts.kernel,facts.outer,facts.epoch.bootId);
  oldProviders(fence,access,v.providers,facts,context);assertHostedDependencyInstallerAttemptDrained(facts.attempt);
  return {pin,fda,units:Object.freeze([facts.outer.unit,...providerRows(fence,access,facts.epoch,facts.outer).map(row=>row.unit)])};
}
function verifyUnverifiedRelease(fence:HostedActivationFence,access:symbol,facts:ReturnType<typeof unverifiedFacts>,phase=UnverifiedObservationPhase.Live) {
  if((facts.epoch.phase!==HostedCustodyPhase.Closed && facts.epoch.phase!==HostedCustodyPhase.Ready) ||
      facts.epoch.generation<=facts.outer.generation || facts.epoch.reservations.some(row=>row.state!==HostedCustodyReservationState.Terminal))held();
  const {pin}=unverifiedReleaseFacts(fence,access,facts);
  const after=unverifiedFacts(fence,access,phase);if(!encode(after).equals(encode(facts)) || !pinReferenceFile(pin.reference.path,65536).bytes.equals(pin.bytes))held();
  boundary(fence,access);return pin.reference;
}
/** Read-only final observation through the ORIGINAL lexical access path. It
 * cannot fence/release/CAS an owner or qualify an absent discharge. Kernel
 * fenceCreator/drain methods here only reobserve existing completion/queue/
 * recursive descendant facts; they do not cancel or stop any unit. */
export function observeOriginalHostedUnverifiedRTerminal(fence:HostedActivationFence,result:HostedForegroundResult,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedForegroundResult(result);
  const observed=readHostedForegroundLaunchObservation(result),phase=UnverifiedObservationPhase.RevokedTerminal,
    facts=unverifiedFacts(fence,access,phase);
  if(result.exitCode!==0 || observed.closeStatus!==0 || result.startId!==facts.outer.startId || result.unit!==facts.outer.unit ||
      observed.startId!==facts.outer.startId || observed.unit!==facts.outer.unit)held();
  const fda=pinReferenceFile(`${unverifiedFences}/${facts.outer.startId}.json`,65536),value:unknown=JSON.parse(fda.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(value,"attempt,binding,completion,entry,identity,invocationId,material,outer,parent,preclaim,preparation,proxyBirth,qualification,version") ||
      !fda.bytes.equals(encode(value)) || !encode({...unverifiedIdentity(facts),invocationId:observed.invocationId,proxyBirth:observed.proxyBirth}).equals(fda.bytes))held();
  const release=verifyUnverifiedRelease(fence,access,facts,phase);
  for(const row of facts.epoch.reservations){facts.kernel.drainQueuedStart(row);facts.kernel.confirmTerminalDescendants(row);}
  if(!encode(unverifiedFacts(fence,access,phase)).equals(encode(facts)))held();
  if(!pinReferenceFile(fda.reference.path,65536).bytes.equals(fda.bytes))held();
  return Object.freeze({startId:facts.outer.startId,unit:facts.outer.unit,workspace:facts.binding.workspace,
    epochGeneration:facts.epoch.generation,release,fda:fda.reference});
}
/** Capture only the actual current idle no-Active R, before Maintenance.
 * This returns original discharge facts, never a permit or a new owner. */
export function captureOriginalHostedUnverifiedRPreservationIdle(fence:HostedActivationFence,access:symbol) {
  const facts=unverifiedFacts(fence,access);
  const release=verifyUnverifiedRelease(fence,access,facts),fda=readUnverifiedFDA(facts);
  if(!encode(unverifiedFacts(fence,access)).equals(encode(facts)))held();
  return Object.freeze({binding:facts.binding,previous:facts.previous,release,fda:fda.reference});
}
/** Fixed historical selection only. Later Maintenance/Consumer ownership is
 * authenticated by its original defining caller; it is never borrowed here. */
export function readOriginalHostedUnverifiedRPreservationHistory(fence:HostedActivationFence,operationId:string,access:symbol) {
  return preservationHistory(undefined,fence,operationId,access);
}
export function readOriginalHostedConsumerUnverifiedRPreservationHistory(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,operationId:string,access:symbol) {
  return preservationHistory(context,fence,operationId,access);
}
enum PreservationHistoryPhase { Live="live", Completed="completed" }
export function readOriginalHostedUnverifiedRPreservationCensusHistory(fence:HostedActivationFence,operationId:string,access:symbol,context?:CurrentHostedDependencyOrigin) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  return new HostedReadonlyEpochStore().readEpoch().revoked ? readOriginalHostedCompletedUnverifiedRPreservationHistory(fence,operationId,access,context) : preservationHistory(context,fence,operationId,access);
}
/** Completed history is selected only by actual revoked custody and original
 * immutable handoff/source closure records, never a caller completion DTO. */
export function readOriginalHostedCompletedUnverifiedRPreservationHistory(fence:HostedActivationFence,operationId:string,access:symbol,context?:CurrentHostedDependencyOrigin) {
  return preservationHistory(context,fence,operationId,access,PreservationHistoryPhase.Completed);
}
function completedPreservationSourceFacts(context:CurrentHostedDependencyOrigin|undefined,fence:HostedActivationFence,access:symbol,completed:NonNullable<ReturnType<typeof readHostedDependencyCompletedPreservation>>,epoch:HostedCustodyEpoch,binding:ReturnType<typeof readHostedDependencyBinding>) {
  if(!epoch.outerRuntime || epoch.outerRuntime.state!==HostedCustodyReservationState.Terminal || epoch.generation<=epoch.outerRuntime.generation)held();
  const owner=completed.consumer.claimed.owner;if(!isDependencyConsumerOwner(owner))held();
  const attempt=owner.attempt,units=priorR(context,fence,attempt.launch.unit,access);
  if(!units?.includes(attempt.launch.unit) || !priorR(context,fence,epoch.outerRuntime.unit,access)?.includes(epoch.outerRuntime.unit))held();
  const final=pinReferenceFile(`${root}/dependency-generation-source-closures/${epoch.outerRuntime.startId}.json`,65536),last:unknown=JSON.parse(final.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(last,"attempt,barrier,baseline,binding,identity,outer,parent,pending,providers,retirement,version") ||
      !encode(last.outer).equals(encode(epoch.outerRuntime)) || !encode(last.binding).equals(encode(binding)) || !encode(last.identity).equals(encode(epoch.identity)))held();
  const closure=pinReferenceFile(`${root}/dependency-generation-source-closures/${attempt.launch.startId}.json`,65536),v:unknown=JSON.parse(closure.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(v,"attempt,barrier,baseline,binding,identity,outer,parent,pending,providers,retirement,version") || v.version!==2 || !encode(v.attempt).equals(encode(attempt)) || !isDependencyProtectedReference(v.baseline))held();
  const baseline=pinReferenceFile(v.baseline.path,65536),b:unknown=JSON.parse(baseline.bytes.toString("utf8"));
  if(!sameDependencyProtectedReference(baseline.reference,v.baseline) || !baseline.bytes.equals(encode(b)) ||
      !isDependencyCustodyObject(b,"actors,attempt,barrier,binding,inputClosureDigest,installerMappingSha256,ready,readyReference,version") ||
      b.version!==1 || !encode(b.attempt).equals(encode(attempt)) || !encode(b.binding).equals(encode(binding)) ||
      !encode(b.ready).equals(encode(completed.ready.receipt)) || !encode(b.readyReference).equals(encode(completed.ready.reference)))held();
  return {closure:closure.reference,final:final.reference,baseline:baseline.reference,units};
}
function preservationHistory(context:CurrentHostedDependencyOrigin|undefined,fence:HostedActivationFence,operationId:string,access:symbol,phase=PreservationHistoryPhase.Live) {
  historicalBoundary(context,fence,access);
  const kernel=new HostedReadonlyHostKernel(),session=historicalSession(context,fence,access,kernel),epoch=new HostedReadonlyEpochStore().readEpoch(),
    material=readHostedReadonlyDependencyMaterial(fence,epoch.identity),binding=readHostedDependencyBinding(material.evidence.candidate.jobId);
  if(!binding || binding.version!==2 || (phase===PreservationHistoryPhase.Live?epoch.revoked:!epoch.revoked || epoch.phase!==HostedCustodyPhase.Closed ||
      epoch.reservations.some(row=>row.state!==HostedCustodyReservationState.Terminal)) || (epoch.phase!==HostedCustodyPhase.Closed && epoch.phase!==HostedCustodyPhase.Ready) ||
      epoch.hostId!==session.hostId || epoch.bootId!==session.bootId || epoch.supervisorId!==session.supervisorId)held();
  const selection=readHostedDependencyPreservationSelection(binding,operationId),{header}=selection;
  const completed=phase===PreservationHistoryPhase.Completed?readHostedDependencyCompletedPreservation(fence,binding,operationId):undefined;
  if(phase===PreservationHistoryPhase.Completed && (!completed || !encode(completed.selection).equals(encode(header))))held();
  const completedSource=completed?completedPreservationSourceFacts(context,fence,access,completed,epoch,binding):undefined;
  if(header.lineage.kind!==HostedDependencyPreservationLineageKind.ReadonlyUnverified || header.prior.receipt.receipt.state!==DependencyReceiptState.Unverified)held();
  const match=new RegExp("^"+unverifiedReleases+"/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\\.json$").exec(header.lineage.release.path);
  if(!match || header.lineage.fda.path!==`${unverifiedFences}/${match[1]}.json`)held();
  const release=pinReferenceFile(header.lineage.release.path,65536),v:unknown=JSON.parse(release.bytes.toString("utf8"));
  if(!sameDependencyProtectedReference(release.reference,header.lineage.release) ||
      !isDependencyCustodyObject(v,"fda,identity,previousOwner,previousOwnerSha256,providers,releasedOwner,version") ||
      !isDependencyCustodyObject(v.identity,"attempt,binding,completion,entry,identity,material,outer,parent,preclaim,preparation,qualification,version") ||
      !release.bytes.equals(encode(v)) || !encode(v.releasedOwner).equals(encode(header.prior.owner)) ||
      !encode(v.identity.identity).equals(encode(epoch.identity)))held();
  const outer=parseHostedCustodyEpoch({...epoch,outerRuntime:v.identity.outer}).outerRuntime;
  if(!outer || outer.startId!==match[1] || outer.state!==HostedCustodyReservationState.Terminal || epoch.generation<=outer.generation ||
      epoch.outerRuntime?.startId===outer.startId && !encode(epoch.outerRuntime).equals(encode(outer)))held();
  const previous=parseDependencyOwner(header.prior.owner);
  if(previous.version!==3 || previous.owner || !sameDependencyProtectedReference(previous.custodyBinding,material.reference) ||
      previous.generationContinuity && previous.generationContinuity.kind!==DependencyGenerationContinuityKind.RetiredReadyV1)held();
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let current:DependencyOwnerRecord|null;
  try{current=store.read(binding.workspace);if(!current || current.version!==3 || !sameDependencyProtectedReference(current.custodyBinding,material.reference))held();}finally{store.close();}
  const parent=readHostedReadonlyDependencyStart(fence,outer.startId);
  if(parent.value.candidateJobId!==binding.jobId || parent.value.startId!==outer.startId || parent.value.unit!==outer.unit || parent.value.creatorId!==outer.creatorId ||
      parent.value.generation!==outer.generation || parent.value.hostId!==epoch.hostId || parent.value.bootId!==epoch.bootId ||
      parent.value.supervisorId!==epoch.supervisorId || parent.value.readonlyJobId!==epoch.identity.jobId ||
      !sameDependencyProtectedReference(parent.value.association,material.reference) || !encode(parent.value.workspace).equals(encode(binding.workspace)))held();
  const preclaim=pinReferenceFile(`${root}/dependency-reader-starts/${outer.startId}.json`,16384),claim:unknown=JSON.parse(preclaim.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(claim,"attempt,binding,custody,kind,origin,ownerRevision,ownerSha256,receipt,version,workspace") || claim.version!==1 ||
      !preclaim.bytes.equals(encode(claim)) || !encode(claim.workspace).equals(encode(binding.workspace)) ||
      !isDependencyProtectedReference(claim.origin) || !sameDependencyProtectedReference(claim.origin,parent.reference) ||
      !isDependencyProtectedReference(claim.custody) || !sameDependencyProtectedReference(claim.custody,material.reference))held();
  const decoded=parseDependencyOwner({...previous,owner:{kind:DependencyOwnerKind.Consumer,phase:DependencyOwnerPhase.Fenced,attempt:claim.attempt}});
  if(!isDependencyConsumerOwner(decoded.owner))held();const attempt=decoded.owner.attempt;
  if(attempt.epoch!==previous.epoch || attempt.launch.startId!==outer.startId || attempt.launch.unit!==outer.unit || attempt.launch.bootId!==epoch.bootId ||
      attempt.launch.installationId!==binding.installationId || attempt.launch.runtimeSha!==binding.runtimeSha || attempt.launch.grantDigest!==binding.grantDigest)held();
  const entry=pinReferenceFile(`${root}/dependency-reader-entries/${outer.startId}.json`,4096);
  if(!entry.bytes.equals(encode({version:1,producer:preclaim.reference,attempt})))held();
  const facts=unverifiedSourceFacts(fence,{epoch,outer,parent,material,binding,previous,attempt,preclaim,entry,kernel}),proof=unverifiedReleaseFacts(fence,access,facts,context);
  if(!encode(facts.committed).equals(encode(header.prior.receipt)) || !sameDependencyProtectedReference(proof.pin.reference,header.lineage.release) ||
      !sameDependencyProtectedReference(proof.fda.reference,header.lineage.fda))held();
  historicalBoundary(context,fence,access);
  const afterStore=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try{if(!encode(afterStore.read(binding.workspace)).equals(encode(current)))held();}finally{afterStore.close();}
  for(const ref of [parent.reference,material.reference,preclaim.reference,entry.reference,facts.preparation,facts.qualification,facts.completion])
    if(!sameDependencyProtectedReference(pinReferenceFile(ref.path,65536).reference,ref))held();
  if(!encode(unverifiedSourceFacts(fence,facts)).equals(encode(facts)) || !encode(new HostedReadonlyEpochStore().readEpoch()).equals(encode(epoch)) ||
      !encode(readHostedReadonlyDependencyMaterial(fence,epoch.identity)).equals(encode(material)) ||
      !encode(readHostedDependencyBinding(binding.jobId)).equals(encode(binding)) ||
      !encode(readHostedDependencyPreservationSelection(binding,operationId)).equals(encode(selection)) ||
      completed && (!encode(readHostedDependencyCompletedPreservation(fence,binding,operationId)).equals(encode(completed)) ||
        !encode(completedPreservationSourceFacts(context,fence,access,completed,epoch,binding)).equals(encode(completedSource))) ||
      !sameDependencyProtectedReference(pinReferenceFile(proof.pin.reference.path,65536).reference,proof.pin.reference) ||
      !sameDependencyProtectedReference(pinReferenceFile(proof.fda.reference.path,65536).reference,proof.fda.reference))held();
  return Object.freeze({binding,previous,attempt,release:proof.pin.reference,fda:proof.fda.reference,units:proof.units});
}
function releaseUnverifiedR(fence:HostedActivationFence,access:symbol):void {
  const {session}=boundary(fence,access),epoch=new HostedReadonlyEpochStore().readEpoch(),material=readHostedReadonlyDependencyMaterial(fence,epoch.identity);
  // Original legacy adoption has no R use to release. Actual custody is still
  // reauthenticated by the unchanged Ready publication gate around this call.
  if(!epoch.outerRuntime) {
    if(material.evidence.kind!==DependencyCustodyEvidenceKind.ReadonlyLocalAdoptionV1 || epoch.revoked || (epoch.phase!==HostedCustodyPhase.Closed && epoch.phase!==HostedCustodyPhase.Ready) || epoch.reservations.length ||
        epoch.hostId!==session.hostId || epoch.bootId!==session.bootId || epoch.supervisorId!==session.supervisorId)held();
    const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
    try{const owner=store.read(material.evidence.workspace);if(!owner || owner.version!==3 || owner.owner || owner.generationContinuity ||
        !sameDependencyProtectedReference(owner.custodyBinding,material.reference))held();}finally{store.close();}
    boundary(fence,access);return;
  }
  const facts=unverifiedFacts(fence,access),previous=facts.previous;
  if(!previous.owner){verifyUnverifiedRelease(fence,access,facts);return;}
  if(facts.epoch.phase!==HostedCustodyPhase.Closed || facts.epoch.generation<=facts.outer.generation ||
      facts.epoch.reservations.some(row=>row.state!==HostedCustodyReservationState.Terminal) ||
      !isDependencyConsumerOwner(previous.owner) || previous.owner.phase!==DependencyOwnerPhase.Fenced)held();
  const fda=pinReferenceFile(`${unverifiedFences}/${facts.outer.startId}.json`,65536),v:unknown=JSON.parse(fda.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(v,"attempt,binding,completion,entry,identity,invocationId,material,outer,parent,preclaim,preparation,proxyBirth,qualification,version") ||
      !fda.bytes.equals(encode(v)) || !encode({...unverifiedIdentity(facts),invocationId:v.invocationId,proxyBirth:v.proxyBirth}).equals(fda.bytes) ||
      typeof v.invocationId!=="string" || !/^[a-f0-9]{32}$/.test(v.invocationId) || typeof v.proxyBirth!=="string" || !/^[1-9][0-9]*:[1-9][0-9]*$/.test(v.proxyBirth))held();
  facts.kernel.fenceCreator(facts.outer,facts.epoch.bootId,fence);facts.kernel.drainQueuedStart(facts.outer);facts.kernel.confirmTerminalDescendants(facts.outer);
  const providers=providerRows(fence,access,facts.epoch,facts.outer).map(row=>{
    const proof=readOriginalHostedManagedProviderCreator(fence,row.startId,access);
    if(!encode(proof.attempt).equals(encode(facts.attempt)) || !encode(proof.row).equals(encode(row)))held();
    facts.kernel.drainQueuedStart(row);facts.kernel.confirmTerminalDescendants(row);return proof;
  });
  assertHostedDependencyInstallerAttemptDrained(facts.attempt);boundary(fence,access);
  const path=`${unverifiedReleases}/${facts.outer.startId}.json`,old=readHostedPrivateBytes(path,65536),
    retained=old ? JSON.parse(old.toString("utf8")) as {releasedOwner?:{activity?:{lastRelease?:{atMs?:string}}}} : undefined,
    activity=previous.activity?.lastEntry?.epoch===facts.attempt.epoch ? {lastEntry:previous.activity.lastEntry,
      lastRelease:{epoch:facts.attempt.epoch,atMs:retained?.releasedOwner?.activity?.lastRelease?.atMs??String(Date.now())}} : previous.activity,
    expected=parseDependencyOwner({...previous,revision:previous.revision+1,owner:null,...(activity?{activity}:{})}),
    bytes=encode({version:1,identity:unverifiedIdentity(facts),previousOwner:previous,previousOwnerSha256:hash(previous),releasedOwner:expected,fda:fda.reference,providers}),
    same=old===undefined || old===null || old.equals(bytes);
  if(!same || bytes.length>65536)held();ensureHostedDependencyDirectory(unverifiedReleases);createReadonlyPrivateRecord(path,bytes);
  const ready=unverifiedFacts(fence,access);if(!encode(ready).equals(encode(facts)) || !pinReferenceFile(path,65536).bytes.equals(bytes))held();
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try{store.compareAndSwap(facts.binding.workspace,previous.revision,expected);
    if(!encode(store.read(facts.binding.workspace)).equals(encode(expected)))held();}finally{store.close();}
  verifyUnverifiedRelease(fence,access,unverifiedFacts(fence,access));
}

/** Reservations deliberately carry no generation. Select only their sealed
 * producer birth, then retain all creator/completion/native checks below. */
function providerRows(fence:HostedActivationFence,access:symbol,epoch:HostedCustodyEpoch,outer:HostedCustodyOuterRuntime) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  return epoch.reservations.filter(row=>{
    const pin=pinReferenceFile(`${root}/dependency-managed-provider-starts/${row.startId}.json`,16384),birth:unknown=JSON.parse(pin.bytes.toString("utf8"));
    const common="attempt,bootId,custodyReference,executionJobId,generation,hostId,installationId,jobRootDir,logicalJobId,originReference,parentStartId,protectedProfile,providerStartId,qualification,runtimeSha,supervisorId,unit,version,workspace";
    if(!isDependencyCustodyObject(birth,(common+",ready,readyRevision").split(",").sort().join(",")) &&
        !isDependencyCustodyObject(birth,(common+",execution,unverified,unverifiedRevision").split(",").sort().join(",")) &&
        !isDependencyCustodyObject(birth,(common+",baselineReady,baselineReadyRevision,execution").split(",").sort().join(",")))held();
    if((birth.version!==1 && birth.version!==3 && birth.version!==5) ||
        !isDependencyCustodyObject(birth,(common+(birth.version===1?",ready,readyRevision":birth.version===5?",baselineReady,baselineReadyRevision,execution":",execution,unverified,unverifiedRevision")).split(",").sort().join(",")) || !pin.bytes.equals(encode(birth)) || birth.providerStartId!==row.startId || birth.unit!==row.unit ||
        row.creatorId!==row.startId || birth.hostId!==epoch.hostId || birth.bootId!==epoch.bootId || birth.supervisorId!==epoch.supervisorId ||
        typeof birth.generation!=="number" || !Number.isSafeInteger(birth.generation) || birth.generation<1 || birth.generation>epoch.generation ||
        typeof birth.parentStartId!=="string" || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(birth.parentStartId)?.[0]!==birth.parentStartId)held();
    const sameParent=birth.parentStartId===outer.startId,sameGeneration=birth.generation===outer.generation;
    if(sameParent!==sameGeneration)held();
    if(!sameDependencyProtectedReference(pinReferenceFile(pin.reference.path,16384).reference,pin.reference))held();
    return sameParent;
  });
}
function oldProviders(fence:HostedActivationFence,access:symbol,value:unknown,facts:ReturnType<typeof selected>,context?:CurrentHostedDependencyOrigin) {
  if(!Array.isArray(value) || value.length>128)held();
  const current=providerRows(fence,access,facts.epoch,facts.outer);
  if(value.length!==current.length)held();
  for(let index=0;index<value.length;index++) {
    const v:unknown=value[index],row=current[index]!;
    if(row.state!==HostedCustodyReservationState.Terminal || !isDependencyCustodyObject(v,"attempt,birth,completion,entry,material,parent,preclaim,preparation,profile,qualification,receipt,row") ||
        !encode(v.row).equals(encode(row)) || !encode(v.attempt).equals(encode(facts.attempt)))held();
    const paths={birth:`dependency-managed-provider-starts/${row.startId}.json`,completion:`dependency-managed-provider-completions/${row.startId}.json`,
      entry:`dependency-reader-entries/${facts.outer.startId}.json`,material:facts.material.reference.path.slice(root.length+1),
      parent:facts.parent.reference.path.slice(root.length+1),preclaim:`dependency-reader-starts/${facts.outer.startId}.json`,
      preparation:`dependency-root-preparations/${facts.outer.startId}.json`,profile:"dependency-installer-profile.json",
      qualification:dependencyToolQualificationRecordName(facts.outer.startId)};
    for(const [key,path] of Object.entries(paths)) {
      const ref=v[key];if(!isDependencyProtectedReference(ref) || ref.path!==`${root}/${path}` ||
          !sameDependencyProtectedReference(pinReferenceFile(ref.path,key==="preparation"?65536:16384).reference,ref))held();
    }
    const native=context?readOriginalHostedManagedConsumerProviderDischargedReceipt(context,fence,row.startId,access):readOriginalHostedManagedProviderDischargedReceipt(fence,row.startId,access);
    if(!encode(native.receipt).equals(encode(v.receipt)) || !encode(native.receipt.parentAttempt).equals(encode(facts.attempt)) ||
        !isDependencyProtectedReference(v.birth) || !sameDependencyProtectedReference(native.receipt.providerReference,v.birth) || !isDependencyProtectedReference(v.completion) || !sameDependencyProtectedReference(native.completion,v.completion))held();
  }
  return value;
}
/** Initial Closed->Ready and Ready/null preflight are not releases of an R use. Only the exact
 * once-migrated ColdV2 predecessor may take this branch; later epochs owe
 * their independently authenticated real R SourceClosed/native chain. */
function authenticateOriginalColdTransferBeforeFirstR(fence:HostedActivationFence,access:symbol):boolean {
  boundary(fence,access);const epoch=new HostedReadonlyEpochStore().readEpoch();
  if((epoch.phase!==HostedCustodyPhase.Closed && epoch.phase!==HostedCustodyPhase.Ready) ||
      epoch.revoked || epoch.outerRuntime || epoch.reservations.length)return false;
  const material=readHostedReadonlyDependencyMaterial(fence,epoch.identity),binding=readHostedDependencyBinding(material.evidence.candidate.jobId);
  if(!binding || binding.version!==2)held();
  const owners=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let previous:ReturnType<LocalDependencyOwnerStore["read"]>;
  try{previous=owners.read(binding.workspace);}finally{owners.close();}
  if(!previous || previous.version!==3 || previous.owner ||
      previous.generationContinuity?.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1 ||
      !sameDependencyProtectedReference(previous.custodyBinding,material.reference))return false;
  const transfer=readOriginalHostedDependencyColdCustodyTransfer(fence,material,previous,access);if(!transfer)return false;
  const after=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try{if(!encode(after.read(binding.workspace)).equals(encode(transfer.previous)))held();}finally{after.close();}
  boundary(fence,access);
  if(!encode(new HostedReadonlyEpochStore().readEpoch()).equals(encode(epoch)) ||
      !encode(readHostedReadonlyDependencyMaterial(fence,epoch.identity)).equals(encode(material)) ||
      !sameDependencyProtectedReference(pinReferenceFile(transfer.reference.path,65536).reference,transfer.reference))held();
  boundary(fence,access);return true;
}
/** Maintenance owns a later epoch than its original R predecessor. Authenticate
 * its current private idle chain before selecting that historical R attempt;
 * neither null ownership nor Terminal reservations supply this proof. */
function authenticateOriginalMaintenanceIdleBeforeR(fence:HostedActivationFence,access:symbol):boolean {
  const {session}=boundary(fence,access),epoch=new HostedReadonlyEpochStore().readEpoch(),material=readHostedReadonlyDependencyMaterial(fence,epoch.identity),
    binding=readHostedDependencyBinding(material.evidence.candidate.jobId);if(!binding || binding.version!==2)held();
  const idle=readOriginalHostedDependencyMaintenanceIdle(fence,material.evidence.workspace,access);if(!idle)return false;
  if((epoch.phase!==HostedCustodyPhase.Closed && epoch.phase!==HostedCustodyPhase.Ready) || epoch.revoked ||
      epoch.hostId!==session.hostId || epoch.bootId!==session.bootId || epoch.supervisorId!==session.supervisorId ||
      epoch.outerRuntime && epoch.outerRuntime.state!==HostedCustodyReservationState.Terminal ||
      epoch.reservations.some(row=>row.state!==HostedCustodyReservationState.Terminal) ||
      idle.previous.version!==3 || idle.previous.owner || idle.previous.generationContinuity?.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1 ||
      !encode(idle.binding).equals(encode(binding)) || !encode(idle.previous.workspace).equals(encode(binding.workspace)) ||
      !encode(binding.workspace).equals(encode(material.evidence.workspace)) ||
      !sameDependencyProtectedReference(idle.previous.custodyBinding,material.reference) || !readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try{if(!encode(store.read(binding.workspace)).equals(encode(idle.previous)))held();}finally{store.close();}
  if(!encode(new HostedReadonlyEpochStore().readEpoch()).equals(encode(epoch)) ||
      !encode(readHostedReadonlyDependencyMaterial(fence,epoch.identity)).equals(encode(material)) ||
      !encode(readHostedDependencyBinding(binding.jobId)).equals(encode(binding)) ||
      !sameDependencyProtectedReference(pinReferenceFile(idle.idle.path,16384).reference,idle.idle) ||
      !sameDependencyProtectedReference(pinReferenceFile(idle.sourceClosed.path,65536).reference,idle.sourceClosed))held();
  boundary(fence,access);return true;
}
/** Capture this real R release chain while its exact Fenced Consumer still
 * exists. Historical discharge is never reconstructed from Terminal/absence. */
export function releaseOriginalHostedDependencyRSourceOwner(fence:HostedActivationFence,access:symbol):void {
  if(authenticateOriginalColdTransferBeforeFirstR(fence,access))return;
  if(!hasActiveOwner(fence,access)){releaseUnverifiedR(fence,access);return;}
  if(authenticateOriginalMaintenanceIdleBeforeR(fence,access))return;
  const before=selected(fence,access),previous=before.previous;
  if(!previous.owner){readOriginalHostedDependencyRIdleGeneration(fence,access);if(!readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();return;}
  if(before.epoch.phase!==HostedCustodyPhase.Closed || before.epoch.generation<=before.outer.generation ||
      before.epoch.reservations.some(row=>row.state!==HostedCustodyReservationState.Terminal) ||
      previous.owner && (!isDependencyConsumerOwner(previous.owner) || previous.owner.phase!==DependencyOwnerPhase.Fenced))held();
  const continuity=previous.generationContinuity;if(!continuity)held();
  const slot=continuity.kind===DependencyGenerationContinuityKind.BaselineAuthenticatedV1 ? continuity :
    readOriginalHostedDependencyRetiredInterval(fence,before.attempt,before.binding,previous,access).slot;
  const fencePin=pinReferenceFile(`${root}/dependency-attempt-fences/${before.outer.startId}.json`,4096);
  if(!fencePin.bytes.equals(encode({version:1,startId:before.outer.startId,attemptId:before.attempt.attemptId,epoch:before.attempt.epoch})))held();
  const baseline=readOriginalHostedDependencyGenerationBaselinePins(before.attempt,before.binding,slot,access),
    retirement=pinReferenceFile(`${root}/dependency-generation-source-retirements/${before.outer.startId}.json`,16384),retired:unknown=JSON.parse(retirement.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(retired,"attempt,barrier,baseline,binding,lifecycle,pending,qualification,version") || retired.version!==1 ||
      !encode(retired.attempt).equals(encode(before.attempt)) || !encode(retired.binding).equals(encode(before.binding)) ||
      !encode(retired.pending).equals(encode(baseline.pending.reference)) || !encode(retired.baseline).equals(encode(slot.baseline)) ||
      !encode(retired.barrier).equals(encode(slot.writerBarrier)) || (retired.lifecycle!==ClosureKind.RuntimeNeverConfigured && retired.lifecycle!==ClosureKind.ConfiguredRuntimeDischarged) ||
      !isDependencyProtectedReference(retired.qualification) || retired.qualification.path!==`${root}/${dependencyToolQualificationRecordName(before.outer.startId)}` ||
      !sameDependencyProtectedReference(pinReferenceFile(retired.qualification.path,16384).reference,retired.qualification) || !retirement.bytes.equals(encode(retired)))held();
  const closurePath=`${root}/dependency-generation-source-closures/${before.outer.startId}.json`,existing=readHostedPrivateBytes(closurePath,65536);
  let providers:unknown;
  if(!previous.owner) {
    if(!existing)held();const v:unknown=JSON.parse(existing.toString("utf8"));
    if(!isDependencyCustodyObject(v,"attempt,barrier,baseline,binding,identity,outer,parent,pending,providers,retirement,version") ||
        v.version!==2 || !existing.equals(encode(v)))held();
    providers=oldProviders(fence,access,v.providers,before);
  }else {
    providers=providerRows(fence,access,before.epoch,before.outer).map(row=>{
      const proof=readOriginalHostedManagedProviderCreator(fence,row.startId,access);
      if(!encode(proof.attempt).equals(encode(before.attempt)) || !encode(proof.row).equals(encode(row)))held();
      before.kernel.drainQueuedStart(row);before.kernel.confirmTerminalDescendants(row);return proof;
    });
  }
  assertHostedDependencyInstallerAttemptDrained(before.attempt);boundary(fence,access);
  const record={version:2,attempt:before.attempt,binding:before.binding,identity:before.epoch.identity,parent:before.parent.reference,
    outer:before.outer,providers,pending:baseline.pending.reference,barrier:slot.writerBarrier,baseline:slot.baseline,retirement:retirement.reference},bytes=encode(record);
  if(bytes.length>65536 || existing && !existing.equals(bytes))held();
  ensureHostedDependencyDirectory(root+"/dependency-generation-source-closures");createReadonlyPrivateRecord(closurePath,bytes);
  const closure=pinReferenceFile(closurePath,65536);if(!closure.bytes.equals(bytes))held();
  const fresh=selected(fence,access);if(!encode(fresh.previous).equals(encode(previous)) || !encode(fresh.epoch).equals(encode(before.epoch)) ||
      !encode(readHostedDependencyActiveActorFacts(fence,access)).equals(encode(baseline.baseline.actors)) ||
      !readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();
  if(!previous.owner){boundary(fence,access);return;}
  const idlePath=`${root}/dependency-generation-idle-closures/${before.binding.workspace.dev}-${before.binding.workspace.ino}/${previous.revision+1}.json`,
    oldIdle=readHostedPrivateBytes(idlePath,16384);
  let pinned:ReturnType<typeof parseDependencyOwner>|undefined;
  if(oldIdle) {
    const v:unknown=JSON.parse(oldIdle.toString("utf8"));
    if(!isDependencyCustodyObject(v,"attempt,binding,previousOwnerSha256,releasedOwner,releasedOwnerSha256,sourceClosed,version") ||
        v.version!==1 || !oldIdle.equals(encode(v)) || v.previousOwnerSha256!==hash(previous) || !encode(v.attempt).equals(encode(before.attempt)) ||
        !encode(v.binding).equals(encode(before.binding)) || !isDependencyProtectedReference(v.sourceClosed) || !sameDependencyProtectedReference(v.sourceClosed,closure.reference))held();
    pinned=parseDependencyOwner(v.releasedOwner);if(v.releasedOwnerSha256!==hash(pinned))held();
  }
  const activity=previous.activity?.lastEntry?.epoch===before.attempt.epoch ? {
    lastEntry:previous.activity.lastEntry,lastRelease:{epoch:before.attempt.epoch,atMs:pinned?.activity?.lastRelease?.atMs??String(Date.now())}} : undefined;
  const expected=parseDependencyOwner({...previous,revision:previous.revision+1,owner:null,...(activity?{activity}:{})});
  if(pinned && !encode(pinned).equals(encode(expected)))held();
  const idleBytes=encode({version:1,attempt:before.attempt,binding:before.binding,previousOwnerSha256:hash(previous),
    releasedOwner:expected,releasedOwnerSha256:hash(expected),sourceClosed:closure.reference});
  if(oldIdle && !oldIdle.equals(idleBytes))held();ensureHostedDependencyDirectory(idlePath.slice(0,idlePath.lastIndexOf("/")));
  createReadonlyPrivateRecord(idlePath,idleBytes);const idle=pinReferenceFile(idlePath,16384);if(!idle.bytes.equals(idleBytes))held();
  const ready=selected(fence,access);if(!encode(ready.previous).equals(encode(previous)) || !encode(ready.epoch).equals(encode(before.epoch)))held();
  boundary(fence,access);
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384,generationBaselineVerifier:{
    assertGenerationBaselineTransition({previousOwner,proposedOwner}) {
      assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
      if(!encode(previousOwner).equals(encode(previous)) || !encode(proposedOwner).equals(encode(expected)))held();
    },
  }});
  try{store.compareAndSwap(before.binding.workspace,previous.revision,expected);
    if(!encode(store.read(before.binding.workspace)).equals(encode(expected)))held();
  }finally{store.close();}
  const after=selected(fence,access);if(!encode(after.previous).equals(encode(expected)) || !encode(after.epoch).equals(encode(before.epoch)) ||
      !sameDependencyProtectedReference(pinReferenceFile(closurePath,65536).reference,closure.reference) ||
      !sameDependencyProtectedReference(pinReferenceFile(idlePath,16384).reference,idle.reference))held();
  boundary(fence,access);
}

/** Fixed fresh operator selection of durable old R discharge. The current
 * enrolled structural custody remains live; this fact cannot renew/reissue it. */
export function readOriginalHostedDependencyRIdleGeneration(fence:HostedActivationFence,access:symbol) {
  boundary(fence,access);const epoch=new HostedReadonlyEpochStore().readEpoch(),material=readHostedReadonlyDependencyMaterial(fence,epoch.identity),
    binding=readHostedDependencyBinding(material.evidence.candidate.jobId);if(!binding || binding.version!==2)held();
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let previous:ReturnType<LocalDependencyOwnerStore["read"]>;
  try{previous=store.read(binding.workspace);}finally{store.close();}
  if(!previous || previous.version!==3 || previous.owner || (previous.generationContinuity?.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1 && previous.generationContinuity?.kind!==DependencyGenerationContinuityKind.RetiredReadyV1) ||
      !sameDependencyProtectedReference(previous.custodyBinding,material.reference))held();
  const path=`${root}/dependency-generation-idle-closures/${binding.workspace.dev}-${binding.workspace.ino}/${previous.revision}.json`,pin=pinReferenceFile(path,16384),
    v:unknown=JSON.parse(pin.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(v,"attempt,binding,previousOwnerSha256,releasedOwner,releasedOwnerSha256,sourceClosed,version") || v.version!==1 ||
      !pin.bytes.equals(encode(v)) || !encode(parseDependencyOwner(v.releasedOwner)).equals(encode(previous)) || v.releasedOwnerSha256!==hash(previous) ||
      !encode(v.binding).equals(encode(binding)) || !isDependencyCustodyObject(v.attempt,"attemptId,epoch,launch") ||
      !isDependencyCustodyObject(v.attempt.launch,"association,bootId,grantDigest,installationId,kind,origin,runtimeSha,startId,unit") ||
      typeof v.attempt.launch.startId!=="string" || !isDependencyProtectedReference(v.sourceClosed) ||
      v.sourceClosed.path!==`${root}/dependency-generation-source-closures/${v.attempt.launch.startId}.json`)held();
  const selectedOld=selected(fence,access,v.attempt.launch.startId),closed=pinReferenceFile(v.sourceClosed.path,65536),c:unknown=JSON.parse(closed.bytes.toString("utf8"));
  if(!sameDependencyProtectedReference(closed.reference,v.sourceClosed) || !isDependencyCustodyObject(c,"attempt,barrier,baseline,binding,identity,outer,parent,pending,providers,retirement,version") ||
      c.version!==2 || !closed.bytes.equals(encode(c)) || !encode(c.attempt).equals(encode(selectedOld.attempt)) || !encode(c.attempt).equals(encode(v.attempt)) ||
      !encode(c.binding).equals(encode(binding)) || !encode(c.identity).equals(encode(epoch.identity)) || !encode(c.outer).equals(encode(selectedOld.outer)) ||
      !encode(c.parent).equals(encode(selectedOld.parent.reference)) || !encode(selectedOld.previous).equals(encode(previous)))held();
  oldProviders(fence,access,c.providers,selectedOld);assertHostedDependencyInstallerAttemptDrained(selectedOld.attempt);
  const slot=previous.generationContinuity.kind===DependencyGenerationContinuityKind.BaselineAuthenticatedV1 ? previous.generationContinuity :
    readOriginalHostedDependencyRetiredInterval(fence,selectedOld.attempt,binding,previous,access).slot;
  const baseline=readOriginalHostedDependencyGenerationBaselinePins(selectedOld.attempt,binding,slot,access);
  if(!encode(c.pending).equals(encode(baseline.pending.reference)) || !encode(c.barrier).equals(encode(slot.writerBarrier)) ||
      !encode(c.baseline).equals(encode(slot.baseline)) || !isDependencyProtectedReference(c.retirement) ||
      c.retirement.path!==`${root}/dependency-generation-source-retirements/${selectedOld.outer.startId}.json` ||
      !sameDependencyProtectedReference(pinReferenceFile(c.retirement.path,16384).reference,c.retirement))held();
  if(!sameDependencyProtectedReference(pinReferenceFile(path,16384).reference,pin.reference) ||
      !encode(new HostedReadonlyEpochStore().readEpoch()).equals(encode(epoch)))held();boundary(fence,access);
  return Object.freeze({binding,previous,idle:pin.reference,sourceClosed:closed.reference});
}

/** Original durable R chain + fresh native drains. An old Terminal row without
 * this privately produced chain remains unclassified, never fabricated history. */
export function readOriginalHostedDependencyPriorRSourceClosure(fence:HostedActivationFence,unit:string,access:symbol):readonly string[]|undefined {
  return priorR(undefined,fence,unit,access);
}
export function readOriginalHostedDependencyConsumerPriorRSourceClosure(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,unit:string,access:symbol):readonly string[]|undefined {
  return priorR(context,fence,unit,access);
}
function historicalSession(context:CurrentHostedDependencyOrigin|undefined,fence:HostedActivationFence,access:symbol,kernel:HostedReadonlyHostKernel) {
  if(!context)return kernel.operatorSession();
  const scope=readOriginalHostedDependencyGenerationNativeScope(context,fence,access);
  return scope.facts.kind===CurrentHostedDependencyOriginKind.Ordinary?kernel.ordinaryRuntimeSession(parseHostedOrdinaryStart(scope.facts.ordinary.start)):kernel.session();
}
function drainHistoricalOuter(context:CurrentHostedDependencyOrigin|undefined,fence:HostedActivationFence,access:symbol,kernel:HostedReadonlyHostKernel,outer:HostedCustodyOuterRuntime,bootId:string) {
  const scope=context?readOriginalHostedDependencyGenerationNativeScope(context,fence,access):undefined;
  if(scope?.facts.kind===CurrentHostedDependencyOriginKind.Ordinary) {
    const session=kernel.ordinaryRuntimeSession(parseHostedOrdinaryStart(scope.facts.ordinary.start)),pin=pinReferenceFile(completionPath(outer),4096);
    if(bootId!==session.bootId || outer.state!==HostedCustodyReservationState.Terminal || !pin.bytes.equals(completionBytes(outer,0)))held();
    kernel.drainQueuedStart(outer);kernel.confirmTerminalDescendants(outer);
    if(!sameDependencyProtectedReference(pinReferenceFile(pin.reference.path,4096).reference,pin.reference))held();
  } else {kernel.fenceCreator(outer,bootId,fence);kernel.drainQueuedStart(outer);kernel.confirmTerminalDescendants(outer);}
}
function historicalBoundary(context:CurrentHostedDependencyOrigin|undefined,fence:HostedActivationFence,access:symbol):void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  if(context)readOriginalHostedDependencyGenerationNativeScope(context,fence,access);else {assertHostedActivationOperator();assertOriginalHostedDependencyOperatorDescriptors(fence,access);if(!readOriginalHostedDependencyRemoverScope(fence,access))new HostedReadonlyHostKernel().operatorSession();}
}
function priorR(context:CurrentHostedDependencyOrigin|undefined,fence:HostedActivationFence,unit:string,access:symbol):readonly string[]|undefined {
  historicalBoundary(context,fence,access);const match=/^subscription-runtime-(?:outer|hosted)-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.service$/.exec(unit);
  if(!match || match[0]!==unit)return undefined;const epoch=new HostedReadonlyEpochStore().readEpoch();let parentId=match[1]!;
  if(unit.startsWith("subscription-runtime-hosted-")) {
    const bytes=readHostedPrivateBytes(`${root}/dependency-managed-provider-starts/${parentId}.json`,16384);if(!bytes)return undefined;
    const birth:unknown=JSON.parse(bytes.toString("utf8"));if(!birth || typeof birth!=="object" || !("parentStartId" in birth) || typeof birth.parentStartId!=="string")held();parentId=birth.parentStartId;
  }
  if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(parentId)?.[0]!==parentId)held();
  const path=`${root}/dependency-generation-source-closures/${parentId}.json`,bytes=readHostedPrivateBytes(path,65536);if(!bytes)return undefined;
  const closure=pinReferenceFile(path,65536),v:unknown=JSON.parse(closure.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(v,"attempt,barrier,baseline,binding,identity,outer,parent,pending,providers,retirement,version") || v.version!==2 ||
      !closure.bytes.equals(encode(v)) || !encode(v.identity).equals(encode(epoch.identity)))held();
  const outer=parseHostedCustodyEpoch({...epoch,outerRuntime:v.outer}).outerRuntime;if(!outer || outer.startId!==parentId || outer.state!==HostedCustodyReservationState.Terminal)held();
  const parent=readHostedReadonlyDependencyStart(fence,parentId),material=readHostedReadonlyDependencyMaterial(fence,epoch.identity),binding=readHostedDependencyBinding(parent.value.candidateJobId);
  if(!binding || binding.version!==2 || !encode(v.binding).equals(encode(binding)) || !isDependencyProtectedReference(v.parent) ||
      !sameDependencyProtectedReference(v.parent,parent.reference) || parent.value.unit!==outer.unit || parent.value.creatorId!==outer.creatorId ||
      parent.value.generation!==outer.generation || parent.value.bootId!==epoch.bootId || parent.value.hostId!==epoch.hostId || parent.value.supervisorId!==epoch.supervisorId ||
      !sameDependencyProtectedReference(parent.value.association,material.reference))held();
  const preclaim=pinReferenceFile(`${root}/dependency-reader-starts/${parentId}.json`,16384),c:unknown=JSON.parse(preclaim.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(c,"attempt,binding,custody,kind,origin,ownerRevision,ownerSha256,receipt,version,workspace") || c.version!==1 ||
      !preclaim.bytes.equals(encode(c)) || !encode(c.attempt).equals(encode(v.attempt)) || !encode(c.workspace).equals(encode(binding.workspace)) ||
      !isDependencyProtectedReference(c.origin) || !sameDependencyProtectedReference(c.origin,parent.reference) || !isDependencyProtectedReference(c.custody) ||
      !sameDependencyProtectedReference(c.custody,material.reference))held();
  const attemptOwner=parseDependencyOwner({version:3,workspace:binding.workspace,revision:1,custodyBinding:material.reference,
    owner:{kind:DependencyOwnerKind.Consumer,phase:DependencyOwnerPhase.Fenced,attempt:v.attempt},epoch:isDependencyCustodyObject(v.attempt,"attemptId,epoch,launch")?v.attempt.epoch:undefined});
  if(!isDependencyConsumerOwner(attemptOwner.owner))held();const attempt=attemptOwner.owner.attempt;
  if(attempt.launch.startId!==parentId || attempt.launch.unit!==outer.unit || attempt.launch.installationId!==binding.installationId ||
      attempt.launch.runtimeSha!==binding.runtimeSha || attempt.launch.grantDigest!==binding.grantDigest || attempt.launch.bootId!==epoch.bootId)held();
  const entry=pinReferenceFile(`${root}/dependency-reader-entries/${parentId}.json`,4096);
  if(!entry.bytes.equals(encode({version:1,producer:preclaim.reference,attempt})))held();
  const kernel=new HostedReadonlyHostKernel();drainHistoricalOuter(context,fence,access,kernel,outer,epoch.bootId);
  // Reuse only the closed provider reference/native reader. It accepts no owner
  // scope or grant and cannot manufacture a missing positive completion.
  const current=providerRows(fence,access,epoch,outer);
  if(!Array.isArray(v.providers) || v.providers.length!==current.length || current.length>128)held();
  for(let i=0;i<current.length;i++) {
    const old:unknown=v.providers[i],row=current[i]!;
    if(!isDependencyCustodyObject(old,"attempt,birth,completion,entry,material,parent,preclaim,preparation,profile,qualification,receipt,row") ||
        !encode(old.row).equals(encode(row)) || !encode(old.attempt).equals(encode(attempt)))held();
    const receipt=context ? readOriginalHostedManagedConsumerProviderDischargedReceipt(context,fence,row.startId,access) :
      readOriginalHostedManagedProviderDischargedReceipt(fence,row.startId,access);
    if(!isDependencyProtectedReference(old.completion) || !sameDependencyProtectedReference(receipt.completion,old.completion) ||
        !encode(receipt.receipt).equals(encode(old.receipt)) || !encode(receipt.receipt.parentAttempt).equals(encode(attempt)) ||
        !isDependencyProtectedReference(old.birth) || !sameDependencyProtectedReference(receipt.receipt.providerReference,old.birth))held();
    for(const key of ["birth","entry","material","parent","preclaim","preparation","profile","qualification"] as const) {
      const ref=old[key];if(!isDependencyProtectedReference(ref) || !ref.path.startsWith(root+"/") ||
          !sameDependencyProtectedReference(pinReferenceFile(ref.path,key==="preparation"?65536:16384).reference,ref))held();
    }
  }
  if(!isDependencyProtectedReference(v.retirement) || v.retirement.path!==`${root}/dependency-generation-source-retirements/${parentId}.json`)held();
  const retiredPin=pinReferenceFile(v.retirement.path,16384),retired:unknown=JSON.parse(retiredPin.bytes.toString("utf8"));
  if(!sameDependencyProtectedReference(retiredPin.reference,v.retirement) || !isDependencyCustodyObject(retired,"attempt,barrier,baseline,binding,lifecycle,pending,qualification,version") ||
      retired.version!==1 || !retiredPin.bytes.equals(encode(retired)) || !encode(retired.attempt).equals(encode(attempt)) || !encode(retired.binding).equals(encode(binding)) ||
      !encode(retired.pending).equals(encode(v.pending)) || !encode(retired.barrier).equals(encode(v.barrier)) || !encode(retired.baseline).equals(encode(v.baseline)) ||
      (retired.lifecycle!==ClosureKind.RuntimeNeverConfigured && retired.lifecycle!==ClosureKind.ConfiguredRuntimeDischarged) ||
      !isDependencyProtectedReference(retired.qualification) || retired.qualification.path!==`${root}/${dependencyToolQualificationRecordName(parentId)}` ||
      !sameDependencyProtectedReference(pinReferenceFile(retired.qualification.path,16384).reference,retired.qualification))held();
  for(const key of ["pending","barrier","baseline"] as const) {
    const ref=v[key];if(!isDependencyProtectedReference(ref) || !ref.path.startsWith(root+"/dependency-generation-") ||
        !sameDependencyProtectedReference(pinReferenceFile(ref.path,key==="baseline"?65536:16384).reference,ref))held();
  }
  const attemptFence=pinReferenceFile(`${root}/dependency-attempt-fences/${parentId}.json`,4096);
  if(!attemptFence.bytes.equals(encode({version:1,startId:parentId,attemptId:attempt.attemptId,epoch:attempt.epoch})))held();
  assertHostedDependencyInstallerAttemptDrained(attempt);
  if(!sameDependencyProtectedReference(pinReferenceFile(path,65536).reference,closure.reference) || !encode(new HostedReadonlyEpochStore().readEpoch()).equals(encode(epoch)))held();
  historicalBoundary(context,fence,access);return Object.freeze([outer.unit,...current.map(row=>row.unit)]);
}
