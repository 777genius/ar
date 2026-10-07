import { readHostedDependencyEvictionEnabled } from "./hosted-dependency-eviction-enabled-policy";
import { fstatSync, readFileSync, readdirSync } from "node:fs";
import { DependencyGenerationContinuityKind as Continuity, DependencyOwnerKind,
  isDependencyCustodyObject,
  sameDependencyMaintenanceAttempt, sameDependencyProtectedReference, sameDependencyTree,
  type DependencyMaintenanceAttempt, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { DependencyReceiptState as State, parseDependencyReceipt, DependencyReceiptParseStatus, type DependencyReceipt, type DependencyTrashIntent } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, assertHostedActivationOperator, withHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedDependencyOwnerRoot } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { assertOriginalHostedDependencyPhysicalRecordAccess, readOriginalHostedDependencyMaintenanceRenameState,
  type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { assertOriginalHostedDependencyMaintenance, readOriginalHostedDependencyMaintenanceDischargedGroups } from "./hosted-dependency-active-maintenance";
import { readHostedDependencyExistingCommittedReady } from "./hosted-dependency-receipts";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { openHostedDependencyManifestPlacement } from "./hosted-dependency-manifest-placement";
import { openHostedDependencyReadySourceLinks } from "./hosted-dependency-ready-source-links";
import { closeDependencySourceLinkSession, type DependencySourceLinkSession } from "../worker-local/dependency-environment/dependency-source-binding";
import { openDependencyTreeRename, readDependencyTreeEffectReferenceAnchors, type DependencyTreeEffectReferenceSession } from "../worker-local/dependency-environment/dependency-tree-effects";
import { assertHostedDependencyReferenceVeto, DependencyReferenceEffect } from "./hosted-dependency-reference-veto";
import { assertHostedDependencyKeyInputsCurrent, readHostedDependencyKeyInputs, hostedDependencyObservationLimits as limits } from "./hosted-dependency-materialization";
type Ready=Extract<DependencyReceipt,{state:State.Ready}>;
type Header={version:1;attempt:DependencyMaintenanceAttempt;ready:Ready;trash:DependencyTrashIntent};
type Operation=Awaited<ReturnType<typeof openDependencyTreeRename>>;
export enum HostedDependencyMaintenanceOriginKind { OperatorMaintenance = "operator_maintenance" }
/** Only the defining original module creates this separate operator entry.
 * Consumer/HOME/provider selectors reject it, and no effect session is public. */
export type OriginalHostedDependencyMaintenanceRenameState={
  kind:HostedDependencyMaintenanceOriginKind.OperatorMaintenance;jobId:string;attempt:DependencyMaintenanceAttempt;header:Header;headerReference:DependencyProtectedReference;
  operation?:Operation;session?:DependencyTreeEffectReferenceSession;sourceLinks?:DependencySourceLinkSession;held:boolean;
};
const root="/var/lib/subscription-runtime-host-policy",encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
function held():never{throw new Error("hosted_dependency_maintenance_rename_held");}
function current(fence:HostedActivationFence,state:OriginalHostedDependencyMaintenanceRenameState,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);assertHostedActivationOperator();if(state.held)held();
  const actual=assertOriginalHostedDependencyMaintenance(fence,state.jobId,state.attempt,access),pin=pinReferenceFile(state.headerReference.path,32768);
  if(readHostedPrivateBytes(`${root}/dependency-transactions/${state.attempt.operationId}.close-unresolved.json`,4096))held();
  if(!sameDependencyProtectedReference(pin.reference,state.headerReference) || !pin.bytes.equals(encode(state.header)) ||
      !sameDependencyTree(state.header.ready.workspace,actual.binding.workspace))held();return actual;
}
export function selectOriginalHostedDependencyMaintenanceRename(fence:HostedActivationFence,jobId:string,attempt:DependencyMaintenanceAttempt,access:symbol):OriginalHostedDependencyMaintenanceRenameState|undefined {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  const a=assertOriginalHostedDependencyMaintenance(fence,jobId,attempt,access),store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let owner;try{owner=store.read(a.binding.workspace);}finally{store.close();}
  if(!owner || owner.version===1 || owner.generationContinuity?.kind!==Continuity.RetiredEvictingV1)return undefined;
  if(owner.owner?.kind!==DependencyOwnerKind.Maintenance || !sameDependencyMaintenanceAttempt(owner.owner.attempt,attempt))held();
  if(readHostedPrivateBytes(`${root}/dependency-transactions/${attempt.operationId}.close-unresolved.json`,4096))held();
  const slot=owner.generationContinuity,pin=pinReferenceFile(`${root}/dependency-transactions/${attempt.operationId}.json`,32768),v:unknown=JSON.parse(pin.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(v,"attempt,ready,trash,version") || v.version!==1 || !pin.bytes.equals(encode(v)) || !encode(v.attempt).equals(encode(attempt)))held();
  const parsed=parseDependencyReceipt(v.ready);if(parsed.status!==DependencyReceiptParseStatus.Valid || parsed.receipt.state!==State.Ready)held();
  const ready=readHostedDependencyExistingCommittedReady(fence,a.binding,slot.readyRevision);
  if(!sameDependencyProtectedReference(ready.reference,slot.previousReady) || !encode(ready.receipt).equals(encode(parsed.receipt)) ||
      !isDependencyCustodyObject(v.trash,"destinationName,destinationParent,operationId,originalTree") || v.trash.operationId!==attempt.operationId ||
      v.trash.destinationName!==`dependency-${attempt.operationId}` || !isDependencyCustodyObject(v.trash.destinationParent,"canonicalPath,dev,ino") ||
      v.trash.destinationParent.canonicalPath!==root+"/dependency-trash" || v.trash.destinationParent.dev!==a.binding.workspace.dev ||
      typeof v.trash.destinationParent.ino!=="string" || !/^[1-9][0-9]*$/.test(v.trash.destinationParent.ino) ||
      !isDependencyCustodyObject(v.trash.originalTree,"dev,ino") || typeof v.trash.originalTree.dev!=="string" || typeof v.trash.originalTree.ino!=="string" ||
      !sameDependencyTree({dev:v.trash.originalTree.dev,ino:v.trash.originalTree.ino},ready.receipt.tree))held();
  // Closed parser validates the complete physical input shape before any await.
  const receipt=parseDependencyReceipt({...ready.receipt,state:State.Evicting,revision:slot.evictingRevision,operationId:attempt.operationId,
    trash:v.trash});if(receipt.status!==DependencyReceiptParseStatus.Valid || receipt.receipt.state!==State.Evicting)held();
  readOriginalHostedDependencyMaintenanceDischargedGroups(fence,jobId,attempt,access);
  return {kind:HostedDependencyMaintenanceOriginKind.OperatorMaintenance,jobId,attempt:owner.owner.attempt,header:{version:1,attempt:owner.owner.attempt,ready:ready.receipt,trash:receipt.receipt.trash},headerReference:pin.reference,held:false};
}
/** Exact physical adapter association, never a supplied FD allowlist. Native
 * readers reach this only through the defining original map's current entry. */
export function assertOriginalHostedDependencyMaintenanceRenameDescriptors(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol):void {
  const state=readOriginalHostedDependencyMaintenanceRenameState(context,access),a=current(fence,state,access),
    expected={workspace:a.binding.workspace,trashPath:root+"/dependency-trash/"+state.header.trash.destinationName,operationId:state.attempt.operationId},
    anchors=state.session ? readDependencyTreeEffectReferenceAnchors(state.session,expected):[];
  for(const fd of [0,1,2]){const stat=fstatSync(fd);if(!stat.isFIFO() && !stat.isSocket())held();}
  const names=readdirSync("/proc/self/fd");if(names.length>512)held();
  for(const name of names) {
    if(!/^(?:0|[1-9][0-9]{0,5})$/.test(name))held();const fd=Number(name);if(fd<=2)continue;
    try {const stat=fstatSync(fd);if(!stat.isFile() && !stat.isDirectory())continue;
      const anchor=anchors.find(v=>v.fd===fd);if(!anchor || !stat.isDirectory() || String(stat.dev)!==anchor.dev || String(stat.ino)!==anchor.ino)held();
      const info=readFileSync(`/proc/self/fdinfo/${fd}`,"utf8");if(info.length>65536 || /^mnt_id:\s*([0-9]+)\s*$/m.exec(info)?.[1]!==anchor.mountId || /^flags:\s*([0-7]+)\s*$/m.exec(info)?.[1]!==anchor.flags)held();
    }catch(error){if((error as NodeJS.ErrnoException).code!=="EBADF")throw error;}
  }
  if(state.session)readDependencyTreeEffectReferenceAnchors(state.session,expected);current(fence,state,access);
}
export async function runOriginalHostedDependencyMaintenanceRename(context:CurrentHostedDependencyOrigin,access:symbol) {
  const state=readOriginalHostedDependencyMaintenanceRenameState(context,access);let placement:Awaited<ReturnType<typeof openHostedDependencyManifestPlacement>>|undefined;
  try {
    withHostedActivationFence(fence=>{current(fence,state,access);readOriginalHostedDependencyMaintenanceDischargedGroups(fence,state.jobId,state.attempt,access);});
    placement=await openHostedDependencyManifestPlacement();const bytes=await placement.get(state.header.ready.manifestDigest);
    await placement.close();placement=undefined;
    withHostedActivationFence(fence=>current(fence,state,access));
    const sourceLinks=openHostedDependencyReadySourceLinks(state.header.ready);
    if(sourceLinks)state.sourceLinks=sourceLinks;
    const keyInputs=await readHostedDependencyKeyInputs(withHostedActivationFence(fence=>current(fence,state,access)).binding);
    const a=withHostedActivationFence(fence=>{const a=current(fence,state,access);if(keyInputs.key.installKey!==state.header.ready.installKey)held();return a;});
    state.operation=await openDependencyTreeRename({workspace:a.binding.workspace,trash:state.header.trash,
      manifestCanonicalBytes:bytes,manifestDigest:state.header.ready.manifestDigest,limits,...(state.sourceLinks?{sourceLinkSession:state.sourceLinks}:{})});
    state.session=state.operation.referenceSession;
    withHostedActivationFence(fence=>assertOriginalHostedDependencyMaintenanceRenameDescriptors(context,fence,access));
    const prepared=await state.operation.prepareSynchronousRename();state.session=prepared.referenceSession;
    const result=withHostedActivationFence(fence=>{
      const actual=current(fence,state,access);assertOriginalHostedDependencyMaintenanceRenameDescriptors(context,fence,access);
      assertHostedDependencyKeyInputsCurrent(actual.binding,keyInputs);
      const groups=readOriginalHostedDependencyMaintenanceDischargedGroups(fence,state.jobId,state.attempt,access);
      assertHostedDependencyReferenceVeto(actual.binding.workspace,root+"/dependency-trash/"+state.header.trash.destinationName,groups,DependencyReferenceEffect.Eviction,
        {session:prepared.referenceSession,operationId:state.attempt.operationId});
      if(!readHostedDependencyEvictionEnabled())held();
      return prepared.commit();
    });
    const close=await state.operation.close();delete state.operation;delete state.session;if(close.closeFailures){publishCloseUnresolved(state,access);held();}
    if(state.sourceLinks){closeDependencySourceLinkSession(state.sourceLinks);delete state.sourceLinks;}
    withHostedActivationFence(fence=>{current(fence,state,access);readOriginalHostedDependencyMaintenanceDischargedGroups(fence,state.jobId,state.attempt,access);});
    return result;
  }catch(error){state.held=true;throw error;}
  finally {
    if(placement)await placement.close();
    if(state.operation){const closed=await state.operation.close();if(closed.closeFailures){state.held=true;publishCloseUnresolved(state,access);}}
    if(state.sourceLinks)closeDependencySourceLinkSession(state.sourceLinks);
  }
}

function publishCloseUnresolved(state:OriginalHostedDependencyMaintenanceRenameState,access:symbol):void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);
  withHostedActivationFence(fence=>{
    assertHostedActivationOperator();assertOriginalHostedDependencyMaintenance(fence,state.jobId,state.attempt,access);
    if(!sameDependencyProtectedReference(pinReferenceFile(state.headerReference.path,32768).reference,state.headerReference))held();
    createReadonlyPrivateRecord(`${root}/dependency-transactions/${state.attempt.operationId}.close-unresolved.json`,encode({version:1,operationId:state.attempt.operationId}));
  });
}
