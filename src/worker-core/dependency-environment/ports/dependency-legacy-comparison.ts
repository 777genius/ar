import type { DependencyReceipt, DependencyReceiptState, DependencyInstallProofKind } from "../domain/dependency-receipt";
import type { DependencyCommittedReceiptReference } from "./dependency-receipt-store";

export type DependencyUnverifiedReceipt = Extract<DependencyReceipt, { state: DependencyReceiptState.Unverified }>;
export type DependencyLegacyComparedReady = Extract<DependencyReceipt, { state: DependencyReceiptState.Ready }> & {
  readonly provenance: Extract<Extract<DependencyReceipt, { state: DependencyReceiptState.Ready }>["provenance"],
    { kind: DependencyInstallProofKind.LegacyCompared }>;
};
/** Called synchronously by storage under its owned CAS mutex, before any
 * publication. Both predecessor arguments are captured by that store, never
 * supplied by the issuer. Implementations authenticate fixed protected records;
 * they must not call a public reader of the same locked store. */
export interface DependencyLegacyComparisonVerifier {
  assertLegacyComparison(input: {
    readonly previousUnverified: DependencyUnverifiedReceipt;
    readonly previousReference: DependencyCommittedReceiptReference;
    readonly proposedReady: DependencyLegacyComparedReady;
  }): void;
}
