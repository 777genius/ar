import { isDependencyCustodyObject, isDependencyProtectedReference,
  type DependencyProtectedReference } from "./dependency-protected-reference";
import { DependencyGenerationContinuityKind, parseDependencyGenerationContinuityInvalidation,
  type DependencyGenerationContinuityInvalidation } from "./dependency-generation-continuity";

/** Historical observation plus continuous exclusion. The references are data;
 * parsing or a successful structural transition never proves that exclusion. */
export type DependencyGenerationBaseline = Readonly<{
  version: 1; kind: DependencyGenerationContinuityKind.BaselineAuthenticatedV1;
  operationId: string; generation: string; readyRevision: number;
  previousReady: DependencyProtectedReference; baseline: DependencyProtectedReference;
  writerBarrier: DependencyProtectedReference;
}>;
/** The real Evicting successor is distinct from an Unverified retirement. */
export type DependencyGenerationEviction = Readonly<{
  version: 1; kind: DependencyGenerationContinuityKind.RetiredEvictingV1;
  operationId: string; generation: string; readyRevision: number; evictingRevision: number;
  previousReady: DependencyProtectedReference; retiredEvicting: DependencyProtectedReference;
  baseline: DependencyProtectedReference; writerBarrier: DependencyProtectedReference;
}>;
export type DependencyGenerationContinuity = DependencyGenerationContinuityInvalidation |
  DependencyGenerationBaseline | DependencyGenerationEviction;
export function parseDependencyGenerationContinuity(value: unknown): DependencyGenerationContinuity {
  const kind = typeof value === "object" && value !== null ? Object.getOwnPropertyDescriptor(value,"kind") : undefined;
  if (!kind || !("value" in kind)) invalid();
  if (kind.value === DependencyGenerationContinuityKind.RetiredReadyV1) return parseDependencyGenerationContinuityInvalidation(value);
  const eviction = kind.value === DependencyGenerationContinuityKind.RetiredEvictingV1;
  if (kind.value !== DependencyGenerationContinuityKind.BaselineAuthenticatedV1 && !eviction ||
      !isDependencyCustodyObject(value, eviction ?
        "baseline,evictingRevision,generation,kind,operationId,previousReady,readyRevision,retiredEvicting,version,writerBarrier" :
        "baseline,generation,kind,operationId,previousReady,readyRevision,version,writerBarrier") ||
      value.version !== 1 || typeof value.operationId !== "string" ||
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(value.operationId)?.[0] !== value.operationId ||
      typeof value.generation !== "string" || value.generation.length < 1 || value.generation.length > 1024 ||
      value.generation.trim() !== value.generation || /[\x00-\x1f\x7f]|sk-[A-Za-z0-9_-]{12,}|Bearer\s/i.test(value.generation) ||
      typeof value.readyRevision !== "number" || !Number.isSafeInteger(value.readyRevision) || value.readyRevision < 1 ||
      !isDependencyProtectedReference(value.previousReady) || !isDependencyProtectedReference(value.baseline) ||
      !isDependencyProtectedReference(value.writerBarrier)) invalid();
  const references = [value.previousReady, value.baseline, value.writerBarrier];
  if (eviction) {
    if (typeof value.evictingRevision !== "number" || !Number.isSafeInteger(value.evictingRevision) ||
        value.evictingRevision !== value.readyRevision + 1 || !isDependencyProtectedReference(value.retiredEvicting)) invalid();
    references.push(value.retiredEvicting);
  }
  if (new Set(references.map(reference => reference.path)).size !== references.length) invalid();
  return JSON.parse(JSON.stringify(value)) as DependencyGenerationBaseline | DependencyGenerationEviction;
}
export function dependencyGenerationContinuityRevision(value: DependencyGenerationContinuity): number {
  switch (value.kind) {
    case DependencyGenerationContinuityKind.RetiredReadyV1: return value.unverifiedRevision;
    case DependencyGenerationContinuityKind.RetiredEvictingV1: return value.evictingRevision;
    case DependencyGenerationContinuityKind.BaselineAuthenticatedV1: return value.readyRevision;
  }
}
function invalid(): never { throw new Error("dependency_generation_continuity:invalid_record"); }
