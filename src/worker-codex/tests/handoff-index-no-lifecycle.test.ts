import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { withHandoffLiveIndexSnapshot, withHandoffWorktreeIndex } from "../codex-goal-handoff-worktree-index";

// Red: the actual-origin guard incorrectly requires protected purpose for an
// ordinary test process, or changes source bytes/callback result in legacy IO.
it("a genuine no-lifecycle TEST process preserves ordinary private index callbacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "TEST-handoff-no-lifecycle-"));
  const source = join(root, "source-index"), bytes = Buffer.from("TEST ordinary index bytes\n");
  try {
    await writeFile(source, bytes, { mode: 0o600 });
    let callbacks = 0;
    assert.equal(await withHandoffLiveIndexSnapshot({ sourceIndexPath: source, operation: async snapshot => {
      callbacks++; assert.deepEqual(await readFile(snapshot.indexPath), bytes);
      assert.notEqual(snapshot.indexPath, source); return "snapshot captured";
    } }), "snapshot captured");
    assert.equal(await withHandoffWorktreeIndex({ initialize: async env => {
      assert.equal(typeof env.GIT_INDEX_FILE, "string"); await writeFile(env.GIT_INDEX_FILE!, bytes);
    }, operation: async env => { callbacks++; assert.deepEqual(await readFile(env.GIT_INDEX_FILE!), bytes); return "worktree captured"; } }), "worktree captured");
    assert.equal(callbacks, 2); assert.deepEqual(await readFile(source), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
