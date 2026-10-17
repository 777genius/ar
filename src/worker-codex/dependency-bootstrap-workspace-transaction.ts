import { captureLegacyDependencyWriterInput, assertLegacyDependencyWriterWorkspace } from "./hosted-dependency-legacy-writer-boundary";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

type GitWorkspace = {
  readonly rootPath: string;
  readonly workspacePath: string;
  readonly pathspec: string;
  readonly indexPath: string;
};

type WorkspaceEntry = {
  readonly path: string;
  readonly kind: "file" | "symlink" | "missing";
  readonly mode?: number;
  readonly digest?: string;
  readonly linkTarget?: string;
};

type WorkspaceState = {
  readonly status: Buffer;
  readonly indexEntries: Buffer;
  readonly entries: ReadonlyMap<string, WorkspaceEntry>;
  readonly indexDigest?: string;
  readonly indexMode?: number;
};

type WorkspaceBaseline = WorkspaceState & {
  readonly backupRoot: string;
  readonly indexExisted: boolean;
  readonly indexMode?: number;
  readonly operationId: string;
  readonly ancestors: ReadonlyMap<string, DirectoryIdentity | undefined>;
  readonly mountDigest?: string;
  readonly anchors: ReadonlyMap<string, FileHandle>;
  readonly indexIdentity?: DirectoryIdentity;
  readonly backupIdentity: DirectoryIdentity;
  readonly backupPaths: ReadonlyMap<string, string>;
  readonly backupAnchor?: FileHandle;
};

type DirectoryIdentity = { readonly dev: string; readonly ino: string };

export enum DependencyBootstrapRecoveryReason {
  AncestorChanged = "ancestor_changed",
  LeafChanged = "leaf_changed",
  ScopedIndexChanged = "scoped_shared_index_changed",
  InspectionFailed = "post_action_inspection_failed",
  ActionFailed = "action_failed",
  MutationDetected = "workspace_mutation_detected",
  CleanupFailed = "recovery_cleanup_failed",
  RestoreFailed = "restore_failed",
  Unsupported = "anchored_restore_unsupported",
}

type RecoveryLocator = { readonly operationId: string; readonly manifestPath: string };

/** Recovery bytes are retained; the locator contains no action error/output. */
export class DependencyBootstrapWorkspaceRecoveryError extends Error {
  readonly name = "DependencyBootstrapWorkspaceRecoveryError";
  constructor(
    readonly reason: DependencyBootstrapRecoveryReason,
    readonly recovery: RecoveryLocator,
    readonly originalReason: string,
  ) {
    super(
      `dependency_bootstrap_workspace_recovery_required:${reason}:operation=${recovery.operationId}:manifest=${recovery.manifestPath}:original=${originalReason}`,
    );
  }
}

/** Legacy best-effort source recovery only. tmpdir may be disposable and neither
 * execFile completion nor this helper proves installer drain, exclusive custody,
 * durable recovery, managed Ready or eviction safety. Never use it as that proof.
 */
export async function withDependencyBootstrapWorkspaceTransaction<T>(input: {
  readonly workspacePath: string;
  readonly action: () => Promise<T>;
}): Promise<T> {
  input = captureLegacyDependencyWriterInput(input);
  const workspace = await resolveGitWorkspace(input.workspacePath);
  assertLegacyDependencyWriterWorkspace(input.workspacePath);
  if (!workspace) return input.action();

  const backupRoot = await mkdtemp(join(tmpdir(), "subscription-runtime-dependency-bootstrap-"));
  let actionStarted = false;
  let baseline: WorkspaceBaseline | undefined;
  try {
    await chmod(backupRoot, 0o700);
    baseline = await captureBaseline(workspace, backupRoot);
    await publishRecoveryManifest(workspace, baseline);
    let value: T;
    let actionError: unknown;
    let actionFailed = false;
    actionStarted = true;
    try {
      assertLegacyDependencyWriterWorkspace(input.workspacePath);
      value = await input.action();
    } catch (error) {
      actionError = error;
      actionFailed = true;
    }
    assertLegacyDependencyWriterWorkspace(input.workspacePath);
    const current = await captureAfterAction(workspace, baseline, actionError);
    // A nested workspace does not own the repository-wide index. Refuse every
    // recovery write if it drifted, including when scoped source also changed.
    if (workspace.workspacePath !== workspace.rootPath &&
      (baseline.indexDigest !== current.indexDigest || baseline.indexMode !== current.indexMode)) {
      throw recoveryError(baseline, DependencyBootstrapRecoveryReason.ScopedIndexChanged, actionError);
    }
    const mutations = workspaceMutations(baseline, current);
    if (mutations.length > 0) {
      assertLegacyDependencyWriterWorkspace(input.workspacePath);
      await rollbackWorkspace(workspace, baseline, current, actionError);
    }
    // Preserve originals on every failure, including verified best-effort restore:
    // installer descendants can outlive the action and continue changing source.
    if (actionFailed) throw recoveryError(baseline, DependencyBootstrapRecoveryReason.ActionFailed, actionError);
    if (mutations.length > 0) {
      throw recoveryError(baseline, DependencyBootstrapRecoveryReason.MutationDetected, "workspace_mutation_detected");
    }
    try {
      await cleanupRecovery(baseline);
    } catch (error) {
      throw recoveryError(baseline, DependencyBootstrapRecoveryReason.CleanupFailed, error);
    }
    return value!;
  } catch (error) {
    if (actionStarted && baseline && !(error instanceof DependencyBootstrapWorkspaceRecoveryError)) {
      throw recoveryError(baseline, DependencyBootstrapRecoveryReason.InspectionFailed, error);
    }
    if (!actionStarted) {
      const reason = error instanceof Error && error.message === "dependency_bootstrap_workspace_transaction_filename_encoding_unsupported"
        ? error.message
        : `dependency_bootstrap_workspace_transaction_baseline_failed:${safeErrorMessage(error)}`;
      throw new Error(reason);
    }
    throw error;
  } finally {
    if (!actionStarted) await rm(backupRoot, { recursive: true, force: true });
    if (baseline) {
      await Promise.all([
        ...baseline.anchors.values(),
        ...(baseline.backupAnchor ? [baseline.backupAnchor] : []),
      ].map((handle) => handle.close()));
    }
  }
}

async function captureAfterAction(
  workspace: GitWorkspace,
  baseline: WorkspaceBaseline,
  originalError?: unknown,
): Promise<WorkspaceState> {
  try {
    await assertAncestorsUnchanged(baseline);
    const current = await captureWorkspaceState(workspace);
    await assertAncestorsUnchanged(baseline);
    return current;
  } catch (error) {
    throw recoveryError(
      baseline,
      error instanceof AncestorChangedError
        ? DependencyBootstrapRecoveryReason.AncestorChanged
        : DependencyBootstrapRecoveryReason.InspectionFailed,
      originalError ?? error,
    );
  }
}

async function resolveGitWorkspace(
  requestedWorkspacePath: string,
): Promise<GitWorkspace | undefined> {
  const workspacePath = await realpath(requestedWorkspacePath);
  assertLegacyDependencyWriterWorkspace(requestedWorkspacePath);
  let output: Buffer;
  try {
    output = await git(workspacePath, [
      "rev-parse",
      "--is-inside-work-tree",
      "--show-toplevel",
      "--path-format=absolute",
      "--git-path",
      "index",
    ]);
  } catch (error) {
    if (gitRepositoryMissing(error)) return undefined;
    throw new Error(
      `dependency_bootstrap_workspace_transaction_git_inspection_failed:${safeErrorMessage(error)}`,
    );
  }
  const lines = output.toString("utf8").trimEnd().split("\n");
  if (lines[0] !== "true" || !lines[1] || !lines[2]) {
    throw new Error("dependency_bootstrap_workspace_transaction_git_invalid");
  }
  const rootPath = await realpath(lines[1]);
  const workspaceRelative = normalizeGitPath(relative(rootPath, workspacePath));
  if (workspaceRelative === ".." || workspaceRelative.startsWith("../")) {
    throw new Error("dependency_bootstrap_workspace_transaction_scope_invalid");
  }
  const rawIndexPath = lines[2];
  return {
    rootPath,
    workspacePath,
    pathspec:
      workspaceRelative.length === 0
        ? "."
        : `:(top,literal)${workspaceRelative}`,
    indexPath: isAbsolute(rawIndexPath)
      ? rawIndexPath
      : resolve(workspacePath, rawIndexPath),
  };
}

async function captureBaseline(
  workspace: GitWorkspace,
  backupRoot: string,
): Promise<WorkspaceBaseline> {
  const state = await captureWorkspaceState(workspace);
  const ancestors = await captureAncestors(workspace, state);
  const anchors = new Map<string, FileHandle>();
  const backupPaths = new Map<string, string>();
  let backupAnchor: FileHandle | undefined;
  try {
    if (process.platform === "linux") {
      for (const [path, expected] of ancestors) {
        if (!expected) continue;
        const parent = anchors.get(dirname(path));
        const anchoredPath = parent && dirname(path) !== path ? join(`/proc/self/fd/${parent.fd}`, relative(dirname(path), path)) : path;
        const handle = await open(anchoredPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        anchors.set(path, handle);
        const actual = identity(await handle.stat({ bigint: true }));
        if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new AncestorChangedError();
      }
    }
    if (process.platform === "linux") {
      backupAnchor = await open(backupRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    }
    for (const entry of state.entries.values()) {
      if (entry.kind === "file") {
        const source = workspaceEntryPath(workspace, entry.path);
        const backupName = `entry-${backupPaths.size.toString().padStart(6, "0")}`;
        backupPaths.set(entry.path, backupName);
        const destination = join(backupRoot, backupName);
        await copyFile(source, destination);
        await chmod(destination, 0o600);
        if (hash(await readFile(destination)) !== entry.digest) {
          throw new Error("dependency_bootstrap_workspace_baseline_unstable");
        }
        await syncFile(destination);
      }
    }

    const indexStat = await lstatOrUndefined(workspace.indexPath);
    if (indexStat && !indexStat.isFile()) {
      throw new Error("dependency_bootstrap_workspace_transaction_index_invalid");
    }
    if (indexStat) {
      const indexBackupPath = join(backupRoot, "index");
      await copyFile(workspace.indexPath, indexBackupPath);
      await chmod(indexBackupPath, 0o600);
      await syncFile(indexBackupPath);
    }
    const baseline: WorkspaceBaseline = {
      ...state,
      backupRoot,
      indexExisted: indexStat !== undefined,
      ...(indexStat ? { indexMode: indexStat.mode & 0o7777 } : {}),
      operationId: randomUUID(),
      ancestors,
      anchors,
      backupIdentity: identity(await lstat(backupRoot, { bigint: true })),
      backupPaths,
      ...(backupAnchor ? { backupAnchor } : {}),
      ...(indexStat ? { indexIdentity: identity(await lstat(workspace.indexPath, { bigint: true })) } : {}),
      ...(process.platform === "linux" ? { mountDigest: await mountDigest() } : {}),
    };
    await assertAncestorsUnchanged(baseline);
    if (workspaceMutations(state, await captureWorkspaceState(workspace)).length > 0) {
      throw new Error("dependency_bootstrap_workspace_baseline_unstable");
    }
    if (indexStat && !Buffer.from(await readFile(workspace.indexPath)).equals(await readFile(join(backupRoot, "index")))) {
      throw new Error("dependency_bootstrap_workspace_baseline_index_unstable");
    }
    return baseline;
  } catch (error) {
    await Promise.all([...anchors.values(), ...(backupAnchor ? [backupAnchor] : [])].map((handle) => handle.close()));
    throw error;
  }
}

async function publishRecoveryManifest(
  workspace: GitWorkspace,
  baseline: WorkspaceBaseline,
): Promise<void> {
  const manifest = {
    version: 1,
    // A locator for manual best-effort recovery, not a durability receipt.
    retention: "legacy_best_effort",
    coverage: "tracked_and_nonignored",
    operationId: baseline.operationId,
    workspace: {
      canonicalPath: workspace.workspacePath,
      gitRootPath: workspace.rootPath,
      identity: baseline.ancestors.get(workspace.workspacePath),
    },
    index: {
      path: workspace.indexPath,
      existed: baseline.indexExisted,
      mode: baseline.indexMode,
      ...(baseline.indexExisted ? {
        identity: baseline.indexIdentity,
        digest: baseline.indexDigest,
        backupPath: "index",
        backupIdentity: identity(await lstat(join(baseline.backupRoot, "index"), { bigint: true })),
      } : {}),
    },
    ancestors: [...baseline.ancestors].map(([path, directoryIdentity]) => ({ path, identity: directoryIdentity ?? null })),
    mountDigest: baseline.mountDigest,
    backupIdentity: baseline.backupIdentity,
    entries: await Promise.all([...baseline.entries.values()].map(async (entry) => ({
      ...entry,
      ...(entry.kind === "file" ? {
        backupPath: baseline.backupPaths.get(entry.path),
        backupIdentity: identity(await lstat(backupEntryPath(baseline, entry.path), { bigint: true })),
      } : {}),
    }))),
  };
  const temporaryPath = join(baseline.backupRoot, "recovery.json.tmp");
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, join(baseline.backupRoot, "recovery.json"));
  await syncDirectory(baseline.backupRoot);
  await syncDirectory(dirname(baseline.backupRoot));
}

class AncestorChangedError extends Error {}

async function captureAncestors(workspace: GitWorkspace, state: WorkspaceState) {
  const paths = new Set<string>();
  const entryParents = [...state.entries.values()].map(
    (entry) => dirname(workspaceEntryPath(workspace, entry.path)),
  );
  for (const path of [workspace.workspacePath, workspace.rootPath, dirname(workspace.indexPath), ...entryParents]) {
    let parent = path;
    for (;;) {
      paths.add(parent);
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  const ancestors = new Map<string, DirectoryIdentity | undefined>();
  for (const path of [...paths].sort((left, right) => left.length - right.length)) {
    const info = await directoryStatOrUndefined(path);
    if (info && !info.isDirectory()) throw new AncestorChangedError();
    ancestors.set(path, info ? identity(info) : undefined);
  }
  return ancestors;
}

async function assertAncestorsUnchanged(baseline: WorkspaceBaseline): Promise<void> {
  // Check outer parents before children: do not traverse a new symlink namespace.
  for (const [path, expected] of baseline.ancestors) {
    const actual = await directoryStatOrUndefined(path);
    const matches = expected === undefined
      ? actual === undefined
      : actual?.isDirectory() && actual.dev.toString() === expected.dev && actual.ino.toString() === expected.ino;
    if (!matches) {
      throw new AncestorChangedError();
    }
  }
  if (baseline.mountDigest !== undefined && baseline.mountDigest !== await mountDigest()) {
    throw new AncestorChangedError();
  }
}

function identity(info: { readonly dev: number | bigint; readonly ino: number | bigint }): DirectoryIdentity {
  return { dev: info.dev.toString(), ino: info.ino.toString() };
}

async function mountDigest(): Promise<string> {
  return hash(await readFile("/proc/self/mountinfo"));
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } catch (error) {
    // Legacy platforms may not support directory sync. This helper makes no
    // durable-recovery claim; actual I/O errors still abort/refuse effects.
    if (!hasErrorCode(error, ["EINVAL", "ENOTSUP", "EOPNOTSUPP"])) throw error;
  } finally {
    await handle.close();
  }
}

function hasErrorCode(error: unknown, codes: readonly string[]): boolean {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && codes.includes(error.code);
}

function recoveryError(baseline: WorkspaceBaseline, reason: DependencyBootstrapRecoveryReason, original: unknown) {
  // Arbitrary provider/installer exceptions can include credentials or file bytes.
  const originalReason = original === "workspace_mutation_detected"
    ? original
    : safeErrorMessage(original);
  return new DependencyBootstrapWorkspaceRecoveryError(reason, recoveryLocator(baseline), originalReason);
}

function recoveryLocator(baseline: WorkspaceBaseline): RecoveryLocator {
  return { operationId: baseline.operationId, manifestPath: join(baseline.backupRoot, "recovery.json") };
}

async function directoryStatOrUndefined(path: string) {
  try { return await lstat(path, { bigint: true }); } catch (error) {
    if (hasErrorCode(error, ["ENOENT"])) return undefined;
    throw error;
  }
}

async function captureWorkspaceState(
  workspace: GitWorkspace,
): Promise<WorkspaceState> {
  const indexStat = await lstatOrUndefined(workspace.indexPath);
  if (indexStat && !indexStat.isFile()) throw new Error("dependency_bootstrap_workspace_transaction_index_invalid");
  const [status, indexEntries, tracked, untracked] = await Promise.all([
    git(workspace.rootPath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      workspace.pathspec,
    ]),
    git(workspace.rootPath, [
      "ls-files",
      "--stage",
      "--full-name",
      "-z",
      "--",
      workspace.pathspec,
    ]),
    gitPaths(workspace, ["ls-files", "--cached", "--full-name", "-z"]),
    gitPaths(workspace, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--full-name",
      "-z",
    ]),
  ]);
  const paths = [...new Set([...tracked, ...untracked])].sort((left, right) =>
    left.localeCompare(right),
  );
  const entries = new Map<string, WorkspaceEntry>();
  for (const path of paths) {
    entries.set(path, await inspectWorkspaceEntry(workspace, path));
  }
  return {
    status, indexEntries, entries,
    ...(indexStat ? { indexDigest: hash(await readFile(workspace.indexPath)), indexMode: indexStat.mode & 0o7777 } : {}),
  };
}

async function inspectWorkspaceEntry(
  workspace: GitWorkspace,
  path: string,
): Promise<WorkspaceEntry> {
  const absolutePath = workspaceEntryPath(workspace, path);
  const entryStat = await lstatOrUndefined(absolutePath);
  if (!entryStat) return { path, kind: "missing" };
  if (entryStat.isSymbolicLink()) {
    return {
      path,
      kind: "symlink",
      mode: entryStat.mode & 0o7777,
      linkTarget: await readlink(absolutePath),
    };
  }
  if (entryStat.isFile()) {
    return {
      path,
      kind: "file",
      mode: entryStat.mode & 0o7777,
      digest: createHash("sha256")
        .update(await readFile(absolutePath))
        .digest("hex"),
    };
  }
  throw new Error("dependency_bootstrap_workspace_transaction_entry_unsupported");
}

async function rollbackWorkspace(
  workspace: GitWorkspace,
  baseline: WorkspaceBaseline,
  current: WorkspaceState,
  originalError: unknown,
): Promise<void> {
  if (process.platform !== "linux") {
    throw recoveryError(baseline, DependencyBootstrapRecoveryReason.Unsupported, originalError);
  }
  try {
    // Validate EVERY destination before the first write. Retained descriptors
    // address the original parents; no recursive deletion or parent creation.
    await assertAncestorsUnchanged(baseline);
    const paths = new Set([...baseline.entries.keys(), ...current.entries.keys()]);
    for (const path of paths) {
      const destination = anchoredEntryPath(workspace, baseline, path);
      await assertLeaf(destination, baseline.entries.get(path));
    }
    await assertLeaf(anchoredPath(baseline, workspace.indexPath));
    await assertBackupUnchanged(baseline);
    for (const entry of baseline.entries.values()) {
      if (entry.kind === "file" && hash(await readFile(backupEntryPath(baseline, entry.path))) !== entry.digest) {
        throw new Error("backup_integrity_failed");
      }
    }
    if (baseline.indexExisted && hash(await readFile(join(baseline.backupRoot, "index"))) !== baseline.indexDigest) {
      throw new Error("backup_integrity_failed");
    }
    await restoreIndex(workspace, baseline);
    for (const path of current.entries.keys()) {
      if (!baseline.entries.has(path)) await unlinkIfPresent(anchoredEntryPath(workspace, baseline, path));
    }
    await restoreBaselineEntries(workspace, baseline);
    await assertAncestorsUnchanged(baseline);
    const verified = await captureWorkspaceState(workspace);
    const remaining = workspaceMutations(baseline, verified);
    if (remaining.length > 0) {
      throw new Error(
        "rollback_verification_failed",
      );
    }
  } catch (rollbackError) {
    throw recoveryError(
      baseline,
      rollbackError instanceof LeafChangedError
        ? DependencyBootstrapRecoveryReason.LeafChanged
        : rollbackError instanceof AncestorChangedError
        ? DependencyBootstrapRecoveryReason.AncestorChanged
        : DependencyBootstrapRecoveryReason.RestoreFailed,
      originalError ?? rollbackError,
    );
  }
}

async function restoreIndex(
  workspace: GitWorkspace,
  baseline: WorkspaceBaseline,
): Promise<void> {
  const destination = anchoredPath(baseline, workspace.indexPath);
  if (!baseline.indexExisted) {
    await unlinkIfPresent(destination);
    return;
  }
  await atomicRestoreFile(destination, await readFile(join(baseline.backupRoot, "index")), baseline.indexMode ?? 0o600);
}

async function restoreBaselineEntries(
  workspace: GitWorkspace,
  baseline: WorkspaceBaseline,
): Promise<void> {
  for (const entry of baseline.entries.values()) {
    const destination = anchoredEntryPath(workspace, baseline, entry.path);
    if (entry.kind === "missing") {
      await unlinkIfPresent(destination);
      continue;
    }
    if (entry.kind === "symlink") {
      await unlinkIfPresent(destination);
      await symlink(entry.linkTarget ?? "", destination);
      continue;
    }
    const source = backupEntryPath(baseline, entry.path);
    await atomicRestoreFile(destination, await readFile(source), entry.mode ?? 0o600);
  }
}

function anchoredEntryPath(workspace: GitWorkspace, baseline: WorkspaceBaseline, path: string): string {
  return anchoredPath(baseline, workspaceEntryPath(workspace, path));
}

function anchoredPath(baseline: WorkspaceBaseline, path: string): string {
  const parent = baseline.anchors.get(dirname(path));
  if (!parent) throw new Error("restore_parent_not_retained");
  return join(`/proc/self/fd/${parent.fd}`, relative(dirname(path), path));
}

class LeafChangedError extends Error {}

async function assertLeaf(path: string, original?: WorkspaceEntry): Promise<void> {
  const info = await lstatOrUndefined(path);
  if (info && (!info.isFile() && !info.isSymbolicLink() ||
    original?.kind === "file" && !info.isFile() ||
    original?.kind === "symlink" && !info.isSymbolicLink())) {
    throw new LeafChangedError();
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try { await unlink(path); } catch (error) {
    if (!hasErrorCode(error, ["ENOENT"])) throw error;
  }
}

async function atomicRestoreFile(destination: string, bytes: Buffer, mode: number): Promise<void> {
  const temporary = join(dirname(destination), `.dependency-bootstrap-${randomUUID()}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
    await rename(temporary, destination);
  } finally {
    await handle.close();
    await unlinkIfPresent(temporary);
  }
  await syncDirectory(dirname(destination));
}

async function assertBackupUnchanged(baseline: WorkspaceBaseline): Promise<void> {
  const info = await directoryStatOrUndefined(baseline.backupRoot);
  if (!info?.isDirectory() || info.dev.toString() !== baseline.backupIdentity.dev || info.ino.toString() !== baseline.backupIdentity.ino) {
    throw new Error("backup_identity_changed");
  }
}

function backupEntryPath(baseline: WorkspaceBaseline, path: string): string {
  const name = baseline.backupPaths.get(path);
  if (!name) throw new Error("backup_mapping_missing");
  return join(baseline.backupRoot, name);
}

async function cleanupRecovery(baseline: WorkspaceBaseline): Promise<void> {
  await assertAncestorsUnchanged(baseline);
  await assertBackupUnchanged(baseline);
  const root = baseline.backupAnchor ? `/proc/self/fd/${baseline.backupAnchor.fd}` : baseline.backupRoot;
  const expected = new Set(["recovery.json", ...baseline.backupPaths.values(), ...(baseline.indexExisted ? ["index"] : [])]);
  const names = await readdir(root);
  if (names.length !== expected.size || names.some((name) => !expected.has(name))) throw new Error("backup_membership_changed");
  for (const name of names) {
    const info = await lstat(join(root, name));
    if (!info.isFile() || info.nlink !== 1) throw new Error("backup_type_changed");
  }
  // Delete mapping last; a partial cleanup failure still leaves a recovery locator.
  for (const name of names.filter((name) => name !== "recovery.json")) await unlink(join(root, name));
  await unlink(join(root, "recovery.json"));
  await rmdir(baseline.backupRoot);
  await syncDirectory(dirname(baseline.backupRoot));
}

function workspaceMutations(
  baseline: WorkspaceState,
  current: WorkspaceState,
): readonly string[] {
  const mutations = new Set<string>();
  const paths = new Set([...baseline.entries.keys(), ...current.entries.keys()]);
  for (const path of paths) {
    if (!sameEntry(baseline.entries.get(path), current.entries.get(path))) {
      mutations.add(path);
    }
  }
  if (!baseline.indexEntries.equals(current.indexEntries)) {
    mutations.add("<git-index>");
  }
  if (baseline.indexDigest !== current.indexDigest || baseline.indexMode !== current.indexMode) mutations.add("<git-index-bytes>");
  if (!baseline.status.equals(current.status)) mutations.add("<git-status>");
  return [...mutations].sort((left, right) => left.localeCompare(right));
}

function sameEntry(
  left: WorkspaceEntry | undefined,
  right: WorkspaceEntry | undefined,
): boolean {
  return (
    left?.kind === right?.kind &&
    left?.mode === right?.mode &&
    left?.digest === right?.digest &&
    left?.linkTarget === right?.linkTarget
  );
}

async function gitPaths(
  workspace: GitWorkspace,
  args: readonly string[],
): Promise<readonly string[]> {
  const output = await git(workspace.rootPath, [
    ...args,
    "--",
    workspace.pathspec,
  ]);
  const decoded = output.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(output)) {
    throw new Error("dependency_bootstrap_workspace_transaction_filename_encoding_unsupported");
  }
  return decoded
    .split("\0")
    .filter(Boolean)
    .map((path) => assertWorkspaceGitPath(workspace, path));
}

async function git(cwd: string, args: readonly string[]): Promise<Buffer> {
  assertLegacyDependencyWriterWorkspace(cwd);
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "buffer",
    timeout: 30_000,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.stdout;
}

function assertWorkspaceGitPath(
  workspace: GitWorkspace,
  rawPath: string,
): string {
  const path = normalizeGitPath(rawPath);
  if (
    path.length === 0 ||
    path === ".." ||
    path.startsWith("../") ||
    path.startsWith("/") ||
    path.includes("\0")
  ) {
    throw new Error("dependency_bootstrap_workspace_transaction_path_invalid");
  }
  workspaceEntryPath(workspace, path);
  return path;
}

function workspaceEntryPath(workspace: GitWorkspace, path: string): string {
  const absolutePath = resolve(workspace.rootPath, path);
  const relativeToWorkspace = relative(workspace.workspacePath, absolutePath);
  if (
    relativeToWorkspace === ".." ||
    relativeToWorkspace.startsWith(`..${sep}`) ||
    isAbsolute(relativeToWorkspace)
  ) {
    throw new Error("dependency_bootstrap_workspace_transaction_path_outside_scope");
  }
  return absolutePath;
}

function normalizeGitPath(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//, "");
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function gitRepositoryMissing(error: unknown): boolean {
  return error instanceof Error && /not a git repository/i.test(error.message);
}

function safeErrorMessage(error: unknown): string {
  if (hasErrorCode(error, ["EACCES", "EPERM", "EIO", "ENOENT", "ENOSPC", "EROFS", "ENOTDIR", "ELOOP"])) {
    return String((error as { code: string }).code);
  }
  if (typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "number" && Number.isInteger(error.code) && error.code >= 0 && error.code <= 255) {
    return `process_exit_${error.code}`;
  }
  return error instanceof Error && ["TypeError", "RangeError", "AbortError", "TimeoutError"].includes(error.name)
    ? error.name
    : "operation_failed";
}
