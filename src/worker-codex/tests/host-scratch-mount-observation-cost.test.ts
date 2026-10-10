import { strict as assert } from "node:assert";
import { constants } from "node:fs";
import { afterEach, beforeEach, test, vi } from "vitest";
import { inspectVisibleScratchMount } from "../host-scratch-mount";

type Handle = { bytes: Buffer; offset: number; directory: boolean; fresh: boolean };
const native = vi.hoisted(() => ({
  handles: new Map<number, Handle>(), nextFd: 100, targetOpens: 0, mountReads: 0, namespaceReads: 0,
  before: "", after: "", namespace: "mnt:[NEWTEST-original]", afterNamespace: "mnt:[NEWTEST-original]",
  heldMountId: 30, freshMountId: 30, freshInode: 50, descriptorInode: 50,
  inputs: [] as string[], query: {} as unknown, queryError: undefined as Error | undefined,
  anonymousError: undefined as Error | undefined, afterQuery: undefined as (() => void) | undefined,
}));
vi.mock("node:fs", async original => ({
  ...await original<typeof import("node:fs")>(),
  openSync(path: string, flags: number, mode?: number) {
    let handle: Handle;
    if (path === "/proc/self/mountinfo") {
      native.mountReads++;
      handle = { bytes: Buffer.from(native.mountReads === 1 ? native.before : native.after), offset: 0, directory: false, fresh: false };
    } else if (path.startsWith("/proc/self/fdinfo/")) {
      const directory = native.handles.get(Number(path.slice("/proc/self/fdinfo/".length)));
      assert.ok(directory?.directory);
      const id = directory.fresh ? native.freshMountId : native.heldMountId;
      handle = { bytes: Buffer.from(`mnt_id:\t${id}\n`), offset: 0, directory: false, fresh: false };
    } else if (path === "/tmp") {
      assert.ok((flags & 0x410000) === 0x410000);
      assert.ok(flags & constants.O_NOFOLLOW); assert.ok(flags & constants.O_EXCL); assert.equal(mode, 0o600);
      if (native.anonymousError) throw native.anonymousError;
      handle = { bytes: Buffer.alloc(0), offset: 0, directory: false, fresh: false };
    } else {
      assert.ok(path.startsWith("/jobs/NEWTEST/"));
      assert.ok(flags & 0x200000); assert.ok(flags & constants.O_DIRECTORY); assert.ok(flags & constants.O_NOFOLLOW);
      native.targetOpens++;
      handle = { bytes: Buffer.alloc(0), offset: 0, directory: true, fresh: native.targetOpens > 1 };
    }
    const fd = native.nextFd++; native.handles.set(fd, handle); return fd;
  },
  closeSync(fd: number) { assert.ok(native.handles.delete(fd)); },
  fstatSync(fd: number) {
    const handle = native.handles.get(fd); assert.ok(handle?.directory);
    return { dev: 8, ino: handle.fresh ? native.freshInode : native.descriptorInode, isDirectory: () => true };
  },
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) {
    const handle = native.handles.get(fd); assert.ok(handle);
    const start = position ?? handle.offset, count = Math.min(length, handle.bytes.length - start);
    buffer.set(handle.bytes.subarray(start, start + count), offset); if (position === null) handle.offset += count;
    return count;
  },
  writeFileSync(fd: number, bytes: string) {
    const handle = native.handles.get(fd); assert.ok(handle); handle.bytes = Buffer.from(bytes);
  },
  readlinkSync(path: string) {
    assert.equal(path, "/proc/self/ns/mnt"); native.namespaceReads++;
    return native.namespaceReads === 1 ? native.namespace : native.afterNamespace;
  },
}));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  execFileSync(command: string, args: readonly string[], options: { stdio: readonly unknown[]; timeout: number; maxBuffer: number; killSignal: string }) {
    assert.equal(command, "findmnt");
    assert.deepEqual(args.slice(0, 5), ["--kernel", "--tab-file", "/proc/self/fd/0", "--json", "--mountpoint"]);
    assert.deepEqual(args.slice(-2), ["--output", "ID,TARGET,UUID,FSROOT"]);
    assert.equal(options.timeout, 2000); assert.equal(options.maxBuffer, 1024 * 1024); assert.equal(options.killSignal, "SIGKILL");
    const handle = native.handles.get(options.stdio[0] as number); assert.ok(handle);
    native.inputs.push(handle.bytes.toString("utf8")); native.afterQuery?.();
    if (native.queryError) throw native.queryError;
    return JSON.stringify(native.query);
  },
}));
const target = "/jobs/NEWTEST/tmp", uuid = "d0f2cac1-2009-4e9d-a710-e156f417938f";
const row = (id: number, point: string, root = "/") => `${id} 1 8:1 ${root} ${point} rw - ext4 /dev/NEWTEST rw`;
const selected = row(30, target, "/runtime-tmp/NEWTEST-source");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  native.handles.clear(); native.nextFd = 100; native.targetOpens = 0; native.mountReads = 0; native.namespaceReads = 0;
  native.before = selected + "\n"; native.after = native.before;
  native.namespace = native.afterNamespace = "mnt:[NEWTEST-original]";
  native.heldMountId = native.freshMountId = 30; native.freshInode = native.descriptorInode = 50;
  native.inputs.length = 0; native.queryError = native.anonymousError = undefined; native.afterQuery = undefined;
  native.query = { filesystems: [{ id: 30, target, uuid, fsroot: "/runtime-tmp/NEWTEST-source" }] };
});
afterEach(() => { Object.defineProperty(process, "platform", platform); assert.equal(native.handles.size, 0); });

// Old RED: external libmount input grows with unrelated rows rather than the FD witness.
test("large NEWTEST topology sends only the original FD-selected row to libmount", () => {
  const background = Array.from({ length: 14600 }, (_, index) =>
    `${1000 + index} 1 0:44 net:[4026533000] /NEWTEST-unrelated/${index} rw - nsfs nsfs rw`);
  native.before = [row(10, target, "/NEWTEST-hidden"), ...background, selected].join("\n") + "\n";
  native.after = native.before;
  assert.deepEqual(inspectVisibleScratchMount(target), { target, uuid, fsroot: "/runtime-tmp/NEWTEST-source", mountId: 30, isPrivate: true });
  assert.deepEqual(native.inputs, [selected + "\n"]);
  assert.equal(native.mountReads, 2); assert.equal(native.targetOpens, 2); assert.equal(native.namespaceReads, 2);
});

// Old RED: known ancestor absence still launches a full-table external query.
test("hidden expected leaf below the FD ancestor remains absent without querying libmount", () => {
  native.before = [selected, row(20, "/jobs/NEWTEST")].join("\n") + "\n"; native.after = native.before;
  native.heldMountId = native.freshMountId = 20;
  assert.equal(inspectVisibleScratchMount(target), undefined); assert.deepEqual(native.inputs, []);
  assert.equal(native.mountReads, 2); assert.equal(native.targetOpens, 2); assert.equal(native.namespaceReads, 2);
});

test.each([false, true])("duplicate selected ID anywhere in full topology denies before libmount (after=%s)", duplicateAfter => {
  const duplicate = row(30, "/NEWTEST-unrelated-duplicate");
  native.before = duplicateAfter ? native.before + duplicate + "\n" : duplicate + "\n" + native.before;
  native.after = native.before;
  assert.throws(() => inspectVisibleScratchMount(target), /Ambiguous/); assert.deepEqual(native.inputs, []);
});

test.each(["named-mount", "held-mount", "named-inode", "held-inode", "namespace", "record", "duplicate-after"])(
  "exact leaf refuses %s drift after querying its selected row", fault => {
    native.afterQuery = () => {
      if (fault === "named-mount") native.freshMountId = 40;
      if (fault === "held-mount") native.heldMountId = 40;
      if (fault === "named-inode") native.freshInode = 60;
      if (fault === "held-inode") native.descriptorInode = 60;
      if (fault === "namespace") native.afterNamespace = "mnt:[NEWTEST-changed]";
      if (fault === "record") native.after = row(30, target, "/NEWTEST-changed") + "\n";
      if (fault === "duplicate-after") native.after += selected + "\n";
    };
    assert.throws(() => inspectVisibleScratchMount(target), /Ambiguous/); assert.deepEqual(native.inputs, [selected + "\n"]);
  });

test.each(["mount-id", "namespace", "record", "duplicate-after"])("ancestor absence still refuses final %s drift", fault => {
  native.before = native.after = row(20, "/jobs/NEWTEST") + "\n"; native.heldMountId = native.freshMountId = 20;
  if (fault === "mount-id") native.freshMountId = 40;
  if (fault === "namespace") native.afterNamespace = "mnt:[NEWTEST-changed]";
  if (fault === "record") native.after = row(20, "/jobs/NEWTEST", "/NEWTEST-changed") + "\n";
  if (fault === "duplicate-after") native.after += native.before;
  assert.throws(() => inspectVisibleScratchMount(target), /Ambiguous/); assert.deepEqual(native.inputs, []);
  assert.equal(native.mountReads, 2); assert.equal(native.targetOpens, 2);
});

test("segment-prefix impostor is not an authenticated ancestor", () => {
  native.before = native.after = row(20, "/jobs/NEW") + "\n"; native.heldMountId = native.freshMountId = 20;
  assert.throws(() => inspectVisibleScratchMount(target), /Ambiguous/); assert.deepEqual(native.inputs, []);
});

test("original escaped row is passed unchanged while query authority uses decoded paths", () => {
  const spaced = "/jobs/NEWTEST/NEW TEST cache", escaped = "/jobs/NEWTEST/NEW\\040TEST\\040cache";
  const original = `${row(30, escaped, "/runtime-tmp/NEW\\040TEST").replace(" rw - ", " rw shared:7 - ")}\n`;
  native.before = native.after = original;
  native.query = { filesystems: [{ id: "30", target: spaced, uuid, fsroot: "/runtime-tmp/NEW TEST" }] };
  assert.deepEqual(inspectVisibleScratchMount(spaced), { target: spaced, uuid, fsroot: "/runtime-tmp/NEW TEST", mountId: 30, isPrivate: false });
  assert.deepEqual(native.inputs, [original]);
});

test.each([null, { filesystems: [{ id: 10, target, uuid, fsroot: "/runtime-tmp/NEWTEST-source" }] },
  { filesystems: [{ id: 30, target, uuid, fsroot: "/NEWTEST-wrong-root" }] },
  { filesystems: [{ id: 30, target: "/jobs/NEWTEST/foreign", uuid, fsroot: "/runtime-tmp/NEWTEST-source" }] },
  { filesystems: [{ id: 30, target, uuid: 5, fsroot: "/runtime-tmp/NEWTEST-source" }] }])("malformed or mismatching selected query denies (%j)", query => {
  native.query = query; assert.throws(() => inspectVisibleScratchMount(target), /Ambiguous/);
});

test("unsupported anonymous snapshot preserves the kernel error instead of granting a tuple", () => {
  const error = Object.assign(new Error("NEWTEST unsupported"), { code: "ENOTSUP" }); native.anonymousError = error;
  assert.throws(() => inspectVisibleScratchMount(target), error); assert.deepEqual(native.inputs, []);
});

test("over-byte full table is refused before sending a small selected row", () => {
  native.before = selected + "\n" + "X".repeat(8 * 1024 * 1024);
  assert.throws(() => inspectVisibleScratchMount(target), /Ambiguous/); assert.deepEqual(native.inputs, []);
});
