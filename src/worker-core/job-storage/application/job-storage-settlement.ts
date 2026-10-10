import {
  assertJobStorageIdentity, assertJobStorageIntent, completeSourceRecoveryCoverage,
  JobStorageCapabilityStatus, JobStorageIntentKind, JobStorageSettlementStatus,
  sameJobStorageIdentity, type JobStorageIdentity, type JobStorageSettlement,
} from "../domain/job-storage";
import type { JobStorageGenerationAuthority, JobStorageSettlementStore, JobStorageSourceHandoffPort } from "../ports/job-storage-ports";

export enum JobStorageTransitionStatus {
  Applied = "applied",
  Pending = "pending",
}
export enum JobStoragePendingReason {
  ContinuationIntent = "continuation-intent",
  WriterActive = "writer-active",
  SourceHandoff = "source-handoff-unverified",
  NativeDrain = "native-drain-unverified",
}
export type JobStorageTransitionResult =
  | { readonly status: JobStorageTransitionStatus.Applied; readonly settlement: JobStorageSettlement }
  | { readonly status: JobStorageTransitionStatus.Pending; readonly reason: JobStoragePendingReason };

/** No filesystem/provider effects and no inference from an execution result. */
export class JobStorageSettlementService {
  constructor(private readonly store: JobStorageSettlementStore,
    private readonly authority: JobStorageGenerationAuthority,
    private readonly handoff: JobStorageSourceHandoffPort) {}

  async resume(identity: JobStorageIdentity, expectedRevision: number): Promise<JobStorageTransitionResult> {
    return this.transition(identity, expectedRevision, async current => {
      if (current.status !== JobStorageSettlementStatus.Resumable || current.intent.kind !== JobStorageIntentKind.Continuation) throw new Error("job_storage_resume_invalid");
      const next = { ...current, revision: current.revision + 1, status: JobStorageSettlementStatus.Active };
      return { next, result: { status: JobStorageTransitionStatus.Applied, settlement: next } };
    });
  }

  async observeTerminal(identity: JobStorageIdentity, expectedRevision: number): Promise<JobStorageTransitionResult> {
    return this.transition(identity, expectedRevision, async current => {
      if (current.status !== JobStorageSettlementStatus.Active) throw new Error("job_storage_terminal_invalid");
      const next = { ...current, revision: current.revision + 1, status: JobStorageSettlementStatus.Resumable };
      return { next, result: { status: JobStorageTransitionStatus.Applied, settlement: next } };
    });
  }

  async close(identity: JobStorageIdentity, expectedRevision: number, handoffId: string, drainEvidenceId: string): Promise<JobStorageTransitionResult> {
    return this.transition(identity, expectedRevision, async current => {
      if (current.status === JobStorageSettlementStatus.Closed) throw new Error("job_storage_generation_closed");
      const pending = (reason: JobStoragePendingReason) => ({ result: { status: JobStorageTransitionStatus.Pending as const, reason } });
      if (current.intent.kind !== JobStorageIntentKind.NoResume) return pending(JobStoragePendingReason.ContinuationIntent);
      if (current.status !== JobStorageSettlementStatus.Resumable) return pending(JobStoragePendingReason.WriterActive);
      const handoff = await this.handoff.verify(current, handoffId);
      if (handoff.status !== JobStorageCapabilityStatus.Verified ||
          !sameJobStorageIdentity(current, handoff.identity) || handoff.settlementRevision !== current.revision ||
          !completeSourceRecoveryCoverage(handoff.source) || !handoff.independentDestinationId ||
          ![handoff.outputManifestSha256, handoff.evidenceManifestSha256, handoff.readbackReceiptSha256].every(isDigest)) {
        return pending(JobStoragePendingReason.SourceHandoff);
      }
      const drain = await this.authority.verifyNativeDrain(current, drainEvidenceId);
      if (drain.status !== JobStorageCapabilityStatus.Verified || !sameJobStorageIdentity(current, drain.identity) ||
          drain.settlementRevision !== current.revision || !isDigest(drain.nativeFenceSha256)) return pending(JobStoragePendingReason.NativeDrain);
      const next = { ...current, revision: current.revision + 1, status: JobStorageSettlementStatus.Closed };
      return { next, result: { status: JobStorageTransitionStatus.Applied, settlement: next } };
    });
  }

  private async transition(identity: JobStorageIdentity, expectedRevision: number,
    effect: (current: JobStorageSettlement) => Promise<{ readonly next?: JobStorageSettlement; readonly result: JobStorageTransitionResult }>): Promise<JobStorageTransitionResult> {
    assertJobStorageIdentity(identity);
    const boundIdentity = Object.freeze({ jobId: identity.jobId, generationId: identity.generationId, receiptSha256: identity.receiptSha256 });
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision === Number.MAX_SAFE_INTEGER) throw new Error("job_storage_revision_invalid");
    return this.authority.withGenerationFence(boundIdentity, () => this.store.update(boundIdentity, expectedRevision, async current => {
      if (!sameJobStorageIdentity(boundIdentity, current) || current.revision !== expectedRevision) throw new Error("job_storage_settlement_stale");
      assertJobStorageIntent(current.intent);
      const boundCurrent = Object.freeze({ ...current, intent: Object.freeze({ ...current.intent }) });
      return effect(boundCurrent);
    }));
  }
}
const isDigest = (value: string) => /^[a-f0-9]{64}$/.test(value);
