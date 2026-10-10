import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CrashLaneCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  readonly killAfterMs?: number;
}

// The foreground supervisor owns exactly one child process group. Unlike a
// Vitest hook timeout, this watchdog still fires if the worker blocks forever.
export async function runCrashLane(lane: number, command: CrashLaneCommand): Promise<number> {
  if (!Number.isInteger(lane) || lane < 0 || lane >= 8) {
    throw new Error("SHARD_LANE must be an integer from 0 to 7");
  }
  const shards = Array.from({ length: 54 }, (_, shard) => shard)
    .filter((shard) => shard % 8 === lane);
  const directory = await mkdtemp(join(tmpdir(), "crash-lane-"));
  const socketPath = join(directory, "progress.sock");
  const server = createServer();
  const connections = new Set<import("node:net").Socket>();
  let child: ReturnType<typeof spawn> | undefined;
  let budget: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let failure = false;
  let next = 0;
  let active: number | undefined;
  const signalChild = (signal: NodeJS.Signals) => {
    if (!child?.pid) return;
    try {
      // detached creates an owned group, not a shell background job. Signal
      // only that group's known leader and Vitest's worker descendants.
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const abort = (reason: string) => {
    if (failure) return;
    failure = true;
    clearTimeout(budget);
    process.stderr.write(`crash lane ${lane}: ${reason}\n`);
    signalChild("SIGTERM");
    killTimer = setTimeout(() => signalChild("SIGKILL"), command.killAfterMs ?? 10_000);
  };
  const armBudget = (label: string) => {
    clearTimeout(budget);
    budget = setTimeout(() => abort(`${label} exceeded ${command.timeoutMs ?? 240_000}ms`),
      command.timeoutMs ?? 240_000);
  };
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => abort("progress socket failed"));
    let buffer = "";
    socket.on("data", (data: Buffer) => {
      buffer += data.toString();
      if (buffer.length > 128) {
        abort("oversized progress record");
        socket.destroy();
        return;
      }
      if (!buffer.endsWith("\n")) return;
      try {
        const event: unknown = JSON.parse(buffer);
        if (!event || typeof event !== "object"
          || !("shard" in event) || !("complete" in event)
          || typeof event.shard !== "number" || typeof event.complete !== "boolean"
          || event.shard !== shards[next] || failure) {
          throw new Error("unexpected shard progress");
        }
        if (!event.complete && active === undefined) {
          active = event.shard;
          armBudget(`shard ${active} (fixture setup, certification and cleanup)`);
          process.stdout.write(`crash lane ${lane}: shard ${active} started (boundaries ${active * 4}..${Math.min(active * 4 + 3, 212)})\n`);
        } else if (event.complete && active === event.shard) {
          process.stdout.write(`crash lane ${lane}: shard ${active} completed\n`);
          active = undefined;
          next += 1;
          armBudget(next === shards.length ? "Vitest shutdown" : "next shard startup");
        } else {
          throw new Error("out-of-order shard lifecycle");
        }
        socket.end("ok\n");
      } catch {
        abort("invalid or out-of-order progress record");
        socket.destroy();
      }
    });
  });
  const onSignal = (signal: NodeJS.Signals) => abort(`supervisor received ${signal}`);
  const onTerm = () => onSignal("SIGTERM");
  const onInterrupt = () => onSignal("SIGINT");
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(socketPath, done);
    });
    child = spawn(command.executable, [...command.args], {
      stdio: "inherit",
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        SHARD_LANE: String(lane),
        CODEX_LEDGER_EPOCH_CRASH_RANGE_ONLY: "1",
        CODEX_LEDGER_EPOCH_CRASH_LANE_SOCKET: socketPath,
      },
    });
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInterrupt);
    armBudget("Vitest startup/import");
    const result = await new Promise<number>((done, reject) => {
      child!.once("error", reject);
      child!.once("close", (code) => done(code ?? 1));
    });
    // Even a zero exit cannot certify an incomplete or overlapping lane.
    const certified = !failure && result === 0 && next === shards.length && active === undefined;
    if (certified) {
      const boundaries = shards.reduce((count, shard) => count + Math.min(4, 213 - shard * 4), 0);
      process.stdout.write(`crash lane ${lane}: certified ${shards.length} shard files / ${boundaries} boundaries\n`);
    }
    return certified ? 0 : 1;
  } finally {
    clearTimeout(budget);
    // Kill remaining owned descendants even if their leader already exited.
    signalChild("SIGKILL");
    clearTimeout(killTimer);
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInterrupt);
    for (const socket of connections) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runCrashLane(Number(process.argv[2] ?? process.env.SHARD_LANE), {
      executable: process.execPath,
      args: ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.crash-shard.config.ts", "--maxWorkers=1"],
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
