import type { SourceWorkerRequestIdentity, SourceWorkerRequestRecord, SourceWorkerRevision, SourceWorkerQuiescenceProof } from "../domain/source-worker-service-ownership";
export interface SourceWorkerRequestStorePort {
  /** Only created=true may schedule preparation, once. Existing IDs never replay,
   * including reserved records from an earlier broker incarnation. */
  accept(identity: SourceWorkerRequestIdentity): Promise<{ readonly created: boolean; readonly record: SourceWorkerRequestRecord }>;
  read(workstreamId: string, requestId: string): Promise<SourceWorkerRequestRecord | null>;
  /** Reads original records only; unidentified publication debt fails closed. */
  list(workstreamId: string): Promise<readonly SourceWorkerRequestRecord[]>;
  revise(workstreamId: string, requestId: string, expectedRevision: number,
    next: SourceWorkerRevision, proof?: SourceWorkerQuiescenceProof): Promise<SourceWorkerRequestRecord>;
}
