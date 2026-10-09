import { HostedCustodyPhase, parseHostedCustodyEpoch, type HostedCustodyEpoch } from "../worker-core/hosted-custody/domain/hosted-custody-epoch";
import type { HostedActivation, HostedOrdinaryReservation } from "../worker-core/hosted-custody/domain/hosted-installation-activation";

/** Pure record checks only. Callers retain the actual file/kernel reads, common
 * fence and original budgets; these comparisons never confer host authority. */
export function custodyEnrollmentJobId(birth: HostedCustodyEpoch): string {
  if (birth.generation !== 1 || birth.phase !== HostedCustodyPhase.Closed || birth.revoked ||
      birth.reservations.length || birth.outerRuntime !== null) invalid();
  return birth.identity.jobId;
}
export function parseHostedCustodyEnrollment(value: unknown): string {
  const birth = parseHostedCustodyEpoch(value);
  return custodyEnrollmentJobId(birth);
}
export function managedReservations(epoch: HostedCustodyEpoch | undefined) {
  return epoch ? [...epoch.reservations, ...(epoch.outerRuntime ? [epoch.outerRuntime] : [])] : [];
}
export function assertActivationSession(activation: HostedActivation, session: { hostId: string; bootId: string; supervisorId: string }): void {
  if (activation.hostId !== session.hostId || activation.bootId !== session.bootId || activation.supervisorId !== session.supervisorId) invalid();
}
export function ordinaryUnitGroup(row: HostedOrdinaryReservation): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.startId) ||
      ![`subscription-runtime-ordinary-${row.startId}.service`, `subscription-runtime-hosted-${row.startId}.service`].includes(row.unit)) invalid();
  return `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${row.unit}`;
}

function invalid(): never { throw new Error("hosted_activation_evidence_invalid"); }
