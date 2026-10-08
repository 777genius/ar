import { freezeFacts } from "./hosted-dependency-immutable-facts";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, statSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DependencyOwnerPhase, parseDependencyOwner, sameDependencyProtectedReference, sameDependencyWorkspace, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { HostedCustodyPhase, HostedCustodyReservationState, parseHostedInstallation, parseHostedActivation, parseHostedCustodyEpoch } from "@vioxen/subscription-runtime/worker-core";
import { parseHostedReadonlyHostInventory } from "../worker-core/hosted-custody/domain/hosted-readonly-inventory";
import { CodexProviderEgressProfileId } from "../provider-codex/codex-provider-egress-policy";
import { assertHostedActivationFence, assertHostedActivationOperator, readHostedActivationBytes, decodeHostedActivationBytes, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readHostedReadonlyDependencyStart, readHostedReadonlyDependencyAssociation } from "../provider-codex/app-server/adapters/hosted-dependency-origin";
import { readHostedDependencyBinding, assertHostedDependencyPhysicalWorkspace, hostedDependencyBindingName } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { systemdObservationBudget } from "../provider-codex/app-server/adapters/systemd-service-arrays";
import { readHostedFdProfile, observeHostedFdProcess, observeHostedFdUnit, assertHostedFdBootstrap } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { assertHostedFdFrameEnvironment } from "../provider-codex/app-server/adapters/hosted-fd-prelude";
import { verifySystemBusInfrastructure } from "../provider-codex/app-server/adapters/system-bus-infrastructure";
import { CurrentHostedDependencyOriginKind } from "./hosted-current-dependency-origin";
import { assertManagedReadonlyInstallationFacts, assertManagedReadonlyStartFacts, assertManagedReadonlyBindingFacts, assertManagedReadonlyOwnerFacts } from "./hosted-managed-readonly-origin-fact-equalities";
const root = "/var/lib/subscription-runtime-host-policy", transport = "/run/user/0/subscription-runtime-host-policy";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function invalid(): never { throw new Error("hosted_dependency_current_origin_unresolved"); }
/** Fixed actual host facts only. No origin/purpose issuance, caller path, FD list,
 * profile, scope DTO or callback. Issuing and association remain the original map. */
function sameStat(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
    a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
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
export function collectActualHostedManagedReadonlyOrigin(fence: HostedActivationFence) {
  assertHostedActivationFence(fence); assertHostedActivationOperator();
  const group = readFileSync("/proc/self/cgroup","utf8").trim();
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
  assertManagedReadonlyInstallationFacts(installation,activation,epoch,enrollment,inventory,hash(enrollmentPin.bytes),hash(inventoryPin.bytes));
  const busInfrastructure = inventory.systemBusInfrastructure; if (!busInfrastructure) invalid();
  const outer = epoch.outerRuntime;
  if (!outer || outer.state !== HostedCustodyReservationState.Reserved || outer.generation !== epoch.generation || outer.unit !== match[1] ||
      outer.startId !== match[2] || outer.creatorId !== outer.startId || readHostedActivationBytes(`scoped-terminating/${outer.startId}.json`)) invalid();
  const startPin = readHostedReadonlyDependencyStart(fence,outer.startId), start = startPin.value;
  assertManagedReadonlyStartFacts(start,installation,epoch);
  const binding = readHostedDependencyBinding(start.candidateJobId);
  assertManagedReadonlyBindingFacts(binding,installation,start);
  if (!binding || binding.version !== 2) invalid();
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
  assertManagedReadonlyOwnerFacts(owner,binding,association.reference,start);
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
  verifySystemBusInfrastructure(busInfrastructure,remaining);
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
