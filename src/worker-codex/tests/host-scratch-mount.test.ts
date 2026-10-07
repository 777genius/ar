import { strict as assert } from "node:assert";
import { closeSync, constants, openSync } from "node:fs";
import { test } from "vitest";
import { inspectVisibleScratchMount, selectVisibleScratchMount } from "../host-scratch-mount";

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
  closeSync(probe);
  const result = inspectVisibleScratchMount("/");
  assert.ok(result);
  assert.equal(result.target, "/");
  assert.ok(result.fsroot?.startsWith("/"));
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
