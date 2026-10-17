import { readOriginalHostedDependencyGenerationNativeScope } from "./hosted-dependency-generation-native-scope";
import type { CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { assertOriginalHostedDependencyPhysicalRecordAccess, assertOriginalHostedDependencyOperatorDescriptors, CurrentHostedDependencyOriginKind } from "./hosted-current-dependency-origin";
import { readHostedOrdinaryReaderParentCompletion, readOriginalHostedOrdinaryReaderParentCompletion, readOriginalHostedConsumerReaderParentCompletion } from "./hosted-ordinary-reader-parent-completion";
import { ScopedTerminationExtent, parseScopedProviderOnlyReceipt, type ScopedProviderOnlyReceipt } from "@vioxen/subscription-runtime/core";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { DependencyCustodyEvidenceKind, DependencyOwnerPhase, isDependencyConsumerOwner, isDependencyCustodyObject,
  isDependencyProtectedReference, parseDependencyOwner, sameDependencyAttempt, sameDependencyProtectedReference,
  sameDependencyWorkspace, type DependencyAttempt, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { HostedActivationPhase, HostedCustodyReservationState, parseHostedOrdinaryStart, parseHostedActivation, type HostedOrdinaryReservation } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, assertHostedActivationOperator, decodeHostedActivationBytes, readHostedActivationBytes,
  type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { HostedDependencyRootOriginKind } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { hostedDependencyBindingName, readHostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedDependencyParentRecipe } from "./hosted-dependency-parent-recipe";
import { dependencyToolQualificationRecordName } from "../core/dependency-environment/dependency-tool-profile";
import { readHostedOrdinaryBirth } from "./hosted-installation-activation";
import { readRetainedOrdinaryBirth } from "./hosted-installation-origin-facts";
import { HostedReadonlyEpochStore } from "./hosted-readonly-epoch-store";
import { readHostedReadonlyDependencyMaterial } from "./hosted-readonly-dependency-records";
import { HostedReadonlyHostKernel, readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
import { parseOrdinaryRootPreparationFacts } from "./hosted-dependency-root-provenance-facts";
import { readHostedDependencyRecoveryAdmissionFacts } from "./hosted-dependency-recovery-admission-facts";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { readHostedDependencyRootDirectoryPin, rootDescriptorPhysicalInfo } from "./hosted-dependency-root-physical-facts";
import { collectProcessBirth, collectProcessCgroup, collectUnitNotFound } from "./hosted-readonly-linux-collector";
import { matchesManagedProviderProxyWait, parseHostedManagedProviderTerminalFacts,
  type HostedManagedProviderTerminalFacts } from "./hosted-managed-provider-terminal-facts";

const root="/var/lib/subscription-runtime-host-policy";
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const uuid=(v:unknown):v is string=>typeof v==="string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(v)?.[0]===v;
function held():never {throw new Error("hosted_ordinary_provider_recovery_held");}
type FailureReceipt=Readonly<{schemaVersion:2;parentAttempt:DependencyAttempt;unit:string;providerStartId:string;
  providerReference:DependencyProtectedReference;ordinaryProviderReference:DependencyProtectedReference;parentReference:DependencyProtectedReference;
  relation:unknown;invocationId:string;proxyBirth:string;waitStatus:number;home:unknown;use:unknown;terminal:HostedManagedProviderTerminalFacts|null}>;
/** Captured protected bytes only. Parsing never publishes a row or authorizes IO/release. */
function parseCompletionReceipt(bytes:Buffer):FailureReceipt {
  if (!Buffer.isBuffer(bytes) || bytes.length<1 || bytes.length>16384) held(); const v=decodeHostedActivationBytes(bytes);
  if (!isDependencyCustodyObject(v,"home,invocationId,ordinaryProviderReference,parentAttempt,parentReference,providerReference,providerStartId,proxyBirth,relation,schemaVersion,terminal,unit,use,waitStatus") ||
      v.schemaVersion!==2 || !uuid(v.providerStartId) || typeof v.unit!=="string" || v.unit!==`subscription-runtime-hosted-${v.providerStartId}.service` ||
      !isDependencyCustodyObject(v.parentAttempt,"attemptId,epoch,launch") || !uuid(v.parentAttempt.attemptId) ||
      typeof v.parentAttempt.epoch!=="number" || !Number.isSafeInteger(v.parentAttempt.epoch) || v.parentAttempt.epoch<1 ||
      !isDependencyCustodyObject(v.parentAttempt.launch,"bootId,grantDigest,installationId,runtimeSha,startId,unit")) held();
  const a=v.parentAttempt; if (!isDependencyCustodyObject(a,"attemptId,epoch,launch")) held();
  const launch=a.launch; if (!isDependencyCustodyObject(launch,"bootId,grantDigest,installationId,runtimeSha,startId,unit")) held();
  if (!uuid(a.attemptId) || typeof a.epoch!=="number" || !Number.isSafeInteger(a.epoch) || a.epoch<1 || !uuid(launch.installationId) || !uuid(launch.bootId) || !uuid(launch.startId) || typeof launch.unit!=="string" || launch.unit!==`subscription-runtime-ordinary-${launch.startId}.service` ||
      typeof launch.runtimeSha!=="string" || /^[a-f0-9]{40}$/.exec(launch.runtimeSha)?.[0]!==launch.runtimeSha ||
      typeof launch.grantDigest!=="string" || /^[a-f0-9]{64}$/.exec(launch.grantDigest)?.[0]!==launch.grantDigest ||
      !isDependencyProtectedReference(v.providerReference) || v.providerReference.path!==`${root}/dependency-managed-provider-starts/${v.providerStartId}.json` ||
      !isDependencyProtectedReference(v.ordinaryProviderReference) || v.ordinaryProviderReference.path!==`${root}/ordinary-starts/${v.providerStartId}.json` ||
      !isDependencyProtectedReference(v.parentReference) || v.parentReference.path!==`${root}/ordinary-starts/${launch.startId}.json` ||
      typeof v.invocationId!=="string" || /^[a-f0-9]{32}$/.exec(v.invocationId)?.[0]!==v.invocationId ||
      typeof v.proxyBirth!=="string" || /^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/.exec(v.proxyBirth)?.[0]!==v.proxyBirth ||
      typeof v.waitStatus!=="number" || !Number.isInteger(v.waitStatus) || v.waitStatus<0 || v.waitStatus>255 ||
      !isDependencyCustodyObject(v.relation,"attemptId,epoch,parentStartId,providerStartId,startDigest,unit,version") ||
      v.relation.version!==1 || v.relation.parentStartId!==launch.startId || v.relation.providerStartId!==v.providerStartId ||
      v.relation.attemptId!==a.attemptId || v.relation.epoch!==a.epoch || v.relation.unit!==v.unit || v.relation.startDigest!==v.ordinaryProviderReference.sha256 ||
      !isDependencyCustodyObject(v.home,"canonicalPath,dev,ino,mountId") || typeof v.home.canonicalPath!=="string" ||
      v.home.canonicalPath.length>4096 || /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.exec(v.home.canonicalPath)?.[0]!==v.home.canonicalPath ||
      v.home.canonicalPath.split("/").some(part=>part==="." || part==="..") ||
      typeof v.home.dev!=="string" || /^(?:0|[1-9][0-9]{0,19})$/.exec(v.home.dev)?.[0]!==v.home.dev ||
      typeof v.home.ino!=="string" || /^[1-9][0-9]{0,19}$/.exec(v.home.ino)?.[0]!==v.home.ino ||
      typeof v.home.mountId!=="string" || /^[1-9][0-9]{0,19}$/.exec(v.home.mountId)?.[0]!==v.home.mountId ||
      !isDependencyCustodyObject(v.use,"accountId,restoredHash") || typeof v.use.accountId!=="string" ||
      v.use.accountId.length<1 || v.use.accountId.length>128 || v.use.accountId.includes("\0") || typeof v.use.restoredHash!=="string" ||
      /^[a-f0-9]{64}$/.exec(v.use.restoredHash)?.[0]!==v.use.restoredHash ||
      (v.terminal===null ? v.waitStatus!==0 : !isDependencyCustodyObject(v.terminal,"invocationId,kind,result,status,unit")) || !encode(v).equals(bytes)) held();
  const t=v.terminal;if (t!==null && !isDependencyCustodyObject(t,"invocationId,kind,result,status,unit")) held();
  const terminal=t===null ? null : parseHostedManagedProviderTerminalFacts(v.unit,
    `Id=${t.unit}\nInvocationID=${t.invocationId}\nActiveState=failed\nSubState=failed\nMainPID=0\nControlPID=0\nJob=\nExecMainCode=${t.kind}\nExecMainStatus=${t.status}\nResult=${t.result}\n`);
  if (!encode(terminal).equals(encode(t)) || !matchesManagedProviderProxyWait(terminal ?? undefined,v.invocationId,v.waitStatus)) held();
  return Object.freeze({schemaVersion:2,parentAttempt:{attemptId:a.attemptId,epoch:a.epoch,
    launch:{installationId:launch.installationId,bootId:launch.bootId,runtimeSha:launch.runtimeSha,grantDigest:launch.grantDigest,startId:launch.startId,unit:launch.unit}},
    unit:v.unit,providerStartId:v.providerStartId,providerReference:v.providerReference,ordinaryProviderReference:v.ordinaryProviderReference,
    parentReference:v.parentReference,relation:v.relation,invocationId:v.invocationId,proxyBirth:v.proxyBirth,waitStatus:v.waitStatus,home:v.home,use:v.use,terminal});
}

export function parseHostedOrdinaryProviderFailureReceipt(bytes:Buffer):FailureReceipt & {readonly terminal:HostedManagedProviderTerminalFacts} {
  const receipt=parseCompletionReceipt(bytes);if (!receipt.waitStatus || !receipt.terminal) held();return {...receipt,terminal:receipt.terminal};
}

function sameFile(a: BigIntStats,b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
    a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
/** Paths come only from fixed local recipes below, never an exported opener. */
function fixedPin(path: string, maximum = 16384) {
  const parts = path.split("/").filter(Boolean); if (parts.length < 2 || parts.length > 128) held();
  const directories: {path:string;fd:number;stat:BigIntStats;mountId:string;flags:number}[] = [], openedDirectories: number[] = []; let fd: number | undefined;
  try {
    let parent = "/";
    for (let i = 0; i < parts.length; i++) {
      const selected = i === 0 ? "/" : `/proc/self/fd/${directories[i-1]!.fd}/${parts[i-1]}`;
      const directoryFd = openSync(selected,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      openedDirectories.push(directoryFd);
      const stat = fstatSync(directoryFd,{bigint:true}),physical=rootDescriptorPhysicalInfo(directoryFd);
      directories.push({path:parent,fd:directoryFd,stat,...physical});
      if (!stat.isDirectory() || stat.uid !== 0n || stat.gid !== 0n || (stat.mode & 0o022n) ||
          (i === parts.length-1 && (stat.mode & 0o7777n) !== 0o700n)) held();
      parent = parent === "/" ? "/"+parts[i] : parent+"/"+parts[i];
    }
    const leaf = directories.at(-1)!;
    fd = openSync(`/proc/self/fd/${leaf.fd}/${parts.at(-1)!}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before = fstatSync(fd,{bigint:true}),leafPhysical=rootDescriptorPhysicalInfo(fd);
    if (leafPhysical.mountId!==leaf.mountId) held();
    if (!before.isFile() || before.uid !== 0n || before.gid !== 0n || before.nlink !== 1n ||
        (before.mode & 0o7777n) !== 0o600n || before.size < 1n || before.size > BigInt(maximum)) held();
    const bytes = Buffer.alloc(Number(before.size)+1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd,bytes,length,bytes.length-length,length); if (!count) break; length += count; }
    if (!encode(rootDescriptorPhysicalInfo(fd)).equals(encode(leafPhysical)) || BigInt(length) !== before.size || !sameFile(before,fstatSync(fd,{bigint:true})) || !sameFile(before,lstatSync(path,{bigint:true}))) held();
    for (const directory of directories) {
      const current = lstatSync(directory.path,{bigint:true}), retained = fstatSync(directory.fd,{bigint:true});
      const physical=rootDescriptorPhysicalInfo(directory.fd),named=readHostedDependencyRootDirectoryPin(directory.path);
      if (physical.flags!==directory.flags || physical.mountId!==directory.mountId || named.mountId!==directory.mountId) held();
      if (!current.isDirectory() || [current,retained].some(stat => stat.dev !== directory.stat.dev || stat.ino !== directory.stat.ino ||
          stat.uid !== directory.stat.uid || stat.gid !== directory.stat.gid || stat.mode !== directory.stat.mode)) held();
    }
    return {bytes:bytes.subarray(0,length),reference:{path,identity:{dev:String(before.dev),ino:String(before.ino)},sha256:hash(bytes.subarray(0,length))}};
  } finally {
    let failure: unknown;
    for (const retained of [...(fd === undefined ? [] : [fd]),...openedDirectories.reverse()]) {
      try { closeSync(retained); } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  }
}
function wire(pin: ReturnType<typeof fixedPin>) {
  const value = decodeHostedActivationBytes(pin.bytes); if (!encode(value).equals(pin.bytes)) held(); return value;
}
function referenced(reference: unknown,path: string,maximum = 16384) {
  if (!isDependencyProtectedReference(reference) || reference.path !== path) held();
  const pin = fixedPin(path,maximum); if (!sameDependencyProtectedReference(pin.reference,reference)) held(); return pin;
}
function boundary(fence: HostedActivationFence,access?:symbol,context?:CurrentHostedDependencyOrigin): void {
  assertHostedActivationFence(fence); assertHostedActivationOperator();
  if(access===undefined)assertHostedProcessDescriptors();else {assertOriginalHostedDependencyPhysicalRecordAccess(access);if(context)readOriginalHostedDependencyGenerationNativeScope(context,fence,access);else assertOriginalHostedDependencyOperatorDescriptors(fence,access);}
}


/** Selected-C historical creator proof only. The same fixed protected records
 * were emitted by the original-map native-child producer. This reader cannot
 * mint them, publish Terminal or release a home/credential. Independent parent
 * native completion is a separate fixed proof, never a recursive child grant.
 * The SAME fixed reader proves its own provider queue/recursive drain before
 * either scheduling publication or retained Terminal readback.
 */
function readCompletionForFinal(fence:HostedActivationFence,startId:string,startSha256:string,phase:HostedCustodyReservationState,access?:symbol,context?:CurrentHostedDependencyOrigin):ScopedProviderOnlyReceipt {
  boundary(fence,access,context); if (!uuid(startId) || /^[a-f0-9]{64}$/.exec(startSha256)?.[0]!==startSha256) held();
  const receiptPin=fixedPin(`${root}/dependency-ordinary-provider-completions/${startId}.json`),receipt=parseCompletionReceipt(receiptPin.bytes);
  const attempt=receipt.parentAttempt,parentId=attempt.launch.startId,providerPin=referenced(receipt.ordinaryProviderReference,`${root}/ordinary-starts/${startId}.json`);
  if (providerPin.reference.sha256!==startSha256) held();
  const provider=parseHostedOrdinaryStart(wire(providerPin)),parentPin=referenced(receipt.parentReference,`${root}/ordinary-starts/${parentId}.json`);
  const parent=parseHostedOrdinaryStart(wire(parentPin)),actual=access===undefined?readHostedOrdinaryBirth(parent.jobId):readRetainedOrdinaryBirth(parent.jobId),{installation,activation}=actual;
  const kernel=new HostedReadonlyHostKernel(),scope=context&&access!==undefined?readOriginalHostedDependencyGenerationNativeScope(context,fence,access):undefined,
    session=scope?(scope.facts.kind===CurrentHostedDependencyOriginKind.Ordinary?kernel.ordinaryRuntimeSession(parseHostedOrdinaryStart(scope.facts.ordinary.start)):kernel.session()):kernel.operatorSession(),inventory=readHostedReadonlyHostInventory();
  if(context){const supervisor=inventory.units.find(v=>v.name===inventory.supervisorUnit),pid=parent.creatorPidBirth.split(":")[0]!;
    if(!supervisor || collectProcessBirth(pid)!==parent.creatorPidBirth || collectProcessCgroup(pid)!==`0::${supervisor.controlGroup}`)held();}
  const parentRow=activation.ordinaryStarts.find(row=>row.startId===parentId),row=activation.ordinaryStarts.find(value=>value.startId===startId);
  if (access===undefined && activation.phase!==HostedActivationPhase.Ordinary || session.hostId!==activation.hostId || session.bootId!==activation.bootId ||
      session.supervisorId!==activation.supervisorId || parent.bootId!==session.bootId || parent.supervisorId!==session.supervisorId ||
      !parentRow || !row || row.state!==phase || access!==undefined && (row.state!==HostedCustodyReservationState.Terminal || parentRow.state!==HostedCustodyReservationState.Terminal) ||
      (parentRow.state!==HostedCustodyReservationState.Reserved && parentRow.state!==HostedCustodyReservationState.Terminal) ||
      parentRow.unit!==attempt.launch.unit || parentRow.unit!==parent.unit || parentRow.creatorId!==parent.creatorId ||
      parentRow.originSha256!==parent.originSha256 || parentRow.generation!==parent.activationGeneration ||
      parent.originSha256!==actual.originSha256 || parent.installationId!==installation.installationId ||
      parent.jobRootDir!==actual.birth.jobRootDir || parent.workspacePath!==actual.birth.workspacePath ||
      (!context && parent.creatorPidBirth!==kernel.ordinaryCreatorBirth()) || row.unit!==receipt.unit || row.creatorId!==parent.creatorId ||
      row.originSha256!==parent.originSha256 || row.generation!==provider.activationGeneration || row.generation>activation.generation ||
      provider.unit!==row.unit || provider.controlGroup!==`/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${row.unit}` ||
      (["installationId","jobId","jobRootDir","workspacePath","bootId","supervisorId","originSha256","creatorId","grantSha256"] as const).some(key=>
        provider[key]!==parent[key])) held();
  const inventoryPin=fixedPin(`${root}/readonly-inventory.json`,65536);
  if (inventoryPin.reference.sha256!==installation.inventorySha256 || !inventoryPin.bytes.equals(encode(inventory))) held();
  const binding=readHostedDependencyBinding(parent.jobId); if (!binding || binding.version!==2 ||
      binding.installationId!==installation.installationId || binding.runtimeSha!==installation.runtimeSha || binding.grantDigest!==parent.grantSha256 ||
      binding.jobRootDir!==parent.jobRootDir || binding.workspace.canonicalPath!==parent.workspacePath ||
      attempt.launch.installationId!==binding.installationId || attempt.launch.runtimeSha!==binding.runtimeSha ||
      attempt.launch.bootId!==parent.bootId || attempt.launch.grantDigest!==binding.grantDigest) held();
  const bindingPin=fixedPin(`${root}/${hostedDependencyBindingName(binding.jobId)}`);
  if (!bindingPin.bytes.equals(encode(binding))) held();
  const ordinaryParentCompletion=readHostedActivationBytes(`ordinary-completed/${parentId}.json`);
  const parentCompletion=ordinaryParentCompletion ? fixedPin(`${root}/ordinary-completed/${parentId}.json`,4096) :
    fixedPin((access===undefined ? readHostedOrdinaryReaderParentCompletion(fence,parentId,parentPin.reference.sha256) : (context ? readOriginalHostedConsumerReaderParentCompletion(context,fence,parentId,parentPin.reference.sha256,access) : readOriginalHostedOrdinaryReaderParentCompletion(fence,parentId,parentPin.reference.sha256,access))).completion.path);
  if (ordinaryParentCompletion && !parentCompletion.bytes.equals(encode({schemaVersion:1,startId:parentId,startSha256:parentPin.reference.sha256,waitStatus:0}))) held();
  if (receipt.waitStatus===0 && !fixedPin(`${root}/ordinary-completed/${startId}.json`,4096).bytes.equals(encode({schemaVersion:1,startId,startSha256,waitStatus:0}))) held();
  const fencePin=fixedPin(`${root}/dependency-attempt-fences/${parentId}.json`,4096);
  if (!fencePin.bytes.equals(encode({version:1,startId:parentId,attemptId:attempt.attemptId,epoch:attempt.epoch}))) held();
  const ownerName=`dependency-owners/${binding.workspace.dev}-${binding.workspace.ino}`;
  if (readHostedActivationBytes(ownerName+".lock")) held();
  const ownerPin=fixedPin(`${root}/${ownerName}.json`),owner=parseDependencyOwner(wire(ownerPin));
  // Original C facts remain unchanged after genuine structural R adoption.
  // Only the private terminal-history path rejoins that actual stored custody;
  // raw finalization cannot waive its v2/live-Ordinary owner contract.
  const custody=owner.version===3 && access!==undefined ? (()=>{
    const epoch=new HostedReadonlyEpochStore().readEpoch(),material=readHostedReadonlyDependencyMaterial(fence,epoch.identity),a=material.evidence;
    if(a.kind!==DependencyCustodyEvidenceKind.ReadonlyColdBaselineAdoptionV2 ||
        !sameDependencyProtectedReference(owner.custodyBinding,material.reference) || a.candidate.jobId!==binding.jobId ||
        !sameDependencyWorkspace(a.workspace,binding.workspace) || !sameDependencyProtectedReference(a.candidate.binding,bindingPin.reference) ||
        epoch.hostId!==session.hostId || epoch.bootId!==session.bootId || epoch.supervisorId!==session.supervisorId)held();
    return {epoch,material};
  })():undefined;
  if ((owner.version!==2 && !custody) || !sameDependencyWorkspace(owner.workspace,binding.workspace) || owner.epoch<attempt.epoch ||
      (parentRow.state===HostedCustodyReservationState.Reserved && (!isDependencyConsumerOwner(owner.owner) ||
        owner.owner.phase!==DependencyOwnerPhase.Fenced || !sameDependencyAttempt(owner.owner.attempt,attempt))) ||
      (isDependencyConsumerOwner(owner.owner) && sameDependencyAttempt(owner.owner.attempt,attempt) && owner.owner.phase!==DependencyOwnerPhase.Fenced)) held();
  const producer=fixedPin(`${root}/dependency-reader-starts/${parentId}.json`),claim=wire(producer);
  const creators=inventory.ordinaryCreators.filter(value=>value.creatorId===parent.creatorId && value.jobId===binding.jobId &&
    value.jobRootDir===binding.jobRootDir && value.workspacePath===binding.workspace.canonicalPath);
  if (creators.length!==1) held(); const recipe=creators[0]!.launch;
  readHostedDependencyParentRecipe(recipe,binding.jobRootDir,binding.workspace.canonicalPath);
  if (!isDependencyCustodyObject(claim,"binding,kind,origin,preclaim,receipt,recipeSha256,version") || claim.version!==1 ||
      claim.kind!==HostedDependencyRootOriginKind.OrdinaryDependencyReaderV1 || claim.recipeSha256!==hash(encode(recipe)) ||
      !isDependencyCustodyObject(claim.preclaim,"attempt,ownerRevision,ownerSha256,version,workspace") || claim.preclaim.version!==1 ||
      typeof claim.preclaim.ownerRevision!=="number" || !Number.isSafeInteger(claim.preclaim.ownerRevision) || claim.preclaim.ownerRevision<1 ||
      owner.revision<=claim.preclaim.ownerRevision || typeof claim.preclaim.ownerSha256!=="string" ||
      /^[a-f0-9]{64}$/.exec(claim.preclaim.ownerSha256)?.[0]!==claim.preclaim.ownerSha256 ||
      !encode(claim.preclaim.attempt).equals(encode(attempt)) || !encode(claim.preclaim.workspace).equals(encode(binding.workspace)) ||
      !isDependencyProtectedReference(claim.origin) || !sameDependencyProtectedReference(claim.origin,parentPin.reference) ||
      !isDependencyProtectedReference(claim.binding) || !sameDependencyProtectedReference(claim.binding,bindingPin.reference)) held();
  const entry=fixedPin(`${root}/dependency-reader-entries/${parentId}.json`,4096);
  if (!entry.bytes.equals(encode({version:1,producer:producer.reference,attempt}))) held();
  const preparation=fixedPin(`${root}/dependency-root-preparations/${parentId}.json`,65536);
  const prepared=parseOrdinaryRootPreparationFacts(preparation.bytes,attempt,{origin:parentPin.reference,producer:producer.reference,entry:entry.reference});
  const qualification=referenced(prepared.qualification,`${root}/${dependencyToolQualificationRecordName(parentId)}`);
  const admitted=readHostedDependencyRecoveryAdmissionFacts(fence,binding,attempt,prepared,qualification.bytes);
  const profile=referenced(prepared.protectedProfile,`${root}/dependency-installer-profile.json`),profileValue=wire(profile);
  if (!profileValue || typeof profileValue!=="object" || !("schemaVersion" in profileValue) || profileValue.schemaVersion!==2) held();
  const relation=fixedPin(`${root}/dependency-provider-attempts/${startId}.json`,4096);
  if (!relation.bytes.equals(encode(receipt.relation))) held();
  const birth=referenced(receipt.providerReference,`${root}/dependency-managed-provider-starts/${startId}.json`);
  const birthAdmission=admitted.version===1 ? {ready:admitted.ready,readyRevision:admitted.readyRevision} : admitted.version===3 ?
    {execution:admitted.execution,baselineReady:admitted.baselineReady,baselineReadyRevision:admitted.baselineReadyRevision} :
    {execution:admitted.execution,unverified:admitted.unverified,unverifiedRevision:admitted.unverifiedRevision};
  const expectedBirth={version:admitted.version===1?2:admitted.version===3?6:4,originKind:HostedDependencyRootOriginKind.OrdinaryDependencyReaderV1,installationId:binding.installationId,runtimeSha:binding.runtimeSha,
    hostId:activation.hostId,bootId:activation.bootId,supervisorId:activation.supervisorId,generation:row.generation,parentGeneration:parentRow.generation,
    unit:row.unit,providerStartId:startId,parentStartId:parentId,logicalJobId:binding.jobId,executionJobId:binding.jobId,jobRootDir:binding.jobRootDir,
    workspace:binding.workspace,attempt,originReference:parentPin.reference,ordinaryProviderReference:providerPin.reference,
    readerProducer:producer.reference,readerEntry:entry.reference,ordinaryRelation:receipt.relation,...birthAdmission,qualification:qualification.reference,protectedProfile:profile.reference};
  if (!birth.bytes.equals(encode(expectedBirth)) || !isDependencyCustodyObject(receipt.home,"canonicalPath,dev,ino,mountId") ||
      receipt.home.canonicalPath!==`${binding.jobRootDir}/home/codex-session-cache/dependency-${attempt.attemptId}`) held();
  const pid=receipt.proxyBirth.slice(0,receipt.proxyBirth.indexOf(":"));
  try {lstatSync(`/proc/${pid}`);held();} catch(error) {if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
  if (!collectUnitNotFound(row.unit)) {
    const observation=spawnSync("/usr/bin/systemctl",["show","--all","--property=Id,InvocationID,ActiveState,SubState,MainPID,ControlPID,Job,ExecMainCode,ExecMainStatus,Result","--",row.unit],
      {encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:5000,maxBuffer:4096,env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",SYSTEMD_COLORS:"0"}});
    if (observation.error || observation.status!==0 || !matchesManagedProviderProxyWait(parseHostedManagedProviderTerminalFacts(row.unit,observation.stdout),receipt.invocationId,receipt.waitStatus) ||
        receipt.terminal!==null && !encode(parseHostedManagedProviderTerminalFacts(row.unit,observation.stdout)).equals(encode(receipt.terminal))) held();
  }
  // Native creator/attempt fencing precedes this SAME selected provider drain.
  // Parent/installer drain cannot stand in for its queue or descendants.
  kernel.drainOrdinaryQueue(row);kernel.confirmOrdinaryDescendants(row);
  // Close every retained file before strict descriptor collection. Exact bytes,
  // identities and current catalog are reobserved, never caller proof snapshots.
  for (const pin of [receiptPin,providerPin,parentPin,inventoryPin,bindingPin,parentCompletion,fencePin,ownerPin,producer,entry,preparation,qualification,profile,relation,birth]) {
    if (!readHostedPrivateBytes(pin.reference.path,pin.bytes.length)?.equals(pin.bytes) ||
        !sameDependencyProtectedReference(fixedPin(pin.reference.path,pin.bytes.length).reference,pin.reference)) held();
  }
  if (readHostedActivationBytes(ownerName+".lock")) held();
  if(custody && (!encode(new HostedReadonlyEpochStore().readEpoch()).equals(encode(custody.epoch)) ||
      !encode(readHostedReadonlyDependencyMaterial(fence,custody.epoch.identity)).equals(encode(custody.material))))held();
  const after=access===undefined?readHostedOrdinaryBirth(parent.jobId):readRetainedOrdinaryBirth(parent.jobId);
  if (!encode(after.installation).equals(encode(installation)) || !encode(after.activation).equals(encode(activation)) ||
      after.originSha256!==actual.originSha256 || !encode(after.birth).equals(encode(actual.birth))) held();
  boundary(fence,access,context);
  const member=(r:HostedOrdinaryReservation,reference:DependencyProtectedReference)=>({startId:r.startId,unit:r.unit,creatorId:r.creatorId,originSha256:r.originSha256,generation:r.generation,start:reference});
  return parseScopedProviderOnlyReceipt({schemaVersion:2,extent:ScopedTerminationExtent.ProviderOnly,publicationGeneration:activation.generation+1,
    identity:{installationId:installation.installationId,hostId:activation.hostId,bootId:activation.bootId,supervisorId:activation.supervisorId,runtimeSha:installation.runtimeSha},
    parent:member(parentRow,parentPin.reference),provider:member(row,providerPin.reference),attempt:{attemptId:attempt.attemptId,epoch:attempt.epoch,grantDigest:attempt.launch.grantDigest},
    home:receipt.home,use:receipt.use,completion:receiptPin.reference});
}

/** Existing nonzero creator guard remains Terminal-only. Parent failure proof
 * is independent, fixed and native-authenticated, never a recursive child grant. */
export function assertHostedOrdinaryProviderFailureCreator(fence:HostedActivationFence,startId:string,startSha256:string):void {
  boundary(fence);if (!uuid(startId) || /^[a-f0-9]{64}$/.exec(startSha256)?.[0]!==startSha256) held();parseHostedOrdinaryProviderFailureReceipt(fixedPin(`${root}/dependency-ordinary-provider-completions/${startId}.json`).bytes);
  readCompletionForFinal(fence,startId,startSha256,HostedCustodyReservationState.Terminal);
}
/** Factual protected recovery of this exact provider before final parent
 * accounting. No arbitrary phase/receipt/child setter and no publication IO. */
export function readHostedOrdinaryProviderCompletionForFinal(fence:HostedActivationFence,startId:string,startSha256:string):ScopedProviderOnlyReceipt {
  return providerCompletion(fence,startId,startSha256);
}
export function readOriginalHostedOrdinaryProviderCompletionForFinal(fence:HostedActivationFence,startId:string,startSha256:string,access:symbol):ScopedProviderOnlyReceipt {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);return providerCompletion(fence,startId,startSha256,access);
}
export function readOriginalHostedConsumerProviderCompletionForFinal(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,startId:string,startSha256:string,access:symbol):ScopedProviderOnlyReceipt {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);return providerCompletion(fence,startId,startSha256,access,context);
}
function providerCompletion(fence:HostedActivationFence,startId:string,startSha256:string,access?:symbol,context?:CurrentHostedDependencyOrigin):ScopedProviderOnlyReceipt {
  boundary(fence,access,context);if (!uuid(startId) || /^[a-f0-9]{64}$/.exec(startSha256)?.[0]!==startSha256) held();const bytes=readHostedActivationBytes("host-activation.json");if (!bytes) held();
  const activation=parseHostedActivation(decodeHostedActivationBytes(bytes)),row=activation.ordinaryStarts.find(value=>value.startId===startId);
  if (!row ||
      row.state!==HostedCustodyReservationState.Reserved && row.state!==HostedCustodyReservationState.Terminal) held();
  return readCompletionForFinal(fence,startId,startSha256,row.state,access,context);
}
