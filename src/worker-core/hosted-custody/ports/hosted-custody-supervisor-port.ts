import type { HostedCustodyEpoch, HostedCustodyIdentity, HostedCustodyReservation } from "../domain/hosted-custody-epoch";

/** Implemented by the trusted host supervisor, never by a worker callback or a
 * deserialized receipt. Every method must throw on unknown/incomplete evidence.
 * Unit absence and proxy exit alone cannot satisfy the terminal operations. */
export interface HostedCustodySupervisorPort {
  /** One host-wide serialization point, shared by ordinary/legacy launches,
   * provider spawns, enrollment, recovery and revocation. Crash recovery may not
   * silently remove a lock or erase retained starts. */
  serialized<T>(action: () => T): T;
  /** Same fence, but may complete an exact validated pending publication before
   * making CLOSED durable. Ordinary admission cannot use this recovery path. */
  recoverSerialized<T>(action: () => T): T;
  readEpoch(): unknown;
  /** Durable atomic replace plus fsync of record and parent, before returning. */
  publishEpoch(epoch: HostedCustodyEpoch): void;
  session(): { readonly hostId: string; readonly bootId: string; readonly supervisorId: string };
  /** Closed finite service/creator inventory, including queued starts and
   * unmanaged launch routes. A process-list scan or assertion is insufficient. */
  verifyExclusiveInventory(): void;
  /** Caller must belong to the reserved trusted outer runtime, not an arbitrary host process. */
  verifyRuntimeOwner(): void;
  /** Exact policy, stage, review, managed grant, bytes and physical custody.
   * No restoration/renewal of revoked authority is performed here. */
  verifyReadonlyMaterial(identity: HostedCustodyIdentity): void;
  verifyDescriptorBoundary(identity: HostedCustodyIdentity): void;
  fenceCreator(reservation: HostedCustodyReservation, recordedBootId: string): void;
  drainQueuedStart(reservation: HostedCustodyReservation): void;
  confirmTerminalDescendants(reservation: HostedCustodyReservation): void;
  requestStop(reservation: HostedCustodyReservation): void;
}
