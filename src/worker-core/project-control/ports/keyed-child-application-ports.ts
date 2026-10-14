import type { ScopedTerminationCause } from "../../hosted-custody/domain/scoped-termination";
import type { ScopedChildTerminationProof } from "./keyed-child-launch-ports";
import type { ChildCorrelation, ChildObservation, ChildScope, KeyedChildLedger } from "../domain/keyed-child-launch";
import type { KeyedChildLedgerTransactionPort } from "./keyed-child-launch-ports";

export enum ScopedStopReason { Requested = "requested", Deadline = "deadline", Budget = "budget", Completion = "completion" }
export enum KeyedAuthorizationMode { Work = "work", Cleanup = "cleanup" }
export enum ScopedStopResult { Unresolved = "unresolved", ReceiptBacked = "receipt_backed" }
export type ScopedStopResponse = ScopedStopResult.Unresolved |
  { readonly outcome: ScopedStopResult.Unresolved; readonly cause: ScopedTerminationCause } |
  { readonly outcome: ScopedStopResult.ReceiptBacked; readonly proof: ScopedChildTerminationProof };
/** References are descriptive only; publication requires the trusted validator. */
export interface KeyedScopedStopPort {
  request(binding: ChildCorrelation, reason: ScopedStopReason): Promise<ScopedStopResponse>;
}
export interface KeyedDispatchAcknowledgment {
  readonly observation: ChildObservation;
  /** Owned foreground observation; never termination proof or renewed permission. */
  readonly completion?: Promise<void>;
}
export interface KeyedChildApplicationPort extends KeyedChildLedgerTransactionPort {
  readonly scope: ChildScope;
  readonly authorityDigest: string;
  readonly deadlineEpochMs: number;
  readonly maxGoalTurns: number;
  authenticate(mode?: KeyedAuthorizationMode): void;
  beforeFreshClaim(slotId: string): void;
  coordinate<T>(action: () => Promise<T>, mode?: KeyedAuthorizationMode): Promise<T>;
  read(mode?: KeyedAuthorizationMode): KeyedChildLedger;
  /** Durable original ownership before any preparation effects. Called under
   * controller/workspace coordination after the claim's durable publication. */
  retainPreparation(binding: ChildCorrelation): void;
  /** Early preflight only; it cannot authorize a later state transition.
   * A reconstructed owner never reopens the original admission. */
  assertPreparationAdmission(binding: ChildCorrelation): void;
  /** Synchronously authenticate the original admission and fresh generation
   * inside the successor CAS callback, under the same common fence as its
   * publication. The application owns the transition policy; the adapter owns
   * the concrete fence/store. No asynchronous callback or renewed authority. */
  transactPreparation(binding: ChildCorrelation,
    successor: (current: KeyedChildLedger) => KeyedChildLedger): KeyedChildLedger;
  /** Close once under coordination. Neither repeated stop nor retry can mint
   * a new original operation, gate, lifetime or cleanup allowance. */
  closePreparation(binding: ChildCorrelation, reason: ScopedStopReason): void;
  materialize(binding: ChildCorrelation, task: string): Promise<void>;
  dispatchPrepared(binding: ChildCorrelation): KeyedDispatchAcknowledgment;
  readonly stopPort?: KeyedScopedStopPort | undefined;
}
