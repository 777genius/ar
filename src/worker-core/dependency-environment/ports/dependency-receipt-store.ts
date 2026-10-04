import type { DependencyReceipt, DependencyReceiptState, DependencyTreeIdentity, DependencyWorkspaceIdentity } from "../domain/dependency-receipt";

export type DependencyCommittedReceiptReference = {
  readonly path: string; readonly identity: DependencyTreeIdentity; readonly sha256: string;
};
export type DependencyCommittedAbsentReceipt = {
  readonly receipt: Extract<DependencyReceipt, { state: DependencyReceiptState.Absent }>;
  readonly reference: DependencyCommittedReceiptReference;
};

/** Protected storage facts only. Trusted composition owns admission, evidence
 * authentication and filesystem effects. Revisions are physical-workspace CAS;
 * historical references must remain authenticated after later publications.
 * An unresolved publisher blocks public reads as well as writes. No lock reaping.
 */
export interface DependencyReceiptStore {
  read(workspace: DependencyWorkspaceIdentity): DependencyReceipt | null;
  compareAndSwap(workspace: DependencyWorkspaceIdentity, expectedRevision: number | null,
    next: DependencyReceipt): DependencyReceipt;
  getCommittedAbsent(workspace: DependencyWorkspaceIdentity, revision: number): DependencyCommittedAbsentReceipt;
}
