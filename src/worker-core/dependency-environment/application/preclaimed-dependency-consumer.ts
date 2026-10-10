import { createHash } from "node:crypto";
import { isDependencyCustodyObject } from "@vioxen/subscription-runtime/core";
import { DependencyAdmissionError, DependencyAdmissionFailure as Failure, DependencyOwnerPhase,
  isDependencyConsumerOwner, parseDependencyOwner, sameDependencyAttempt,
  type DependencyAttempt, type DependencyOwnerRecord } from "../domain/dependency-owner";
import { sameDependencyWorkspace, type DependencyWorkspaceIdentity } from "../domain/dependency-receipt";
import type { DependencyOwnerStore } from "../ports/dependency-owner-store";

export type DependencyConsumerPreclaim = {
  readonly version: 1; readonly workspace: DependencyWorkspaceIdentity; readonly attempt: DependencyAttempt;
  readonly ownerRevision: number; readonly ownerSha256: string;
};
const digest = (record: DependencyOwnerRecord): string => createHash("sha256")
  .update(JSON.stringify(record) + "\n").digest("hex");
function current(store: DependencyOwnerStore, workspace: DependencyWorkspaceIdentity, attempt: DependencyAttempt): DependencyOwnerRecord {
  const read = store.read(workspace);
  if (!read) fail();
  const record = parseDependencyOwner(read);
  if (record.version === 1 || !sameDependencyWorkspace(record.workspace, workspace) ||
      !isDependencyConsumerOwner(record.owner) || record.owner.phase !== DependencyOwnerPhase.ExclusiveMutation ||
      !sameDependencyAttempt(record.owner.attempt, attempt)) fail();
  return record;
}
/** Producer fact capture only. Host composition separately authenticates the
 * actual start/custody and persists its immutable handoff before submission. */
export function captureDependencyConsumerPreclaim(store: DependencyOwnerStore, workspace: DependencyWorkspaceIdentity,
  attempt: DependencyAttempt): DependencyConsumerPreclaim {
  const record = current(store, workspace, attempt);
  return JSON.parse(JSON.stringify({ version: 1, workspace: record.workspace, attempt,
    ownerRevision: record.revision, ownerSha256: digest(record) })) as DependencyConsumerPreclaim;
}
/** Does not claim twice or consume a token. The actual fixed CLI must create its
 * once-only protected entry before IO; this assertion cannot replace that seam.
 * The digest is the producer's preclaim revision, not a currentness credential
 * after Running or any other owner revision has been published. */
export function assertDependencyPreclaimedConsumer(store: DependencyOwnerStore, workspace: DependencyWorkspaceIdentity,
  preclaim: DependencyConsumerPreclaim): DependencyOwnerRecord {
  if (!isDependencyCustodyObject(preclaim, "attempt,ownerRevision,ownerSha256,version,workspace") ||
      !isDependencyCustodyObject(preclaim.workspace, "canonicalPath,dev,ino") ||
      !isDependencyCustodyObject(preclaim.attempt, "attemptId,epoch,launch") ||
      typeof preclaim.attempt.launch !== "object" || preclaim.attempt.launch === null ||
      !isDependencyCustodyObject(preclaim.attempt.launch, Object.hasOwn(preclaim.attempt.launch, "kind") ?
        "association,bootId,grantDigest,installationId,kind,origin,runtimeSha,startId,unit" :
        "bootId,grantDigest,installationId,runtimeSha,startId,unit") || preclaim.version !== 1 || !Number.isSafeInteger(preclaim.ownerRevision) || preclaim.ownerRevision < 1 ||
      !/^[a-f0-9]{64}$/.test(preclaim.ownerSha256) || !sameDependencyWorkspace(preclaim.workspace, workspace)) fail();
  const record = current(store, workspace, preclaim.attempt);
  if (record.revision !== preclaim.ownerRevision || digest(record) !== preclaim.ownerSha256) fail();
  return record;
}
function fail(): never { throw new DependencyAdmissionError(Failure.StaleAttempt); }
