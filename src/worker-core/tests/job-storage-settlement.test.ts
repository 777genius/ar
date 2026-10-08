import { describe, expect, it } from "vitest";
import {
  JobStorageCapabilityStatus, JobStorageHomeStateRequirement, JobStorageIntentKind,
  JobStoragePendingReason, JobStorageSettlementService, JobStorageSettlementStatus,
  JobStorageTransitionStatus, SourceRecoveryFacet,
  sameJobStorageIdentity, type JobStorageGenerationAuthority, type JobStorageIdentity,
  type JobStorageSettlement, type JobStorageSettlementStore,
} from "../index";

/** Domain CAS fixture only. It provides no qualified native drain or writer pin. */
class SerialSettlementStore implements JobStorageSettlementStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(public current: JobStorageSettlement) {}
  update<T>(identity: JobStorageIdentity, revision: number,
    effect: (current: JobStorageSettlement) => Promise<{ readonly next?: JobStorageSettlement; readonly result: T }>): Promise<T> {
    const run = this.pending.then(async () => {
      if (!sameJobStorageIdentity(identity, this.current) || this.current.revision !== revision) throw new Error("job_storage_settlement_stale");
      const decision = await effect(this.current);
      if (decision.next) this.current = decision.next;
      return decision.result;
    });
    this.pending = run.catch(() => undefined);
    return run;
  }
}
const unsupportedNative: JobStorageGenerationAuthority = {
  withGenerationFence: async (_identity, effect) => effect(),
  verifyNativeDrain: async () => ({ status: JobStorageCapabilityStatus.Unsupported }),
};
const identity: JobStorageIdentity = { jobId: "test-storage-cas", generationId: "generation-1", receiptSha256: "a".repeat(64) };
const newState = (status: JobStorageSettlementStatus, continuation = false): JobStorageSettlement => ({ ...identity, revision: 0, status,
  intent: continuation ? { kind: JobStorageIntentKind.Continuation, sessionId: "test-session" }
    : { kind: JobStorageIntentKind.NoResume, homeStateRequirement: JobStorageHomeStateRequirement.NoneRequired } });

describe("storage settlement CAS", () => {
  it("records terminal as RESUMABLE and preserves it when source handoff is unknown", async () => {
    const store = new SerialSettlementStore(newState(JobStorageSettlementStatus.Active));
    const service = new JobStorageSettlementService(store, unsupportedNative, { verify: async () => ({ status: JobStorageCapabilityStatus.Unknown }) });
    await service.observeTerminal(identity, 0);
    expect(store.current.status).toBe(JobStorageSettlementStatus.Resumable);
    expect(await service.close(identity, 1, "unverified-handoff", "unverified-drain")).toEqual({
      status: JobStorageTransitionStatus.Pending, reason: JobStoragePendingReason.SourceHandoff });
    expect(store.current.revision).toBe(1);
    expect(store.current.status).toBe(JobStorageSettlementStatus.Resumable);
  });
  it("serializes two competing resumes and rejects stale close under the same revision", async () => {
    const store = new SerialSettlementStore(newState(JobStorageSettlementStatus.Resumable, true));
    const service = new JobStorageSettlementService(store, unsupportedNative, { verify: async () => ({ status: JobStorageCapabilityStatus.Unknown }) });
    const decisions = await Promise.allSettled([service.resume(identity, 0), service.resume(identity, 0), service.close(identity, 0, "handoff", "drain")]);
    expect(decisions.map(value => value.status)).toEqual(["fulfilled", "rejected", "rejected"]);
    expect(store.current).toMatchObject({ status: JobStorageSettlementStatus.Active, revision: 1 });
    await expect(service.observeTerminal({ ...identity, generationId: "another-generation" }, 1)).rejects.toThrow("job_storage_settlement_stale");
  });
  it("never resumes a closed or accepted no-resume generation", async () => {
    for (const status of [JobStorageSettlementStatus.Closed, JobStorageSettlementStatus.Resumable]) {
      const store = new SerialSettlementStore(newState(status));
      const service = new JobStorageSettlementService(store, unsupportedNative, { verify: async () => ({ status: JobStorageCapabilityStatus.Unsupported }) });
      await expect(service.resume(identity, 0)).rejects.toThrow("job_storage_resume_invalid");
      expect(store.current.revision).toBe(0);
    }
  });
  it("cannot switch the transaction generation by mutating the caller while its fence waits", async () => {
    const supplied = { ...identity }, store = new SerialSettlementStore(newState(JobStorageSettlementStatus.Active));
    let release!: () => void, enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const authority: JobStorageGenerationAuthority = { ...unsupportedNative, async withGenerationFence(_bound, effect) { enter(); await barrier; return effect(); } };
    const service = new JobStorageSettlementService(store, authority, { verify: async () => ({ status: JobStorageCapabilityStatus.Unknown }) });
    const transition = service.observeTerminal(supplied, 0);
    await entered;
    supplied.generationId = "unprotected-other-generation";
    release();
    await transition;
    expect(store.current).toMatchObject({ generationId: identity.generationId, status: JobStorageSettlementStatus.Resumable, revision: 1 });
  });
  it("keeps closure pending for missing ignored coverage and unsupported native drain", async () => {
    const facets = Object.fromEntries(Object.values(SourceRecoveryFacet).map(facet => [facet, JobStorageCapabilityStatus.Verified])) as Record<SourceRecoveryFacet, JobStorageCapabilityStatus>;
    facets[SourceRecoveryFacet.UntrackedIncludingIgnored] = JobStorageCapabilityStatus.Unknown;
    const store = new SerialSettlementStore(newState(JobStorageSettlementStatus.Resumable));
    // Adversarial handoff-verifier data exercises the close gate. It is not a
    // snapshot implementation or native qualification authority.
    const service = new JobStorageSettlementService(store, unsupportedNative, { verify: async () => ({
      status: JobStorageCapabilityStatus.Verified, identity, settlementRevision: 0,
      source: { sourceManifestSha256: "b".repeat(64), inventorySha256: "c".repeat(64), facets },
      outputManifestSha256: "d".repeat(64), evidenceManifestSha256: "e".repeat(64),
      independentDestinationId: "test-independent-destination", readbackReceiptSha256: "f".repeat(64),
    }) });
    expect(await service.close(identity, 0, "handoff", "drain")).toEqual({ status: JobStorageTransitionStatus.Pending, reason: JobStoragePendingReason.SourceHandoff });
    facets[SourceRecoveryFacet.UntrackedIncludingIgnored] = JobStorageCapabilityStatus.Verified;
    expect(await service.close(identity, 0, "handoff", "drain")).toEqual({ status: JobStorageTransitionStatus.Pending, reason: JobStoragePendingReason.NativeDrain });
    expect(store.current).toMatchObject({ status: JobStorageSettlementStatus.Resumable, revision: 0 });
  });
});
