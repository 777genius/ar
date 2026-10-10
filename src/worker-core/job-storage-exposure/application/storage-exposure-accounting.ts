import { assertStorageCapacity, assertStorageQuotaProof, exposureFailure, parseStorageAmounts,
  parseStorageClaim, parseStorageCapacitySnapshot, parseStorageDrainSealProof, parseStorageFilesystem, parseStorageGeneration,
  parseStorageLedger, parseStorageOperation, parseStorageQuotaProof, sameStorageAmounts,
  sameStorageFilesystem, sameStorageGeneration, storageSum, storageUInt, StorageExposureError,
  StorageExposureFailure, StorageExposurePhase, type StorageAmounts, type StorageExposureClaim,
  type StorageExposureLedger, type StorageFilesystem, type StorageGeneration } from "../domain/storage-exposure";
import { StorageKernelResultKind, StorageObservedWriter, type StorageExposureCapacityPort,
  type StorageExposureKernelPort, type StorageExposureStore, type StorageExposureTransaction,
  type StorageKernelResult, StorageKernelUnsupportedReason } from "../ports/storage-exposure-ports";

export enum StorageAccountingResultKind {
  Completed = "completed", Unsupported = "unsupported", Uncertain = "uncertain", CapacityRejected = "capacity_rejected",
}
export type StorageAccountingResult = {
  readonly kind: StorageAccountingResultKind;
  readonly claim: StorageExposureClaim;
  readonly unsupportedReason?: StorageKernelUnsupportedReason;
};
export type StorageExposureRequest = {
  readonly filesystem: StorageFilesystem;
  readonly generation: StorageGeneration;
  readonly operationId: string;
  readonly baseline: StorageAmounts;
  readonly growth: StorageAmounts;
  /** Explicit cap prevents an estimate from silently increasing authority. */
  readonly cap: StorageAmounts;
};

/** Trusted host composition only. This use case does not register a job, mint A
 * lifetime authority or authenticate native proofs. All kernel effects stay
 * behind the qualified port; absent enforcement is explicitly Unsupported. */
export class StorageExposureAccounting {
  private readonly filesystem: StorageFilesystem;
  constructor(filesystem: StorageFilesystem, private readonly store: StorageExposureStore,
    private readonly capacity: StorageExposureCapacityPort, private readonly kernel: StorageExposureKernelPort) {
    this.filesystem = parseStorageFilesystem(filesystem);
  }

  async reserve(request: StorageExposureRequest): Promise<StorageExposureClaim> {
    const filesystem = parseStorageFilesystem(request.filesystem), generation = parseStorageGeneration(request.generation);
    const operationId = parseStorageOperation(request.operationId), baseline = parseStorageAmounts(request.baseline),
      growth = parseStorageAmounts(request.growth), cap = parseStorageAmounts(request.cap);
    if (!sameStorageFilesystem(filesystem, this.filesystem)) exposureFailure(StorageExposureFailure.IdentityChanged);
    const proposed = parseStorageClaim({ generation, operationId, baseline, growth, cap, revision: 1,
      phase: StorageExposurePhase.Pending, quotaProof: null, drainSealProof: null }, filesystem);
    return this.store.withFilesystemFence(async tx => {
      const ledger = await this.read(tx), existing = this.find(ledger, generation);
      if (existing) {
        if (existing.operationId !== operationId || !sameStorageAmounts(existing.baseline, baseline) ||
            !sameStorageAmounts(existing.growth, growth) || !sameStorageAmounts(existing.cap, cap)) exposureFailure(StorageExposureFailure.Conflict);
        return existing; // Returning history grants no barrier/release authority.
      }
      // Parsing rejects live same-job generations and project ID reuse, even
      // when the old generation is Released. History remains bounded/retained.
      const next = parseStorageLedger({ ...ledger, revision: ledger.revision + 1, claims: [...ledger.claims, proposed] });
      await this.checkCapacity(tx, ledger, next.claims);
      await tx.persist(ledger.revision, next);
      return proposed;
    });
  }

  async activate(generationInput: StorageGeneration, expectedRevision: number): Promise<StorageAccountingResult> {
    const generation = parseStorageGeneration(generationInput);
    return this.store.withFilesystemFence(async tx => {
      let ledger = await this.read(tx), claim = this.required(ledger, generation, expectedRevision);
      if (claim.phase === StorageExposurePhase.Active) return completed(claim);
      if (![StorageExposurePhase.Pending, StorageExposurePhase.Verified].includes(claim.phase)) exposureFailure(StorageExposureFailure.Conflict);
      if (!await this.capacityFits(tx, ledger)) return capacityRejected(claim);
      const prepared = await this.kernelCall(tx, () => this.kernel.prepareOrVerifyQuota(this.filesystem, claim), value => this.checkedProof(value, claim));
      if (prepared.kind !== StorageKernelResultKind.Verified) return this.retainOutcome(tx, ledger, claim, prepared);
      const proof = prepared.value;
      claim = await this.update(tx, ledger, claim, { phase: StorageExposurePhase.Verified, quotaProof: proof });
      ledger = await this.read(tx);
      // This fresh statfs charges even the already allocated baseline/cap.
      if (!await this.capacityFits(tx, ledger)) return capacityRejected(claim);
      await tx.assertFence();
      const opened = await this.kernelCall(tx, () => this.kernel.openWriterBarrier(this.filesystem, claim), value => this.checkedProof(value, claim));
      if (opened.kind !== StorageKernelResultKind.Verified) return this.retainOutcome(tx, ledger, claim, opened);
      return completed(await this.update(tx, ledger, claim, { phase: StorageExposurePhase.Active }));
    });
  }

  async grow(input: { readonly generation: StorageGeneration; readonly expectedRevision: number;
    readonly operationId: string; readonly growth: StorageAmounts }): Promise<StorageAccountingResult> {
    const generation = parseStorageGeneration(input.generation), operationId = parseStorageOperation(input.operationId),
      growth = parseStorageAmounts(input.growth), expectedRevision = input.expectedRevision;
    return this.store.withFilesystemFence(async tx => {
      let ledger = await this.read(tx), claim = this.required(ledger, generation);
      if (claim.operationId === operationId) {
        if (!sameStorageAmounts(claim.growth, growth)) exposureFailure(StorageExposureFailure.Conflict);
        return claim.phase === StorageExposurePhase.Active ? completed(claim) : uncertain(claim);
      }
      if (claim.revision !== expectedRevision) exposureFailure(StorageExposureFailure.Stale);
      if (claim.phase !== StorageExposurePhase.Active || storageUInt(growth.bytes) < storageUInt(claim.growth.bytes) ||
          storageUInt(growth.inodes) < storageUInt(claim.growth.inodes) || sameStorageAmounts(growth, claim.growth)) exposureFailure(StorageExposureFailure.Conflict);
      const next = parseStorageClaim({ ...claim, revision: claim.revision + 1, operationId, growth,
        cap: storageSum(claim.baseline, growth), phase: StorageExposurePhase.GrowPending, quotaProof: null }, this.filesystem);
      const claims = ledger.claims.map(row => sameStorageGeneration(row.generation, generation) ? next : row);
      await this.checkCapacity(tx, ledger, claims);
      await tx.persist(ledger.revision, parseStorageLedger({ ...ledger, revision: ledger.revision + 1, claims }));
      claim = next; ledger = await this.read(tx);
      if (!await this.capacityFits(tx, ledger)) return capacityRejected(claim);
      const grown = await this.kernelCall(tx, () => this.kernel.growQuota(this.filesystem, claim), value => this.checkedProof(value, claim));
      if (grown.kind !== StorageKernelResultKind.Verified) return this.retainOutcome(tx, ledger, claim, grown);
      const proof = grown.value;
      return completed(await this.update(tx, ledger, claim, { phase: StorageExposurePhase.Active, quotaProof: proof }));
    });
  }

  async reconcile(generationInput: StorageGeneration, expectedRevision: number): Promise<StorageAccountingResult> {
    const generation = parseStorageGeneration(generationInput);
    return this.store.withFilesystemFence(async tx => {
      const ledger = await this.read(tx), claim = this.required(ledger, generation, expectedRevision);
      if (claim.phase === StorageExposurePhase.Released) return completed(claim);
      // A durable drain/seal cannot be undone by quota observation. Only a
      // fresh native drain/seal release may finish this retained commitment.
      if (claim.phase === StorageExposurePhase.Sealed) return uncertain(claim);
      const observed = await this.kernelCall(tx, () => this.kernel.reconcileQuota(this.filesystem, claim), value => {
        const proof = this.checkedProof(value.proof, claim);
        if (!Object.values(StorageObservedWriter).includes(value.writer)) exposureFailure(StorageExposureFailure.Invalid);
        return Object.freeze({ proof, writer: value.writer });
      });
      if (observed.kind !== StorageKernelResultKind.Verified) return this.retainOutcome(tx, ledger, claim, observed);
      const proof = observed.value.proof;
      // No release, usage-credit or new barrier is inferred from observation.
      return completed(await this.update(tx, ledger, claim, { quotaProof: proof, drainSealProof: null,
        phase: observed.value.writer === StorageObservedWriter.Active ? StorageExposurePhase.Active : StorageExposurePhase.Verified }));
    });
  }

  async release(input: { readonly generation: StorageGeneration; readonly expectedRevision: number;
    readonly operationId: string }): Promise<StorageAccountingResult> {
    const generation = parseStorageGeneration(input.generation), operationId = parseStorageOperation(input.operationId),
      expectedRevision = input.expectedRevision;
    return this.store.withFilesystemFence(async tx => {
      const ledger = await this.read(tx), claim = this.required(ledger, generation);
      if (claim.phase === StorageExposurePhase.Released) {
        if (claim.drainSealProof?.operationId !== operationId) exposureFailure(StorageExposureFailure.Conflict);
        return completed(claim);
      }
      if (claim.revision !== expectedRevision) exposureFailure(StorageExposureFailure.Stale);
      let committed: StorageExposureClaim | undefined, callbackStarted = false;
      const result = await this.kernelCall(tx, () => this.kernel.withDrainedQuotaSeal(this.filesystem, claim, operationId,
        async proofInput => {
          if (callbackStarted) exposureFailure(StorageExposureFailure.Conflict);
          callbackStarted = true;
          const proof = parseStorageDrainSealProof(proofInput);
          if (!sameStorageFilesystem(proof.filesystem, this.filesystem) || !sameStorageGeneration(proof.generation, generation) ||
              proof.claimRevision !== claim.revision || proof.operationId !== operationId) exposureFailure(StorageExposureFailure.IdentityChanged);
          await tx.assertFence();
          const sealed = await this.update(tx, ledger, claim, { phase: StorageExposurePhase.Sealed, drainSealProof: proof });
          const latest = await this.read(tx);
          committed = await this.update(tx, latest, sealed, { phase: StorageExposurePhase.Released });
          return committed;
        }));
      if (committed) {
        // Callback committed while the native generation fence was retained.
        // An acknowledgement failure does not erase the durable seal proof.
        return result.kind === StorageKernelResultKind.Verified ? completed(committed) : uncertain(committed);
      }
      if (result.kind === StorageKernelResultKind.Verified) exposureFailure(StorageExposureFailure.Invalid);
      return this.retainOutcome(tx, ledger, claim, result);
    });
  }

  private async read(tx: StorageExposureTransaction): Promise<StorageExposureLedger> {
    await tx.assertFence(); const ledger = parseStorageLedger(await tx.read());
    if (!sameStorageFilesystem(ledger.filesystem, this.filesystem)) exposureFailure(StorageExposureFailure.IdentityChanged);
    return ledger;
  }
  private find(ledger: StorageExposureLedger, generation: StorageGeneration): StorageExposureClaim | undefined {
    const claim = ledger.claims.find(row => row.generation.jobId === generation.jobId && row.generation.generationId === generation.generationId);
    if (claim && !sameStorageGeneration(claim.generation, generation)) exposureFailure(StorageExposureFailure.IdentityChanged);
    return claim;
  }
  private required(ledger: StorageExposureLedger, generation: StorageGeneration, expectedRevision?: number): StorageExposureClaim {
    const claim = this.find(ledger, generation);
    if (!claim) exposureFailure(StorageExposureFailure.Conflict);
    if (expectedRevision !== undefined && claim.revision !== expectedRevision) exposureFailure(StorageExposureFailure.Stale);
    return claim;
  }
  private async update(tx: StorageExposureTransaction, ledger: StorageExposureLedger, claim: StorageExposureClaim,
    change: Partial<Pick<StorageExposureClaim, "phase" | "quotaProof" | "drainSealProof">>): Promise<StorageExposureClaim> {
    const next = parseStorageClaim({ ...claim, ...change, revision: claim.revision + 1 }, this.filesystem);
    await tx.persist(ledger.revision, parseStorageLedger({ ...ledger, revision: ledger.revision + 1,
      claims: ledger.claims.map(row => sameStorageGeneration(row.generation, claim.generation) ? next : row) }));
    return next;
  }
  private async checkCapacity(tx: StorageExposureTransaction, ledger: StorageExposureLedger, claims: readonly StorageExposureClaim[]): Promise<void> {
    await tx.assertFence(); const snapshot = parseStorageCapacitySnapshot(await this.capacity.readCapacity(this.filesystem));
    await tx.assertFence(); assertStorageCapacity(snapshot, ledger, claims);
  }
  private async capacityFits(tx: StorageExposureTransaction, ledger: StorageExposureLedger): Promise<boolean> {
    try { await this.checkCapacity(tx, ledger, ledger.claims); return true; }
    catch (error) { if (error instanceof StorageExposureError && error.reason === StorageExposureFailure.Capacity) return false; throw error; }
  }
  private async kernelCall<T>(tx: StorageExposureTransaction, effect: () => Promise<StorageKernelResult<T>>,
    decode: (value: T) => T = value => value): Promise<StorageKernelResult<T>> {
    await tx.assertFence();
    let result: StorageKernelResult<T>;
    try {
      const observed = await effect();
      if (observed.kind === StorageKernelResultKind.Verified) result = { kind: StorageKernelResultKind.Verified, value: decode(observed.value) };
      else if (observed.kind === StorageKernelResultKind.Unsupported && Object.values(StorageKernelUnsupportedReason).includes(observed.reason)) {
        result = { kind: StorageKernelResultKind.Unsupported, reason: observed.reason };
      } else result = { kind: StorageKernelResultKind.Uncertain };
    } catch { result = { kind: StorageKernelResultKind.Uncertain }; }
    await tx.assertFence();
    return result;
  }
  private checkedProof(value: unknown, claim: StorageExposureClaim): ReturnType<typeof parseStorageQuotaProof> {
    const proof = parseStorageQuotaProof(value); assertStorageQuotaProof(proof, this.filesystem, claim); return proof;
  }
  private async retainOutcome(tx: StorageExposureTransaction, ledger: StorageExposureLedger, claim: StorageExposureClaim,
    outcome: Exclude<StorageKernelResult<unknown>, { kind: StorageKernelResultKind.Verified }>): Promise<StorageAccountingResult> {
    if (outcome.kind === StorageKernelResultKind.Unsupported) return { kind: StorageAccountingResultKind.Unsupported, claim, unsupportedReason: outcome.reason };
    const latest = await this.read(tx);
    // A release callback may have durably sealed before its second publication
    // failed. Read the actual revision instead of overwriting it with old facts.
    const retained = this.required(latest, claim.generation);
    if (retained.phase === StorageExposurePhase.Sealed || retained.phase === StorageExposurePhase.Released) return uncertain(retained);
    return uncertain(await this.update(tx, latest, retained, { phase: StorageExposurePhase.Unknown }));
  }
}
function completed(claim: StorageExposureClaim): StorageAccountingResult { return { kind: StorageAccountingResultKind.Completed, claim }; }
function uncertain(claim: StorageExposureClaim): StorageAccountingResult { return { kind: StorageAccountingResultKind.Uncertain, claim }; }
function capacityRejected(claim: StorageExposureClaim): StorageAccountingResult { return { kind: StorageAccountingResultKind.CapacityRejected, claim }; }
