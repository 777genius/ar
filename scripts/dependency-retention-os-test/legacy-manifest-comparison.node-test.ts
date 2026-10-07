/** Regression boundary: independent actual TEST filesystem captures. No real
 * workspace, npm, provider, installation authority or fabricated Ready DTO. */
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { observeDependencyTree } from "../../dist/worker-local/dependency-environment/observe-dependency-tree.js";
import { DependencyTreeObservationStatus as Observed }
  from "../../dist/worker-core/dependency-environment/domain/dependency-tree-manifest.js";
import { compareIndependentLegacyCaptures, LegacyManifestComparison as Outcome } from "./legacy-manifest-comparison.ts";
const limits = { maxEntries: 64, maxTotalBytes: 4096, maxManifestBytes: 16384, maxDurationMs: 10000 };
const options = { skip: process.platform !== "linux" };
async function fixture() {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "TEST-legacy-independent-")));
  const tree = join(workspace, "node_modules"), pkg = join(tree, "pkg"), file = join(pkg, "index.js");
  await mkdir(tree); await chmod(tree, 0o755); await mkdir(pkg); await chmod(pkg, 0o755);
  await writeFile(file, "abc"); await chmod(file, 0o644);
  return { workspace, tree, pkg, file,
    observe: () => observeDependencyTree({ workspacePath: workspace, treeName: "node_modules", limits }),
    cleanup: () => rm(workspace, { recursive: true, force: true }) };
}
async function pair() { const left = await fixture(), right = await fixture(); return { left, right,
  cleanup: async () => { await left.cleanup(); await right.cleanup(); } }; }

test("equal independent TEST trees are facts only, never LegacyCompared or eviction authority", options, async () => {
  const f = await pair();
  try {
    await utimes(f.right.file, new Date(1000), new Date(1000));
    const a = await f.left.observe(), b = await f.right.observe();
    assert.equal(a.status, Observed.Complete); assert.equal(b.status, Observed.Complete);
    const result = compareIndependentLegacyCaptures(a, b, await f.left.observe(), await f.right.observe());
    assert.equal(result.outcome, Outcome.MatchFactsOnly);
    assert.equal(result.legacyComparedPublished, false); assert.equal(result.deletionAuthority, false);
    const counterfeit = compareIndependentLegacyCaptures(a, a, a, a);
    assert.equal(counterfeit.outcome, Outcome.PreserveNotIndependent);
  } finally { await f.cleanup(); }
});

// Red if same-size bytes, mode-only edits, dot additions, removed files or
// entry-kind differences are treated as disposable dependency-cache noise.
for (const change of ["bytes", "mode", "dot-extra", "missing", "kind", "symlink"] as const) {
  test(`independent reference detects ${change} and preserves candidate inode/content`, options, async () => {
    const f = await pair();
    try {
      if (change === "bytes") {
        const old = await lstat(f.left.file); await writeFile(f.left.file, "xyz"); await utimes(f.left.file, old.atime, old.mtime);
      }
      if (change === "mode") await chmod(f.left.file, 0o755);
      if (change === "dot-extra") { await mkdir(join(f.left.tree, ".authored")); await writeFile(join(f.left.tree, ".authored", "code"), "xyz"); }
      if (change === "missing") await rm(f.left.file);
      if (change === "kind") { await rm(f.left.file); await mkdir(f.left.file); }
      if (change === "symlink") {
        await writeFile(join(f.left.pkg, "other.js"), "abc"); await writeFile(join(f.right.pkg, "other.js"), "abc");
        await symlink("pkg/index.js", join(f.left.tree, "alias")); await symlink("pkg/other.js", join(f.right.tree, "alias"));
      }
      const before = await lstat(f.left.tree), a = await f.left.observe(), b = await f.right.observe();
      const result = compareIndependentLegacyCaptures(a, b, await f.left.observe(), await f.right.observe());
      assert.equal(result.outcome, Outcome.PreserveMismatch);
      assert("counts" in result && result.counts !== undefined);
      const expectedCount = { bytes: "fileBytes", mode: "modes", "dot-extra": "added", missing: "missing", kind: "kinds", symlink: "symlinkTargets" } as const;
      assert(result.counts[expectedCount[change]] > 0);
      const after = await lstat(f.left.tree); assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
      assert.equal(result.deletionAuthority, false);
      if (change === "bytes") assert.equal(await readFile(f.left.file, "utf8"), "xyz");
      if (change === "mode") assert.equal((await lstat(f.left.file)).mode & 0o777, 0o755);
      if (change === "dot-extra") assert.equal(await readFile(join(f.left.tree, ".authored", "code"), "utf8"), "xyz");
    } finally { await f.cleanup(); }
  });
}

test("a later equal recapture cannot reset a mutated original baseline", options, async () => {
  const f = await pair();
  try {
    const original = await f.left.observe(), reference = await f.right.observe();
    await writeFile(f.left.file, "xyz"); await writeFile(f.right.file, "xyz");
    const result = compareIndependentLegacyCaptures(original, reference, await f.left.observe(), await f.right.observe());
    assert.equal(result.outcome, Outcome.PreserveChanged); assert.equal(result.deletionAuthority, false);
    assert.equal(await readFile(f.left.file, "utf8"), "xyz");
  } finally { await f.cleanup(); }
});

test("an incomplete physical inventory preserves, even with other complete equal captures", options, async () => {
  const f = await pair();
  try {
    const a = await f.left.observe(), b = await f.right.observe();
    const limited = await observeDependencyTree({ workspacePath: f.left.workspace, treeName: "node_modules",
      limits: { ...limits, maxEntries: 1 } });
    assert.equal(limited.status, Observed.Incomplete);
    const result = compareIndependentLegacyCaptures(a, b, limited, b);
    assert.equal(result.outcome, Outcome.PreserveIncomplete); assert.equal(result.deletionAuthority, false);
    assert.equal(await readFile(f.left.file, "utf8"), "abc");
  } finally { await f.cleanup(); }
});
