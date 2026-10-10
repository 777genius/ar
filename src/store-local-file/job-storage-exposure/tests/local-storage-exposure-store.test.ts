import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { StorageAccountingResultKind, StorageExposureAccounting, StorageExposureFailure,
  StorageExposurePhase, StorageKernelResultKind, StorageObservedWriter, parseStorageLedger, storageFullExposure,
  unsupportedStorageExposureKernel, type StorageAmounts, type StorageCapacitySnapshot,
  type StorageDrainSealProof, type StorageExposureClaim, type StorageExposureKernelPort,
  type StorageExposureLedger, type StorageExposureRequest, type StorageFilesystem, type StorageGeneration,
  type StorageQuotaProof } from "../../../worker-core/job-storage-exposure/index";
import { LocalStorageExposureStore as Store, storageExposureFenceName, storageExposureLedgerName } from "../index";
import { withCompiledTestFixture } from "../../tests/compiled-test-fixture";

const runFile = promisify(execFile), GiB = 1073741824n;
function amounts(bytes: bigint, inodes = 4096n): StorageAmounts { return { bytes: bytes.toString(), inodes: inodes.toString() }; }
function generation(jobId = `test-job-${randomUUID()}`, projectId = 1): StorageGeneration { return { jobId, projectId, generationId: randomUUID() }; }
function proof(filesystem: StorageFilesystem, claim: StorageExposureClaim): StorageQuotaProof {
  return { filesystem, generation: claim.generation, operationId: claim.operationId,
    baseline: claim.baseline, cap: claim.cap, inheritanceVerified: true, sealedBaselineVerified: true,
    writeSurfaceVerified: true, digest: "b".repeat(64) };
}
function drain(filesystem: StorageFilesystem, claim: StorageExposureClaim, operationId: string): StorageDrainSealProof {
  return { filesystem, generation: claim.generation, claimRevision: claim.revision, operationId,
    writerDrained: true, descendantsDrained: true, referencesDrained: true, quotaSealed: true, digest: "c".repeat(64) };
}
async function fixture() {
  // These are fresh metadata-only TEST roots, not actual project/quota mounts.
  // Hosted test orchestration supplies its job-owned scratch TMPDIR.
  const testRoot = await realpath(await mkdtemp(join(tmpdir(), "NEWTEST-storage-exposure-")));
  const rootPath = join(testRoot, "private-control"); await mkdir(rootPath, { mode: 0o700 });
  const filesystem: StorageFilesystem = { machineId: "a".repeat(32), uuid: "d0f2cac1-2009-4e9d-a710-e156f417938f",
    device: ((await stat(rootPath, { bigint: true })).dev + 1n).toString() };
  const store = await Store.create({ rootPath, filesystem });
  let available = amounts(32n * GiB, 100000n), rootAvailableBytes = (8n * GiB).toString();
  const capacity = { async readCapacity(): Promise<StorageCapacitySnapshot> { return { filesystem, available, rootAvailableBytes }; } };
  const published = async (): Promise<StorageExposureLedger> => parseStorageLedger(JSON.parse(await readFile(join(rootPath, storageExposureLedgerName), "utf8")));
  const accounting = (kernel = unsupportedStorageExposureKernel(), target = store) => new StorageExposureAccounting(filesystem, target, capacity, kernel);
  const request = (id: StorageGeneration, bytes = 2n * GiB): StorageExposureRequest => ({ filesystem, generation: id,
    operationId: randomUUID(), baseline: amounts(0n, 0n), growth: amounts(bytes), cap: amounts(bytes) });
  return { testRoot, rootPath, filesystem, store, capacity, accounting, published, request,
    setAvailable(next: StorageAmounts) { available = next; },
    setRootAvailable(bytes: bigint) { rootAvailableBytes = bytes.toString(); },
    async cleanup() { await store.close(); await rm(testRoot, { recursive: true }); } };
}

describe.skipIf(process.platform !== "linux")("durable full-Q storage exposure", () => {
  it("charges resume baseline6+growth2 as cap8 across reopen and rejects empty growth2/cap10", async () => {
    // Red if a restart loses baseline/claim or an estimated cap exceeds G.
    const sample = await fixture(); let reopened: Store | undefined;
    try {
      const id = generation(), request = { ...sample.request(id), baseline: amounts(6n * GiB, 600n),
        growth: amounts(2n * GiB, 200n), cap: amounts(8n * GiB, 800n) };
      const first = await sample.accounting().reserve(request);
      expect(first.phase).toBe(StorageExposurePhase.Pending);
      await sample.store.close(); reopened = await Store.open(sample);
      const duplicate = await sample.accounting(undefined, reopened).reserve(request);
      expect(duplicate.revision).toBe(1);
      const ledger = await reopened.withFilesystemFence(tx => tx.read());
      expect(storageFullExposure(ledger.claims)).toEqual({ bytes: "8589934592", inodes: "800" });
      expect(ledger.claims[0]?.growth).toEqual({ bytes: "2147483648", inodes: "200" });
      const invalid = { ...sample.request(generation(undefined, 2)), cap: amounts(10n * GiB) };
      await expect(sample.accounting(undefined, reopened).reserve(invalid)).rejects.toMatchObject({ reason: StorageExposureFailure.Invalid });
      expect((await sample.published()).claims).toHaveLength(1);
    } finally { await reopened?.close(); await sample.cleanup(); }
  });

  it("available7 - oldQ2 - newQ1 rejects at floor5 despite write/delete observations", async () => {
    const sample = await fixture();
    try {
      sample.setAvailable(amounts(7n * GiB, 100000n));
      await sample.accounting().reserve(sample.request(generation("test-old", 1)));
      const next = sample.request(generation("test-new", 2), GiB);
      for (const actualAvailable of [7n * GiB, 6n * GiB, 7n * GiB]) {
        sample.setAvailable(amounts(actualAvailable, 100000n));
        await expect(sample.accounting().reserve(next)).rejects.toMatchObject({ reason: StorageExposureFailure.Capacity });
      }
      const ledger = await sample.published();
      expect(ledger.claims).toHaveLength(1);
      expect(storageFullExposure(ledger.claims).bytes).toBe("2147483648");
      expect(ledger.revision).toBe(2);
    } finally { await sample.cleanup(); }
  });

  it("enforces inode floor independently and also refuses insufficient root reserve", async () => {
    const sample = await fixture();
    try {
      sample.setAvailable(amounts(32n * GiB, 50010n));
      await sample.accounting().reserve({ ...sample.request(generation("test-inode-old", 1)), growth: amounts(1024n, 5n), cap: amounts(1024n, 5n) });
      const next = { ...sample.request(generation("test-inode-new", 2)), growth: amounts(1024n, 6n), cap: amounts(1024n, 6n) };
      await expect(sample.accounting().reserve(next)).rejects.toMatchObject({ reason: StorageExposureFailure.Capacity });
      sample.setAvailable(amounts(32n * GiB, 100000n)); sample.setRootAvailable(5n * GiB - 1n);
      await expect(sample.accounting().reserve(next)).rejects.toMatchObject({ reason: StorageExposureFailure.Capacity });
      expect(storageFullExposure((await sample.published()).claims).inodes).toBe("5");
    } finally { await sample.cleanup(); }
  });

  it("rejects overflow, zero unlimited caps and noncanonical quantities before changing disk authority", async () => {
    const sample = await fixture();
    try {
      const original = await readFile(join(sample.rootPath, storageExposureLedgerName));
      for (const value of ["01", "-1", "1.5", "18446744073709551616"]) {
        const input = sample.request(generation());
        await expect(sample.accounting().reserve({ ...input, growth: { ...input.growth, bytes: value } }))
          .rejects.toMatchObject({ reason: StorageExposureFailure.Invalid });
      }
      const zero = { ...sample.request(generation()), growth: amounts(0n, 0n), cap: amounts(0n, 0n) };
      await expect(sample.accounting().reserve(zero)).rejects.toMatchObject({ reason: StorageExposureFailure.Invalid });
      expect(await readFile(join(sample.rootPath, storageExposureLedgerName))).toEqual(original);
    } finally { await sample.cleanup(); }
  });

  it("captures caller budget and generation before an awaited host snapshot", async () => {
    const sample = await fixture(); let entered!: () => void, proceed!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { proceed = resolve; });
    const input = sample.request(generation("test-mutable-request", 1));
    const originalGeneration = { ...input.generation };
    try {
      const accounting = new StorageExposureAccounting(sample.filesystem, sample.store, {
        async readCapacity() { entered(); await gate; return sample.capacity.readCapacity(); },
      }, unsupportedStorageExposureKernel());
      const reserved = accounting.reserve(input); await waiting;
      // Caller mutation cannot raise quota after the request was validated.
      (input.growth as { bytes: string }).bytes = "10737418240";
      (input.cap as { bytes: string }).bytes = "10737418240";
      (input.generation as { projectId: number }).projectId = 10;
      proceed(); await reserved;
      const disk = (await sample.published()).claims[0]!;
      expect(disk.generation).toEqual(originalGeneration);
      expect(disk.cap.bytes).toBe("2147483648");
    } finally { proceed(); await sample.cleanup(); }
  });

  it("serializes two physical-store instances before the same available snapshot can over-admit", async () => {
    // Red if the fence is per job, in-memory only, or does not cover statfs.
    const sample = await fixture(), second = await Store.open(sample);
    let entered!: () => void, proceed!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { proceed = resolve; });
    try {
      sample.setAvailable(amounts(8n * GiB, 100000n));
      const first = new StorageExposureAccounting(sample.filesystem, sample.store, {
        async readCapacity(fs) { entered(); await gate; return sample.capacity.readCapacity(); },
      }, unsupportedStorageExposureKernel());
      const reservation = first.reserve(sample.request(generation("test-concurrent-a", 1)));
      await waiting;
      const next = sample.request(generation("test-concurrent-b", 2));
      await expect(sample.accounting(undefined, second).reserve(next)).rejects.toMatchObject({ reason: StorageExposureFailure.Busy });
      proceed(); await reservation;
      await expect(sample.accounting(undefined, second).reserve(next)).rejects.toMatchObject({ reason: StorageExposureFailure.Capacity });
      expect((await sample.published()).claims).toHaveLength(1);
    } finally { proceed(); await second.close(); await sample.cleanup(); }
  });

  it("unsupported native enforcement preserves pending fullQ and grants no writer barrier", async () => {
    const sample = await fixture();
    try {
      const claim = await sample.accounting().reserve(sample.request(generation()));
      const result = await sample.accounting().activate(claim.generation, claim.revision);
      expect(result.kind).toBe(StorageAccountingResultKind.Unsupported);
      expect(result.claim.phase).toBe(StorageExposurePhase.Pending);
      expect((await sample.published()).claims[0]?.quotaProof).toBeNull();
      expect(storageFullExposure((await sample.published()).claims)).toEqual({ bytes: "2147483648", inodes: "4096" });
    } finally { await sample.cleanup(); }
  });

  it("publishes pending before quota verification, and verified facts before opening the barrier", async () => {
    // Native contract double inspects real durable publication. This proves
    // orchestration order, not physical kernel quota/inheritance enforcement.
    const sample = await fixture(), observed: StorageExposurePhase[] = [];
    const kernel: StorageExposureKernelPort = { ...unsupportedStorageExposureKernel(),
      async prepareOrVerifyQuota(fs, claim) {
        const disk = (await sample.published()).claims[0]!;
        expect(disk.phase).toBe(StorageExposurePhase.Pending); expect(disk.cap.bytes).toBe("2147483648");
        expect(Object.isFrozen(claim)).toBe(true); expect(Object.isFrozen(claim.cap)).toBe(true);
        observed.push(disk.phase); return { kind: StorageKernelResultKind.Verified, value: proof(fs, claim) };
      },
      async openWriterBarrier(fs, claim) {
        const disk = (await sample.published()).claims[0]!;
        expect(disk.phase).toBe(StorageExposurePhase.Verified); expect(disk.quotaProof?.cap.bytes).toBe("2147483648");
        observed.push(disk.phase); return { kind: StorageKernelResultKind.Verified, value: proof(fs, claim) };
      },
    };
    try {
      const claim = await sample.accounting(kernel).reserve(sample.request(generation()));
      const active = await sample.accounting(kernel).activate(claim.generation, claim.revision);
      expect(active.kind).toBe(StorageAccountingResultKind.Completed); expect(active.claim.phase).toBe(StorageExposurePhase.Active);
      expect(observed).toEqual([StorageExposurePhase.Pending, StorageExposurePhase.Verified]);
      expect((await sample.published()).claims[0]?.revision).toBe(3);
    } finally { await sample.cleanup(); }
  });

  it("durably increases both commitments before grow, retains uncertainty, and reconciles without usage credit", async () => {
    const sample = await fixture(); let calls = 0, observedPending: StorageExposureClaim | undefined;
    const kernel: StorageExposureKernelPort = { ...unsupportedStorageExposureKernel(),
      async prepareOrVerifyQuota(fs, claim) { return { kind: StorageKernelResultKind.Verified, value: proof(fs, claim) }; },
      async openWriterBarrier(fs, claim) { return { kind: StorageKernelResultKind.Verified, value: proof(fs, claim) }; },
      async growQuota() {
        calls += 1; observedPending = (await sample.published()).claims[0];
        throw new Error("TEST lost native acknowledgement");
      },
      async reconcileQuota(fs, claim) { return { kind: StorageKernelResultKind.Verified,
        value: { proof: proof(fs, claim), writer: StorageObservedWriter.Active } }; },
    };
    try {
      const accounting = sample.accounting(kernel), reserved = await accounting.reserve(sample.request(generation()));
      const active = (await accounting.activate(reserved.generation, reserved.revision)).claim;
      const growth = { generation: active.generation, expectedRevision: active.revision, operationId: randomUUID(), growth: amounts(4n * GiB, 8192n) };
      const outcome = await accounting.grow(growth);
      // Assert outside the native uncertainty catcher: a failed ordering
      // assertion must not masquerade as the deliberate lost acknowledgement.
      expect(observedPending?.phase).toBe(StorageExposurePhase.GrowPending);
      expect(observedPending?.cap).toEqual({ bytes: "4294967296", inodes: "8192" });
      expect(outcome.kind).toBe(StorageAccountingResultKind.Uncertain); expect(outcome.claim.phase).toBe(StorageExposurePhase.Unknown);
      const duplicate = await accounting.grow(growth);
      expect(duplicate.kind).toBe(StorageAccountingResultKind.Uncertain); expect(calls).toBe(1);
      expect(storageFullExposure((await sample.published()).claims)).toEqual({ bytes: "4294967296", inodes: "8192" });
      const reconciled = await accounting.reconcile(active.generation, outcome.claim.revision);
      expect(reconciled.claim.phase).toBe(StorageExposurePhase.Active);
      expect(storageFullExposure((await sample.published()).claims).bytes).toBe("4294967296");
      await expect(accounting.grow({ ...growth, operationId: randomUUID(), expectedRevision: reconciled.claim.revision,
        growth: amounts(5n * GiB, 8191n) })).rejects.toMatchObject({ reason: StorageExposureFailure.Conflict });
    } finally { await sample.cleanup(); }
  });

  it("failed/foreign quota proof holds uncertainty instead of returning to an activatable verified state", async () => {
    const sample = await fixture(); let barrierCalls = 0;
    const kernel: StorageExposureKernelPort = { ...unsupportedStorageExposureKernel(),
      async prepareOrVerifyQuota(fs, claim) { return { kind: StorageKernelResultKind.Verified, value: proof(fs, claim) }; },
      async openWriterBarrier(fs, claim) {
        barrierCalls += 1; return { kind: StorageKernelResultKind.Verified,
          value: { ...proof(fs, claim), generation: { ...claim.generation, generationId: randomUUID() } } };
      },
    };
    try {
      const accounting = sample.accounting(kernel), pending = await accounting.reserve(sample.request(generation()));
      const result = await accounting.activate(pending.generation, pending.revision);
      expect(result.kind).toBe(StorageAccountingResultKind.Uncertain); expect(result.claim.phase).toBe(StorageExposurePhase.Unknown);
      await expect(accounting.activate(pending.generation, result.claim.revision)).rejects.toMatchObject({ reason: StorageExposureFailure.Conflict });
      expect(barrierCalls).toBe(1); expect(storageFullExposure((await sample.published()).claims).bytes).toBe("2147483648");
    } finally { await sample.cleanup(); }
  });

  it("releases only current revision after native drain+seal and never reuses the project ID", async () => {
    const sample = await fixture(); let valid = false, calls = 0;
    const kernel: StorageExposureKernelPort = { ...unsupportedStorageExposureKernel(),
      async withDrainedQuotaSeal(fs, claim, operationId, commit) {
        calls += 1;
        const seal = drain(fs, claim, operationId);
        if (!valid) return { kind: StorageKernelResultKind.Uncertain };
        const value = await commit(seal);
        expect((await sample.published()).claims[0]?.phase).toBe(StorageExposurePhase.Released);
        return { kind: StorageKernelResultKind.Verified, value };
      },
    };
    try {
      const accounting = sample.accounting(kernel), pending = await accounting.reserve(sample.request(generation()));
      const operationId = randomUUID();
      const retained = await accounting.release({ generation: pending.generation, expectedRevision: pending.revision, operationId });
      expect(retained.claim.phase).toBe(StorageExposurePhase.Unknown);
      expect(storageFullExposure((await sample.published()).claims).bytes).toBe("2147483648");
      valid = true;
      await expect(accounting.release({ generation: pending.generation, expectedRevision: pending.revision, operationId }))
        .rejects.toMatchObject({ reason: StorageExposureFailure.Stale });
      const released = await accounting.release({ generation: pending.generation, expectedRevision: retained.claim.revision, operationId });
      expect(released.claim.phase).toBe(StorageExposurePhase.Released);
      expect(storageFullExposure((await sample.published()).claims)).toEqual({ bytes: "0", inodes: "0" });
      await accounting.release({ generation: pending.generation, expectedRevision: retained.claim.revision, operationId });
      expect(calls).toBe(2);
      await expect(accounting.reserve(sample.request(generation("test-reuse", pending.generation.projectId))))
        .rejects.toMatchObject({ reason: StorageExposureFailure.Conflict });
    } finally { await sample.cleanup(); }
  });

  it("persistent CAS cannot omit claims, skip sealing, reset history or change filesystem identity", async () => {
    const sample = await fixture();
    try {
      await sample.accounting().reserve(sample.request(generation()));
      await sample.store.withFilesystemFence(async tx => {
        const ledger = await tx.read();
        await expect(tx.persist(ledger.revision, { ...ledger, revision: ledger.revision + 1, claims: [] }))
          .rejects.toMatchObject({ reason: StorageExposureFailure.Invalid });
        const claim = ledger.claims[0]!;
        await expect(tx.persist(ledger.revision, { ...ledger, revision: ledger.revision + 1,
          claims: [{ ...claim, phase: StorageExposurePhase.Released, revision: claim.revision + 1 }] }))
          .rejects.toMatchObject({ reason: StorageExposureFailure.Invalid });
      });
      await expect(Store.create(sample)).rejects.toMatchObject({ reason: StorageExposureFailure.Conflict });
      await expect(sample.accounting().reserve({ ...sample.request(generation("test-other", 2)),
        filesystem: { ...sample.filesystem, uuid: randomUUID() } })).rejects.toMatchObject({ reason: StorageExposureFailure.IdentityChanged });
      expect((await sample.published()).claims).toHaveLength(1);
    } finally { await sample.cleanup(); }
  });

  it("hard process exit retains a real fsynced pending claim and publication fence, without PID/TTL takeover", async () => {
    // Child exits during the native boundary after reserve completed on disk.
    // No source/mock assertion can prove the cross-process retained fence.
    const sample = await fixture(); let reopened: Store | undefined;
    try {
      await sample.store.close();
      const helper = fileURLToPath(new URL("./fixtures/storage-exposure-crash-process.ts", import.meta.url));
      await withCompiledTestFixture(helper, sample.testRoot, async compiledHelper => {
        await expect(runFile(process.execPath, [compiledHelper,
          resolve("dist/store-local-file/job-storage-exposure/index.js"), resolve("dist/worker-core/job-storage-exposure/index.js"),
          sample.rootPath, JSON.stringify(sample.filesystem)], { timeout: 5000, maxBuffer: 4096 })).rejects.toMatchObject({ code: 23 });
      });
      const ledger = await sample.published();
      expect(ledger.claims[0]?.phase).toBe(StorageExposurePhase.Pending);
      expect(storageFullExposure(ledger.claims)).toEqual({ bytes: "8589934592", inodes: "800" });
      const fence = join(sample.rootPath, storageExposureFenceName);
      expect((await lstat(fence)).isFile()).toBe(true);
      const ancient = new Date(0); const { utimes } = await import("node:fs/promises"); await utimes(fence, ancient, ancient);
      reopened = await Store.open(sample);
      await expect(reopened.withFilesystemFence(tx => tx.read())).rejects.toMatchObject({ reason: StorageExposureFailure.Busy });
      expect(storageFullExposure((await sample.published()).claims).bytes).toBe("8589934592");
    } finally { await reopened?.close(); await sample.cleanup(); }
  });

  it("rejects grafted hardlinks, symlinks and control-root substitution without overwriting evidence", async () => {
    const sample = await fixture();
    try {
      const ledgerPath = join(sample.rootPath, storageExposureLedgerName), original = await readFile(ledgerPath);
      await link(ledgerPath, join(sample.testRoot, "retained-hardlink"));
      await expect(sample.store.withFilesystemFence(tx => tx.read())).rejects.toMatchObject({ reason: StorageExposureFailure.UnsafeStore });
      await rm(join(sample.testRoot, "retained-hardlink"));
      await rename(ledgerPath, join(sample.testRoot, "retained-ledger"));
      await symlink(join(sample.testRoot, "retained-ledger"), ledgerPath);
      await expect(sample.store.withFilesystemFence(tx => tx.read())).rejects.toMatchObject({ reason: StorageExposureFailure.UnsafeStore });
      await rm(ledgerPath); await rename(join(sample.testRoot, "retained-ledger"), ledgerPath);
      await rename(sample.rootPath, join(sample.testRoot, "retained-control")); await mkdir(sample.rootPath, { mode: 0o700 });
      await writeFile(join(sample.rootPath, "sentinel"), "TEST replacement retained");
      await expect(sample.store.withFilesystemFence(tx => tx.read())).rejects.toMatchObject({ reason: StorageExposureFailure.UnsafeStore });
      expect(await readdir(sample.rootPath)).toEqual(["sentinel"]);
      expect(await readFile(join(sample.testRoot, "retained-control", storageExposureLedgerName))).toEqual(original);
    } finally { await sample.cleanup(); }
  });
});
