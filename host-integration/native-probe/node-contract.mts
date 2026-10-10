import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, readlinkSync, readSync, writeSync } from "node:fs";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { scrypt } from "node:crypto";
import { promisify } from "node:util";

interface NativeRefusalClient { readonly probe: () => boolean }
interface ThreadMessage { readonly ready?: boolean; readonly refused?: boolean }
interface ThreadInput { readonly addon: string; readonly barrier: SharedArrayBuffer }
function load(addon: string): NativeRefusalClient {
  const value: unknown = createRequire(import.meta.url)(addon);
  assert.ok(value && typeof value === "object" && "probe" in value && typeof value.probe === "function");
  const callable = value.probe;
  return Object.freeze({ probe: () => { const result: unknown = Reflect.apply(callable, value, []); assert.equal(typeof result, "boolean"); return result === true; } });
}
function filters(): Map<string, number> {
  const result = new Map<string, number>();
  for (const tid of readdirSync("/proc/self/task")) {
    let status: string;
    try { status = readFileSync(`/proc/self/task/${tid}/status`, "utf8"); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw error; }
    const match = /^Seccomp_filters:\s*([0-9]+)$/m.exec(status); assert.ok(match);
    result.set(tid, Number(match[1]));
  }
  return result;
}
function assertNoIoUringDescriptors(): void {
  for (const fd of readdirSync("/proc/self/fd")) {
    try { assert.ok(!readlinkSync(`/proc/self/fd/${fd}`).includes("io_uring"), `no retained io_uring descriptor ${fd}`); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw error; }
  }
}
if (!isMainThread) {
  const input: unknown = workerData;
  assert.ok(input && typeof input === "object" && "addon" in input && typeof input.addon === "string" && "barrier" in input && input.barrier instanceof SharedArrayBuffer);
  const data: ThreadInput = { addon: input.addon, barrier: input.barrier };
  parentPort!.postMessage({ ready: true } satisfies ThreadMessage);
  const barrier = new Int32Array(data.barrier); Atomics.wait(barrier, 0, 0);
  parentPort!.postMessage({ refused: load(data.addon).probe() } satisfies ThreadMessage);
  parentPort!.close();
} else {
  const addon = process.argv[2]; assert.ok(addon);
  const handshake = Buffer.alloc(1); assert.equal(readSync(3, handshake, 0, 1, null), 1);
  const barrier = new SharedArrayBuffer(4);
  const existing = new Worker(new URL(import.meta.url), { workerData: { addon, barrier } satisfies ThreadInput });
  function message(worker: Worker, key: keyof ThreadMessage): Promise<boolean> {
    return new Promise((accept, reject) => {
      const listener = (input: unknown): void => {
        assert.ok(input && typeof input === "object");
        if (!Object.hasOwn(input, key)) return;
        const value: unknown = Reflect.get(input, key); assert.equal(typeof value, "boolean"); worker.off("message", listener); accept(value === true);
      };
      worker.on("message", listener);
      worker.once("error", reject);
      worker.once("exit", code => { if (code) reject(new Error(`Node thread exited ${code}`)); });
    });
  }
  function exit(worker: Worker): Promise<void> { return new Promise((accept, reject) => { worker.once("exit", code => code === 0 ? accept() : reject(new Error(`Node thread exited ${code}`))); worker.once("error", reject); }); }
  const existingExit = exit(existing); assert.equal(await message(existing, "ready"), true);
  assertNoIoUringDescriptors();
  const before = filters(); const client = load(addon); const after = filters();
  for (const [tid, count] of before) assert.equal(after.get(tid), count + 1, `TSYNC covers original Node thread ${tid}`);
  assert.equal(client.probe(), true);
  const originalRefused = message(existing, "refused");
  Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
  assert.equal(await originalRefused, true); await existingExit;
  const freshBarrier = new SharedArrayBuffer(4); Atomics.store(new Int32Array(freshBarrier), 0, 1);
  const fresh = new Worker(new URL(import.meta.url), { workerData: { addon, barrier: freshBarrier } satisfies ThreadInput });
  const freshExit = exit(fresh); const freshReady = message(fresh, "ready");
  const freshRefused = message(fresh, "refused"); assert.equal(await freshReady, true); assert.equal(await freshRefused, true); await freshExit;
  // This schedules the actual libuv pool after sealing, independently of V8 threads.
  const key = await promisify(scrypt)("owned-fixture", "disposable", 16); assert.ok(Buffer.isBuffer(key) && key.length === 16);
  assertNoIoUringDescriptors();
  const packet = Buffer.alloc(32); packet.writeUInt32LE(0x4e505631); packet.writeUInt16LE(1, 4); packet.writeUInt16LE(1, 6); packet.writeBigUInt64LE(42n, 8); packet.writeBigUInt64LE(1n, 16);
  assert.equal(writeSync(3, packet), 32); assert.equal(readSync(3, handshake, 0, 1, null), 1);
  process.stdout.write(JSON.stringify({ node: process.version, originalThreads: before.size, tsync: true, existingWorker: true, freshWorker: true, libuvPool: true, endpointRetained: true, ioUringRefused: true, ioUringCustodyAbsent: true }) + "\n");
}
