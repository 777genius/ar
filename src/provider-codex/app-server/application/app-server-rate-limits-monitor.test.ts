import { describe, expect, it, vi } from "vitest";
import {
  AppServerRateLimitsMonitor,
  CodexAppServerRateLimitsRejectedError,
} from "./app-server-rate-limits-monitor";

describe("AppServerRateLimitsMonitor", () => {
  it("uses the TTL cache instead of polling repeated initial reads", async () => {
    let now = new Date("2026-09-04T10:00:00.000Z");
    const read = vi.fn(async () => ({ rateLimits: { primary: null } }));
    const handle = vi.fn(async () => ({ status: "admitted" as const }));
    const monitor = new AppServerRateLimitsMonitor({
      read,
      handle,
      now: () => now,
      cacheTtlMs: 30_000,
    });

    await monitor.prime();
    now = new Date("2026-09-04T10:00:20.000Z");
    await monitor.prime();

    expect(read).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({
      source: "initial_read",
    }));
  });

  it("invalidates the cache and refetches a full snapshot after push updates", async () => {
    const snapshots = [
      { rateLimits: { primary: { usedPercent: 10 } } },
      { rateLimits: { primary: { usedPercent: 100 } } },
    ];
    const read = vi.fn(async () => snapshots.shift());
    const handled: unknown[] = [];
    const monitor = new AppServerRateLimitsMonitor({
      read,
      handle: async (input) => {
        handled.push(input);
        return { status: "admitted" };
      },
    });

    await monitor.prime();
    monitor.notifyRateLimitsUpdated();
    await monitor.flush();

    expect(read).toHaveBeenCalledTimes(2);
    expect(handled).toEqual([
      expect.objectContaining({ source: "initial_read" }),
      expect.objectContaining({ source: "notification_refetch" }),
    ]);
  });

  it("coalesces concurrent push updates without losing a newer generation", async () => {
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const read = vi.fn()
      .mockImplementationOnce(async () => {
        await firstRead;
        return { rateLimits: { primary: { usedPercent: 1 } } };
      })
      .mockResolvedValue({ rateLimits: { primary: { usedPercent: 2 } } });
    const monitor = new AppServerRateLimitsMonitor({
      read,
      handle: async () => ({ status: "admitted" }),
    });

    const initial = monitor.prime();
    monitor.notifyRateLimitsUpdated();
    monitor.notifyRateLimitsUpdated();
    releaseFirst();
    await initial;
    await monitor.flush();

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects a limited account during preflight", async () => {
    const monitor = new AppServerRateLimitsMonitor({
      read: async () => ({ rateLimits: { primary: { usedPercent: 100 } } }),
      handle: async () => ({ status: "rejected", reason: "quota_limited" }),
    });

    await expect(monitor.prime()).rejects.toEqual(
      new CodexAppServerRateLimitsRejectedError("quota_limited"),
    );
  });
});
