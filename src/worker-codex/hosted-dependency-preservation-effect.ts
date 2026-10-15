import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { DependencyOwnerKind, sameDependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationFence, withHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { beginOriginalHostedDependencyPreservation, assertOriginalHostedDependencyPreservation,
  readOriginalHostedDependencyPreservationRetired, releaseOriginalHostedDependencyPreservation } from "./hosted-dependency-preservation-operator";
import { isOriginalHostedDependencyPreservationReleased } from "./hosted-dependency-preservation-operator";
import type { HostedDependencyPreservationSelection } from "./hosted-dependency-preservation-selection";
import { openDependencyTreePreservation, DependencyPreservationLocation, readDependencyTreeEffectReferenceAnchors } from "../worker-local/dependency-environment/dependency-tree-effects";
import { hostedDependencyObservationLimits as limits } from "./hosted-dependency-materialization";
import { hostedDependencyQuarantineRoot, hostedDependencyPreservationPath, readHostedDependencyPreparedPreservation,
  hostedDependencyPreservationCommit, readHostedDependencyCommittedPreservation, type HostedDependencyPreparedPreservation } from "./hosted-dependency-preservation";
import { pinReferenceFile, encodeReference as encode } from "./hosted-dependency-legacy-reference-records";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { assertHostedDependencyReferenceVeto, DependencyReferenceEffect } from "./hosted-dependency-reference-veto";
import { readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
import { readOriginalHostedDependencyPreservationDischargedUnits } from "./hosted-dependency-preservation-operator";
type Operation=Awaited<ReturnType<typeof openDependencyTreePreservation>>;
// Only this defining runner installs its actual low-level operation. There is
// no exported setter, caller session, descriptor list, callback or proof DTO.
let current:{selection:HostedDependencyPreservationSelection;operation:Operation|undefined}|undefined;
const hash=(v:Uint8Array)=>createHash("sha256").update(v).digest("hex");
const marker=(id:string)=>`/var/lib/subscription-runtime-host-policy/dependency-transactions/${id}.close-unresolved.json`;
function held():never {throw new Error("hosted_dependency_preservation_effect_held");}
export enum HostedDependencyExplicitPreservationOutcome { Preserved = "preserved" }
function absent(path:string):boolean {try{lstatSync(path);return false;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return true;throw e;}}
/** Original descriptor dispatcher reads genuine retained handles. Ownership
 * and all native facts are checked by the caller around each physical step;
 * avoiding that recursion here does not broaden the retained FD association. */
export function assertOriginalHostedDependencyPreservationDescriptors(fence:HostedActivationFence,access:symbol):boolean {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);if(!current)return false;
  const {selection:s,operation}=current,expected={workspace:s.binding.workspace,
    trashPath:`${hostedDependencyQuarantineRoot}/dependency-${s.operationId}`,operationId:s.operationId},
    anchors=operation?readDependencyTreeEffectReferenceAnchors(operation.referenceSession,expected):[];
  if(readHostedPrivateBytes(marker(s.operationId),4096))held();
  for(const fd of [0,1,2]){const stat=fstatSync(fd);if(!stat.isFIFO() && !stat.isSocket())held();}
  const names=readdirSync("/proc/self/fd");if(names.length>512)held();
  for(const name of names) {
    if(!/^(?:0|[1-9][0-9]{0,5})$/.test(name))held();const fd=Number(name);if(fd<=2)continue;
    try {const stat=fstatSync(fd);if(!stat.isFile() && !stat.isDirectory())continue;
      const anchor=anchors.find(v=>v.fd===fd);if(!anchor || !stat.isDirectory() || String(stat.dev)!==anchor.dev || String(stat.ino)!==anchor.ino)held();
      const info=readFileSync(`/proc/self/fdinfo/${fd}`,"utf8");if(info.length>65536 || /^mnt_id:\s*([0-9]+)\s*$/m.exec(info)?.[1]!==anchor.mountId || /^flags:\s*([0-7]+)\s*$/m.exec(info)?.[1]!==anchor.flags)held();
    }catch(e){if((e as NodeJS.ErrnoException).code!=="EBADF")throw e;}
  }
  if(operation)readDependencyTreeEffectReferenceAnchors(operation.referenceSession,expected);assertHostedActivationFence(fence);return true;
}
/** Callable only through the existing original explicit operator method. All
 * unknown bytes and raw symlinks are flushed/renamed before a committed mapping
 * exists; the ordinary foreground entry is the sole installer consumer. */
export async function runOriginalHostedDependencyPreservation(jobId:string,recover:boolean,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);if(current)held();
  const s=withHostedActivationFence(fence=>beginOriginalHostedDependencyPreservation(fence,jobId,recover,access)),state={selection:s,operation:undefined as Operation|undefined};current=state;
  let closed=false;
  try {
    if(withHostedActivationFence(fence=>isOriginalHostedDependencyPreservationReleased(fence,s,access))) {
      const retired=withHostedActivationFence(fence=>readOriginalHostedDependencyPreservationRetired(fence,s,access)),prepared=readHostedDependencyPreparedPreservation(s.binding,retired.receipt);
      if(!readHostedDependencyCommittedPreservation(s.binding,retired.receipt,s.operationId))held();
      return {outcome:HostedDependencyExplicitPreservationOutcome.Preserved,operationId:s.operationId,mappingDigest:hash(encode(prepared.header)),
        destination:`${hostedDependencyQuarantineRoot}/${prepared.header.trash.destinationName}`,preservedBytes:prepared.header.inventory.logicalBytes,entries:prepared.header.inventory.entries};
    }
    const retired=withHostedActivationFence(fence=>{assertOriginalHostedDependencyPreservation(fence,s,access);return readOriginalHostedDependencyPreservationRetired(fence,s,access);});
    const attempt=s.claimedOwner.owner;if(!attempt || attempt.kind!==DependencyOwnerKind.Maintenance)held();
    const trash={operationId:s.operationId,originalTree:retired.receipt.tree,destinationParent:s.destinationParent,destinationName:`dependency-${s.operationId}`},
      destination=`${hostedDependencyQuarantineRoot}/${trash.destinationName}`,prefix=hostedDependencyPreservationPath(s.binding,retired.receipt.revision);
    let prepared=readHostedPrivateBytes(prefix+".prepared.json",32768)?readHostedDependencyPreparedPreservation(s.binding,retired.receipt):undefined;
    if(prepared && prepared.header.attempt.operationId!==s.operationId || !prepared && readHostedPrivateBytes(prefix+".committed.json",4096))held();
    const missing=absent(s.binding.workspace.canonicalPath+"/node_modules");if(missing===absent(destination) || missing && !prepared)held();
    state.operation=await openDependencyTreePreservation({workspace:s.binding.workspace,trash,limits},missing?DependencyPreservationLocation.Preserved:DependencyPreservationLocation.Original);
    const operation=state.operation;
    withHostedActivationFence(fence=> {
      assertOriginalHostedDependencyPreservation(fence,s,access);
      if(!prepared) {
        const path=`${hostedDependencyQuarantineRoot}/${s.operationId}.inventory.json.gz`,bytes=gzipSync(operation.inventory.canonicalBytes);publishInventory(path,bytes);
        const inventory=pinReferenceFile(path,4*1024*1024);if(!inventory.bytes.equals(bytes))held();
        const header:HostedDependencyPreparedPreservation={version:1,binding:s.binding,attempt:attempt.attempt,previous:retired,trash,
          inventory:{reference:inventory.reference,digest:operation.inventory.digest,logicalBytes:operation.inventory.logicalBytes,entries:operation.inventory.entries}};
        createReadonlyPrivateRecord(prefix+".prepared.json",encode(header));prepared=readHostedDependencyPreparedPreservation(s.binding,retired.receipt);
        if(!encode(prepared.header).equals(encode(header)))held();
      }
      if(prepared.header.inventory.digest!==operation.inventory.digest || !encode(prepared.header.trash).equals(encode(trash)))held();
      const reference=prepared.reference;assertOriginalHostedDependencyPreservation(fence,s,access);
      if(!sameDependencyProtectedReference(readHostedDependencyPreparedPreservation(s.binding,retired.receipt).reference,reference))held();
      const groups=new Set(readHostedReadonlyHostInventory().units.map(v=>v.controlGroup));
      for(const unit of readOriginalHostedDependencyPreservationDischargedUnits(fence,access))groups.add(`/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`);
      assertHostedDependencyReferenceVeto(s.binding.workspace,destination,[...groups],DependencyReferenceEffect.Eviction,{session:operation.referenceSession,operationId:s.operationId});
      operation.commit(prepared.header.inventory.digest);
      assertOriginalHostedDependencyPreservation(fence,s,access);
      assertHostedDependencyReferenceVeto(s.binding.workspace,destination,[...groups],DependencyReferenceEffect.Eviction,{session:operation.referenceSession,operationId:s.operationId});
      const bytes=encode(hostedDependencyPreservationCommit(prepared));createReadonlyPrivateRecord(prefix+".committed.json",bytes);
      if(!pinReferenceFile(prefix+".committed.json",4096).bytes.equals(bytes))held();
    });
    const result=await operation.close();closed=true;state.operation=undefined;
    if(result.closeFailures){createReadonlyPrivateRecord(marker(s.operationId),encode({version:1,operationId:s.operationId}));held();}
    withHostedActivationFence(fence=> {
      assertOriginalHostedDependencyPreservation(fence,s,access);if(!readHostedDependencyCommittedPreservation(s.binding,retired.receipt,s.operationId))held();
      releaseOriginalHostedDependencyPreservation(fence,s,access);
    });
    return {outcome:HostedDependencyExplicitPreservationOutcome.Preserved,operationId:s.operationId,mappingDigest:hash(encode(prepared!.header)),destination,
      preservedBytes:prepared!.header.inventory.logicalBytes,entries:prepared!.header.inventory.entries};
  } finally {
    if(!closed && state.operation && (await state.operation.close()).closeFailures)createReadonlyPrivateRecord(marker(s.operationId),encode({version:1,operationId:s.operationId}));
    if(current===state)current=undefined;
  }
}
/** Bounded inventory durability; replay re-syncs the SAME immutable inode. */
function publishInventory(path:string,bytes:Buffer):void {
  if(!bytes.length || bytes.length>4*1024*1024)held();let fd:number,created=true;
  try{fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
  catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;if(!pinReferenceFile(path,4*1024*1024).bytes.equals(bytes))held();created=false;fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);}
  try{const stat=fstatSync(fd,{bigint:true});if(!stat.isFile() || stat.uid!==0n || stat.nlink!==1n || (stat.mode&0o7777n)!==0o600n)held();if(created)writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  const parent=openSync(hostedDependencyQuarantineRoot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(parent);}finally{closeSync(parent);}
  if(!pinReferenceFile(path,4*1024*1024).bytes.equals(bytes))held();
}
