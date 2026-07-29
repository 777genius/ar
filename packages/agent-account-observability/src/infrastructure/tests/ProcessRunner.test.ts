import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { NodeProcessRunner } from "../ProcessRunner";

describe("NodeProcessRunner", () => {
  it.each([
    {
      name: "successful",
      exitCode: 0,
      stdout: "done",
      stderr: "",
    },
    {
      name: "failed",
      exitCode: 7,
      stdout: "",
      stderr: "bad",
    },
  ])(
    "keeps the $name child result when immediate exit makes stdin report EPIPE",
    async ({ exitCode, stdout, stderr }) => {
      const child = createImmediateExitChild({
        exitCode,
        stdout,
        stderr,
      });
      const result = await runnerFor(child).run({
        command: "immediate-exit",
        args: [],
        cwd: process.cwd(),
        env: {},
        stdin: "input the child will not read",
        timeoutMs: 10_000,
      });

      expect(result).toEqual({
        exitCode,
        stdout,
        stderr,
        timedOut: false,
      });
    },
  );

  it("kills a running child and reports a non-EPIPE stdin failure once", async () => {
    const child = createStdinFailureChild();
    const result = await runnerFor(child).run({
      command: "stdin-failure",
      args: [],
      cwd: process.cwd(),
      env: {},
      stdin: "input",
      timeoutMs: 10_000,
    });

    expect(child.killed).toBe(true);
    expect(child.signalCode).toBe("SIGTERM");
    expect(result).toEqual({
      exitCode: null,
      stdout: "",
      stderr: "safe child stderr\nstdin transport failed",
      timedOut: false,
    });
    expect(result.stderr.match(/stdin transport failed/g)).toHaveLength(1);
  });

  it("settles once on a child process error before its close event", async () => {
    const child = createSpawnErrorThenCloseChild();
    const result = await runnerFor(child).run({
      command: "missing-command",
      args: [],
      cwd: process.cwd(),
      env: {},
      stdin: "input",
      timeoutMs: 5,
    });
    await delay(20);

    expect(child.killed).toBe(false);
    expect(result).toEqual({
      exitCode: null,
      stdout: "",
      stderr: "spawn context\nspawn ENOENT",
      timedOut: false,
    });
  });
});

function runnerFor(child: ChildProcessWithoutNullStreams): NodeProcessRunner {
  return new NodeProcessRunner(
    (() => child) as typeof import("node:child_process").spawn,
  );
}

function createImmediateExitChild(input: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}): ChildProcessWithoutNullStreams {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let child: EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    kill(signal?: NodeJS.Signals): boolean;
  };
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      callback(error);
      queueMicrotask(() => {
        if (input.stdout) stdout.write(input.stdout);
        if (input.stderr) stderr.write(input.stderr);
        child.exitCode = input.exitCode;
        child.emit("close", input.exitCode, null);
      });
    },
  });
  child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    kill() {
      this.killed = true;
      return true;
    },
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

function createStdinFailureChild(): ChildProcessWithoutNullStreams {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let child: EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    kill(signal?: NodeJS.Signals): boolean;
  };
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      stderr.write("safe child stderr");
      callback(
        Object.assign(new Error("stdin transport failed"), { code: "EIO" }),
      );
    },
  });
  child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      this.killed = true;
      this.signalCode = signal;
      queueMicrotask(() => this.emit("close", null, signal));
      return true;
    },
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

function createSpawnErrorThenCloseChild(): ChildProcessWithoutNullStreams {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let child: EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    kill(signal?: NodeJS.Signals): boolean;
  };
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
      queueMicrotask(() => {
        stderr.write("spawn context");
        child.emit(
          "error",
          Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
        );
        stderr.write("late close output");
        child.exitCode = 0;
        child.emit("close", 0, null);
      });
    },
  });
  child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    kill() {
      this.killed = true;
      return true;
    },
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}
