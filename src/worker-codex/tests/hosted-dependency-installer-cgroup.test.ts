import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeInstallerCgroupEmpty } from "../hosted-dependency-installer-cgroup";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
  const path = mkdtempSync(join(tmpdir(), "TEST-installer-cgroup-")); roots.push(path); return path;
}
function empty(path: string): void {
  writeFileSync(join(path, "cgroup.events"), "populated 0\nfrozen 0\n"); writeFileSync(join(path, "cgroup.procs"), "");
}
describe.skipIf(process.platform !== "linux")("installer cgroup filesystem observations", () => {
  // Regression: ENOENT in an existing root's evidence becomes false root absence.
  it.each(["cgroup.events", "cgroup.procs"])("refuses missing evidence %s inside a present root", missing => {
    const path = fixture(); empty(path); rmSync(join(path, missing));
    expect(() => observeInstallerCgroupEmpty(path)).toThrow();
  });
  it("distinguishes initial absence from positive recursive emptiness", () => {
    const path = fixture(); empty(path);
    const child = join(path, "TEST-child"); mkdirSync(child); empty(child);
    const present = observeInstallerCgroupEmpty(path), absent = observeInstallerCgroupEmpty(join(path, "TEST-absent"));
    expect(present).toMatch(/^[a-f0-9]{64}$/); expect(absent).not.toBe(present);
    writeFileSync(join(child, "cgroup.procs"), "123\n");
    expect(() => observeInstallerCgroupEmpty(path)).toThrow("unresolved");
  });
  it("refuses an incomplete descendant after an empty parent", () => {
    const path = fixture(); empty(path); mkdirSync(join(path, "TEST-child"));
    expect(() => observeInstallerCgroupEmpty(path)).toThrow();
  });
});
