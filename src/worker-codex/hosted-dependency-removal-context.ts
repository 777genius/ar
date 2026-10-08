import { createHash } from "node:crypto";
import { readFileSync, lstatSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DependencyOwnerKind, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { HostedReadonlyEpochStore } from "./hosted-readonly-epoch-store";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { readHostedReadonlyDependencyMaterial } from "./hosted-readonly-dependency-records";
import { HostedCustodyPhase } from "@vioxen/subscription-runtime/worker-core";
import { HostedActivationPhase } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, assertHostedActivationOperator, decodeHostedActivationBytes, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedFdBootstrap, assertHostedFdConfinement, observeHostedFdProcess, observeHostedFdUnit, readHostedFdProfile } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { assertHostedDependencyPhysicalWorkspace, assertHostedDependencyQualifiedInventory, readHostedDependencyBinding, hostedDependencyOwnerRoot } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { closeDependencySourceLinkSession, type DependencySourceLinkSession } from "../worker-local/dependency-environment/dependency-source-binding";
import { readDependencyTreeEffectReferenceAnchors, type DependencyTreeEffectReferenceSession } from "../worker-local/dependency-environment/dependency-tree-effects";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { readHostedInstallationActivation, readHostedOrdinaryBirth } from "./hosted-installation-origin-facts";
import { assertInspectedInstallation, assertActivationSession } from "./hosted-installation-physical-facts";
import { readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
import { collectProcessBirth, collectUnitInvocation, collectUnitShow } from "./hosted-readonly-linux-collector";
import { pinReferenceFile, encodeReference as encode } from "./hosted-dependency-legacy-reference-records";
import { hostedDependencyRemovalClaimPath, hostedDependencyRemovalOperations, readOriginalHostedDependencyRemovalRecoveryScope, assertOriginalHostedDependencyRemovalRecoveryLock } from "./hosted-dependency-removal-ownership";
import { parseHostedDependencyRemovalClaim, parseHostedDependencyRemovalActor, parseHostedDependencyRemovalLock,
  hostedDependencyRemovalAttempt, type HostedDependencyRemovalClaim, type HostedDependencyRemovalActor } from "./hosted-dependency-removal-records";
import { readHostedDependencyCommittedAbsent } from "./hosted-dependency-receipts";
import { assertHostedDependencyReadySourceHistory } from "./hosted-dependency-ready-source-links";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { hostedTestEgressGrantRoot } from "./hosted-test-egress-files";
import { assertHostedTestEgressIdentity, parseHostedTestEgressGrant } from "./hosted-test-egress-contract";
import { CodexProviderEgressProfileId } from "../provider-codex/codex-provider-egress-policy";
import { readOriginalHostedDependencyRemovalParentScope, assertOriginalHostedDependencyRemovalParentLock } from "./hosted-dependency-removal-parent";
import { readOriginalHostedDependencyRemovalHeader } from "./hosted-dependency-transactions";
import { readOriginalHostedDependencyRemovalFirstClaim } from "./hosted-dependency-removal-recovery";
import { systemdObservationBudget } from "../provider-codex/app-server/adapters/systemd-service-arrays";

// Only fixed original actor entry creates this context, after EOF release.
// No setter, registration, constructor input, allowlist or grant is exported.
type ClaimSelection = Readonly<{ claim: HostedDependencyRemovalClaim; reference: DependencyProtectedReference }>;
type ActorContext = { selected: ClaimSelection; actor: HostedDependencyRemovalActor; actorReference: DependencyProtectedReference;
  lockReference: DependencyProtectedReference; session?: DependencyTreeEffectReferenceSession; sourceLinks?: DependencySourceLinkSession };
let current: ActorContext | undefined;
const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const bootstrap = fileURLToPath(new URL("./hosted-dependency-remover-bootstrap.js", import.meta.url));
function held(): never { throw new Error("hosted_dependency_remover_context_held"); }
export function hostedDependencyRemovalRecordPath(operationId: string, suffix: "actor" | "consumed" | "revoked" | "session-closed" | "retirement" | "proxy-revoked" | "submitted"): string {
  const base = hostedDependencyRemovalClaimPath(operationId); return base.slice(0, -"claim.json".length) + suffix + ".json";
}
function selection(operationId: string): ClaimSelection {
  const pin = pinReferenceFile(hostedDependencyRemovalClaimPath(operationId), 65536), claim = parseHostedDependencyRemovalClaim(JSON.parse(pin.bytes.toString("utf8")));
  if (!pin.bytes.equals(encode(claim)) || hostedDependencyRemovalAttempt(claim).operationId !== operationId) held();
  return { claim, reference: pin.reference };
}
/** Current protected history is rejoined, not reconstructed from a DTO. */
export function readOriginalHostedDependencyRemovalClaim(operationId: string, access: symbol): ClaimSelection {
  assertOriginalHostedDependencyPhysicalRecordAccess(access); assertHostedActivationOperator(); return selection(operationId);
}
function consumed(state: ActorContext): void {
  const attempt = hostedDependencyRemovalAttempt(state.selected.claim), path = hostedDependencyRemovalRecordPath(attempt.operationId, "consumed"),
    expected = { version: 1, claim: state.selected.reference, actor: state.actorReference };
  if (!pinReferenceFile(path, 16384).bytes.equals(encode(expected)) || readHostedPrivateBytes(hostedDependencyRemovalRecordPath(attempt.operationId, "revoked"), 16384)) held();
}
function own(state: ActorContext, fence: HostedActivationFence, access: symbol, descriptors = true) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access); assertHostedActivationFence(fence); assertHostedActivationOperator();
  if (current !== state) held(); const claim = state.selected.claim, attempt = hostedDependencyRemovalAttempt(claim), selected = selection(attempt.operationId);
  if (!encode(selected).equals(encode(state.selected))) held(); consumed(state);
  if(!pinReferenceFile(hostedDependencyRemovalRecordPath(attempt.operationId,"submitted"),16384).bytes.equals(encode({version:1,claim:state.selected.reference,
    unit:state.actor.actor.unit,parentBirth:state.actor.parent.pidBirth,controlGroup:`0::${state.actor.parent.controlGroup}`,bootstrap:state.actor.bootstrap})))held();
  const profile = readHostedFdProfile(); if (!profile) held();
  const self = observeHostedFdProcess(process.pid), parent = observeHostedFdProcess(Number(state.actor.parent.pidBirth.split(":")[0])),
    proxy = observeHostedFdProcess(Number(state.actor.proxy.pidBirth.split(":")[0])), unit = observeHostedFdUnit(state.actor.actor.unit, [profile.node.path, bootstrap, attempt.operationId],systemdObservationBudget());
  if (self.birth !== state.actor.actor.pidBirth || self.group !== `0::${state.actor.actor.controlGroup}` || self.argv[2] !== attempt.operationId ||
      unit.mainPid !== process.pid || unit.invocation !== state.actor.actor.invocationId || unit.group !== state.actor.actor.controlGroup || unit.root !== "" ||
      parent.birth !== state.actor.parent.pidBirth || parent.group !== `0::${state.actor.parent.controlGroup}` ||
      proxy.birth !== state.actor.proxy.pidBirth || proxy.parentPid !== parent.pid || proxy.group !== `0::${state.actor.proxy.controlGroup}`) held();
  const actual = readHostedInstallationActivation(); assertInspectedInstallation(actual.installation);
  const inventory = readHostedReadonlyHostInventory(), supervisor = inventory.units.find(row => row.name === inventory.supervisorUnit);
  if (!supervisor || state.actor.parent.unit !== supervisor.name || state.actor.parent.controlGroup !== supervisor.controlGroup ||
      collectUnitInvocation(supervisor.name) !== state.actor.parent.invocationId) held();
  const shown = collectUnitShow(supervisor.name);
  if (shown.Id !== supervisor.name || shown.ControlGroup !== supervisor.controlGroup || shown.DropInPaths !== "" ||
      !shown.MainPID || collectProcessBirth(shown.MainPID) !== attempt.host.supervisorId) held();
  const session = { hostId: readFileSync("/etc/machine-id", "utf8").trim(), bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), supervisorId: attempt.host.supervisorId };
  assertActivationSession(actual.activation, session);
  if (attempt.host.installationId !== actual.installation.installationId || attempt.host.runtimeSha !== actual.installation.runtimeSha ||
      attempt.host.inventoryDigest !== actual.installation.inventorySha256 || attempt.host.bootId !== session.bootId) held();
  const binding = readHostedDependencyBinding(claim.binding.jobId); if (!binding || !encode(binding).equals(encode(claim.binding))) held();
  if (actual.activation.phase === HostedActivationPhase.Ordinary) {
    const origin = readHostedOrdinaryBirth(binding.jobId), grantBytes = readHostedPrivateBytes(`${hostedTestEgressGrantRoot}/${hash(binding.jobId)}.json`, 4096);
    if (!grantBytes || hash(grantBytes) !== binding.grantDigest || origin.birth.workspacePath !== binding.workspace.canonicalPath || origin.birth.jobRootDir !== binding.jobRootDir) held();
    const grant = parseHostedTestEgressGrant(decodeHostedActivationBytes(grantBytes)); assertHostedTestEgressIdentity(grant, origin.birth);
    if (grant.profileId !== CodexProviderEgressProfileId.TestNpmQualification) held();
  } else {
    if(actual.activation.phase!==HostedActivationPhase.Exclusive)held();const epoch=new HostedReadonlyEpochStore().readEpoch();
    if(epoch.phase!==HostedCustodyPhase.Closed || epoch.revoked || epoch.outerRuntime || epoch.reservations.length ||
      epoch.bootId!==session.bootId || epoch.supervisorId!==session.supervisorId)held();
    new HostedReadonlySupervisorHost().verifyReadonlyMaterial(epoch.identity);
    const material=readHostedReadonlyDependencyMaterial(fence,epoch.identity);
    if(material.evidence.candidate.jobId!==binding.jobId || !encode(material.evidence.workspace).equals(encode(binding.workspace)) ||
      !encode(new HostedReadonlyEpochStore().readEpoch()).equals(encode(epoch)))held();
  }
  assertHostedDependencyQualifiedInventory(); assertHostedDependencyPhysicalWorkspace(binding);
  const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
  try { if (!encode(store.read(binding.workspace)).equals(encode(claim.claimed))) held(); } finally { store.close(); }
  const committed = readHostedDependencyCommittedAbsent(binding, claim.absent.receipt.revision);
  if (!encode(committed).equals(encode(claim.absent)) || !encode(pinReferenceFile(claim.header.path, 32768).reference).equals(encode(claim.header)) ||
      !encode(pinReferenceFile(state.actorReference.path, 65536).reference).equals(encode(state.actorReference))) held();
  const first = claim.previousClaim === null ? selected : readOriginalHostedDependencyRemovalFirstClaim(fence,selected,access), actorPin = pinReferenceFile(hostedDependencyRemovalRecordPath(hostedDependencyRemovalAttempt(first.claim).operationId, "actor"), 65536),
    firstActor = parseHostedDependencyRemovalActor(JSON.parse(actorPin.bytes.toString("utf8")), first.claim, first.reference),
    lock = pinReferenceFile(`${hostedDependencyRemovalOperations}/${claim.absent.receipt.operationId}.remove.lock`, 65536);
  parseHostedDependencyRemovalLock(JSON.parse(lock.bytes.toString("utf8")), first.claim, actorPin.reference);
  if (!encode(lock.reference).equals(encode(state.lockReference)) || !firstActor.actor.invocationId) held();
  for(const reference of [claim.originalIdle,claim.sourceClosed])if(!encode(pinReferenceFile(reference.path,65536).reference).equals(encode(reference)))held();
  const header = readOriginalHostedDependencyRemovalHeader(claim.absent.receipt,access); assertHostedDependencyReadySourceHistory(header.ready);
  if (descriptors) {
    const anchors = state.session ? readDependencyTreeEffectReferenceAnchors(state.session, { workspace: binding.workspace,
      trashPath: claim.absent.receipt.evictionCommit.trash.destinationParent.canonicalPath + "/" + claim.absent.receipt.evictionCommit.trash.destinationName,
      operationId: claim.absent.receipt.operationId }) : [];
    for (const fd of self.descriptors.filter(v => v.file || v.directory)) {
      if (!fd.directory || !anchors.some(anchor => anchor.fd === fd.fd && anchor.dev === fd.dev && anchor.ino === fd.ino && Number.parseInt(anchor.flags, 8) === fd.flags)) held();
    }
    assertHostedFdBootstrap({ ...self, descriptors: self.descriptors.filter(fd => !anchors.some(anchor => anchor.fd === fd.fd)) }, profile);
    assertHostedFdConfinement(self, [profile.node.path, bootstrap, attempt.operationId], "");
  }
  if (collectProcessBirth(String(parent.pid)) !== parent.birth || collectProcessBirth(String(proxy.pid)) !== proxy.birth) held();
  assertHostedActivationFence(fence); return { ...actual, binding, session };
}
/** Only SAME original association can widen the own unit census or FD branch. */
export function readOriginalHostedDependencyRemoverScope(fence: HostedActivationFence, access: symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access); if (!current) return readOriginalHostedDependencyRemovalParentScope(fence,access) ?? readOriginalHostedDependencyRemovalRecoveryScope(fence,access);
  const actual = own(current, fence, access); return { units: Object.freeze([current.actor.actor.unit]), operator: actual.session };
}
export function readOriginalHostedDependencyRemoverAuthority(fence: HostedActivationFence, jobId: string, access: symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access); if (!current) return undefined;
  const actual = own(current, fence, access, false); if (actual.binding.jobId !== jobId) held(); return actual;
}
export function assertOriginalHostedDependencyRemoverLock(path: string, fence: HostedActivationFence, access: symbol): boolean {
  assertOriginalHostedDependencyPhysicalRecordAccess(access); if (!current) return assertOriginalHostedDependencyRemovalParentLock(path,fence,access) || assertOriginalHostedDependencyRemovalRecoveryLock(path,fence,access);
  own(current, fence, access, false); return path === current.lockReference.path;
}
/** Dedicated fixed actor entry, comparison UUID only. Genuine EOF has already
 * closed stdin. Protected parent-issued actor birth/Invocation, immutable claim
 * and own actual self observations determine admission; requests carry no grant. */
export async function runOriginalHostedDependencyRemoverActor(operationId: string, access: symbol): Promise<void> {
  assertOriginalHostedDependencyPhysicalRecordAccess(access); if (current) held();
  const selected = selection(operationId), actorPin = pinReferenceFile(hostedDependencyRemovalRecordPath(operationId, "actor"), 65536),
    actor = parseHostedDependencyRemovalActor(JSON.parse(actorPin.bytes.toString("utf8")), selected.claim, selected.reference),
    lockReference = pinReferenceFile(`${hostedDependencyRemovalOperations}/${selected.claim.absent.receipt.operationId}.remove.lock`, 65536).reference;
  if (actor.actor.pidBirth !== collectProcessBirth(String(process.pid))) held();
  const state: ActorContext = { selected, actor, actorReference: actorPin.reference, lockReference }; current = state;
  try {
    const { runOriginalHostedDependencyRemovalEffects } = await import("./hosted-dependency-removal-effects");
    await runOriginalHostedDependencyRemovalEffects(access);
  } finally { if (state.sourceLinks) closeDependencySourceLinkSession(state.sourceLinks); current = undefined; }
}
// SAME-access fixed effect implementation owns session fields on this genuine
// association. This reader cannot create a context or register a foreign actor.
export function readOriginalHostedDependencyRemoverEffectState(access: symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access); if (!current) held(); return current;
}
