import { spawn } from "node:child_process";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { BoundedStorageFailure } from "../../src/worker-core/storage/bounded-storage-contract";
import { NativeWire } from "./native-wire";

describe("native wire own-process deadline", () => {
  // Red on R1: the real child keeps stdin open without reading, so an 8MiB
  // publish payload cannot finish its write callback and consume() never runs.
  it("times out blocked publication writes, closes only its child and refuses replay", async () => {
    let ownedWire: NativeWire | undefined;
    // Register cleanup before clock activation, including a failed phase barrier.
    onTestFinished(async () => { vi.useRealTimers(); ownedWire?.stop(); if (ownedWire) await ownedWire.exited; });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const child = spawn("/bin/sleep", ["30"], { stdio: ["pipe", "pipe", "pipe"], env: { LC_ALL: "C" } });
    const wire = ownedWire = new NativeWire(child, 150);
    let repliesRead = 0;
    try {
      // Attach rejection observation synchronously, before any timer or I/O turn.
      const publication = wire.command("PUBLISH 4194304 4194304\n", Buffer.alloc(8388608, 120), async () => { repliesRead++; return wire.line(); })
        .then(value => ({ kind: "completed" as const, value }), error => ({ kind: "failed" as const, error: error as unknown }));
      // setImmediate and the actual OS pipe/child remain real. Bound the I/O
      // phase turns; the watchdog clock cannot advance until payload is queued.
      for (let turn = 0; turn < 16 && child.stdin.writableLength < 8388608; turn++) await new Promise<void>(resolve => setImmediate(resolve));
      expect(child.stdin.writableLength).toBeGreaterThanOrEqual(8388608);
      expect(repliesRead).toBe(0);
      await vi.advanceTimersByTimeAsync(150);
      const observed = await Promise.race([
        publication,
        // Detect the old blocked write without waiting forever or extending the
        // 150ms deadline: one real I/O turn must follow a settled watchdog.
        new Promise<{ kind: "hung" }>(resolve => setImmediate(() => resolve({ kind: "hung" }))),
      ]);
      expect(observed.kind).toBe("failed");
      if (observed.kind !== "failed") throw new Error("publication_write_deadline_missing");
      expect(observed.error).toMatchObject({ reason: BoundedStorageFailure.Uncertain });
      expect(repliesRead).toBe(0);
      expect(await wire.exited).toStrictEqual({ code: null, signal: "SIGKILL" });
      await expect(wire.command("ASSERT\n", undefined, () => wire.line())).rejects.toMatchObject({ reason: BoundedStorageFailure.Uncertain });
      expect(repliesRead).toBe(0);
    } finally {
      vi.useRealTimers(); wire.stop(); await wire.exited;
    }
  }, 5000);
});
