import type { DependencyReceipt, DependencyReceiptState } from "../domain/dependency-receipt";
import type { DependencyCommittedReceiptReference } from "./dependency-receipt-store";
/** The adapter captures its OWN exact committed predecessor under its mutex.
 * Original physical composition authenticates its durable explicit selection
 * and named source-tree capture before opening the store, never via a DTO grant. */
export interface DependencyExplicitReinstallationVerifier {
  assertExplicitReinstallation(input: {
    readonly previousReceipt: Extract<DependencyReceipt, { state: DependencyReceiptState.Ready | DependencyReceiptState.Unverified }>;
    readonly previousReference: DependencyCommittedReceiptReference;
    readonly proposedUnverified: Extract<DependencyReceipt, { state: DependencyReceiptState.Unverified }>;
  }): void;
}
