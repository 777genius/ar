import type { DependencyReceipt, DependencyReceiptState, DependencyTreeIdentity, DependencyWorkspaceIdentity } from "../domain/dependency-receipt";

export type DependencyCommittedReceiptReference = {
  readonly path: string; readonly identity: DependencyTreeIdentity; readonly sha256: string;
};
export type DependencyCommittedAbsentReceipt = {
  readonly receipt: Extract<DependencyReceipt, { state: DependencyReceiptState.Absent }>;
  readonly reference: DependencyCommittedReceiptReference;
};

export type DependencyCommittedReadyReceipt = {
  readonly receipt: Extract<DependencyReceipt, { state: DependencyReceiptState.Ready }>;
  readonly reference: DependencyCommittedReceiptReference;
};

export type DependencyCommittedUnverifiedReceipt = {
  readonly receipt: Extract<DependencyReceipt, { state: DependencyReceiptState.Unverified }>;
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
  // Fixed trusted composition must verify the held owner and factual root;
  // these methods publish no active continuity or generated authority.
  retireReady(workspace: DependencyWorkspaceIdentity, expectedRevision: number,
    expectedReference: DependencyCommittedReceiptReference,
    next: Extract<DependencyReceipt, { state: DependencyReceiptState.Unverified }>): DependencyCommittedUnverifiedReceipt;
  publishFactualUnverified(workspace: DependencyWorkspaceIdentity,
    next: Extract<DependencyReceipt, { state: DependencyReceiptState.Unverified }>): DependencyCommittedUnverifiedReceipt;
  getCommittedReady(workspace: DependencyWorkspaceIdentity, revision: number): DependencyCommittedReadyReceipt;
  getCommittedUnverified(workspace: DependencyWorkspaceIdentity, revision: number): DependencyCommittedUnverifiedReceipt;
  getCommittedAbsent(workspace: DependencyWorkspaceIdentity, revision: number): DependencyCommittedAbsentReceipt;
}
