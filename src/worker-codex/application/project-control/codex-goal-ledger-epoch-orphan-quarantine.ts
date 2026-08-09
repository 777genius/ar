import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  ConsumedOutputLedgerEpochOrphanWorkspaceBinding,
} from "@vioxen/subscription-runtime/worker-core";

const execFileAsync = promisify(execFile);
const MAX_ORPHAN_FILE_BYTES = 16 * 1024 * 1024;
const bindingCache = new Map<string, {
  readonly device: number;
  readonly inode: number;
  readonly treeSha256: string;
  readonly binding: ConsumedOutputLedgerEpochOrphanWorkspaceBinding;
}>();

export async function bindLedgerEpochOrphanWorkspace(input: {
  readonly workspacePath: string;
  readonly deniedRoots: readonly string[];
}): Promise<ConsumedOutputLedgerEpochOrphanWorkspaceBinding | undefined> {
  const declaredPath = resolve(input.workspacePath);
  const deniedRoots = input.deniedRoots.map((root) => resolve(root));
  if (deniedRoots.some((root) => pathInsideOrEqual(declaredPath, root))) {
    return { declaredPath, state: "denied" };
  }
  let metadata;
  try {
    metadata = await lstat(declaredPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    return { declaredPath, state: "denied" };
  }
  const canonicalPath = await realpath(declaredPath);
  const canonicalDeniedRoots = await Promise.all(deniedRoots.map(canonicalPathIfPresent));
  if (canonicalDeniedRoots.some((root) =>
    root !== undefined && pathInsideOrEqual(canonicalPath, root)
  )) {
    return { declaredPath, state: "denied", canonicalPath };
  }
  const treeSha256 = await workspaceTreeSha256(canonicalPath);
  const cached = bindingCache.get(canonicalPath);
  if (cached && cached.device === metadata.dev && cached.inode === metadata.ino &&
    cached.treeSha256 === treeSha256) return cached.binding;
  let topLevel: string;
  try {
    topLevel = (await gitBytes(canonicalPath, ["rev-parse", "--show-toplevel"]))
      .toString("utf8").trim();
  } catch {
    return undefined;
  }
  if (await realpath(topLevel) !== canonicalPath) return undefined;
  const status = await gitBytes(canonicalPath, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all",
  ]);
  if (status.length === 0) return undefined;
  const head = (await gitBytes(canonicalPath, ["rev-parse", "HEAD"]))
    .toString("utf8").trim();
  if (!/^[a-f0-9]{40,64}$/.test(head)) {
    throw new Error("ledger_epoch_orphan_workspace_head_invalid");
  }
  const trackedDiff = await gitBytes(canonicalPath, ["diff", "--binary", "HEAD", "--"]);
  const untracked = nulValues(await gitBytes(canonicalPath, [
    "ls-files", "--others", "--exclude-standard", "-z",
  ])).sort();
  const contentHash = createHash("sha256")
    .update("ledger-epoch-orphan-workspace-v1\0")
    .update(head).update("\0")
    .update(status).update("\0")
    .update(trackedDiff).update("\0");
  for (const path of untracked) {
    assertSafeRelativePath(path);
    const absolute = resolve(canonicalPath, path);
    const entry = await lstat(absolute);
    if (entry.isSymbolicLink()) {
      contentHash.update(path).update("\0symlink\0").update(await readlink(absolute));
      continue;
    }
    if (!entry.isFile()) throw new Error("ledger_epoch_orphan_workspace_entry_unsafe");
    const bytes = await readHardenedFile(absolute);
    contentHash.update(path).update("\0file\0")
      .update(String(bytes.length)).update("\0")
      .update(createHash("sha256").update(bytes).digest("hex")).update("\n");
  }
  const binding: ConsumedOutputLedgerEpochOrphanWorkspaceBinding = {
    declaredPath,
    state: "quarantined",
    canonicalPath,
    device: metadata.dev,
    inode: metadata.ino,
    headSha: head,
    statusSha256: sha256(status),
    statusSize: status.length,
    trackedDiffSha256: sha256(trackedDiff),
    trackedDiffSize: trackedDiff.length,
    untrackedFileCount: untracked.length,
    contentSha256: contentHash.digest("hex"),
    statusPreview: nulValues(status).slice(0, 5),
  };
  bindingCache.set(canonicalPath, {
    device: metadata.dev,
    inode: metadata.ino,
    treeSha256: await workspaceTreeSha256(canonicalPath),
    binding,
  });
  return binding;
}

export async function bindLedgerEpochOrphanWorkspaces(input: {
  readonly workspacePaths: readonly string[];
  readonly requiredWorkspacePaths: ReadonlySet<string>;
  readonly deniedRoots: readonly string[];
}): Promise<readonly ConsumedOutputLedgerEpochOrphanWorkspaceBinding[]> {
  const bindings = await Promise.all(input.workspacePaths.map(async (workspacePath) => {
    const binding = await bindLedgerEpochOrphanWorkspace({
      workspacePath,
      deniedRoots: input.deniedRoots,
    });
    if (!binding && input.requiredWorkspacePaths.has(resolve(workspacePath))) {
      throw new Error("ledger_epoch_clean_or_missing_orphan_refused");
    }
    return binding;
  }));
  return bindings.filter(
    (binding): binding is ConsumedOutputLedgerEpochOrphanWorkspaceBinding =>
      binding !== undefined,
  );
}

export async function ledgerEpochOrphanWorkspaceBindingMatches(input: {
  readonly binding: ConsumedOutputLedgerEpochOrphanWorkspaceBinding;
  readonly deniedRoots: readonly string[];
}): Promise<boolean> {
  try {
    const current = await bindLedgerEpochOrphanWorkspace({
      workspacePath: input.binding.declaredPath,
      deniedRoots: input.deniedRoots,
    });
    return JSON.stringify(current) === JSON.stringify(input.binding);
  } catch {
    return false;
  }
}

function nulValues(bytes: Buffer): string[] {
  return bytes.toString("utf8").split("\0").filter(Boolean);
}

function assertSafeRelativePath(path: string): void {
  if (!path || isAbsolute(path) || normalize(path) !== path || path === ".." ||
    path.startsWith(`..${sep}`)
  ) throw new Error("ledger_epoch_orphan_workspace_path_unsafe");
}

async function readHardenedFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_ORPHAN_FILE_BYTES) {
      throw new Error("ledger_epoch_orphan_workspace_entry_unsafe");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function workspaceTreeSha256(root: string): Promise<string> {
  const hash = createHash("sha256").update("ledger-epoch-workspace-tree-v1\0");
  const visit = async (path: string, relativePath: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const child = `${relativePath}/${entry.name}`;
      const absolute = resolve(path, entry.name);
      const metadata = await lstat(absolute);
      hash.update(child).update("\0").update(String(metadata.mode)).update("\0");
      if (metadata.isDirectory()) {
        hash.update("directory\n");
        await visit(absolute, child);
      } else if (metadata.isSymbolicLink()) {
        hash.update("symlink\0").update(await readlink(absolute)).update("\n");
      } else if (metadata.isFile()) {
        const bytes = await readHardenedFile(absolute);
        hash.update("file\0").update(String(bytes.length)).update("\0")
          .update(sha256(bytes)).update("\n");
      } else {
        hash.update("other\n");
      }
    }
  };
  await visit(root, "");
  return hash.digest("hex");
}

async function gitBytes(cwd: string, args: readonly string[]): Promise<Buffer> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  return result.stdout;
}

async function canonicalPathIfPresent(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathInsideOrEqual(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
