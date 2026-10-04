import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readFile, statfs, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DependencyTreeObservationFailure as Failure, DependencyTreeObservationStatus as Status } from "../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import type { DependencyTreeIdentity } from "../../worker-core/dependency-environment/domain/dependency-receipt";

export type DependencyPinnedFileObservation =
  | { readonly status: Status.Complete; readonly identity: DependencyTreeIdentity; readonly mountId: string;
      readonly sha256: string; readonly size: string }
  | { readonly status: Status.Incomplete; readonly reason: Failure };
class FileObservationError extends Error { constructor(readonly reason: Failure) { super(reason); } }
function fail(reason: Failure): never { throw new FileObservationError(reason); }
const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
  a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const child = (handle: FileHandle, name: string): string => `/proc/self/fd/${handle.fd}/${name}`;
async function mount(handle: FileHandle): Promise<string> {
  const info = await readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8");
  const id = /^mnt_id:\s*(\d+)\s*$/m.exec(info)?.[1];
  if (!id || info.length > 65536) fail(Failure.UnsafeNamespace);
  return id;
}

/** Exact-byte tool pin through retained, no-follow ancestors. Paths must be
 * actual canonical files, not aliases. Supplied bounds are qualification policy.
 */
export async function observeDependencyPinnedFile(input: {
  readonly path: string; readonly maxBytes: number; readonly maxDurationMs: number;
}): Promise<DependencyPinnedFileObservation> {
  const retained: { handle: FileHandle; info: BigIntStats; mountId: string; parent?: FileHandle; name?: string }[] = [];
  try {
    if (process.platform !== "linux") fail(Failure.UnsupportedPlatform);
    if (!isAbsolute(input.path) || resolve(input.path) !== input.path || input.path.includes("\0") ||
        input.path.length > 4096 || Buffer.from(input.path).toString() !== input.path ||
        ![input.maxBytes, input.maxDurationMs].every((n) => Number.isSafeInteger(n) && n > 0)) fail(Failure.InvalidRequest);
    if ((await statfs("/proc/self/fd", { bigint: true })).type !== 0x9fa0n) fail(Failure.UnsupportedPlatform);
    const start = performance.now();
    const check = (): void => { if (performance.now() - start > input.maxDurationMs) fail(Failure.Bounds); };
    const retain = async (path: string, parent?: FileHandle, name?: string): Promise<FileHandle> => {
      const handle = await open(path, flags);
      try {
        retained.push({ handle, info: await handle.stat({ bigint: true }), mountId: await mount(handle),
          ...(parent ? { parent } : {}), ...(name ? { name } : {}) });
        return handle;
      } catch (error) { await handle.close(); throw error; }
    };
    const root = await retain("/");
    const parts = input.path.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) fail(Failure.InvalidRequest);
    let parent = root;
    for (const part of parts) {
      check();
      parent = await retain(child(parent, part), parent, part);
    }
    const path = child(parent, name);
    const observed = await lstat(path, { bigint: true });
    if (!observed.isFile()) fail(Failure.SpecialFile);
    if (observed.nlink !== 1n) fail(Failure.Hardlink);
    if (observed.size > BigInt(input.maxBytes)) fail(Failure.Bounds);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat({ bigint: true });
      if (!same(observed, info)) fail(Failure.Unstable);
      const mountId = await mount(file);
      if (mountId !== retained[retained.length - 1]!.mountId) fail(Failure.MountCrossing);
      const digest = createHash("sha256");
      const bytes = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < Number(info.size)) {
        check();
        const { bytesRead } = await file.read(bytes, 0, Math.min(bytes.length, Number(info.size) - offset), offset);
        if (!bytesRead) fail(Failure.Unstable);
        digest.update(bytes.subarray(0, bytesRead)); offset += bytesRead;
      }
      if ((await file.read(bytes, 0, 1, offset)).bytesRead || !same(info, await file.stat({ bigint: true })) ||
          !same(info, await lstat(path, { bigint: true }))) fail(Failure.Unstable);
      const verify = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!same(info, await verify.stat({ bigint: true }))) fail(Failure.IdentityChanged);
        if (await mount(verify) !== mountId) fail(Failure.MountCrossing);
      } finally { await verify.close(); }
      for (const anchor of retained) {
        check();
        const current = await anchor.handle.stat({ bigint: true });
        if (current.dev !== anchor.info.dev || current.ino !== anchor.info.ino || current.mode !== anchor.info.mode) fail(Failure.IdentityChanged);
        if (await mount(anchor.handle) !== anchor.mountId) fail(Failure.MountCrossing);
        if (anchor.parent && anchor.name) {
          const verifyDirectory = await open(child(anchor.parent, anchor.name), flags);
          try {
            const value = await verifyDirectory.stat({ bigint: true });
            if (value.dev !== anchor.info.dev || value.ino !== anchor.info.ino || value.mode !== anchor.info.mode) fail(Failure.IdentityChanged);
            if (await mount(verifyDirectory) !== anchor.mountId) fail(Failure.MountCrossing);
          } finally { await verifyDirectory.close(); }
        }
      }
      check();
      return { status: Status.Complete, identity: { dev: String(info.dev), ino: String(info.ino) }, mountId,
        sha256: digest.digest("hex"), size: String(info.size) };
    } finally { await file.close(); }
  } catch (error) {
    return { status: Status.Incomplete, reason: error instanceof FileObservationError ? error.reason : Failure.Access };
  } finally {
    let closeFailed = false;
    for (const anchor of retained.reverse()) { try { await anchor.handle.close(); } catch { closeFailed = true; } }
    if (closeFailed) return { status: Status.Incomplete, reason: Failure.Access };
  }
}
