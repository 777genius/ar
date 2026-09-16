import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopAppServerProcess } from "../app-server/application/app-server-process-stopper";

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: { write: () => true, end: vi.fn() },
    stdout: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
    kill: vi.fn(() => true),
  });
}

describe("app-server process stopper", () => {
  afterEach(() => vi.useRealTimers());

  it("cleans up descendants when TERM exits only the parent without waiting", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const signals: NodeJS.Signals[] = [];
    let descendantAlive = true;

    await stopAppServerProcess({ child, exited: false, signal: (_, signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") child.emit("exit", 0, null);
      if (signal === "SIGKILL") descendantAlive = false;
    } });

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(descendantAlive).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("escalates and returns by the deadline even without a parent exit event", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const signal = vi.fn();
    const stopped = stopAppServerProcess({ child, exited: false, signal });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(signal.mock.calls.map((call) => call[1])).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
    expect(signal.mock.calls.map((call) => call[1])).toEqual(["SIGTERM", "SIGKILL", "SIGKILL"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not signal a parent already known to have exited before stop", async () => {
    const child = fakeChild();
    const signal = vi.fn();
    await stopAppServerProcess({ child, exited: true, signal });
    expect(signal).not.toHaveBeenCalled();
    expect(child.stdin.end).not.toHaveBeenCalled();
  });
});
