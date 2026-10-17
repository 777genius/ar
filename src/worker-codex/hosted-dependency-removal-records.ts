import { DependencyGenerationContinuityKind, DependencyOwnerKind, DependencyOwnerPhase,
  isDependencyCustodyObject, isDependencyProtectedReference, parseDependencyOwner, sameDependencyProtectedReference,
  type DependencyOwnerRecord, type DependencyMaintenanceAttempt, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { DependencyReceiptState, DependencyReceiptParseStatus, parseDependencyReceipt,
  type DependencyReceipt } from "@vioxen/subscription-runtime/worker-core";
import { parseHostedDependencyBinding, type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { encodeReference as encode } from "./hosted-dependency-legacy-reference-records";

export enum HostedDependencyRemovalRecordKind { Claim = "removal_claim", Actor = "removal_actor", Lock = "removal_lock",
  SessionClosed = "removal_session_closed", Retirement = "removal_retirement", Idle = "removal_idle" }
export type HostedDependencyRemovalClaim = Readonly<{ version: 1; kind: HostedDependencyRemovalRecordKind.Claim;
  binding: HostedDependencyBinding; previous: DependencyOwnerRecord; claimed: DependencyOwnerRecord;
  originalIdle: DependencyProtectedReference; sourceClosed: DependencyProtectedReference;
  absent: Readonly<{ receipt: Extract<DependencyReceipt, { state: DependencyReceiptState.Absent }>; reference: DependencyProtectedReference }>;
  header: DependencyProtectedReference; previousClaim: DependencyProtectedReference | null; previousRetirement: DependencyProtectedReference | null }>;
export type HostedDependencyRemovalActorFacts = Readonly<{ pidBirth: string; unit: string; controlGroup: string; invocationId: string;
  bootId: string; supervisorId: string }>;
export type HostedDependencyRemovalActor = Readonly<{ version: 1; kind: HostedDependencyRemovalRecordKind.Actor;
  claim: DependencyProtectedReference; actor: HostedDependencyRemovalActorFacts;
  parent: HostedDependencyRemovalActorFacts; proxy: Readonly<{ pidBirth: string; controlGroup: string }>; bootstrap: DependencyProtectedReference }>;
export type HostedDependencyRemovalLock = Readonly<{ version: 2; kind: HostedDependencyRemovalRecordKind.Lock;
  evictionOperationId: string; absent: DependencyProtectedReference; header: DependencyProtectedReference;
  manifestDigest: string; firstAttempt: DependencyMaintenanceAttempt; actor: DependencyProtectedReference }>;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function held(): never { throw new Error("hosted_dependency_removal_record_unresolved"); }
function equal(a: unknown, b: unknown): boolean { return encode(a).equals(encode(b)); }
function reference(v: unknown): asserts v is DependencyProtectedReference { if (!isDependencyProtectedReference(v)) held(); }
export function hostedDependencyRemovalUnit(operationId: string): string {
  if (!uuid.test(operationId)) held(); return `subscription-runtime-dependency-remove-${operationId}.service`;
}
export function hostedDependencyRemovalAttempt(claim: HostedDependencyRemovalClaim): DependencyMaintenanceAttempt {
  if (claim.claimed.owner?.kind !== DependencyOwnerKind.Maintenance) held(); return claim.claimed.owner.attempt;
}
/** Closed factual parser. Authenticity comes from original physical custody,
 * protected pins and actual predecessor CAS; a valid DTO grants no effects. */
export function parseHostedDependencyRemovalClaim(v: unknown): HostedDependencyRemovalClaim {
  if (!isDependencyCustodyObject(v, "absent,binding,claimed,header,kind,originalIdle,previous,previousClaim,previousRetirement,sourceClosed,version") ||
      v.version !== 1 || v.kind !== HostedDependencyRemovalRecordKind.Claim || !isDependencyCustodyObject(v.absent, "receipt,reference")) held();
  const binding = parseHostedDependencyBinding(v.binding), previous = parseDependencyOwner(v.previous), claimed = parseDependencyOwner(v.claimed),
    parsed = parseDependencyReceipt(v.absent.receipt);
  if (binding.version === 1 || previous.version === 1 || claimed.version !== previous.version || previous.owner ||
      previous.generationContinuity?.kind !== DependencyGenerationContinuityKind.RetiredEvictingV1 ||
      !equal(previous.workspace, binding.workspace) || claimed.owner?.kind !== DependencyOwnerKind.Maintenance ||
      claimed.owner.phase !== DependencyOwnerPhase.ExclusiveMutation || parsed.status !== DependencyReceiptParseStatus.Valid ||
      parsed.receipt.state !== DependencyReceiptState.Absent) held();
  const absent = parsed.receipt, slot = previous.generationContinuity, attempt = claimed.owner.attempt;
  if (attempt.operationId === absent.operationId || slot.operationId !== absent.operationId || slot.generation !== absent.generation ||
      absent.revision !== slot.evictingRevision + 1 || !equal(absent.workspace, previous.workspace) ||
      attempt.epoch !== previous.epoch + 1 || !equal(claimed, parseDependencyOwner({ ...previous, revision: previous.revision + 1,
        epoch: attempt.epoch, owner: claimed.owner })) || attempt.host.installationId !== binding.installationId ||
      attempt.host.runtimeSha !== binding.runtimeSha || attempt.host.grantDigest !== binding.grantDigest) held();
  reference(v.absent.reference); reference(v.header); reference(v.originalIdle); reference(v.sourceClosed);
  if ((v.previousClaim === null) !== (v.previousRetirement === null)) held();
  if (v.previousClaim !== null) { reference(v.previousClaim); reference(v.previousRetirement); }
  if (v.previousRetirement !== null) reference(v.previousRetirement);
  return Object.freeze({ version: 1, kind: HostedDependencyRemovalRecordKind.Claim, binding, previous, claimed,
    originalIdle: v.originalIdle, sourceClosed: v.sourceClosed, absent: { receipt: absent, reference: v.absent.reference },
    header: v.header, previousClaim: v.previousClaim, previousRetirement: v.previousRetirement });
}
function actorFacts(v: unknown, remover: boolean): HostedDependencyRemovalActorFacts {
  if (!isDependencyCustodyObject(v, "bootId,controlGroup,invocationId,pidBirth,supervisorId,unit") ||
      typeof v.pidBirth !== "string" || !/^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/.test(v.pidBirth) ||
      typeof v.supervisorId !== "string" || !/^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/.test(v.supervisorId) ||
      typeof v.invocationId !== "string" || !/^[a-f0-9]{32}$/.test(v.invocationId) || typeof v.bootId !== "string" || !uuid.test(v.bootId) ||
      typeof v.unit !== "string" || !/^[A-Za-z0-9_@.-]+\.service$/.test(v.unit) ||
      typeof v.controlGroup !== "string" || !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(v.controlGroup)) held();
  if (remover && !/^subscription-runtime-dependency-remove-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.service$/.test(v.unit)) held();
  return { pidBirth: v.pidBirth, unit: v.unit, controlGroup: v.controlGroup, invocationId: v.invocationId,
    bootId: v.bootId, supervisorId: v.supervisorId };
}
export function parseHostedDependencyRemovalActor(v: unknown, claim: HostedDependencyRemovalClaim,
  claimReference: DependencyProtectedReference): HostedDependencyRemovalActor {
  if (!isDependencyCustodyObject(v, "actor,bootstrap,claim,kind,parent,proxy,version") || v.version !== 1 ||
      v.kind !== HostedDependencyRemovalRecordKind.Actor || !isDependencyCustodyObject(v.proxy, "controlGroup,pidBirth")) held();
  reference(v.claim); reference(v.bootstrap);
  const actor = actorFacts(v.actor, true), parent = actorFacts(v.parent, false), attempt = hostedDependencyRemovalAttempt(claim);
  if (!sameDependencyProtectedReference(v.claim, claimReference) || actor.unit !== hostedDependencyRemovalUnit(attempt.operationId) ||
      actor.controlGroup !== `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${actor.unit}` ||
      actor.bootId !== attempt.host.bootId || parent.bootId !== actor.bootId || actor.supervisorId !== attempt.host.supervisorId ||
      parent.supervisorId !== actor.supervisorId || typeof v.proxy.pidBirth !== "string" ||
      !/^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/.test(v.proxy.pidBirth) || v.proxy.controlGroup !== parent.controlGroup ||
      new Set([actor.pidBirth.split(":")[0], parent.pidBirth.split(":")[0], v.proxy.pidBirth.split(":")[0]]).size !== 3) held();
  return Object.freeze({ version: 1, kind: HostedDependencyRemovalRecordKind.Actor, claim: v.claim, actor, parent,
    proxy: { pidBirth: v.proxy.pidBirth, controlGroup: parent.controlGroup }, bootstrap: v.bootstrap });
}
/** V1, partial, extra fields and malformed locks are deliberately unrecognized.
 * This function never upgrades a record or infers stale actor discharge. */
export function parseHostedDependencyRemovalLock(v: unknown, claim: HostedDependencyRemovalClaim,
  actorReference: DependencyProtectedReference): HostedDependencyRemovalLock {
  if (!isDependencyCustodyObject(v, "absent,actor,evictionOperationId,firstAttempt,header,kind,manifestDigest,version") ||
      v.version !== 2 || v.kind !== HostedDependencyRemovalRecordKind.Lock || !equal(v.firstAttempt, hostedDependencyRemovalAttempt(claim))) held();
  reference(v.absent); reference(v.actor); reference(v.header);
  if (v.evictionOperationId !== claim.absent.receipt.operationId || v.manifestDigest !== claim.absent.receipt.evictionCommit.manifestDigest ||
      !sameDependencyProtectedReference(v.absent, claim.absent.reference) || !sameDependencyProtectedReference(v.header, claim.header) ||
      !sameDependencyProtectedReference(v.actor, actorReference)) held();
  return Object.freeze({ version: 2, kind: HostedDependencyRemovalRecordKind.Lock, evictionOperationId: claim.absent.receipt.operationId,
    absent: v.absent, actor: v.actor, header: v.header, manifestDigest: claim.absent.receipt.evictionCommit.manifestDigest,
    firstAttempt: hostedDependencyRemovalAttempt(claim) });
}
