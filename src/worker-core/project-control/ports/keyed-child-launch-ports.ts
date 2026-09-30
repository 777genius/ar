import type { ChildCorrelation, ChildObservation, ChildScope, IndependentNoEffectEvidence,
  KeyedChildLedger } from "../domain/keyed-child-launch";

/** Atomic compare-and-swap under the host/controller/workspace fences.
 * The synchronous callback must not perform materialization, submission or waiting.
 * Persist one successor (including occupancy and handles) atomically before effects.
 * An implementation must validate immutable authority and generation, and durably
 * commit/fsync intent before any submission; stale/foreign successors are rejected.
 */
export interface KeyedChildLedgerTransactionPort {
  transact(scope: ChildScope, authorityDigest: string, expectedGeneration: number,
    successor: (current: KeyedChildLedger) => KeyedChildLedger): Promise<KeyedChildLedger>;
}
/** Host-only correlated reconciliation. Reading intent never authorizes submission.
 * Actual at-most-once submission is the future adapter/usecase's responsibility.
 * Acknowledgment and observation are bounded; foreground waits are outside CAS.
 */
export interface KeyedChildObservationPort {
  observeAuthorized(scope: ChildScope, binding: ChildCorrelation): Promise<ChildObservation>;
}
export interface KeyedChildNoEffectProofPort {
  establishNoEffects(scope: ChildScope, binding: ChildCorrelation): Promise<IndependentNoEffectEvidence | null>;
}
export enum ScopedTerminationProofKind { ReceiptBacked = "receipt_backed_scoped_termination" }
/** Reserved for PR5: no collector, fake default, or production terminalizer here.
 * The receipt must prove fenced creators, drained queued starts, and empty runtime
 * AND correlated provider cgroups. Provider exit, lease expiry and timeout do not.
 */
export interface ScopedChildTerminationProof {
  readonly kind: ScopedTerminationProofKind;
  readonly scope: ChildScope;
  readonly correlation: ChildCorrelation;
  readonly receiptDigest: string;
  readonly activationGeneration: number;
  readonly runtimeProofDigest: string;
  readonly providerProofDigest: string;
}
export interface FutureKeyedChildTerminationProofPort {
  proveTermination(scope: ChildScope, binding: ChildCorrelation): Promise<ScopedChildTerminationProof | null>;
}
/** Future usecase boundary: validate prepared correlation, CAS/fsync fresh intent,
 * then submit its exact preallocated start once. Existing intent only reconciles.
 * No caller-supplied replay permit; ambiguous publication remains occupied.
 * This port is a contract only, with no implementation or wait in this lane.
 */
export interface KeyedChildSubmissionPort {
  dispatchPrepared(scope: ChildScope, expectedPrepared: ChildCorrelation): Promise<ChildObservation>;
}
