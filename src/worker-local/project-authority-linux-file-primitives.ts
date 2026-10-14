import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import {
  link, lstat, mkdir, open, readdir, realpath, rename, statfs, unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const FLOCK_BINARY = "/usr/bin/flock";
const PROC_FD = "/proc/self/fd";
const LOCK_NAME = ".authority-tuple.flock";
const TEMP_PATTERN = /^\.authority-tuple\.[0-9a-f-]{36}\.tmp$/;

type Identity = { readonly dev: bigint; readonly ino: bigint };
type HeldDirectory = {
  readonly lexicalPath: string;
  readonly handle: FileHandle;
  readonly identity: Identity;
};

export type AuthorityBoundary = {
  readonly root: HeldDirectory;
  readonly project: HeldDirectory;
};

export type LocalAuthorityFilesystemVerifier = (
  heldProjectDirectoryPath: string,
) => Promise<void>;

export type AuthorityLock = {
  readonly handle: FileHandle;
  readonly identity: Identity;
};

export enum LocalProjectAuthorityCrashPoint {
  AfterTempWrite = "after_temp_write",
  AfterTempFsync = "after_temp_fsync",
  AfterRenameBeforeDirectoryFsync = "after_rename_before_directory_fsync",
  AfterDirectoryFsync = "after_directory_fsync",
}

export async function openAuthorityBoundary(
  rootDir: string,
  projectId: string,
): Promise<AuthorityBoundary> {
  if (process.platform !== "linux" || !isAbsolute(rootDir) || resolve(rootDir) !== rootDir) {
    throw new Error("project_authority_linux_boundary_unavailable");
  }
  await assertProcfs();
  const root = await openPrivateLeaf(rootDir, true);
  try {
    const projectPath = join(rootDir, projectId);
    if (dirname(projectPath) !== rootDir) throw new Error("project_authority_path_outside_root");
    const project = await openPrivateChild(root, projectId, true);
    return { root, project };
  } catch (error) {
    await root.handle.close();
    throw error;
  }
}

export async function closeAuthorityBoundary(boundary: AuthorityBoundary): Promise<void> {
  await boundary.project.handle.close().catch(() => undefined);
  await boundary.root.handle.close().catch(() => undefined);
}

export async function acquireAuthorityLock(
  boundary: AuthorityBoundary,
  verifyLocalFilesystem: LocalAuthorityFilesystemVerifier,
): Promise<AuthorityLock> {
  await revalidateBoundary(boundary);
  await verifyLocalFilesystem(procPath(boundary.project.handle.fd));
  await assertTrustedFlock();
  const path = childPath(boundary.project, LOCK_NAME);
  const handle = await open(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  ).catch((cause) => {
    throw new Error("project_authority_lock_unavailable", { cause });
  });
  try {
    const metadata = await handle.stat({ bigint: true });
    assertPrivateRegular(metadata, "project_authority_lock_unsafe");
    await runFlock(handle.fd);
    const entry = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await entry.stat({ bigint: true });
      if (current.dev !== metadata.dev || current.ino !== metadata.ino) {
        throw new Error("project_authority_lock_identity_changed");
      }
      assertPrivateRegular(current, "project_authority_lock_unsafe");
    } finally {
      await entry.close();
    }
    await revalidateBoundary(boundary);
    return { handle, identity: { dev: metadata.dev, ino: metadata.ino } };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function releaseAuthorityLock(lock: AuthorityLock): Promise<void> {
  await lock.handle.close();
}

export async function revalidateAuthorityLock(
  boundary: AuthorityBoundary, lock: AuthorityLock,
): Promise<void> {
  const entry = await open(childPath(boundary.project, LOCK_NAME),
    constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await entry.stat({ bigint: true });
    assertPrivateRegular(metadata, "project_authority_lock_unsafe");
    if (metadata.dev !== lock.identity.dev || metadata.ino !== lock.identity.ino) {
      throw new Error("project_authority_lock_identity_changed");
    }
  } finally { await entry.close(); }
}

export async function readBoundedStable(
  directory: HeldDirectory,
  name: string,
  limit: number,
): Promise<Buffer | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(childPath(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new Error("project_authority_state_unreadable", { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertPrivateRegular(before, "project_authority_state_corrupt");
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!stableMetadata(before, after) || offset > limit || offset === 0 ||
        after.size !== BigInt(offset)) {
      throw new Error("project_authority_state_corrupt");
    }
    const entry = await open(childPath(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await entry.stat({ bigint: true });
      if (current.dev !== after.dev || current.ino !== after.ino) {
        throw new Error("project_authority_state_identity_changed");
      }
    } finally { await entry.close(); }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function publishAuthorityFile(input: {
  readonly boundary: AuthorityBoundary;
  readonly lock: AuthorityLock;
  readonly name: string;
  readonly body: Buffer;
  readonly noReplace: boolean;
  readonly crash?: (point: LocalProjectAuthorityCrashPoint) => Promise<void> | void;
}): Promise<"published" | "exists"> {
  await revalidateBoundary(input.boundary);
  const tempName = `.authority-tuple.${randomUUID()}.tmp`;
  const tempPath = childPath(input.boundary.project, tempName);
  const handle = await open(
    tempPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let tempExists = true;
  let simulatedCrash = false;
  const crash = async (point: Parameters<NonNullable<typeof input.crash>>[0]) => {
    try { await input.crash?.(point); } catch (error) { simulatedCrash = true; throw error; }
  };
  try {
    let written = 0;
    while (written < input.body.length) {
      const result = await handle.write(input.body, written, input.body.length - written, written);
      if (result.bytesWritten === 0) throw new Error("project_authority_state_write_failed");
      written += result.bytesWritten;
    }
    await crash(LocalProjectAuthorityCrashPoint.AfterTempWrite);
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    assertPrivateRegular(metadata, "project_authority_temp_unsafe");
    if (metadata.size !== BigInt(input.body.length)) {
      throw new Error("project_authority_state_write_failed");
    }
    await crash(LocalProjectAuthorityCrashPoint.AfterTempFsync);
    await handle.close();
    await revalidateBoundary(input.boundary);
    await revalidateAuthorityLock(input.boundary, input.lock);
    const target = childPath(input.boundary.project, input.name);
    if (input.noReplace) {
      try {
        await link(tempPath, target);
      } catch (error) {
        if (errorCode(error) === "EEXIST") return "exists";
        throw error;
      }
      await unlink(tempPath);
    } else {
      await rename(tempPath, target);
    }
    tempExists = false;
    await crash(LocalProjectAuthorityCrashPoint.AfterRenameBeforeDirectoryFsync);
    await revalidateBoundary(input.boundary);
    await input.boundary.project.handle.sync();
    await revalidateAuthorityLock(input.boundary, input.lock);
    await crash(LocalProjectAuthorityCrashPoint.AfterDirectoryFsync);
    await revalidateBoundary(input.boundary);
    return "published";
  } finally {
    await handle.close().catch(() => undefined);
    if (tempExists && !simulatedCrash) await unlink(tempPath).catch(() => undefined);
  }
}

export async function cleanupAuthorityTemps(boundary: AuthorityBoundary): Promise<void> {
  for (const name of await readdir(procPath(boundary.project.handle.fd))) {
    if (!TEMP_PATTERN.test(name)) continue;
    const path = childPath(boundary.project, name);
    let metadata;
    try {
      metadata = await lstat(path, { bigint: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isSymbolicLink() && metadata.isFile() &&
        metadata.uid === BigInt(process.geteuid!()) && (metadata.mode & 0o777n) === 0o600n) {
      await unlink(path);
    }
  }
  await boundary.project.handle.sync();
}

export async function revalidateBoundary(boundary: AuthorityBoundary): Promise<void> {
  await Promise.all([revalidateDirectory(boundary.root), revalidateDirectory(boundary.project)]);
  const rootEntry = await open(childPath(boundary.root, basename(boundary.project.lexicalPath)),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const metadata = await rootEntry.stat({ bigint: true });
    if (metadata.dev !== boundary.project.identity.dev || metadata.ino !== boundary.project.identity.ino) {
      throw new Error("project_authority_directory_identity_changed");
    }
  } finally {
    await rootEntry.close();
  }
}

async function openPrivateLeaf(path: string, create: boolean): Promise<HeldDirectory> {
  const parentPath = dirname(path);
  const parent = await openDirectoryChain(parentPath);
  try {
    return await openPrivateChild(parent, basename(path), create);
  } finally {
    await parent.handle.close();
  }
}

async function openPrivateChild(
  parent: HeldDirectory,
  name: string,
  create: boolean,
): Promise<HeldDirectory> {
  const lexicalPath = join(parent.lexicalPath, name);
  const path = childPath(parent, name);
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
      await parent.handle.sync();
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    .catch((cause) => { throw new Error("project_authority_path_outside_root", { cause }); });
  try {
    const metadata = await handle.stat({ bigint: true });
    assertPrivateDirectory(metadata);
    return { lexicalPath, handle, identity: { dev: metadata.dev, ino: metadata.ino } };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openDirectoryChain(path: string): Promise<HeldDirectory> {
  let currentPath: string = sep;
  let handle = await open(sep, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of resolve(path).split(sep).filter(Boolean)) {
      const nextPath = join(procPath(handle.fd), component);
      const next = await open(nextPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.close();
      handle = next;
      currentPath = join(currentPath, component);
    }
    const metadata = await handle.stat({ bigint: true });
    return { lexicalPath: currentPath, handle, identity: { dev: metadata.dev, ino: metadata.ino } };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function revalidateDirectory(directory: HeldDirectory): Promise<void> {
  const [held, lexical] = await Promise.all([
    directory.handle.stat({ bigint: true }),
    lstat(directory.lexicalPath, { bigint: true }),
  ]);
  if (!held.isDirectory() || lexical.isSymbolicLink() || !lexical.isDirectory() ||
      held.dev !== directory.identity.dev || held.ino !== directory.identity.ino ||
      lexical.dev !== directory.identity.dev || lexical.ino !== directory.identity.ino) {
    throw new Error("project_authority_directory_identity_changed");
  }
  assertPrivateDirectory(held);
}

function assertPrivateDirectory(metadata: BigIntStats): void {
  if (!metadata.isDirectory() || metadata.uid !== BigInt(process.geteuid!()) ||
      (metadata.mode & 0o777n) !== 0o700n) {
    throw new Error("project_authority_directory_not_private");
  }
}

function assertPrivateRegular(
  metadata: BigIntStats,
  error: string,
): void {
  if (!metadata.isFile() || metadata.uid !== BigInt(process.geteuid!()) ||
      (metadata.mode & 0o777n) !== 0o600n) throw new Error(error);
}

function stableMetadata(a: BigIntStats,
  b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function assertProcfs(): Promise<void> {
  const canonical = await realpath(PROC_FD).catch(() => "");
  if (!canonical.startsWith("/proc/")) throw new Error("project_authority_procfs_unavailable");
}

export async function certifyLocalAuthorityFilesystem(
  heldProjectDirectoryPath: string,
): Promise<void> {
  const metadata = await statfs(heldProjectDirectoryPath, { bigint: true })
    .catch((cause) => {
      throw new Error("project_authority_filesystem_uncertified", { cause });
    });
  const explicitlyCertifiedLocalTypes = new Set([
    0xef53n, // ext2/ext3/ext4
    0x58465342n, // XFS
    0x9123683en, // Btrfs
    0x01021994n, // tmpfs
    0x794c7630n, // overlayfs
  ]);
  if (!explicitlyCertifiedLocalTypes.has(metadata.type)) {
    throw new Error("project_authority_filesystem_uncertified");
  }
}

async function assertTrustedFlock(): Promise<void> {
  const [canonical, metadata] = await Promise.all([
    realpath(FLOCK_BINARY).catch(() => ""), lstat(FLOCK_BINARY).catch(() => undefined),
  ]);
  if (canonical !== FLOCK_BINARY || !metadata?.isFile() || metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0) throw new Error("project_authority_flock_untrusted");
}

async function runFlock(fd: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(FLOCK_BINARY, ["--exclusive", "3"], {
      stdio: ["ignore", "ignore", "pipe", fd],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk).slice(0, 512); });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`project_authority_flock_failed:${code ?? signal}:${stderr}`)));
  });
}

function procPath(fd: number): string { return join(PROC_FD, String(fd)); }
function childPath(directory: HeldDirectory, name: string): string {
  if (basename(name) !== name || name === "." || name === "..") {
    throw new Error("project_authority_child_name_invalid");
  }
  return join(procPath(directory.handle.fd), name);
}
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code) : undefined;
}
