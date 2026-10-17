import { constants as osConstants } from "node:os";
import { readdirSync } from "node:fs";
import { DependencyOwnerKind, DependencyOwnerPhase, DependencyGenerationContinuityKind, isDependencyCustodyObject, isDependencyProtectedReference,
  parseDependencyOwner, sameDependencyProtectedReference, type DependencyOwnerRecord, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedDependencyOwnerRoot } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { readOriginalHostedDependencyRemovalClaim, hostedDependencyRemovalRecordPath } from "./hosted-dependency-removal-context";
import { hostedDependencyRemovalAttempt, parseHostedDependencyRemovalActor, HostedDependencyRemovalRecordKind as Kind } from "./hosted-dependency-removal-records";
import { hostedDependencyRemovalOperations } from "./hosted-dependency-removal-ownership";
import { encodeReference as encode, pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { readHostedInstallationActivation } from "./hosted-installation-origin-facts";
import { collectProcessBirth, collectUnitShow, collectUnitNotFound, collectJobs } from "./hosted-readonly-linux-collector";
import { parseScopedManagerJobs } from "./hosted-readonly-observations";
import { readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
import { observeHostedDependencyRemoverRetirement, observeHostedDependencyRemoverCgroup, HostedRemoverCgroupObservation, type HostedRemoverRetirementFacts } from "./hosted-dependency-remover-retirement";
import { HostedManagedProviderWaitKind, HostedManagedProviderResult, matchesManagedProviderProxyWait, type HostedManagedProviderTerminalFacts } from "./hosted-managed-provider-terminal-facts";
import { readHostedDependencyCommittedAbsent, readHostedDependencyEstablishedReceipt } from "./hosted-dependency-receipts";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { HostedDependencyRemovalDisposition } from "./hosted-dependency-removal-effects";

function held():never{throw new Error("hosted_dependency_removal_history_held");}
function same(a:unknown,b:unknown):boolean{return encode(a).equals(encode(b));}
function reference(value:unknown):asserts value is DependencyProtectedReference{if(!isDependencyProtectedReference(value))held();}
/** Durable terminal was issued only by the original parent, from retained FDA
 * close. Revalidation keeps exact boot/supervisor, consumed+revoked association,
 * source pins and native jobs/cgroup. A missing current PID grants nothing. */
export function readOriginalHostedDependencyRemovalRetirement(fence:HostedActivationFence,operationId:string,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);assertHostedActivationOperator();
  const selected=readOriginalHostedDependencyRemovalClaim(operationId,access),claim=selected.claim,attempt=hostedDependencyRemovalAttempt(claim),
    pin=pinReferenceFile(hostedDependencyRemovalRecordPath(operationId,"retirement"),65536),v:unknown=JSON.parse(pin.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(v,"actor,claim,consumed,kind,lock,native,parentClosed,proxyRevoked,revoked,version") || v.version!==1 || v.kind!==Kind.Retirement ||
    !pin.bytes.equals(encode(v)) || !same(v.claim,selected.reference))held();
  for(const value of [v.actor,v.claim,v.consumed,v.revoked,v.lock])reference(value);
  reference(v.actor);reference(v.consumed);reference(v.revoked);reference(v.lock);
  const actorPin=pinReferenceFile(hostedDependencyRemovalRecordPath(operationId,"actor"),65536),actor=parseHostedDependencyRemovalActor(JSON.parse(actorPin.bytes.toString("utf8")),claim,selected.reference);
  if(!sameDependencyProtectedReference(actorPin.reference,v.actor) || !same(pinReferenceFile(v.consumed.path,16384).reference,v.consumed) ||
    !same(pinReferenceFile(v.revoked.path,16384).reference,v.revoked) || v.consumed.path!==hostedDependencyRemovalRecordPath(operationId,"consumed") ||
    v.revoked.path!==hostedDependencyRemovalRecordPath(operationId,"revoked") ||
    !pinReferenceFile(v.consumed.path,16384).bytes.equals(encode({version:1,claim:selected.reference,actor:actorPin.reference})) ||
    !pinReferenceFile(v.revoked.path,16384).bytes.equals(encode({version:1,claim:selected.reference,actor:actorPin.reference})))held();
  if(!pinReferenceFile(hostedDependencyRemovalRecordPath(operationId,"submitted"),16384).bytes.equals(encode({version:1,claim:selected.reference,
    unit:actor.actor.unit,parentBirth:actor.parent.pidBirth,controlGroup:`0::${actor.parent.controlGroup}`,bootstrap:actor.bootstrap})))held();
  const actual=readHostedInstallationActivation(),inventory=readHostedReadonlyHostInventory(),supervisor=inventory.units.find(row=>row.name===inventory.supervisorUnit);
  if(!supervisor || actual.activation.bootId!==attempt.host.bootId || actual.activation.supervisorId!==attempt.host.supervisorId ||
    actual.installation.installationId!==attempt.host.installationId || actual.installation.runtimeSha!==attempt.host.runtimeSha ||
    actual.installation.inventorySha256!==attempt.host.inventoryDigest || collectProcessBirth(collectUnitShow(supervisor.name).MainPID??"")!==attempt.host.supervisorId)held();
  const close=v.parentClosed,native=v.native;
  if(close===null) {
    reference(v.proxyRevoked);const proxy=pinReferenceFile(hostedDependencyRemovalRecordPath(operationId,"proxy-revoked"),16384);
    if(!sameDependencyProtectedReference(proxy.reference,v.proxyRevoked) || !proxy.bytes.equals(encode({version:1,claim:selected.reference,actor:actorPin.reference,
      pidBirth:actor.proxy.pidBirth,controlGroup:actor.proxy.controlGroup,bootId:actor.actor.bootId,supervisorId:actor.actor.supervisorId})))held();
  } else if(v.proxyRevoked!==null || !isDependencyCustodyObject(close,"actorBirth,exitCode,invocationId,proxyBirth,signal,unit") ||
    close.actorBirth!==actor.actor.pidBirth || close.proxyBirth!==actor.proxy.pidBirth || close.unit!==actor.actor.unit || close.invocationId!==actor.actor.invocationId ||
    !(close.signal===null && typeof close.exitCode==="number" && Number.isInteger(close.exitCode) && close.exitCode>=0 && close.exitCode<=255 ||
      close.exitCode===null && typeof close.signal==="string" && Object.hasOwn(osConstants.signals,close.signal)))held();
  if(!isDependencyCustodyObject(native,"cgroup,cgroupSha256,terminal") ||
    native.cgroup!==HostedRemoverCgroupObservation.Empty && native.cgroup!==HostedRemoverCgroupObservation.Absent ||
    typeof native.cgroupSha256!=="string" || /^[a-f0-9]{64}$/.exec(native.cgroupSha256)?.[0]!==native.cgroupSha256 ||
    !isDependencyCustodyObject(native.terminal,"invocationId,kind,result,status,unit"))held();
  const terminal=native.terminal;
  if(terminal.unit!==actor.actor.unit || terminal.invocationId!==actor.actor.invocationId || typeof terminal.status!=="number" || !Number.isInteger(terminal.status) ||
    !(terminal.kind===HostedManagedProviderWaitKind.Exited && (terminal.status===0 && terminal.result===HostedManagedProviderResult.Success ||
      terminal.status>0 && terminal.status<=255 && terminal.result===HostedManagedProviderResult.ExitCode) ||
      terminal.kind===HostedManagedProviderWaitKind.Killed && terminal.status>0 && terminal.status<=64 && terminal.result===HostedManagedProviderResult.Signal))held();
  const facts:HostedRemoverRetirementFacts={cgroup:native.cgroup,cgroupSha256:native.cgroupSha256,terminal:terminal as HostedManagedProviderTerminalFacts};
  if(close!==null && isDependencyCustodyObject(close,"actorBirth,exitCode,invocationId,proxyBirth,signal,unit") && close.signal===null &&
    !matchesManagedProviderProxyWait(facts.terminal,actor.actor.invocationId,close.exitCode as number))held();
  if(collectUnitNotFound(actor.actor.unit)) {
    if(parseScopedManagerJobs(collectJobs()).some(job=>job.unit===actor.actor.unit))held();
    const fresh=observeHostedDependencyRemoverCgroup(actor.actor.unit,10000);
    if(fresh.cgroup!==HostedRemoverCgroupObservation.Absent && !same(fresh,{cgroup:facts.cgroup,cgroupSha256:facts.cgroupSha256}))held();
    if(!collectUnitNotFound(actor.actor.unit) || parseScopedManagerJobs(collectJobs()).some(job=>job.unit===actor.actor.unit))held();
  } else {
    const fresh=observeHostedDependencyRemoverRetirement(actor.actor.unit,actor.actor.invocationId,10000);
    if(!same(fresh.terminal,facts.terminal) || fresh.cgroup!==HostedRemoverCgroupObservation.Absent && !same(fresh,facts))held();
  }
  for(const ref of [claim.originalIdle,claim.sourceClosed,claim.header,claim.absent.reference])if(!same(pinReferenceFile(ref.path,65536).reference,ref))held();
  if(!same(pinReferenceFile(pin.reference.path,65536).reference,pin.reference))held();assertHostedActivationFence(fence);
  return {selected,actor,actorReference:actorPin.reference,retirement:pin.reference,lock:v.lock,native:facts};
}
export function readOriginalHostedDependencyRemovalIdle(fence:HostedActivationFence,workspace:DependencyOwnerRecord["workspace"],access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});let previous;try{previous=store.read(workspace);}finally{store.close();}
  if(!previous || previous.version===1 || previous.owner || previous.generationContinuity?.kind!==DependencyGenerationContinuityKind.RetiredEvictingV1)return undefined;
  const path=`${hostedDependencyRemovalOperations}/${workspace.dev}-${workspace.ino}-${previous.revision}.removal-idle.json`,bytes=readHostedPrivateBytes(path,65536);if(!bytes)return undefined;
  const pin=pinReferenceFile(path,65536),proof=readOriginalHostedDependencyRemovalRelease(fence,pin.reference,access);
  if(!same(proof.previous,previous))held();const again=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try{if(!same(again.read(workspace),previous))held();}finally{again.close();}return proof;
}
/** Authenticated release history remains factual after the own custody claim.
 * Current admission separately compares its exact deterministic successor. */
export function readOriginalHostedDependencyRemovalRelease(fence:HostedActivationFence,release:DependencyProtectedReference,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  const pin=pinReferenceFile(release.path,65536),v:unknown=JSON.parse(pin.bytes.toString("utf8"));
  if(!sameDependencyProtectedReference(pin.reference,release) || !isDependencyCustodyObject(v,"claim,completion,fenced,kind,released,retirement,version") ||
    v.version!==1 || v.kind!==Kind.Idle || !pin.bytes.equals(encode(v)))held();
  const previous=parseDependencyOwner(v.released),workspace=previous.workspace;
  if(previous.version===1 || previous.owner || previous.generationContinuity?.kind!==DependencyGenerationContinuityKind.RetiredEvictingV1 ||
    release.path!==`${hostedDependencyRemovalOperations}/${workspace.dev}-${workspace.ino}-${previous.revision}.removal-idle.json`)held();
  reference(v.claim);reference(v.retirement);reference(v.completion);
  const fenced=parseDependencyOwner(v.fenced);if(fenced.owner?.kind!==DependencyOwnerKind.Maintenance || fenced.owner.phase!==DependencyOwnerPhase.Fenced ||
    !same(parseDependencyOwner({...fenced,revision:fenced.revision+1,owner:null}),previous))held();
  const proof=readOriginalHostedDependencyRemovalRetirement(fence,fenced.owner.attempt.operationId,access),claim=proof.selected.claim;
  if(!same(v.claim,proof.selected.reference) || !same(v.retirement,proof.retirement) || !same(fenced,parseDependencyOwner({...claim.claimed,revision:claim.claimed.revision+1,owner:{...claim.claimed.owner,phase:DependencyOwnerPhase.Fenced}})) ||
    !same(pinReferenceFile(v.completion.path,16384).reference,v.completion) || v.completion.path!==hostedDependencyRemovalRecordPath(fenced.owner.attempt.operationId,"session-closed"))held();
  const completion:unknown=JSON.parse(pinReferenceFile(v.completion.path,16384).bytes.toString("utf8"));
  if(!isDependencyCustodyObject(completion,"actor,claim,disposition,kind,removedEntries,version") || completion.version!==1 || completion.kind!==Kind.SessionClosed ||
    !same(completion.claim,v.claim) || !same(completion.actor,proof.actorReference) ||
    !(completion.disposition===HostedDependencyRemovalDisposition.Removed && typeof completion.removedEntries==="number" && Number.isSafeInteger(completion.removedEntries) && completion.removedEntries>0 ||
      completion.disposition===HostedDependencyRemovalDisposition.RecoveredAbsent && completion.removedEntries===null))held();
  if(readHostedPrivateBytes(`${hostedDependencyRemovalOperations}/${claim.absent.receipt.operationId}.remove.lock`,65536) ||
    !same(readHostedDependencyCommittedAbsent(claim.binding,claim.absent.receipt.revision),claim.absent) ||
    !same(readHostedDependencyEstablishedReceipt(claim.binding),claim.absent.receipt))held();
  assertHostedActivationFence(fence);return {binding:claim.binding,previous,idle:pin.reference,sourceClosed:claim.sourceClosed,attempt:fenced.owner.attempt,claim,retirement:proof.retirement,priorAbsent:claim.absent,removedEntries:typeof completion.removedEntries==="number" ? completion.removedEntries : null};
}
/** Closed original lifetimes participate in census even after manager GC. */
export function readOriginalHostedDependencyDischargedRemovalUnits(fence:HostedActivationFence,access:symbol):readonly string[] {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);let names:string[];
  try{names=readdirSync(hostedDependencyRemovalOperations);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;return Object.freeze([]);}if(names.length>4096)held();
  const units:string[]=[];for(const name of names.filter(name=>name.endsWith(".removal-retirement.json"))) {
    const id=name.slice(0,-".removal-retirement.json".length),proof=readOriginalHostedDependencyRemovalRetirement(fence,id,access);units.push(proof.actor.actor.unit);
  }
  return Object.freeze(units);
}
