import {
  assertHostedCustodyIdentity, assertHostedCustodySession, closeHostedCustodyEpoch,
  HostedCustodyPhase, HostedCustodyReservationState, parseHostedCustodyEpoch,
  readyHostedCustodyEpoch, reserveHostedCustodyStart, terminalHostedCustodyStart, terminalHostedOuterRuntime,
  type HostedCustodyIdentity, type HostedCustodyReservation,
} from "./domain/hosted-custody-epoch";
import type { HostedCustodySupervisorPort } from "./ports/hosted-custody-supervisor-port";

export enum HostedCustodyLaunchKind {
  ManagedProvider = "managed_provider",
  Ordinary = "ordinary",
  Legacy = "legacy",
}

/** Safety application for one finite exclusive TEST epoch. This class is not an
 * authority adapter: implementation acceptance also requires the port at every
 * actual host launch boundary. Nothing initializes a missing durable record. */
export class HostedCustodySupervisor {
  constructor(private readonly host: HostedCustodySupervisorPort) {}

  /** Persist CLOSED before consulting live inventory or restoring authority.
   * Any failure thereafter leaves CLOSED and all unresolved reservations held. */
  recover(identity: HostedCustodyIdentity): void {
    this.host.recoverSerialized(() => {
      let epoch = closeHostedCustodyEpoch(parseHostedCustodyEpoch(this.host.readEpoch()));
      this.host.publishEpoch(epoch);
      assertHostedCustodyIdentity(epoch.identity, identity);
      const session = this.host.session();
      if (epoch.hostId !== session.hostId || epoch.revoked) throw new Error("hosted_custody_recovery_required");
      // Every recovery attempt invalidates prior admission closures, including
      // recovery on the same boot and supervisor. Overflow leaves CLOSED.
      epoch = parseHostedCustodyEpoch({ ...epoch, generation: epoch.generation + 1 });
      this.host.publishEpoch(epoch);
      if (epoch.outerRuntime !== null && epoch.outerRuntime.state !== HostedCustodyReservationState.Terminal) {
        this.host.fenceCreator(epoch.outerRuntime, epoch.bootId);
        this.host.drainQueuedStart(epoch.outerRuntime);
        this.host.confirmTerminalDescendants(epoch.outerRuntime);
        epoch = terminalHostedOuterRuntime(epoch, epoch.outerRuntime.startId);
        this.host.publishEpoch(epoch);
      }
      for (const reservation of epoch.reservations) {
        if (reservation.state === HostedCustodyReservationState.Terminal) continue;
        this.host.fenceCreator(reservation, epoch.bootId);
        this.host.drainQueuedStart(reservation);
        this.host.confirmTerminalDescendants(reservation);
        epoch = terminalHostedCustodyStart(epoch, reservation.startId);
        this.host.publishEpoch(epoch);
      }
      this.host.verifyExclusiveInventory();
      this.host.verifyReadonlyMaterial(epoch.identity);
      this.host.verifyDescriptorBoundary(epoch.identity);
      this.host.publishEpoch(readyHostedCustodyEpoch(epoch, session));
    });
  }

  /** The real host adapter submits the existing launch primitive inside this
   * serialized call; it must not hand a reusable permission token to a worker.
   * A failed/partial submission retains its exact reservation. */
  start<T>(kind: HostedCustodyLaunchKind, identity: HostedCustodyIdentity, generation: number,
    reservation: Omit<HostedCustodyReservation, "state">, submit: () => T): T {
    return this.host.serialized(() => {
      let epoch = parseHostedCustodyEpoch(this.host.readEpoch());
      try {
        assertHostedCustodySession(epoch, this.host.session());
        if (!Number.isSafeInteger(generation) || generation !== epoch.generation) {
          throw new Error("hosted_custody_generation_changed");
        }
        if (kind !== HostedCustodyLaunchKind.ManagedProvider || epoch.phase !== HostedCustodyPhase.Ready || epoch.revoked) {
          throw new Error("hosted_custody_start_denied");
        }
        assertHostedCustodyIdentity(epoch.identity, identity);
        this.host.verifyRuntimeOwner();
        this.host.verifyReadonlyMaterial(epoch.identity);
        this.host.verifyExclusiveInventory();
        this.host.verifyDescriptorBoundary(epoch.identity);
        epoch = reserveHostedCustodyStart(epoch, identity, reservation);
        this.host.publishEpoch(epoch);
      } catch (error) {
        this.host.publishEpoch(closeHostedCustodyEpoch(epoch));
        throw error;
      }
      // No catch/finally releases the reservation on a thrown spawn, proxy exit,
      // timeout or cancellation. Terminal evidence is an independent operation.
      return submit();
    });
  }

  reconcile(startId: string): void {
    this.host.serialized(() => {
      const epoch = parseHostedCustodyEpoch(this.host.readEpoch());
      assertHostedCustodySession(epoch, this.host.session());
      const reservation = epoch.reservations.find(record => record.startId === startId);
      if (!reservation) throw new Error("hosted_custody_unknown_start");
      this.host.fenceCreator(reservation, epoch.bootId);
      this.host.drainQueuedStart(reservation);
      this.host.confirmTerminalDescendants(reservation);
      this.host.publishEpoch(terminalHostedCustodyStart(epoch, startId));
    });
  }

  revoke(identity: HostedCustodyIdentity): void {
    this.host.serialized(() => {
      const epoch = parseHostedCustodyEpoch(this.host.readEpoch());
      assertHostedCustodyIdentity(epoch.identity, identity);
      const revoked = closeHostedCustodyEpoch(epoch, true);
      this.host.publishEpoch(revoked);
      // Stop failure is retained as failure; revocation remains durable and no
      // reservation becomes terminal on the strength of a stop request.
      let failed = false;
      for (const reservation of [...revoked.reservations, ...(revoked.outerRuntime ? [revoked.outerRuntime] : [])]) {
        if (reservation.state === HostedCustodyReservationState.Terminal) continue;
        try { this.host.requestStop(reservation); } catch { failed = true; }
      }
      if (failed) throw new Error("hosted_custody_stop_incomplete");
    });
  }
}
