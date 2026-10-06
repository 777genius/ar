import type { DependencyOwnerRecord } from "../domain/dependency-owner";
import type { DependencyReceipt, DependencyReceiptState } from "../domain/dependency-receipt";
import type { DependencyCommittedReceiptReference } from "./dependency-receipt-store";
import type { DependencyGenerationContinuityInvalidation } from "@vioxen/subscription-runtime/core";

export type DependencyUnverifiedGenerationReceipt = Extract<DependencyReceipt, { state: DependencyReceiptState.Unverified }>;
// Fixed trusted composition resolves actual host owner/physical capture. Ports
// carry store-captured facts, never caller predicates or producer permits.
export interface DependencyGenerationReceiptVerifier {
  assertReadyRetirement(input: {
    readonly previousReady: Extract<DependencyReceipt, { state: DependencyReceiptState.Ready }>;
    readonly previousReference: DependencyCommittedReceiptReference;
    readonly proposedUnverified: DependencyUnverifiedGenerationReceipt;
  }): void;
  assertFactualUnverified(input: { readonly proposedUnverified: DependencyUnverifiedGenerationReceipt }): void;
}
// Called under the owner store mutex with its actual captured predecessor.
// The fixed reader authenticates the already committed receipt retirement; it
// must not recursively call a public reader of this same owner store.
export interface DependencyGenerationRetirementVerifier {
  assertGenerationRetirement(input: {
    readonly previousOwner: Extract<DependencyOwnerRecord, { version: 2 | 3 }>;
    readonly proposedOwner: Extract<DependencyOwnerRecord, { version: 2 | 3 }>;
    readonly invalidation: DependencyGenerationContinuityInvalidation;
  }): void;
}
