import { unlinkOriginalHostedDependencyRemovalLock } from "./hosted-dependency-removal-lock-release";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DependencyOwnerKind, DependencyOwnerPhase, parseDependencyOwner, isDependencyCustodyObject, sameDependencyProtectedReference, type DependencyProtectedReference, type DependencyOwnerRecord } from "@vioxen/subscription-runtime/core";
import { withHostedActivationFence, assertHostedActivationFence, isHostedActivationFenceBusy, assertHostedActivationProcessDescriptors, withHostedRemovalRetirementFence, withHostedRemovalRetirementReconciliation, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { assertHostedFdProcess, HostedFdLaunchKind } from "../provider-codex/app-server/adapters/hosted-fd-child";
import { spawnHostedFdChild, hostedFdLaunch, assertHostedRemoverCloseResultForChild, type HostedRemoverCloseResult } from "../provider-codex/app-server/adapters/hosted-fd-launch";
import { observeHostedFdProcess, observeHostedFdUnit, readHostedFdProfile } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { hostedDependencyOwnerRoot } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { claimOriginalHostedDependencyTrashRemoval, tryReleaseOriginalHostedDependencyCompletedRemoval, publishOriginalHostedDependencyRemovalOwner, assertOriginalHostedCompletedRemovalWitness, assertOriginalHostedCompletedRemovalArchive, acknowledgeOriginalHostedCompletedRemovalArchive, hostedDependencyRemovalOperations } from "./hosted-dependency-removal-ownership";
import { hostedDependencyRemovalRecordPath, readOriginalHostedDependencyRemovalClaim } from "./hosted-dependency-removal-context";
import { hostedDependencyRemovalAttempt, hostedDependencyRemovalUnit, parseHostedDependencyRemovalActor, parseHostedDependencyRemovalLock, HostedDependencyRemovalRecordKind as Kind, type HostedDependencyRemovalActor } from "./hosted-dependency-removal-records";
import { encodeReference as encode, pinReferenceFile, writeReferenceOnce } from "./hosted-dependency-legacy-reference-records";
import { HostedReadonlyHostKernel, readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
import { collectUnitInvocation } from "./hosted-readonly-linux-collector";
import { readHostedInstallationActivation } from "./hosted-installation-origin-facts";
import { readHostedDependencyEvictionEnabled } from "./hosted-dependency-eviction-enabled-policy";
import { hostedFdCustodySystemdLaunch, TrustedCustodyLaunchRole } from "./trusted-custody-systemd-launch";
import { observeHostedDependencyRemoverRetirement } from "./hosted-dependency-remover-retirement";
import { matchesManagedProviderProxyWait } from "./hosted-managed-provider-terminal-facts";
import { HostedDependencyRemovalDisposition } from "./hosted-dependency-removal-effects";
import { HostedDependencyTransactionOutcome } from "./hosted-dependency-transactions";
import { readOriginalHostedDependencyOperatorNativeCensus } from "./hosted-dependency-generation-native-census";
import { readOriginalHostedDependencyRemovalFirstClaim } from "./hosted-dependency-removal-recovery";
import { systemdObservationBudget } from "../provider-codex/app-server/adapters/systemd-service-arrays";

type Selection = ReturnType<typeof claimOriginalHostedDependencyTrashRemoval>;
type ParentContext = { selected: Selection; owner: DependencyOwnerRecord; child: ChildProcessWithoutNullStreams;
  actor?: HostedDependencyRemovalActor; actorReference?: DependencyProtectedReference; lockReference?: DependencyProtectedReference;
  closed?: HostedRemoverCloseResult };
let current: ParentContext | undefined;
const bootstrap = fileURLToPath(new URL("./hosted-dependency-remover-bootstrap.js", import.meta.url));
function held(): never { throw new Error("hosted_dependency_removal_parent_held"); }
function owner(selection: Selection): DependencyOwnerRecord {
  const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
  try { const owner = store.read(selection.claim.binding.workspace); if (!owner) held(); return owner; } finally { store.close(); }
}
function guard(state: ParentContext, fence: HostedActivationFence, access: symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access); assertHostedActivationFence(fence); assertHostedActivationProcessDescriptors(fence);
  if (current !== state || !encode(owner(state.selected)).equals(encode(state.owner))) held();
  const attempt = hostedDependencyRemovalAttempt(state.selected.claim), session = new HostedReadonlyHostKernel().operatorSession(), actual = readHostedInstallationActivation();
  if (session.bootId !== attempt.host.bootId || session.supervisorId !== attempt.host.supervisorId || actual.installation.installationId !== attempt.host.installationId ||
      actual.installation.runtimeSha !== attempt.host.runtimeSha || actual.installation.inventorySha256 !== attempt.host.inventoryDigest ||
      !encode(readOriginalHostedDependencyRemovalClaim(attempt.operationId, access).reference).equals(encode(state.selected.reference))) held();
  if (state.actor) {
    const parent = observeHostedFdProcess(process.pid);
    if (parent.birth !== state.actor.parent.pidBirth || parent.group !== `0::${state.actor.parent.controlGroup}` ||
        collectUnitInvocation(state.actor.parent.unit) !== state.actor.parent.invocationId || !state.actorReference ||
        !sameDependencyProtectedReference(pinReferenceFile(state.actorReference.path, 65536).reference, state.actorReference)) held();
  }
  return session;
}
/** Factual allowance from this exact original physical child only. No caller
 * unit/actor registration can reach it. Closed branch requires genuine FDA close
 * plus exact Invocation terminal/recursive empty facts, never PID absence. */
export function readOriginalHostedDependencyRemovalParentScope(fence: HostedActivationFence, access: symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access); if (!current?.actor) return undefined;
  const state = current, actor = state.actor!, operator = guard(state, fence, access);
  if (state.closed) {
    assertHostedRemoverCloseResultForChild(state.closed, state.child);
    observeHostedDependencyRemoverRetirement(actor.actor.unit, actor.actor.invocationId, 10000);
  } else {
    assertHostedFdProcess(state.child, actor.actor.unit, HostedFdLaunchKind.Remover);
    const profile = readHostedFdProfile(); if (!profile) held();
    const actual = observeHostedFdProcess(Number(actor.actor.pidBirth.split(":")[0])), unit = observeHostedFdUnit(actor.actor.unit, [profile.node.path, bootstrap, hostedDependencyRemovalAttempt(state.selected.claim).operationId],systemdObservationBudget());
    if (actual.birth !== actor.actor.pidBirth || actual.group !== `0::${actor.actor.controlGroup}` || unit.invocation !== actor.actor.invocationId || unit.mainPid !== actual.pid) held();
  }
  return { units: Object.freeze([actor.actor.unit]), operator };
}
export function assertOriginalHostedDependencyRemovalParentLock(path: string, fence: HostedActivationFence, access: symbol): boolean {
  assertOriginalHostedDependencyPhysicalRecordAccess(access); if (!current?.actor || !current.lockReference || !current.actorReference) return false;
  guard(current, fence, access); const pin = pinReferenceFile(current.lockReference.path, 65536);
  if (!sameDependencyProtectedReference(pin.reference, current.lockReference)) held();
  const first=readOriginalHostedDependencyRemovalFirstClaim(fence,current.selected,access),actor=pinReferenceFile(hostedDependencyRemovalRecordPath(hostedDependencyRemovalAttempt(first.claim).operationId,"actor"),65536);
  parseHostedDependencyRemovalLock(JSON.parse(pin.bytes.toString("utf8")), first.claim, actor.reference);
  return path === current.lockReference.path;
}
/** Fixed installed source reference; profile already independently pins bytes.
 * Public source mode is distinct from protected private record mode0600. */
function bootstrapReference(): DependencyProtectedReference {
  const profile = readHostedFdProfile(), file = profile?.bootstraps.find(pin => pin.path === bootstrap); if (!file) held();
  const fd = openSync(bootstrap, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true }), named = lstatSync(bootstrap, { bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || before.mode & 0o022n || before.dev !== named.dev || before.ino !== named.ino) held();
    if(before.size<1n || before.size>65536n)held();const bytes=readFileSync(fd),after=fstatSync(fd,{bigint:true}),final=lstatSync(bootstrap,{bigint:true});
    if(bytes.length!==Number(before.size) || createHash("sha256").update(bytes).digest("hex")!==file.sha256 || before.ctimeNs!==after.ctimeNs || before.mtimeNs!==after.mtimeNs ||
      before.size!==after.size || final.dev!==before.dev || final.ino!==before.ino || final.ctimeNs!==before.ctimeNs || final.mtimeNs!==before.mtimeNs || final.nlink!==1n)held();
    return { path: bootstrap, identity: { dev: String(before.dev), ino: String(before.ino) }, sha256: file.sha256 };
  } finally { closeSync(fd); }
}
enum RemovalAction { Remove = "remove", Recover = "recover" }
export function runOriginalHostedDependencyTrashRemovalParent(jobId:string,revision:number,access:symbol) {return run(jobId,revision,access,RemovalAction.Remove);}
export function recoverOriginalHostedDependencyTrashRemovalParent(jobId:string,revision:number,access:symbol) {return run(jobId,revision,access,RemovalAction.Recover);}
async function run(jobId: string, revision: number, access: symbol, action:RemovalAction) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access); if (current) held();
  if (!readHostedDependencyEvictionEnabled()) return { outcome: HostedDependencyTransactionOutcome.Skipped };
  let completed:ReturnType<typeof tryReleaseOriginalHostedDependencyCompletedRemoval>;
  try {completed=withHostedActivationFence(fence=>{
    const result=tryReleaseOriginalHostedDependencyCompletedRemoval(fence,jobId,revision,access);
    if(result && action===RemovalAction.Recover)acknowledgeOriginalHostedCompletedRemovalArchive(fence,jobId,revision,access);
    return result;
  });}
  catch(error) {
    if(action!==RemovalAction.Recover || !isHostedActivationFenceBusy(error))throw error;
    // Explicit completion reconciliation only: never mint a fresh remover claim.
    return withHostedRemovalRetirementReconciliation((fence,witness)=>{
      assertOriginalHostedCompletedRemovalWitness(fence,witness,jobId,revision,access);
      const result=tryReleaseOriginalHostedDependencyCompletedRemoval(fence,jobId,revision,access);if(!result)held();return result;
    },(fence,witness)=>assertOriginalHostedCompletedRemovalArchive(fence,witness,jobId,revision,access));
  }
  if(completed)return completed;
  const selected = withHostedActivationFence(fence => claimOriginalHostedDependencyTrashRemoval(fence, jobId, revision, access,action===RemovalAction.Recover)),
    attempt = hostedDependencyRemovalAttempt(selected.claim), unit = hostedDependencyRemovalUnit(attempt.operationId);
  withHostedActivationFence(fence=>{
    assertHostedActivationFence(fence);assertHostedProcessDescriptors();const parent=observeHostedFdProcess(process.pid),session=new HostedReadonlyHostKernel().operatorSession(),submitted=hostedDependencyRemovalRecordPath(attempt.operationId,"submitted");
    try{lstatSync(submitted);held();}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(session.bootId!==attempt.host.bootId || session.supervisorId!==attempt.host.supervisorId || !encode(owner(selected)).equals(encode(selected.claim.claimed)))held();
    writeReferenceOnce(submitted,{version:1,claim:selected.reference,unit,parentBirth:parent.birth,controlGroup:parent.group,bootstrap:bootstrapReference()});
  });
  const invocation = hostedFdCustodySystemdLaunch(TrustedCustodyLaunchRole.Remover, attempt.operationId, "/"),
    child = spawnHostedFdChild(invocation.command, invocation.args, { cwd: "/", detached: false }, unit, HostedFdLaunchKind.Remover),
    state: ParentContext = { selected, owner: selected.claim.claimed, child };
  current = state; let released = false;
  const closed = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
  child.stdout.resume(); child.stderr.resume();
  try {
    const launch = hostedFdLaunch(child); await launch.observe();
    withHostedActivationFence(fence => {
      const session = guard(state, fence, access), observed = launch.removerActorObservation(), parent = observeHostedFdProcess(process.pid),
        inventory = readHostedReadonlyHostInventory(), supervisor = inventory.units.find(row => row.name === inventory.supervisorUnit);
      if (!supervisor || parent.group !== `0::${supervisor.controlGroup}` || observed.proxy.parentPid !== process.pid || observed.proxy.group !== parent.group) held();
      const actor = parseHostedDependencyRemovalActor({ version: 1, kind: Kind.Actor, claim: selected.reference,
        actor: { pidBirth: observed.actor.birth, unit, controlGroup: observed.unit.group, invocationId: observed.unit.invocation, bootId: session.bootId, supervisorId: session.supervisorId },
        parent: { pidBirth: parent.birth, unit: supervisor.name, controlGroup: supervisor.controlGroup, invocationId: collectUnitInvocation(supervisor.name), bootId: session.bootId, supervisorId: session.supervisorId },
        proxy: { pidBirth: observed.proxy.birth, controlGroup: supervisor.controlGroup }, bootstrap: bootstrapReference() }, selected.claim, selected.reference);
      state.actor = actor; state.actorReference = writeReferenceOnce(hostedDependencyRemovalRecordPath(attempt.operationId, "actor"), actor);
      const lockPath = `${hostedDependencyRemovalOperations}/${selected.claim.absent.receipt.operationId}.remove.lock`;
      if(selected.claim.previousClaim) {
        const first=readOriginalHostedDependencyRemovalFirstClaim(fence,selected,access),firstActor=pinReferenceFile(hostedDependencyRemovalRecordPath(hostedDependencyRemovalAttempt(first.claim).operationId,"actor"),65536),pin=pinReferenceFile(lockPath,65536);
        parseHostedDependencyRemovalLock(JSON.parse(pin.bytes.toString("utf8")),first.claim,firstActor.reference);state.lockReference=pin.reference;
      } else {
        const lock = parseHostedDependencyRemovalLock({ version: 2, kind: Kind.Lock, evictionOperationId: selected.claim.absent.receipt.operationId,
          absent: selected.claim.absent.reference, header: selected.claim.header, manifestDigest: selected.claim.absent.receipt.evictionCommit.manifestDigest,
          firstAttempt: attempt, actor: state.actorReference }, selected.claim, state.actorReference);
        try { lstatSync(lockPath); held(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        state.lockReference = writeReferenceOnce(lockPath, lock);
      }
      writeReferenceOnce(hostedDependencyRemovalRecordPath(attempt.operationId, "consumed"), { version: 1, claim: selected.reference, actor: state.actorReference });
      launch.release(fence, "subscription-runtime-remover-fd-release-v1\n", true, () => { guard(state, fence, access); if(!readHostedDependencyEvictionEnabled())held(); }); released = true;
    });
    await closed; state.closed = launch.removerCloseResult(); assertHostedRemoverCloseResultForChild(state.closed, child);
    return withHostedRemovalRetirementFence(fence=>{
      guard(state,fence,access);assertHostedRemoverCloseResultForChild(state.closed!,state.child);
      if(!state.actorReference || !state.lockReference)held();
      return {claim:state.selected.reference,actor:state.actorReference,lock:state.lockReference,
        completion:pinReferenceFile(hostedDependencyRemovalRecordPath(attempt.operationId,"session-closed"),16384).reference};
    },fence=>retireAndRelease(state,fence,access),
      (fence,witness)=>assertOriginalHostedCompletedRemovalArchive(fence,witness,jobId,revision,access));
  } finally {
    if (!released) { hostedFdLaunch(child).invalidate(); child.kill("SIGTERM"); }
    current = undefined;
  }
}
function retireAndRelease(state: ParentContext, fence: HostedActivationFence, access: symbol) {
  guard(state, fence, access); if (!state.actor || !state.actorReference || !state.lockReference || !state.closed) held();
  assertHostedRemoverCloseResultForChild(state.closed, state.child);
  const attempt = hostedDependencyRemovalAttempt(state.selected.claim), actor = state.actor;
  writeReferenceOnce(hostedDependencyRemovalRecordPath(attempt.operationId, "revoked"), { version: 1, claim: state.selected.reference, actor: state.actorReference });
  const native = observeHostedDependencyRemoverRetirement(actor.actor.unit, actor.actor.invocationId, 10000);
  if (state.closed.invocationId !== actor.actor.invocationId || state.closed.actorBirth !== actor.actor.pidBirth || state.closed.proxyBirth !== actor.proxy.pidBirth ||
      state.closed.signal === null && (state.closed.exitCode === null || !matchesManagedProviderProxyWait(native.terminal, actor.actor.invocationId, state.closed.exitCode))) held();
  const retirement = writeReferenceOnce(hostedDependencyRemovalRecordPath(attempt.operationId, "retirement"), { version: 1, kind: Kind.Retirement,
    claim: state.selected.reference, actor: state.actorReference, lock: state.lockReference,
    consumed: pinReferenceFile(hostedDependencyRemovalRecordPath(attempt.operationId, "consumed"), 16384).reference,
    revoked: pinReferenceFile(hostedDependencyRemovalRecordPath(attempt.operationId, "revoked"), 16384).reference, parentClosed: state.closed, proxyRevoked:null, native });
  const completion = pinReferenceFile(hostedDependencyRemovalRecordPath(attempt.operationId, "session-closed"), 16384), value: unknown = JSON.parse(completion.bytes.toString("utf8"));
  if (!isDependencyCustodyObject(value, "actor,claim,disposition,kind,removedEntries,version") || value.version !== 1 || value.kind !== Kind.SessionClosed ||
      !encode(value.actor).equals(encode(state.actorReference)) || !encode(value.claim).equals(encode(state.selected.reference)) ||
      !(value.disposition === HostedDependencyRemovalDisposition.Removed && Number.isSafeInteger(value.removedEntries) && typeof value.removedEntries === "number" && value.removedEntries > 0 ||
        value.disposition === HostedDependencyRemovalDisposition.RecoveredAbsent && value.removedEntries === null)) held();
  guard(state, fence, access);if(!readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();
  const previous = state.owner; if (previous.owner?.kind !== DependencyOwnerKind.Maintenance) held();
  const fenced = parseDependencyOwner({ ...previous, revision: previous.revision + 1, owner: { ...previous.owner, phase: DependencyOwnerPhase.Fenced } });
  publishOriginalHostedDependencyRemovalOwner(fence, previous, fenced, access); state.owner = fenced;
  guard(state, fence, access);
  const next = parseDependencyOwner({ ...fenced, revision: fenced.revision + 1, owner: null });
  writeReferenceOnce(`${hostedDependencyRemovalOperations}/${next.workspace.dev}-${next.workspace.ino}-${next.revision}.removal-idle.json`,
    { version: 1, kind: Kind.Idle, claim: state.selected.reference, retirement, completion: completion.reference, fenced, released: next });
  guard(state,fence,access);unlinkOriginalHostedDependencyRemovalLock(fence,state.lockReference,access);
  publishOriginalHostedDependencyRemovalOwner(fence, fenced, next, access); state.owner = next; guard(state, fence, access);
  return { outcome: HostedDependencyTransactionOutcome.TrashRemoved, operationId: state.selected.claim.absent.receipt.operationId, removedEntries: value.removedEntries };
}
