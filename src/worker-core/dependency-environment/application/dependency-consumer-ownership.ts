import { DependencyAdmissionError, DependencyAdmissionFailure as Failure, DependencyOwnerPhase, DependencyOwnerKind, isDependencyConsumerOwner,
  parseDependencyOwner, sameDependencyAttempt, isDependencyCustodyLaunch, type DependencyAttempt, type DependencyLaunchBinding,
  type DependencyOwnerRecord } from "../domain/dependency-owner";
import { sameDependencyWorkspace, type DependencyWorkspaceIdentity } from "../domain/dependency-receipt";
import type { DependencyOwnerStore } from "../ports/dependency-owner-store";

/** Synchronous state transitions compose under the existing trusted host fence.
 * Caller must authenticate actual launch/grant and revoke future capabilities.
 * There is deliberately no release/PID/TTL API until the host drain composition.
 */
export function claimDependencyConsumer(store: DependencyOwnerStore, workspace: DependencyWorkspaceIdentity,
  launch: DependencyLaunchBinding, attemptId: string): DependencyAttempt {
  const current = store.read(workspace);
  if (current && !sameDependencyWorkspace(current.workspace, workspace)) fail(Failure.WorkspaceChanged);
  if (current?.owner) fail(Failure.Busy);
  const epoch = (current?.epoch ?? 0) + 1;
  const attempt = { attemptId, epoch, launch };
  // A custody launch cannot create/migrate its own authority. Only the actual
  // stored idle v3 pointer selected by trusted B/D composition can enter.
  if (isDependencyCustodyLaunch(launch) !== (current?.version === 3)) fail(Failure.Unsupported);
  const next = parseDependencyOwner({ ...(current?.version === 3 ? current : { version: 2 }), workspace, revision: (current?.revision ?? 0) + 1,
    epoch, owner: { kind: DependencyOwnerKind.Consumer, phase: DependencyOwnerPhase.ExclusiveMutation, attempt },
    ...(current?.activity === undefined ? {} : { activity: current.activity }) });
  store.compareAndSwap(workspace, current?.revision ?? null, next);
  return attempt;
}

export function assertDependencyConsumer(store: DependencyOwnerStore, workspace: DependencyWorkspaceIdentity,
  attempt: DependencyAttempt, expectedPhase: DependencyOwnerPhase): DependencyOwnerRecord {
  const current = store.read(workspace);
  if (!current || (current.version !== 2 && current.version !== 3) || !sameDependencyWorkspace(current.workspace, workspace) || !isDependencyConsumerOwner(current.owner) ||
      current.owner.phase !== expectedPhase || !sameDependencyAttempt(current.owner.attempt, attempt)) fail(Failure.StaleAttempt);
  return current;
}

export function markDependencyConsumerRunning(store: DependencyOwnerStore, workspace: DependencyWorkspaceIdentity,
  attempt: DependencyAttempt, observedAtMs: string | null = null): void {
  const current = assertDependencyConsumer(store, workspace, attempt, DependencyOwnerPhase.ExclusiveMutation);
  store.compareAndSwap(workspace, current.revision, { ...current, revision: current.revision + 1,
    activity: { lastEntry: { epoch: attempt.epoch, atMs: observedAtMs }, lastRelease: current.activity?.lastRelease ?? null },
    owner: { kind: DependencyOwnerKind.Consumer, phase: DependencyOwnerPhase.Running, attempt } });
}

export function fenceDependencyConsumer(store: DependencyOwnerStore, workspace: DependencyWorkspaceIdentity,
  attempt: DependencyAttempt): void {
  const current = store.read(workspace);
  if (!current || !sameDependencyWorkspace(current.workspace, workspace) || !isDependencyConsumerOwner(current.owner) ||
      !sameDependencyAttempt(current.owner.attempt, attempt)) fail(Failure.StaleAttempt);
  if (current.owner.phase === DependencyOwnerPhase.Fenced) return;
  store.compareAndSwap(workspace, current.revision, { ...current, revision: current.revision + 1,
    owner: { ...(current.version !== 1 ? { kind: DependencyOwnerKind.Consumer } : {}), phase: DependencyOwnerPhase.Fenced, attempt } });
}
function fail(reason: Failure): never { throw new DependencyAdmissionError(reason); }

/** Consume the actual producer's existing exclusive claim, never claim again.
 * Trusted adapter authenticates immutable producer reference and one-shot entry. */
export function assertDependencyPreclaimedConsumer(store: DependencyOwnerStore, workspace: DependencyWorkspaceIdentity,
  actualLaunch: DependencyLaunchBinding, retainedAttempt: DependencyAttempt): DependencyAttempt {
  if (!sameDependencyAttempt(retainedAttempt,{...retainedAttempt,launch:actualLaunch})) fail(Failure.StaleAttempt);
  const current = assertDependencyConsumer(store,workspace,retainedAttempt,DependencyOwnerPhase.ExclusiveMutation);
  if (!isDependencyConsumerOwner(current.owner)) fail(Failure.StaleAttempt); return current.owner.attempt;
}
