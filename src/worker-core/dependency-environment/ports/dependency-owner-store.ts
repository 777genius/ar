import type { DependencyOwnerRecord } from "../domain/dependency-owner";
import type { DependencyWorkspaceIdentity } from "../domain/dependency-receipt";

/** Trusted composition owns the private root. Neither this port nor its records
 * authenticate host custody or grants. Physical dev/ino is the storage key, so
 * two canonical aliases cannot create independent owners. No TTL/PID recovery.
 * Publication and conflict comparison must be serialized and file/parent-synced.
 */
export interface DependencyOwnerStore {
  read(workspace: DependencyWorkspaceIdentity): DependencyOwnerRecord | null;
  compareAndSwap(workspace: DependencyWorkspaceIdentity, expectedRevision: number | null,
    next: DependencyOwnerRecord): DependencyOwnerRecord;
}
