import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostedDependencyJobRoot } from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { gitWorkspaceStatus } from "../codex-goal-status-files";

const io = vi.hoisted(() => ({ calls: 0 }));
// Denial tests never execute an unauthenticated binary. The actual origin and
// purpose guards are NOT mocked; this trap detects any attempted legacy IO.
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  execFile: (..._args: readonly unknown[]): never => {
    io.calls++; throw new Error("TEST_unauthenticated_exec_trap");
  },
}));
afterEach(() => { io.calls = 0; vi.unstubAllEnvs(); });

describe("protected status source-read routing", () => {
  it("refuses selected source status without an original purpose before Git despite caller environment", async () => {
    const workspace = hostedDependencyJobRoot("TEST-status-no-original") + "/workspace";
    for (const marker of [undefined, "0", "1"]) {
      vi.stubEnv("SUBSCRIPTION_RUNTIME_SANDBOX_KIND", marker);
      // A path and marker are request data. No fake admitted private context is constructed.
      await expect(gitWorkspaceStatus(workspace)).rejects.toThrow("hosted_dependency_current_origin_unresolved");
      expect(io.calls).toBe(0);
    }
  });
  it("preserves the ordinary legacy unreadable-worktree warning fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "TEST-unprotected-status-"));
    try {
      await expect(gitWorkspaceStatus(root)).resolves.toEqual({ exists: true,
        dirty: false, changedFiles: [], warning: root + " is not a readable git worktree" });
      expect(io.calls).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
