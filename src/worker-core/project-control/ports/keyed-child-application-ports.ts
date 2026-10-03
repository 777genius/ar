import type { ChildCorrelation, ChildObservation, ChildScope, KeyedChildLedger } from "../domain/keyed-child-launch";
import type { KeyedChildLedgerTransactionPort } from "./keyed-child-launch-ports";

export enum ScopedStopReason { Requested = "requested", Deadline = "deadline" }
export enum ScopedStopResult { Unresolved = "unresolved" }
/** PR5 supplies proof, not a boolean terminalizer. PR4 never releases occupancy. */
export interface KeyedScopedStopPort {
  request(binding: ChildCorrelation, reason: ScopedStopReason): Promise<ScopedStopResult>;
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
  authenticate(): void;
  beforeFreshClaim(slotId: string): void;
  coordinate<T>(action: () => Promise<T>): Promise<T>;
  read(): KeyedChildLedger;
  materialize(binding: ChildCorrelation, task: string): Promise<void>;
  dispatchPrepared(binding: ChildCorrelation): KeyedDispatchAcknowledgment;
  readonly stopPort?: KeyedScopedStopPort | undefined;
}
