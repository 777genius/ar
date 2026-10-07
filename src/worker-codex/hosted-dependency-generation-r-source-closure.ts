import { readOriginalHostedDependencyOperatorNativeCensus } from "./hosted-dependency-generation-native-census";
import { readHostedDependencyActiveActorFacts } from "./hosted-dependency-active-actor-facts";
import { readOriginalHostedDependencyGenerationNativeScope } from "./hosted-dependency-generation-native-scope";
import { createHash } from "node:crypto";
import { DependencyGenerationContinuityKind, DependencyOwnerKind, DependencyOwnerPhase, isDependencyConsumerOwner,
  isDependencyCustodyObject, isDependencyProtectedReference, parseDependencyOwner, sameDependencyAttempt,
  sameDependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { fenceDependencyConsumer, HostedCustodyPhase, HostedCustodyReservationState, parseHostedCustodyEpoch } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedForegroundResult, readHostedForegroundLaunchObservation, type HostedForegroundResult } from "../provider-codex/app-server/adapters/hosted-fd-launch";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { hostedDependencyOwnerRoot, readHostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedReadonlyDependencyStart } from "../provider-codex/app-server/adapters/hosted-dependency-origin";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { dependencyToolQualificationRecordName } from "../core/dependency-environment/dependency-tool-profile";
import { assertOriginalHostedDependencyPhysicalRecordAccess, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { HostedDependencySourceRuntimeClosureKind as ClosureKind } from "./hosted-dependency-generation-state";
import { readOriginalHostedDependencyGenerationBaselinePins } from "./hosted-dependency-generation-source-closure";
import { readOriginalHostedManagedProviderCreator, readOriginalHostedManagedProviderDischargedReceipt, readOriginalHostedManagedConsumerProviderDischargedReceipt } from "./hosted-managed-provider-failure-recovery";
import { readHostedReadonlyDependencyMaterial } from "./hosted-readonly-dependency-records";
import { HostedReadonlyEpochStore } from "./hosted-readonly-epoch-store";
import { HostedReadonlyHostKernel, HostedReadonlyRuntimeRole, completionPath, completionBytes } from "./hosted-readonly-host-kernel";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { ensureHostedDependencyDirectory } from "./hosted-dependency-receipts";
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
  try{const owner=store.read(binding.workspace);return !!owner && owner.version===3 && owner.generationContinuity?.kind===DependencyGenerationContinuityKind.BaselineAuthenticatedV1;}
  finally{store.close();}
}
function selected(fence:HostedActivationFence,access:symbol,startId?:string) {
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
  if(epoch.revoked || !outer || outer.state!==HostedCustodyReservationState.Terminal || epoch.bootId!==session.bootId ||
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
      previous.generationContinuity?.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1)held();
  const decoded=parseDependencyOwner({...previous,owner:{kind:DependencyOwnerKind.Consumer,phase:DependencyOwnerPhase.Fenced,attempt:claim.attempt}});
  if(!isDependencyConsumerOwner(decoded.owner))held();const attempt=decoded.owner.attempt;
  if(attempt.epoch!==previous.epoch || attempt.launch.startId!==outer.startId || attempt.launch.unit!==outer.unit ||
      attempt.launch.bootId!==epoch.bootId || attempt.launch.installationId!==binding.installationId || attempt.launch.runtimeSha!==binding.runtimeSha ||
      attempt.launch.grantDigest!==binding.grantDigest || previous.owner && (!isDependencyConsumerOwner(previous.owner) || !sameDependencyAttempt(previous.owner.attempt,attempt)))held();
  const entry=pinReferenceFile(`${root}/dependency-reader-entries/${outer.startId}.json`,4096);
  if(!entry.bytes.equals(encode({version:1,producer:preclaim.reference,attempt})))held();
  kernel.fenceCreator(outer,epoch.bootId,fence);kernel.drainQueuedStart(outer);kernel.confirmTerminalDescendants(outer);
  boundary(fence,access);return {epoch,outer,parent,material,binding,previous,attempt,preclaim,entry,kernel};
}
/** Real retained FDA foreground identity fences ONLY its own current R owner.
 * No completion/status DTO, absent PID, parent Runtime rename or borrowed C
 * context can publish this transition. Native discharge remains separately due. */
export function fenceOriginalHostedDependencyRSourceOwner(fence:HostedActivationFence,result:HostedForegroundResult,access:symbol):void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedForegroundResult(result);
  if(result.exitCode!==0)held();if(!hasActiveOwner(fence,access))return;const observed=readHostedForegroundLaunchObservation(result),facts=selected(fence,access),previous=facts.previous;
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
function oldProviders(fence:HostedActivationFence,access:symbol,value:unknown,facts:ReturnType<typeof selected>) {
  if(!Array.isArray(value) || value.length>128)held();
  const current=facts.epoch.reservations.filter(row=>row.generation===facts.outer.generation);
  if(value.length!==current.length)held();
  for(let index=0;index<value.length;index++) {
    const v:unknown=value[index],row=current[index]!;
    if(!isDependencyCustodyObject(v,"attempt,birth,completion,entry,material,parent,preclaim,preparation,profile,qualification,receipt,row") ||
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
    const native=readOriginalHostedManagedProviderDischargedReceipt(fence,row.startId,access);
    if(!encode(native.receipt).equals(encode(v.receipt)) || !sameDependencyProtectedReference(native.completion,v.completion))held();
  }
  return value;
}
/** Capture this real R release chain while its exact Fenced Consumer still
 * exists. Historical discharge is never reconstructed from Terminal/absence. */
export function releaseOriginalHostedDependencyRSourceOwner(fence:HostedActivationFence,access:symbol):void {
  if(!hasActiveOwner(fence,access))return;const before=selected(fence,access),previous=before.previous;
  if(!previous.owner){readOriginalHostedDependencyRIdleGeneration(fence,access);if(!readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();return;}
  if(before.epoch.phase!==HostedCustodyPhase.Closed || before.epoch.generation<=before.outer.generation ||
      before.epoch.reservations.some(row=>row.state!==HostedCustodyReservationState.Terminal) ||
      previous.owner && (!isDependencyConsumerOwner(previous.owner) || previous.owner.phase!==DependencyOwnerPhase.Fenced))held();
  const slot=previous.generationContinuity;if(slot?.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1)held();
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
    providers=before.epoch.reservations.filter(row=>row.generation===before.outer.generation).map(row=>{
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
  if(!previous || previous.version!==3 || previous.owner || previous.generationContinuity?.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1 ||
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
  const baseline=readOriginalHostedDependencyGenerationBaselinePins(selectedOld.attempt,binding,previous.generationContinuity,access);
  if(!encode(c.pending).equals(encode(baseline.pending.reference)) || !encode(c.barrier).equals(encode(previous.generationContinuity.writerBarrier)) ||
      !encode(c.baseline).equals(encode(previous.generationContinuity.baseline)) || !isDependencyProtectedReference(c.retirement) ||
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
function historicalBoundary(context:CurrentHostedDependencyOrigin|undefined,fence:HostedActivationFence,access:symbol):void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  if(context)readOriginalHostedDependencyGenerationNativeScope(context,fence,access);else boundary(fence,access);
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
  const kernel=new HostedReadonlyHostKernel();kernel.fenceCreator(outer,epoch.bootId,fence);kernel.drainQueuedStart(outer);kernel.confirmTerminalDescendants(outer);
  // Reuse only the closed provider reference/native reader. It accepts no owner
  // scope or grant and cannot manufacture a missing positive completion.
  const current=epoch.reservations.filter(row=>row.generation===outer.generation);
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
