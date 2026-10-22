/** Real disposable filesystem DATA checks; no native authority or launch. */
import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureExplicitOpaqueTreeData, OpaqueSnapshotKind } from "./current-explicit-preservation.js";
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "TEST-explicit-opaque-DATA-"))), tree = base + "/tree";
  mkdirSync(tree); mkdirSync(tree + "/nested", { mode: 0o750 }); writeFileSync(tree + "/nested/bytes", Buffer.from([0, 255, 128, 1]), { mode: 0o640 });
  chmodSync(tree + "/nested", 0o750); chmodSync(tree + "/nested/bytes", 0o640); symlinkSync("missing", tree + "/dangling");
  mkdirSync(tree + "/.cache"); mkdirSync(tree + "/.cache/TEST-explicit-preservation",{mode:0o750});
  writeFileSync(tree + "/.cache/TEST-explicit-preservation/authored.bin",Buffer.from([0,255,128,3,0]),{mode:0o640});
  chmodSync(tree + "/.cache/TEST-explicit-preservation",0o750);chmodSync(tree + "/.cache/TEST-explicit-preservation/authored.bin",0o640);return { base, tree };
}
test("whole opaque DATA preserves inode, binary bytes, modes and raw links across actual rename", () => {
  const f = fixture(); try {
    const before = captureExplicitOpaqueTreeData(f.tree), inode = lstatSync(f.tree).ino;
    renameSync(f.tree, f.base + "/retained"); assert.deepEqual(captureExplicitOpaqueTreeData(f.base + "/retained"), before);
    assert.equal(lstatSync(f.base + "/retained").ino, inode); assert.deepEqual(readFileSync(f.base + "/retained/nested/bytes"), Buffer.from([0, 255, 128, 1]));
    assert(before.entries.some(row => row.kind === OpaqueSnapshotKind.File && row.mode === String(0o640)));
    const cache=before.entries.find(row=>row.path===Buffer.from(".cache/TEST-explicit-preservation/authored.bin").toString("base64"));assert(cache && cache.kind===OpaqueSnapshotKind.File && cache.mode===String(0o640));
    assert.deepEqual(readFileSync(f.base + "/retained/.cache/TEST-explicit-preservation/authored.bin"),Buffer.from([0,255,128,3,0]));
    assert(before.entries.some(row => row.kind === OpaqueSnapshotKind.Directory && row.mode === String(0o750)));
  } finally { rmSync(f.base, { recursive: true }); }
});
test("opaque DATA records a symlink itself and never hashes its outside target", () => {
  const f = fixture(); try {
    const outside = f.base + "/outside"; writeFileSync(outside, "first own outside bytes"); symlinkSync("../outside", f.tree + "/external");
    const before = captureExplicitOpaqueTreeData(f.tree); writeFileSync(outside, "different own outside bytes");
    assert.deepEqual(captureExplicitOpaqueTreeData(f.tree), before);
  } finally { rmSync(f.base, { recursive: true }); }
});
test("opaque DATA detects byte, mode and named-inode replacements", () => {
  const f = fixture(); try {
    const before = captureExplicitOpaqueTreeData(f.tree); writeFileSync(f.tree + "/nested/bytes", Buffer.from([0, 255, 128, 2]));
    assert.notDeepEqual(captureExplicitOpaqueTreeData(f.tree), before);
    const bytes = captureExplicitOpaqueTreeData(f.tree); chmodSync(f.tree + "/nested/bytes", 0o600); assert.notDeepEqual(captureExplicitOpaqueTreeData(f.tree), bytes);
    const mode = captureExplicitOpaqueTreeData(f.tree); renameSync(f.tree + "/nested/bytes", f.base + "/held"); writeFileSync(f.tree + "/nested/bytes", Buffer.from([0, 255, 128, 2]), { mode: 0o600 });
    assert.notDeepEqual(captureExplicitOpaqueTreeData(f.tree), mode);
    renameSync(f.tree, f.base + "/held-tree"); symlinkSync("held-tree", f.tree); assert.throws(() => captureExplicitOpaqueTreeData(f.tree));
  } finally { rmSync(f.base, { recursive: true }); }
});
test("opaque DATA refuses an oversized regular leaf before unbounded reads", () => {
  const f = fixture(); try { writeFileSync(f.tree + "/large", ""); truncateSync(f.tree + "/large",64 * 1024 * 1024 + 1); assert.throws(() => captureExplicitOpaqueTreeData(f.tree)); }
  finally { rmSync(f.base, { recursive: true }); }
});
test("actual Linux raw filename and symlink bytes survive whole-tree DATA rename", { skip: process.platform !== "linux" }, () => {
  const f = fixture(); try {
    const name = Buffer.concat([Buffer.from(f.tree + "/"), Buffer.from([255, 1])]); writeFileSync(name, Buffer.from([0, 255])); symlinkSync(Buffer.from([255, 2]), f.tree + "/raw");
    const before = captureExplicitOpaqueTreeData(f.tree); renameSync(f.tree, f.base + "/retained"); assert.deepEqual(captureExplicitOpaqueTreeData(f.base + "/retained"), before);
  } finally { rmSync(f.base, { recursive: true }); }
});
