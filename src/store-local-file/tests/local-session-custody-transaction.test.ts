import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SessionArtifact, SessionWriteResult } from "@vioxen/subscription-runtime/core";
import { createLocalFileBackendRuntimeAdapters, LocalFileLeaseStore } from "../index";
import { LocalFileProviderLock } from "../shared/local-file-custody-lock";
import * as atomicFiles from "../shared/write-atomic-local-file";

const providerInstanceId = "transaction-session";
const encryptionKey = new Uint8Array(32).fill(9);
const makeArtifact = (text: string): SessionArtifact => ({
  providerId: "fake", kind: "json-file", formatVersion: "fake-v1", contentType: "application/json",
  bytes: new TextEncoder().encode(text),
});

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "ar-custody-transaction-"));
  let now = Date.parse("2026-10-23T00:00:00.000Z");
  const adapters = createLocalFileBackendRuntimeAdapters({
    providerId: "fake", rootDir, encryptionKey, now: () => new Date(now),
  });
  const initial = await adapters.sessionStore.write({ providerInstanceId, expectedGeneration: 0,
    nextArtifact: makeArtifact("initial-fake-session"), idempotencyKey: "seed", leaseId: "bootstrap" });
  if (initial.status !== "accepted") throw new Error("seed_not_accepted");
  return { rootDir, ...adapters, initial, advance: () => { now += 1_001; } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function lease(f: Fixture, runId: string, generationHash = f.initial.generationHash) {
  const acquired = await f.leaseStore.acquire({ providerInstanceId, runId, attempt: 1,
    ttlMs: 1_000, restoredGenerationHash: generationHash });
  if (acquired.status !== "granted") throw new Error("lease_not_granted");
  return acquired;
}
async function start(f: Fixture, leaseId: string, generationHash = f.initial.generationHash) {
  await f.leaseStore.finalize({ leaseId, restoredGenerationHash: generationHash });
  await f.leaseStore.markWritebackStarted({ leaseId });
}

it.each(["cas", "replay"])("serializes independent processes through the public factory (%s)", async (mode) => {
  const rootDir = await mkdtemp(join(tmpdir(), "ar-custody-process-"));
  try {
    const receipts = await processWriters(rootDir, mode);
    expect(receipts.filter((r) => r.status === "accepted")).toHaveLength(1);
    expect(receipts.filter((r) => r.status === (mode === "cas" ? "stale_generation" : "idempotent_replay"))).toHaveLength(7);
    const { sessionStore } = createLocalFileBackendRuntimeAdapters({ providerId: "fake", rootDir, encryptionKey });
    expect(await sessionStore.read({ providerInstanceId: "multiprocess-session" })).toMatchObject({ generation: 1 });
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

describe("lease fencing at the session transaction", () => {
  it("rejects expired owners at every transition and at the actual write after a successor acquires", async () => {
    const f = await fixture();
    try {
      const expired = await lease(f, "expired");
      await start(f, expired.leaseId);
      f.advance();
      const current = await lease(f, "current");
      await expect(f.leaseStore.finalize({ leaseId: expired.leaseId, restoredGenerationHash: f.initial.generationHash })).rejects.toThrow("local_file_lease_expired_or_released");
      await expect(f.leaseStore.markWritebackStarted({ leaseId: expired.leaseId })).rejects.toThrow("local_file_lease_expired_or_released");
      await expect(f.sessionStore.write({ providerInstanceId, expectedGeneration: 1, nextArtifact: makeArtifact("expired-fake"),
        idempotencyKey: "expired", leaseId: expired.leaseId })).rejects.toThrow("local_file_lease_expired_or_released");
      await expect(f.leaseStore.markWritebackCommitted({ leaseId: expired.leaseId, nextGenerationHash: "unwritten", idempotencyKey: "expired" })).resolves.toMatchObject({ status: "stale_generation" });
      // Neither the explicit seed compatibility path nor an arbitrary ID may
      // bypass the current owner, even though their expected generation matches.
      for (const leaseId of ["seed-local-file-backend", "arbitrary", "bootstrap"]) {
        await expect(f.sessionStore.write({ providerInstanceId, expectedGeneration: 1, nextArtifact: makeArtifact("seed-race"),
          idempotencyKey: `seed-race-${leaseId}`, leaseId })).rejects.toThrow("local_file_lease_unavailable");
      }
      await start(f, current.leaseId);
      const receipt = await f.sessionStore.write({ providerInstanceId, expectedGeneration: 1, nextArtifact: makeArtifact("current-fake"),
        idempotencyKey: "current", leaseId: current.leaseId });
      expect(receipt).toMatchObject({ status: "accepted", generation: 2 });
      expect(await f.sessionStore.read({ providerInstanceId })).toMatchObject({ generation: 2, artifact: makeArtifact("current-fake") });
    } finally { await rm(f.rootDir, { recursive: true, force: true }); }
  });

  it("rejects released, wrong-provider and unstarted leases, and arbitrary replacement IDs", async () => {
    const f = await fixture();
    try {
      await expect(f.sessionStore.write({ providerInstanceId, expectedGeneration: 1, nextArtifact: makeArtifact("arbitrary"),
        idempotencyKey: "arbitrary", leaseId: "bootstrap" })).rejects.toThrow("local_file_lease_not_found");
      const owned = await lease(f, "owned");
      await expect(f.sessionStore.write({ providerInstanceId, expectedGeneration: 1, nextArtifact: makeArtifact("unstarted"),
        idempotencyKey: "unstarted", leaseId: owned.leaseId })).rejects.toThrow("local_file_lease_writeback_not_started");
      await f.leaseStore.release({ leaseId: owned.leaseId, reason: "test" });
      await expect(f.leaseStore.finalize({ leaseId: owned.leaseId, restoredGenerationHash: f.initial.generationHash })).rejects.toThrow("local_file_lease_expired_or_released");
      const foreign = await f.leaseStore.acquire({ providerInstanceId: "other-provider", runId: "other", attempt: 1, ttlMs: 1_000, restoredGenerationHash: f.initial.generationHash });
      if (foreign.status !== "granted") throw new Error("lease_not_granted");
      await expect(f.sessionStore.write({ providerInstanceId, expectedGeneration: 1, nextArtifact: makeArtifact("foreign"),
        idempotencyKey: "foreign", leaseId: foreign.leaseId })).rejects.toThrow("local_file_lease_provider_mismatch");
    } finally { await rm(f.rootDir, { recursive: true, force: true }); }
  });

  it("preserves live unchanged-refresh commits and rejects stale no-op commits", async () => {
    const f = await fixture();
    try {
      const first = await lease(f, "unchanged");
      await f.leaseStore.finalize({ leaseId: first.leaseId, restoredGenerationHash: f.initial.generationHash });
      const intent = { leaseId: first.leaseId, nextGenerationHash: f.initial.generationHash, idempotencyKey: "unchanged" };
      expect(await f.leaseStore.markWritebackCommitted(intent)).toEqual({ status: "committed" });
      const stale = await lease(f, "stale-unchanged");
      await f.leaseStore.finalize({ leaseId: stale.leaseId, restoredGenerationHash: f.initial.generationHash });
      f.advance();
      await lease(f, "current");
      await expect(f.leaseStore.markWritebackCommitted({ ...intent, leaseId: stale.leaseId })).rejects.toThrow("local_file_lease_expired_or_released");
      expect(await f.leaseStore.markWritebackCommitted(intent)).toEqual({ status: "idempotent_replay" });
      expect(await f.leaseStore.acquire({ providerInstanceId, runId: "third", attempt: 1, ttlMs: 1_000, restoredGenerationHash: f.initial.generationHash })).toMatchObject({ status: "denied" });
    } finally { await rm(f.rootDir, { recursive: true, force: true }); }
  });

  it.each(["writeback_started", "committed"])("cleans a committed replay's leftover %s active pointer without clearing its successor", async (activeState) => {
    const f = await fixture();
    try {
      const first = await lease(f, "first");
      await start(f, first.leaseId);
      const written = await f.sessionStore.write({ providerInstanceId, expectedGeneration: 1,
        nextArtifact: makeArtifact("committed-fake"), idempotencyKey: "committed", leaseId: first.leaseId });
      if (written.status !== "accepted") throw new Error("write_not_accepted");
      const intent = { leaseId: first.leaseId, nextGenerationHash: written.generationHash, idempotencyKey: "committed" };
      const realWrite = atomicFiles.writeAtomicLocalFile;
      const fault = vi.spyOn(atomicFiles, "writeAtomicLocalFile").mockImplementation(async (path, serialized, exclusive) => {
        if (path.includes(join("leases", "active")) && JSON.parse(serialized).state === "committed") {
          if (activeState === "committed") await realWrite(path, serialized, exclusive);
          throw new Error("simulated_commit_cleanup_crash");
        }
        return realWrite(path, serialized, exclusive);
      });
      await expect(f.leaseStore.markWritebackCommitted(intent)).rejects.toThrow("simulated_commit_cleanup_crash");
      fault.mockRestore();
      const activePath = join(f.rootDir, "leases", "active", `${createHash("sha256").update(providerInstanceId).digest("hex")}.json`);
      expect(JSON.parse(await readFile(activePath, "utf8")).state).toBe(activeState);
      expect(await f.leaseStore.markWritebackCommitted(intent)).toEqual({ status: "idempotent_replay" });
      const successor = await lease(f, "successor", written.generationHash);
      expect(await f.leaseStore.markWritebackCommitted(intent)).toEqual({ status: "idempotent_replay" });
      expect(JSON.parse(await readFile(activePath, "utf8")).leaseId).toBe(successor.leaseId);
      expect(await f.leaseStore.acquire({ providerInstanceId, runId: "third", attempt: 1, ttlMs: 1_000,
        restoredGenerationHash: written.generationHash })).toMatchObject({ status: "denied" });
    } finally { vi.restoreAllMocks(); await rm(f.rootDir, { recursive: true, force: true }); }
  });

  it("recovers a persisted write with unknown acknowledgement after expiry and preserves later generations", async () => {
    const f = await fixture();
    try {
      const first = await lease(f, "first");
      await start(f, first.leaseId);
      const intent = { providerInstanceId, expectedGeneration: 1, nextArtifact: makeArtifact("first-fake"), idempotencyKey: "first", leaseId: first.leaseId };
      const realWrite = atomicFiles.writeAtomicLocalFile;
      const fault = vi.spyOn(atomicFiles, "writeAtomicLocalFile").mockImplementation(async (path, serialized, exclusive) => {
        if (path.includes(join("leases", "records")) && serialized.includes('"persistedWrite"')) throw new Error("simulated_receipt_crash");
        return realWrite(path, serialized, exclusive);
      });
      await expect(f.sessionStore.write(intent)).rejects.toThrow("simulated_receipt_crash");
      fault.mockRestore();
      const persisted = await f.sessionStore.read({ providerInstanceId });
      if (!persisted) throw new Error("session_missing");
      expect(persisted.generation).toBe(2);
      f.advance();
      const second = await lease(f, "second", persisted.generationHash);
      // Replay reconstructs the first receipt without requiring or stealing
      // the second lease, then a late commit only acknowledges that receipt.
      expect(await f.sessionStore.write(intent)).toMatchObject({ status: "idempotent_replay", generation: 2 });
      expect(await f.leaseStore.markWritebackCommitted({ leaseId: first.leaseId, nextGenerationHash: persisted.generationHash, idempotencyKey: "first" })).toEqual({ status: "committed" });
      expect(await f.leaseStore.acquire({ providerInstanceId, runId: "third", attempt: 1, ttlMs: 1_000, restoredGenerationHash: persisted.generationHash })).toMatchObject({ status: "denied" });
      await start(f, second.leaseId, persisted.generationHash);
      const later = await f.sessionStore.write({ providerInstanceId, expectedGeneration: 2, nextArtifact: makeArtifact("second-fake"), idempotencyKey: "second", leaseId: second.leaseId });
      expect(later).toMatchObject({ status: "accepted", generation: 3 });
      expect(await f.sessionStore.write(intent)).toMatchObject({ status: "idempotent_replay", generation: 2 });
      expect(await f.leaseStore.markWritebackCommitted({ leaseId: first.leaseId, nextGenerationHash: persisted.generationHash, idempotencyKey: "first" })).toEqual({ status: "idempotent_replay" });
      expect(await f.sessionStore.read({ providerInstanceId })).toMatchObject({ generation: 3, artifact: makeArtifact("second-fake") });
    } finally { vi.restoreAllMocks(); await rm(f.rootDir, { recursive: true, force: true }); }
  });

  it("verifies and upgrades an exact current-generation legacy v1 replay", async () => {
    const f = await fixture();
    try {
      const current = await lease(f, "legacy");
      await start(f, current.leaseId);
      const intent = { providerInstanceId, expectedGeneration: 1, nextArtifact: makeArtifact("legacy-fake"),
        idempotencyKey: "legacy", leaseId: current.leaseId, metadata: { context: "original" } };
      await f.sessionStore.write(intent);
      const path = join(f.rootDir, `${createHash("sha256").update(providerInstanceId).digest("hex")}.json`);
      const oldRecord = JSON.parse(await readFile(path, "utf8"));
      delete oldRecord.idempotency.legacy.requestHash;
      const legacyBytes = JSON.stringify(oldRecord);
      await writeFile(path, legacyBytes);
      for (const changed of [
        { ...intent, expectedGeneration: 2 }, { ...intent, leaseId: "other" },
        { ...intent, nextArtifact: { ...intent.nextArtifact, formatVersion: "other-v1" } },
        { ...intent, nextArtifact: { ...intent.nextArtifact, contentType: "text/plain" } },
        { ...intent, metadata: { context: "changed" } },
      ]) await expect(f.sessionStore.write(changed)).rejects.toThrow("local_store_legacy_idempotency_unverifiable");
      expect(await f.sessionStore.write(intent)).toMatchObject({ status: "idempotent_replay", generation: 2 });
      expect(JSON.parse(await readFile(path, "utf8")).idempotency.legacy.requestHash).toEqual(expect.any(String));
      // A historical legacy receipt has lost its descriptor/lease evidence.
      const unverifiable = { ...oldRecord, generation: 3 };
      await writeFile(path, JSON.stringify(unverifiable));
      await expect(f.sessionStore.write(intent)).rejects.toThrow("local_store_legacy_idempotency_unverifiable");
    } finally { await rm(f.rootDir, { recursive: true, force: true }); }
  });

  it("copies Buffer-backed input before waiting for the provider lock", async () => {
    const f = await fixture();
    let unblock!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const held = new LocalFileProviderLock({ rootDir: f.rootDir }).run(providerInstanceId, async () => { locked(); await gate; });
    try {
      await ready;
      const bytes = Buffer.from("original-fake-session");
      const original = new Uint8Array(bytes);
      const intent = { providerInstanceId, expectedGeneration: 1, nextArtifact: { ...makeArtifact(""), bytes },
        idempotencyKey: "buffer-intent", leaseId: "seed-local-file-backend" };
      const pending = f.sessionStore.write(intent);
      bytes.fill(120);
      unblock();
      await held;
      expect(await pending).toMatchObject({ status: "accepted", generation: 2 });
      expect((await f.sessionStore.read({ providerInstanceId }))?.artifact.bytes).toEqual(original);
      expect(await f.sessionStore.write({ ...intent, nextArtifact: { ...intent.nextArtifact, bytes: original } })).toMatchObject({ status: "idempotent_replay" });
      await expect(f.sessionStore.write(intent)).rejects.toThrow("idempotency_key_conflict");
    } finally { unblock(); await held; await rm(f.rootDir, { recursive: true, force: true }); }
  });

  it("binds idempotency to the complete write intent", async () => {
    const f = await fixture();
    try {
      const current = await lease(f, "current");
      await start(f, current.leaseId);
      const intent = { providerInstanceId, expectedGeneration: 1, nextArtifact: makeArtifact("same-fake"), idempotencyKey: "intent", leaseId: current.leaseId, metadata: { context: "one" } };
      expect(await f.sessionStore.write(intent)).toMatchObject({ status: "accepted" });
      for (const changed of [
        { ...intent, expectedGeneration: 2 }, { ...intent, leaseId: "other" },
        { ...intent, nextArtifact: { ...intent.nextArtifact, formatVersion: "other-v1" } },
        { ...intent, nextArtifact: { ...intent.nextArtifact, contentType: "text/plain" } },
        { ...intent, metadata: { context: "two" } },
      ]) await expect(f.sessionStore.write(changed)).rejects.toThrow("idempotency_key_conflict");
      expect(await f.sessionStore.write(intent)).toMatchObject({ status: "idempotent_replay", generation: 2 });
    } finally { await rm(f.rootDir, { recursive: true, force: true }); }
  });
});

describe("process transaction lock recovery", () => {
  it("recovers the lock of a terminated real process through the public factory", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ar-custody-killed-lock-"));
    const child = fork(fileURLToPath(new URL("./fixtures/session-writer-process.ts", import.meta.url)), [rootDir, "hold-lock", "0"], {
      execArgv: ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"], silent: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve());
        child.once("error", reject);
        child.once("exit", () => reject(new Error("lock_holder_exited_before_ready")));
      });
      const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await stopped;
      const { sessionStore } = createLocalFileBackendRuntimeAdapters({ providerId: "fake", rootDir, encryptionKey });
      expect(await sessionStore.write({ providerInstanceId, expectedGeneration: 0, nextArtifact: makeArtifact("recovered"),
        idempotencyKey: "recovered", leaseId: "bootstrap" })).toMatchObject({ status: "accepted", generation: 1 });
      expect(await readdir(join(rootDir, "leases", "locks"))).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("serializes overlapping reclamation of a dead provider and dead cleanup guard", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ar-custody-recursive-lock-"));
    try {
      const setup = new LocalFileProviderLock({ rootDir });
      await setup.run(providerInstanceId, async () => {});
      const lockPath = join(rootDir, "leases", "locks", `${createHash("sha256").update(providerInstanceId).digest("hex")}.lock`);
      const deadRecord = { storageVersion: "local-file-lease-lock-v1", lockId: "dead-provider",
        providerInstanceIdHash: "test", pid: 999_999, acquiredAt: "2020-01-01T00:00:00Z", expiresAt: "2020-01-01T00:00:01Z" };
      const guardPath = (path: string, id: string) => join(dirname(path), `${createHash("sha256").update(`${path}\0${id}`).digest("hex")}.cleanup.lock`);
      await writeFile(lockPath, JSON.stringify(deadRecord));
      let path = lockPath;
      let id = deadRecord.lockId;
      // Multiple previously crashed cleanup guards exercise recursive recovery
      // and ensure that lock basenames stay bounded at every depth.
      for (let depth = 0; depth < 4; depth += 1) {
        path = guardPath(path, id);
        id = `dead-cleanup-${depth}`;
        await writeFile(path, JSON.stringify({ ...deadRecord, lockId: id }));
      }
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) => new LocalFileLeaseStore({ rootDir }).acquire({
        providerInstanceId, runId: `contender-${index}`, attempt: 1, ttlMs: 60_000, restoredGenerationHash: "initial",
      })));
      expect(results.filter((result) => result.status === "granted")).toHaveLength(1);
      expect(results.filter((result) => result.status === "denied")).toHaveLength(7);
      expect(await readdir(join(rootDir, "leases", "locks"))).toEqual([]);
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "linux")("reclaims an expired lock when its PID now has another process incarnation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ar-custody-reused-pid-"));
    try {
      const setup = new LocalFileProviderLock({ rootDir });
      await setup.run(providerInstanceId, async () => {});
      const lockPath = join(rootDir, "leases", "locks", `${createHash("sha256").update(providerInstanceId).digest("hex")}.lock`);
      const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      await writeFile(lockPath, JSON.stringify({ storageVersion: "local-file-lease-lock-v1", lockId: "previous-incarnation",
        providerInstanceIdHash: "test", pid: process.pid, acquiredAt: "2020-01-01T00:00:00Z", expiresAt: "2020-01-01T00:00:01Z",
        ownerProcess: { bootId, startTimeTicks: "0" } }));
      expect(await new LocalFileLeaseStore({ rootDir }).acquire({ providerInstanceId, runId: "replacement", attempt: 1,
        ttlMs: 1_000, restoredGenerationHash: "initial" })).toMatchObject({ status: "granted" });
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  });

  it("releases a failed operation's lock and never steals from an expired live process", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ar-custody-lock-"));
    try {
      const lock = new LocalFileProviderLock({ rootDir, lockTtlMs: 1 });
      await expect(lock.run(providerInstanceId, async () => { throw new Error("simulated_failure"); })).rejects.toThrow("simulated_failure");
      expect(await lock.run(providerInstanceId, async () => "recovered")).toBe("recovered");
      const lockPath = join(rootDir, "leases", "locks", `${createHash("sha256").update(providerInstanceId).digest("hex")}.lock`);
      await writeFile(lockPath, JSON.stringify({ storageVersion: "local-file-lease-lock-v1", lockId: "paused-live-owner",
        providerInstanceIdHash: "test", pid: process.pid, acquiredAt: "2020-01-01T00:00:00Z", expiresAt: "2020-01-01T00:00:01Z" }));
      const contender = new LocalFileLeaseStore({ rootDir, lockAcquireTimeoutMs: 25, lockPollMs: 2 });
      await expect(contender.acquire({ providerInstanceId, runId: "contender", attempt: 1, ttlMs: 1_000, restoredGenerationHash: "initial" })).rejects.toThrow("local_file_lease_lock_timeout");
      expect(await readFile(lockPath, "utf8")).toContain("paused-live-owner");
      await rm(lockPath);
      expect(await readdir(join(rootDir, "leases", "locks"))).toEqual([]);
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  });
});

async function processWriters(rootDir: string, mode: string): Promise<SessionWriteResult[]> {
  const children: ChildProcess[] = [];
  try {
    const writers = Array.from({ length: 8 }, (_, index) => {
      const child = fork(fileURLToPath(new URL("./fixtures/session-writer-process.ts", import.meta.url)), [rootDir, mode, String(index)], {
        execArgv: ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"], silent: true,
      });
      children.push(child);
      let errorOutput = "";
      child.stderr?.on("data", (bytes) => { errorOutput += String(bytes); });
      let readyResolve!: () => void;
      const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
      const result = new Promise<SessionWriteResult>((resolve, reject) => {
        let receipt: SessionWriteResult | undefined;
        child.on("message", (message: { ready?: boolean; receipt?: SessionWriteResult }) => {
          if (message.ready) readyResolve();
          if (message.receipt) receipt = message.receipt;
        });
        child.once("error", reject);
        child.once("exit", (code) => receipt && code === 0 ? resolve(receipt) : reject(new Error(`writer_process_failed:${code}:${errorOutput}`)));
      });
      return { child, ready, result };
    });
    await Promise.race([
      Promise.all(writers.map((writer) => writer.ready)),
      Promise.all(writers.map((writer) => writer.result)).then(() => { throw new Error("writer_exited_before_ready"); }),
    ]);
    for (const writer of writers) writer.child.send("write");
    return await Promise.all(writers.map((writer) => writer.result));
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
}
