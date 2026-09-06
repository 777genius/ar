import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, rename, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkerControlService } from "../../worker-core/control/worker-control-service";
import { LocalFileWorkerControlInboxStore } from "../worker-control-inbox/adapters/local-worker-control-inbox-store";
import { ValidatedHistoryCache } from "../worker-control-inbox/adapters/validated-history-cache";

const io = vi.hoisted(() => ({ reads: 0, bytes: 0, afterRead: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const value = await fs.readFile(...args);
    io.reads++;
    io.bytes += Buffer.byteLength(value);
    const afterRead = io.afterRead;
    io.afterRead = undefined;
    await afterRead?.();
    return value;
  } };
});
const target = { jobId: "test-history-job" };
const date = new Date("2026-09-06T00:00:00Z");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const storageVersion = "local-file-worker-control-inbox-v1";

describe("worker control validated history", () => {
  it("reuses terminal history with zero payload reads while retaining receipt history", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "control-history-test-"));
    try {
      const dir = join(rootDir, "worker-control-inbox", hash(target.jobId));
      const claims = join(dir, "delivery-claims");
      await mkdir(claims, { recursive: true });
      const signals = Array.from({ length: 1_000 }, (_, index) => ({
        storageVersion, schemaVersion: 1, signalId: `signal-${index}`, idempotencyKey: `signal-${index}`,
        target, intent: "guidance", deliveryMode: "interrupt_then_continue", body: "x".repeat(1_024),
        createdAt: date.toISOString(), createdBy: "orchestrator", priority: "normal", supersedesSignalIds: [], metadata: {},
      }));
      const accepted = signals.map(({ signalId }) => ({
        storageVersion, schemaVersion: 1, receiptId: `accepted-${signalId}`, signalId, target,
        state: "accepted", createdAt: date.toISOString(), deliveryAttemptId: `delivery-${signalId}`, metadata: {},
      }));
      const delivered = accepted.map((receipt) => ({ ...receipt, receiptId: `delivered-${receipt.signalId}`,
        state: "delivered", createdAt: new Date(date.getTime() + 1).toISOString(),
        deliveredAt: new Date(date.getTime() + 1).toISOString(), appliedAt: new Date(date.getTime() + 2).toISOString(),
      }));
      await writeFile(join(dir, "signals.jsonl"), signals.map((value) => JSON.stringify(value)).join("\n") + "\n");
      await writeFile(join(dir, "receipts.jsonl"), delivered.map((value) => JSON.stringify(value)).join("\n") + "\n");
      await Promise.all(accepted.map((receipt) => writeFile(join(claims, hash(receipt.signalId) + ".json"), JSON.stringify(receipt))));
      const store = new LocalFileWorkerControlInboxStore({ rootDir });
      const control = new WorkerControlService({ store });
      const history = await store.listReceipts({ target });
      expect(history).toHaveLength(2_000);
      expect(history.filter((receipt) => receipt.state === "accepted")).toHaveLength(1_000);
      const views = await control.listSignals({ target, includeExpired: true });
      expect(views).toHaveLength(1_000);
      io.reads = 0; io.bytes = 0;
      const cpu = process.cpuUsage();
      const started = performance.now();
      for (let index = 0; index < 8; index++) {
        expect(await control.listSignals({ target, states: ["pending"], includeExpired: false })).toEqual([]);
      }
      const cpuUsed = process.cpuUsage(cpu);
      process.stdout.write("CONTROL_HISTORY_CACHE " + JSON.stringify({ history: 1_000, polls: 8, reads: io.reads, bytes: io.bytes,
        wallMs: Math.round(performance.now() - started), cpuMs: Math.round((cpuUsed.user + cpuUsed.system) / 1_000) }) + "\n");
      expect(io.reads).toBe(0);
      expect(io.bytes).toBe(0);
      expect(await store.listReceipts({ target })).toEqual(history);
      expect(await control.listSignals({ target, includeExpired: true })).toEqual(views);
      // Cache ownership must not leak through mutable Dates/metadata/targets.
      history[0]!.createdAt.setTime(0);
      expect((await store.listReceipts({ target }))[0]!.createdAt.getTime()).not.toBe(0);
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  });

  it("observes other instances' append, claim, release and same-size file replacement", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "control-invalidation-test-"));
    try {
      const readerStore = new LocalFileWorkerControlInboxStore({ rootDir });
      const reader = new WorkerControlService({ store: readerStore });
      const writerStore = new LocalFileWorkerControlInboxStore({ rootDir });
      const writer = new WorkerControlService({ store: writerStore });
      expect(await reader.listSignals({ target })).toEqual([]);
      const signal = await writer.enqueueSignal({ target, intent: "guidance", body: "first" });
      expect((await reader.listSignals({ target }))[0]!.state).toBe("pending");
      const batch = await writer.consumeForContinuation({ target, deliveryAttemptId: "test-first", deferDeliveryConfirmation: true });
      expect((await reader.listSignals({ target }))[0]!.state).toBe("accepted");
      await writer.releaseContinuationDelivery({ batch });
      expect((await reader.listSignals({ target }))[0]!.state).toBe("pending");
      const secondBatch = await writer.consumeForContinuation({ target, deliveryAttemptId: "test-second", deferDeliveryConfirmation: true });
      expect((await reader.listSignals({ target }))[0]!.latestReceipt?.deliveryAttemptId).toBe("test-second");
      await writer.confirmContinuationDelivery({ batch: secondBatch });
      expect((await reader.listSignals({ target }))[0]!.state).toBe("delivered");
      await writer.enqueueSignal({ target, intent: "guidance", body: "other" });
      expect(await reader.listSignals({ target })).toHaveLength(2);
      const path = join(rootDir, "worker-control-inbox", hash(target.jobId), "signals.jsonl");
      const { readFile } = await import("node:fs/promises");
      const contents = await readFile(path, "utf8");
      await writeFile(path + ".replacement", contents.replace('"first"', '"fresh"'));
      await rename(path + ".replacement", path);
      expect((await reader.listSignals({ target, signalIds: [signal.signalId] }))[0]!.signal.body).toBe("fresh");
      await writeFile(path, "");
      expect(await reader.listSignals({ target })).toEqual([]);
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  });

  it("keeps exactly-once claiming across independently warmed instances", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "control-race-test-"));
    try {
      const first = new WorkerControlService({ store: new LocalFileWorkerControlInboxStore({ rootDir }) });
      const second = new WorkerControlService({ store: new LocalFileWorkerControlInboxStore({ rootDir }) });
      const signal = await first.enqueueSignal({ target, intent: "guidance", body: "only once" });
      await Promise.all([first.listSignals({ target }), second.listSignals({ target })]);
      const batches = await Promise.all([
        first.consumeForContinuation({ target, deliveryAttemptId: "test-race-a" }),
        second.consumeForContinuation({ target, deliveryAttemptId: "test-race-b" }),
      ]);
      expect(batches.flatMap((batch) => batch.signalIds)).toEqual([signal.signalId]);
      const restarted = new WorkerControlService({ store: new LocalFileWorkerControlInboxStore({ rootDir }) });
      expect((await restarted.consumeForContinuation({ target, deliveryAttemptId: "test-race-c" })).signalIds).toEqual([]);
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  });

  it("re-evaluates stale accepted leases after cached reads", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "control-lease-test-"));
    let now = new Date(date);
    try {
      const service = new WorkerControlService({ store: new LocalFileWorkerControlInboxStore({ rootDir }), clock: { now: () => now } });
      await service.enqueueSignal({ target, intent: "guidance", body: "recover" });
      await service.consumeForContinuation({ target, deliveryAttemptId: "test-old", deferDeliveryConfirmation: true });
      expect((await service.reconcile({ target, repair: true, acceptedStaleAfterMs: 60_000 })).repairedCount).toBe(0);
      now = new Date(date.getTime() + 120_000);
      expect((await service.reconcile({ target, repair: true, acceptedStaleAfterMs: 60_000 })).repairedCount).toBe(1);
      expect((await service.consumeForContinuation({ target, deliveryAttemptId: "test-new" })).signalIds).toHaveLength(1);
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  });

  it("does not cache a snapshot changed during read and handles a completed partial append", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "control-cache-race-test-"));
    try {
      const path = join(rootDir, "history");
      const cache = new ValidatedHistoryCache();
      const parse = (text: string) => { try { return [JSON.parse(text) as { value: number }]; } catch { return []; } };
      await writeFile(path, '{"value":1}');
      io.afterRead = async () => { await writeFile(path, '{"value":2}'); };
      expect(await cache.read(path, parse)).toEqual([{ value: 1 }]);
      expect(await cache.read(path, parse)).toEqual([{ value: 2 }]);
      await writeFile(path, '{"value":');
      expect(await cache.read(path, parse)).toEqual([]);
      await appendFile(path, '3}');
      expect(await cache.read(path, parse)).toEqual([{ value: 3 }]);
    } finally { io.afterRead = undefined; await rm(rootDir, { recursive: true, force: true }); }
  });

  it("evicts by file count and payload bytes without limiting readable history", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "control-cache-limit-test-"));
    try {
      const first = join(rootDir, "first"); const second = join(rootDir, "second");
      await writeFile(first, "1234"); await writeFile(second, "5678");
      for (const cache of [new ValidatedHistoryCache(1, 100), new ValidatedHistoryCache(10, 6)]) {
        expect(await cache.read(first, (text) => [text])).toEqual(["1234"]);
        expect(await cache.read(second, (text) => [text])).toEqual(["5678"]);
        io.reads = 0;
        expect(await cache.read(first, (text) => [text])).toEqual(["1234"]);
        expect(io.reads).toBe(1);
      }
      const tiny = new ValidatedHistoryCache(1, 1);
      expect(await tiny.read(first, (text) => [text])).toEqual(["1234"]);
      io.reads = 0;
      expect(await tiny.read(first, (text) => [text])).toEqual(["1234"]);
      expect(io.reads).toBe(1);
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  });
});
