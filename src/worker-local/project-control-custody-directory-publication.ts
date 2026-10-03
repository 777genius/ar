import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  ProjectControlCustodyMaterializationRecovery,
  ProjectControlRecoveryDirectoryIdentity,
} from "@vioxen/subscription-runtime/worker-core";
import {
  openAbsoluteDirectoryNoSymlinks,
  type CustodyMaterializationCrashHook,
} from "./project-control-evidence-custody-materialization";

/**
 * Allocate off-path, durably checkpoint the inode, then publish without clobbering.
 * A crash before prepare leaves only an unreferenced, empty staging directory;
 * it is never adopted as authority. After prepare, either name must resolve to
 * exactly the journaled inode. The staging entry is synced before the journal,
 * and the final entry is synced before the applied checkpoint.
 */
export async function materializeRecoverableCustodyDirectory(input: {
  readonly path: string;
  readonly recovery: ProjectControlCustodyMaterializationRecovery;
  readonly crashHook?: CustodyMaterializationCrashHook;
}): Promise<void> {
  const { path, recovery } = input;
  if (!/^[a-f0-9-]{36}$/.test(recovery.operationId)) {
    throw new Error("project_control_recovery_operation_invalid");
  }
  await recovery.revalidate();
  const expected = recovery.identities.find(identity => identity.path === path);
  if (expected) {
    const handle = await openAbsoluteDirectoryNoSymlinks(path);
    try { await assertIdentity(handle, expected, path); }
    finally { await handle.close(); }
    return;
  }

  const parentPath = dirname(path);
  const parentIdentity = recovery.identities.find(identity => identity.path === parentPath);
  if (!parentIdentity) throw new Error("project_control_recovery_parent_identity_missing");
  const parent = await openAbsoluteDirectoryNoSymlinks(parentPath);
  let staged: FileHandle | undefined;
  try {
    await assertIdentity(parent, parentIdentity, parentPath);
    const child = `/proc/self/fd/${parent.fd}/${basename(path)}`;
    let pending = recovery.pendingDirectory?.path === path ? recovery.pendingDirectory : undefined;
    if (!pending) {
      if (await exists(child)) throw new Error("project_control_recovery_unrecorded_directory_identity");
      const prefix = `.custody-${recovery.operationId}-`;
      const stagingName = basename(await mkdtemp(`/proc/self/fd/${parent.fd}/${prefix}`));
      const stagingPath = join(parentPath, stagingName);
      staged = await open(`/proc/self/fd/${parent.fd}/${stagingName}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const stat = await staged.stat();
      pending = { path, stagingPath, device: stat.dev, inode: stat.ino };
      await assertIdentity(staged, pending, stagingPath);
      await input.crashHook?.("after_custody_staging_creation_before_checkpoint", path);
      await staged.sync();
      await parent.sync();
      await recovery.revalidate();
      await recovery.prepare(pending);
      await input.crashHook?.("after_custody_staging_checkpoint_before_publication", path);
    }
    if (dirname(pending.stagingPath) !== parentPath ||
        !basename(pending.stagingPath).startsWith(`.custody-${recovery.operationId}-`)) {
      throw new Error("project_control_recovery_staging_path_invalid");
    }
    const stagingEntry = `/proc/self/fd/${parent.fd}/${basename(pending.stagingPath)}`;
    if (await exists(child)) {
      // Only a previously published inode from this operation may be resumed.
      if (await exists(stagingEntry)) throw new Error("project_control_recovery_directory_identity_drift");
      const current = await openAbsoluteDirectoryNoSymlinks(path);
      try { await assertIdentity(current, pending, path); }
      finally { await current.close(); }
    } else {
      staged ??= await open(stagingEntry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await assertIdentity(staged, pending, pending.stagingPath);
      await recovery.revalidate();
      if (await realpath(`/proc/self/fd/${parent.fd}`) !== parentPath) {
        throw new Error("project_control_recovery_directory_identity_drift");
      }
      await input.crashHook?.("before_custody_directory_publication", path);
      await renameDirectoryNoReplace(parent, basename(pending.stagingPath), basename(path));
      await assertIdentity(staged, pending, path);
      await input.crashHook?.("after_custody_directory_creation_before_parent_fsync", path);
    }
    // On a retry, the rename may have survived while its parent fsync did not.
    await parent.sync();
    await recovery.revalidate();
    const current = await openAbsoluteDirectoryNoSymlinks(path);
    try { await assertIdentity(current, pending, path); }
    finally { await current.close(); }
    await recovery.applied({ path, device: pending.device, inode: pending.inode });
  } finally {
    try { await staged?.close(); } finally { await parent.close(); }
  }
}

async function assertIdentity(
  handle: FileHandle,
  expected: ProjectControlRecoveryDirectoryIdentity,
  path: string,
): Promise<void> {
  const stat = await handle.stat();
  if (!stat.isDirectory() || stat.dev !== expected.device || stat.ino !== expected.inode ||
      await realpath(`/proc/self/fd/${handle.fd}`) !== path) {
    throw new Error("project_control_recovery_directory_identity_drift");
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Node's rename can overwrite an empty substituted directory. GNU mv's Linux
 * no-clobber rename uses RENAME_NOREPLACE; --no-copy forbids a copy fallback.
 * Both names are relative to the same inherited parent descriptor. Unsupported
 * platforms/options fail closed, and skipped moves are detected by inode/name
 * verification by the caller. No shell, lexical parent lookup, or PATH search.
 */
async function renameDirectoryNoReplace(parent: FileHandle, source: string, target: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/mv", ["--no-copy", "--no-clobber", "--no-target-directory", "--",
      `/proc/self/fd/3/${source}`, `/proc/self/fd/3/${target}`], {
      stdio: ["ignore", "ignore", "ignore", parent.fd],
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    child.once("error", () => reject(new Error("project_control_recovery_atomic_rename_unavailable")));
    child.once("exit", code => code === 0 ? resolve()
      : reject(new Error("project_control_recovery_atomic_rename_failed")));
  });
}
