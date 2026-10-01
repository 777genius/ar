import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { parseHostedOrdinaryStart } from "@vioxen/subscription-runtime/worker-core";
import { readHostedOrdinaryProcessOrigin } from "../../provider-codex/app-server/adapters/hosted-process-activation";
import { HostedInstallationActivationStore } from "../hosted-installation-activation";
import { runHostedRuntimeForeground } from "../hosted-readonly-foreground";
import { enrolledTestChild } from "./hosted-child-slot-test-support";

// Registered in the installation suite to reuse its disposable private records
// and finite kernel/systemd facts. Admission, reservation and watcher are real.
export function registerChildForegroundDeadlineTests({ fixture, runtimeDirectory, read, put }: {
  fixture: { child: unknown; spawn: ReturnType<typeof vi.fn>; stops: string[];
    onStop: (() => void) | undefined; runtimeUnit: string; group: string };
  runtimeDirectory: string;
  read: (name: string) => Record<string, unknown>;
  put: (name: string, value: unknown) => void;
}): void {
  // Bug: child expiry/ambiguous submission closes siblings, refunds a birth, claims terminal custody, or opens MiMo activation.
  it.each(["wall-rollback", "monotonic-rollback", "elapsed-expiry"])("foreground rechecks the original budget immediately after submission: %s", async mode => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let monotonic = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const { store, launch } = enrolledTestChild(runtimeDirectory, read("readonly-inventory.json"), put);
    fixture.onStop = () => {
      expect(store.read().phase).toBe("ORDINARY");
      expect(() => withHostedActivationFence(() => {})).not.toThrow();
    };
    fixture.spawn.mockImplementation(() => {
      expect(store.read().ordinaryStarts.map(row => row.state)).toEqual(["reserved"]);
      if (mode === "wall-rollback") vi.setSystemTime(Date.now() - 30_000);
      else if (mode === "monotonic-rollback") monotonic -= 1;
      else monotonic += 60_001;
      return fixture.child;
    });
    const pending = runHostedRuntimeForeground(launch.command, launch.args, launch.cwd, {});
    let error: unknown;
    const settled = pending.catch(caught => { error = caught; });
    try {
      await Promise.resolve();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(mode === "elapsed-expiry" ? "child_deadline_expired" : "child_clock_inconsistent");
      expect(fixture.spawn).toHaveBeenCalledOnce();
      const starts = store.read().ordinaryStarts;
      expect(starts.map(row => row.state)).toEqual(["reserved"]);
      expect(new Set(fixture.stops)).toEqual(new Set([starts[0]!.unit]));
      expect(store.read().phase).toBe("ORDINARY");
      expect(() => read(`ordinary-completed/${starts[0]!.startId}.json`)).toThrow();
      const replacement = vi.fn();
      expect(() => new HostedInstallationActivationStore().runOrdinaryRuntimeLaunch(launch.command, launch.args, launch.cwd, replacement))
        .toThrow("child_invocation_consumed");
      expect(replacement).not.toHaveBeenCalled();
    } finally {
      (fixture.child as EventEmitter).emit("exit", null, "SIGTERM"); await settled; vi.useRealTimers();
    }
  });

  it("foreground watcher includes elapsed submission time in the original monotonic deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let monotonic = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const { store, launch } = enrolledTestChild(runtimeDirectory, read("readonly-inventory.json"), put);
    const wall = Date.now();
    fixture.spawn.mockImplementation(() => { monotonic = 20_000; return fixture.child; });
    const pending = runHostedRuntimeForeground(launch.command, launch.args, launch.cwd, {});
    const child = fixture.child as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    try {
      monotonic = 59_999; await vi.advanceTimersByTimeAsync(39_999);
      expect(fixture.stops).toEqual([]); expect(child.kill).not.toHaveBeenCalled();
      // Wall time progresses more slowly than elapsed time; it cannot extend the budget.
      vi.setSystemTime(wall + 39_999);
      monotonic = 60_001; await vi.advanceTimersByTimeAsync(2);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      const starts = store.read().ordinaryStarts;
      expect(starts.map(row => row.state)).toEqual(["reserved"]);
      expect(new Set(fixture.stops)).toEqual(new Set([starts[0]!.unit]));
      expect(store.read().phase).toBe("ORDINARY");
      expect(() => read(`ordinary-completed/${starts[0]!.startId}.json`)).toThrow();
      child.emit("exit", null, "SIGTERM"); expect(await pending).toBe(70);
    } finally { child.emit("exit", null, "SIGTERM"); await pending; vi.useRealTimers(); }
  });

  it.each(["ambiguous", "deadline"])("retains one child birth with scoped cleanup: %s", async mode => {
    const { store, launch } = enrolledTestChild(runtimeDirectory, read("readonly-inventory.json"), put);
    fixture.onStop = () => {
      expect(store.read().phase).toBe("ORDINARY");
      expect(() => withHostedActivationFence(() => {})).not.toThrow();
    };
    if (mode === "ambiguous") {
      expect(() => store.runOrdinaryRuntimeLaunch(launch.command, launch.args, launch.cwd, () => {
        throw new Error("TEST ambiguous submission");
      })).toThrow("ambiguous submission");
    } else {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      try {
        const pending = runHostedRuntimeForeground(launch.command, launch.args, launch.cwd, {});
        await vi.advanceTimersByTimeAsync(60_001);
        expect((fixture.child as { kill: unknown }).kill).toHaveBeenCalledWith("SIGTERM");
        (fixture.child as EventEmitter).emit("exit", null, "SIGTERM"); expect(await pending).toBe(70);
      } finally { vi.useRealTimers(); }
    }
    const starts = store.read().ordinaryStarts;
    expect(starts).toHaveLength(1); expect(starts[0]?.state).toBe("reserved");
    expect(new Set(fixture.stops)).toEqual(new Set([starts[0]!.unit]));
    expect(() => new HostedInstallationActivationStore().runOrdinaryRuntimeLaunch(launch.command, launch.args, launch.cwd,
      () => { throw new Error("replacement must not submit"); })).toThrow("child_invocation_consumed");
    expect(() => read(`ordinary-completed/${starts[0]!.startId}.json`)).toThrow();
    expect(store.stopOrdinaryRuntime({ jobId: "ordinary-job", jobRootDir: "/jobs/ordinary-job", workspacePath: launch.cwd })).toBe(true);
    expect(store.read().phase).toBe("ORDINARY");
    const start = parseHostedOrdinaryStart(read(`ordinary-starts/${starts[0]!.startId}.json`));
    fixture.runtimeUnit = start.unit; fixture.group = start.controlGroup;
    expect(() => withHostedActivationFence(fence => readHostedOrdinaryProcessOrigin(fence))).toThrow("hosted_mimo_activation_closed");
  });
}

/** PR4 correlation seam on the actual PR3 immutable slot/ordinary store. */
export function registerKeyedCorrelationTests(input: Parameters<typeof registerChildForegroundDeadlineTests>[0]): void {
  it("PR4 persists predetermined reservation and start in the existing sync fence and refuses replay", () => {
    const { store, launch } = enrolledTestChild(input.runtimeDirectory, input.read("readonly-inventory.json"), input.put);
    const startId = "cccccccc-cccc-cccc-cccc-cccccccccccc", unit = `subscription-runtime-ordinary-${startId}.service`;
    withHostedActivationFence(fence => {
      const prepared = store.reserveOrdinaryRuntime(fence, launch.command, launch.args, launch.cwd, { startId, unit });
      expect(prepared.reservation.startId).toBe(startId); expect(prepared.start.unit).toBe(unit);
      expect(store.read().ordinaryStarts[0]!.startId).toBe(startId);
      expect(input.read(`ordinary-starts/${startId}.json`).unit).toBe(unit);
      expect(() => withHostedActivationFence(() => {})).toThrow(); // Same uninterrupted fence.
      expect(() => store.reserveOrdinaryRuntime(fence, launch.command, launch.args, launch.cwd, { startId, unit })).toThrow();
    });
    expect(input.fixture.spawn).not.toHaveBeenCalled(); expect(store.read().ordinaryStarts).toHaveLength(1);
  });
  it("PR4 rejects changed unit correlation before publishing an ordinary reservation", () => {
    const { store, launch } = enrolledTestChild(input.runtimeDirectory, input.read("readonly-inventory.json"), input.put);
    withHostedActivationFence(fence => expect(() => store.reserveOrdinaryRuntime(fence, launch.command, launch.args, launch.cwd,
      { startId: "cccccccc-cccc-cccc-cccc-cccccccccccc", unit: "foreign.service" })).toThrow());
    expect(store.read().ordinaryStarts).toHaveLength(0); expect(input.fixture.spawn).not.toHaveBeenCalled();
  });
}
