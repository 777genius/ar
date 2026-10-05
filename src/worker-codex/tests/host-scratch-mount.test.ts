import { strict as assert } from "node:assert";
import { test } from "vitest";
import { selectVisibleScratchMount } from "../host-scratch-mount";

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
