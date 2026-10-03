import type { ScopedSignal, ScopedTerminationOperation, ScopedTerminationMember, ScopedTerminationObservation, ScopedTerminationReason, ScopedTerminationReceipt } from "../domain/scoped-termination";
/** Authenticated retained target, never a model supplied path or identity. Short
 * coordinated callbacks take the host fence after controller/workspace locks. */
export interface ScopedTerminationPort {
  authenticate(): void;
  begin(reason: ScopedTerminationReason): Promise<ScopedTerminationOperation>;
  fenceCreator(member: ScopedTerminationMember, remainingMs: number): Promise<void>;
  drainQueue(member: ScopedTerminationMember, remainingMs: number): Promise<void>;
  signal(member: ScopedTerminationMember, signal: ScopedSignal, remainingMs: number): Promise<void>;
  collect(member: ScopedTerminationMember, remainingMs: number): Promise<ScopedTerminationObservation>;
  publish(operation: ScopedTerminationOperation, observations: readonly ScopedTerminationObservation[], remainingMs: number): Promise<ScopedTerminationReceipt>;
}
