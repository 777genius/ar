import { DependencyGenerationContinuityKind, parseDependencyGenerationContinuityInvalidation } from "@vioxen/subscription-runtime/core";
import { DependencyAdmissionError, DependencyAdmissionFailure as Failure, DependencyOwnerKind, DependencyOwnerPhase,
  parseDependencyOwner, type DependencyOwnerRecord } from "../domain/dependency-owner";
import { DependencyReceiptState, DependencyUnverifiedReason, sameDependencyWorkspace,
  type DependencyWorkspaceIdentity } from "../domain/dependency-receipt";
import type { DependencyOwnerStore } from "../ports/dependency-owner-store";
import type { DependencyReceiptStore, DependencyCommittedUnverifiedReceipt } from "../ports/dependency-receipt-store";

/** Inactive foundation: retires current receipt authentication only. It cannot
 * mint a generation baseline, authorize a writer or release the held owner.
 * The fixed supervisor must own its actual activation fence across both stores;
 * injected verifiers independently resolve that owner and protected history.
 * Failure after receipt publication retains the same owner for reconciliation.
 */
export function invalidateDependencyGeneration(input: {
  readonly owners: DependencyOwnerStore; readonly receipts: DependencyReceiptStore;
  readonly workspace: DependencyWorkspaceIdentity; readonly expectedOwnerRevision: number;
  readonly expectedReceiptRevision: number;
  readonly reason: DependencyUnverifiedReason.TreeChanged | DependencyUnverifiedReason.InputsChanged;
}): { readonly owner: Extract<DependencyOwnerRecord, { version: 3 }>; readonly retired: DependencyCommittedUnverifiedReceipt } {
  const raw = input.owners.read(input.workspace);
  if (!raw) fail();
  const current = parseDependencyOwner(raw);
  if (current.version !== 3 || current.revision !== input.expectedOwnerRevision || !sameDependencyWorkspace(current.workspace, input.workspace) ||
      !current.owner || current.owner.phase !== DependencyOwnerPhase.ExclusiveMutation ||
      (input.reason !== DependencyUnverifiedReason.TreeChanged && input.reason !== DependencyUnverifiedReason.InputsChanged)) fail();
  const receipt = input.receipts.read(input.workspace);
  if (!receipt || receipt.state !== DependencyReceiptState.Ready || receipt.revision !== input.expectedReceiptRevision) fail();
  const ready = input.receipts.getCommittedReady(input.workspace, receipt.revision);
  const retired = input.receipts.retireReady(input.workspace, receipt.revision, ready.reference, {
    version: 1, revision: receipt.revision + 1, workspace: receipt.workspace, generation: receipt.generation,
    coverageRevision: receipt.coverageRevision, state: DependencyReceiptState.Unverified, tree: receipt.tree, reason: input.reason,
  });
  const operationId = current.owner.kind === DependencyOwnerKind.Maintenance ? current.owner.attempt.operationId : current.owner.attempt.attemptId;
  const generationContinuity = parseDependencyGenerationContinuityInvalidation({ version: 1,
    kind: DependencyGenerationContinuityKind.RetiredReadyV1, operationId, generation: receipt.generation,
    readyRevision: ready.receipt.revision, unverifiedRevision: retired.receipt.revision,
    previousReady: ready.reference, retiredUnverified: retired.reference });
  const next = parseDependencyOwner({ ...current, revision: current.revision + 1, generationContinuity });
  if (next.version !== 3) fail();
  const published = input.owners.compareAndSwap(input.workspace, current.revision, next);
  if (published.version !== 3) fail();
  return { owner: published, retired };
}
function fail(): never { throw new DependencyAdmissionError(Failure.StaleAttempt); }
