import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, link, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import type { DependencyManifestBlobStore } from "@vioxen/subscription-runtime/worker-core";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const digestPattern = /^[a-f0-9]{64}$/;
const temporaryPattern = /^\.pending-[a-f0-9-]{36}$/;
const lockName = ".publication-lock";

export enum DependencyManifestStorageFailure {
  Unsupported = "unsupported",
  InvalidConfig = "invalid_config",
  UnsafeRoot = "unsafe_root",
  UnsafeStore = "unsafe_store",
  InvalidDigest = "invalid_digest",
  Corrupt = "corrupt",
  Quota = "quota",
  Busy = "busy",
  Closed = "closed",
}

export class DependencyManifestStorageError extends Error {
  constructor(readonly reason: DependencyManifestStorageFailure) {
    super(`dependency_manifest_storage:${reason}`);
  }
}

type StoreLimits = {
  readonly maxManifestBytes: number;
  readonly maxStoredBytes: number;
  readonly maxBlobs: number;
};

/** This constructor is for trusted composition, never worker JSON. The caller
 * must place this private root outside tool grants. File checks alone do not
 * establish that policy, nor make a blob an installation/eviction proof.
 * Publication is serialized across processes. A crashed publisher's lock is
 * deliberately retained: neither PID absence nor age authorizes its removal.
 */
export class LocalDependencyManifestBlobStore implements DependencyManifestBlobStore {
  private closing = false;
  private activeOperations = 0;
  private drained: (() => void) | undefined;
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly rootPath: string,
    private readonly root: FileHandle,
    private readonly rootIdentity: { readonly dev: bigint; readonly ino: bigint },
    private readonly limits: StoreLimits,
  ) {}

  static async open(input: StoreLimits & { readonly rootPath: string }): Promise<LocalDependencyManifestBlobStore> {
    if (process.platform !== "linux") fail(DependencyManifestStorageFailure.Unsupported);
    if (!isAbsolute(input.rootPath) || resolve(input.rootPath) !== input.rootPath ||
        ![input.maxManifestBytes, input.maxStoredBytes, input.maxBlobs].every((n) => Number.isSafeInteger(n) && n > 0)) {
      fail(DependencyManifestStorageFailure.InvalidConfig);
    }
    if (await realpath(input.rootPath) !== input.rootPath) fail(DependencyManifestStorageFailure.UnsafeRoot);
    const handle = await open(input.rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat({ bigint: true });
      const pathInfo = await lstat(input.rootPath, { bigint: true });
      if (!info.isDirectory() || (info.mode & 0o777n) !== 0o700n || info.uid !== BigInt(process.geteuid!()) ||
          info.dev !== pathInfo.dev || info.ino !== pathInfo.ino) fail(DependencyManifestStorageFailure.UnsafeRoot);
      return new LocalDependencyManifestBlobStore(input.rootPath, handle, { dev: info.dev, ino: info.ino }, input);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async put(canonicalManifestBytes: Uint8Array): Promise<string> {
    return this.withOperation(() => this.putActive(canonicalManifestBytes));
  }

  private async putActive(canonicalManifestBytes: Uint8Array): Promise<string> {
    if (canonicalManifestBytes.byteLength === 0 || canonicalManifestBytes.byteLength > this.limits.maxManifestBytes) fail(DependencyManifestStorageFailure.Quota);
    const bytes = Buffer.from(canonicalManifestBytes);
    const digest = hash(bytes);
    const compressed = await compress(bytes, { level: 9 });
    await this.assertRoot();
    const lockPath = this.path(lockName);
    let lock: FileHandle;
    try {
      lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (code(error, "EEXIST")) fail(DependencyManifestStorageFailure.Busy);
      throw error;
    }
    const lockIdentity = await lock.stat({ bigint: true });
    const temporary = this.path(`.pending-${randomUUID()}`);
    let temporaryCreated = false;
    try {
      await lock.writeFile(`${digest}\n`);
      await lock.sync();
      await this.root.sync();
      try {
        await this.getActive(digest);
        return digest;
      } catch (error) {
        if (!code(error, "ENOENT")) throw error;
      }
      await this.assertCapacity(compressed.length);
      const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temporaryCreated = true;
      try {
        await output.writeFile(compressed);
        await output.sync();
      } finally {
        await output.close();
      }
      await this.assertRoot();
      // link is exclusive publication; it never replaces an existing blob.
      await link(temporary, this.path(`${digest}.gz`));
      await unlink(temporary);
      temporaryCreated = false;
      await this.root.sync();
      await this.getActive(digest);
      return digest;
    } finally {
      try {
        if (temporaryCreated) await unlink(temporary);
      } finally {
        await lock.close();
        const current = await lstat(lockPath, { bigint: true });
        if (current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino || !current.isFile()) {
          fail(DependencyManifestStorageFailure.UnsafeStore);
        }
        await unlink(lockPath);
        await this.root.sync();
      }
    }
  }

  async get(contentDigest: string): Promise<Uint8Array> {
    return this.withOperation(() => this.getActive(contentDigest));
  }

  private async getActive(contentDigest: string): Promise<Uint8Array> {
    if (!digestPattern.test(contentDigest)) fail(DependencyManifestStorageFailure.InvalidDigest);
    await this.assertRoot();
    const observed = await lstat(this.path(`${contentDigest}.gz`), { bigint: true });
    if (!observed.isFile()) fail(DependencyManifestStorageFailure.Corrupt);
    let handle: FileHandle;
    try {
      // Nonblocking open also rejects a FIFO substituted after the lstat veto.
      handle = await open(this.path(`${contentDigest}.gz`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (code(error, "ELOOP")) fail(DependencyManifestStorageFailure.Corrupt);
      throw error;
    }
    try {
      const before = await handle.stat({ bigint: true });
      const compressedBound = Math.min(this.limits.maxStoredBytes, this.limits.maxManifestBytes * 2 + 1024);
      if (!before.isFile() || before.dev !== observed.dev || before.ino !== observed.ino ||
          before.nlink !== 1n || before.dev !== this.rootIdentity.dev || before.uid !== BigInt(process.geteuid!()) ||
          (before.mode & 0o777n) !== 0o600n || before.size > BigInt(compressedBound)) fail(DependencyManifestStorageFailure.Corrupt);
      const compressed = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < compressed.length) {
        const read = await handle.read(compressed, offset, compressed.length - offset, offset);
        if (read.bytesRead === 0) fail(DependencyManifestStorageFailure.Corrupt);
        offset += read.bytesRead;
      }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
      if (extra.bytesRead !== 0) fail(DependencyManifestStorageFailure.Corrupt);
      const after = await handle.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n || compressed.length !== Number(before.size)) {
        fail(DependencyManifestStorageFailure.Corrupt);
      }
      let bytes: Buffer;
      try {
        bytes = await decompress(compressed, { maxOutputLength: this.limits.maxManifestBytes });
      } catch {
        fail(DependencyManifestStorageFailure.Corrupt);
      }
      if (bytes.length === 0 || hash(bytes) !== contentDigest) fail(DependencyManifestStorageFailure.Corrupt);
      await this.assertRoot();
      return bytes;
    } finally {
      await handle.close();
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeAfterDraining();
    return this.closePromise;
  }

  private async closeAfterDraining(): Promise<void> {
    // Keep the /proc/self/fd anchor alive through every operation's cleanup;
    // releasing it early permits unrelated opens to reuse its descriptor number.
    if (this.activeOperations > 0) await new Promise<void>((resolve) => { this.drained = resolve; });
    await this.root.close();
  }

  private async withOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) fail(DependencyManifestStorageFailure.Closed);
    this.activeOperations++;
    try {
      return await operation();
    } finally {
      this.activeOperations--;
      if (this.activeOperations === 0) this.drained?.();
    }
  }

  private path(name: string): string {
    return join(`/proc/self/fd/${this.root.fd}`, name);
  }

  private async assertRoot(): Promise<void> {
    const info = await lstat(this.rootPath, { bigint: true });
    if (!info.isDirectory() || info.dev !== this.rootIdentity.dev || info.ino !== this.rootIdentity.ino ||
        (info.mode & 0o777n) !== 0o700n || info.uid !== BigInt(process.geteuid!())) fail(DependencyManifestStorageFailure.UnsafeRoot);
    if (await realpath(this.rootPath) !== this.rootPath) fail(DependencyManifestStorageFailure.UnsafeRoot);
  }

  private async assertCapacity(additionalBytes: number): Promise<void> {
    // Latin-1 preserves each filename byte while permitting streaming iteration.
    // Decode only after checking an exact UTF-8 round trip; reject unknown names.
    const entries = await opendir(this.path("."), { encoding: "latin1", bufferSize: 32 });
    let bytes = 0n;
    let blobs = 0;
    for await (const entry of entries) {
      const raw = Buffer.from(entry.name, "latin1");
      const name = raw.toString("utf8");
      if (!Buffer.from(name, "utf8").equals(raw)) fail(DependencyManifestStorageFailure.UnsafeStore);
      if (name === lockName) continue;
      if (!/^[a-f0-9]{64}\.gz$/.test(name) && !temporaryPattern.test(name)) fail(DependencyManifestStorageFailure.UnsafeStore);
      const info = await lstat(this.path(name), { bigint: true });
      if (!info.isFile() || info.dev !== this.rootIdentity.dev || info.uid !== BigInt(process.geteuid!()) ||
          (info.mode & 0o777n) !== 0o600n) fail(DependencyManifestStorageFailure.UnsafeStore);
      bytes += info.size;
      blobs++;
      if (blobs >= this.limits.maxBlobs || bytes + BigInt(additionalBytes) > BigInt(this.limits.maxStoredBytes)) {
        fail(DependencyManifestStorageFailure.Quota);
      }
    }
    if (bytes + BigInt(additionalBytes) > BigInt(this.limits.maxStoredBytes)) fail(DependencyManifestStorageFailure.Quota);
  }
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function code(error: unknown, expected: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === expected;
}

function fail(reason: DependencyManifestStorageFailure): never {
  throw new DependencyManifestStorageError(reason);
}
