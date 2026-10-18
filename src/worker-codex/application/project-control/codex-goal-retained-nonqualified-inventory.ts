import { createHash } from "node:crypto";
import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import {
  RetainedNonqualifiedResourcePolicyId,
  retainedNonqualifiedResourceLimits,
  type RetainedNonqualifiedInventoryEntry,
  type RetainedNonqualifiedResourceLimits,
} from "@vioxen/subscription-runtime/worker-core";
import { hashHeldImmutableFile, statHeldImmutableFile } from "../../../worker-local/project-control-evidence-custody-held-stat";
import { assertGitWorkspaceRawPatchIdentitySupported } from "../../codex-goal-runtime-result-io";
import { tarPathFields } from "../../codex-goal-handoff-untracked-tar";
import { defaultProjectControlGitPort } from "./adapters/host-command-adapters";
import { readRegularFileWithMode, USTAR_TRAILER_BYTES, ustarMemberBytes } from "./codex-goal-retained-nonqualified-lifecycle";

const GIT_TIMEOUT_MS = 20_000;
const PLACEHOLDER_SHA256 = "0".repeat(64);

/** Dependency and cache directories that are rebuildable and never useful INPUT. Nothing else is disposable. */
export const RETAINED_NONQUALIFIED_DISPOSABLE_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".venv",
]);
// Credentials, auth and session material is never archived, and an ignored one cannot be classified away.
const CREDENTIAL_PATH = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|\.codex|\.claude|auth(\.json)?|credentials?(\..*)?|secrets?(\..*)?|sessions?|id_[a-z0-9]+|[^/]*\.(pem|key|p12|pfx))(\/|$)/i;

export type RetainedWorkspaceInventory = {
  readonly headCommit: string;
  readonly entries: readonly RetainedNonqualifiedInventoryEntry[];
  readonly totalBytes: number;
  readonly digest: string;
  /** Raw bytes of untracked files and explicitly retained ignored files, in path order. Empty when measuring. */
  readonly untrackedFiles: readonly { readonly path: string; readonly bytes: Buffer; readonly mode: number }[];
  /** Staged blobs that differ from HEAD (binary-safe), so the index can be rebuilt independently of the worktree. */
  readonly stagedFiles: readonly { readonly path: string; readonly bytes: Buffer; readonly mode: number }[];
  /** Ignored entries classified as disposable dependency/cache material (names only, never copied). */
  readonly disposableListing: readonly string[];
  /**
   * Exact sizes derived from the same scan: the padded USTAR lengths the two archives will have, and an
   * upper bound for the pretty-printed receipt entries. Measured identically with or without bodies.
   */
  readonly measure: {
    readonly untrackedTarBytes: number;
    readonly stagedTarBytes: number;
    readonly receiptEntriesBoundBytes: number;
    readonly worktreeBytes: number;
    readonly stagedBytes: number;
    readonly largestFileBytes: number;
  };
};

export type RetainedInventoryOptions = {
  readonly collect?: boolean;
  /**
   * Metadata only: sizes and modes come from held descriptors and no body is read or hashed, so a large
   * corpus can be admitted (or refused) before any large allocation. The returned digest and entry hashes
   * are placeholders and must never be compared or recorded.
   */
  readonly measureOnly?: boolean;
  /** Exact relative paths of ignored files that are useful INPUT and must be retained. */
  readonly ignoredRetain?: readonly string[];
  /** The validated effective policy limits; defaults to the ordinary policy. */
  readonly limits?: RetainedNonqualifiedResourceLimits;
};

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const byPath = <T extends { readonly path: string }>(left: T, right: T) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

export function retainedInventoryDigest(
  headCommit: string,
  entries: readonly RetainedNonqualifiedInventoryEntry[],
  disposableListing: readonly string[],
): string {
  return sha256(JSON.stringify({ headCommit, entries, disposableListing }));
}

/**
 * Capture a closed, content-hashed inventory: every tracked change relative to
 * HEAD with its independent stage-zero index entry (mode and object id, so an
 * index-only change is visible even when HEAD, the worktree bytes and the
 * porcelain code are unchanged), every untracked file, and every ignored file.
 * An ignored file must be explicitly retained (useful input) or sit under a
 * dependency/cache directory; anything else, and any credential-looking path,
 * refuses instead of being silently omitted. The same function serves the
 * operation and admission, so "unchanged" means one thing. Aliases, escaping or
 * aliased parents, nested repositories, unmerged/gitlink entries, oversize trees
 * and a tree that changes while read all refuse.
 *
 * Every size limit comes from the one validated policy passed in `limits`: the entry
 * count, each file, the combined worktree+staged bytes, and the Git metadata buffers.
 * A file is refused from its measured size BEFORE its body is allocated.
 */
export async function captureRetainedWorkspaceInventory(
  workspacePath: string,
  options: RetainedInventoryOptions = {},
): Promise<RetainedWorkspaceInventory> {
  const limits = options.limits ?? retainedNonqualifiedResourceLimits(RetainedNonqualifiedResourcePolicyId.Default)!;
  const measureOnly = options.measureOnly === true;
  const root = await realpath(workspacePath);
  await assertGitWorkspaceRawPatchIdentitySupported(root);
  const gitBuffer = async (args: readonly string[], maxBuffer: number = limits.gitMetadataBytes) =>
    Buffer.from((await defaultProjectControlGitPort.runBuffered({
      args: ["-C", root, ...args], timeoutMs: GIT_TIMEOUT_MS, maxBuffer,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    })).stdout);
  const git = async (args: readonly string[]) => (await gitBuffer(args)).toString("utf8");
  const headCommit = (await git(["rev-parse", "--verify", "HEAD"])).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headCommit)) throw new Error("retained_nonqualified_head_required");
  const status = async () => parseStatus(await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]));
  const listing = await status();
  if (listing.length > limits.entries) throw new Error("retained_nonqualified_inventory_too_large");
  const indexEntries = parseIndex(await git(["ls-files", "--stage", "-z"]));
  const headEntries = parseTree(await git(["ls-tree", "-r", "-z", "HEAD"]));
  const retain = new Set(options.ignoredRetain ?? []);
  const entries: RetainedNonqualifiedInventoryEntry[] = [];
  const untrackedFiles: { path: string; bytes: Buffer; mode: number }[] = [];
  const stagedFiles: { path: string; bytes: Buffer; mode: number }[] = [];
  let totalBytes = 0;
  let worktreeBytes = 0;
  let stagedBytes = 0;
  let largestFileBytes = 0;
  let untrackedTarBytes = USTAR_TRAILER_BYTES;
  let stagedTarBytes = USTAR_TRAILER_BYTES;
  let receiptEntriesBoundBytes = 0;
  const admit = (size: number) => {
    if (size > limits.fileBytes || totalBytes + size > limits.inventoryBytes) throw new Error("retained_nonqualified_inventory_too_large");
    totalBytes += size;
    largestFileBytes = Math.max(largestFileBytes, size);
  };
  const representable = (path: string) => {
    if (tarPathFields(path) === undefined) throw new Error("retained_nonqualified_tar_path_unrepresentable");
  };
  const noteReceiptEntry = (path: string, hasIndex: boolean) => {
    // Upper bound of one two-space pretty-printed receipt entry: the seven fixed fields measure about 245 bytes
    // plus the exact JSON-encoded path (quotes and escapes included); 270 leaves slack for wider numbers. The
    // optional index object measures about 142 bytes; 160 leaves slack. Observed canary receipts average ~354.
    receiptEntriesBoundBytes += 270 + Buffer.byteLength(JSON.stringify(path)) + (hasIndex ? 160 : 0);
  };
  /** Size and mode from a held descriptor first (no body); the body is read only after the size is admitted. */
  const fileEntry = async (absolutePath: string): Promise<{ bytes: Buffer | undefined; sha256: string; length: number; mode: number }> => {
    const held = await statHeldImmutableFile(absolutePath);
    admit(held.length);
    if (measureOnly) return { bytes: undefined, sha256: PLACEHOLDER_SHA256, length: held.length, mode: held.mode };
    if (options.collect !== true) {
      // Verification (admission, recheck) needs only the digest: stream it through the held descriptor so that no file
      // body is ever resident, whatever the policy's per-file bound.
      const streamed = await hashHeldImmutableFile(absolutePath, limits.fileBytes);
      if (streamed.length !== held.length) throw new Error("retained_nonqualified_workspace_changing");
      return { bytes: undefined, sha256: streamed.sha256, length: streamed.length, mode: streamed.mode };
    }
    const { bytes, mode } = await readRegularFileWithMode(absolutePath, limits.fileBytes);
    if (bytes.length !== held.length) throw new Error("retained_nonqualified_workspace_changing");
    return { bytes, sha256: sha256(bytes), length: bytes.length, mode };
  };

  for (const item of listing) {
    // `dir/` is how Git reports a nested repository (or submodule): its contents are not inventoried.
    if (item.path.endsWith("/")) throw new Error("retained_nonqualified_unsupported_entry");
    const untracked = item.code === "??";
    if (/[U]/.test(item.code) || item.code === "!!" || item.code === "AA") throw new Error("retained_nonqualified_unmerged_entry");
    const absolutePath = await insideWorkspace(root, item.path);
    const staged = indexEntries.get(item.path);
    if (staged !== undefined && (staged.stage !== "0" || staged.mode === "160000")) throw new Error("retained_nonqualified_unmerged_entry");
    const index = staged === undefined ? undefined : { mode: staged.mode, oid: staged.oid };
    const head = headEntries.get(item.path);
    if (index !== undefined && (head === undefined || head.oid !== index.oid || head.mode !== index.mode)) {
      // The staged side as its own recoverable object, independent of any worktree edit. Its size is read
      // from Git first, so an oversize blob is refused before the body is requested.
      const blobSize = parseBlobSize(await git(["cat-file", "-s", index.oid]));
      admit(blobSize);
      stagedBytes += blobSize;
      representable(item.path);
      stagedTarBytes += ustarMemberBytes(blobSize);
      // The raw staged payload is fetched ONLY by the admitted collecting path. Every other mode (measuring, admission,
      // recheck) is bound by the independent index identity already recorded on the entry (stage-zero mode + object id,
      // whose id is the content hash of the blob) and by the size admitted above, so no staged body is ever requested.
      if (options.collect === true && !measureOnly) {
        const blob = await gitBuffer(["cat-file", "blob", index.oid], blobSize + 1024);
        if (blob.length !== blobSize) throw new Error("retained_nonqualified_workspace_changing");
        stagedFiles.push({ path: item.path, bytes: blob, mode: index.mode === "100755" ? 0o755 : 0o644 });
      }
    }
    const metadata = await lstat(absolutePath).catch((error: unknown) => {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    });
    const indexField = index === undefined ? {} : { index };
    noteReceiptEntry(item.path, index !== undefined);
    if (!metadata) {
      if (untracked || !item.code.includes("D")) throw new Error("retained_nonqualified_workspace_changing");
      entries.push({ path: item.path, status: item.code, layer: "tracked", kind: "deleted", mode: 0, size: 0, sha256: sha256(""), ...indexField });
      continue;
    }
    if (metadata.isSymbolicLink()) {
      // A tracked link is bound by its target text and never followed. An
      // untracked link cannot be represented in the raw-byte archive.
      const target = await readlink(absolutePath);
      if (untracked || isAbsolute(target) || escapesWorkspace(item.path, target)) throw new Error("retained_nonqualified_unsafe_symlink");
      entries.push({ path: item.path, status: item.code, layer: "tracked", kind: "symlink",
        mode: metadata.mode & 0o777, size: Buffer.byteLength(target), sha256: sha256(target), ...indexField });
      continue;
    }
    if (!metadata.isFile()) throw new Error("retained_nonqualified_unsupported_entry");
    // Advisory early refusal from the path-based size; the held descriptor below is the authority.
    if (metadata.size > limits.fileBytes || totalBytes + metadata.size > limits.inventoryBytes) throw new Error("retained_nonqualified_inventory_too_large");
    const { bytes, sha256: fileSha256, length, mode } = await fileEntry(absolutePath);
    worktreeBytes += length;
    if (untracked) { representable(item.path); untrackedTarBytes += ustarMemberBytes(length); }
    entries.push({ path: item.path, status: item.code, layer: untracked ? "untracked" : "tracked", kind: "file",
      mode, size: length, sha256: fileSha256, ...indexField });
    if (untracked && options.collect && bytes !== undefined) untrackedFiles.push({ path: item.path, bytes, mode });
  }

  // Ignored files: retain the explicitly named useful inputs, classify only dependency/cache
  // directories as disposable, and refuse everything else rather than omit it.
  const disposable = new Set<string>();
  const ignoredFiles = new Set<string>();
  for (const name of parseNullList(await git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]))) {
    if (disposableEntry(name)) { disposable.add(name); continue; }
    if (!name.endsWith("/")) { ignoredFiles.add(name); continue; }
    for (const file of parseNullList(await git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", name]))) {
      if (disposableEntry(file)) disposable.add(name);
      else ignoredFiles.add(file);
    }
  }
  if (listing.length + ignoredFiles.size + disposable.size > limits.entries) throw new Error("retained_nonqualified_inventory_too_large");
  // The receipt also lists each disposable entry and each retained ignored path by name.
  for (const name of disposable) receiptEntriesBoundBytes += 10 + Buffer.byteLength(JSON.stringify(name));
  for (const wanted of retain) {
    if (CREDENTIAL_PATH.test(wanted)) throw new Error(`retained_nonqualified_ignored_credential_path:${wanted}`);
    if (!ignoredFiles.has(wanted)) throw new Error(`retained_nonqualified_ignored_retain_not_ignored:${wanted}`);
  }
  for (const file of [...ignoredFiles].sort()) {
    if (!retain.has(file)) throw new Error(`retained_nonqualified_ignored_unclassified:${file}`);
    const absolutePath = await insideWorkspace(root, file);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) throw new Error("retained_nonqualified_unsafe_symlink");
    if (!metadata.isFile()) throw new Error("retained_nonqualified_unsupported_entry");
    if (metadata.size > limits.fileBytes || totalBytes + metadata.size > limits.inventoryBytes) throw new Error("retained_nonqualified_inventory_too_large");
    const { bytes, sha256: fileSha256, length, mode } = await fileEntry(absolutePath);
    worktreeBytes += length;
    representable(file);
    untrackedTarBytes += ustarMemberBytes(length);
    noteReceiptEntry(file, false);
    receiptEntriesBoundBytes += 10 + Buffer.byteLength(JSON.stringify(file)); // also listed in ignored.retain
    entries.push({ path: file, status: "!!", layer: "ignored", kind: "file", mode, size: length, sha256: fileSha256 });
    if (options.collect && bytes !== undefined) untrackedFiles.push({ path: file, bytes, mode });
  }

  entries.sort(byPath);
  untrackedFiles.sort(byPath);
  stagedFiles.sort(byPath);
  const disposableListing = [...disposable].sort();
  // Closed inventory: the listing must be identical after the bytes were read.
  if (JSON.stringify(await status()) !== JSON.stringify(listing)) throw new Error("retained_nonqualified_workspace_changing");
  return { headCommit, entries, totalBytes, digest: retainedInventoryDigest(headCommit, entries, disposableListing),
    untrackedFiles, stagedFiles, disposableListing,
    measure: { untrackedTarBytes, stagedTarBytes, receiptEntriesBoundBytes, worktreeBytes, stagedBytes, largestFileBytes } };
}

function parseBlobSize(raw: string): number {
  const text = raw.trim();
  if (!/^\d{1,15}$/.test(text)) throw new Error("retained_nonqualified_git_blob_size_invalid");
  return Number(text);
}

function disposableEntry(name: string): boolean {
  return name.split("/").some((part) => RETAINED_NONQUALIFIED_DISPOSABLE_DIRECTORIES.has(part)) && !CREDENTIAL_PATH.test(name);
}

function parseNullList(raw: string): readonly string[] {
  const records = raw.split("\0");
  if (records.pop() !== "") throw new Error("retained_nonqualified_git_listing_invalid");
  return records;
}

function parseStatus(raw: string): readonly { readonly code: string; readonly path: string }[] {
  return parseNullList(raw).map((record) => {
    if (record.length < 4 || record[2] !== " ") throw new Error("retained_nonqualified_git_status_invalid");
    return { code: record.slice(0, 2), path: record.slice(3) };
  });
}

/** `git ls-files --stage -z`: "<mode> <oid> <stage>\t<path>". */
function parseIndex(raw: string): ReadonlyMap<string, { readonly mode: string; readonly oid: string; readonly stage: string }> {
  const result = new Map<string, { mode: string; oid: string; stage: string }>();
  for (const record of parseNullList(raw)) {
    const tab = record.indexOf("\t");
    const fields = record.slice(0, tab).split(" ");
    if (tab < 0 || fields.length !== 3) throw new Error("retained_nonqualified_git_index_invalid");
    const [mode, oid, stage] = fields as [string, string, string];
    const path = record.slice(tab + 1);
    // A second entry for a path is a conflicted (non-zero stage) index.
    if (result.has(path) || stage !== "0") throw new Error("retained_nonqualified_unmerged_entry");
    result.set(path, { mode, oid, stage });
  }
  return result;
}

/** `git ls-tree -r -z HEAD`: "<mode> <type> <oid>\t<path>". */
function parseTree(raw: string): ReadonlyMap<string, { readonly mode: string; readonly oid: string }> {
  const result = new Map<string, { mode: string; oid: string }>();
  for (const record of parseNullList(raw)) {
    const tab = record.indexOf("\t");
    const fields = record.slice(0, tab).split(" ");
    if (tab < 0 || fields.length !== 3) throw new Error("retained_nonqualified_git_tree_invalid");
    result.set(record.slice(tab + 1), { mode: fields[0]!, oid: fields[2]! });
  }
  return result;
}

/** A relative path whose real parent is the lexical parent: no alias or escape. */
async function insideWorkspace(root: string, relativePath: string): Promise<string> {
  const parts = relativePath.split("/");
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\0") ||
      parts.some((part) => part === "" || part === "." || part === ".." || part === ".git")) {
    throw new Error("retained_nonqualified_unsafe_path");
  }
  const absolutePath = join(root, relativePath);
  if (await realpath(dirname(absolutePath)) !== dirname(absolutePath)) throw new Error("retained_nonqualified_unsafe_path");
  return absolutePath;
}

function escapesWorkspace(relativePath: string, target: string): boolean {
  const resolved = normalize(resolve("/workspace", dirname(relativePath), target));
  return resolved !== "/workspace" && !resolved.startsWith("/workspace/");
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
