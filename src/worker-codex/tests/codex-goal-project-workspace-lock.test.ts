import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ProjectAccessScope,
  WorkspaceLockPort,
} from "@vioxen/subscription-runtime/worker-core";
import {
  projectControlWorkspaceLocks,
  withValidatedProjectWorkspaceLock,
  withProjectAdmissionPublicationLock,
} from "../codex-goal-project-workspace-lock";

describe("project control workspace lock", () => {
  it("permits only one concurrent restart launch for the same canonical workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-workspace-lock-"));
    const workspace = join(root, "worktrees", "shared");
    const registryRootDir = join(root, "worker-jobs", "registry");
    const scope = projectScope(root);
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstDidEnter = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let active = 0;
    let maxConcurrency = 0;
    let launches = 0;
    try {
      await mkdir(workspace, { recursive: true });
      const first = withValidatedProjectWorkspaceLock({
        locks: projectControlWorkspaceLocks(registryRootDir),
        scope,
        requestedWorkspacePath: workspace,
        owner: "controller-a:job-a",
        effect: async () => {
          launches += 1;
          active += 1;
          maxConcurrency = Math.max(maxConcurrency, active);
          firstEntered();
          await firstMayFinish;
          active -= 1;
        },
      });
      await firstDidEnter;
      await expect(
        withValidatedProjectWorkspaceLock({
          locks: projectControlWorkspaceLocks(registryRootDir),
          scope,
          requestedWorkspacePath: workspace,
          owner: "controller-b:job-b",
          effect: async () => {
            launches += 1;
            active += 1;
            maxConcurrency = Math.max(maxConcurrency, active);
            active -= 1;
          },
        }),
      ).rejects.toMatchObject({ code: "safe_execution_workspace_locked" });
      expect(launches).toBe(1);
      releaseFirst();
      await first;
      await withValidatedProjectWorkspaceLock({
        locks: projectControlWorkspaceLocks(registryRootDir),
        scope,
        requestedWorkspacePath: workspace,
        owner: "controller-b:job-b",
        effect: async () => {
          launches += 1;
          active += 1;
          maxConcurrency = Math.max(maxConcurrency, active);
          active -= 1;
        },
      });
      expect(maxConcurrency).toBe(1);
      expect(launches).toBe(2);
    } finally {
      releaseFirst?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  // A writer can change the binding while the leaf is released. Publication
  // must reject that drift and finally must release the reacquired token.
  it.each([false, true])("revalidates the ordered handoff and releases the current token (drift=%s)", async (drift) => {
    const root = await mkdtemp(join(tmpdir(), "project-workspace-handoff-"));
    const workspacePath = join(root, "worktrees", "target");
    const registryRootDir = join(root, "worker-jobs", "registry");
    const bindingPath = join(workspacePath, "binding.txt");
    const locks = projectControlWorkspaceLocks(registryRootDir);
    let releases = 0;
    let published = 0;
    let submitted = 0;
    const observedLocks: WorkspaceLockPort = {
      acquire: async (input) => await locks.acquire(input),
      release: async (lease) => {
        await locks.release(lease);
        releases += 1;
        if (releases === 1 && drift) await writeFile(bindingPath, "changed");
      },
    };
    try {
      await mkdir(workspacePath, { recursive: true });
      await mkdir(registryRootDir, { recursive: true });
      await writeFile(bindingPath, "expected");
      const start = withValidatedProjectWorkspaceLock({
        locks: observedLocks, scope: projectScope(root), requestedWorkspacePath: workspacePath,
        owner: "project-start:controller:job",
        effect: async (workspace) => {
          const originalToken = workspace.lease.lockId;
          await workspace.withOrderedAdmissionPublication!({
            registryRootDir,
            revalidate: async (current) => {
              expect(current.lease.lockId).not.toBe(originalToken);
              if (await readFile(bindingPath, "utf8") !== "expected") throw new Error("binding_changed");
            },
            effect: async () => {
              await expect(locks.acquire({ workspacePath, owner: "collision" })).rejects.toMatchObject({ code: "safe_execution_workspace_locked" });
              await expect(withProjectAdmissionPublicationLock({ registryRootDir, owner: "collision", effect: async () => {} })).rejects.toMatchObject({ code: "safe_execution_workspace_locked" });
              published += 1;
            },
          });
          // Submission runs after topology release, while the new leaf remains held.
          await withProjectAdmissionPublicationLock({ registryRootDir, owner: "next-census", effect: async () => {} });
          await expect(locks.acquire({ workspacePath, owner: "collision" })).rejects.toMatchObject({ code: "safe_execution_workspace_locked" });
          submitted += 1;
        },
      });
      if (drift) await expect(start).rejects.toThrow("binding_changed");
      else await start;
      expect(published).toBe(drift ? 0 : 1);
      expect(submitted).toBe(drift ? 0 : 1);
      expect(releases).toBe(2);
      const next = await locks.acquire({ workspacePath, owner: "next-start" });
      await locks.release(next);
      await withProjectAdmissionPublicationLock({ registryRootDir, owner: "next-publication", effect: async () => {} });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an alias retargeted after acquire and releases the lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-workspace-retarget-"));
    const worktreeRoot = join(root, "worktrees");
    const inside = join(worktreeRoot, "inside");
    const alias = join(worktreeRoot, "alias");
    const outside = join(root, "outside");
    let released = false;
    let effectRan = false;
    try {
      await Promise.all([
        mkdir(join(inside, "node_modules"), { recursive: true }),
        mkdir(join(outside, "node_modules"), { recursive: true }),
      ]);
      await symlink(inside, alias, "dir");
      const locks: WorkspaceLockPort = {
        async acquire(input) {
          await rm(alias);
          await symlink(outside, alias, "dir");
          return {
            lockId: "lease-1",
            workspacePath: input.workspacePath,
            owner: input.owner,
          };
        },
        async release() {
          released = true;
        },
      };
      await expect(
        withValidatedProjectWorkspaceLock({
          locks,
          scope: projectScope(root),
          requestedWorkspacePath: alias,
          owner: "controller:job",
          effect: async () => {
            effectRan = true;
          },
        }),
      ).rejects.toThrow(/project_control_workspace_real_path_/);
      expect(effectRan).toBe(false);
      expect(released).toBe(true);
      await expect(access(join(outside, "node_modules"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function projectScope(root: string): ProjectAccessScope {
  return {
    projectId: "project-a",
    workspaceRoots: [join(root, "workspaces")],
    worktreeRoots: [join(root, "worktrees")],
    registryRoot: join(root, "worker-jobs", "registry"),
  };
}
