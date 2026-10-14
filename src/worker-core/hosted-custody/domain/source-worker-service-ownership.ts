import type { HostedInstallation, HostedOrdinaryReservation } from "./hosted-installation-activation";
export enum SourceWorkerOperation { Start = "source-worker-start", Status = "source-worker-status", Stop = "source-worker-stop", Reconcile = "source-worker-reconcile" }
export enum SourceWorkerState { Reserved = "reserved", Starting = "starting", Running = "running", StopRequested = "stop_requested", Terminal = "terminal", Uncertain = "uncertain" }
export enum SourceWorkerOutcome { Completed = "completed", Failed = "failed", Stopped = "stopped", FailedBeforeEffect = "failed_before_effect" }
/** Immutable accepted installation, not the currently installed configuration.
 * A compatible upgrade must read original requests using these original pins. */
export type SourceWorkerBinding = Pick<HostedInstallation, "installationId" | "runtimeSha" | "runtimeManifestSha256"> & {
  readonly configSha256: string; readonly policySha256: string; readonly scopeSha256: string;
};
export type SourceWorkerRequestIdentity = SourceWorkerBinding & {
  readonly schemaVersion: 1; readonly requestId: string; readonly workstreamId: string;
  readonly expectedMachineId: string; readonly workerJobId: string; readonly sourceSha: string;
  readonly businessSha256: string; readonly fingerprint: string;
  readonly deadlineMs: number; readonly timeoutMs: number; readonly cleanupTimeoutMs: number;
};
/** OS custody remains authoritative. Reference its start ID, never a unit list. */
export type SourceWorkerRequestRecord = {
  readonly identity: SourceWorkerRequestIdentity; readonly revision: number;
  readonly state: SourceWorkerState; readonly outcome: SourceWorkerOutcome | null;
  readonly brokerEpochId: string | null;
  readonly runtimeStartId: HostedOrdinaryReservation["startId"] | null;
  readonly sourceSpecSha256: string | null; readonly terminationFenceSha256: string | null;
  readonly terminalReceiptSha256: string | null;
};
export type SourceWorkerRevision = Omit<SourceWorkerRequestRecord, "identity" | "revision">;
export type SourceWorkerReadModel = Pick<SourceWorkerRequestIdentity, "requestId" | "workstreamId" | "workerJobId" | "fingerprint" | "deadlineMs"> & SourceWorkerRevision & { readonly revision: number };
/** Facts must be authenticated by the custody adapter under its host fence.
 * Neither this shape nor a missing unit establishes terminal authority. */
export type SourceWorkerQuiescenceProof = {
  readonly requestFingerprint: string; readonly runtimeStartId: string | null;
  readonly receiptSha256: string; readonly operationSettled: boolean;
  readonly ownerLossFenced: boolean; readonly producersClosed: boolean;
  readonly queuedSubmissions: number; readonly liveDescendants: number;
  readonly noDispatchProven: boolean;
};
export function assertSourceWorkerSuccessor(prior: SourceWorkerRequestRecord, next: SourceWorkerRevision,
  proof?: SourceWorkerQuiescenceProof): void {
  const allowed: Record<SourceWorkerState, readonly SourceWorkerState[]> = {
    reserved: [SourceWorkerState.Starting, SourceWorkerState.StopRequested, SourceWorkerState.Uncertain, SourceWorkerState.Terminal],
    starting: [SourceWorkerState.Running, SourceWorkerState.StopRequested, SourceWorkerState.Uncertain, SourceWorkerState.Terminal],
    running: [SourceWorkerState.StopRequested, SourceWorkerState.Uncertain, SourceWorkerState.Terminal],
    stop_requested: [SourceWorkerState.Uncertain, SourceWorkerState.Terminal],
    uncertain: [SourceWorkerState.Running, SourceWorkerState.StopRequested, SourceWorkerState.Terminal], terminal: [],
  };
  if (!allowed[prior.state].includes(next.state)) throw new Error("source_worker_transition_denied");
  for (const key of ["brokerEpochId", "runtimeStartId", "sourceSpecSha256", "terminationFenceSha256"] as const) {
    if (prior[key] !== null && next[key] !== prior[key]) throw new Error("source_worker_correlation_changed");
  }
  if (next.terminationFenceSha256 !== null && (next.state === SourceWorkerState.Starting || next.state === SourceWorkerState.Running)) throw new Error("source_worker_fenced");
  if (next.state === SourceWorkerState.StopRequested && next.terminationFenceSha256 === null) throw new Error("source_worker_fence_required");
  if (next.state !== SourceWorkerState.Terminal) {
    if (next.outcome !== null || next.terminalReceiptSha256 !== null) throw new Error("source_worker_outcome_requires_terminal");
    return;
  }
  if (!proof || proof.requestFingerprint !== prior.identity.fingerprint || proof.runtimeStartId !== next.runtimeStartId ||
      proof.receiptSha256 !== next.terminalReceiptSha256 || !next.outcome ||
      !(proof.operationSettled || proof.ownerLossFenced) || !proof.producersClosed ||
      proof.queuedSubmissions !== 0 || proof.liveDescendants !== 0 ||
      (next.outcome === SourceWorkerOutcome.Completed && (!proof.operationSettled || next.runtimeStartId === null)) ||
      (next.outcome === SourceWorkerOutcome.Stopped && next.terminationFenceSha256 === null) ||
      (next.outcome === SourceWorkerOutcome.FailedBeforeEffect && (!proof.noDispatchProven || next.runtimeStartId !== null))) {
    throw new Error("source_worker_terminal_proof_required");
  }
}
