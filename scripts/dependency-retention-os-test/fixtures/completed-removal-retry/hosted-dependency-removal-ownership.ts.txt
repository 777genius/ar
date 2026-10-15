import { isDependencyCustodyObject } from "@vioxen/subscription-runtime/core";
import { HostedDependencyRemovalDisposition } from "./hosted-dependency-removal-effects";
import { HostedDependencyTransactionOutcome } from "./hosted-dependency-transactions";
import { unlinkOriginalHostedDependencyRemovalLock, confirmOriginalHostedDependencyRemovalLockReleased } from "./hosted-dependency-removal-lock-release";
import { readOriginalHostedDependencyRemovalIdle } from "./hosted-dependency-removal-history";
import { HostedReadonlyHostKernel } from "./hosted-readonly-host-kernel";
import { readOriginalHostedDependencyRemovalRetirement } from "./hosted-dependency-removal-history";
import { readOriginalHostedDependencyOperatorNativeCensus } from "./hosted-dependency-generation-native-census";
import { readdirSync } from "node:fs";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { retireOriginalHostedDependencyRemovalForRecovery, readOriginalHostedDependencyRemovalFirstClaim } from "./hosted-dependency-removal-recovery";
import { readOriginalHostedDependencyRemovalClaim, hostedDependencyRemovalRecordPath } from "./hosted-dependency-removal-context";
import { parseHostedDependencyRemovalLock } from "./hosted-dependency-removal-records";
import { randomUUID } from "node:crypto";
import { DependencyOwnerKind, DependencyOwnerPhase, parseDependencyOwner, type DependencyOwnerRecord } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedDependencyOwnerRoot } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { readOriginalHostedDependencyMaintenanceIdle } from "./hosted-dependency-active-maintenance";
import { ensureHostedDependencyDirectory } from "./hosted-dependency-receipts";
import { readOriginalHostedDependencyRemovalCommittedHistoryWithFence } from "./hosted-dependency-transactions";
import { encodeReference as encode, pinReferenceFile, writeReferenceOnce } from "./hosted-dependency-legacy-reference-records";
import { hostedDependencyRemovalAttempt, HostedDependencyRemovalRecordKind, parseHostedDependencyRemovalClaim } from "./hosted-dependency-removal-records";

export const hostedDependencyRemovalOperations = "/var/lib/subscription-runtime-host-policy/dependency-transactions";
let recovery: {operationId:string;owner:DependencyOwnerRecord;lock:ReturnType<typeof pinReferenceFile>["reference"];lockAbsent?:boolean} | undefined;
function recoveryGuard(fence:HostedActivationFence,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);if(!recovery)return undefined;
  const proof=readOriginalHostedDependencyRemovalRetirement(fence,recovery.operationId,access),store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try{if(!encode(store.read(recovery.owner.workspace)).equals(encode(recovery.owner)))held();}finally{store.close();}
  if(recovery.lockAbsent)confirmOriginalHostedDependencyRemovalLockReleased(fence,recovery.lock,access);
  else if(!encode(pinReferenceFile(recovery.lock.path,65536).reference).equals(encode(recovery.lock)))held();
  if(!encode(proof.lock).equals(encode(recovery.lock)))held();
  return {state:recovery,operator:new HostedReadonlyHostKernel().operatorSession()};
}
export function readOriginalHostedDependencyRemovalRecoveryScope(fence:HostedActivationFence,access:symbol) {
  const proof=recoveryGuard(fence,access);return proof ? {units:Object.freeze([] as string[]),operator:proof.operator} : undefined;
}
export function assertOriginalHostedDependencyRemovalRecoveryLock(path:string,fence:HostedActivationFence,access:symbol) {
  const proof=recoveryGuard(fence,access);return !!proof && !proof.state.lockAbsent && proof.state.lock.path===path;
}
function held(): never { throw new Error("hosted_dependency_removal_owner_unresolved"); }
export function hostedDependencyRemovalClaimPath(operationId: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId)) held();
  return `${hostedDependencyRemovalOperations}/${operationId}.removal-claim.json`;
}
/** Parent-only first claim. Source history and current idle are actual reads;
 * operation UUID/epoch are allocated here and cannot rewrite eviction identity.
 * No claim is accepted merely because an owner file currently happens to be null. */
export function claimOriginalHostedDependencyTrashRemoval(fence: HostedActivationFence, jobId: string, revision: number, access: symbol, recoverOnly=false) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access); assertHostedActivationFence(fence);
  // Caller already holds the SAME activation fence. Avoid a nested acquisition.
  const history = readOriginalHostedDependencyRemovalCommittedHistoryWithFence(fence, jobId, revision, access);
  const lockPath=`${hostedDependencyRemovalOperations}/${history.committed.receipt.operationId}.remove.lock`;
  if(readHostedPrivateBytes(lockPath,65536)){if(!recoverOnly)held();return recover(fence,history,lockPath,access);}
  if(recoverOnly)held();
  const idle = readOriginalHostedDependencyMaintenanceIdle(fence, history.actual.binding.workspace, access);
  if (!idle || !encode(idle.binding).equals(encode(history.actual.binding)) || idle.previous.owner) held();
  const previous = idle.previous, actual = history.actual, operationId = randomUUID(), attempt = { operationId, epoch: previous.epoch + 1,
    host: { installationId: actual.installation.installationId, bootId: actual.session.bootId, supervisorId: actual.session.supervisorId,
      runtimeSha: actual.installation.runtimeSha, inventoryDigest: actual.installation.inventorySha256, grantDigest: actual.binding.grantDigest } },
    claimed = parseDependencyOwner({ ...previous, revision: previous.revision + 1, epoch: attempt.epoch,
      owner: { kind: DependencyOwnerKind.Maintenance, phase: DependencyOwnerPhase.ExclusiveMutation, attempt } });
  const claim = parseHostedDependencyRemovalClaim({ version: 1, kind: HostedDependencyRemovalRecordKind.Claim, binding: actual.binding,
    previous, claimed, originalIdle: idle.idle, sourceClosed: idle.sourceClosed, absent: history.committed,
    header: history.headerReference, previousClaim: null, previousRetirement: null });
  ensureHostedDependencyDirectory(hostedDependencyRemovalOperations);
  const reference = writeReferenceOnce(hostedDependencyRemovalClaimPath(operationId), claim);
  publishOriginalHostedDependencyRemovalOwner(fence, previous, claimed, access);
  const pin = pinReferenceFile(reference.path, 65536);
  if (!pin.bytes.equals(encode(claim)) || !encode(hostedDependencyRemovalAttempt(claim)).equals(encode(attempt))) held();
  return { claim, reference, header: history.header };
}
export function publishOriginalHostedDependencyRemovalOwner(fence: HostedActivationFence, previous: DependencyOwnerRecord,
  next: DependencyOwnerRecord, access: symbol): void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access); assertHostedActivationFence(fence);
  const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
  try {
    if (!encode(store.read(previous.workspace)).equals(encode(previous)) || !encode(store.compareAndSwap(previous.workspace, previous.revision, next)).equals(encode(next)) ||
        !encode(store.read(previous.workspace)).equals(encode(next))) held();
  } finally { store.close(); }
}

function recover(fence:HostedActivationFence,history:ReturnType<typeof readOriginalHostedDependencyRemovalCommittedHistoryWithFence>,lockPath:string,access:symbol) {
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});let current:DependencyOwnerRecord | null;
  try{current=store.read(history.actual.binding.workspace);}finally{store.close();}if(!current || current.version===1)held();
  const host={installationId:history.actual.installation.installationId,bootId:history.actual.session.bootId,supervisorId:history.actual.session.supervisorId,
    runtimeSha:history.actual.installation.runtimeSha,inventoryDigest:history.actual.installation.inventorySha256,grantDigest:history.actual.binding.grantDigest},
    names=readdirSync(hostedDependencyRemovalOperations);if(names.length>4096)held();
  const matches=names.filter(name=>name.endsWith(".removal-claim.json")).map(name=>readOriginalHostedDependencyRemovalClaim(name.slice(0,-".removal-claim.json".length),access))
    .filter(s=>encode(s.claim.absent).equals(encode(history.committed)) && encode(s.claim.binding).equals(encode(history.actual.binding)) &&
      encode(hostedDependencyRemovalAttempt(s.claim).host).equals(encode(host)));
  const pending=matches.filter(s=>encode(s.claim.previous).equals(encode(current)) && s.claim.previousClaim!==null &&
    !readHostedPrivateBytes(hostedDependencyRemovalRecordPath(hostedDependencyRemovalAttempt(s.claim).operationId,"actor"),65536));
  if(pending.length>1)held();
  if(pending[0]) {
    const selected=pending[0],first=readOriginalHostedDependencyRemovalFirstClaim(fence,selected,access),actor=pinReferenceFile(hostedDependencyRemovalRecordPath(hostedDependencyRemovalAttempt(first.claim).operationId,"actor"),65536);
    parseHostedDependencyRemovalLock(JSON.parse(pinReferenceFile(lockPath,65536).bytes.toString("utf8")),first.claim,actor.reference);
    if(!selected.claim.previousClaim || recovery)held();const id=selected.claim.previousClaim.path.slice(hostedDependencyRemovalOperations.length+1,-".removal-claim.json".length);
    recovery={operationId:id,owner:current,lock:pinReferenceFile(lockPath,65536).reference};
    try{if(!readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();publishOriginalHostedDependencyRemovalOwner(fence,current,selected.claim.claimed,access);
      recovery.owner=selected.claim.claimed;return {...selected,header:history.header};}finally{recovery=undefined;}
  }
  const selected=matches.filter(s=>{
    const claim=s.claim.claimed,owner=claim.owner;if(!owner || owner.kind!==DependencyOwnerKind.Maintenance)return false;
    const fenced=parseDependencyOwner({...claim,revision:claim.revision+1,owner:{...owner,phase:DependencyOwnerPhase.Fenced}}),idle=parseDependencyOwner({...fenced,revision:fenced.revision+1,owner:null});
    return [claim,fenced,idle].some(v=>encode(v).equals(encode(current)));
  });if(selected.length!==1)held();const old=selected[0]!,oldId=hostedDependencyRemovalAttempt(old.claim).operationId,
    retired=retireOriginalHostedDependencyRemovalForRecovery(fence,oldId,access),first=readOriginalHostedDependencyRemovalFirstClaim(fence,old,access),
    actor=pinReferenceFile(hostedDependencyRemovalRecordPath(hostedDependencyRemovalAttempt(first.claim).operationId,"actor"),65536),lock=pinReferenceFile(lockPath,65536);
  parseHostedDependencyRemovalLock(JSON.parse(lock.bytes.toString("utf8")),first.claim,actor.reference);
  if(!encode(retired.lock).equals(encode(lock.reference)) || recovery)held();recovery={operationId:oldId,owner:current,lock:lock.reference};
  try {
  if(!readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();const oldOwner=old.claim.claimed.owner;if(!oldOwner)held();
  const fenced=parseDependencyOwner({...old.claim.claimed,revision:old.claim.claimed.revision+1,owner:{...oldOwner,phase:DependencyOwnerPhase.Fenced}}),
    idle=parseDependencyOwner({...fenced,revision:fenced.revision+1,owner:null});
  if(encode(current).equals(encode(old.claim.claimed))) {publishOriginalHostedDependencyRemovalOwner(fence,current,fenced,access);current=fenced;recovery.owner=current;}
  if(encode(current).equals(encode(fenced))) {publishOriginalHostedDependencyRemovalOwner(fence,current,idle,access);current=idle;recovery.owner=current;}
  if(!encode(current).equals(encode(idle)))held();
  const attempt={operationId:randomUUID(),epoch:idle.epoch+1,host},claimed=parseDependencyOwner({...idle,revision:idle.revision+1,epoch:attempt.epoch,
    owner:{kind:DependencyOwnerKind.Maintenance,phase:DependencyOwnerPhase.ExclusiveMutation,attempt}}),
    claim=parseHostedDependencyRemovalClaim({...old.claim,previous:idle,claimed,previousClaim:old.reference,previousRetirement:retired.retirement}),
    reference=writeReferenceOnce(hostedDependencyRemovalClaimPath(attempt.operationId),claim);
  publishOriginalHostedDependencyRemovalOwner(fence,idle,claimed,access);recovery.owner=claimed;return {claim,reference,header:history.header};
  }finally{recovery=undefined;}
}

/** Exact completion retry crosses the lock-unlink crash gap. Success still needs
 * original retirement + local successful closure, exact owner stage, committed
 * Absent/source pins, native census and an anchored positive/negative lock join. */
export function tryReleaseOriginalHostedDependencyCompletedRemoval(fence:HostedActivationFence,jobId:string,revision:number,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  const history=readOriginalHostedDependencyRemovalCommittedHistoryWithFence(fence,jobId,revision,access),store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let current:DependencyOwnerRecord|null;try{current=store.read(history.actual.binding.workspace);}finally{store.close();}if(!current || current.version===1)return undefined;
  if(!current.owner) {
    const proof=readOriginalHostedDependencyRemovalIdle(fence,current.workspace,access);if(!proof)return undefined;
    if(!encode(proof.priorAbsent).equals(encode(history.committed)))held();
    return {outcome:HostedDependencyTransactionOutcome.TrashRemoved,operationId:history.committed.receipt.operationId,removedEntries:proof.removedEntries};
  }
  if(current.owner.kind!==DependencyOwnerKind.Maintenance || current.owner.attempt.operationId===history.committed.receipt.operationId)return undefined;
  const id=current.owner.attempt.operationId,completionBytes=readHostedPrivateBytes(hostedDependencyRemovalRecordPath(id,"session-closed"),16384);
  if(!completionBytes || !readHostedPrivateBytes(hostedDependencyRemovalRecordPath(id,"retirement"),65536))return undefined;
  const proof=readOriginalHostedDependencyRemovalRetirement(fence,id,access),completion=pinReferenceFile(hostedDependencyRemovalRecordPath(id,"session-closed"),16384),v:unknown=JSON.parse(completion.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(v,"actor,claim,disposition,kind,removedEntries,version") || v.version!==1 || v.kind!==HostedDependencyRemovalRecordKind.SessionClosed ||
    !completion.bytes.equals(encode(v)) || !encode(v.claim).equals(encode(proof.selected.reference)) || !encode(v.actor).equals(encode(proof.actorReference)))held();
  if(v.disposition===HostedDependencyRemovalDisposition.Partial)return undefined;
  if(!(v.disposition===HostedDependencyRemovalDisposition.Removed && typeof v.removedEntries==="number" && Number.isSafeInteger(v.removedEntries) && v.removedEntries>0 ||
    v.disposition===HostedDependencyRemovalDisposition.RecoveredAbsent && v.removedEntries===null) || !encode(proof.selected.claim.absent).equals(encode(history.committed)) ||
    !encode(proof.selected.claim.binding).equals(encode(history.actual.binding)))held();
  const claimed=proof.selected.claim.claimed;if(!claimed.owner)held();
  const fenced=parseDependencyOwner({...claimed,revision:claimed.revision+1,owner:{...claimed.owner,phase:DependencyOwnerPhase.Fenced}}),
    next=parseDependencyOwner({...fenced,revision:fenced.revision+1,owner:null});
  if(![claimed,fenced].some(stage=>encode(stage).equals(encode(current))) || recovery)held();
  recovery={operationId:id,owner:current,lock:proof.lock,lockAbsent:!readHostedPrivateBytes(proof.lock.path,65536)};
  try {
    if(!readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();
    if(encode(current).equals(encode(claimed))) {publishOriginalHostedDependencyRemovalOwner(fence,current,fenced,access);current=fenced;recovery.owner=fenced;}
    writeReferenceOnce(`${hostedDependencyRemovalOperations}/${next.workspace.dev}-${next.workspace.ino}-${next.revision}.removal-idle.json`,
      {version:1,kind:HostedDependencyRemovalRecordKind.Idle,claim:proof.selected.reference,retirement:proof.retirement,completion:completion.reference,fenced,released:next});
    recoveryGuard(fence,access);
    if(recovery.lockAbsent)confirmOriginalHostedDependencyRemovalLockReleased(fence,proof.lock,access);
    else {unlinkOriginalHostedDependencyRemovalLock(fence,proof.lock,access);recovery.lockAbsent=true;}
    recoveryGuard(fence,access);publishOriginalHostedDependencyRemovalOwner(fence,fenced,next,access);recovery.owner=next;
    recoveryGuard(fence,access);return {outcome:HostedDependencyTransactionOutcome.TrashRemoved,operationId:history.committed.receipt.operationId,removedEntries:v.removedEntries};
  }finally{recovery=undefined;}
}
