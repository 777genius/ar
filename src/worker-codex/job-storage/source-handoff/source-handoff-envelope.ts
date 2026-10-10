import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  SourceHandoffEntryKind as Kind, SourceHandoffFailure as Failure, SourceHandoffRoot as Root,
  sourceHandoffFail, type SourceHandoffDirectory, type SourceHandoffManifest,
} from "./source-handoff-contracts";
import {
  assertSourceHandoffArtifacts, assertSourceHandoffDirectory, sourceHandoffDigest, sourceHandoffFileChunks, sourceHandoffId,
  sourceHandoffLimits, sourceHandoffRelativePath, withSourceHandoffFile,
} from "./source-handoff-filesystem";

// Same AEAD/key/nonce/tag contract as existing encrypted session custody. No
// plaintext archive, new crypto library or credential/key file is created.
const magic = Buffer.from("SR-SOURCE-HANDOFF\0"), nonceBytes = 12, tagBytes = 16;
async function writeAll(file: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) sourceHandoffFail(Failure.Destination);
    offset += bytesWritten;
  }
}
function keyCopy(key: Uint8Array): Buffer {
  if (key.byteLength !== 32) sourceHandoffFail(Failure.Invalid);
  return Buffer.from(key);
}
export async function captureEncryptedSourceHandoff(input: {
  readonly roots: Readonly<Record<Root, SourceHandoffDirectory>>; readonly destination: SourceHandoffDirectory;
  readonly handoffId: string; readonly manifest: SourceHandoffManifest; readonly key: Uint8Array;
  readonly binding: string; readonly assertCurrent: () => void;
}): Promise<{ readonly envelopeSha256: string; readonly envelopeBytes: number }> {
  sourceHandoffId(input.handoffId);
  await assertSourceHandoffDirectory(input.destination);
  const manifestBytes = Buffer.from(JSON.stringify(input.manifest));
  if (manifestBytes.length > sourceHandoffLimits.manifestBytes) sourceHandoffFail(Failure.Bounds);
  const nonce = randomBytes(nonceBytes), key = keyCopy(input.key);
  const finalPath = join(input.destination.path, `${input.handoffId}.source.aead`);
  const temporary = join(input.destination.path, `.${input.handoffId}.${randomBytes(12).toString("hex")}.pending`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const hash = createHash("sha256");
  let bytesWritten = 0;
  const emit = async (bytes: Buffer): Promise<void> => {
    input.assertCurrent();
    await assertSourceHandoffDirectory(input.destination);
    await writeAll(file, bytes); hash.update(bytes); bytesWritten += bytes.length;
  };
  try {
    if ((await file.stat()).dev !== input.destination.device) sourceHandoffFail(Failure.Destination);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: tagBytes });
    cipher.setAAD(Buffer.from(input.binding));
    await emit(Buffer.concat([magic, nonce]));
    const length = Buffer.alloc(4); length.writeUInt32BE(manifestBytes.length);
    await emit(cipher.update(length)); await emit(cipher.update(manifestBytes));
    for (const entry of input.manifest.entries) {
      if (entry.kind !== Kind.File) continue;
      const rootName = entry.path.split("/")[0] as Root, root = input.roots[rootName];
      await assertSourceHandoffDirectory(root);
      const path = join(root.path, entry.path.slice(rootName.length + 1));
      await withSourceHandoffFile(path, root.device, async (source, metadata) => {
        if (metadata.size !== entry.size || (metadata.mode & 0o777) !== entry.mode) sourceHandoffFail(Failure.Changed);
        const content = createHash("sha256");
        for await (const chunk of sourceHandoffFileChunks(source, entry.size)) { content.update(chunk); await emit(cipher.update(chunk)); }
        if (content.digest("hex") !== entry.sha256) sourceHandoffFail(Failure.Changed);
      });
    }
    await emit(cipher.final()); await emit(cipher.getAuthTag());
    await file.sync();
    input.assertCurrent(); await assertSourceHandoffDirectory(input.destination);
    // Exclusive publication; never overwrite an old/uncertain handoff.
    await link(temporary, finalPath);
    // Make the single-link publication durable, not the temporary alias.
    await unlink(temporary);
    const parent = await open(input.destination.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
    return { envelopeSha256: hash.digest("hex"), envelopeBytes: bytesWritten };
  } finally {
    key.fill(0); await file.close();
    // Only the random ciphertext leaf exclusively created by this operation.
    await unlink(temporary).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
}
async function* plaintext(input: ReadbackInput): AsyncGenerator<Buffer> {
  const key = keyCopy(input.key);
  try {
    await assertSourceHandoffDirectory(input.destination);
    const path = join(input.destination.path, `${input.handoffId}.source.aead`);
    // The handle must outlive the generator, so use an explicit no-follow fd.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || before.dev !== input.destination.device || before.uid !== input.destination.uid ||
          (before.mode & 0o077) || before.size !== input.envelopeBytes || before.size > sourceHandoffLimits.bytes + sourceHandoffLimits.manifestBytes + 128) sourceHandoffFail(Failure.Invalid);
      const header = Buffer.alloc(magic.length + nonceBytes), tag = Buffer.alloc(tagBytes);
      if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length || !header.subarray(0, magic.length).equals(magic) ||
          (await file.read(tag, 0, tagBytes, before.size - tagBytes)).bytesRead !== tagBytes) sourceHandoffFail(Failure.Invalid);
      const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(magic.length), { authTagLength: tagBytes });
      decipher.setAAD(Buffer.from(input.binding)); decipher.setAuthTag(tag);
      const hash = createHash("sha256"); hash.update(header);
      let offset = header.length;
      while (offset < before.size - tagBytes) {
        input.assertCurrent();
        const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, before.size - tagBytes - offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) sourceHandoffFail(Failure.Authentication);
        const bytes = buffer.subarray(0, bytesRead); offset += bytesRead; hash.update(bytes);
        yield decipher.update(bytes);
      }
      hash.update(tag);
      const final = decipher.final();
      if (hash.digest("hex") !== input.envelopeSha256) sourceHandoffFail(Failure.Authentication);
      const after = await file.stat();
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) sourceHandoffFail(Failure.Changed);
      input.assertCurrent(); await assertSourceHandoffDirectory(input.destination);
      if (final.length) yield final;
    } finally { await file.close(); }
  } catch { sourceHandoffFail(Failure.Authentication); }
  finally { key.fill(0); }
}
export type ReadbackInput = {
  readonly destination: SourceHandoffDirectory; readonly handoffId: string; readonly key: Uint8Array;
  readonly binding: string; readonly envelopeSha256: string; readonly envelopeBytes: number;
  readonly assertCurrent: () => void;
};
class PlainReader {
  private remainder: Buffer = Buffer.alloc(0);
  constructor(private readonly chunks: AsyncIterator<Buffer>) {}
  async read(size: number): Promise<Buffer> {
    const pieces: Buffer[] = []; let remaining = size;
    while (remaining) {
      if (!this.remainder.length) {
        const next = await this.chunks.next();
        if (next.done) sourceHandoffFail(Failure.Invalid);
        this.remainder = next.value;
        if (!this.remainder.length) continue;
      }
      const length = Math.min(remaining, this.remainder.length);
      pieces.push(this.remainder.subarray(0, length)); this.remainder = this.remainder.subarray(length); remaining -= length;
    }
    return Buffer.concat(pieces, size);
  }
  async end(): Promise<void> {
    if (this.remainder.length) sourceHandoffFail(Failure.Invalid);
    let next = await this.chunks.next();
    while (!next.done && !next.value.length) next = await this.chunks.next();
    if (!next.done) sourceHandoffFail(Failure.Invalid);
  }
}
function validateManifest(value: unknown): SourceHandoffManifest {
  const manifest = value as SourceHandoffManifest;
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries) || !/^[a-f0-9]{64}$/.test(manifest.gitFactsSha256) ||
      manifest.entries.length > sourceHandoffLimits.entries) sourceHandoffFail(Failure.Invalid);
  const known = new Set<string>(); let total = 0;
  for (const entry of manifest.entries) {
    sourceHandoffRelativePath(entry.path);
    if (![Root.Workspace, Root.Output, Root.Evidence].includes(entry.path.split("/")[0] as Root) || known.has(entry.path) ||
        (!Object.values(Root).includes(entry.path as Root) && !known.has(dirname(entry.path))) ||
        ![Kind.File, Kind.Directory].includes(entry.kind) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        (entry.kind === Kind.Directory && (entry.size !== 0 || entry.sha256 !== sourceHandoffDigest("")))) sourceHandoffFail(Failure.Invalid);
    known.add(entry.path); total += entry.size;
  }
  if (total > sourceHandoffLimits.bytes || Object.values(Root).some(root => !manifest.entries.some(entry => entry.path === root && entry.kind === Kind.Directory))) sourceHandoffFail(Failure.Invalid);
  assertSourceHandoffArtifacts(manifest.entries, manifest.requiredArtifacts);
  return manifest;
}
async function consume(input: ReadbackInput, restore?: string): Promise<SourceHandoffManifest> {
  const chunks = plaintext(input), reader = new PlainReader(chunks);
  try {
    const size = (await reader.read(4)).readUInt32BE();
    if (size > sourceHandoffLimits.manifestBytes) sourceHandoffFail(Failure.Bounds);
    const manifest = validateManifest(JSON.parse((await reader.read(size)).toString("utf8")) as unknown);
    for (const entry of manifest.entries) {
      input.assertCurrent();
      if (entry.kind === Kind.Directory) {
        if (restore) await mkdir(join(restore, entry.path), { mode: 0o700 });
        continue;
      }
      const file = restore ? await open(join(restore, entry.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) : undefined;
      try {
        const hash = createHash("sha256"); let remaining = entry.size;
        while (remaining) {
          const bytes = await reader.read(Math.min(256 * 1024, remaining)); remaining -= bytes.length;
          hash.update(bytes); if (file) await writeAll(file, bytes);
        }
        if (hash.digest("hex") !== entry.sha256) sourceHandoffFail(Failure.Authentication);
        if (file) { await file.chmod(entry.mode); await file.sync(); }
      } finally { await file?.close(); }
    }
    await reader.end();
    if (restore) for (const entry of [...manifest.entries].reverse()) if (entry.kind === Kind.Directory) {
      await chmod(join(restore, entry.path), entry.mode);
      const directory = await open(join(restore, entry.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return manifest;
  } finally { await chunks.return(undefined); }
}
/** Complete authentication/readback BEFORE plaintext restore effects. Both passes
 * are under the SAME native immutable-ciphertext custody/exclusion lease; it
 * excludes all path/content/FD-alias writers throughout authentication and restore.
 * Directory pinning alone is insufficient and grants no restore capability.
 * A failed restore remains protected, never activated or blindly removed. */
export async function restoreEncryptedSourceHandoff(input: ReadbackInput & {
  readonly restoreParent: SourceHandoffDirectory;
}): Promise<{ readonly manifest: SourceHandoffManifest; readonly restorePath: string }> {
  sourceHandoffId(input.handoffId);
  await consume(input);
  input.assertCurrent(); await assertSourceHandoffDirectory(input.restoreParent);
  const restorePath = join(input.restoreParent.path, `${input.handoffId}.${randomBytes(12).toString("hex")}.offline`);
  await mkdir(restorePath, { mode: 0o700 });
  const manifest = await consume(input, restorePath);
  input.assertCurrent(); await assertSourceHandoffDirectory(input.restoreParent);
  const parent = await open(input.restoreParent.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
  return { manifest, restorePath };
}
