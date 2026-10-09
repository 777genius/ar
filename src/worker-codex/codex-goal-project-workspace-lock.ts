import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  ProjectAccessScope,
  WorkspaceLock,
  WorkspaceLockPort,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalWorkspaceIntegrationLock } from "@vioxen/subscription-runtime/worker-local";
import { projectControlCanonicalWorkspacePath } from "./application/project-control/codex-goal-project-workspace-scope";

export type ProjectControlWorkspaceLease = {
  readonly requestedWorkspacePath: string;
  readonly canonicalWorkspacePath: string;
  readonly lease: WorkspaceLock;
};

export function projectControlWorkspaceLocks(
  registryRootDir: string,
): WorkspaceLockPort {
  return new LocalWorkspaceIntegrationLock({
    rootDir: projectControlWorkspaceLockRoot(registryRootDir),
    staleLockMs: 30 * 60_000,
  });
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
  const lock = await locks.acquire({
    workspacePath: registryPath,
    owner: input.owner,
  });
  try {
    if (await realpath(resolve(input.registryRootDir)) !== registryPath ||
      lock.workspacePath !== registryPath) {
      throw new Error("project_control_registry_real_path_changed");
    }
    return await input.effect();
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
  const lock = await input.locks.acquire({
    workspacePath: canonicalWorkspacePath,
    owner: input.owner,
  });
  try {
    const reboundWorkspacePath = await projectControlCanonicalWorkspacePath(
      input.requestedWorkspacePath,
      input.scope,
    );
    if (
      lock.workspacePath !== canonicalWorkspacePath ||
      reboundWorkspacePath !== canonicalWorkspacePath
    ) {
      throw new Error("project_control_workspace_real_path_changed");
    }
    return await input.effect({
      requestedWorkspacePath: input.requestedWorkspacePath,
      canonicalWorkspacePath,
      lease: lock,
    });
  } finally {
    await input.locks.release(lock);
  }
}
