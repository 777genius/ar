import { hostedManagedDependencyProviderInvocation, bindHostedDependencyToolChild, abandonHostedDependencyToolInvocation } from "./hosted-managed-dependency-tool-plan";
import { sameHostedDependencyStatFacts as sameStat } from "./hosted-dependency-stat-facts";
import { spawnHostedFdChild, hostedFdLaunch } from "../provider-codex/app-server/adapters/hosted-fd-launch";
import { createHash } from "node:crypto";
import { spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, statSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DependencyOwnerKind, DependencyOwnerPhase, DependencyConsumerLaunchKind, isDependencyConsumerOwner, parseDependencyOwner, sameDependencyProtectedReference, sameDependencyWorkspace, sameDependencyAttempt, parseDependencyGenerationContinuityInvalidation,
  type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { HostedActivationPhase, HostedCustodyPhase, HostedCustodyReservationState, parseHostedActivation, parseHostedInstallation,
  parseHostedCustodyEpoch, DependencyReceiptState } from "@vioxen/subscription-runtime/worker-core";
import { parseHostedReadonlyHostInventory } from "../worker-core/hosted-custody/domain/hosted-readonly-inventory";
import { CodexProviderEgressProfileId } from "../provider-codex/codex-provider-egress-policy";
import { assertHostedActivationFence, assertHostedActivationOperator, decodeHostedActivationBytes, readHostedActivationBytes,
  readHostedOrdinaryProcessOrigin, withHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readHostedReadonlyDependencyAssociation, readHostedReadonlyDependencyStart } from "../provider-codex/app-server/adapters/hosted-dependency-origin";
import { assertHostedDependencyPhysicalWorkspace, hostedDependencyBindingName, readHostedDependencyBinding, readHostedDependencyAttempt, assertHostedDependencyStartAllowed, isHostedDependencyWorkspace, type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { assertHostedRetainedToolDescriptors, type HostedRetainedToolFiles } from "../provider-codex/app-server/adapters/hosted-retained-tool-files";
import { assertHostedFdBootstrap, observeHostedFdProcess, observeHostedFdUnit, readHostedFdProfile } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { systemdObservationBudget } from "../provider-codex/app-server/adapters/systemd-service-arrays";
import { verifySystemBusInfrastructure } from "../provider-codex/app-server/adapters/system-bus-infrastructure";
import { assertHostedFdFrameEnvironment } from "../provider-codex/app-server/adapters/hosted-fd-prelude";
import { assertHostedFdProcess, HostedFdLaunchKind } from "../provider-codex/app-server/adapters/hosted-fd-child";
import { hostedDependencySystemdRunExecutable } from "../provider-codex/app-server/adapters/hosted-dependency-systemd-command";

import { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { invalidateDependencyGeneration } from "../worker-core/dependency-environment/application/invalidate-dependency-generation";
import { DependencyUnverifiedReason } from "../worker-core/dependency-environment/domain/dependency-receipt";
import { hostedDependencyReceiptHistoryRoot } from "../provider-codex/app-server/adapters/hosted-dependency-history-path";
import { dependencyToolQualificationRecordName, dependencyToolGuestConfig, dependencyToolGuestConfigPath, parseDependencyToolQualification,
  type DependencyToolQualification } from "../core/dependency-environment/dependency-tool-profile";
import { DependencyToolReadyProvenanceKind, matchesDependencyToolReadyIdentity,
  type DependencyToolReadyFacts } from "../core/dependency-environment/dependency-tool-ready-reader";
import { assertHostedDependencyRootGitProfile } from "../provider-codex/app-server/adapters/hosted-dependency-root-git-profile";
import { assertHostedDependencyRootGitConfigBytes } from "../provider-codex/app-server/adapters/hosted-dependency-root-git-config";
import { HostedDependencyRootDescriptorRecipe, type HostedDependencyRootDescriptorAnchor,
  type HostedDependencyRootDescriptorMaterial } from "../provider-codex/app-server/adapters/hosted-dependency-root-descriptor-material";
export { HostedDependencyRootDescriptorRecipe } from "../provider-codex/app-server/adapters/hosted-dependency-root-descriptor-material";
import { HostedDependencyRootPurpose, isHostedDependencySignedTaskId, type HostedDependencyManagedGitScope, type HostedDependencyRootScope,
  type HostedDependencyManagedProviderFacts, type HostedDependencyRootDirectoryPin, type HostedDependencyRootPreparationRecord } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
export { HostedDependencyRootPurpose, isHostedDependencySignedTaskId } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
export type { HostedDependencyManagedGitScope, HostedDependencyRootScope, HostedDependencyRootDirectoryPin } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";

const root = "/var/lib/subscription-runtime-host-policy", transport = "/run/user/0/subscription-runtime-host-policy";
const brand: unique symbol = Symbol("hosted.current.dependency.origin");
export type CurrentHostedDependencyOrigin = Readonly<{ [brand]: true }>;
export enum CurrentHostedDependencyOriginKind { Ordinary = "ordinary", ManagedReadonlyLocal = "managed_readonly_local" }
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function invalid(): never { throw new Error("hosted_dependency_current_origin_unresolved"); }
const contexts = new WeakMap<CurrentHostedDependencyOrigin, { digest: string; facts: CurrentHostedDependencyOriginFacts; scope?: HostedRetainedToolFiles; rootPurpose?: RootPurposeState }>();
/** PRIVATE selected-path reader. Only names derived below from independently
 * pinned start/installation are used; no exported arbitrary-path read port. */
function selectedFile(path: string, maximum: number, privateFile = true) {
  if (!/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(path) || path.split("/").some(p => p === "." || p === "..")) invalid();
  const ancestors: { path: string; stat: BigIntStats }[] = [];
  for (let p = dirname(path);; p = dirname(p)) {
    const stat = lstatSync(p, { bigint: true });
    if (!stat.isDirectory() || stat.uid !== 0n || (stat.mode & 0o022n) ||
        (privateFile && p === dirname(path) && (stat.mode & 0o077n))) invalid();
    ancestors.push({ path: p, stat }); if (p === "/") break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true }), entry = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & (privateFile ? 0o077n : 0o022n)) ||
        before.size < 1n || before.size > BigInt(maximum) || !sameStat(before,entry)) invalid();
    const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd,bytes,length,bytes.length-length,length); if (!count) break; length += count; }
    if (BigInt(length) !== before.size || !sameStat(before,fstatSync(fd,{bigint:true})) || !sameStat(before,lstatSync(path,{bigint:true}))) invalid();
    for (const p of ancestors) { const now = lstatSync(p.path,{bigint:true});
      if (!now.isDirectory() || now.dev !== p.stat.dev || now.ino !== p.stat.ino || now.uid !== p.stat.uid || now.mode !== p.stat.mode) invalid(); }
    const data = bytes.subarray(0,length), reference: DependencyProtectedReference = { path,
      identity:{dev:String(before.dev),ino:String(before.ino)},sha256:hash(data) };
    return { bytes:data, reference };
  } finally { closeSync(fd); }
}
function fixed(name: string, maximum = 65536) { return selectedFile(`${root}/${name}`,maximum); }
function material(expected: DependencyProtectedReference, path: string, maximum = 262144, privateFile = true) {
  if (expected.path !== path) invalid(); const pin = selectedFile(path,maximum,privateFile);
  if (!sameDependencyProtectedReference(pin.reference,expected)) invalid(); return pin;
}
function selectedSnapshot(fence: HostedActivationFence, scope?: HostedRetainedToolFiles, rootPurpose?: RootPurposeState) {
  assertHostedActivationFence(fence); assertHostedActivationOperator();
  const group = readFileSync("/proc/self/cgroup","utf8").trim();
  if (/^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-ordinary-[a-f0-9-]{36}\.service$/.test(group)) {
    const ordinary = readHostedOrdinaryProcessOrigin(fence,scope);
    return { digest:hash(JSON.stringify(ordinary)), facts:Object.freeze({kind:CurrentHostedDependencyOriginKind.Ordinary,ordinary}) };
  }
  const match = /^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/(subscription-runtime-outer-([a-f0-9-]{36})\.service)$/.exec(group);
  if (!match || !match[1] || !match[2]) invalid();
  const remaining = systemdObservationBudget();
  for (const name of ["host-activation.next","ordinary-origins.next","readonly-epoch.next"]) if (readHostedActivationBytes(name)) invalid();
  const installationPin = fixed("host-installation.json"), activationPin = fixed("host-activation.json"),
    epochPin = fixed("readonly-epoch.json"), enrollmentPin = fixed("readonly-enrollment.json"), inventoryPin = fixed("readonly-inventory.json");
  const installation = parseHostedInstallation(decodeHostedActivationBytes(installationPin.bytes));
  const activation = parseHostedActivation(decodeHostedActivationBytes(activationPin.bytes));
  const epoch = parseHostedCustodyEpoch(decodeHostedActivationBytes(epochPin.bytes)), enrollment = parseHostedCustodyEpoch(decodeHostedActivationBytes(enrollmentPin.bytes));
  const inventory = parseHostedReadonlyHostInventory(decodeHostedActivationBytes(inventoryPin.bytes));
  if (activation.phase !== HostedActivationPhase.Exclusive || activation.installationId !== installation.installationId ||
      activation.hostId !== installation.hostId || activation.exclusiveEnrollmentSha256 !== hash(enrollmentPin.bytes) ||
      activation.ordinaryStarts.some(row => row.state !== HostedCustodyReservationState.Terminal) ||
      inventory.schemaVersion !== 4 || !inventory.collectorProfile || !inventory.systemBusInfrastructure ||
      inventory.hostId !== installation.hostId || hash(inventoryPin.bytes) !== installation.inventorySha256 ||
      epoch.phase !== HostedCustodyPhase.Ready || epoch.revoked || enrollment.phase !== HostedCustodyPhase.Closed || enrollment.revoked ||
      enrollment.generation !== 1 || enrollment.reservations.length !== 0 || enrollment.outerRuntime !== null ||
      epoch.hostId !== installation.hostId || enrollment.hostId !== epoch.hostId || JSON.stringify(enrollment.identity) !== JSON.stringify(epoch.identity) ||
      epoch.bootId !== activation.bootId || epoch.supervisorId !== activation.supervisorId ||
      epoch.identity.runtimeSha !== installation.runtimeSha || epoch.identity.runtimeManifestSha256 !== installation.runtimeManifestSha256) invalid();
  const outer = epoch.outerRuntime;
  if (!outer || outer.state !== HostedCustodyReservationState.Reserved || outer.generation !== epoch.generation || outer.unit !== match[1] ||
      outer.startId !== match[2] || outer.creatorId !== outer.startId || readHostedActivationBytes(`scoped-terminating/${outer.startId}.json`)) invalid();
  const startPin = readHostedReadonlyDependencyStart(fence,outer.startId), start = startPin.value;
  if (start.installationId !== installation.installationId || start.runtimeSha !== installation.runtimeSha || start.inventoryDigest !== installation.inventorySha256 ||
      start.hostId !== epoch.hostId || start.bootId !== epoch.bootId || start.supervisorId !== epoch.supervisorId || start.generation !== epoch.generation ||
      start.readonlyJobId !== epoch.identity.jobId || start.jobRootDir !== epoch.identity.jobRootDir || start.workspace.canonicalPath !== epoch.identity.workspacePath ||
      start.grantDigest !== epoch.identity.grantSha256 || start.policyDigest !== epoch.identity.policySha256 || start.reviewDigest !== epoch.identity.reviewSha256 ||
      start.stageDigest !== epoch.identity.stageSha256) invalid();
  const binding = readHostedDependencyBinding(start.candidateJobId);
  if (!binding || binding.version !== 2 || binding.installationId !== installation.installationId || binding.runtimeSha !== installation.runtimeSha ||
      binding.jobRootDir !== start.jobRootDir || !sameDependencyWorkspace(binding.workspace,start.workspace)) invalid();
  assertHostedDependencyPhysicalWorkspace(binding);
  const association = readHostedReadonlyDependencyAssociation(fence,binding.workspace);
  if (!association || !sameDependencyProtectedReference(association.reference,start.association)) invalid();
  const a = association.evidence, R = a.readonlyCustody, name = hash(start.readonlyJobId)+".json";
  if (a.candidate.jobId !== binding.jobId || R.jobId !== start.readonlyJobId || R.jobRootDir !== binding.jobRootDir || R.workspacePath !== binding.workspace.canonicalPath ||
      a.installation.installationId !== installation.installationId || a.installation.runtimeSha !== installation.runtimeSha || a.installation.inventoryDigest !== installation.inventorySha256) invalid();
  material(a.candidate.binding,`${root}/${hostedDependencyBindingName(binding.jobId)}`);
  const grantPin = material(R.grant,`${transport}/codex-egress/${name}`), policyPin = material(R.policy,`${transport}/codex-readonly/${name}`),
    reviewPin = material(R.review,`${transport}/codex-readonly-reviewed/${name}`), stagePin = material(R.stage,`${transport}/codex-readonly-stages/${hash(installation.runtimeDirectory)}.json`),
    leasePin = material(R.lease,`${root}/codex-readonly-custody/${name}`);
  if (start.grantDigest !== hash(grantPin.bytes) || start.policyDigest !== hash(policyPin.bytes) || start.reviewDigest !== hash(reviewPin.bytes) ||
      start.stageDigest !== hash(stagePin.bytes) || start.leaseDigest !== hash(leasePin.bytes)) invalid();
  const grant = decodeHostedActivationBytes(grantPin.bytes);
  if (!grant || typeof grant !== "object" || Array.isArray(grant) || Object.keys(grant).sort().join(",") !== "jobId,jobRootDir,profileId,schemaVersion,workspacePath" ||
      !("schemaVersion" in grant) || grant.schemaVersion !== 1 || !("profileId" in grant) || grant.profileId !== CodexProviderEgressProfileId.TestManagedQualification ||
      !("jobId" in grant) || grant.jobId !== start.readonlyJobId || !("jobRootDir" in grant) || grant.jobRootDir !== binding.jobRootDir ||
      !("workspacePath" in grant) || grant.workspacePath !== binding.workspace.canonicalPath) invalid();
  const ownerName = `dependency-owners/${binding.workspace.dev}-${binding.workspace.ino}`;
  if (readHostedActivationBytes(ownerName+".lock")) invalid();
  const ownerPin = fixed(ownerName+".json",16384), owner = parseDependencyOwner(decodeHostedActivationBytes(ownerPin.bytes));
  if (readHostedActivationBytes(ownerName+".lock")) invalid();
  if (owner.version !== 3 || !sameDependencyWorkspace(owner.workspace,binding.workspace) || !sameDependencyProtectedReference(owner.custodyBinding,association.reference)) invalid();
  if (owner.owner !== null && (owner.owner.kind === DependencyOwnerKind.Maintenance || owner.owner.phase === DependencyOwnerPhase.Fenced ||
      owner.owner.attempt.launch.startId !== start.startId || owner.owner.attempt.launch.unit !== start.unit ||
      !("association" in owner.owner.attempt.launch) || !sameDependencyProtectedReference(owner.owner.attempt.launch.association,association.reference))) invalid();
  const profile = readHostedFdProfile(remaining); if (!profile) invalid();
  const directory = fileURLToPath(new URL("../../",import.meta.url)).replace(/\/$/,"");
  const bootstrap = `${directory}/dist/worker-codex/hosted-readonly-runtime-bootstrap.js`, cli = `${directory}/dist/worker-codex/codex-goal-cli.js`;
  if (installation.runtimeDirectory !== directory || inventory.runtimeLaunch.command !== profile.node.path || inventory.runtimeLaunch.args[0] !== cli ||
      inventory.runtimeLaunch.cwd !== binding.workspace.canonicalPath) invalid();
  const environment: Record<string,string> = {};
  for (const [key,value] of Object.entries(process.env)) if (value !== undefined) environment[key] = value;
  assertHostedFdFrameEnvironment(environment);
  const self = observeHostedFdProcess(process.pid), unit = observeHostedFdUnit(start.unit,[profile.node.path,bootstrap],remaining), parent = observeHostedFdProcess(unit.mainPid);
  if (unit.root !== "" || self.parentPid !== unit.mainPid || self.group !== group || parent.group !== group ||
      self.exe !== profile.node.path || JSON.stringify(self.argv) !== JSON.stringify([inventory.runtimeLaunch.command,...inventory.runtimeLaunch.args]) ||
      self.user !== readlinkSync("/proc/1/ns/user") || self.mount !== readlinkSync("/proc/1/ns/mnt") || self.pidNamespace !== readlinkSync("/proc/1/ns/pid") ||
      parent.user !== self.user || parent.mount !== self.mount || parent.pidNamespace !== self.pidNamespace) invalid();
  assertHostedFdBootstrap(parent,profile,remaining);
  // Only the kernel proc root magic links are followed, never input paths.
  const rootSelf = statSync(`/proc/${self.pid}/root`,{bigint:true}), rootParent = statSync(`/proc/${parent.pid}/root`,{bigint:true}),
    hostRoot = statSync("/",{bigint:true}), rootOne = statSync("/proc/1/root",{bigint:true});
  if (!hostRoot.isDirectory() || [rootSelf,rootParent,rootOne].some(s => !s.isDirectory() || s.dev !== hostRoot.dev || s.ino !== hostRoot.ino)) invalid();
  const supervisor = inventory.units.find(row => row.name === inventory.supervisorUnit); if (!supervisor) invalid();
  const shown = spawnSync("/usr/bin/systemctl",["show","--property=Id,FragmentPath,DropInPaths,ControlGroup,MainPID","--",supervisor.name],
    {encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:remaining(),maxBuffer:65536,env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",SYSTEMD_COLORS:"0"}});
  if (shown.error || shown.signal || shown.status !== 0 || shown.stderr) invalid();
  const lines = shown.stdout.trim().split("\n"); if (lines.length !== 5) invalid();
  const fields = new Map(lines.map(line => { const at = line.indexOf("="); if (at < 1) invalid(); return [line.slice(0,at),line.slice(at+1)] as const; }));
  const fragmentPath = fields.get("FragmentPath"), supervisorPid = Number(fields.get("MainPID"));
  if (fields.size !== 5 || fields.get("Id") !== supervisor.name || fields.get("DropInPaths") !== "" || fields.get("ControlGroup") !== supervisor.controlGroup ||
      !fragmentPath || !Number.isSafeInteger(supervisorPid) || supervisorPid < 1 ||
      hash(selectedFile(fragmentPath,1024*1024,false).bytes) !== supervisor.fragmentSha256) invalid();
  const supervisorProcess = observeHostedFdProcess(supervisorPid);
  if (supervisorProcess.birth !== start.supervisorId || supervisorProcess.group !== `0::${supervisor.controlGroup}` ||
      readFileSync("/etc/machine-id","utf8").trim() !== start.hostId || readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim() !== start.bootId) invalid();
  verifySystemBusInfrastructure(inventory.systemBusInfrastructure,remaining);
  if (rootPurpose?.descriptors.size) {
    // Managed provider and helper handles share this original map collector.
    // The independent ordinary retained-file scope cannot be borrowed here.
    if (scope !== undefined) invalid(); assertRootPurposeDescriptors(rootPurpose);
  } else if (scope === undefined) assertHostedProcessDescriptors(); else assertHostedRetainedToolDescriptors(scope);
  const freshSelf = observeHostedFdProcess(process.pid), freshParent = observeHostedFdProcess(unit.mainPid), freshSupervisor = observeHostedFdProcess(supervisorPid);
  if (freshSelf.birth !== self.birth || freshSelf.parentPid !== self.parentPid || freshSelf.group !== self.group ||
      JSON.stringify(freshSelf.argv) !== JSON.stringify(self.argv) || freshSelf.exe !== self.exe || freshSelf.user !== self.user || freshSelf.mount !== self.mount ||
      freshSelf.pidNamespace !== self.pidNamespace || freshParent.birth !== parent.birth || freshParent.group !== parent.group ||
      JSON.stringify(freshParent.argv) !== JSON.stringify(parent.argv) || freshParent.exe !== parent.exe || freshParent.parentPid !== parent.parentPid ||
      freshParent.user !== parent.user || freshParent.mount !== parent.mount || freshParent.pidNamespace !== parent.pidNamespace ||
      freshSupervisor.birth !== supervisorProcess.birth || freshSupervisor.group !== supervisorProcess.group) invalid();
  for (const [name,pin] of [["host-installation.json",installationPin],["host-activation.json",activationPin],["readonly-epoch.json",epochPin],
    ["readonly-enrollment.json",enrollmentPin],["readonly-inventory.json",inventoryPin]] as const) if (!fixed(name).bytes.equals(pin.bytes)) invalid();
  const freshUnit = observeHostedFdUnit(start.unit,[profile.node.path,bootstrap],remaining);
  if (JSON.stringify(freshUnit) !== JSON.stringify(unit)) invalid();
  assertHostedDependencyPhysicalWorkspace(binding); remaining();
  // Provider reservations are scheduler facts, not an immutable origin pin.
  // This reader cannot authorize a provider: its final frame must independently
  // join the genuine child/owned reservation and the same actual consumer.
  const digest = hash(JSON.stringify([installationPin.reference,activationPin.reference,
    {hostId:epoch.hostId,bootId:epoch.bootId,supervisorId:epoch.supervisorId,generation:epoch.generation,identity:epoch.identity,outerRuntime:epoch.outerRuntime},enrollmentPin.reference,inventoryPin.reference,
    startPin.reference,association.reference,self.birth,parent.birth,supervisorProcess.birth,unit.invocation]));
  // Raw pinned bytes stay in this collector; authoritative facts contain only
  // detached immutable metadata, never a mutable Buffer/TypedArray view.
  const associationFacts = freezeFacts(structuredClone({reference:association.reference,evidence:association.evidence}));
  return {digest,facts:Object.freeze({kind:CurrentHostedDependencyOriginKind.ManagedReadonlyLocal,installation,activation,epoch,inventory,
    start,originReference:startPin.reference,association:associationFacts,binding,owner,selfBirth:self.birth,parentBirth:parent.birth,unitInvocation:unit.invocation})};
}
export type CurrentHostedDependencyOriginFacts = ReturnType<typeof selectedSnapshot>["facts"];
/** Actual fixed process/installed history only. This brand does not claim an
 * owner, bless a manifest or permit an enqueue. Consumers still join both. */
export function readCurrentHostedDependencyOrigin(fence: HostedActivationFence, scope?: HostedRetainedToolFiles): CurrentHostedDependencyOrigin {
  const selected = selectedSnapshot(fence,scope), context = Object.freeze({[brand]:true as const});
  contexts.set(context,{digest:selected.digest,facts:freezeFacts(selected.facts),...(scope ? {scope}: {})}); return context;
}
export function assertCurrentHostedDependencyOrigin(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence): CurrentHostedDependencyOriginFacts {
  const retained = contexts.get(context); if (!retained) invalid();
  const current = selectedSnapshot(fence,retained.scope,retained.rootPurpose); if (current.digest !== retained.digest) invalid(); return current.facts;
}
export function invalidateCurrentHostedDependencyOrigin(context: CurrentHostedDependencyOrigin): void {
  const retained = contexts.get(context); let failure: unknown;
  // Resource revocation is cleanup only. Delete authority even if physical close
  // fails, so no failed revocation can leave a future helper permit alive.
  try { for (const descriptor of [...(retained?.rootPurpose?.descriptors.keys() ?? [])]) {
    try { descriptor.close(); } catch (error) { failure ??= error; }
  } } finally { contexts.delete(context); if (currentRootOrigin === context) currentRootOrigin = undefined; }
  if (failure !== undefined) throw failure;
}

export type CurrentHostedManagedDependencyProvider = HostedDependencyManagedProviderFacts;
function managedProviderBirth(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, unit: string): CurrentHostedManagedDependencyProvider {
  const retained = contexts.get(context); if (!retained?.rootPurpose) invalid();
  assertCurrentHostedDependencyRootPurpose(retained.rootPurpose.managed,HostedDependencyRootPurpose.ManagedGitReadV1,fence);
  const actual = assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.Running);
  if (actual.facts.kind !== CurrentHostedDependencyOriginKind.ManagedReadonlyLocal ||
      !sameDependencyAttempt(actual.attempt,retained.rootPurpose.record.attempt)) invalid();
  const match = /^subscription-runtime-hosted-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.service$/.exec(unit);
  if (!match || match[0] !== unit) invalid(); const providerStartId = match[1]!;
  const facts = actual.facts, epoch = facts.epoch;
  const reservation = epoch.reservations.find(row => row.unit === unit);
  if (!reservation || reservation.startId !== providerStartId || reservation.creatorId !== providerStartId ||
      reservation.state !== HostedCustodyReservationState.Reserved || epoch.generation !== facts.start.generation ||
      epoch.identity.jobId !== facts.start.readonlyJobId || epoch.identity.workspacePath !== actual.binding.workspace.canonicalPath ||
      epoch.identity.jobRootDir !== actual.binding.jobRootDir) invalid();
  const ready = currentRootReady(actual.binding);
  if (!encode(ready).equals(encode(retained.rootPurpose.ready))) invalid();
  const record = retained.rootPurpose.record;
  return freezeFacts({version:1 as const,installationId:actual.binding.installationId,runtimeSha:actual.binding.runtimeSha,
    hostId:epoch.hostId,bootId:epoch.bootId,supervisorId:epoch.supervisorId,generation:epoch.generation,unit,providerStartId,
    parentStartId:actual.attempt.launch.startId,logicalJobId:actual.binding.jobId,executionJobId:facts.start.readonlyJobId,
    jobRootDir:actual.binding.jobRootDir,workspace:actual.binding.workspace,attempt:actual.attempt,
    custodyReference:facts.association.reference,originReference:facts.originReference,ready:ready.reference,
    readyRevision:ready.receipt.revision,qualification:record.qualification,protectedProfile:record.protectedProfile});
}
export function readCurrentHostedManagedDependencyProviderParent(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence) {
  const state = contexts.get(context)?.rootPurpose; if (!state) invalid();
  assertCurrentHostedDependencyRootPurpose(state.managed,HostedDependencyRootPurpose.ManagedGitReadV1,fence);
  const actual = assertCurrentHostedDependencyAttempt(context,fence);
  if (actual.facts.kind !== CurrentHostedDependencyOriginKind.ManagedReadonlyLocal) invalid();
  return Object.freeze({binding:actual.binding,attempt:actual.attempt,facts:actual.facts});
}
/** Concrete publication only after the actual existing custody supervisor has
 * durably reserved THIS provider. No DTO scope, callback or alternate origin. */
export function publishCurrentHostedManagedDependencyProvider(context: CurrentHostedDependencyOrigin,
  fence: HostedActivationFence, unit: string): void {
  const before = managedProviderBirth(context,fence,unit), directory = `${root}/dependency-managed-provider-starts`;
  try { mkdirSync(directory,{mode:0o700}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const parent = readHostedDependencyRootDirectoryPin(directory), protectedRoot = readHostedDependencyRootDirectoryPin(root), stat = lstatSync(directory);
  if (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o700 ||
      parent.dev !== protectedRoot.dev || parent.mountId !== protectedRoot.mountId) invalid();
  const path = `${directory}/${before.providerStartId}.json`, bytes = encode(before);
  const fd = openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { writeFileSync(fd,bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const directoryFd = openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  // Every temporary publication FD has closed before the actual collector.
  const after = managedProviderBirth(context,fence,unit);
  if (!encode(after).equals(bytes) || !selectedFile(path,16384).bytes.equals(bytes) ||
      !encode(readHostedDependencyRootDirectoryPin(directory)).equals(encode(parent))) invalid();
}
/** Selection requires the SAME genuine running parent plus current actual owned
 * provider reservation. Returned JSON/reference are facts, never a child grant. */
export function readCurrentHostedManagedDependencyProvider(context: CurrentHostedDependencyOrigin,
  fence: HostedActivationFence, unit: string) {
  const current = managedProviderBirth(context,fence,unit), pin = fixed(`dependency-managed-provider-starts/${current.providerStartId}.json`,16384);
  if (!pin.bytes.equals(encode(current))) invalid();
  const after = managedProviderBirth(context,fence,unit); if (!encode(after).equals(pin.bytes)) invalid();
  return Object.freeze({value:current,reference:pin.reference});
}

/** One fixed provider resource producer. All physical handles belong to the
 * original-origin entry; a scope DTO or caller reader cannot open these files. */
export function prepareCurrentHostedManagedDependencyProviderTools(context: CurrentHostedDependencyOrigin,
  fence: HostedActivationFence, unit: string) {
  const selected = readCurrentHostedManagedDependencyProvider(context,fence,unit), state = contexts.get(context)?.rootPurpose;
  if (!state || state.provider) invalid();
  const scope = assertCurrentHostedDependencyRootPurpose(state.managed,HostedDependencyRootPurpose.ManagedGitReadV1,fence);
  const providerRoot = `${root}/dependency-provider-roots/${selected.value.providerStartId}`;
  const rootPin = readHostedDependencyRootDirectoryPin(providerRoot), stat = lstatSync(providerRoot);
  if (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o700) invalid();
  const qualification = material(state.record.qualification,`${root}/${dependencyToolQualificationRecordName(selected.value.parentStartId)}`,16384);
  const q = parseDependencyToolQualification(decodeHostedActivationBytes(qualification.bytes));
  const capsulePath = providerRoot+dependencyToolGuestConfigPath, bytes = encode(dependencyToolGuestConfig(q));
  const parentPin = readHostedDependencyRootDirectoryPin(dirname(capsulePath));
  if (!dirname(capsulePath).startsWith(providerRoot+"/") || parentPin.dev !== rootPin.dev || parentPin.mountId !== rootPin.mountId) invalid();
  const fd = openSync(capsulePath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { writeFileSync(fd,bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const parentFd = openSync(dirname(capsulePath),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  const opened: RootDescriptor[] = [];
  try {
    const associate = (path: string, pin: HostedDependencyRootDirectoryPin) => {
      const physical = openHostedDependencyRootDescriptorMaterial(scope,HostedDependencyRootDescriptorRecipe.DurableFileV1,path,
        {directory:false,maximum:16384,root:pin});
      const resource = new RootDescriptor(context,physical,rootInternalAccess); state.descriptors.set(resource,physical);
      opened.push(resource); Object.freeze(resource); return resource;
    };
    const record = associate(state.record.qualification.path,readHostedDependencyRootDirectoryPin(dirname(state.record.qualification.path)));
    const capsule = associate(capsulePath,rootPin);
    if ((fstatSync(record.fd).mode & 0o7777) !== 0o600 || (fstatSync(capsule.fd).mode & 0o7777) !== 0o600 ||
        !readManagedProviderDescriptor(record.fd).equals(qualification.bytes) || !readManagedProviderDescriptor(capsule.fd).equals(bytes)) invalid();
    state.provider = {unit,reference:selected.reference,root:rootPin,qualification:freezeFacts(q),ready:state.record.providerReady,record,capsule,capsulePath};
    return readCurrentHostedManagedDependencyProviderTools(context,fence,unit);
  } catch (error) { delete state.provider; for (const resource of opened.reverse()) resource.close(); throw error; }
}

/** Facts for the fixed finite-root consumer, independently joined before and
 * after every use. There is no public ReadyReader callback in the managed path. */
export function readCurrentHostedManagedDependencyProviderTools(context: CurrentHostedDependencyOrigin,
  fence: HostedActivationFence, unit: string) {
  const selected = readCurrentHostedManagedDependencyProvider(context,fence,unit), state = contexts.get(context)?.rootPurpose;
  const provider = state?.provider;
  if (!state || !provider || provider.unit !== unit || !sameDependencyProtectedReference(provider.reference,selected.reference) ||
      !encode(readHostedDependencyRootDirectoryPin(provider.root.canonicalPath)).equals(encode(provider.root))) invalid();
  const qualification = material(state.record.qualification,`${root}/${dependencyToolQualificationRecordName(selected.value.parentStartId)}`,16384);
  if (!readManagedProviderDescriptor(provider.record.fd).equals(qualification.bytes) || !encode(provider.qualification).equals(qualification.bytes) ||
      !readManagedProviderDescriptor(provider.capsule.fd).equals(encode(dependencyToolGuestConfig(provider.qualification)))) invalid();
  if (provider.child) {
    if (!provider.command || !provider.args) invalid();
    assertHostedFdProcess(provider.child,unit,HostedFdLaunchKind.Provider,provider.command,provider.args);
  }
  const after = readCurrentHostedManagedDependencyProvider(context,fence,unit);
  if (!sameDependencyProtectedReference(after.reference,provider.reference)) invalid();
  return Object.freeze({qualification:provider.qualification,ready:provider.ready,capsulePath:provider.capsulePath,
    provider:selected.value,reference:selected.reference});
}
/** Fixed issuer-owned exec. No public invocation DTO or child registration edge
 * can mutate the original entry; Plan and FDA both derive this actual spawn. */
export function spawnCurrentHostedManagedDependencyProvider(context: CurrentHostedDependencyOrigin,
  fence: HostedActivationFence, unit: string,
  input: Readonly<{command:string;args:readonly string[];cwd:string;env:Readonly<Record<string,string>>}>): ChildProcessWithoutNullStreams {
  readCurrentHostedManagedDependencyProviderParent(context,fence);
  const invocation = hostedManagedDependencyProviderInvocation(fence,unit,input,context);
  if (!invocation || invocation.systemdUnit !== unit || invocation.stdinBootstrap === undefined) invalid();
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    retainCurrentHostedManagedDependencyProviderInvocation(context,fence,invocation);
    child = spawnHostedFdChild(invocation.command,invocation.args,{cwd:input.cwd,detached:true},unit,HostedFdLaunchKind.Provider);
    bindCurrentHostedManagedDependencyProviderChild(context,invocation,child); bindHostedDependencyToolChild(invocation,child);
    return child;
  } catch (error) {
    if (child) { hostedFdLaunch(child).invalidate(); child.kill("SIGTERM"); }
    abandonHostedDependencyToolInvocation(invocation); throw error;
  }
}
export function readCurrentHostedManagedDependencyProviderFrame(context: CurrentHostedDependencyOrigin,
  fence: HostedActivationFence, unit: string, child: ChildProcess): string | Buffer {
  readCurrentHostedManagedDependencyProviderTools(context,fence,unit);
  const provider = contexts.get(context)?.rootPurpose?.provider;
  if (!provider || provider.child !== child || !provider.invocation || !("stdinBootstrap" in provider.invocation) ||
      typeof provider.invocation.stdinBootstrap !== "string") invalid();
  return provider.invocation.stdinBootstrap;
}
function retainCurrentHostedManagedDependencyProviderInvocation(context: CurrentHostedDependencyOrigin,
  fence: HostedActivationFence, invocation: Readonly<{command:string;args:readonly string[];systemdUnit?:string}>): void {
  const unit = invocation.systemdUnit; if (!unit) invalid(); readCurrentHostedManagedDependencyProviderTools(context,fence,unit);
  const provider = contexts.get(context)?.rootPurpose?.provider;
  if (!provider || provider.invocation || invocation.command !== hostedDependencySystemdRunExecutable ||
      !invocation.args.includes(`--unit=${unit}`) || !invocation.args.includes(`--property=RootDirectory=${provider.root.canonicalPath}`)) invalid();
  provider.invocation = invocation; provider.command = invocation.command; provider.args = Object.freeze([...invocation.args]);
}
function bindCurrentHostedManagedDependencyProviderChild(context: CurrentHostedDependencyOrigin,
  invocation: object, child: ChildProcess): void {
  const provider = contexts.get(context)?.rootPurpose?.provider;
  if (!provider || provider.invocation !== invocation || provider.child || !provider.command || !provider.args) invalid();
  assertHostedFdProcess(child,provider.unit,HostedFdLaunchKind.Provider,provider.command,provider.args); provider.child = child;
}
/** Physical cleanup of the original entry's resources only. Parent origin and
 * helper purpose survive a proven resource close; no re-open grant is minted. */
export function closeCurrentHostedManagedDependencyProviderTools(context: CurrentHostedDependencyOrigin, unit: string): void {
  const state = contexts.get(context)?.rootPurpose, provider = state?.provider;
  if (!state || !provider) return; if (provider.unit !== unit) invalid();
  provider.capsule.close(); provider.record.close(); delete state.provider;
}
export function assertCurrentHostedManagedDependencyCapsuleCopy(context: CurrentHostedDependencyOrigin,
  fence: HostedActivationFence, unit: string, fd: number): void {
  // The fixed FDA reader owns a temporary contained FD. No collector runs
  // until that reader closes it; this comparison registers no descriptor.
  assertHostedActivationFence(fence); readRetainedHostedDependencyAttemptFacts(context,DependencyOwnerPhase.Running);
  const provider = contexts.get(context)?.rootPurpose?.provider; if (!provider) invalid();
  if (provider.unit !== unit) invalid();
  const retained = fstatSync(provider.capsule.fd,{bigint:true}), actual = fstatSync(fd,{bigint:true});
  if (!sameStat(retained,actual) || !readManagedProviderDescriptor(fd).equals(encode(dependencyToolGuestConfig(provider.qualification)))) invalid();
}
function readManagedProviderDescriptor(fd: number): Buffer {
  const before = fstatSync(fd,{bigint:true}); if (!before.isFile() || before.size < 1n || before.size > 16384n) invalid();
  const bytes = Buffer.alloc(Number(before.size)+1); let length = 0;
  while (length < bytes.length) { const count = readSync(fd,bytes,length,bytes.length-length,length); if (!count) break; length += count; }
  if (BigInt(length) !== before.size || !sameStat(before,fstatSync(fd,{bigint:true}))) invalid(); return bytes.subarray(0,length);
}

/** Routing observation only; never permission to read project inputs. */
export function isHostedManagedReadonlyOuterRuntime(): boolean {
  return process.platform === "linux" && /^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-outer-[a-f0-9-]{36}\.service$/.test(
    readFileSync("/proc/self/cgroup","utf8").trim());
}

/** Classification only: actual outer epoch determines whether omitted/foreign
 * request paths still require the protected dependency branch. */
export function isCurrentHostedDependencyManagedReadonlyOrigin(fence: HostedActivationFence): boolean {
  assertHostedActivationFence(fence); assertHostedActivationOperator();
  const group = readFileSync("/proc/self/cgroup","utf8").trim();
  if (!/^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-outer-[a-f0-9-]{36}\.service$/.test(group)) return false;
  const epoch = parseHostedCustodyEpoch(decodeHostedActivationBytes(fixed("readonly-epoch.json").bytes));
  return isHostedDependencyWorkspace(epoch.identity.workspacePath);
}

/** Routing only, before any caller workspace/context-based fallback. The
 * actual C/R unit selects its protected dependency branch; no origin is issued.
 * Inconsistent protected state throws, so omission cannot select legacy IO. */
export function requiresCurrentHostedDependencyRootPurpose(): boolean {
  if (process.platform !== "linux") return false;
  const group = readFileSync("/proc/self/cgroup","utf8");
  if (group.length > 4096) invalid();
  const current = group.trim();
  const outer = /^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-outer-[a-f0-9-]{36}\.service$/.exec(current);
  const ordinary = /^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-ordinary-[a-f0-9-]{36}\.service$/.exec(current);
  if ((!outer || outer[0] !== current) && (!ordinary || ordinary[0] !== current)) return false;
  return withHostedActivationFence(fence => {
    if (outer) {
      assertHostedActivationOperator();
      if (readHostedActivationBytes("readonly-epoch.next")) invalid();
      const before = fixed("readonly-epoch.json"), epoch = parseHostedCustodyEpoch(decodeHostedActivationBytes(before.bytes));
      const row = epoch.outerRuntime, unit = current.slice(current.lastIndexOf("/")+1);
      if (epoch.phase !== HostedCustodyPhase.Ready || epoch.revoked || !row || row.state !== HostedCustodyReservationState.Reserved ||
          row.generation !== epoch.generation || row.unit !== unit || row.unit !== `subscription-runtime-outer-${row.startId}.service` ||
          row.creatorId !== row.startId || epoch.bootId !== readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim() ||
          readHostedActivationBytes(`scoped-terminating/${row.startId}.json`)) invalid();
      const birth = fixed(`readonly-outer-start-${row.startId}.json`,4096);
      if (!birth.bytes.equals(encode({schemaVersion:1,hostId:epoch.hostId,bootId:epoch.bootId,jobId:epoch.identity.jobId,
          generation:epoch.generation,startId:row.startId,creatorId:row.creatorId,unit:row.unit}))) invalid();
      const after = fixed("readonly-epoch.json");
      if (!before.bytes.equals(after.bytes) || !sameDependencyProtectedReference(before.reference,after.reference)) invalid();
      return isHostedDependencyWorkspace(epoch.identity.workspacePath);
    }
    const actual = readHostedOrdinaryProcessOrigin(fence), binding = readHostedDependencyBinding(String(actual.start.jobId));
    if (!binding) { if (isHostedDependencyWorkspace(String(actual.start.workspacePath))) invalid(); return false; }
    if (binding.jobRootDir !== actual.start.jobRootDir || binding.workspace.canonicalPath !== actual.start.workspacePath ||
        binding.installationId !== actual.start.installationId || binding.grantDigest !== actual.start.grantSha256) invalid();
    if (binding.version === 3) invalid(); // Protected reference has no helper/provider purpose.
    return binding.version === 2;
  });
}

/** Actual latest owner read AFTER the expensive current-origin collection.
 * A factual returned attempt is not an enqueue permit; final frame reasserts. */
export function assertCurrentHostedDependencyAttempt(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence,
  phase: DependencyOwnerPhase = DependencyOwnerPhase.Running) {
  return attemptFromFacts(assertCurrentHostedDependencyOrigin(context,fence),phase);
}
function attemptFromFacts(facts: CurrentHostedDependencyOriginFacts, phase: DependencyOwnerPhase) {
  if (facts.kind === CurrentHostedDependencyOriginKind.Ordinary) {
    const binding = readHostedDependencyBinding(String(facts.ordinary.start.jobId)); if (!binding) invalid();
    const attempt = readHostedDependencyAttempt(binding,facts.ordinary.start,String(facts.ordinary.reservation.startId),phase);
    return Object.freeze({facts,binding,attempt});
  }
  const {binding,start,association} = facts, name = `dependency-owners/${binding.workspace.dev}-${binding.workspace.ino}`;
  assertHostedDependencyStartAllowed(start.startId);
  if (readHostedActivationBytes(name+".lock")) invalid();
  const owner = parseDependencyOwner(decodeHostedActivationBytes(fixed(name+".json",16384).bytes));
  if (readHostedActivationBytes(name+".lock") || owner.version !== 3 || !sameDependencyWorkspace(owner.workspace,binding.workspace) ||
      !sameDependencyProtectedReference(owner.custodyBinding,association.reference) || !isDependencyConsumerOwner(owner.owner) || owner.owner.phase !== phase) invalid();
  const attempt = owner.owner.attempt, launch = attempt.launch;
  if (!("kind" in launch) || launch.kind !== DependencyConsumerLaunchKind.ManagedReadonlyLocalV1 ||
      launch.startId !== start.startId || launch.unit !== start.unit || launch.bootId !== start.bootId ||
      launch.installationId !== start.installationId || launch.runtimeSha !== start.runtimeSha || launch.grantDigest !== start.grantDigest ||
      !sameDependencyProtectedReference(launch.association,association.reference) || !sameDependencyProtectedReference(launch.origin,facts.originReference)) invalid();
  assertHostedDependencyPhysicalWorkspace(binding);
  return Object.freeze({facts,binding,attempt});
}

/** Metadata-only current owner fact for an already private-qualified read model.
 * It cannot mint an origin/qualifier or authorize effects: every submission uses
 * assertCurrentHostedDependencyAttempt under the actual fresh fence/collector. */
export function readRetainedHostedDependencyAttemptFacts(context: CurrentHostedDependencyOrigin,
  phase: DependencyOwnerPhase = DependencyOwnerPhase.Running) {
  const retained = contexts.get(context); if (!retained) invalid(); return attemptFromFacts(retained.facts,phase);
}

const rootInternalAccess = Symbol("hosted.root.internal.access");
class RootPurposeFacade {
  #origin: CurrentHostedDependencyOrigin;
  #purpose: HostedDependencyRootPurpose;
  constructor(origin: CurrentHostedDependencyOrigin, purpose: HostedDependencyRootPurpose) {
    this.#origin = origin; this.#purpose = purpose; Object.freeze(this);
  }
  static resolve(context: RootPurposeFacade, purpose: HostedDependencyRootPurpose, access: symbol) {
    if (access !== rootInternalAccess) invalid();
    if (!(context instanceof RootPurposeFacade) || context.#purpose !== purpose) invalid();
    const retained = contexts.get(context.#origin), state = retained?.rootPurpose;
    if (!retained || !state || (purpose === HostedDependencyRootPurpose.ManagedGitReadV1 ? state.managed : state.cleanup) !== context) invalid();
    return { origin:context.#origin, state };
  }
}
// Freeze reflected dispatch before the first facade can escape. A wrapper must
// never intercept the lexical access argument or private original-map state.
Object.freeze(RootPurposeFacade); Object.freeze(RootPurposeFacade.prototype);
export type HostedDependencyRootPurposeContext = RootPurposeFacade;
type RootPurposeState = {
  readonly record: HostedDependencyRootPreparationRecord; readonly reference: DependencyProtectedReference;
  readonly ready: ReturnType<LocalDependencyReceiptStore["getCommittedReady"]>;
  readonly managed: RootPurposeFacade; cleanup?: RootPurposeFacade;
  readonly descriptors: Map<RootDescriptor, HostedDependencyRootDescriptorMaterial>;
  provider?: ManagedProviderState;
};
type ManagedProviderState = {
  readonly unit: string; readonly reference: DependencyProtectedReference; readonly root: HostedDependencyRootDirectoryPin;
  readonly qualification: DependencyToolQualification; readonly ready: DependencyToolReadyFacts;
  readonly record: RootDescriptor; readonly capsule: RootDescriptor; readonly capsulePath: string;
  invocation?: object; child?: ChildProcess; command?: string; args?: readonly string[];
};
/** The class value/constructor is private. Its record is factual cleanup state;
 * every open/getter/assertion still resolves the sole original-origin map. */
class RootDescriptor {
  readonly #origin: CurrentHostedDependencyOrigin;
  readonly #material: HostedDependencyRootDescriptorMaterial;
  constructor(origin: CurrentHostedDependencyOrigin, material: HostedDependencyRootDescriptorMaterial, construction: symbol) {
    // A class constructor can be reflected from a real resource's prototype.
    // Runtime construction therefore requires this lexical private constant;
    // it is not an issuing authority and can grant no read/open/purpose.
    if (construction !== rootInternalAccess) invalid();
    this.#origin = origin; this.#material = material;
  }
  get fd(): number {
    const state = contexts.get(this.#origin)?.rootPurpose;
    if (!state || state.descriptors.get(this) !== this.#material || this.#material.closed) invalid();
    if (!sameDependencyAttempt(readRetainedHostedDependencyAttemptFacts(this.#origin,DependencyOwnerPhase.Running).attempt,state.record.attempt)) invalid();
    return this.#material.fd;
  }
  close(): void {
    if (this.#material.closed) return;
    const state = contexts.get(this.#origin)?.rootPurpose;
    if (state && state.descriptors.get(this) !== this.#material) invalid();
    // A close uncertainty revokes the whole origin, never authorizes FD reuse.
    try {
      // Bytes may have changed after a failed read. Cleanup still requires the
      // exact physical handle, not stability of the former content snapshot.
      const handles = [...this.#material.ancestors,...this.#material.dependencies,this.#material];
      for (const handle of handles) {
        const actual = fstatSync(handle.fd,{bigint:true}), pin = handle.stat;
        const text = readFileSync(`/proc/self/fdinfo/${handle.fd}`,"utf8");
        const flags = /^flags:\s+([0-7]{1,12})$/m.exec(text), mount = /^mnt_id:\s+([1-9][0-9]*)$/m.exec(text);
        if (text.length > 4096 || actual.dev !== pin.dev || actual.ino !== pin.ino || actual.mode !== pin.mode || actual.uid !== pin.uid || actual.gid !== pin.gid ||
            readlinkSync(`/proc/self/fd/${handle.fd}`) !== handle.path || !flags || !mount ||
            Number.parseInt(flags[1]!,8) !== handle.flags || mount[1] !== handle.mountId) invalid();
      }
      // A revoked resource can still close its own physically authenticated
      // private handles. This cleanup grants no read, path, scope or new origin.
      for (const handle of handles.reverse()) closeSync(handle.fd);
      this.#material.closed = true; state?.descriptors.delete(this);
    }
    catch (error) { contexts.delete(this.#origin); if (currentRootOrigin === this.#origin) currentRootOrigin = undefined; throw error; }
  }
}
Object.freeze(RootDescriptor); Object.freeze(RootDescriptor.prototype);
export type HostedDependencyRootDescriptor = RootDescriptor;
function assertRootPurposeDescriptors(state: RootPurposeState): void {
  if (state.descriptors.size > 256) invalid();
  for (const material of state.descriptors.values()) assertHostedDependencyRootDescriptorMaterial(material);
  for (const fd of [0,1,2]) { const stat = fstatSync(fd); if (!stat.isFIFO() && !stat.isSocket()) invalid(); }
  const names = readdirSync("/proc/self/fd"); if (names.length > 512) invalid();
  for (const name of names) {
    if (!/^(?:0|[1-9][0-9]{0,5})$/.test(name)) invalid(); const fd = Number(name); if (fd <= 2) continue;
    try {
      const stat = fstatSync(fd); if (!stat.isFile() && !stat.isDirectory()) continue;
      const associated = [...state.descriptors.values()].find(material => material.fd === fd ||
        [...material.ancestors,...material.dependencies].some(anchor => anchor.fd === fd));
      if (!associated) invalid(); assertHostedDependencyRootDescriptorMaterial(associated);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error; }
  }
}
let currentRootOrigin: CurrentHostedDependencyOrigin | undefined;
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value)+"\n");
function freezeFacts<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeFacts(child); if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}
/** Factual physical capture only. Calling this cannot register any purpose. */
export function readHostedDependencyRootDirectoryPin(path: string): HostedDependencyRootDirectoryPin {
  if (path !== "/" && /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.exec(path)?.[0] !== path ||
      path.split("/").some(p => p === "." || p === "..")) invalid();
  const parents: {path:string;stat:BigIntStats}[] = [];
  for (let p = path;; p = dirname(p)) {
    const stat = lstatSync(p,{bigint:true});
    if (!stat.isDirectory() || (p !== path && (stat.uid !== 0n || stat.gid !== 0n || (stat.mode & 0o022n)))) invalid();
    parents.push({path:p,stat}); if (p === "/") break;
  }
  const fd = openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd,{bigint:true}), named = parents[0]!.stat;
    if (stat.dev !== named.dev || stat.ino !== named.ino || stat.mode !== named.mode) invalid();
    const info = readFileSync(`/proc/self/fdinfo/${fd}`,"utf8");
    if (info.length > 16384) invalid(); const match = [...info.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
    if (match.length !== 1 || !match[0]?.[1]) invalid();
    for (const parent of parents) { const now = lstatSync(parent.path,{bigint:true});
      if (now.dev !== parent.stat.dev || now.ino !== parent.stat.ino || now.uid !== parent.stat.uid || now.gid !== parent.stat.gid || now.mode !== parent.stat.mode) invalid(); }
    return Object.freeze({canonicalPath:path,dev:String(stat.dev),ino:String(stat.ino),mountId:match[0][1]});
  } finally { closeSync(fd); }
}
function assertDirectory(pin: HostedDependencyRootDirectoryPin): void {
  if (!pin || Object.keys(pin).sort().join(",") !== "canonicalPath,dev,ino,mountId" ||
      !encode(readHostedDependencyRootDirectoryPin(pin.canonicalPath)).equals(encode(pin))) invalid();
}
function currentOwnerForRoot(binding: HostedDependencyBinding) {
  const name = `dependency-owners/${binding.workspace.dev}-${binding.workspace.ino}`;
  if (readHostedActivationBytes(name+".lock")) invalid(); const owner = parseDependencyOwner(decodeHostedActivationBytes(fixed(name+".json",16384).bytes));
  if (readHostedActivationBytes(name+".lock") || !sameDependencyWorkspace(owner.workspace,binding.workspace)) invalid(); return owner;
}
function currentRootReady(binding: HostedDependencyBinding) {
  const store = LocalDependencyReceiptStore.open({rootPath:hostedDependencyReceiptHistoryRoot,maxRecordBytes:16384,maxHistorySteps:2048});
  try {
    const receipt = store.read(binding.workspace); if (!receipt || receipt.state !== DependencyReceiptState.Ready) invalid();
    const committed = store.getCommittedReady(binding.workspace,receipt.revision);
    if (!encode(committed.receipt).equals(encode(receipt))) invalid(); return freezeFacts(committed);
  } finally { store.close(); }
}
function rootIdentity(facts: CurrentHostedDependencyOriginFacts, binding: HostedDependencyBinding) {
  const installation = facts.kind === CurrentHostedDependencyOriginKind.ManagedReadonlyLocal ? facts.installation : facts.ordinary.installation;
  const inventoryPin = fixed("readonly-inventory.json"), inventory = parseHostedReadonlyHostInventory(decodeHostedActivationBytes(inventoryPin.bytes));
  if (hash(inventoryPin.bytes) !== installation.inventorySha256) invalid();
  const creators = inventory.ordinaryCreators.filter(row => row.jobId === binding.jobId && row.jobRootDir === binding.jobRootDir && row.workspacePath === binding.workspace.canonicalPath);
  if (creators.length !== 1) invalid(); const args = creators[0]!.launch.args;
  const value = (flag: string, optional = false): string | undefined => {
    const positions = args.flatMap((arg,i) => arg === flag ? [i] : []);
    if (positions.length !== (optional && positions.length === 0 ? 0 : 1)) invalid();
    if (!positions.length) return undefined; const text = args[positions[0]!+1];
    if (!text || text.startsWith("--") || text.includes("\0")) invalid(); return text;
  };
  const logicalTaskId = value("--task-id");
  if (!isHostedDependencySignedTaskId(logicalTaskId) || value("--job-root") !== binding.jobRootDir || value("--workspace") !== binding.workspace.canonicalPath) invalid();
  const durable = value("--durable-handoff-root",true), fixedDurable = binding.jobRootDir+"/durable-handoffs";
  if ((durable !== undefined && durable !== fixedDurable) ||
      (process.env.SUBSCRIPTION_RUNTIME_DURABLE_HANDOFF_ROOT !== undefined && process.env.SUBSCRIPTION_RUNTIME_DURABLE_HANDOFF_ROOT !== fixedDurable)) invalid();
  return {logicalTaskId,durable:fixedDurable,executionJobId:facts.kind === CurrentHostedDependencyOriginKind.ManagedReadonlyLocal ? facts.start.readonlyJobId : binding.jobId};
}
function readRootPreparation(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence) {
  const actual = assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation), {binding,attempt,facts} = actual;
  if (facts.kind !== CurrentHostedDependencyOriginKind.ManagedReadonlyLocal || binding.version !== 2) invalid();
  const selected = fixed(`dependency-root-preparations/${attempt.launch.startId}.json`,65536);
  const record = decodeHostedActivationBytes(selected.bytes) as HostedDependencyRootPreparationRecord;
  if (!record || Object.keys(record).sort().join(",") !== "attempt,authoredRoots,config,configAncestors,custodyReference,durableHandoffRoot,generatedRoots,protectedProfile,providerReady,qualification,ready,readyRevision,scratchParent,sourceLookupAncestors,version" ||
      record.version !== 2 || !encode(record).equals(selected.bytes) || !sameDependencyAttempt(record.attempt,attempt) ||
      !sameDependencyProtectedReference(record.custodyReference,facts.association.reference)) invalid();
  const ready = currentRootReady(binding);
  if (record.readyRevision !== ready.receipt.revision || !sameDependencyProtectedReference(record.ready,ready.reference)) invalid();
  assertRootPhysicalRecord(record,facts,binding,attempt);
  const after = assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
  if (!sameDependencyAttempt(after.attempt,attempt) || !encode(currentRootReady(binding)).equals(encode(ready))) invalid();
  return {record:freezeFacts(record),reference:freezeFacts(selected.reference),ready};
}
function assertRootPhysicalRecord(record: HostedDependencyRootPreparationRecord, facts: CurrentHostedDependencyOriginFacts,
  binding: HostedDependencyBinding, attempt: ReturnType<typeof attemptFromFacts>["attempt"], remaining = systemdObservationBudget()) {
  const identity = rootIdentity(facts,binding);
  if (record.durableHandoffRoot.canonicalPath !== identity.durable || record.scratchParent.canonicalPath !== `${root}/dependency-root-scratch/${attempt.launch.startId}` ||
      record.durableHandoffRoot.dev !== binding.workspace.dev || record.durableHandoffRoot.mountId !== record.authoredRoots[0]?.mountId) invalid();
  for (const privateParent of [record.durableHandoffRoot,record.scratchParent]) {
    assertDirectory(privateParent); const actual = lstatSync(privateParent.canonicalPath);
    if (actual.uid !== 0 || actual.gid !== 0 || (actual.mode & 0o7777) !== 0o700) invalid();
  }
  const scratchRoot = readHostedDependencyRootDirectoryPin(`${root}/dependency-root-scratch`), protectedRoot = readHostedDependencyRootDirectoryPin(root);
  const parentStat = lstatSync(scratchRoot.canonicalPath);
  if (parentStat.uid !== 0 || parentStat.gid !== 0 || (parentStat.mode & 0o7777) !== 0o700 ||
      scratchRoot.dev !== protectedRoot.dev || scratchRoot.mountId !== protectedRoot.mountId ||
      record.scratchParent.dev !== scratchRoot.dev || record.scratchParent.mountId !== scratchRoot.mountId) invalid();
  if (!Array.isArray(record.authoredRoots) || record.authoredRoots.length < 1 || record.authoredRoots.length > 129 ||
      !Array.isArray(record.generatedRoots) || record.generatedRoots.length !== 1 || !Array.isArray(record.sourceLookupAncestors) || record.sourceLookupAncestors.length > 16384 ||
      record.authoredRoots[0]?.canonicalPath !== binding.workspace.canonicalPath || record.authoredRoots[0]?.dev !== binding.workspace.dev ||
      record.authoredRoots[0]?.ino !== binding.workspace.ino || record.generatedRoots[0]?.canonicalPath !== binding.workspace.canonicalPath+"/node_modules") invalid();
  for (const pin of [...record.authoredRoots,...record.generatedRoots,...record.sourceLookupAncestors]) {
    if (pin.canonicalPath !== binding.workspace.canonicalPath && !pin.canonicalPath.startsWith(binding.workspace.canonicalPath+"/")) invalid();
    assertDirectory(pin);
  }
  const qualification = material(record.qualification,`${root}/${dependencyToolQualificationRecordName(attempt.launch.startId)}`,16384), q = parseDependencyToolQualification(decodeHostedActivationBytes(qualification.bytes));
  if (q.attemptId !== attempt.attemptId || q.epoch !== attempt.epoch || q.startId !== attempt.launch.startId || q.readyRevision !== record.readyRevision ||
      !sameDependencyWorkspace(q.workspace,binding.workspace) || q.tree.dev !== record.generatedRoots[0]!.dev || q.tree.ino !== record.generatedRoots[0]!.ino) invalid();
  const ready = currentRootReady(binding).receipt, providerReady = record.providerReady;
  if (!matchesDependencyToolReadyIdentity({workspace:ready.workspace,coverageRevision:ready.coverageRevision,revision:ready.revision,
      installKey:ready.installKey,tree:ready.tree,manifestDigest:ready.manifestDigest},providerReady) ||
      providerReady.provenance.kind === DependencyToolReadyProvenanceKind.RegistryCompleted ||
      !encode(providerReady.provenance.readonlySources.map(source => ({canonicalPath:source.canonicalPath,
        dev:source.identity.dev,ino:source.identity.ino}))).equals(encode(record.authoredRoots.slice(1).map(pin => ({canonicalPath:pin.canonicalPath,dev:pin.dev,ino:pin.ino}))))) invalid();
  const sourceBinding = providerReady.provenance.sourceBinding;
  material({path:sourceBinding.path,identity:sourceBinding.identity,sha256:sourceBinding.sha256},sourceBinding.path,262144);
  const profile = material(record.protectedProfile,`${root}/dependency-installer-profile.json`,16384);
  const decoded = decodeHostedActivationBytes(profile.bytes) as Record<string,unknown>;
  if (decoded.schemaVersion !== 2) invalid(); const rootGit = assertHostedDependencyRootGitProfile(decoded.rootGit,remaining);
  const config = material(record.config,`${binding.workspace.canonicalPath}/.git/config`,65536,false);
  assertHostedDependencyRootGitConfigBytes(config.bytes);
  if (!Array.isArray(record.configAncestors) || record.configAncestors.length < 2 || record.configAncestors.length > 128) invalid();
  let parent = `${binding.workspace.canonicalPath}/.git`;
  for (const pin of record.configAncestors) { if (pin.canonicalPath !== parent) invalid(); assertDirectory(pin); parent = dirname(parent); }
  if (record.configAncestors.at(-1)?.canonicalPath !== "/") invalid();
  if (remaining() <= 0) invalid(); return {identity,rootGit};
}
/** No DTO inputs. Loads the sole trusted qualifier's fixed protected record and
 * actual Ready before Running; provenance lives in the original origin map. */
export function prepareCurrentHostedDependencyRootPurpose(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence): void {
  const retained = contexts.get(context); if (!retained || retained.rootPurpose) invalid();
  const preparation = readRootPreparation(context,fence), managed = new RootPurposeFacade(context,HostedDependencyRootPurpose.ManagedGitReadV1);
  retained.rootPurpose = {...preparation,managed,descriptors:new Map()}; currentRootOrigin = context;
}
export function captureCurrentHostedDependencyRootPurpose(purpose: HostedDependencyRootPurpose): HostedDependencyRootPurposeContext {
  if (!currentRootOrigin) invalid(); const origin = currentRootOrigin, state = contexts.get(origin)?.rootPurpose; if (!state) invalid();
  if (purpose === HostedDependencyRootPurpose.ManagedGitReadV1) return state.managed;
  if (purpose !== HostedDependencyRootPurpose.DependencySourceCleanupV1 || state.cleanup) invalid();
  // Source hygiene alone captures current Ready while genuinely exclusive.
  // A historical preprepared pointer cannot resurrect a retired baseline.
  return withHostedActivationFence(fence => {
    const current = assertCurrentHostedDependencyAttempt(origin,fence,DependencyOwnerPhase.ExclusiveMutation);
    if (!sameDependencyAttempt(current.attempt,state.record.attempt) || !encode(currentRootReady(current.binding)).equals(encode(state.ready))) invalid();
    state.cleanup = new RootPurposeFacade(origin,purpose); return state.cleanup;
  });
}
function rootScope(context: RootPurposeFacade, purpose: HostedDependencyRootPurpose, fence: HostedActivationFence,
  phase: DependencyOwnerPhase) {
  const {origin,state} = RootPurposeFacade.resolve(context,purpose,rootInternalAccess), actual = assertCurrentHostedDependencyAttempt(origin,fence,phase);
  const {binding,attempt,facts} = actual, owner = currentOwnerForRoot(binding);
  if (facts.kind !== CurrentHostedDependencyOriginKind.ManagedReadonlyLocal || owner.version !== 3 || !isDependencyConsumerOwner(owner.owner) ||
      !sameDependencyAttempt(owner.owner.attempt,attempt) || owner.owner.phase !== phase || !sameDependencyAttempt(attempt,state.record.attempt) ||
      !sameDependencyProtectedReference(owner.custodyBinding,state.record.custodyReference)) invalid();
  material(state.reference,`${root}/dependency-root-preparations/${attempt.launch.startId}.json`,65536);
  const identity = rootIdentity(facts,binding), scope: HostedDependencyRootScope = freezeFacts({logicalJobId:binding.jobId,logicalTaskId:identity.logicalTaskId,
    executionJobId:identity.executionJobId,jobRootDir:binding.jobRootDir,workspace:binding.workspace,attempt,ownerRevision:owner.revision,custodyReference:owner.custodyBinding});
  return {origin,state,actual,owner,scope};
}
export function assertCurrentHostedDependencyRootPurpose(context: HostedDependencyRootPurposeContext,
  purpose: HostedDependencyRootPurpose.ManagedGitReadV1, fence: HostedActivationFence): HostedDependencyManagedGitScope {
  const remaining = systemdObservationBudget(), held = rootScope(context,purpose,fence,DependencyOwnerPhase.Running);
  if (!encode(currentRootReady(held.actual.binding)).equals(encode(held.state.ready))) invalid();
  const physical = assertRootPhysicalRecord(held.state.record,held.actual.facts,held.actual.binding,held.actual.attempt,remaining);
  const after = assertCurrentHostedDependencyAttempt(held.origin,fence,DependencyOwnerPhase.Running);
  if (!sameDependencyAttempt(after.attempt,held.actual.attempt) || !encode(currentOwnerForRoot(after.binding)).equals(encode(held.owner)) ||
      !encode(currentRootReady(after.binding)).equals(encode(held.state.ready)) || remaining() <= 0) invalid();
  const record = held.state.record;
  return Object.freeze({...held.scope,rootGit:physical.rootGit,protectedProfile:record.protectedProfile,durableHandoffRoot:record.durableHandoffRoot,
    scratchParent:record.scratchParent,authoredRoots:record.authoredRoots,generatedRoots:record.generatedRoots,sourceLookupAncestors:record.sourceLookupAncestors});
}
/** The ONLY helper descriptor association edge. All provenance remains in the
 * existing original-origin entry; selection data cannot supply an FD or pins. */
export function openCurrentHostedDependencyRootDescriptor(context: HostedDependencyRootPurposeContext,
  fence: HostedActivationFence, recipe: HostedDependencyRootDescriptorRecipe, path: string): HostedDependencyRootDescriptor {
  const {origin,state} = RootPurposeFacade.resolve(context,HostedDependencyRootPurpose.ManagedGitReadV1,rootInternalAccess);
  const scope = assertCurrentHostedDependencyRootPurpose(context,HostedDependencyRootPurpose.ManagedGitReadV1,fence);
  if (state.descriptors.size >= 256) invalid();
  const material = openHostedDependencyRootDescriptorMaterial(scope,recipe,path), descriptor = new RootDescriptor(origin,material,rootInternalAccess);
  Object.freeze(descriptor);
  state.descriptors.set(descriptor,material);
  try { assertCurrentHostedDependencyRootPurpose(context,HostedDependencyRootPurpose.ManagedGitReadV1,fence); return descriptor; }
  catch (error) { descriptor.close(); throw error; }
}
export function assertCurrentHostedDependencyRetiredReady(context: HostedDependencyRootPurposeContext,
  fence: HostedActivationFence): HostedDependencyRootScope {
  const held = rootScope(context,HostedDependencyRootPurpose.DependencySourceCleanupV1,fence,DependencyOwnerPhase.ExclusiveMutation);
  if (held.owner.version !== 3 || !held.owner.generationContinuity) invalid();
  const slot = parseDependencyGenerationContinuityInvalidation(held.owner.generationContinuity), ready = held.state.ready;
  const store = LocalDependencyReceiptStore.open({rootPath:hostedDependencyReceiptHistoryRoot,maxRecordBytes:16384,maxHistorySteps:2048});
  try {
    const current = store.read(held.actual.binding.workspace);
    if (!current || current.state !== DependencyReceiptState.Unverified || current.revision !== ready.receipt.revision+1 || current.generation !== ready.receipt.generation ||
        slot.operationId !== held.actual.attempt.attemptId || slot.readyRevision !== ready.receipt.revision || slot.unverifiedRevision !== current.revision ||
        slot.generation !== ready.receipt.generation || !sameDependencyProtectedReference(slot.previousReady,ready.reference)) invalid();
    const previous = store.getCommittedReady(held.actual.binding.workspace,ready.receipt.revision), retired = store.getCommittedUnverified(held.actual.binding.workspace,current.revision);
    if (!encode(previous).equals(encode(ready)) || !encode(retired.receipt).equals(encode(current)) || !sameDependencyProtectedReference(retired.reference,slot.retiredUnverified)) invalid();
  } finally { store.close(); }
  const after = assertCurrentHostedDependencyAttempt(held.origin,fence,DependencyOwnerPhase.ExclusiveMutation);
  if (!sameDependencyAttempt(after.attempt,held.actual.attempt) || !encode(currentOwnerForRoot(after.binding)).equals(encode(held.owner))) invalid();
  return held.scope;
}

/** One concrete retirement producer under the actual synchronous host fence.
 * Store verifier inputs are the stores' own captured predecessor facts. Neither
 * callbacks, baseline records nor expected revisions arrive from the caller.
 * An uncertain receipt/CAS is held, never released or implicitly retried.
 */
export function retireCurrentHostedDependencySourceCleanup(context: HostedDependencyRootPurposeContext,
  reason: DependencyUnverifiedReason.TreeChanged | DependencyUnverifiedReason.InputsChanged): void {
  RootPurposeFacade.resolve(context,HostedDependencyRootPurpose.DependencySourceCleanupV1,rootInternalAccess);
  withHostedActivationFence(fence => {
    const held = rootScope(context,HostedDependencyRootPurpose.DependencySourceCleanupV1,fence,DependencyOwnerPhase.ExclusiveMutation);
    if ((reason !== DependencyUnverifiedReason.TreeChanged && reason !== DependencyUnverifiedReason.InputsChanged) ||
        !encode(currentRootReady(held.actual.binding)).equals(encode(held.state.ready))) invalid();
    // No collectors execute while either store owns temporary descriptors.
    // The same genuine outer fence brackets both publications and final actual
    // collector/readback. Owner verifier uses its OWN captured owner under CAS.
    const assertRetained = () => {
      assertHostedActivationFence(fence);
      const resolved = RootPurposeFacade.resolve(context,HostedDependencyRootPurpose.DependencySourceCleanupV1,rootInternalAccess);
      if (resolved.origin !== held.origin || resolved.state !== held.state) invalid();
    };
    const receipts = LocalDependencyReceiptStore.open({rootPath:hostedDependencyReceiptHistoryRoot,maxRecordBytes:16384,maxHistorySteps:2048,
      generationReceiptVerifier:{
        assertReadyRetirement({previousReady,previousReference,proposedUnverified}) {
          assertRetained(); const owner = currentOwnerForRoot(held.actual.binding);
          if (!encode(owner).equals(encode(held.owner)) || !encode(previousReady).equals(encode(held.state.ready.receipt)) ||
              !sameDependencyProtectedReference(previousReference,held.state.ready.reference) || proposedUnverified.revision !== previousReady.revision+1 ||
              proposedUnverified.generation !== previousReady.generation || proposedUnverified.reason !== reason ||
              !sameDependencyWorkspace(proposedUnverified.workspace,held.actual.binding.workspace)) invalid();
        },
        assertFactualUnverified() { invalid(); },
      }});
    let owners: LocalDependencyOwnerStore | undefined;
    try {
      owners = LocalDependencyOwnerStore.open({rootPath:root+"/dependency-owners",maxRecordBytes:16384,
        generationRetirementVerifier:{assertGenerationRetirement({previousOwner,proposedOwner,invalidation}) {
          assertRetained();
          if (!encode(previousOwner).equals(encode(held.owner)) || proposedOwner.revision !== previousOwner.revision+1 ||
              !encode(proposedOwner.owner).equals(encode(previousOwner.owner)) || proposedOwner.epoch !== previousOwner.epoch ||
              !sameDependencyProtectedReference(proposedOwner.custodyBinding,held.state.record.custodyReference) ||
              invalidation.operationId !== held.actual.attempt.attemptId || invalidation.readyRevision !== held.state.ready.receipt.revision ||
              invalidation.unverifiedRevision !== held.state.ready.receipt.revision+1 || invalidation.generation !== held.state.ready.receipt.generation ||
              !sameDependencyProtectedReference(invalidation.previousReady,held.state.ready.reference)) invalid();
          const current = receipts.read(held.actual.binding.workspace);
          if (!current || current.state !== DependencyReceiptState.Unverified || current.revision !== invalidation.unverifiedRevision ||
              current.generation !== invalidation.generation || current.reason !== reason) invalid();
          const committed = receipts.getCommittedUnverified(held.actual.binding.workspace,current.revision);
          if (!encode(committed.receipt).equals(encode(current)) || !sameDependencyProtectedReference(committed.reference,invalidation.retiredUnverified)) invalid();
        }}});
      invalidateDependencyGeneration({owners,receipts,workspace:held.actual.binding.workspace,expectedOwnerRevision:held.owner.revision,
        expectedReceiptRevision:held.state.ready.receipt.revision,reason});
    } finally { try { owners?.close(); } finally { receipts.close(); } }
    assertCurrentHostedDependencyRetiredReady(context,fence);
  });
}

/** Protected config facts only, bounded retained FD and root ancestry. Actual
 * issuer/admission selects workspace first; this function cannot mint a purpose.
 */
export function readHostedDependencyRootGitConfigPin(workspace: string) {
  const pin = selectedFile(`${workspace}/.git/config`,65536,false);
  assertHostedDependencyRootGitConfigBytes(pin.bytes);
  const ancestors: HostedDependencyRootDirectoryPin[] = [];
  for (let path = `${workspace}/.git`;; path = dirname(path)) {
    if (ancestors.length >= 128) invalid(); const stat = lstatSync(path);
    if (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o022)) invalid();
    ancestors.push(readHostedDependencyRootDirectoryPin(path)); if (path === "/") break;
  }
  const after = selectedFile(`${workspace}/.git/config`,65536,false);
  if (!sameDependencyProtectedReference(after.reference,pin.reference) || !after.bytes.equals(pin.bytes)) invalid();
  for (const ancestor of ancestors) assertDirectory(ancestor);
  return Object.freeze({...pin,ancestors:Object.freeze(ancestors)});
}

// PRIVATE physical descriptor recipe implementation. Only the genuine public
// original-map opener above calls this; scope DTOs cannot select raw source IO.
function denied(): never { throw new Error("hosted_dependency_root_descriptor_denied"); }
function info(fd: number) {
  const text = readFileSync(`/proc/self/fdinfo/${fd}`,"utf8");
  if (text.length > 4096) denied();
  const flags = [...text.matchAll(/^flags:\s+([0-7]{1,12})$/gm)], mounts = [...text.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
  if (flags.length !== 1 || mounts.length !== 1) denied();
  const value = Number.parseInt(flags[0]![1]!,8);
  if (!Number.isSafeInteger(value) || (value & 3) || !(value & 0o2000000) || (value & 0o10000000)) denied();
  return {flags:value,mountId:mounts[0]![1]!};
}
function sameDirectory(a: BigIntStats, b: BigIntStats) {
  return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino &&
    a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
}
function sameFile(a: BigIntStats, b: BigIntStats) {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
    a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function beneath(path: string, root: string) { return path === root || path.startsWith(root+"/"); }
function full(pattern: RegExp, value: string) { return pattern.exec(value)?.[0] === value; }
function excluded(path: string, scope: HostedDependencyManagedGitScope) {
  return path.split("/").some(segment => segment === "node_modules" || segment === ".git") ||
    scope.generatedRoots.some(root => beneath(path,root.canonicalPath));
}
function packetName(name: string, task: string): boolean {
  if (name.startsWith(task+".")) return full(/^[a-f0-9]{64}\.packet$/,name.slice(task.length+1));
  if (!name.startsWith("."+task+".")) return false;
  return full(new RegExp(`^[a-f0-9]{64}\\.packet\\.${process.pid}\\.[a-f0-9]{16}\\.tmp$`),name.slice(task.length+2));
}
function durableLeaf(relative: string, task: string): boolean {
  const parts = relative.split("/");
  if (parts.length === 1 && parts[0]!.startsWith(task+"."))
    return full(/^[a-f0-9]{64}\.handoff\.(?:patch|summary\.json|manifest\.json)$/,parts[0]!.slice(task.length+1));
  return parts.length === 2 && packetName(parts[0]!,task) &&
    new Set(["status.porcelain-v2.z","index.patch","worktree.patch","head-relative.patch","untracked.tar","untracked.paths.z","quarantine.json","manifest.json"]).has(parts[1]!);
}
function select(scope: HostedDependencyManagedGitScope, recipe: HostedDependencyRootDescriptorRecipe, path: string) {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 16384 || path.includes("\0") ||
      path !== "/" && path.split("/").slice(1).some(segment => !segment || segment === "." || segment === "..") ||
      path.split("/").length > 512 || path === "/proc" || path.startsWith("/proc/")) denied();
  const workspace = scope.workspace.canonicalPath, durable = scope.durableHandoffRoot.canonicalPath, scratch = scope.scratchParent.canonicalPath;
  if (!isHostedDependencySignedTaskId(scope.logicalTaskId) || durable !== scope.jobRootDir+"/durable-handoffs") denied();
  if (recipe === HostedDependencyRootDescriptorRecipe.DirectoryV1) {
    const authored = scope.authoredRoots.some(pin => beneath(path,pin.canonicalPath)) && !excluded(path,scope);
    const scratchChild = path.startsWith(scratch+"/") && full(/^git-[A-Za-z0-9]{6}(?:\/objects)?$/,path.slice(scratch.length+1));
    const durableChild = path.startsWith(durable+"/") && packetName(path.slice(durable.length+1),scope.logicalTaskId);
    if (path !== scratch && path !== durable && !authored && !scratchChild && !durableChild || excluded(path,scope) || path === "/") denied();
    const pin = [...scope.authoredRoots,scope.durableHandoffRoot,scope.scratchParent].find(candidate => beneath(path,candidate.canonicalPath));
    return {directory:true,maximum:0,root:pin};
  }
  if (recipe === HostedDependencyRootDescriptorRecipe.AuthoredFileV1) {
    const root = scope.authoredRoots.find(pin => path.startsWith(pin.canonicalPath+"/"));
    if (!root || excluded(path,scope)) denied(); return {directory:false,maximum:64*1024*1024,root};
  }
  if (recipe === HostedDependencyRootDescriptorRecipe.GitIndexV1) {
    const relative = path.slice((workspace+"/.git/").length);
    if (!path.startsWith(workspace+"/.git/") || relative !== "index" && !full(/^sharedindex\.[a-f0-9]{40}(?:[a-f0-9]{24})?$/,relative)) denied();
    return {directory:false,maximum:32*1024*1024,root:scope.authoredRoots[0]};
  }
  if (recipe === HostedDependencyRootDescriptorRecipe.DurableFileV1) {
    if (!path.startsWith(durable+"/") || !durableLeaf(path.slice(durable.length+1),scope.logicalTaskId)) denied();
    return {directory:false,maximum:path.endsWith(".handoff.patch") ? 16*1024*1024 : 256*1024*1024,root:scope.durableHandoffRoot};
  }
  if (recipe === HostedDependencyRootDescriptorRecipe.TaskEventsV1) {
    if (path !== scope.jobRootDir+"/"+scope.logicalTaskId+".events.jsonl") denied();
    return {directory:false,maximum:16*1024*1024,root:scope.durableHandoffRoot};
  }
  denied();
}
/** Retained nofollow traversal. Every ancestor remains open until the selected
 * leaf is pinned. This function returns facts only; the sole origin map owns
 * the later association, and unrelated raw opens never enter that map. */
function openHostedDependencyRootDescriptorMaterial(scope: HostedDependencyManagedGitScope,
  recipe: HostedDependencyRootDescriptorRecipe, path: string,
  fixedSelection?: Readonly<{directory:false;maximum:number;root:HostedDependencyRootDirectoryPin}>): HostedDependencyRootDescriptorMaterial {
  const selection = fixedSelection ?? select(scope,recipe,path), descriptors: number[] = [], ancestors: HostedDependencyRootDescriptorAnchor[] = [], dependencies: HostedDependencyRootDescriptorAnchor[] = [];
  let retained = false;
  try {
    let parent = openSync("/",constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW); descriptors.push(parent);
    let physical = "/", actual = fstatSync(parent,{bigint:true});
    if (!sameDirectory(actual,lstatSync("/",{bigint:true})) || actual.uid !== 0n || actual.gid !== 0n || (actual.mode & 0o022n)) denied();
    const segments = path === "/" ? [] : path.slice(1).split("/");
    for (let index = 0; index < segments.length; index++) {
      ancestors.push(Object.freeze({fd:parent,path:physical,stat:actual,...info(parent)}));
      const last = index === segments.length-1, directory = !last || selection.directory;
      const named = `/proc/self/fd/${parent}/${segments[index]!}`, before = lstatSync(named,{bigint:true});
      const fd = openSync(named,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(directory ? constants.O_DIRECTORY:0));
      descriptors.push(fd); physical = physical === "/" ? "/"+segments[index]! : physical+"/"+segments[index]!;
      actual = fstatSync(fd,{bigint:true});
      if (!(directory ? sameDirectory(actual,before):sameFile(actual,before)) || actual.uid !== 0n || actual.gid !== 0n ||
          (actual.mode & 0o022n) || realpathSync(`/proc/self/fd/${fd}`) !== physical ||
          !(directory ? sameDirectory(actual,lstatSync(named,{bigint:true})):sameFile(actual,lstatSync(named,{bigint:true})))) denied();
      parent = fd;
    }
    const fd = parent, openedInfo = info(fd);
    if (!selection.directory && (!actual.isFile() || actual.nlink !== 1n || actual.size < 0n || actual.size > BigInt(selection.maximum))) denied();
    if (selection.root) {
      const rootPath = recipe === HostedDependencyRootDescriptorRecipe.TaskEventsV1 ? scope.jobRootDir : selection.root.canonicalPath;
      const anchor = path === rootPath ? {stat:actual,mountId:openedInfo.mountId} : ancestors.find(pin => pin.path === rootPath);
      if (!anchor || anchor.stat.dev.toString() !== selection.root.dev ||
        anchor.mountId !== selection.root.mountId || actual.dev.toString() !== selection.root.dev || openedInfo.mountId !== selection.root.mountId) denied();
      if (recipe !== HostedDependencyRootDescriptorRecipe.TaskEventsV1 && anchor.stat.ino.toString() !== selection.root.ino) denied();
      if (selection.directory && (beneath(path,scope.scratchParent.canonicalPath) || beneath(path,scope.durableHandoffRoot.canonicalPath)) &&
          (actual.mode & 0o7777n) !== 0o700n) denied();
      if (recipe === HostedDependencyRootDescriptorRecipe.TaskEventsV1) {
        const child = openSync(`/proc/self/fd/${descriptors[ancestors.findIndex(pin => pin.path === rootPath)]!}/durable-handoffs`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        descriptors.push(child); const durable = fstatSync(child,{bigint:true}), childInfo = info(child);
        if (durable.dev.toString() !== selection.root.dev || durable.ino.toString() !== selection.root.ino || childInfo.mountId !== selection.root.mountId ||
            durable.uid !== 0n || durable.gid !== 0n || (durable.mode & 0o7777n) !== 0o700n ||
            !sameDirectory(durable,lstatSync(selection.root.canonicalPath,{bigint:true})) || realpathSync(`/proc/self/fd/${child}`) !== selection.root.canonicalPath) denied();
        dependencies.push(Object.freeze({fd:child,path:selection.root.canonicalPath,stat:durable,...childInfo}));
      }
    }
    const result = {fd,path,directory:selection.directory,stat:actual,...openedInfo,ancestors:Object.freeze(ancestors),dependencies:Object.freeze(dependencies),closed:false};
    assertHostedDependencyRootDescriptorMaterial(result); retained = true; return result;
  } finally { if (!retained) for (const fd of descriptors.reverse()) closeSync(fd); }
}
function assertHostedDependencyRootDescriptorMaterial(material: HostedDependencyRootDescriptorMaterial): void {
  if (material.closed) denied();
  const opened = fstatSync(material.fd,{bigint:true}), named = lstatSync(material.path,{bigint:true}), current = info(material.fd);
  if (!(material.directory ? sameDirectory(material.stat,opened)&&sameDirectory(opened,named):sameFile(material.stat,opened)&&sameFile(opened,named)) ||
      current.flags !== material.flags || current.mountId !== material.mountId || readlinkSync(`/proc/self/fd/${material.fd}`) !== material.path ||
      realpathSync(material.path) !== material.path) denied();
  for (const anchor of [...material.ancestors,...material.dependencies]) {
    const current = info(anchor.fd);
    if (!sameDirectory(anchor.stat,fstatSync(anchor.fd,{bigint:true})) || !sameDirectory(anchor.stat,lstatSync(anchor.path,{bigint:true})) ||
        current.flags !== anchor.flags || current.mountId !== anchor.mountId || readlinkSync(`/proc/self/fd/${anchor.fd}`) !== anchor.path ||
        realpathSync(`/proc/self/fd/${anchor.fd}`) !== anchor.path) denied();
  }
}
