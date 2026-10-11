import { ensureHostedDependencyDirectory } from "./hosted-dependency-receipts";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { readHostedOrdinaryParentRecord, HostedOrdinaryParentRecordKind } from "./hosted-ordinary-parent-record-facts";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { DependencyOwnerPhase, isDependencyConsumerOwner, isDependencyCustodyObject, isDependencyProtectedReference,
  sameDependencyAttempt, sameDependencyProtectedReference, type DependencyAttempt, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { HostedCustodyReservationState, parseHostedOrdinaryStart, fenceDependencyConsumer } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, assertHostedActivationOperator, decodeHostedActivationBytes, readHostedActivationBytes,
  type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { assertHostedForegroundResult, readHostedForegroundLaunchObservation, type HostedForegroundResult } from "../provider-codex/app-server/adapters/hosted-fd-launch";
import { hostedDependencyOwnerRoot, readHostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { assertHostedDependencyParentRecipe } from "../provider-codex/app-server/adapters/hosted-dependency-parent-recipe";
import { HostedOrdinaryDependencyReaderKind } from "./hosted-ordinary-dependency-reader";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { readHostedOrdinaryBirth } from "./hosted-installation-origin-facts";
import { assertInspectedInstallation, assertActivationSession } from "./hosted-installation-physical-facts";
import { HostedReadonlyHostKernel, readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
import { collectUnitNotFound } from "./hosted-readonly-linux-collector";
import { parseHostedOrdinaryReaderTerminalFacts, matchesManagedProviderProxyWait, type HostedManagedProviderTerminalFacts } from "./hosted-managed-provider-terminal-facts";
const root="/var/lib/subscription-runtime-host-policy", encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function held():never {throw new Error("hosted_ordinary_reader_completion_held");}
const uuid=(v:unknown):v is string=>typeof v==="string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(v)?.[0]===v;
export interface HostedOrdinaryReaderParentCompletion {
  readonly schemaVersion:1;readonly start:DependencyProtectedReference;readonly preclaim:DependencyProtectedReference;
  readonly binding:DependencyProtectedReference;readonly attempt:DependencyAttempt;readonly unit:string;
  readonly invocationId:string;readonly proxyBirth:string;readonly waitStatus:number;readonly terminal:HostedManagedProviderTerminalFacts|null;
}
function boundary(fence:HostedActivationFence):void {assertHostedActivationFence(fence);assertHostedActivationOperator();assertHostedProcessDescriptors();}
function pin(fence:HostedActivationFence,name:string) {
  const prefixes:readonly [string,HostedOrdinaryParentRecordKind][]=[["ordinary-starts/",HostedOrdinaryParentRecordKind.Start],["dependency-reader-starts/",HostedOrdinaryParentRecordKind.Producer],
    ["dependency-ordinary-reader-completions/",HostedOrdinaryParentRecordKind.Completion],["dependency-attempt-fences/",HostedOrdinaryParentRecordKind.AttemptFence]];
  const selected=prefixes.find(([prefix])=>name.startsWith(prefix));if (!selected || !name.endsWith(".json")) held();
  return readHostedOrdinaryParentRecord(fence,selected[1],name.slice(selected[0].length,-5));
}
function selection(fence:HostedActivationFence,startId:string) {
  boundary(fence);if (!uuid(startId)) held();const startPin=pin(fence,`ordinary-starts/${startId}.json`),start=parseHostedOrdinaryStart(decodeHostedActivationBytes(startPin.bytes));
  if (start.unit!==`subscription-runtime-ordinary-${startId}.service`) held();
  const actual=readHostedOrdinaryBirth(start.jobId),{installation,activation}=actual,kernel=new HostedReadonlyHostKernel();
  assertInspectedInstallation(installation);assertActivationSession(activation,kernel.operatorSession());
  const row=activation.ordinaryStarts.find(value=>value.startId===startId),binding=readHostedDependencyBinding(start.jobId);
  if (!row || (row.state!==HostedCustodyReservationState.Reserved && row.state!==HostedCustodyReservationState.Terminal) ||
      row.unit!==start.unit || row.creatorId!==start.creatorId || row.originSha256!==start.originSha256 || row.generation!==start.activationGeneration ||
      start.installationId!==installation.installationId || start.bootId!==activation.bootId || start.supervisorId!==activation.supervisorId ||
      start.creatorPidBirth!==kernel.ordinaryCreatorBirth() || actual.originSha256!==start.originSha256 || actual.birth.workspacePath!==start.workspacePath ||
      actual.birth.jobRootDir!==start.jobRootDir || !binding || binding.version!==2 || binding.installationId!==installation.installationId ||
      binding.runtimeSha!==installation.runtimeSha || binding.grantDigest!==start.grantSha256 || binding.workspace.canonicalPath!==start.workspacePath || binding.jobRootDir!==start.jobRootDir) held();
  const bindingPin=readHostedOrdinaryParentRecord(fence,HostedOrdinaryParentRecordKind.Binding,binding.jobId),producer=pin(fence,`dependency-reader-starts/${startId}.json`),claim=decodeHostedActivationBytes(producer.bytes);
  if (!bindingPin.bytes.equals(encode(binding)) || !isDependencyCustodyObject(claim,"binding,kind,origin,preclaim,receipt,recipeSha256,version") ||
      claim.version!==1 || claim.kind!==HostedOrdinaryDependencyReaderKind.OrdinaryDependencyReaderV1 || !isDependencyProtectedReference(claim.origin) ||
      !sameDependencyProtectedReference(claim.origin,startPin.reference) || !isDependencyProtectedReference(claim.binding) ||
      !sameDependencyProtectedReference(claim.binding,bindingPin.reference) || !isDependencyCustodyObject(claim.preclaim,"attempt,ownerRevision,ownerSha256,version,workspace") ||
      claim.preclaim.version!==1 || typeof claim.preclaim.ownerRevision!=="number" || !Number.isSafeInteger(claim.preclaim.ownerRevision) || claim.preclaim.ownerRevision<1 ||
      typeof claim.preclaim.ownerSha256!=="string" || /^[a-f0-9]{64}$/.exec(claim.preclaim.ownerSha256)?.[0]!==claim.preclaim.ownerSha256 || !producer.bytes.equals(encode(claim)) || !encode(claim.preclaim.workspace).equals(encode(binding.workspace)) || !isDependencyCustodyObject(claim.preclaim.attempt,"attemptId,epoch,launch") ||
      !uuid(claim.preclaim.attempt.attemptId) || typeof claim.preclaim.attempt.epoch!=="number" || !Number.isSafeInteger(claim.preclaim.attempt.epoch) || claim.preclaim.attempt.epoch<1 ||
      !isDependencyCustodyObject(claim.preclaim.attempt.launch,"bootId,grantDigest,installationId,runtimeSha,startId,unit") ||
      !encode(claim.preclaim.attempt.launch).equals(encode({installationId:binding.installationId,bootId:start.bootId,runtimeSha:binding.runtimeSha,grantDigest:binding.grantDigest,startId,unit:start.unit}))) held();
  const attempt:DependencyAttempt={attemptId:claim.preclaim.attempt.attemptId,epoch:claim.preclaim.attempt.epoch,
    launch:{installationId:binding.installationId,bootId:start.bootId,runtimeSha:binding.runtimeSha,grantDigest:binding.grantDigest,startId,unit:start.unit}};
  const inventory=readHostedReadonlyHostInventory(),inventoryBytes=readHostedActivationBytes("readonly-inventory.json");
  const creators=inventory.ordinaryCreators.filter(value=>value.creatorId===start.creatorId && value.jobId===start.jobId && value.workspacePath===start.workspacePath && value.jobRootDir===start.jobRootDir);
  if (!inventoryBytes || hash(inventoryBytes)!==installation.inventorySha256 || creators.length!==1 || claim.recipeSha256!==hash(encode(creators[0]!.launch))) held();
  assertHostedDependencyParentRecipe(creators[0]!.launch.args,binding.jobRootDir,binding.workspace.canonicalPath);
  return {actual,startPin,start,row,binding,bindingPin,producer,attempt,kernel};
}
function native(fence:HostedActivationFence,facts:ReturnType<typeof selection>,receipt:HostedOrdinaryReaderParentCompletion,allowCollected:boolean):void {
  const pid=receipt.proxyBirth.split(":")[0]!;
  try {lstatSync(`/proc/${pid}`);held();} catch(error) {if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
  if (collectUnitNotFound(receipt.unit)) {if (!allowCollected && receipt.waitStatus!==0) held();}
  else {
    const result=spawnSync("/usr/bin/systemctl",["show","--all","--property=Id,InvocationID,ActiveState,SubState,MainPID,ControlPID,Job,ExecMainCode,ExecMainStatus,Result","--",receipt.unit],
      {encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:5000,maxBuffer:4096,env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",SYSTEMD_COLORS:"0"}});
    if (result.error || result.status!==0 || !matchesManagedProviderProxyWait(parseHostedOrdinaryReaderTerminalFacts(receipt.unit,result.stdout),receipt.invocationId,receipt.waitStatus) ||
        receipt.terminal!==null && !encode(parseHostedOrdinaryReaderTerminalFacts(receipt.unit,result.stdout)).equals(encode(receipt.terminal))) held();
  }
  if (!matchesManagedProviderProxyWait(receipt.terminal ?? undefined,receipt.invocationId,receipt.waitStatus)) held();
  if (receipt.waitStatus===0 && !readHostedOrdinaryParentRecord(fence,HostedOrdinaryParentRecordKind.ZeroCompletion,facts.row.startId).bytes.equals(encode({schemaVersion:1,startId:facts.row.startId,startSha256:facts.startPin.reference.sha256,waitStatus:0}))) held();
  facts.kernel.drainOrdinaryQueue(facts.row);facts.kernel.confirmOrdinaryDescendants(facts.row);
}
function stable(fence:HostedActivationFence,before:ReturnType<typeof selection>):void {
  const after=selection(fence,before.row.startId);
  if (!encode(after.actual).equals(encode(before.actual)) || !sameDependencyProtectedReference(after.startPin.reference,before.startPin.reference) ||
      !sameDependencyProtectedReference(after.bindingPin.reference,before.bindingPin.reference) || !sameDependencyProtectedReference(after.producer.reference,before.producer.reference)) held();boundary(fence);
}
/** Factual bytes only, selected by original FDA association before IO. The
 * private store independently requires the SAME retained physical child before
 * writing these bytes. No public writer/status/row registration exists. */
export function collectHostedOrdinaryReaderParentCompletion(fence:HostedActivationFence,result:HostedForegroundResult):HostedOrdinaryReaderParentCompletion {
  assertHostedForegroundResult(result);const observed=readHostedForegroundLaunchObservation(result),facts=selection(fence,observed.startId);
  if (observed.unit!==facts.row.unit || observed.closeStatus!==result.exitCode || result.exitCode<0 || result.exitCode>255) held();
  const collected=collectUnitNotFound(observed.unit);if (collected && observed.closeStatus!==0) held();
  const manager=collected ? undefined : spawnSync("/usr/bin/systemctl",["show","--all","--property=Id,InvocationID,ActiveState,SubState,MainPID,ControlPID,Job,ExecMainCode,ExecMainStatus,Result","--",observed.unit],
    {encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:5000,maxBuffer:4096,env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",SYSTEMD_COLORS:"0"}});
  if (manager && (manager.error || manager.status!==0)) held();const terminal=manager ? parseHostedOrdinaryReaderTerminalFacts(observed.unit,manager.stdout) : null;
  const receipt:HostedOrdinaryReaderParentCompletion=Object.freeze({schemaVersion:1,start:facts.startPin.reference,preclaim:facts.producer.reference,binding:facts.bindingPin.reference,
    attempt:facts.attempt,unit:observed.unit,invocationId:observed.invocationId,proxyBirth:observed.proxyBirth,waitStatus:observed.closeStatus,terminal});
  const owners=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try {const owner=owners.read(facts.binding.workspace);if (!owner || !isDependencyConsumerOwner(owner.owner) || owner.owner.phase!==DependencyOwnerPhase.Fenced ||
      !sameDependencyAttempt(owner.owner.attempt,facts.attempt)) held();} finally {owners.close();}
  const attemptFence=pin(fence,`dependency-attempt-fences/${facts.row.startId}.json`);
  if (!attemptFence.bytes.equals(encode({version:1,startId:facts.row.startId,attemptId:facts.attempt.attemptId,epoch:facts.attempt.epoch}))) held();
  native(fence,facts,receipt,false);stable(fence,facts);return receipt;
}
/** Independent historical parent proof. Never examines/authorizes a provider,
 * marks a row, releases credentials/home or recursively depends on child proof. */
export function readHostedOrdinaryReaderParentCompletion(fence:HostedActivationFence,startId:string,startSha256:string) {
  boundary(fence);if (typeof startSha256!=="string" || /^[a-f0-9]{64}$/.exec(startSha256)?.[0]!==startSha256) held();
  const facts=selection(fence,startId),completion=pin(fence,`dependency-ordinary-reader-completions/${startId}.json`),v=decodeHostedActivationBytes(completion.bytes);
  if (facts.startPin.reference.sha256!==startSha256 || !isDependencyCustodyObject(v,"attempt,binding,invocationId,preclaim,proxyBirth,schemaVersion,start,terminal,unit,waitStatus") ||
      v.schemaVersion!==1 || v.unit!==facts.row.unit || !isDependencyProtectedReference(v.start) || !sameDependencyProtectedReference(v.start,facts.startPin.reference) ||
      !isDependencyProtectedReference(v.preclaim) || !sameDependencyProtectedReference(v.preclaim,facts.producer.reference) ||
      !isDependencyProtectedReference(v.binding) || !sameDependencyProtectedReference(v.binding,facts.bindingPin.reference) || !encode(v.attempt).equals(encode(facts.attempt)) ||
      typeof v.invocationId!=="string" || /^[a-f0-9]{32}$/.exec(v.invocationId)?.[0]!==v.invocationId || typeof v.proxyBirth!=="string" ||
      /^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/.exec(v.proxyBirth)?.[0]!==v.proxyBirth || typeof v.waitStatus!=="number" || !Number.isInteger(v.waitStatus) || v.waitStatus<0 || v.waitStatus>255 ||
      (v.terminal===null ? v.waitStatus!==0 : !isDependencyCustodyObject(v.terminal,"invocationId,kind,result,status,unit")) || !completion.bytes.equals(encode(v))) held();
  const t=v.terminal;if (t!==null && !isDependencyCustodyObject(t,"invocationId,kind,result,status,unit")) held();
  const terminal=t===null ? null : parseHostedOrdinaryReaderTerminalFacts(facts.row.unit,
    `Id=${t.unit}\nInvocationID=${t.invocationId}\nActiveState=failed\nSubState=failed\nMainPID=0\nControlPID=0\nJob=\nExecMainCode=${t.kind}\nExecMainStatus=${t.status}\nResult=${t.result}\n`);
  const receipt:HostedOrdinaryReaderParentCompletion={schemaVersion:1,start:v.start,preclaim:v.preclaim,binding:v.binding,attempt:facts.attempt,unit:facts.row.unit,
    invocationId:v.invocationId,proxyBirth:v.proxyBirth,waitStatus:v.waitStatus,terminal};
  if (!encode(terminal).equals(encode(t))) held();native(fence,facts,receipt,true);stable(fence,facts);
  if (!pin(fence,`dependency-ordinary-reader-completions/${startId}.json`).bytes.equals(completion.bytes)) held();boundary(fence);
  return Object.freeze({...facts,completion:completion.reference,receipt});
}

/** Containment only, selected by SAME genuine FDA result before IO. It cannot
 * manufacture completion, release an owner or stop an unrelated process. No
 * unnecessary stop effect is required for an already proven completed child. */
export function fenceHostedOrdinaryReaderOwner(fence:HostedActivationFence,result:HostedForegroundResult):void {
  assertHostedForegroundResult(result);const observed=readHostedForegroundLaunchObservation(result),facts=selection(fence,observed.startId);
  if (facts.row.state!==HostedCustodyReservationState.Reserved || facts.row.unit!==observed.unit) held();
  const owners=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try {const owner=owners.read(facts.binding.workspace);if (!owner || !isDependencyConsumerOwner(owner.owner) ||
      !sameDependencyAttempt(owner.owner.attempt,facts.attempt)) held();fenceDependencyConsumer(owners,facts.binding.workspace,facts.attempt);
  } finally {owners.close();}
  ensureHostedDependencyDirectory(`${root}/dependency-attempt-fences`);
  createReadonlyPrivateRecord(`${root}/dependency-attempt-fences/${facts.row.startId}.json`,encode({version:1,startId:facts.row.startId,attemptId:facts.attempt.attemptId,epoch:facts.attempt.epoch}));
  stable(fence,facts);
}
