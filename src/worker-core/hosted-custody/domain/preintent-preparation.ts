import type { ChildCorrelation } from "../../project-control/domain/keyed-child-launch";

export enum PreparationEffect {
  PublicationPlan = "publication_plan", Prompt = "prompt", SourceClone = "source_clone",
  SourceCheckout = "source_checkout", SourceHead = "source_head", SourceStatus = "source_status",
  Manifest = "manifest",
}
/** Immutable consumer-owned identity. Paths, native handles and mechanisms are
 * supplied by the outer adapter, never by the model or this policy boundary. */
export interface OriginalPreparationOwner {
  readonly correlation: ChildCorrelation;
  readonly preparationGeneration: number;
  readonly ownershipDigest: string;
  readonly preparationPlanDigest: string;
  readonly deadlineEpochMs: number;
  readonly maxGoalTurns: number;
}
declare const preparationQuiescenceBrand: unique symbol;
/** Native original custody and the original writer supply this authority.
 * A process exit, signal result, boolean or serialized proof cannot construct it. */
export interface OriginalPreparationQuiescence {
  readonly [preparationQuiescenceBrand]: true;
  readonly ownershipDigest: string;
  readonly proofDigest: string;
}
