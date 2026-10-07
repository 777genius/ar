import { strict as assert } from "node:assert";
import { closeSync, constants, openSync } from "node:fs";
import { afterEach, test, vi } from "vitest";
import * as fs from "node:fs";
import * as child from "node:child_process";
import { inspectVisibleScratchMount, readKernelMountTable, selectVisibleScratchMount } from "../host-scratch-mount";

// Builtin ESM namespace exports are nonconfigurable; expose mutable TEST exports
// while retaining the native functions for all unoverridden FD/anonymous-file work.
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>() }));

afterEach(() => vi.restoreAllMocks());

const target = "/jobs/NEWTEST/tmp", uuid = "d0f2cac1-2009-4e9d-a710-e156f417938f";
const hidden = { id: 10, target, uuid, fsroot: "/runtime-tmp/test" };
const row = (id: number, point: string, root = "/") => `${id} 1 8:1 ${root} ${point} rw - ext4 /dev/test rw`;
const query = (...filesystems: unknown[]) => ({ filesystems });

// RED: a hidden expected singleton is mistaken for an exact visible mount.
test("FD containing ancestor excludes the covered singleton and segment-prefix impostors", () => {
  const table = [row(10, target, hidden.fsroot), row(20, "/jobs/NEWTEST")].join("\n");
  assert.equal(selectVisibleScratchMount(target, 20, table, query(hidden)), undefined);
  assert.throws(() => selectVisibleScratchMount(target, 20, row(20, "/jobs/NEW"), query(hidden)), /Ambiguous/);
  assert.throws(() => selectVisibleScratchMount(target, 20, table, null), /Ambiguous/);
  // Corrupt query evidence must not become permission to prepare an ancestor-backed leaf.
  for (const corrupt of [null, { id: "bad" }, { id: 0 }]) {
    assert.throws(() => selectVisibleScratchMount(target, 20, table, query(corrupt)), /Ambiguous/);
  }
});

// RED: socket transport denies a supported root; unsupported anonymous files
// must raise the kernel error instead of returning a tuple or an absent mount.
test.runIf(process.platform === "linux")("real adapter preserves the root or rejects unsupported anonymous files", () => {
  let probe: number;
  try {
    // Independent kernel capability probe, not a filesystem-name assumption.
    // Linux O_TMPFILE|O_RDWR creates an unnamed inode, reclaimed on close.
    probe = openSync("/tmp", 0x410000 | constants.O_RDWR, 0o600);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOTSUP" ||
        !("syscall" in error) || error.syscall !== "open" || !("path" in error) || error.path !== "/tmp") throw error;
    assert.throws(() => inspectVisibleScratchMount("/"), { code: "ENOTSUP", syscall: "open", path: "/tmp" });
    return;
  }
  try {
    fs.writeFileSync(probe, readKernelMountTable(), { encoding: "utf8" });
    const full = JSON.parse(child.execFileSync("findmnt", ["--kernel", "--tab-file", "/proc/self/fd/0", "--json", "--mountpoint", "/", "--output", "ID,TARGET,UUID,FSROOT"],
      { stdio: [probe, "pipe", "pipe"], encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" }));
    const result = inspectVisibleScratchMount("/"); assert.ok(result);
    const visible = full.filesystems.find((value: { target: string }) => value.target === "/"); assert.ok(visible);
    assert.deepEqual(result, { target: "/", fsroot: visible.fsroot, ...(typeof visible.uuid === "string" ? { uuid: visible.uuid } : {}) });
  } finally { closeSync(probe); }
});

// RED: rejecting every multirow query prevents use of the real rebound directory.
test("only the unique visible FD-associated row supplies tuple authority", () => {
  const visible = { ...hidden, id: 30 };
  const table = [row(10, target, hidden.fsroot), row(30, target, hidden.fsroot)].join("\n");
  assert.deepEqual(selectVisibleScratchMount(target, 30, table, query(hidden, visible)),
    { target, uuid, fsroot: hidden.fsroot });
  assert.throws(() => selectVisibleScratchMount(target, 30, table, query(hidden)), /Ambiguous/);
  assert.throws(() => selectVisibleScratchMount(target, 30, table, query(visible, visible)), /Ambiguous/);
  assert.throws(() => selectVisibleScratchMount(target, 30, `${table}\n${row(30, target)}`, query(visible)), /Ambiguous/);
});

test("unknown visible tuples remain visible, while incoherent kernel records deny", () => {
  const actual = { id: 30, target, uuid: "foreign-volume", fsroot: "/foreign" };
  assert.deepEqual(selectVisibleScratchMount(target, 30, row(30, target, "/foreign"), query(hidden, actual)),
    { target, uuid: "foreign-volume", fsroot: "/foreign" });
  assert.throws(() => selectVisibleScratchMount(target, 30, row(30, target, "/other"), query(actual)), /Ambiguous/);
  assert.throws(() => selectVisibleScratchMount(target, 30, row(10, target), query(actual)), /Ambiguous/);
  const spaced = "/jobs/NEW TEST/tmp", escaped = "/jobs/NEW\\040TEST/tmp";
  assert.deepEqual(selectVisibleScratchMount(spaced, 30, row(30, escaped), query({ id: "30", target: spaced, uuid: null, fsroot: "/" })),
    { target: spaced, fsroot: "/" });
});

// The real reader owns the descriptor and enforces bytes, independently of parsing.
test("kernel reader accepts exact-cap EOF, rejects cap+1 and closes on failure", () => {
  const realOpen = fs.openSync, realRead = fs.readSync; let fd = -1, bytes = 8 * 1024 * 1024, used = 0, fault: Error | undefined;
  vi.spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: number | string, mode?: fs.Mode) => {
    fd = realOpen(process.execPath, flags, mode); return fd;
  }) as typeof fs.openSync);
  vi.spyOn(fs, "readSync").mockImplementation(((actual: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
    if (actual !== fd) return realRead(actual, buffer, offset, length, position);
    if (fault) throw fault;
    const n = Math.min(length, bytes - used); buffer.fill(120, offset, offset + n); used += n; return n;
  }) as typeof fs.readSync);
  assert.equal(readKernelMountTable().length, bytes); assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  used = 0; bytes++; assert.throws(readKernelMountTable, /Ambiguous/); assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  used = 0; fault = Error("NEWTEST reader fault"); assert.throws(readKernelMountTable, error => error === fault);
  assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
});

// Synthetic kernel bytes run through the real FD ownership/anonymous-input adapter.
// A reconstructed row, dropped duplicate, stale record or lost held FD must reject.
test.runIf(process.platform === "linux")("adapter queries the untouched original row and retains full-table refusals", () => {
  // Test the actual anonymous-file capability before installing synthetic kernel/query observations.
  let snapshot: number;
  try { snapshot = openSync("/tmp", 0x410000 | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_EXCL, 0o600); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOTSUP" ||
        !("syscall" in error) || error.syscall !== "open" || !("path" in error) || error.path !== "/tmp") throw error;
    assert.throws(() => inspectVisibleScratchMount("/"), { code: "ENOTSUP", syscall: "open", path: "/tmp" });
    return;
  }
  closeSync(snapshot);
  const probe = openSync("/", 0x200000 | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const id = Number(fs.readFileSync(`/proc/self/fdinfo/${probe}`, "utf8").match(/^mnt_id:\s+(\d+)$/m)![1]); closeSync(probe);
  const original = `${id} 1 8:1 /TEST\\040root / rw shared:7 master:3 - ext4 /dev/NEWTEST rw`, unrelated = row(id + 1, "/NEWTEST-unrelated");
  const realOpen = fs.openSync, realRead = fs.readSync, streams = new Map<number, { value: Buffer; used: number }>();
  let tables: string[] = [], held = -1, queryId = id, closeHeld = false, input = "";
  vi.spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: number | string, mode?: fs.Mode) => {
    const fd = realOpen(path, flags, mode);
    if (path === "/" && held === -1) held = fd;
    if (path === "/proc/self/mountinfo") streams.set(fd, { value: Buffer.from(tables.shift()!), used: 0 });
    else streams.delete(fd);
    return fd;
  }) as typeof fs.openSync);
  vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
    const stream = streams.get(fd); if (!stream) return realRead(fd, buffer, offset, length, position);
    const n = Math.min(length, stream.value.length - stream.used); stream.value.copy(buffer, offset, stream.used, stream.used + n); stream.used += n; return n;
  }) as typeof fs.readSync);
  const execute = vi.spyOn(child, "execFileSync").mockImplementation(((_file: string, _args: string[], options: { stdio: [number, string, string] }) => {
    input = fs.readFileSync(`/proc/self/fd/${options.stdio[0]}`, "utf8"); if (closeHeld) closeSync(held);
    return JSON.stringify(query({ id: queryId, target: "/", fsroot: "/TEST root", uuid: null }));
  }) as typeof child.execFileSync);
  const before = original + "\n" + unrelated + "\n";
  tables = [before, original.replace("rw shared:7", "ro shared:7") + "\n" + unrelated + "\n"];
  assert.deepEqual(inspectVisibleScratchMount("/"), { target: "/", fsroot: "/TEST root" }); assert.equal(input, original + "\n");
  for (const fault of ["wrong-id", "duplicate-id", "changed-record", "closed-fd", "malformed-row"]) {
    held = -1; queryId = fault === "wrong-id" ? id + 1 : id; closeHeld = fault === "closed-fd";
    tables = [fault === "duplicate-id" ? before + original + "\n" : fault === "malformed-row" ? `${id} invalid\n` : before,
      fault === "changed-record" ? before.replace("/TEST\\040root", "/changed") : before];
    assert.throws(() => inspectVisibleScratchMount("/"));
  }
  assert.ok(execute.mock.calls.length >= 1);
});
