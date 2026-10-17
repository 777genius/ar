import { createReadonlyPrivateRecord, readonlySupervisorRoot } from "./hosted-readonly-custody";
import { createHash } from "node:crypto";
import { DependencyAdmissionError, DependencyAdmissionFailure, DependencyOwnerPhase,
  fenceDependencyConsumer, sameDependencyAttempt, isDependencyConsumerOwner, type HostedActivation, type HostedOrdinaryStart,
  type HostedOrdinaryReservation, type DependencyAttempt } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, readHostedActivationBytes, decodeHostedActivationBytes,
  type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { hostedDependencyOwnerRoot, readHostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { HostedReadonlyHostKernel } from "./hosted-readonly-host-kernel";
import { assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { DependencyGenerationContinuityKind } from "@vioxen/subscription-runtime/core";
import { releaseCurrentHostedDependencyCSourceOwner } from "./hosted-current-dependency-origin";

/** Called by the retained launch owner in the initial host supervisor, after
 * --wait. Fencing state denies future provider enqueues before ordered host
 * drain. No runner-finally, PID absence, TTL or untrusted completion evidence.
 */
export function releaseHostedDependencyConsumer(fence: HostedActivationFence,
  activation: HostedActivation, start: HostedOrdinaryStart, reservation: HostedOrdinaryReservation): boolean {
  assertHostedActivationFence(fence);
  const binding = readHostedDependencyBinding(start.jobId);
  if (!binding) return false;
  const kernel = new HostedReadonlyHostKernel(), session = kernel.operatorSession();
  const original = readHostedActivationBytes(`ordinary-starts/${reservation.startId}.json`);
  if (!original || !original.equals(Buffer.from(JSON.stringify(start) + "\n")) ||
      binding.installationId !== start.installationId || binding.workspace.canonicalPath !== start.workspacePath ||
      binding.grantDigest !== start.grantSha256 || activation.bootId !== start.bootId ||
      session.bootId !== activation.bootId || session.supervisorId !== activation.supervisorId ||
      JSON.stringify(activation.ordinaryStarts.find(r => r.startId === reservation.startId)) !== JSON.stringify(reservation)) invalid();
  let store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
  let attempt,active=false,alreadyReleased=false;
  try {
    const owner = store.read(binding.workspace);
    active=!!owner && owner.version!==1 && (owner.generationContinuity?.kind===DependencyGenerationContinuityKind.BaselineAuthenticatedV1 ||
      owner.generationContinuity?.kind===DependencyGenerationContinuityKind.RetiredReadyV1 &&
      !!readHostedActivationBytes(`dependency-generation-retired-intervals/${reservation.startId}.json`));
    if(!owner?.owner) {if(!active)return true;alreadyReleased=true;}
    else {
      if (!isDependencyConsumerOwner(owner.owner)) invalid();
      attempt = owner.owner.attempt;
      if (attempt.launch.startId !== reservation.startId || attempt.launch.installationId !== binding.installationId ||
          attempt.launch.bootId !== activation.bootId || attempt.launch.runtimeSha !== binding.runtimeSha ||
          attempt.launch.grantDigest !== binding.grantDigest) invalid();
      // Selected Active C was fenced by its actual retained FDA final result.
      // This release function cannot manufacture that association after loss.
      if(active && owner.owner.phase!==DependencyOwnerPhase.Fenced)invalid();
      fenceDependencyConsumer(store, binding.workspace, attempt);
    }
  } finally { store.close(); }
  if(alreadyReleased) {releaseCurrentHostedDependencyCSourceOwner(fence,reservation.startId);return true;}
  if(!attempt)invalid();
  createReadonlyPrivateRecord(`${readonlySupervisorRoot}/dependency-attempt-fences/${reservation.startId}.json`,
    Buffer.from(JSON.stringify({ version: 1, startId: reservation.startId, attemptId: attempt.attemptId, epoch: attempt.epoch }) + "\n"));
  const owned = dependencyOwnedReservations(activation, reservation, attempt);
  for (const row of owned) {
    const bytes = readHostedActivationBytes(`ordinary-starts/${row.startId}.json`);
    if (!bytes) invalid();
    kernel.fenceOrdinaryCreator(row, activation.bootId, createHash("sha256").update(bytes).digest("hex"), fence);
    kernel.drainOrdinaryQueue(row);
    kernel.confirmOrdinaryDescendants(row);
  }
  // Installer is a separate sibling unit. Ordinary cgroup emptiness does not
  // cover it; a retained mapping needs its own consumed/fence/queue/empty proof.
  assertHostedDependencyInstallerAttemptDrained(attempt);
  // The original fixed operation joins durable same-use revocation + native
  // final proof before publication and captures its own store predecessor.
  // No physical collector runs while this release store has open descriptors.
  if(active) {releaseCurrentHostedDependencyCSourceOwner(fence,reservation.startId);return true;}
  store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
  try {
    const current = store.read(binding.workspace);
    if (!current || !isDependencyConsumerOwner(current.owner) || current.owner.phase !== DependencyOwnerPhase.Fenced ||
        !sameDependencyAttempt(current.owner.attempt, attempt)) invalid();
    const previousActivity = current.activity;
    const activity = previousActivity && previousActivity.lastEntry?.epoch === attempt.epoch ? {
      lastEntry: previousActivity.lastEntry, lastRelease: { epoch: attempt.epoch, atMs: String(Date.now()) },
    } : undefined;
    store.compareAndSwap(binding.workspace, current.revision, { ...current, revision: current.revision + 1, owner: null,
      ...(activity === undefined ? {} : { activity }) });
  } finally { store.close(); }
  return true;
}

/** Protected parent correlation selects only this attempt's actual starts.
 * Stop requests use the same strict mapping as successful drain/release. */
export function dependencyOwnedReservations(activation: HostedActivation, reservation: HostedOrdinaryReservation,
  attempt?: DependencyAttempt): HostedOrdinaryReservation[] {
  const owned = [reservation];
  for (const row of activation.ordinaryStarts) {
    if (!row.unit.startsWith("subscription-runtime-hosted-")) continue;
    const bytes = readHostedActivationBytes(`dependency-provider-attempts/${row.startId}.json`);
    if (!bytes) {
      // Selected C final accounting cannot classify an unrecorded same-origin
      // later candidate as unrelated/never-issued. Generic behavior remains.
      const parent=readHostedActivationBytes(`ordinary-starts/${reservation.startId}.json`);
      if (!parent) invalid();const selected=decodeHostedActivationBytes(parent);
      if (!selected || typeof selected!=="object" || !("jobId" in selected) || typeof selected.jobId!=="string") invalid();
      if (readHostedDependencyBinding(selected.jobId)?.version===2 && row.creatorId===reservation.creatorId &&
          row.originSha256===reservation.originSha256 && row.generation>reservation.generation) invalid();
      continue;
    }
    const v = decodeHostedActivationBytes(bytes) as Record<string, unknown>;
    if (v.parentStartId !== reservation.startId) continue;
    const provider = readHostedActivationBytes(`ordinary-starts/${row.startId}.json`);
    if (Object.keys(v).sort().join(",") !== "attemptId,epoch,parentStartId,providerStartId,startDigest,unit,version" ||
        v.version !== 1 || (attempt && (v.attemptId !== attempt.attemptId || v.epoch !== attempt.epoch)) ||
        typeof v.attemptId !== "string" || !/^[a-f0-9-]{36}$/.test(v.attemptId) ||
        typeof v.epoch !== "number" || !Number.isSafeInteger(v.epoch) || v.epoch < 1 ||
        v.providerStartId !== row.startId || v.unit !== row.unit || !provider ||
        createHash("sha256").update(provider).digest("hex") !== v.startDigest) invalid();
    owned.push(row);
  }
  return owned;
}
function invalid(): never { throw new DependencyAdmissionError(DependencyAdmissionFailure.Unsupported); }
