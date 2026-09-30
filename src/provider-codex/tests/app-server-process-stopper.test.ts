import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerProcessCleanupError, stopAppServerProcess } from "../app-server/application/app-server-process-stopper";

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

  it("rejects at the deadline when the independently observed child remains alive", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const signal = vi.fn();
    const stopped = stopAppServerProcess({ child, exited: false, signal });

    const outcome = stopped.then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signal.mock.calls.map((call) => call[1])).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await outcome).not.toBeNull();
    expect(await outcome).toBeInstanceOf(AppServerProcessCleanupError);
    expect((await outcome as Error).cause).toEqual(new Error("codex_app_server_stop_timeout"));
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
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

  it("completes live numeric-group escalation without signalling again after observed exit", async () => {
    vi.useFakeTimers();
    const child = Object.assign(fakeChild(), { pid: 812346 });
    const signals: NodeJS.Signals[] = [];
    const stopped = stopAppServerProcess({ child, exited: false, signal: (_, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") child.emit("exit", 0, null);
    } });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(stopped).resolves.toBeUndefined();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["TERM", "escalation", "observation", "final"])("preserves %s failure and removes observations and timers", async (where) => {
    vi.useFakeTimers();
    const child = fakeChild();
    const failure = new Error("fake cleanup failure");
    let kills = 0;
    const result = stopAppServerProcess({ child, exited: false, signal: (_, signal) => {
      if (signal === "SIGTERM") {
        if (where === "TERM") throw failure;
        if (where === "observation") child.emit("error", failure);
        if (where === "final") child.emit("exit", 0, null);
      } else {
        kills += 1;
        if (where === "final" || (where === "escalation" && kills === 1)) throw failure;
      }
    } }).catch((error: unknown) => error);
    if (where === "escalation") await vi.advanceTimersByTimeAsync(5_000);
    const error = await result;
    expect(error).toBeInstanceOf(AppServerProcessCleanupError);
    expect((error as Error).cause).toBe(failure);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves observation and final signal failures together", async () => {
    const child = fakeChild();
    const observation = new Error("fake observation failure");
    const signalFailure = new Error("fake signal failure");
    const error = await stopAppServerProcess({ child, exited: false, signal: (_, signal) => {
      if (signal === "SIGTERM") child.emit("error", observation);
      else throw signalFailure;
    } }).catch((error: unknown) => error);
    expect((error as Error).cause).toBeInstanceOf(AggregateError);
    expect(((error as Error).cause as AggregateError).errors).toEqual([observation, signalFailure]);
  });

});
