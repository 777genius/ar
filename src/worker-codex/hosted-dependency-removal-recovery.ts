import { DependencyOwnerKind, DependencyOwnerPhase, isDependencyCustodyObject, parseDependencyOwner, sameDependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { observeHostedFdProcess } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { readOriginalHostedDependencyRemovalClaim, hostedDependencyRemovalRecordPath } from "./hosted-dependency-removal-context";
import { hostedDependencyRemovalAttempt, parseHostedDependencyRemovalActor, parseHostedDependencyRemovalLock, HostedDependencyRemovalRecordKind as Kind } from "./hosted-dependency-removal-records";
import { hostedDependencyRemovalOperations } from "./hosted-dependency-removal-ownership";
import { encodeReference as encode, pinReferenceFile, writeReferenceOnce } from "./hosted-dependency-legacy-reference-records";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { collectUnitInvocation, fenceScopedSubmitter } from "./hosted-readonly-linux-collector";
import { observeHostedDependencyRemoverRetirement } from "./hosted-dependency-remover-retirement";
import { readOriginalHostedDependencyRemovalRetirement } from "./hosted-dependency-removal-history";
function held():never{throw new Error("hosted_dependency_removal_recovery_held");}
/** Genuine old lifetime revocation. A live exact pidfd observes POLLIN before
 * its protected receipt is written. Absent PID without that receipt is HOLD.
 * The source actor sees durable revocation before any subsequent effect. */
export function retireOriginalHostedDependencyRemovalForRecovery(fence:HostedActivationFence,id:string,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);assertHostedActivationOperator();assertHostedProcessDescriptors();
  if(readHostedPrivateBytes(hostedDependencyRemovalRecordPath(id,"retirement"),65536))return readOriginalHostedDependencyRemovalRetirement(fence,id,access);
  const selected=readOriginalHostedDependencyRemovalClaim(id,access),actorPin=pinReferenceFile(hostedDependencyRemovalRecordPath(id,"actor"),65536),
    actor=parseHostedDependencyRemovalActor(JSON.parse(actorPin.bytes.toString("utf8")),selected.claim,selected.reference),
    first=readOriginalHostedDependencyRemovalFirstClaim(fence,selected,access),firstActor=pinReferenceFile(hostedDependencyRemovalRecordPath(hostedDependencyRemovalAttempt(first.claim).operationId,"actor"),65536),
    lock=pinReferenceFile(`${hostedDependencyRemovalOperations}/${selected.claim.absent.receipt.operationId}.remove.lock`,65536),
    consumed=pinReferenceFile(hostedDependencyRemovalRecordPath(id,"consumed"),16384),marker={version:1,claim:selected.reference,actor:actorPin.reference};
  parseHostedDependencyRemovalLock(JSON.parse(lock.bytes.toString("utf8")),first.claim,firstActor.reference);
  if(!consumed.bytes.equals(encode(marker)))held();
  // Explicit recovery cannot kill a live/paused actor to manufacture eligibility.
  // The actual actor Invocation and its recursive descendants must already be
  // terminal/empty; only its still-live exact submitter can then be fenced.
  const before=observeHostedDependencyRemoverRetirement(actor.actor.unit,actor.actor.invocationId,10000);
  const revoked=writeReferenceOnce(hostedDependencyRemovalRecordPath(id,"revoked"),marker),proxyPath=hostedDependencyRemovalRecordPath(id,"proxy-revoked"),
    proxyReceipt={version:1,claim:selected.reference,actor:actorPin.reference,pidBirth:actor.proxy.pidBirth,controlGroup:actor.proxy.controlGroup,bootId:actor.actor.bootId,supervisorId:actor.actor.supervisorId};
  if(!readHostedPrivateBytes(proxyPath,16384)) {
    const parent=observeHostedFdProcess(Number(actor.parent.pidBirth.split(":")[0])),proxy=observeHostedFdProcess(Number(actor.proxy.pidBirth.split(":")[0]));
    if(parent.birth!==actor.parent.pidBirth || parent.group!==`0::${actor.parent.controlGroup}` || collectUnitInvocation(actor.parent.unit)!==actor.parent.invocationId ||
      proxy.birth!==actor.proxy.pidBirth || proxy.parentPid!==parent.pid || proxy.group!==`0::${actor.proxy.controlGroup}` || collectUnitInvocation(actor.actor.unit)!==actor.actor.invocationId)held();
    fenceScopedSubmitter(actor.proxy.pidBirth,actor.proxy.controlGroup,10000);
    writeReferenceOnce(proxyPath,proxyReceipt);
  }
  const proxy=pinReferenceFile(proxyPath,16384);if(!proxy.bytes.equals(encode(proxyReceipt)))held();
  // This acknowledgment is never used as terminal evidence. Exact Invocation
  // remains required, and a newly queued operation prevents retirement.
  if(collectUnitInvocation(actor.actor.unit)!==actor.actor.invocationId)held();
  const native=observeHostedDependencyRemoverRetirement(actor.actor.unit,actor.actor.invocationId,10000);
  if(!encode(before.terminal).equals(encode(native.terminal)))held();
  writeReferenceOnce(hostedDependencyRemovalRecordPath(id,"retirement"),{version:1,kind:Kind.Retirement,claim:selected.reference,actor:actorPin.reference,
    lock:lock.reference,consumed:consumed.reference,revoked,parentClosed:null,proxyRevoked:proxy.reference,native});
  return readOriginalHostedDependencyRemovalRetirement(fence,id,access);
}
/** Every predecessor edge includes its actual immutable retirement and exact
 * Fenced/null CAS shape. Keeping the first lock never mutates its actor UUID. */
export function readOriginalHostedDependencyRemovalFirstClaim(fence:HostedActivationFence,selected:ReturnType<typeof readOriginalHostedDependencyRemovalClaim>,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);let current=selected;
  for(let depth=0;current.claim.previousClaim;depth++) {
    if(depth>=32 || !current.claim.previousRetirement)held();const pin=pinReferenceFile(current.claim.previousClaim.path,65536),v:unknown=JSON.parse(pin.bytes.toString("utf8"));
    if(!isDependencyCustodyObject(v,"absent,binding,claimed,header,kind,originalIdle,previous,previousClaim,previousRetirement,sourceClosed,version"))held();
    const id=current.claim.previousClaim.path.slice(hostedDependencyRemovalOperations.length+1,-".removal-claim.json".length),previous=readOriginalHostedDependencyRemovalClaim(id,access),
      retired=readOriginalHostedDependencyRemovalRetirement(fence,id,access),owner=previous.claim.claimed.owner;
    if(!owner || owner.kind!==DependencyOwnerKind.Maintenance || !sameDependencyProtectedReference(pin.reference,previous.reference) ||
      !sameDependencyProtectedReference(previous.reference,current.claim.previousClaim) || !sameDependencyProtectedReference(retired.retirement,current.claim.previousRetirement) ||
      !encode({...previous.claim,previous:current.claim.previous,claimed:current.claim.claimed,previousClaim:current.claim.previousClaim,previousRetirement:current.claim.previousRetirement}).equals(encode(current.claim)))held();
    const fenced=parseDependencyOwner({...previous.claim.claimed,revision:previous.claim.claimed.revision+1,owner:{...owner,phase:DependencyOwnerPhase.Fenced}}),
      idle=parseDependencyOwner({...fenced,revision:fenced.revision+1,owner:null});
    if(!encode(idle).equals(encode(current.claim.previous)))held();current=previous;
  }
  return current;
}
