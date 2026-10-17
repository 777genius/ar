import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalFileWorkspaceLockStore, type LocalWorkspaceLockDirectoryLifecycle } from "../safe-execution/adapters/local-safe-execution-state-store";

describe("workspace lock directory custody consumer", () => {
  it("refuses a directory lifecycle without the consuming write veto", () => {
    // These methods must never execute: this is an admission negative, not a
    // simulated native issuer or positive allocation proof.
    const lifecycle: LocalWorkspaceLockDirectoryLifecycle = {
      createLease() { throw new Error("unexpected_directory_creation"); },
      hold() { throw new Error("unexpected_directory_hold"); },
    };
    expect(() => new LocalFileWorkspaceLockStore("/unused-TEST-lock-root", undefined, lifecycle))
      .toThrow("workspace_lock_directory_veto_required");
  });

  it("keeps ordinary real acquire, live-owner refusal and release behavior", async () => {
    const root = await mkdtemp(join(tmpdir(), "TEST-lock-directory-consumer-"));
    const workspace = join(root, "workspace"), locks = join(root, "locks");
    await mkdir(workspace, { mode: 0o700 });
    const store = new LocalFileWorkspaceLockStore(locks);
    try {
      const lease = await store.acquire({ taskId: "TEST-original-lease", workspacePath: workspace,
        ownerId: "TEST-original-owner", ownerPid: process.pid });
      expect(lease.workspacePath).toBe(await realpath(workspace));
      const entries = await readdir(join(locks, "workspace-locks"));
      expect(entries).toHaveLength(1);
      const actual = JSON.parse(await readFile(join(locks, "workspace-locks", entries[0]!, "lock.json"), "utf8")) as { taskId: string };
      expect(actual.taskId).toBe("TEST-original-lease");
      await expect(store.acquire({ taskId: "TEST-foreign-lease", workspacePath: workspace,
        ownerId: "TEST-foreign-owner", ownerPid: process.pid })).rejects.toMatchObject({ code: "safe_execution_workspace_locked" });
      await lease.release();
      expect(await readdir(join(locks, "workspace-locks"))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
