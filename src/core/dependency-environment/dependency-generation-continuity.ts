import { isDependencyCustodyObject, isDependencyProtectedReference,
  type DependencyProtectedReference } from "./dependency-custody-evidence";

// Closed continuity records are facts only. Their parser and epoch do not
// authorize reuse; current fixed physical composition authenticates exclusion.
export enum DependencyGenerationContinuityKind {
  RetiredReadyV1 = "retired_ready_v1",
  BaselineAuthenticatedV1 = "baseline_authenticated_v1",
  RetiredEvictingV1 = "retired_evicting_v1",
}
export type DependencyGenerationContinuityInvalidation = {
  readonly version: 1; readonly kind: DependencyGenerationContinuityKind.RetiredReadyV1;
  readonly operationId: string; readonly generation: string;
  readonly readyRevision: number; readonly unverifiedRevision: number;
  readonly previousReady: DependencyProtectedReference;
  readonly retiredUnverified: DependencyProtectedReference;
};
export function parseDependencyGenerationContinuityInvalidation(value: unknown): DependencyGenerationContinuityInvalidation {
  if (!isDependencyCustodyObject(value, "generation,kind,operationId,previousReady,readyRevision,retiredUnverified,unverifiedRevision,version") ||
      value.version !== 1 || value.kind !== DependencyGenerationContinuityKind.RetiredReadyV1 ||
      typeof value.operationId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.operationId) ||
      typeof value.generation !== "string" || value.generation.length < 1 || value.generation.length > 1024 ||
      value.generation.trim() !== value.generation || /[\x00-\x1f\x7f]|sk-[A-Za-z0-9_-]{12,}|Bearer\s/i.test(value.generation) ||
      !Number.isSafeInteger(value.readyRevision) || typeof value.readyRevision !== "number" || value.readyRevision < 1 ||
      !Number.isSafeInteger(value.unverifiedRevision) || typeof value.unverifiedRevision !== "number" ||
      value.unverifiedRevision !== value.readyRevision + 1 ||
      !isDependencyProtectedReference(value.previousReady) || !isDependencyProtectedReference(value.retiredUnverified) ||
      value.previousReady.path === value.retiredUnverified.path) throw new Error("dependency_generation_continuity:invalid_record");
  return JSON.parse(JSON.stringify(value)) as DependencyGenerationContinuityInvalidation;
}
