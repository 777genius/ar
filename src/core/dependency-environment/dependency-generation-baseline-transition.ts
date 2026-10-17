import { DependencyGenerationContinuityKind } from "./dependency-generation-continuity";
import { dependencyGenerationContinuityRevision } from "./dependency-generation-baseline";
import { sameDependencyProtectedReference } from "./dependency-custody-evidence";
import { DependencyOwnerKind, DependencyOwnerPhase, isDependencyConsumerOwner, sameDependencyOwnerIdentity,
  type DependencyOwnerRecord } from "./dependency-owner";

type ProtectedOwner = Extract<DependencyOwnerRecord,{version:2|3}>;
/** Store-captured predecessor only. This checks the closed scheduling shape;
 * the adapter must ALSO verify current installed/native/original-map facts. */
export function assertDependencyGenerationBaselineTransition(previous: ProtectedOwner, next: ProtectedOwner): void {
  const before = previous.generationContinuity, after = next.generationContinuity;
  const activeBefore = before?.kind === DependencyGenerationContinuityKind.BaselineAuthenticatedV1;
  const activeAfter = after?.kind === DependencyGenerationContinuityKind.BaselineAuthenticatedV1;
  if (!activeBefore && !activeAfter) invalid();
  if (next.revision !== previous.revision + 1 || !after) invalid();
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  if (previous.version !== next.version) {
    // Existing genuine custody upgrade preserves the same idle generation.
    // The fixed adapter must authenticate its actual custody transfer too.
    if (previous.version!==2 || next.version!==3 || previous.owner || next.owner ||
        previous.epoch!==next.epoch || !unchanged || !activeBefore || !activeAfter) invalid();
    return;
  }
  if (unchanged) {
    if (!activeBefore || !activeAfter) invalid();
    if (!previous.owner) {
      if (!next.owner || next.owner.phase !== DependencyOwnerPhase.ExclusiveMutation || next.epoch !== previous.epoch+1) invalid();
      return;
    }
    if (next.epoch !== previous.epoch) invalid();
    if (!next.owner) { if (previous.owner.phase !== DependencyOwnerPhase.Fenced) invalid(); return; }
    if (!sameDependencyOwnerIdentity(previous.owner,next.owner)) invalid();
    if (previous.owner.phase === DependencyOwnerPhase.Fenced && next.owner.phase !== DependencyOwnerPhase.Fenced ||
        previous.owner.phase === DependencyOwnerPhase.Running && next.owner.phase === DependencyOwnerPhase.ExclusiveMutation) invalid();
    return;
  }
  if (!previous.owner || !next.owner || previous.epoch !== next.epoch ||
      previous.owner.phase !== DependencyOwnerPhase.ExclusiveMutation || next.owner.phase !== DependencyOwnerPhase.ExclusiveMutation ||
      !sameDependencyOwnerIdentity(previous.owner,next.owner)) invalid();
  const operation = previous.owner.kind === DependencyOwnerKind.Maintenance ? previous.owner.attempt.operationId : previous.owner.attempt.attemptId;
  if (after.operationId !== operation) invalid();
  if (activeAfter) {
    if (activeBefore || !isDependencyConsumerOwner(previous.owner) ||
        before && after.readyRevision <= dependencyGenerationContinuityRevision(before)) invalid();
    return;
  }
  if (!activeBefore || after.generation !== before.generation || after.readyRevision !== before.readyRevision ||
      !sameDependencyProtectedReference(after.previousReady,before.previousReady)) invalid();
  if (after.kind === DependencyGenerationContinuityKind.RetiredEvictingV1 &&
      (previous.owner.kind !== DependencyOwnerKind.Maintenance ||
       !sameDependencyProtectedReference(after.baseline,before.baseline) ||
       !sameDependencyProtectedReference(after.writerBarrier,before.writerBarrier))) invalid();
}
function invalid(): never { throw new Error("dependency_generation_continuity:invalid_record"); }
