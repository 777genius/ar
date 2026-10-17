import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, realpath, rename, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BoundedStorageFailure, BoundedStoragePhase, type BoundedStorageLedger, type BoundedStorageRequest } from "../../src/worker-core/storage/bounded-storage-contract";
import { parseBoundedLedger } from "../../src/worker-core/storage/bounded-storage-policy";
import { LocalBoundedStorageReservationStore } from "../../src/store-local-file/storage/local-bounded-storage-reservation-store";
import type { BoundedStorageNativeHost } from "../../src/worker-core/storage/bounded-storage-contract";
import { NewDedicatedTestRootProbe, type NewDedicatedTestHost, type NewDedicatedTestOwner, type NewDedicatedTestObservation } from "./native-bounded-storage-host";
import { prepareNewTestB1, observeOwnedFenceWait, retainOwnedTestProcess, observeOwnedTestTermination } from "../../scripts/e2e-storage/prepare-new-test-b1";

/** Explicit operator selection only, after independent source review. Every
 * invocation creates a NEW native owner/whole FS; nothing adopts a manifest FS.
 * UNRUN in the source worker. Absence of creation input is a failure, never skip. */
const creationPath = process.env.BOUNDED_STORAGE_NEW_TEST_CREATION;
const deathFixtures = [
  { prepare: false, path: process.env.BOUNDED_STORAGE_NEW_TEST_OWNER_DEATH_PENDING_CREATION },
  { prepare: true, path: process.env.BOUNDED_STORAGE_NEW_TEST_OWNER_DEATH_PREPARE_CREATION },
] as const;
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
let native: BoundedStorageNativeHost;
let boundary: NewDedicatedTestHost;
let owner: NewDedicatedTestOwner;
let observation: NewDedicatedTestObservation;
let lifetime: Promise<void>;
let releaseOwner: () => void;
let store: LocalBoundedStorageReservationStore;
let prepared: BoundedStorageRequest;
async function boundedText(fd: FileHandle, maximum: number): Promise<string> {
  const before = await fd.stat({ bigint: true });
  if (before.size > BigInt(maximum)) throw new Error("oversized_TEST_metadata");
  const bytes = Buffer.alloc(Number(before.size) + 1);
  let used = 0;
  while (used < bytes.length) { const r = await fd.read(bytes, used, bytes.length - used, used); if (!r.bytesRead) break; used += r.bytesRead; }
  const after = await fd.stat({ bigint: true });
  expect([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs]).toStrictEqual([before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs]);
  expect(used).toBe(Number(before.size));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
}
async function diskLedger(name = "bounded-storage-ledger.json"): Promise<{ bytes: string; ledger: BoundedStorageLedger }> {
  const fd = await open(join(observation.controlRoot, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await fd.stat({ bigint: true });
    expect(s.uid).toBe(0n); expect(s.nlink).toBe(1n); expect(s.mode & 0o7777n).toBe(0o600n);
    expect(s.size).toBeLessThanOrEqual(4194304n);
    const bytes = await boundedText(fd, 4194304);
    return { bytes, ledger: parseBoundedLedger(JSON.parse(bytes) as unknown, observation.filesystem) };
  } finally { await fd.close(); }
}
describe("actual native bounded backend - NEW dedicated TEST only", () => {
  beforeAll(async () => {
    if (process.platform !== "linux" || process.getuid?.() !== 0 || !creationPath || !isAbsolute(creationPath)) throw new Error("NEW_TEST_creation_required_UNRUN_is_not_evidence");
    const inputs = [creationPath, ...deathFixtures.map(fixture => fixture.path)];
    if (inputs.some(path => !path || !isAbsolute(path))) throw new Error("NEW_TEST_fresh_owner_death_creation_required");
    const canonical = await Promise.all(inputs.map(path => realpath(path!)));
    if (new Set(canonical).size !== inputs.length) throw new Error("NEW_TEST_owner_death_creation_must_be_separate");
    let ready!: () => void, failed!: (error: unknown) => void;
    const initialized = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    const lifetimeEnd = new Promise<void>(resolve => { releaseOwner = resolve; });
    lifetime = prepareNewTestB1(creationPath, async original => {
      owner = original; observation = original.observation;
      const admission = await original.admitPreparation(); native = admission.host; boundary = admission.host; prepared = admission.request;
      expect(observation.filesystem.device).not.toBe(String((await lstat("/srv/workers", { bigint: true })).dev));
      // Competing first holder before ledger initialization. The canonical
      // holder actually reaches the fence; a different root refuses beforehand.
      await native.withFilesystemFence(async session => {
        await session.assertHeld();
        await expect(owner.probeRoot(NewDedicatedTestRootProbe.CompetingControl)).rejects.toMatchObject({ reason: BoundedStorageFailure.Identity });
        expect(await session.readLedger()).toBeNull();
      });
      await expect(lstat(join(observation.controlRoot, "test-competing-control", "bounded-storage.fence"))).rejects.toMatchObject({ code: "ENOENT" });
      store = await LocalBoundedStorageReservationStore.initialize(observation.filesystem, native);
      ready(); await lifetimeEnd;
    });
    void lifetime.catch(failed);
    await initialized;
  });
  afterAll(async () => { releaseOwner?.(); if (lifetime) await lifetime; });
  // Red if distinct processes can pass the fence concurrently or replace its
  // inode: the second native process is actually blocked in kernel flock.
  it("uses one stable fence across independent native holders", async () => {
    let enteredFirst!: () => void, releaseFirst!: () => void;
    const entered = new Promise<void>(resolve => { enteredFirst = resolve; });
    const release = new Promise<void>(resolve => { releaseFirst = resolve; });
    const order: string[] = [];
    let firstPid = 0;
    owner.onLockAttempt(pid => { firstPid = pid; });
    const first = native.withFilesystemFence(async session => { await session.assertHeld(); order.push("first"); enteredFirst(); await release; order.push("first-done"); });
    const firstResult = first.then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    let secondResult: Promise<{ error: unknown }> | undefined;
    let attemptTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([entered, firstResult.then(result => { throw result.error ?? new Error("first_holder_did_not_enter"); })]);
      const lockBefore = await lstat(join(observation.controlRoot, "bounded-storage.fence"), { bigint: true });
      let attempted!: (value: { pid: number; device: string; inode: string }) => void;
      const actualAttempt = new Promise<{ pid: number; device: string; inode: string }>(resolve => { attempted = resolve; });
      owner.onLockAttempt((pid, device, inode) => { attempted({ pid, device, inode }); });
      const second = native.withFilesystemFence(async session => { await session.assertHeld(); order.push("second"); });
      // A startup refusal must release the first holder too; a Vitest timeout
      // does not cancel an awaiting callback or enter its finally block.
      secondResult = second.then(() => ({ error: undefined }), (error: unknown) => ({ error }));
      const wait = await Promise.race([actualAttempt,
        secondResult.then(result => { throw result.error ?? new Error("second_holder_passed_before_kernel_wait"); }),
        new Promise<never>((_resolve, reject) => { attemptTimer = setTimeout(() => reject(new Error("second_native_WAIT_deadline")), 5000); }),
      ]);
      clearTimeout(attemptTimer);
      expect([wait.device, wait.inode]).toStrictEqual([String(lockBefore.dev), String(lockBefore.ino)]);
      const proof = await observeOwnedFenceWait(observation.ownerPid, firstPid, wait.pid, lockBefore.dev, lockBefore.ino);
      console.info("NEW_TEST_fence_kernel_wait", JSON.stringify(proof));
      expect(order).toStrictEqual(["first"]);
      // Release only after the kernel has independently shown the exact wait.
      releaseFirst();
      const results = await Promise.all([firstResult, secondResult]);
      for (const result of results) if (result.error) throw result.error;
      const lockAfter = await lstat(join(observation.controlRoot, "bounded-storage.fence"), { bigint: true });
      expect(order).toStrictEqual(["first", "first-done", "second"]);
      expect([lockAfter.dev, lockAfter.ino]).toStrictEqual([lockBefore.dev, lockBefore.ino]);
    } finally {
      clearTimeout(attemptTimer); owner.onLockAttempt(undefined); releaseFirst();
      await firstResult; if (secondResult) await secondResult;
    }
  }, 15000);
  it("refuses later competing control roots and subtree roots before a fence or debit", async () => {
    const before = (await diskLedger()).bytes;
    await expect(owner.probeRoot(NewDedicatedTestRootProbe.CompetingControl)).rejects.toMatchObject({ reason: BoundedStorageFailure.Identity });
    await expect(owner.probeRoot(NewDedicatedTestRootProbe.Subtree)).rejects.toMatchObject({ reason: BoundedStorageFailure.Uncertain });
    await expect(owner.probeRoot(NewDedicatedTestRootProbe.LegacySession)).rejects.toMatchObject({ reason: BoundedStorageFailure.Identity });
    expect((await diskLedger()).bytes).toBe(before);
    await expect(lstat(join(observation.controlRoot, "test-competing-control", "bounded-storage.fence"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses a stale native ledger CAS without publishing a new intent or losing bytes", async () => {
    const before = (await diskLedger()).bytes;
    await expect(native.withFilesystemFence(session => session.publishLedger("stale_expected_bytes", before)))
      .rejects.toMatchObject({ reason: BoundedStorageFailure.Conflict });
    expect((await diskLedger()).bytes).toBe(before);
    await expect(lstat(join(observation.controlRoot, "bounded-storage.intent"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  // No mocked quota facts: actual mke2fs + loop + mounted ext4 + quotactl_fd.
  // Red if Prepared can precede physical backing/geometry/exact both limits.
  it("prepares real full allocation and verifies both limits and inherited layout", async () => {
    const result = await store.prepare(prepared);
    expect(result.phase).toBe(BoundedStoragePhase.Prepared);
    expect(result.facts?.hardLimit).toStrictEqual({ bytes: "67108864", inodes: "1024" });
    expect(BigInt(result.facts!.allocatedBytes)).toBeGreaterThanOrEqual(BigInt(prepared.physicalBytes));
    expect(BigInt(result.facts!.reachable.bytes)).toBeGreaterThanOrEqual(67108864n);
    expect(BigInt(result.facts!.reachable.inodes)).toBeGreaterThanOrEqual(1024n);
    expect(result.facts!.payloadDevice).toBe(result.facts!.loopDevice);
    const ledger = await diskLedger();
    expect(ledger.ledger.reservations[0]?.request.exposure).toStrictEqual(prepared.exposure);
    expect(ledger.ledger.reservations[0]?.requestSha256).toBe(digest(JSON.stringify(prepared)));
    const again = await store.prepare(prepared);
    expect(again.facts?.backingInode).toBe(result.facts?.backingInode);
    expect(again.facts?.innerUuid).toBe(result.facts?.innerUuid);
    expect(await store.verifyPrepared(prepared.generation)).toStrictEqual(result.facts);
    // Still no payload writer/start barrier or drain/removal authority exists.
  }, 300000);
  it("refuses generation reuse with a changed operation before another image", async () => {
    const before = (await diskLedger()).bytes;
    await expect(store.prepare({ ...prepared, operationId: randomUUID() })).rejects.toMatchObject({ reason: BoundedStorageFailure.Conflict });
    expect((await diskLedger()).bytes).toBe(before);
  });
  it("checks complete current frames natively after a real revision advance", async () => {
    const next = await owner.admitPreparation(); boundary = next.host;
    await expect(boundary.withNativeBoundary(session => session.requireNativeCurrent(JSON.stringify(prepared), digest(JSON.stringify(prepared)))))
      .rejects.toMatchObject({ reason: BoundedStorageFailure.Conflict });
    const r = next.request;
    const substitutions = [
      { ...r, binding: { ...r.binding, bootId: randomUUID() } },
      { ...r, binding: { ...r.binding, policySha256: "0".repeat(64) } },
      { ...r, binding: { ...r.binding, admissionReceiptSha256: "0".repeat(64) } },
      { ...r, binding: { ...r.binding, admissionRevision: r.binding.admissionRevision + 1 } },
      { ...r, binding: { ...r.binding, filesystem: { ...r.binding.filesystem, uuid: randomUUID() } } },
      { ...r, binding: { ...r.binding, filesystem: { ...r.binding.filesystem, device: "1" } } },
      { ...r, binding: { ...r.binding, filesystem: { ...r.binding.filesystem, machineId: "0".repeat(32) } } },
      { ...r, generation: { ...r.generation, jobId: `test-storage-b1-${randomUUID()}` } },
      { ...r, generation: { ...r.generation, generationId: randomUUID() } },
      { ...r, generation: { ...r.generation, projectId: r.generation.projectId + 1 } },
      { ...r, operationId: randomUUID() },
      { ...r, cap: { ...r.cap, bytes: "1" } },
      { ...r, physicalBytes: "4096" },
      { ...r, exposure: { ...r.exposure, bytes: "1" } },
    ];
    const before = (await diskLedger()).bytes;
    for (const changed of substitutions) {
      // Deliberately bypass TS capture with raw canonical bytes and a correct
      // digest of those bytes. The actual native current record must refuse.
      const bytes = JSON.stringify(changed);
      await expect(boundary.withNativeBoundary(session => session.requireNativeCurrent(bytes, digest(bytes))))
        .rejects.toMatchObject({ reason: BoundedStorageFailure.Conflict });
    }
    await expect(boundary.withNativeBoundary(session => session.prepareNative(JSON.stringify(r), digest(JSON.stringify(r)))))
      .rejects.toMatchObject({ reason: BoundedStorageFailure.Conflict });
    expect((await diskLedger()).bytes).toBe(before);
  });
  it("refuses raw new Pending and a coincident digest for a different complete request", async () => {
    const admission = await owner.admitPreparation(); boundary = admission.host;
    const r = admission.request, before = await diskLedger();
    const pending = { request: r, requestSha256: digest(JSON.stringify(r)), revision: 1, phase: BoundedStoragePhase.Pending, facts: null };
    const next = `${JSON.stringify({ ...before.ledger, revision: before.ledger.revision + 1, reservations: [...before.ledger.reservations, pending] })}\n`;
    await expect(boundary.withNativeBoundary(session => session.publishLedger(before.bytes, next)))
      .rejects.toMatchObject({ reason: BoundedStorageFailure.Conflict });
    const wrong = `${JSON.stringify({ ...before.ledger, revision: before.ledger.revision + 1, reservations: [...before.ledger.reservations,
      { ...pending, request: { ...r, generation: { ...r.generation, jobId: `test-storage-b1-${randomUUID()}` } } }] })}\n`;
    await expect(boundary.withNativeBoundary(async session => {
      await session.requireNativeCurrent(JSON.stringify(r), digest(JSON.stringify(r)));
      await session.publishLedger(before.bytes, wrong);
    })).rejects.toMatchObject({ reason: BoundedStorageFailure.Conflict });
    expect((await diskLedger()).bytes).toBe(before.bytes);
    await expect(lstat(join(observation.controlRoot, "bounded-storage.intent"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  // Kill the actual native holder through callback failure after its fsynced
  // Pending ack; no physical PREPARE is sent. Reopen a different holder and
  // verify the durable debit, absence and no implicit retry/new generation.
  it("retains durable Pending across holder death and never replays absence", async () => {
    const admission = await owner.admitPreparation();
    native = admission.host; boundary = admission.host; const changed = admission.request;
    const sha = digest(JSON.stringify(changed));
    let published = "";
    await expect(native.withFilesystemFence(async session => {
      const old = await session.readLedger();
      if (!old) throw new Error("ledger_missing");
      const current = parseBoundedLedger(JSON.parse(old) as unknown, observation.filesystem);
      const next = parseBoundedLedger({ ...current, revision: current.revision + 1, reservations: [...current.reservations,
        { request: changed, requestSha256: sha, revision: 1, phase: BoundedStoragePhase.Pending, facts: null }] }, observation.filesystem);
      published = `${JSON.stringify(next)}\n`;
      await session.requirePreparationCapability(changed, sha);
      await session.publishLedger(old, published);
      throw new Error("deliberate_holder_death_after_pending");
    })).rejects.toThrow("deliberate_holder_death_after_pending");
    expect((await diskLedger()).bytes).toBe(published);
    const reopened = await LocalBoundedStorageReservationStore.open(observation.filesystem, native);
    const reconciled = await reopened.reconcile(changed.generation);
    expect(reconciled.phase).toBe(BoundedStoragePhase.Blocked);
    expect(reconciled.request.exposure).toStrictEqual(changed.exposure);
    expect((await reopened.prepare(changed)).phase).toBe(BoundedStoragePhase.Blocked);
    await expect(lstat(join(observation.scratchRoot, ".bounded-storage", changed.generation.generationId))).rejects.toMatchObject({ code: "ENOENT" });
    const another = await owner.admitPreparation();
    await expect(reopened.prepare(another.request)).rejects.toMatchObject({ reason: BoundedStorageFailure.Uncertain });
    expect((await diskLedger()).ledger.reservations).toHaveLength(2);
  });
  it("refuses reinitialization when both ledger and marker disappear from their canonical names", async () => {
    const before = await diskLedger();
    const ledgerPath = join(observation.controlRoot, "bounded-storage-ledger.json");
    const markerPath = join(observation.controlRoot, "test-ledger-initialized");
    const ledgerIdentity = await lstat(ledgerPath, { bigint: true }), markerIdentity = await lstat(markerPath, { bigint: true });
    // Retain both objects as loss evidence; do not delete/reset or restore them.
    // This terminal mutation exercises native original-owner memory, not a
    // marker-only check which would accept a second empty ledger.
    await rename(ledgerPath, join(observation.controlRoot, "test-retained-ledger-loss.json"));
    await rename(markerPath, join(observation.controlRoot, "test-retained-initialized-marker"));
    await expect(LocalBoundedStorageReservationStore.initialize(observation.filesystem, native))
      .rejects.toMatchObject({ reason: BoundedStorageFailure.Uncertain });
    expect((await diskLedger("test-retained-ledger-loss.json")).bytes).toBe(before.bytes);
    const retainedLedger = await lstat(join(observation.controlRoot, "test-retained-ledger-loss.json"), { bigint: true });
    const retainedMarker = await lstat(join(observation.controlRoot, "test-retained-initialized-marker"), { bigint: true });
    expect([retainedLedger.dev, retainedLedger.ino, retainedMarker.dev, retainedMarker.ino])
      .toStrictEqual([ledgerIdentity.dev, ledgerIdentity.ino, markerIdentity.dev, markerIdentity.ino]);
    await expect(lstat(ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  // Two separate protected NEW invocations: Pending authorization and PREPARE
  // authorization have different valid native preconditions. The loss fixture
  // above is never reused, restored, adopted or allowed to satisfy these tests.
  for (const fixture of deathFixtures) it(`refuses ${fixture.prepare ? "PREPARE" : "new Pending"} on the retained ingress after exact original owner death`, async () => {
    if (!fixture.path) throw new Error("NEW_TEST_owner_death_creation_required");
    await prepareNewTestB1(fixture.path, async original => {
      const obs = original.observation, admission = await original.admitPreparation();
      expect(obs.filesystem).not.toStrictEqual(observation.filesystem);
      expect([obs.fenceDevice, obs.fenceInode]).not.toStrictEqual([observation.fenceDevice, observation.fenceInode]);
      await LocalBoundedStorageReservationStore.initialize(obs.filesystem, admission.host);
      // Retain read-only observations before death, independently of owner PID
      // paths. They preserve the valid canonical ledger/current/claim evidence.
      const retainedHandles: FileHandle[] = [];
      try {
        const control = await open(`${obs.controlRoot}/.`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); retainedHandles.push(control);
        const claim = await open(join(obs.scratchRoot, ".bounded-storage-new-test-owner-v1"), constants.O_RDONLY | constants.O_NOFOLLOW); retainedHandles.push(claim);
        const current = await open(join(obs.controlRoot, "test-current-v1"), constants.O_RDONLY | constants.O_NOFOLLOW); retainedHandles.push(current);
        let armed!: () => void, proceed!: () => void;
        const ready = new Promise<void>(resolve => { armed = resolve; });
        const ownerExited = new Promise<void>(resolve => { proceed = resolve; });
        let retainedBytes = "", identity: { ownerPid: number; holderPid: number; channel: number } | undefined;
        const holder = admission.host.withNativeBoundary(async session => {
          const bytes = await session.readLedger();
          if (!bytes) throw new Error("owner_death_intact_ledger_required");
          const ledger = parseBoundedLedger(JSON.parse(bytes) as unknown, obs.filesystem);
          expect(ledger.reservations).toHaveLength(0);
          const request = JSON.stringify(admission.request), sha = digest(request);
          await session.requireNativeCurrent(request, sha); // actual CAPABLE1
          const pending = `${JSON.stringify({ ...ledger, revision: ledger.revision + 1, reservations: [
            { request: admission.request, requestSha256: sha, revision: 1, phase: BoundedStoragePhase.Pending, facts: null },
          ] })}\n`;
          if (fixture.prepare) {
            await session.publishLedger(bytes, pending); // actual durable Pending ACK
            expect(await session.readLedger()).toBe(pending);
          }
          retainedBytes = fixture.prepare ? pending : bytes;
          identity = session.retainedHolder();
          expect(identity.ownerPid).toBe(obs.ownerPid);
          const ownerProcess = await retainOwnedTestProcess(identity.ownerPid, process.pid);
          const holderProcess = await retainOwnedTestProcess(identity.holderPid, identity.ownerPid);
          await session.assertHeld();
          armed(); await ownerExited;
          // These call direct stream.write on this SAME retained ingress. Neither
          // stopped flags nor an invalid current/ledger fixture can make them green.
          const evidence = fixture.prepare
            ? await session.probePrepareAfterOwnerLoss(request, sha)
            : await session.probePendingAfterOwnerLoss(bytes, pending);
          expect(evidence).toMatchObject(identity);
          expect(evidence.remoteEOF).toBe(true);
          expect(evidence.output).not.toMatch(/(?:^|\n)(?:OK1|FACT1|CAPABLE1)(?: |\n|$)/);
          await observeOwnedTestTermination(ownerProcess);
          await observeOwnedTestTermination(holderProcess);
          console.info("NEW_TEST_owner_death_retained_ingress", JSON.stringify({ ...evidence, ownerProcess, holderProcess, ledgerSha256: digest(retainedBytes), requestSha256: sha }));
          throw new Error("owner_death_native_probe_complete");
        });
        const result = holder.then(() => ({ error: undefined }), (error: unknown) => ({ error }));
        try {
          await Promise.race([ready, result.then(value => { throw value.error ?? new Error("owner_death_holder_not_armed"); })]);
          // Kill from outside the retained callback. terminate waits only for the
          // exact owner's exit, never for the holder to finish this callback.
          try { await original.terminate(); } finally { proceed(); }
          expect((await result).error).toMatchObject({ message: "owner_death_native_probe_complete" });
          expect(identity).toBeDefined();
          const retainedRoot = `/proc/self/fd/${control.fd}`;
          const ledger = await open(join(retainedRoot, "bounded-storage-ledger.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
          try { expect(await boundedText(ledger, 4194304)).toBe(retainedBytes); } finally { await ledger.close(); }
          expect((await claim.stat({ bigint: true })).nlink).toBe(1n);
          expect((await current.stat({ bigint: true })).nlink).toBe(1n);
          await expect(lstat(join(retainedRoot, "bounded-storage.intent"))).rejects.toMatchObject({ code: "ENOENT" });
          await expect(lstat(join(retainedRoot, `${admission.generation.generationId}.native`))).rejects.toMatchObject({ code: "ENOENT" });
          // TS guards remain additional assertions after genuine native evidence.
          await expect(admission.host.withFilesystemFence(session => session.assertHeld())).rejects.toMatchObject({ reason: BoundedStorageFailure.Uncertain });
          await expect(original.admitPreparation()).rejects.toMatchObject({ reason: BoundedStorageFailure.Conflict });
        } finally { proceed(); }
      } finally { await Promise.all(retainedHandles.map(handle => handle.close())); }
    });
  }, 300000);
});
