import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { DependencyConsumerLaunchKind, isDependencyCustodyObject, isDependencyProtectedReference,
  sameDependencyProtectedReference, type DependencyProtectedReference } from "../core/dependency-environment/dependency-custody-evidence";
import { DependencyOwnerPhase, isDependencyConsumerOwner, isDependencyCustodyLaunch, parseDependencyOwner } from "../core/dependency-environment/dependency-owner";
import { sameDependencyWorkspace } from "../core/dependency-environment/dependency-workspace";
import { HostedCustodyPhase, HostedCustodyReservationState, parseHostedCustodyEpoch } from "../worker-core/hosted-custody/domain/hosted-custody-epoch";
import { assertHostedActivationFence, assertHostedActivationOperator, decodeHostedActivationBytes, readHostedActivationBytes,
  type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { readHostedReadonlyDependencyStart } from "../provider-codex/app-server/adapters/hosted-dependency-origin";
import { readHostedDependencyBinding, hostedDependencyBindingName } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { dependencyToolQualificationRecordName, parseDependencyToolQualification } from "../core/dependency-environment/dependency-tool-profile";
import { readHostedReadonlyDependencyMaterial } from "./hosted-readonly-dependency-records";
import { readHostedDependencyCommittedReady } from "./hosted-dependency-receipts";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { collectBootId, collectUnitNotFound } from "./hosted-readonly-linux-collector";
import { matchesManagedProviderProxyWait, parseHostedManagedProviderTerminalFacts,
  type HostedManagedProviderTerminalFacts } from "./hosted-managed-provider-terminal-facts";

const root = "/var/lib/subscription-runtime-host-policy";
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(value)?.[0] === value;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)+"\n");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function held(): never { throw new Error("hosted_managed_provider_recovery_held"); }
type FailureReceipt = Readonly<{ schemaVersion:1; parentAttempt:unknown; unit:string; providerStartId:string;
  providerReference:DependencyProtectedReference; invocationId:string; proxyBirth:string; waitStatus:number;
  terminal:HostedManagedProviderTerminalFacts }>;

/** Captured bytes only. Codec success is never creator, origin or release authority. */
export function parseHostedManagedProviderFailureReceipt(bytes: Buffer): FailureReceipt {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 16384) held();
  const value = decodeHostedActivationBytes(bytes);
  if (!isDependencyCustodyObject(value,"invocationId,parentAttempt,providerReference,providerStartId,proxyBirth,schemaVersion,terminal,unit,waitStatus") ||
      value.schemaVersion !== 1 || !uuid(value.providerStartId) || value.unit !== `subscription-runtime-hosted-${value.providerStartId}.service` ||
      !isDependencyProtectedReference(value.providerReference) || value.providerReference.path !== `${root}/dependency-managed-provider-starts/${value.providerStartId}.json` ||
      typeof value.invocationId !== "string" || /^[a-f0-9]{32}$/.exec(value.invocationId)?.[0] !== value.invocationId ||
      typeof value.proxyBirth !== "string" || /^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/.exec(value.proxyBirth)?.[0] !== value.proxyBirth ||
      typeof value.waitStatus !== "number" || !Number.isInteger(value.waitStatus) || value.waitStatus < 1 || value.waitStatus > 255 ||
      !isDependencyCustodyObject(value.parentAttempt,"attemptId,epoch,launch") || !uuid(value.parentAttempt.attemptId) ||
      typeof value.parentAttempt.epoch !== "number" || !Number.isSafeInteger(value.parentAttempt.epoch) || value.parentAttempt.epoch < 1 ||
      !isDependencyCustodyObject(value.parentAttempt.launch,"association,bootId,grantDigest,installationId,kind,origin,runtimeSha,startId,unit") ||
      value.parentAttempt.launch.kind !== DependencyConsumerLaunchKind.ManagedReadonlyLocalV1 ||
      !isDependencyCustodyObject(value.terminal,"invocationId,kind,result,status,unit") || !encode(value).equals(bytes)) held();
  const t = value.terminal;
  const terminal = parseHostedManagedProviderTerminalFacts(value.unit,
    `Id=${t.unit}\nInvocationID=${t.invocationId}\nActiveState=failed\nSubState=failed\nMainPID=0\nControlPID=0\nJob=\nExecMainCode=${t.kind}\nExecMainStatus=${t.status}\nResult=${t.result}\n`);
  if (!encode(terminal).equals(encode(t)) || !matchesManagedProviderProxyWait(terminal,value.invocationId,value.waitStatus)) held();
  return Object.freeze({schemaVersion:1,parentAttempt:value.parentAttempt,unit:value.unit,providerStartId:value.providerStartId,
    providerReference:value.providerReference,invocationId:value.invocationId,proxyBirth:value.proxyBirth,waitStatus:value.waitStatus,terminal});
}

function sameFile(a: BigIntStats,b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
    a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
/** Paths come only from fixed local recipes below, never an exported opener. */
function fixedPin(path: string, maximum = 16384) {
  const parts = path.split("/").filter(Boolean); if (parts.length < 2 || parts.length > 128) held();
  const directories: {path:string;fd:number;stat:BigIntStats}[] = [], openedDirectories: number[] = []; let fd: number | undefined;
  try {
    let parent = "/";
    for (let i = 0; i < parts.length; i++) {
      const selected = i === 0 ? "/" : `/proc/self/fd/${directories[i-1]!.fd}/${parts[i-1]}`;
      const directoryFd = openSync(selected,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      openedDirectories.push(directoryFd);
      const stat = fstatSync(directoryFd,{bigint:true}); directories.push({path:parent,fd:directoryFd,stat});
      if (!stat.isDirectory() || stat.uid !== 0n || stat.gid !== 0n || (stat.mode & 0o022n) ||
          (i === parts.length-1 && (stat.mode & 0o7777n) !== 0o700n)) held();
      parent = parent === "/" ? "/"+parts[i] : parent+"/"+parts[i];
    }
    const leaf = directories.at(-1)!;
    fd = openSync(`/proc/self/fd/${leaf.fd}/${parts.at(-1)!}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before = fstatSync(fd,{bigint:true});
    if (!before.isFile() || before.uid !== 0n || before.gid !== 0n || before.nlink !== 1n ||
        (before.mode & 0o7777n) !== 0o600n || before.size < 1n || before.size > BigInt(maximum)) held();
    const bytes = Buffer.alloc(Number(before.size)+1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd,bytes,length,bytes.length-length,length); if (!count) break; length += count; }
    if (BigInt(length) !== before.size || !sameFile(before,fstatSync(fd,{bigint:true})) || !sameFile(before,lstatSync(path,{bigint:true}))) held();
    for (const directory of directories) {
      const current = lstatSync(directory.path,{bigint:true}), retained = fstatSync(directory.fd,{bigint:true});
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
function boundary(fence: HostedActivationFence): void {
  assertHostedActivationFence(fence); assertHostedActivationOperator(); assertHostedProcessDescriptors();
}

/** Trusted recovery-only composition. It authenticates fixed persisted facts,
 * never publishes completion, acquires a fence or releases an owner/home/lease.
 * Caller still performs independent queue + recursive cgroup checks in order. */
export function assertHostedManagedProviderFailureCreator(fence: HostedActivationFence,startId: string): void {
  boundary(fence); if (!uuid(startId)) held();
  const epochPin = fixedPin(`${root}/readonly-epoch.json`,65536), epoch = parseHostedCustodyEpoch(wire(epochPin));
  const outer = epoch.outerRuntime, row = epoch.reservations.find(record => record.startId === startId);
  if (epoch.phase !== HostedCustodyPhase.Closed || epoch.revoked || epoch.bootId !== collectBootId() || !outer ||
      outer.state !== HostedCustodyReservationState.Terminal || epoch.generation <= outer.generation ||
      !row || row.state !== HostedCustodyReservationState.Reserved || row.creatorId !== startId ||
      row.unit !== `subscription-runtime-hosted-${startId}.service`) held();
  // Outer-first status0 is independently enforced by the unchanged supervisor.
  // Even an already-Terminal row cannot replace its protected creator receipt.
  const outerCompletion = fixedPin(`${root}/readonly-completed-${outer.startId}.json`,4096);
  if (!outerCompletion.bytes.equals(encode({schemaVersion:1,startId:outer.startId,unit:outer.unit,
    creatorId:outer.creatorId,waitCompleted:true,waitStatus:0}))) held();
  const parent = readHostedReadonlyDependencyStart(fence,outer.startId), start = parent.value;
  if (start.startId !== outer.startId || start.creatorId !== outer.creatorId || start.unit !== outer.unit ||
      start.generation !== outer.generation || start.hostId !== epoch.hostId || start.bootId !== epoch.bootId ||
      start.supervisorId !== epoch.supervisorId || start.readonlyJobId !== epoch.identity.jobId ||
      start.jobRootDir !== epoch.identity.jobRootDir || start.workspace.canonicalPath !== epoch.identity.workspacePath) held();
  const material = readHostedReadonlyDependencyMaterial(fence,epoch.identity), binding = readHostedDependencyBinding(start.candidateJobId);
  if (!binding || binding.version !== 2 || start.installationId !== binding.installationId || start.runtimeSha !== binding.runtimeSha ||
      !sameDependencyWorkspace(start.workspace,binding.workspace) || !sameDependencyProtectedReference(start.association,material.reference)) held();
  const ownerName = `dependency-owners/${binding.workspace.dev}-${binding.workspace.ino}`;
  if (readHostedActivationBytes(ownerName+".lock")) held();
  const ownerPin = fixedPin(`${root}/${ownerName}.json`), owner = parseDependencyOwner(wire(ownerPin));
  if (owner.version !== 3 || !isDependencyConsumerOwner(owner.owner) ||
      (owner.owner.phase !== DependencyOwnerPhase.Running && owner.owner.phase !== DependencyOwnerPhase.Fenced) || !sameDependencyWorkspace(owner.workspace,binding.workspace) ||
      !sameDependencyProtectedReference(owner.custodyBinding,material.reference)) held();
  const attempt = owner.owner.attempt, launch = attempt.launch;
  if (!isDependencyCustodyLaunch(launch) || launch.kind !== DependencyConsumerLaunchKind.ManagedReadonlyLocalV1 || launch.startId !== start.startId || launch.unit !== start.unit ||
      launch.installationId !== start.installationId || launch.runtimeSha !== start.runtimeSha || launch.bootId !== start.bootId ||
      launch.grantDigest !== start.grantDigest || !sameDependencyProtectedReference(launch.origin,parent.reference) ||
      !sameDependencyProtectedReference(launch.association,material.reference)) held();
  const preclaim = fixedPin(`${root}/dependency-reader-starts/${outer.startId}.json`), claim = wire(preclaim);
  if (!isDependencyCustodyObject(claim,"attempt,binding,custody,kind,origin,ownerRevision,ownerSha256,receipt,version,workspace") ||
      claim.version !== 1 || claim.kind !== DependencyConsumerLaunchKind.ManagedReadonlyLocalV1 ||
      typeof claim.ownerRevision !== "number" || !Number.isSafeInteger(claim.ownerRevision) || claim.ownerRevision < 1 || owner.revision <= claim.ownerRevision ||
      typeof claim.ownerSha256 !== "string" || /^[a-f0-9]{64}$/.exec(claim.ownerSha256)?.[0] !== claim.ownerSha256 ||
      !encode(claim.attempt).equals(encode(attempt)) || !encode(claim.workspace).equals(encode(binding.workspace))) held();
  referenced(claim.origin,parent.reference.path); referenced(claim.custody,material.reference.path);
  referenced(claim.binding,`${root}/${hostedDependencyBindingName(binding.jobId)}`);
  if (!isDependencyProtectedReference(claim.origin) || !isDependencyProtectedReference(claim.custody) ||
      !sameDependencyProtectedReference(claim.origin,parent.reference) || !sameDependencyProtectedReference(claim.custody,material.reference)) held();
  const entry = fixedPin(`${root}/dependency-reader-entries/${outer.startId}.json`,4096);
  if (!entry.bytes.equals(encode({version:1,producer:preclaim.reference,attempt}))) held();
  const preparation = fixedPin(`${root}/dependency-root-preparations/${outer.startId}.json`,65536), prepared = wire(preparation);
  if (!isDependencyCustodyObject(prepared,"attempt,authoredRoots,config,configAncestors,custodyReference,durableHandoffRoot,generatedRoots,protectedProfile,providerReady,qualification,ready,readyRevision,scratchParent,sourceLookupAncestors,version") ||
      prepared.version !== 2 || !encode(prepared.attempt).equals(encode(attempt)) ||
      !isDependencyProtectedReference(prepared.custodyReference) || !sameDependencyProtectedReference(prepared.custodyReference,material.reference) ||
      typeof prepared.readyRevision !== "number" || !Number.isSafeInteger(prepared.readyRevision) || prepared.readyRevision < 1) held();
  const ready = readHostedDependencyCommittedReady(binding,prepared.readyRevision);
  if (!isDependencyProtectedReference(prepared.ready) || !sameDependencyProtectedReference(prepared.ready,ready.reference)) held();
  const qualification = referenced(prepared.qualification,`${root}/${dependencyToolQualificationRecordName(outer.startId)}`);
  const q = parseDependencyToolQualification(wire(qualification));
  if (q.attemptId !== attempt.attemptId || q.epoch !== attempt.epoch || q.startId !== outer.startId ||
      q.readyRevision !== ready.receipt.revision || !sameDependencyWorkspace(q.workspace,binding.workspace) ||
      q.tree.dev !== ready.receipt.tree.dev || q.tree.ino !== ready.receipt.tree.ino) held();
  const profile = referenced(prepared.protectedProfile,`${root}/dependency-installer-profile.json`), decodedProfile = wire(profile);
  if (!decodedProfile || typeof decodedProfile !== "object" || !("schemaVersion" in decodedProfile) || decodedProfile.schemaVersion !== 2) held();
  const birth = fixedPin(`${root}/dependency-managed-provider-starts/${startId}.json`);
  const expectedBirth = {version:1,installationId:binding.installationId,runtimeSha:binding.runtimeSha,
    hostId:epoch.hostId,bootId:epoch.bootId,supervisorId:epoch.supervisorId,generation:outer.generation,unit:row.unit,providerStartId:startId,
    parentStartId:attempt.launch.startId,logicalJobId:binding.jobId,executionJobId:start.readonlyJobId,jobRootDir:binding.jobRootDir,
    workspace:binding.workspace,attempt,custodyReference:material.reference,originReference:parent.reference,ready:ready.reference,
    readyRevision:ready.receipt.revision,qualification:qualification.reference,protectedProfile:profile.reference};
  if (!birth.bytes.equals(encode(expectedBirth))) held();
  const receiptPin = fixedPin(`${root}/dependency-managed-provider-completions/${startId}.json`), receipt = parseHostedManagedProviderFailureReceipt(receiptPin.bytes);
  if (!sameDependencyProtectedReference(receipt.providerReference,birth.reference) || !encode(receipt.parentAttempt).equals(encode(attempt)) || receipt.unit !== row.unit) held();
  const pid = receipt.proxyBirth.slice(0,receipt.proxyBirth.indexOf(":"));
  try { lstatSync(`/proc/${pid}`); held(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!collectUnitNotFound(row.unit)) {
    const observation = spawnSync("/usr/bin/systemctl",["show",
      "--property=Id,InvocationID,ActiveState,SubState,MainPID,ControlPID,Job,ExecMainCode,ExecMainStatus,Result","--",row.unit],
      {encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:5000,maxBuffer:4096,
        env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",SYSTEMD_COLORS:"0"}});
    if (observation.error || observation.status !== 0) held();
    const current = parseHostedManagedProviderTerminalFacts(row.unit,observation.stdout);
    if (!encode(current).equals(encode(receipt.terminal))) held();
  }
  // Every read FD is closed before the real descriptor collector; unchanged
  // protected bytes/references make the captured predecessor join stable.
  for (const pin of [epochPin,outerCompletion,ownerPin,preclaim,entry,preparation,qualification,profile,birth,receiptPin]) {
    if (!readHostedPrivateBytes(pin.reference.path,pin.bytes.length)?.equals(pin.bytes) ||
        !sameDependencyProtectedReference(fixedPin(pin.reference.path,pin.bytes.length).reference,pin.reference)) held();
  }
  if (readHostedActivationBytes(ownerName+".lock")) held();
  const afterParent = readHostedReadonlyDependencyStart(fence,outer.startId), afterMaterial = readHostedReadonlyDependencyMaterial(fence,epoch.identity);
  if (!sameDependencyProtectedReference(afterParent.reference,parent.reference) || !sameDependencyProtectedReference(afterMaterial.reference,material.reference)) held();
  boundary(fence);
}
