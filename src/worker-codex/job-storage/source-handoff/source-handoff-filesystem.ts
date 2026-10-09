import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import {
  SourceHandoffEntryKind as Kind, SourceHandoffFailure as Failure, SourceHandoffRoot as Root,
  sourceHandoffFail, type SourceHandoffDirectory, type SourceHandoffEntry,
} from "./source-handoff-contracts";

export const sourceHandoffLimits = Object.freeze({ entries: 100_000, bytes: 64 * 1024 ** 3, manifestBytes: 32 * 1024 ** 2 });
export const sourceHandoffDigest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export function sourceHandoffRelativePath(path: string): void {
  if (!path || Buffer.byteLength(path) > 4096 || isAbsolute(path) || /[\u0000-\u001f\u007f\\]/.test(path) ||
      path.split("/").some(part => !part || part === "." || part === "..")) sourceHandoffFail(Failure.Invalid);
}
export function sourceHandoffId(id: string): void {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === "." || id === "..") sourceHandoffFail(Failure.Invalid);
}
export async function assertSourceHandoffDirectory(expected: SourceHandoffDirectory): Promise<void> {
  if (!isAbsolute(expected.path) || resolve(expected.path) !== expected.path || expected.path === "/") sourceHandoffFail(Failure.Destination);
  const actual = await lstat(expected.path);
  if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== expected.device || actual.ino !== expected.inode ||
      actual.uid !== expected.uid || actual.uid !== process.getuid?.() || (actual.mode & 0o077) ||
      await realpath(expected.path) !== expected.path) sourceHandoffFail(Failure.Destination);
}
export async function sourceHandoffDirectory(path: string): Promise<SourceHandoffDirectory> {
  const stat = await lstat(path);
  const directory = Object.freeze({ path, device: stat.dev, inode: stat.ino, uid: stat.uid });
  await assertSourceHandoffDirectory(directory);
  return directory;
}
export function sourceHandoffRootsDisjoint(paths: readonly string[]): void {
  for (let left = 0; left < paths.length; left++) for (let right = left + 1; right < paths.length; right++) {
    const a = relative(paths[left]!, paths[right]!), b = relative(paths[right]!, paths[left]!);
    if (!a || (!a.startsWith("../") && !isAbsolute(a)) || (!b.startsWith("../") && !isAbsolute(b))) sourceHandoffFail(Failure.Destination);
  }
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size &&
    a.nlink === b.nlink && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
export async function withSourceHandoffFile<T>(path: string, expectedDevice: number,
  effect: (file: FileHandle, metadata: Stats) => Promise<T>): Promise<T> {
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.dev !== expectedDevice) sourceHandoffFail(Failure.Unsupported);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameFile(before, await file.stat())) sourceHandoffFail(Failure.Changed);
    const result = await effect(file, before);
    if (!sameFile(before, await file.stat()) || !sameFile(before, await lstat(path))) sourceHandoffFail(Failure.Changed);
    return result;
  } finally { await file.close(); }
}
export async function* sourceHandoffFileChunks(file: FileHandle, size: number): AsyncGenerator<Buffer> {
  let position = 0;
  while (position < size) {
    const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, size - position));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (!bytesRead) sourceHandoffFail(Failure.Changed);
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}
export async function inventorySourceHandoff(roots: Readonly<Record<Root, SourceHandoffDirectory>>,
  assertCurrent: () => void): Promise<readonly SourceHandoffEntry[]> {
  const entries: SourceHandoffEntry[] = [];
  let totalBytes = 0;
  const scan = async (root: SourceHandoffDirectory, path: string, name: string): Promise<void> => {
    assertCurrent();
    sourceHandoffRelativePath(name);
    const stat = await lstat(path);
    if (stat.dev !== root.device || stat.uid !== root.uid || stat.isSymbolicLink() ||
        (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) sourceHandoffFail(Failure.Unsupported);
    if (entries.length >= sourceHandoffLimits.entries) sourceHandoffFail(Failure.Bounds);
    if (name.startsWith("workspace/.git/") && (name.endsWith(".lock") || name.includes("/alternates") ||
        name.endsWith("/http-alternates") || name === "workspace/.git/commondir" || name === "workspace/.git/shallow" ||
        name.startsWith("workspace/.git/modules/") || name.startsWith("workspace/.git/lfs/"))) sourceHandoffFail(Failure.Unsupported);
    if (name.endsWith("/.git") && name !== "workspace/.git") sourceHandoffFail(Failure.Unsupported);
    if (stat.isDirectory()) {
      entries.push({ path: name, kind: Kind.Directory, mode: stat.mode & 0o777, size: 0, sha256: sourceHandoffDigest("") });
      for (const child of (await readdir(path)).sort()) await scan(root, join(path, child), `${name}/${child}`);
    } else {
      totalBytes += stat.size;
      if (totalBytes > sourceHandoffLimits.bytes) sourceHandoffFail(Failure.Bounds);
      const sha256 = await withSourceHandoffFile(path, root.device, async (file, metadata) => {
        const hash = createHash("sha256");
        for await (const chunk of sourceHandoffFileChunks(file, metadata.size)) { assertCurrent(); hash.update(chunk); }
        return hash.digest("hex");
      });
      entries.push({ path: name, kind: Kind.File, mode: stat.mode & 0o777, size: stat.size, sha256 });
    }
  };
  for (const name of [Root.Workspace, Root.Output, Root.Evidence]) {
    await assertSourceHandoffDirectory(roots[name]);
    await scan(roots[name], roots[name].path, name);
    await assertSourceHandoffDirectory(roots[name]);
  }
  return Object.freeze(entries.map(entry => Object.freeze(entry)));
}
export function handoffFacetDigest(entries: readonly SourceHandoffEntry[], root: Root): string {
  return sourceHandoffDigest(JSON.stringify(entries.filter(entry => entry.path === root || entry.path.startsWith(`${root}/`))));
}

export function assertSourceHandoffArtifacts(entries: readonly SourceHandoffEntry[],
  required: Readonly<Record<Root.Output | Root.Evidence, readonly string[]>>): void {
  for (const root of [Root.Output, Root.Evidence] as const) {
    if (!required || !Array.isArray(required[root]) || !required[root].length || required[root].length > 128) sourceHandoffFail(Failure.Unsupported);
    for (const path of required[root]) {
      sourceHandoffRelativePath(path);
      if (!entries.some(entry => entry.path === `${root}/${path}` && entry.kind === Kind.File)) sourceHandoffFail(Failure.Unsupported);
    }
  }
}
