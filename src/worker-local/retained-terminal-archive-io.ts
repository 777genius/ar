import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { assertRetainedTerminalArchivePatchSize } from "@vioxen/subscription-runtime/worker-core";

/** Fixed-size descriptor reads; callers remain responsible for authorized roots. */
export async function inspectRetainedTerminalArchive(path: string, options: {
  readonly collect?: boolean;
  readonly expectedCanonicalPath?: string;
} = {}): Promise<{
  size: number; sha256: string; bytes?: Buffer;
}> {
  const { collect = false, expectedCanonicalPath } = options;
  const canonical = await realpath(path);
  if (expectedCanonicalPath !== undefined && canonical !== expectedCanonicalPath) {
    throw new Error("consumed_output_evidence_file_changed");
  }
  const initial = await lstat(path, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink()) {
    throw new Error("consumed_output_evidence_file_invalid");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFile(initial, before)) {
      throw new Error("consumed_output_evidence_file_changed");
    }
    const expectedSize = Number(before.size);
    assertRetainedTerminalArchivePatchSize(expectedSize);
    const first = await readDescriptorSnapshot(handle, expectedSize, false);
    await assertFileUnchanged(path, canonical, before, handle);
    const second = await readDescriptorSnapshot(handle, expectedSize, collect);
    await assertFileUnchanged(path, canonical, before, handle);
    if (first.sha256 !== second.sha256) {
      throw new Error("consumed_output_evidence_file_changed");
    }
    return { size: expectedSize, sha256: second.sha256,
      ...(second.bytes ? { bytes: second.bytes } : {}) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readDescriptorSnapshot(
  handle: FileHandle,
  expectedSize: number,
  collect: boolean,
): Promise<{ readonly sha256: string; readonly bytes?: Buffer }> {
  const bytes = collect ? Buffer.allocUnsafe(expectedSize) : undefined;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const hash = createHash("sha256");
  let position = 0;
  while (position < expectedSize) {
    const { bytesRead } = await handle.read(buffer, 0,
      Math.min(buffer.length, expectedSize - position), position);
    if (!bytesRead) throw new Error("consumed_output_evidence_file_truncated");
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    bytes?.set(chunk, position);
    position += bytesRead;
  }
  const overflow = await handle.read(buffer, 0, 1, expectedSize);
  if (overflow.bytesRead !== 0) {
    throw new Error("consumed_output_evidence_file_changed");
  }
  return { sha256: hash.digest("hex"), ...(bytes ? { bytes } : {}) };
}

async function assertFileUnchanged(
  path: string,
  canonical: string,
  expected: BigIntStats,
  handle: FileHandle,
): Promise<void> {
  if (!sameFile(expected, await handle.stat({ bigint: true })) ||
      !sameFile(expected, await lstat(path, { bigint: true })) ||
      canonical !== await realpath(path)) {
    throw new Error("consumed_output_evidence_file_changed");
  }
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
