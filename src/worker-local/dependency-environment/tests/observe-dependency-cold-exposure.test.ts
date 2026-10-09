import { createHash } from "node:crypto";
import { readdirSync, readlinkSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DependencyManifestEntryKind, DependencyTreeObservationStatus, DependencyTreeObservationFailure } from "../../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import { observeDependencyTreeWithPhysicalExposure, assertDependencySourceExposureCurrent, closeDependencySourceExposure,
  captureDependencyPhysicalTreeExposure, type DependencySourceExposure } from "../observe-dependency-tree";

const limits = { maxEntries: 2000, maxTotalBytes: 4096, maxManifestBytes: 1024 * 1024, maxDurationMs: 30000 };
async function fixture(directories = 0) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "TEST-cold-physical-"))), tree = join(path, "node_modules");
  await mkdir(tree, { mode: 0o700 });
  for (let i = 0; i < directories; i++) await mkdir(join(tree, `directory-${i}`), { mode: 0o700 });
  const file = join(tree, "index.js"); await writeFile(file, "abc", { mode: 0o600 });
  const root = await lstat(path, { bigint: true }), modules = await lstat(tree, { bigint: true });
  const workspace = { canonicalPath: path, dev: String(root.dev), ino: String(root.ino) }, expectedTree = { dev: String(modules.dev), ino: String(modules.ino) };
  return { path, tree, file, input: { workspacePath: path, treeName: "node_modules" as const, expectedWorkspace: workspace, expectedTree, limits } };
}
function fixtureDescriptors(path: string): string[] {
  const names = readdirSync("/proc/self/fd"); if (names.length > 4096) throw new Error("TEST FD inventory bound");
  return names.filter(name => {
    try { const target = readlinkSync(`/proc/self/fd/${name}`); return target === path || target.startsWith(path + "/"); }
    catch (error) { if (!["ENOENT", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; return false; }
  });
}
// Actual Linux TEST filesystem and kernel FD oracle. A DTO never supplies
// provenance/exclusion. Native admission separately measures exactly3 walks.
describe.skipIf(process.platform !== "linux")("same-walk cold physical exposure", () => {
  it.each(["same-length-edit", "membership-add"])("revalidates original pins after descriptor close and refuses %s", async change => {
    const f = await fixture(); let exposure: DependencySourceExposure | undefined;
    try {
      const result = await observeDependencyTreeWithPhysicalExposure(f.input);
      expect(result.status).toBe(DependencyTreeObservationStatus.Complete);
      if (result.status !== DependencyTreeObservationStatus.Complete || !result.exposure) throw new Error("TEST missing physical baseline");
      exposure = result.exposure;
      const leaf = result.entries.find(entry => entry.kind === DependencyManifestEntryKind.File);
      expect(leaf).toMatchObject({ size: "3", sha256: createHash("sha256").update("abc").digest("hex") });
      expect(result.totalBytes).toBe("3"); expect(Number(result.measurement.observedScanDurationMs)).toBeGreaterThan(0);
      expect(fixtureDescriptors(f.path)).toEqual([]); expect(() => assertDependencySourceExposureCurrent(exposure!)).not.toThrow();
      expect(fixtureDescriptors(f.path)).toEqual([]);
      if (change === "same-length-edit") await writeFile(f.file, "xyz");
      else await writeFile(join(f.tree, "added.js"), "keep authored TEST bytes");
      expect(() => assertDependencySourceExposureCurrent(exposure!)).toThrow(); expect(fixtureDescriptors(f.path)).toEqual([]);
      closeDependencySourceExposure(exposure); expect(() => assertDependencySourceExposureCurrent(exposure!)).toThrow();
      expect(await readFile(f.file, "utf8")).toBe(change === "same-length-edit" ? "xyz" : "abc");
    } finally { if (exposure) closeDependencySourceExposure(exposure); await rm(f.path, { recursive: true, force: true }); }
  });
  it("513 directory retention exhaustion preserves the canonical scan and returns no partial exposure", async () => {
    const f = await fixture(513);
    try {
      const result = await observeDependencyTreeWithPhysicalExposure(f.input);
      expect(result.status).toBe(DependencyTreeObservationStatus.Complete);
      if (result.status !== DependencyTreeObservationStatus.Complete) throw new Error("TEST canonical support shrank");
      expect(result.exposure).toBeUndefined(); expect(result.entries).toHaveLength(515); expect(result.totalBytes).toBe("3");
      expect(result.entries.find(entry => entry.kind === DependencyManifestEntryKind.File)).toMatchObject({ sha256: createHash("sha256").update("abc").digest("hex") });
      expect(fixtureDescriptors(f.path)).toEqual([]);
      expect(await observeDependencyTreeWithPhysicalExposure({ ...f.input, limits: { ...limits, maxEntries: 1 } }))
        .toEqual({ status: DependencyTreeObservationStatus.Incomplete, reason: DependencyTreeObservationFailure.Bounds });
      // Strict existing physical routes retain their512 refusal; optional
      // registry fallback cannot accidentally change local/source support rules.
      expect(await captureDependencyPhysicalTreeExposure({ workspace: f.input.expectedWorkspace, expectedTree: f.input.expectedTree, limits }))
        .toEqual({ status: DependencyTreeObservationStatus.Incomplete, reason: DependencyTreeObservationFailure.Bounds });
      expect(await readFile(f.file, "utf8")).toBe("abc");
    } finally { await rm(f.path, { recursive: true, force: true }); }
  });
});
