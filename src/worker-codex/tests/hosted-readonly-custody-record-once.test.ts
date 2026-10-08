import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadonlyPrivateRecord, createReadonlyPrivateRecordOnce } from "../hosted-readonly-custody";

const roots: string[] = [];
function fixture(parent = tmpdir()): string {
  const root = mkdtempSync(join(parent, "subscription-runtime-TEST-private-record-")); roots.push(root); return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const bytes = Buffer.from('{"version":1,"TEST":"one-time-entry"}\n');

// Real filesystem durability/name-consumption boundary only. These records do
// not issue managed origin authority or prove genuine preclaim effect ordering.
// Red if identical replay succeeds, writes again, or replaces retained evidence.
describe.skipIf(process.platform !== "linux")("private record one-time creation", () => {
  it("creates once and refuses identical replay while preserving inode, mode and bytes", () => {
    const root = fixture(), path = join(root, "entry.json");
    createReadonlyPrivateRecordOnce(path, bytes);
    const before = lstatSync(path, { bigint: true });
    expect(before.isFile()).toBe(true); expect(before.mode & 0o7777n).toBe(0o600n);
    expect(readFileSync(path)).toEqual(bytes);
    expect(() => createReadonlyPrivateRecordOnce(path, bytes)).toThrow(expect.objectContaining({ code: "EEXIST" }));
    const after = lstatSync(path, { bigint: true });
    expect([after.dev, after.ino, after.mode, after.size, after.ctimeNs, after.mtimeNs])
      .toEqual([before.dev, before.ino, before.mode, before.size, before.ctimeNs, before.mtimeNs]);
    expect(readFileSync(path)).toEqual(bytes); expect(readdirSync(root)).toEqual(["entry.json"]);
  });
  it.each([Buffer.alloc(0), Buffer.from("TEST-uncertain-publication")])("retains existing uncertain bytes %j", retained => {
    const root = fixture(), path = join(root, "entry.json"); writeFileSync(path, retained, { mode: 0o600 });
    const before = lstatSync(path, { bigint: true });
    expect(() => createReadonlyPrivateRecordOnce(path, bytes)).toThrow(expect.objectContaining({ code: "EEXIST" }));
    const after = lstatSync(path, { bigint: true });
    expect([after.dev, after.ino, after.size, after.ctimeNs, after.mtimeNs])
      .toEqual([before.dev, before.ino, before.size, before.ctimeNs, before.mtimeNs]);
    expect(readFileSync(path)).toEqual(retained);
  });
});

// The unchanged idempotent reader requires genuine root-owned ancestry and
// procfs. Run this separate gate on disposable root Linux, never fake uid/fs.
describe.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)("root private enrollment replay", () => {
  it("keeps identical enrollment replay accepted while one-time entry replay refuses", () => {
    const root = fixture("/run"), enrollment = join(root, "enrollment.json"), entry = join(root, "entry.json");
    createReadonlyPrivateRecord(enrollment, bytes); const before = lstatSync(enrollment, { bigint: true });
    expect(() => createReadonlyPrivateRecord(enrollment, bytes)).not.toThrow();
    const after = lstatSync(enrollment, { bigint: true });
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]); expect(readFileSync(enrollment)).toEqual(bytes);
    createReadonlyPrivateRecordOnce(entry, bytes);
    expect(() => createReadonlyPrivateRecordOnce(entry, bytes)).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(readFileSync(entry)).toEqual(bytes);
  });
});
