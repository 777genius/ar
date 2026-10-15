import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { withProtectedCodexGoalJobBirthPublication } from "./protected-job-birth";
import { dirname, join, resolve } from "node:path";
import type {
  ProjectAccessScope,
  WorkspaceLock,
  WorkspaceLockPort,
} from "@vioxen/subscription-runtime/worker-core";
import { SafeExecutionError } from "@vioxen/subscription-runtime/worker-core";
import { LocalWorkspaceIntegrationLock, LocalProjectControlEvidenceCustody } from "@vioxen/subscription-runtime/worker-local";
import { projectControlCanonicalWorkspacePath } from "./application/project-control/codex-goal-project-workspace-scope";

export type ProjectControlWorkspaceLease = {
  readonly requestedWorkspacePath: string;
  readonly canonicalWorkspacePath: string;
  readonly lease: WorkspaceLock;
  /** Explicit handoff: release leaf, take topology then reacquire leaf, and
   * revalidate before publishing. The current lease getter follows that token. */
  readonly withOrderedAdmissionPublication?: <T>(input: {
    readonly registryRootDir: string;
    readonly revalidate: (current: ProjectControlWorkspaceLease) => Promise<void>;
    readonly effect: () => Promise<T>;
  }) => Promise<T>;
};

const localLockRoots = new WeakMap<WorkspaceLockPort, string>();
const currentLeases = new WeakMap<ProjectControlWorkspaceLease, Readonly<{
  registryLockRoot: string; assertCurrent(): Promise<void>;
}>>();

/** Reader validation only. Structural copies and closed/handoff leases are not
 * current; a persisted exact local owner record must still match the live token. */
export async function assertProjectControlWorkspaceLeaseCurrent(
  lease: ProjectControlWorkspaceLease, registryRootDir: string,
): Promise<void> {
  const current = currentLeases.get(lease);
  if (!current || current.registryLockRoot !== projectControlWorkspaceLockRoot(registryRootDir))
    throw new Error("project_control_workspace_lease_not_held");
  await current.assertCurrent();
  const token = lease.lease;
  const key = createHash("sha256").update(lease.canonicalWorkspacePath).digest("hex");
  const path = join(current.registryLockRoot, "workspace-locks", key, "lock.json");
  const record = await new LocalProjectControlEvidenceCustody().readImmutableFile(path, 64 * 1024);
  const lock = JSON.parse(Buffer.from(record.bytes).toString("utf8")) as Record<string, unknown>;
  if (lock.taskId !== token.lockId || lock.ownerId !== token.owner ||
      lock.workspacePath !== lease.canonicalWorkspacePath || lock.ownerPid !== process.pid)
    throw new Error("project_control_workspace_lease_not_held");
  await current.assertCurrent();
  if (lease.lease !== token) throw new Error("project_control_workspace_lease_not_held");
}

export function projectControlWorkspaceLocks(
  registryRootDir: string,
  assertPublicationCurrent?: (paths: readonly string[]) => void,
): WorkspaceLockPort {
  const locks = new LocalWorkspaceIntegrationLock({
    rootDir: projectControlWorkspaceLockRoot(registryRootDir),
    staleLockMs: 30 * 60_000,
    ...(assertPublicationCurrent ? { assertPublicationCurrent } : {}),
  });
  localLockRoots.set(locks, projectControlWorkspaceLockRoot(registryRootDir));
  return locks;
}

export function projectControlWorkspaceLockRoot(
  registryRootDir: string,
): string {
  return join(
    dirname(registryRootDir),
    "reviewed-worker-outputs",
    ".locks",
  );
}

/**
 * A short registry-topology publication section. It coordinates the fresh
 * admission/census check with the existing registration or launch-authorization
 * write, then releases before any provider submission or wait.
 */
export async function withProjectAdmissionPublicationLock<T>(input: {
  readonly registryRootDir: string;
  readonly owner: string;
  readonly effect: () => Promise<T>;
}): Promise<T> {
  const locks = projectControlWorkspaceLocks(input.registryRootDir);
  const registryPath = await realpath(resolve(input.registryRootDir));
  const deadline = performance.now() + 5_000;
  let lock: WorkspaceLock;
  for (;;) {
    try {
      lock = await locks.acquire({ workspacePath: registryPath, owner: input.owner });
      break;
    } catch (error) {
      if (!(error instanceof SafeExecutionError) || error.code !== "safe_execution_workspace_locked") throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(50, remaining)));
      if (performance.now() >= deadline) throw error;
    }
  }
  try {
    if (await realpath(resolve(input.registryRootDir)) !== registryPath ||
      lock.workspacePath !== registryPath) {
      throw new Error("project_control_registry_real_path_changed");
    }
    // Raw first effects share this owner-private try-lock through the final
    // census and existing claim publication, including every awaited read.
    return await withProtectedCodexGoalJobBirthPublication(input.effect);
  } finally {
    await locks.release(lock);
  }
}

export async function withValidatedProjectWorkspaceLock<T>(input: {
  readonly locks: WorkspaceLockPort;
  readonly scope: ProjectAccessScope;
  readonly requestedWorkspacePath: string;
  readonly expectedCanonicalWorkspacePath?: string;
  readonly owner: string;
  readonly effect: (lease: ProjectControlWorkspaceLease) => Promise<T>;
}): Promise<T> {
  const canonicalWorkspacePath = await projectControlCanonicalWorkspacePath(
    input.requestedWorkspacePath,
    input.scope,
  );
  if (
    input.expectedCanonicalWorkspacePath &&
    canonicalWorkspacePath !== input.expectedCanonicalWorkspacePath
  ) {
    throw new Error("project_control_workspace_real_path_changed");
  }
  let lock: WorkspaceLock | undefined = await input.locks.acquire({
    workspacePath: canonicalWorkspacePath,
    owner: input.owner,
  });
  let publicationActive = false;
  let closed = false;
  const assertCanonicalBinding = async (): Promise<void> => {
    const reboundWorkspacePath = await projectControlCanonicalWorkspacePath(
      input.requestedWorkspacePath,
      input.scope,
    );
    if (
      closed || !lock || lock.workspacePath !== canonicalWorkspacePath ||
      reboundWorkspacePath !== canonicalWorkspacePath
    ) {
      throw new Error("project_control_workspace_real_path_changed");
    }
  };
  const workspace: ProjectControlWorkspaceLease = {
    requestedWorkspacePath: input.requestedWorkspacePath,
    canonicalWorkspacePath,
    get lease() {
      if (!lock || closed) throw new Error("project_control_workspace_lease_not_held");
      return lock;
    },
    async withOrderedAdmissionPublication(publication) {
      if (!lock || closed || publicationActive) {
        throw new Error("project_control_workspace_publication_not_available");
      }
      publicationActive = true;
      try {
        await input.locks.release(lock);
        lock = undefined;
        return await withProjectAdmissionPublicationLock({
          registryRootDir: publication.registryRootDir,
          owner: input.owner,
          effect: async () => {
            lock = await input.locks.acquire({ workspacePath: canonicalWorkspacePath, owner: input.owner });
            await assertCanonicalBinding();
            await publication.revalidate(workspace);
            return await publication.effect();
          },
        });
      } finally { publicationActive = false; }
    },
  };
  const registryLockRoot = localLockRoots.get(input.locks);
  if (registryLockRoot) currentLeases.set(workspace, { registryLockRoot, assertCurrent: assertCanonicalBinding });
  try {
    await assertCanonicalBinding();
    return await input.effect(workspace);
  } finally {
    currentLeases.delete(workspace);
    closed = true;
    if (lock) await input.locks.release(lock);
  }
}
