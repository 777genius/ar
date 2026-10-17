import {
  assertHeldLexicalFile,
  assertLocalProjectControlEvidenceCustodySupported,
  closeHeldLexicalFile,
  LocalProjectControlEvidenceCustody,
  openAbsoluteFileNoSymlinks,
} from "./project-control-evidence-custody-local-adapter";
import { deepCode } from "./project-control-evidence-custody-errors";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

/**
 * Metadata-only sibling of the held immutable read: size and permission bits come from a
 * descriptor opened through the same component-by-component, symlink-refusing, held-parent
 * chain, and the lexical binding is revalidated before returning. No body is read, so it is
 * the safe way to measure before a large allocation. The caller still reads through the
 * custody reader, which enforces its own byte cap, so a file that grows after this
 * measurement is caught there; this value is an admission estimate, not a read bound.
 */
export type HeldImmutableFileFacts = { readonly length: number; readonly mode: number; readonly uid: number };

export async function statHeldImmutableFile(path: string): Promise<HeldImmutableFileFacts> {
  assertLocalProjectControlEvidenceCustodySupported();
  const held = await openAbsoluteFileNoSymlinks(resolve(path));
  try {
    const before = await held.handle.stat();
    if (!before.isFile()) throw new Error("evidence_custody_file_invalid");
    await assertHeldLexicalFile(held, before, "evidence_custody_file_changed_during_read");
    return { length: before.size, mode: before.mode & 0o777, uid: before.uid };
  } finally {
    await closeHeldLexicalFile(held);
  }
}

/**
 * Read a small private file so that its metadata check and its bytes come from the SAME held final descriptor.
 * The descriptor is opened through the same component-by-component, symlink-refusing, held-parent chain as the
 * immutable reader; `check` sees that descriptor's uid, mode and size BEFORE any payload is read (a refusal throws
 * and no byte is ever buffered); the byte cap is enforced on the descriptor's size and while reading; the
 * descriptor's identity and metadata must be unchanged after the read; and the lexical binding is revalidated
 * before the descriptor is released. A path replaced between the metadata and the payload therefore either still
 * yields the checked inode's bytes and is refused by the final lexical revalidation, or is refused earlier.
 * `afterMetadata` is a fixture seam that runs between the check and the payload read.
 */
export async function readHeldImmutableFileChecked(
  path: string,
  maxBytes: number,
  check: (facts: HeldImmutableFileFacts) => void,
  afterMetadata?: () => Promise<void>,
): Promise<Buffer> {
  assertLocalProjectControlEvidenceCustodySupported();
  const held = await openAbsoluteFileNoSymlinks(resolve(path));
  try {
    const before = await held.handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error("evidence_custody_file_invalid");
    check({ length: before.size, mode: before.mode & 0o777, uid: before.uid });
    await afterMetadata?.();
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, maxBytes - length + 1));
      const { bytesRead } = await held.handle.read(chunk, 0, chunk.length, length);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
      if (length > maxBytes) throw new Error("evidence_custody_file_invalid");
    }
    const after = await held.handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || after.size !== length ||
        before.uid !== after.uid || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("evidence_custody_file_changed_during_read");
    }
    await assertHeldLexicalFile(held, before, "evidence_custody_file_changed_during_read");
    return Buffer.concat(chunks, length);
  } finally {
    await closeHeldLexicalFile(held);
  }
}

/**
 * Streaming SHA-256 of a held immutable file: the same component-safe, symlink-refusing descriptor, the same byte cap
 * and the same identity/metadata re-checks as the buffering readers, but at most one 1 MiB chunk is resident. Payload
 * verification (replay, admission) needs only the hash and exact length, so it never allocates the payload.
 */
export async function hashHeldImmutableFile(path: string, maxBytes: number):
  Promise<{ readonly sha256: string; readonly length: number; readonly mode: number }> {
  assertLocalProjectControlEvidenceCustodySupported();
  const held = await openAbsoluteFileNoSymlinks(resolve(path));
  try {
    const before = await held.handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error("evidence_custody_file_invalid");
    const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(1024 * 1024);
    let length = 0;
    for (;;) {
      const { bytesRead } = await held.handle.read(chunk, 0, Math.min(chunk.length, maxBytes - length + 1), length);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      length += bytesRead;
      if (length > maxBytes) throw new Error("evidence_custody_file_invalid");
    }
    const after = await held.handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || after.size !== length ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("evidence_custody_file_changed_during_read");
    await assertHeldLexicalFile(held, before, "evidence_custody_file_changed_during_read");
    return { sha256: hash.digest("hex"), length, mode: before.mode & 0o777 };
  } finally {
    await closeHeldLexicalFile(held);
  }
}

/** Like statHeldImmutableFile; a missing leaf is undefined only beneath a certified canonical parent. */
export async function statOptionalHeldImmutableFile(path: string): Promise<HeldImmutableFileFacts | undefined> {
  try {
    return await statHeldImmutableFile(path);
  } catch (error) {
    if (deepCode(error) !== "ENOENT") throw error;
    const custody = new LocalProjectControlEvidenceCustody();
    await custody.canonicalDirectory(dirname(resolve(path)));
    if (await custody.pathKind(path) !== "absent") throw error;
    return undefined;
  }
}
