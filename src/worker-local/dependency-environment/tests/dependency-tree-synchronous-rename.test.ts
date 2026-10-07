import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DependencyTreeObservationStatus } from "../../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import { observeDependencyTree } from "../observe-dependency-tree";
import { openDependencyTreeRename, readDependencyTreeEffectReferenceAnchors, type DependencyTreeEffectInput } from "../dependency-tree-effects";

const limits = { maxEntries: 128, maxTotalBytes: 65536, maxManifestBytes: 65536, maxDurationMs: 30000 };
async function identity(path: string) {
  const stat = await lstat(path, { bigint: true });
  return { canonicalPath: path, dev: String(stat.dev), ino: String(stat.ino) };
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-synchronous-rename-"))),
    workspace = join(root, "workspace"), trash = join(root, "trash"), tree = join(workspace, "node_modules");
  await mkdir(workspace); await mkdir(trash, { mode: 0o700 }); await mkdir(tree); await mkdir(join(tree, "pkg"));
  const file = join(tree, "pkg/index.js"); await writeFile(file, "original");
  const observed = await observeDependencyTree({ workspacePath: workspace, treeName: "node_modules", limits });
  if (observed.status !== DependencyTreeObservationStatus.Complete) throw new Error("TEST observation incomplete");
  const operationId = randomUUID(), input: DependencyTreeEffectInput = {
    workspace: await identity(workspace), trash: { operationId, originalTree: observed.tree,
      destinationParent: await identity(trash), destinationName: `dependency-${operationId}` },
    manifestCanonicalBytes: observed.canonicalBytes, manifestDigest: observed.digest, limits,
  };
  const target = join(trash, input.trash.destinationName), operation = await openDependencyTreeRename(input);
  return { file, tree, target, input, operation,
    async close() { await operation.close(); await rm(root, { recursive: true, force: true }); } };
}

// Real disposable filesystem effects only. These assertions do not mint an
// original context, owner or kernel exclusion proof.
describe.skipIf(process.platform !== "linux")("synchronous anchored rename", () => {
  it("prepares without effects and completes the exact rename before returning", async () => {
    const f = await fixture();
    try {
      const prepared = await f.operation.prepareSynchronousRename();
      expect(existsSync(f.tree)).toBe(true); expect(existsSync(f.target)).toBe(false);
      const result = prepared.commit();
      expect("then" in result).toBe(false);
      const moved = lstatSync(f.target, { bigint: true });
      expect({ dev: String(moved.dev), ino: String(moved.ino) }).toEqual(f.input.trash.originalTree);
      expect(existsSync(f.tree)).toBe(false);
      expect(await readFile(join(f.target, "pkg/index.js"), "utf8")).toBe("original");
      expect(() => prepared.commit()).toThrow("closed");
    } finally { await f.close(); }
  });
  it("close invalidates prepared commit and its exact descriptor session", async () => {
    const f = await fixture();
    try {
      const prepared = await f.operation.prepareSynchronousRename(); await f.operation.close();
      expect(() => prepared.commit()).toThrow("closed");
      expect(() => readDependencyTreeEffectReferenceAnchors(prepared.referenceSession,
        { workspace: f.input.workspace, trashPath: f.target, operationId: f.input.trash.operationId })).toThrow("closed");
      expect(existsSync(f.tree)).toBe(true); expect(existsSync(f.target)).toBe(false);
    } finally { await f.close(); }
  });
  it.each(["content", "addition", "target"])("refuses %s changed after preparation without an effect", async change => {
    const f = await fixture();
    try {
      const prepared = await f.operation.prepareSynchronousRename();
      if (change === "content") await writeFile(f.file, "mutated!");
      if (change === "addition") await writeFile(join(f.tree, "pkg/extra.js"), "extra");
      if (change === "target") { await mkdir(f.target); await writeFile(join(f.target, "sentinel"), "kept"); }
      expect(() => prepared.commit()).toThrow(); expect(() => prepared.commit()).toThrow("closed");
      expect(existsSync(f.tree)).toBe(true);
      if (change === "target") expect(await readFile(join(f.target, "sentinel"), "utf8")).toBe("kept");
      else expect(existsSync(f.target)).toBe(false);
    } finally { await f.close(); }
  });
  it("failed preparation closes the session and poisons every later submission", async () => {
    const f = await fixture();
    try {
      await writeFile(f.file, "mutated!");
      await expect(f.operation.prepareSynchronousRename()).rejects.toThrow("manifest_mismatch");
      await expect(f.operation.rename()).rejects.toThrow("closed");
      expect(() => readDependencyTreeEffectReferenceAnchors(f.operation.referenceSession,
        { workspace: f.input.workspace, trashPath: f.target, operationId: f.input.trash.operationId })).toThrow("closed");
      expect(existsSync(f.tree)).toBe(true); expect(existsSync(f.target)).toBe(false);
    } finally { await f.close(); }
  });
});
