import type { ChildCorrelation } from "../../project-control/domain/keyed-child-launch";
import type { OriginalPreparationOwner, OriginalPreparationQuiescence, PreparationEffect } from "../domain/preintent-preparation";

/** Original consumer-owned native operation, retained before any preparation
 * prefix. No process discovery, copied PID, replacement operation or timeout
 * proof is permitted. Implementations preserve original native cleanup ends. */
export interface OriginalPreparationCustodyPort {
  readonly owner: OriginalPreparationOwner;
  assertAdmission(binding: ChildCorrelation): void;
  requestStop(): void;
  join(): Promise<OriginalPreparationQuiescence | null>;
  authenticateQuiescence(proof: OriginalPreparationQuiescence): void;
}
export interface PreparationAdmissionPort {
  /** The caller owns fresh ledger + original gate coordination. Record the
   * prefix before invoking a bounded synchronous effect/start handoff. */
  effect<T>(binding: ChildCorrelation, effect: PreparationEffect, start: () => T): Promise<T>;
}
