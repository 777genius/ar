import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BoundedStorageBackend, BoundedStorageFailure, BoundedStoragePhase, type BoundedStorageLedger, type BoundedStorageRequest } from "../../src/worker-core/storage/bounded-storage-contract";
import { boundedImageEnvelope, parseBoundedLedger, parseBoundedRequest } from "../../src/worker-core/storage/bounded-storage-policy";
import { LocalBoundedStorageReservationStore } from "../../src/store-local-file/storage/local-bounded-storage-reservation-store";
import { NativeBoundedStorageHost, type RegisteredBoundedStorageHost } from "./native-bounded-storage-host";

/** Not selected by ordinary vitest config. Run explicitly only after source/TC/C
 * review in a NEW dedicated TEST filesystem registered by the host operator.
 * No fixture creation, compilation, quota module load, cleanup or fallback.
 * Retain all identities/evidence after this suite for exact owner disposition. */
const registrationPath = process.env.BOUNDED_STORAGE_NEW_TEST_REGISTRATION;
const suite = registrationPath ? describe : describe.skip;
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
let native: NativeBoundedStorageHost;
let registration: RegisteredBoundedStorageHost;
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
function request(): BoundedStorageRequest {
  const cap = { bytes: "67108864", inodes: "1024" };
  return parseBoundedRequest({ backend: BoundedStorageBackend.Ext4ProjectImage, binding: registration.binding,
    generation: { jobId: `test-storage-b1-${randomUUID()}`, generationId: randomUUID(), projectId: 500001 },
    operationId: randomUUID(), baseline: { bytes: "0", inodes: "0" }, growth: cap, cap, ...boundedImageEnvelope(cap) });
}
async function diskLedger(): Promise<{ bytes: string; ledger: BoundedStorageLedger }> {
  const fd = await open(join(registration.controlRoot, "bounded-storage-ledger.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await fd.stat({ bigint: true });
    expect(s.uid).toBe(0n); expect(s.nlink).toBe(1n); expect(s.mode & 0o7777n).toBe(0o600n);
    expect(s.size).toBeLessThanOrEqual(4194304n);
    const bytes = await boundedText(fd, 4194304);
    return { bytes, ledger: parseBoundedLedger(JSON.parse(bytes) as unknown, registration.filesystem) };
  } finally { await fd.close(); }
}
suite("actual native bounded backend - NEW dedicated TEST only", () => {
  beforeAll(async () => {
    if (process.platform !== "linux" || process.getuid?.() !== 0 || !registrationPath || !isAbsolute(registrationPath)) throw new Error("NEW_TEST_registration_required");
    const fd = await open(registrationPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = await fd.stat({ bigint: true });
      expect(s.uid).toBe(0n); expect(s.nlink).toBe(1n); expect(s.mode & 0o7777n).toBe(0o400n); expect(s.size).toBeLessThanOrEqual(8192n);
      const manifest = JSON.parse(await boundedText(fd, 8192)) as { purpose: string; registration: RegisteredBoundedStorageHost };
      expect(manifest.purpose).toBe("NEW_TEST_storage_b1_dedicated_ext4_no_real_projects");
      registration = manifest.registration;
    } finally { await fd.close(); }
    // Operator supplies a dedicated outer TEST volume, never the active shared
    // /srv/workers filesystem or a user project. Fixed branded paths plus exact
    // native dev/UUID verification are independently checked before effects.
    expect(registration.scratchRoot).toMatch(/^\/srv\/workers\/test-storage-b1-[0-9a-f-]{36}\/outer$/);
    expect(registration.controlRoot).toMatch(/^\/var\/lib\/subscription-runtime-test\/test-storage-b1-[0-9a-f-]{36}$/);
    const outer = await lstat(registration.scratchRoot, { bigint: true });
    const workers = await lstat("/srv/workers", { bigint: true });
    expect(outer.dev).not.toBe(workers.dev);
    native = new NativeBoundedStorageHost(registration);
    store = await LocalBoundedStorageReservationStore.initialize(registration.filesystem, native);
  });
  // Red if distinct processes can pass the fence concurrently or replace its
  // inode: the second native process is actually blocked in kernel flock.
  it("uses one stable fence across independent native holders", async () => {
    let enteredFirst!: () => void, releaseFirst!: () => void;
    const entered = new Promise<void>(resolve => { enteredFirst = resolve; });
    const release = new Promise<void>(resolve => { releaseFirst = resolve; });
    const order: string[] = [];
    const first = native.withFilesystemFence(async session => { await session.assertHeld(); order.push("first"); enteredFirst(); await release; order.push("first-done"); });
    await entered;
    const lockBefore = await lstat(join(registration.controlRoot, "bounded-storage.fence"), { bigint: true });
    const second = native.withFilesystemFence(async session => { await session.assertHeld(); order.push("second"); });
    try { await new Promise(resolve => setTimeout(resolve, 100)); expect(order).toStrictEqual(["first"]); }
    finally { releaseFirst(); }
    await Promise.all([first, second]);
    const lockAfter = await lstat(join(registration.controlRoot, "bounded-storage.fence"), { bigint: true });
    expect(order).toStrictEqual(["first", "first-done", "second"]);
    expect([lockAfter.dev, lockAfter.ino]).toStrictEqual([lockBefore.dev, lockBefore.ino]);
  });
  it("refuses a stale native ledger CAS without publishing a new intent or losing bytes", async () => {
    const before = (await diskLedger()).bytes;
    await expect(native.withFilesystemFence(session => session.publishLedger("stale_expected_bytes", before)))
      .rejects.toMatchObject({ reason: BoundedStorageFailure.Conflict });
    expect((await diskLedger()).bytes).toBe(before);
    await expect(lstat(join(registration.controlRoot, "bounded-storage.intent"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  // No mocked quota facts: actual mke2fs + loop + mounted ext4 + quotactl_fd.
  // Red if Prepared can precede physical backing/geometry/exact both limits.
  it("prepares real full allocation and verifies both limits and inherited layout", async () => {
    prepared = parseBoundedRequest({ ...request(), generation: registration.admissionGeneration });
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
  // Kill the actual native holder through callback failure after its fsynced
  // Pending ack; no physical PREPARE is sent. Reopen a different holder and
  // verify the durable debit, absence and no implicit retry/new generation.
  it("retains durable Pending across holder death and never replays absence", async () => {
    const r = request(), changed = parseBoundedRequest({ ...r, generation: { ...r.generation, projectId: 500002 } });
    const sha = digest(JSON.stringify(changed));
    let published = "";
    await expect(native.withFilesystemFence(async session => {
      const old = await session.readLedger();
      if (!old) throw new Error("ledger_missing");
      const current = parseBoundedLedger(JSON.parse(old) as unknown, registration.filesystem);
      const next = parseBoundedLedger({ ...current, revision: current.revision + 1, reservations: [...current.reservations,
        { request: changed, requestSha256: sha, revision: 1, phase: BoundedStoragePhase.Pending, facts: null }] }, registration.filesystem);
      published = `${JSON.stringify(next)}\n`;
      await session.publishLedger(old, published);
      throw new Error("deliberate_holder_death_after_pending");
    })).rejects.toThrow("deliberate_holder_death_after_pending");
    expect((await diskLedger()).bytes).toBe(published);
    const reopened = await LocalBoundedStorageReservationStore.open(registration.filesystem, native);
    const reconciled = await reopened.reconcile(changed.generation);
    expect(reconciled.phase).toBe(BoundedStoragePhase.Blocked);
    expect(reconciled.request.exposure).toStrictEqual(changed.exposure);
    expect((await reopened.prepare(changed)).phase).toBe(BoundedStoragePhase.Blocked);
    await expect(lstat(join(registration.scratchRoot, ".bounded-storage", changed.generation.generationId))).rejects.toMatchObject({ code: "ENOENT" });
    const another = request();
    await expect(reopened.prepare({ ...another, generation: { ...another.generation, projectId: 500003 } })).rejects.toMatchObject({ reason: BoundedStorageFailure.Uncertain });
    expect((await diskLedger()).ledger.reservations).toHaveLength(2);
  });
});
