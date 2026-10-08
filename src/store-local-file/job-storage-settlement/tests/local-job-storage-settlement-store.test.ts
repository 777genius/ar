import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { JobStoragePendingReason, JobStorageTransitionStatus } from "../../../worker-core/job-storage/application/job-storage-settlement";
import { JobStorageCapabilityStatus as Capability, JobStorageHomeStateRequirement, JobStorageIntentKind,
  JobStorageProducer, JobStorageSettlementStatus as Status, SourceRecoveryFacet,
  type JobStorageAdmissionReceipt, type JobStorageSettlement } from "../../../worker-core/job-storage/domain/job-storage";
import type { JobStorageGenerationAuthority, JobStorageSourceHandoffPort } from "../../../worker-core/job-storage/ports/job-storage-ports";
import { JobStorageStoreFailure as Failure, LocalJobStorageSettlementStore as Store, settlementFenceName,
  settlementIntentName, settlementRecordName, type LocalJobStorageSettlementOptions } from "../index";

const runFile = promisify(execFile), digest = "a".repeat(64);
async function fixture(continuation = false) {
  // New metadata-only TEST roots. Host orchestration supplies job-owned scratch
  // TMPDIR and may supply an independent persistent control parent. /dev/shm
  // exercises process crash retention, not reboot/power-loss qualification.
  const payload = await realpath(await mkdtemp(join(tmpdir(), "NEWTEST-settlement-payload-")));
  const parent = process.env.SUBSCRIPTION_RUNTIME_TEST_SETTLEMENT_CONTROL_PARENT ?? "/dev/shm";
  const control = await realpath(await mkdtemp(join(parent, "NEWTEST-settlement-control-")));
  await chmod(control, 0o700);
  const info = await stat(control, { bigint: true }), payloadInfo = await stat(payload, { bigint: true });
  if (info.dev === payloadInfo.dev) { await rm(control, { recursive: true }); await rm(payload, { recursive: true }); throw new Error("TEST independent control filesystem required"); }
  const identity = { jobId: `NEWTEST-${randomUUID()}`, generationId: randomUUID(), receiptSha256: digest };
  const receipt: JobStorageAdmissionReceipt = { ...identity, schemaVersion: 1,
    intent: continuation ? { kind: JobStorageIntentKind.Continuation, sessionId: "NEWTEST-session" } :
      { kind: JobStorageIntentKind.NoResume, homeStateRequirement: JobStorageHomeStateRequirement.NoneRequired },
    taskId: "NEWTEST-task", attemptId: "NEWTEST-attempt", producerId: JobStorageProducer.CodexGoalRunner,
    providerBindingSha256: digest, layout: { jobRoot: payload, workspace: join(payload, "workspace"),
      state: join(payload, "state"), home: join(payload, "home"), tmp: join(payload, "tmp") },
    machineId: "b".repeat(32), filesystemUuid: randomUUID(), device: payloadInfo.dev.toString(),
    mountSource: "NEWTEST-device", fsRoot: "/", namespaceId: "NEWTEST-namespace", pinId: "NEWTEST-pin" };
  const order: string[] = [];
  // Contract double only: these tests exercise durable CAS + actual service,
  // and cannot qualify real native drain, admission or proof authenticity.
  const authority: JobStorageGenerationAuthority = {
    async withGenerationFence(_identity, effect) { order.push("fence-enter"); try { return await effect(); } finally { order.push("fence-exit"); } },
    async verifyNativeDrain() { return { status: Capability.Unsupported }; },
  };
  const options: LocalJobStorageSettlementOptions = { identity,
    controlRoot: { path: control, device: info.dev.toString(), inode: info.ino.toString() }, authority,
    async readAuthenticatedReceipt() { order.push("authenticated-receipt"); return receipt; } };
  const store = await Store.create(options);
  const disk = async (): Promise<JobStorageSettlement> => (JSON.parse(await readFile(join(control, settlementRecordName), "utf8")) as { settlement: JobStorageSettlement }).settlement;
  return { payload, control, identity, receipt, authority, options, store, disk, order,
    async cleanup() { await store.close(); await rm(control, { recursive: true }); await rm(payload, { recursive: true }); } };
}
const unsupportedHandoff: JobStorageSourceHandoffPort = { async verify() { return { status: Capability.Unsupported }; } };

describe.skipIf(process.platform !== "linux")("persistent job storage settlement", () => {
  it("initializes from trusted composition under the required outer fence, without a caller verification flag", async () => {
    // Red if initialization is possible from naked input or before native fence.
    const f = await fixture();
    try {
      expect(f.order).toEqual(["fence-enter", "authenticated-receipt", "fence-exit"]);
      expect(await f.disk()).toMatchObject({ ...f.identity, revision: 0, status: Status.Active });
      await expect(Store.open({ ...f.options, authority: undefined } as unknown as LocalJobStorageSettlementOptions)).rejects.toMatchObject({ reason: Failure.Unsupported });
      await expect(Store.open({ ...f.options, readAuthenticatedReceipt: undefined } as unknown as LocalJobStorageSettlementOptions)).rejects.toMatchObject({ reason: Failure.Unsupported });
      await expect(Store.create(f.options)).rejects.toMatchObject({ reason: Failure.Stale });
      expect((await f.disk()).revision).toBe(0);
    } finally { await f.cleanup(); }
  });

  it("actual service preserves terminal/continuation intent and revision across reopen; completed never implies CLOSED", async () => {
    // Red if terminal execution clears intent, resets revision or disposes data.
    const f = await fixture(true); let reopened: Store | undefined;
    try {
      const terminal = await f.store.createService(unsupportedHandoff).observeTerminal(f.identity, 0);
      expect(terminal.status).toBe(JobStorageTransitionStatus.Applied);
      await f.store.close(); reopened = await Store.open(f.options);
      const service = reopened.createService(unsupportedHandoff);
      const close = await service.close(f.identity, 1, "NEWTEST-handoff", "NEWTEST-drain");
      expect(close).toEqual({ status: JobStorageTransitionStatus.Pending, reason: JobStoragePendingReason.ContinuationIntent });
      expect(await f.disk()).toMatchObject({ revision: 1, status: Status.Resumable, intent: f.receipt.intent });
      await service.resume(f.identity, 1);
      expect(await f.disk()).toMatchObject({ revision: 2, status: Status.Active, intent: f.receipt.intent });
    } finally { await reopened?.close(); await f.cleanup(); }
  });

  it("does not accept a payload-filesystem root when the authenticated receipt mutates during filesystem awaits", async () => {
    // Red if connect rereads caller-owned device after realpath/open/stat await.
    const f = await fixture(); let accepted: Store | undefined;
    try {
      const path = join(f.control, "NEWTEST-mutable-receipt"); await mkdir(path, { mode: 0o700 });
      const info = await stat(path, { bigint: true });
      const mutable = { ...f.receipt, device: info.dev.toString() };
      let changed!: () => void;
      const mutation = new Promise<void>(resolve => { changed = resolve; });
      const opening = Store.create({ ...f.options,
        controlRoot: { path, device: info.dev.toString(), inode: info.ino.toString() },
        async readAuthenticatedReceipt() {
          // Receipt resolves in a microtask; setImmediate runs only after connect
          // has consumed it and yielded for real asynchronous filesystem IO.
          setImmediate(() => { mutable.device = f.receipt.device; changed(); });
          return mutable;
        },
      }).then(store => { accepted = store; return store; });
      const rejected = expect(opening).rejects.toMatchObject({ reason: Failure.Unsafe });
      await mutation; await rejected;
      expect(mutable.device).toBe(f.receipt.device);
      expect(await readdir(path)).toEqual([]); // No record, intent or fence admitted.
    } finally { await accepted?.close(); await f.cleanup(); }
  });

  it("two independent instances serialize physical CAS and reject the stale revision without invoking its callback", async () => {
    // Red if instances use only an in-memory mutex or lose a winning revision.
    const f = await fixture(), second = await Store.open(f.options);
    let entered!: () => void, proceed!: () => void, losingCalls = 0;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { proceed = resolve; });
    try {
      const first = f.store.update(f.identity, 0, async current => {
        entered(); await gate; return { next: { ...current, revision: 1, status: Status.Resumable }, result: "committed" };
      });
      await waiting;
      await expect(second.update(f.identity, 0, async () => { losingCalls++; return { result: "lost" }; })).rejects.toMatchObject({ reason: Failure.Busy });
      proceed(); expect(await first).toBe("committed");
      await expect(second.update(f.identity, 0, async () => { losingCalls++; return { result: "lost" }; })).rejects.toMatchObject({ reason: Failure.Stale });
      expect(losingCalls).toBe(0); expect((await f.disk()).revision).toBe(1);
    } finally { proceed(); await second.close(); await f.cleanup(); }
  });

  it("rejects foreign generation/receipt, immutable intent changes, skipped revisions and invalid status transitions", async () => {
    const f = await fixture();
    try {
      for (const identity of [{ ...f.identity, generationId: "NEWTEST-other" }, { ...f.identity, receiptSha256: "c".repeat(64) }]) {
        await expect(f.store.update(identity, 0, async () => ({ result: null }))).rejects.toMatchObject({ reason: Failure.Stale });
        await expect(Store.open({ ...f.options, identity })).rejects.toMatchObject({ reason: Failure.Stale });
      }
      const original = await readFile(join(f.control, settlementRecordName));
      const before = await f.disk();
      for (const next of [{ ...before, revision: 2, status: Status.Resumable }, { ...before, revision: 1, status: Status.Closed },
        { ...before, revision: 1, status: Status.Resumable, intent: { kind: JobStorageIntentKind.Continuation as const, sessionId: "NEWTEST-other" } }]) {
        await expect(f.store.update(f.identity, 0, async () => ({ next, result: null }))).rejects.toMatchObject({ reason: Failure.Invalid });
      }
      expect(await readFile(join(f.control, settlementRecordName))).toEqual(original);
    } finally { await f.cleanup(); }
  });

  it("actual service retains pending handoff/drain and closes only a current verified source and drain revision", async () => {
    const f = await fixture(); let handoffMode = Capability.Unsupported, drainVerified = false, drainCalls = 0;
    const handoff: JobStorageSourceHandoffPort = { async verify(current) {
      if (handoffMode !== Capability.Verified) return { status: Capability.Unsupported };
      return { status: Capability.Verified, identity: current, settlementRevision: current.revision,
        source: { sourceManifestSha256: digest, inventorySha256: digest,
          facets: Object.fromEntries(Object.values(SourceRecoveryFacet).map(facet => [facet, Capability.Verified])) as Record<SourceRecoveryFacet, Capability> },
        outputManifestSha256: digest, evidenceManifestSha256: digest, independentDestinationId: "NEWTEST-independent", readbackReceiptSha256: digest };
    } };
    const authority: JobStorageGenerationAuthority = { ...f.authority, async verifyNativeDrain(current) {
      drainCalls++; return drainVerified ? { status: Capability.Verified, identity: current, settlementRevision: current.revision, nativeFenceSha256: digest } : { status: Capability.Unknown };
    } };
    let target: Store | undefined;
    try {
      await f.store.close(); target = await Store.open({ ...f.options, authority });
      const service = target.createService(handoff);
      expect(await service.close(f.identity, 0, "NEWTEST-handoff", "NEWTEST-drain")).toEqual({ status: JobStorageTransitionStatus.Pending, reason: JobStoragePendingReason.WriterActive });
      await service.observeTerminal(f.identity, 0);
      expect(await target.createService().close(f.identity, 1, "NEWTEST-handoff", "NEWTEST-drain")).toEqual({ status: JobStorageTransitionStatus.Pending, reason: JobStoragePendingReason.SourceHandoff });
      expect(drainCalls).toBe(0); handoffMode = Capability.Verified;
      expect(await service.close(f.identity, 1, "NEWTEST-handoff", "NEWTEST-drain")).toEqual({ status: JobStorageTransitionStatus.Pending, reason: JobStoragePendingReason.NativeDrain });
      expect(await f.disk()).toMatchObject({ revision: 1, status: Status.Resumable }); drainVerified = true;
      const closed = await service.close(f.identity, 1, "NEWTEST-handoff", "NEWTEST-drain");
      expect(closed.status).toBe(JobStorageTransitionStatus.Applied);
      expect(await f.disk()).toMatchObject({ revision: 2, status: Status.Closed });
      await expect(service.resume(f.identity, 2)).rejects.toThrow("job_storage_resume_invalid");
      await expect(service.close(f.identity, 2, "NEWTEST-handoff", "NEWTEST-drain")).rejects.toThrow("job_storage_generation_closed");
    } finally { await target?.close(); await f.cleanup(); }
  });

  it("refuses substituted roots and symlink/hardlink records, retaining the original authority bytes", async () => {
    const f = await fixture();
    try {
      const record = join(f.control, settlementRecordName), backup = join(f.control, "original-record");
      await rename(record, backup); await symlink(backup, record);
      await expect(f.store.update(f.identity, 0, async () => ({ result: null }))).rejects.toMatchObject({ reason: Failure.Unsafe });
      await unlink(record); await link(backup, record);
      await expect(Store.open(f.options)).rejects.toMatchObject({ reason: Failure.Unsafe });
      await unlink(record); await rename(backup, record);
      const moved = f.control + "-retained"; await rename(f.control, moved); await mkdir(f.control, { mode: 0o700 });
      try {
        await expect(Store.create(f.options)).rejects.toMatchObject({ reason: Failure.Unsafe });
        await expect(f.store.update(f.identity, 0, async () => ({ result: null }))).rejects.toMatchObject({ reason: Failure.Unsafe });
        expect((JSON.parse(await readFile(join(moved, settlementRecordName), "utf8")) as { settlement: JobStorageSettlement }).settlement.revision).toBe(0);
      } finally { await rm(f.control, { recursive: true }); await rename(moved, f.control); }
    } finally { await f.cleanup(); }
  });

  it("holds a crashed process's durable fence across fresh instances without PID/TTL takeover", async () => {
    // Red if actual service crash is treated as terminal/drained or loses CAS fencing.
    const f = await fixture();
    try {
      await f.store.createService(unsupportedHandoff).observeTerminal(f.identity, 0); await f.store.close();
      const helper = fileURLToPath(new URL("./fixtures/settlement-crash-process.ts", import.meta.url));
      await expect(runFile(process.execPath, ["--experimental-strip-types", helper,
        resolve("dist/store-local-file/job-storage-settlement/index.js"), JSON.stringify(f.options.controlRoot), JSON.stringify(f.receipt)],
      { timeout: 10000 })).rejects.toMatchObject({ code: 23 });
      const retained = await readFile(join(f.control, settlementFenceName));
      for (let attempt = 0; attempt < 2; attempt++) await expect(Store.open(f.options)).rejects.toMatchObject({ reason: Failure.Busy });
      expect(await readFile(join(f.control, settlementFenceName))).toEqual(retained);
      expect(await f.disk()).toMatchObject({ revision: 1, status: Status.Resumable });
    } finally { await f.cleanup(); }
  });

  it("retains an incomplete publication intent even after its lock is absent, never erasing or replaying it", async () => {
    const f = await fixture();
    try {
      const before = await readFile(join(f.control, settlementRecordName));
      const intent = Buffer.from('{"schemaVersion":1,"partial":"NEWTEST-interrupted-publication"}\n');
      await writeFile(join(f.control, settlementIntentName), intent, { mode: 0o600, flag: "wx" });
      await expect(f.store.update(f.identity, 0, async () => ({ result: null }))).rejects.toMatchObject({ reason: Failure.Uncertain });
      await expect(Store.open(f.options)).rejects.toMatchObject({ reason: Failure.Busy });
      expect(await readFile(join(f.control, settlementIntentName))).toEqual(intent);
      expect(await readFile(join(f.control, settlementRecordName))).toEqual(before);
      expect((await stat(join(f.control, settlementFenceName))).isFile()).toBe(true);
    } finally { await f.cleanup(); }
  });
});
