import { DependencyAdmissionError, DependencyAdmissionFailure as Failure, DependencyOwnerKind, DependencyOwnerPhase,
  parseDependencyOwner, sameDependencyMaintenanceAttempt, type DependencyMaintenanceAttempt, type DependencyOwnerRecord } from "../domain/dependency-owner";
import type { DependencyWorkspaceIdentity } from "../domain/dependency-receipt";
import type { DependencyOwnerStore } from "../ports/dependency-owner-store";

/** Storage transitions only. The host adapter supplies actual authenticated
 * session and drain facts; this application cannot grant host authority. */
export function claimDependencyMaintenance(store: DependencyOwnerStore, workspace: DependencyWorkspaceIdentity,
  host: DependencyMaintenanceAttempt["host"], operationId: string): DependencyMaintenanceAttempt {
  const current = store.read(workspace);
  if (current?.owner) fail(Failure.Busy);
  const attempt = { operationId, epoch: (current?.epoch ?? 0) + 1, host };
  const next = parseDependencyOwner({ version: 2, workspace, revision: (current?.revision ?? 0) + 1,
    epoch: attempt.epoch, owner: { kind: DependencyOwnerKind.Maintenance, phase: DependencyOwnerPhase.ExclusiveMutation, attempt } });
  store.compareAndSwap(workspace, current?.revision ?? null, next);
  return attempt;
}
export function assertDependencyMaintenance(store: DependencyOwnerStore, workspace: DependencyWorkspaceIdentity,
  attempt: DependencyMaintenanceAttempt): DependencyOwnerRecord {
  const current = store.read(workspace);
  if (!current || current.version !== 2 || current.owner?.kind !== DependencyOwnerKind.Maintenance ||
      current.owner.phase !== DependencyOwnerPhase.ExclusiveMutation || !sameDependencyMaintenanceAttempt(current.owner.attempt, attempt)) fail(Failure.StaleAttempt);
  return current;
}
export function releaseDependencyMaintenance(store: DependencyOwnerStore, workspace: DependencyWorkspaceIdentity,
  attempt: DependencyMaintenanceAttempt): void {
  const current = assertDependencyMaintenance(store, workspace, attempt);
  store.compareAndSwap(workspace, current.revision, { ...current, revision: current.revision + 1, owner: null });
}
function fail(reason: Failure): never { throw new DependencyAdmissionError(reason); }
