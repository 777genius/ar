import { lstat, open, readdir, realpath, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { durableReplaceJsonFile } from "../../project-control-operation-file-store";

export async function durableReplaceEpochJson(
  path: string,
  value: unknown,
): Promise<void> {
  await durableReplaceJsonFile({ path, value, ensureParent: false });
}

export async function durablePublishEpochRoot(
  stagingRoot: string,
  targetRoot: string,
): Promise<void> {
  await syncTree(stagingRoot);
  await rename(stagingRoot, targetRoot);
  await syncDirectory(dirname(targetRoot));
}

export async function durableConfirmEpochRoot(root: string): Promise<void> {
  await syncTree(root);
  await syncDirectory(dirname(root));
}

export async function canonicalConsumedOutputLedgerRoot(
  value: string,
  mustExist: boolean,
): Promise<string> {
  const requested = resolve(value);
  if (mustExist) {
    const metadata = await lstat(requested);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("ledger_epoch_root_invalid");
    }
    return await realpath(requested);
  }
  try {
    const metadata = await lstat(requested);
    if (metadata.isSymbolicLink()) throw new Error("ledger_epoch_symlink_denied");
    return await realpath(requested);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    const missing: string[] = [basename(requested)];
    let ancestor = dirname(requested);
    while (true) {
      try {
        const canonicalAncestor = await realpath(ancestor);
        return join(canonicalAncestor, ...missing.reverse());
      } catch (ancestorError) {
        if (!isNodeError(ancestorError, "ENOENT")) throw ancestorError;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw ancestorError;
        missing.push(basename(ancestor));
        ancestor = parent;
      }
    }
  }
}

async function syncTree(root: string): Promise<void> {
  const directories = [root];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index]!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else await syncFile(path);
    }
  }
  for (const directory of directories.reverse()) await syncDirectory(directory);
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error;
  } finally {
    await handle?.close();
  }
}

function directorySyncUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EISDIR" || code === "EINVAL" || code === "ENOTSUP" ||
    code === "EPERM" || code === "EACCES";
}

function isNodeError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}
