import { createHash } from "node:crypto";
import { parseStorageFilesystem, parseStorageGeneration, sameStorageGeneration, type StorageFilesystem, type StorageGeneration } from "../../worker-core/job-storage-exposure/domain/storage-exposure";
import { BoundedStorageError, BoundedStorageFailure, BoundedStorageInspection, BoundedStoragePhase,
  type BoundedStorageLedger, type BoundedStorageNativeFacts, type BoundedStorageNativeHost, type BoundedStorageNativeSession,
  type BoundedStoragePreparationPort, type BoundedStorageRequest, type BoundedStorageReservation } from "../../worker-core/storage/bounded-storage-contract";
import { assertBoundedCapacity, assertBoundedRootCapacity, boundedFailure, boundedFields, parseBoundedFacts, parseBoundedLedger, parseBoundedRequest, parseBoundedReservation } from "../../worker-core/storage/bounded-storage-policy";

const maxLedgerBytes = 4 * 1024 * 1024;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
type Read = { readonly bytes: string; readonly ledger: BoundedStorageLedger };

/** Metadata-only authority. The native holder owns stable flock and durable
 * replace; this store owns full-Q/P/E policy. No PID/TTL, usage/deletion credit,
 * image disposal, native start barrier or new-generation retry exists here. */
export class LocalBoundedStorageReservationStore implements BoundedStoragePreparationPort {
  private constructor(private readonly filesystem: StorageFilesystem, private readonly native: BoundedStorageNativeHost) {}

  /** Only trusted installed host registration may initialize a NEW control root.
   * Existing/missing authorities are never silently reset by prepare/open. */
  static async initialize(filesystemInput: StorageFilesystem, native: BoundedStorageNativeHost): Promise<LocalBoundedStorageReservationStore> {
    const filesystem = parseStorageFilesystem(boundedFields(filesystemInput, ["machineId", "uuid", "device"]));
    await native.withFilesystemFence(async session => {
      if (await session.readLedger() !== null) boundedFailure(BoundedStorageFailure.Conflict);
      const ledger = parseBoundedLedger({ version: 1, filesystem, revision: 1, reservations: [] }, filesystem);
      await session.assertHeld(); assertBoundedCapacity(await session.readCapacity(), []);
      await session.publishLedger(null, encode(ledger));
    });
    return new LocalBoundedStorageReservationStore(filesystem, native);
  }
  static async open(filesystemInput: StorageFilesystem, native: BoundedStorageNativeHost): Promise<LocalBoundedStorageReservationStore> {
    const store = new LocalBoundedStorageReservationStore(parseStorageFilesystem(boundedFields(filesystemInput, ["machineId", "uuid", "device"])), native);
    await native.withFilesystemFence(session => store.read(session));
    return store;
  }

  async prepare(input: BoundedStorageRequest): Promise<BoundedStorageReservation> {
    const request = parseBoundedRequest(input), digest = hash(JSON.stringify(request)); // Before first await.
    return this.native.withFilesystemFence(async session => {
      let before = await this.read(session);
      const existing = before.ledger.reservations.find(row => row.request.generation.generationId === request.generation.generationId);
      if (existing) {
        if (existing.requestSha256 !== digest) boundedFailure(BoundedStorageFailure.Conflict);
        // Inspect only. An interrupted prepare is never blindly executed again.
        return this.observe(session, before, existing);
      }
      for (const row of before.ledger.reservations) {
        const observed = await this.observe(session, before, row);
        if (observed.phase !== BoundedStoragePhase.Prepared) boundedFailure(BoundedStorageFailure.Uncertain);
        before = await this.read(session);
      }
      await session.requirePreparationCapability(request, digest);
      const pending = parseBoundedReservation({ request, requestSha256: digest, revision: 1, phase: BoundedStoragePhase.Pending, facts: null });
      const next = parseBoundedLedger({ ...before.ledger, revision: before.ledger.revision + 1, reservations: [...before.ledger.reservations, pending] }, this.filesystem);
      await session.assertHeld(); assertBoundedCapacity(await session.readCapacity(), next.reservations);
      // Native holder fsyncs Pending before any backing allocation/quota effect.
      await session.publishLedger(before.bytes, encode(next));
      before = await this.read(session);
      let facts: BoundedStorageNativeFacts;
      try {
        await session.assertHeld();
        facts = parseBoundedFacts(await session.prepare(request, digest), request, digest);
      } catch (error) {
        // If publication also fails, the durably Pending claim and native intent
        // remain protected. Never erase or replace that uncertainty with success.
        await this.change(session, await this.read(session), pending, BoundedStoragePhase.Unknown, null);
        throw error;
      }
      let phase = BoundedStoragePhase.Prepared;
      try { assertBoundedCapacity(await session.readCapacity(), before.ledger.reservations); }
      catch (error) {
        if (!(error instanceof BoundedStorageError) || error.reason !== BoundedStorageFailure.Capacity) throw error;
        phase = BoundedStoragePhase.Blocked;
      }
      const committed = await this.change(session, before, pending, phase, facts);
      if (phase !== BoundedStoragePhase.Prepared) boundedFailure(BoundedStorageFailure.Capacity);
      return committed; // Physical preparation only; no writer authority.
    });
  }

  async reconcile(generationInput: StorageGeneration): Promise<BoundedStorageReservation> {
    const generation = parseStorageGeneration(boundedFields(generationInput, ["jobId", "generationId", "projectId"]));
    return this.native.withFilesystemFence(async session => {
      const before = await this.read(session);
      return this.observe(session, before, this.required(before.ledger, generation));
    });
  }
  async verifyPrepared(generationInput: StorageGeneration): Promise<BoundedStorageNativeFacts> {
    const generation = parseStorageGeneration(boundedFields(generationInput, ["jobId", "generationId", "projectId"]));
    return this.native.withFilesystemFence(async session => {
      const before = await this.read(session), row = await this.observe(session, before, this.required(before.ledger, generation));
      if (row.phase !== BoundedStoragePhase.Prepared || !row.facts) boundedFailure(BoundedStorageFailure.Uncertain);
      assertBoundedCapacity(await session.readCapacity(), (await this.read(session)).ledger.reservations);
      return row.facts; // A must separately authenticate/pin its completed namespace.
    });
  }

  private async observe(session: BoundedStorageNativeSession, before: Read, row: BoundedStorageReservation): Promise<BoundedStorageReservation> {
    await session.assertHeld();
    const observation = await session.inspect(row.request, row.requestSha256);
    if (observation.kind !== BoundedStorageInspection.Prepared) {
      return this.change(session, before, row, observation.kind === BoundedStorageInspection.Absent ? BoundedStoragePhase.Blocked : BoundedStoragePhase.Unknown, null);
    }
    const facts = parseBoundedFacts(observation.facts, row.request, row.requestSha256);
    if (row.facts) for (const key of ["backingDevice", "backingInode", "backingBytes", "loopDevice", "innerUuid", "payloadDevice", "payloadInode", "payloadMountId", "nativeNamespaceInode"] as const) {
      if (row.facts[key] !== facts[key]) boundedFailure(BoundedStorageFailure.Identity);
    }
    assertBoundedCapacity(await session.readCapacity(), before.ledger.reservations);
    // Fresh usage is observational. It cannot change exposure/revision or force
    // a durable rewrite of every active row on each admission.
    if (row.phase === BoundedStoragePhase.Prepared) return Object.freeze({ ...row, facts });
    return this.change(session, before, row, BoundedStoragePhase.Prepared, facts);
  }
  private async change(session: BoundedStorageNativeSession, before: Read, row: BoundedStorageReservation,
    phase: BoundedStoragePhase, facts: BoundedStorageNativeFacts | null): Promise<BoundedStorageReservation> {
    const next = parseBoundedReservation({ ...row, revision: row.revision + 1, phase, facts });
    const ledger = parseBoundedLedger({ ...before.ledger, revision: before.ledger.revision + 1,
      reservations: before.ledger.reservations.map(r => r.request.generation.generationId === row.request.generation.generationId ? next : r) }, this.filesystem);
    await session.assertHeld(); assertBoundedRootCapacity((await session.readCapacity()).rootAvailableBytes);
    await session.publishLedger(before.bytes, encode(ledger)); return next;
  }
  private required(ledger: BoundedStorageLedger, generation: StorageGeneration): BoundedStorageReservation {
    const row = ledger.reservations.find(r => r.request.generation.generationId === generation.generationId);
    if (!row || !sameStorageGeneration(row.request.generation, generation)) boundedFailure(BoundedStorageFailure.Identity);
    return row;
  }
  private async read(session: BoundedStorageNativeSession): Promise<Read> {
    await session.assertHeld(); const bytes = await session.readLedger();
    if (!bytes || Buffer.byteLength(bytes) > maxLedgerBytes) boundedFailure(BoundedStorageFailure.UnsafeControl);
    const ledger = parseBoundedLedger(JSON.parse(bytes) as unknown, this.filesystem);
    for (const row of ledger.reservations) if (row.requestSha256 !== hash(JSON.stringify(row.request))) boundedFailure(BoundedStorageFailure.Identity);
    return { bytes, ledger };
  }
}
function encode(ledger: BoundedStorageLedger): string {
  const bytes = `${JSON.stringify(ledger)}\n`;
  if (Buffer.byteLength(bytes) > maxLedgerBytes) boundedFailure(BoundedStorageFailure.Exhausted);
  return bytes;
}
