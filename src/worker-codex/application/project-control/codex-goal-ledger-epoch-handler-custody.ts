import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { LedgerEpochDebtCustodyBinding } from
  "./codex-goal-consumed-output-ledger-epoch-switch";

export function ledgerEpochCustodyPaths(
  bindings: readonly LedgerEpochDebtCustodyBinding[],
  oldRoot: string,
  newRoot: string,
  additionalPaths: readonly string[] = [],
): readonly string[] {
  return [...new Set([
    oldRoot, newRoot, ...additionalPaths,
    ...bindings.map((binding) => binding.canonicalPath),
  ].map((path) => resolve(path)))].sort();
}

export async function ledgerEpochDirectoryIdentity(
  path: string,
  allowMissing = false,
) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (allowMissing && isNodeError(error, "ENOENT")) {
      return { canonicalPath: resolve(path), present: false as const };
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("ledger_epoch_target_root_identity_drift");
  }
  return {
    canonicalPath: await realpath(path),
    device: metadata.dev,
    inode: metadata.ino,
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === code;
}
