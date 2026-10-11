import { observedProcessCgroup } from "./hosted-readonly-observations";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, type BigIntStats, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { sameDependencyProtectedReference, type DependencyProtectedReference, DependencyOwnerPhase, DependencyConsumerLaunchKind, isDependencyConsumerOwner, parseDependencyOwner, sameDependencyWorkspace } from "@vioxen/subscription-runtime/core";
import { HostedCustodyPhase, HostedCustodyReservationState, parseHostedCustodyEpoch } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, assertHostedActivationOperator, decodeHostedActivationBytes, readHostedActivationBytes, readHostedOrdinaryProcessOrigin, collectHostedOrdinaryProcessOriginFacts, withHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { isHostedDependencyWorkspace, readHostedDependencyBinding, hostedDependencyBindingName, readHostedDependencyAttempt, assertHostedDependencyStartAllowed, assertHostedDependencyPhysicalWorkspace, type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { sameRootDescriptorStat as sameStat, readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
import { CurrentHostedDependencyOriginKind, type CurrentHostedDependencyOriginFacts } from "./hosted-current-dependency-origin";
import { formHostedOrdinarySelectedParentLineageFacts } from "../provider-codex/app-server/adapters/hosted-ordinary-selected-lineage-facts";
import { assertHostedDependencyParentRecipe, assertHostedDependencyParentEnvironment } from "../provider-codex/app-server/adapters/hosted-dependency-parent-recipe";
import { parseHostedReadonlyHostInventory } from "../worker-core/hosted-custody/domain/hosted-readonly-inventory";
import { selectHostedDependencyRootTaskArgumentFacts } from "./hosted-dependency-root-record-facts";
import { type HostedDependencyRootDirectoryPin } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import { assertHostedDependencyRootGitConfigBytes } from "../provider-codex/app-server/adapters/hosted-dependency-root-git-config";
const root = "/var/lib/subscription-runtime-host-policy";
const hash = (bytes:Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encode = (value:unknown) => Buffer.from(JSON.stringify(value)+"\n");
function invalid():never { throw new Error("hosted_dependency_current_origin_unresolved"); }
// Factual C/R read models and fixed config/executable recipes only. The shared reader stays lexical.
// No map, resource opener, descriptor association, issuance, callbacks or authority mutation is exported.
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
/** Fresh fixed factual C collection; the original map brackets this with its
 * actual descriptor inventory. The returned digest grants no purpose/resource. */
export function collectCurrentHostedOrdinaryDependencyOrigin(fence: HostedActivationFence) {
  const ordinary = collectHostedOrdinaryProcessOriginFacts(fence);
  const lineage = formHostedOrdinarySelectedParentLineageFacts(ordinary);
  const binding = readHostedDependencyBinding(lineage.jobId);
  const bindingPin = binding ? fixed(hostedDependencyBindingName(lineage.jobId),16384) : undefined;
  if (binding && (!bindingPin || !bindingPin.bytes.equals(encode(binding)) ||
      binding.installationId !== lineage.installationId || binding.runtimeSha !== lineage.runtimeSha ||
      binding.workspace.canonicalPath !== lineage.workspacePath || binding.jobRootDir !== lineage.jobRootDir ||
      binding.grantDigest !== lineage.grantSha256)) invalid();
  return {digest:hash(encode({lineage,binding:bindingPin?.reference ?? null})),
    facts:Object.freeze({kind:CurrentHostedDependencyOriginKind.Ordinary,ordinary})};
}
/** Actual signed parent selection only. C selects its exact creator identity;
 * R keeps its independently authenticated runtimeLaunch. No caller recipe. */
export function readCurrentHostedDependencySignedParentRecipe(facts:CurrentHostedDependencyOriginFacts) {
  const installation = facts.kind === CurrentHostedDependencyOriginKind.Ordinary ? facts.ordinary.installation : facts.installation;
  const bytes = fixed("readonly-inventory.json"), inventory = parseHostedReadonlyHostInventory(decodeHostedActivationBytes(bytes.bytes));
  if (hash(bytes.bytes) !== installation.inventorySha256) invalid();
  if (facts.kind === CurrentHostedDependencyOriginKind.ManagedReadonlyLocal) return inventory.runtimeLaunch;
  const start = facts.ordinary.start;
  const creators = inventory.ordinaryCreators.filter(row => row.creatorId === start.creatorId && row.jobId === start.jobId &&
    row.jobRootDir === start.jobRootDir && row.workspacePath === start.workspacePath);
  if (creators.length !== 1) invalid(); const launch = creators[0]!.launch;
  assertHostedDependencyParentRecipe(launch.args,String(start.jobRootDir),String(start.workspacePath));
  assertHostedDependencyParentEnvironment(process.env,String(start.jobRootDir)); return launch;
}
/** Routing facts only. */
export function isHostedManagedReadonlyOuterRuntime(): boolean {
  return process.platform === "linux" && /^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-outer-[a-f0-9-]{36}\.service$/.test(
    observedProcessCgroup(readFileSync("/proc/self/cgroup","utf8")));
}
/** Classification only: actual outer epoch determines whether omitted/foreign
 * request paths still require the protected dependency branch. */
export function isCurrentHostedDependencyManagedReadonlyOrigin(fence: HostedActivationFence): boolean {
  assertHostedActivationFence(fence); assertHostedActivationOperator();
  const group = observedProcessCgroup(readFileSync("/proc/self/cgroup","utf8"));
  if (!/^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-outer-[a-f0-9-]{36}\.service$/.test(group)) return false;
  const epoch = parseHostedCustodyEpoch(decodeHostedActivationBytes(fixed("readonly-epoch.json").bytes));
  return isHostedDependencyWorkspace(epoch.identity.workspacePath);
}
/** Routing only, before any caller workspace/context-based fallback. The
 * actual C/R unit selects its protected dependency branch; no origin is issued.
 * Inconsistent protected state throws, so omission cannot select legacy IO. */
export function requiresCurrentHostedDependencyRootPurpose(heldFence?: HostedActivationFence): boolean {
  if (heldFence !== undefined) assertHostedActivationFence(heldFence);
  if (process.platform !== "linux") return false;
  const group = readFileSync("/proc/self/cgroup","utf8");
  if (group.length > 4096) invalid();
  const current = observedProcessCgroup(group);
  const outer = /^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-outer-[a-f0-9-]{36}\.service$/.exec(current);
  const ordinary = /^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-ordinary-[a-f0-9-]{36}\.service$/.exec(current);
  if ((!outer || outer[0] !== current) && (!ordinary || ordinary[0] !== current)) return false;
  const classify = (fence: HostedActivationFence): boolean => {
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
  };
  return heldFence === undefined ? withHostedActivationFence(classify) : classify(heldFence);
}

export function readHostedDependencyAttemptFacts(facts: CurrentHostedDependencyOriginFacts, phase: DependencyOwnerPhase) {
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

export function rootIdentity(facts: CurrentHostedDependencyOriginFacts, binding: HostedDependencyBinding) {
  const launch=readCurrentHostedDependencySignedParentRecipe(facts);
  return selectHostedDependencyRootTaskArgumentFacts(launch.args,binding,
    facts.kind === CurrentHostedDependencyOriginKind.ManagedReadonlyLocal ? facts.start.readonlyJobId : binding.jobId,
    process.env.SUBSCRIPTION_RUNTIME_DURABLE_HANDOFF_ROOT);
}

function assertDirectory(pin:HostedDependencyRootDirectoryPin):void {
  const actual = readHostedDependencyRootDirectoryPin(pin.canonicalPath);
  if (actual.dev !== pin.dev || actual.ino !== pin.ino || actual.mountId !== pin.mountId) invalid();
}
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

export function currentSessionModelExecutable():DependencyProtectedReference {
  const path = process.env.PATH;
  if (path !== "/usr/bin:/bin" && path !== "/usr/local/bin:/usr/bin:/bin") invalid();
  for (const directory of path.split(":")) {
    try { return selectedFile(realpathSync(directory+"/codex"),64*1024*1024,false).reference; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return invalid();
}
