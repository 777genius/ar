import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
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
  const initial = await lstat(path);
  if (!initial.isFile() || initial.isSymbolicLink()) {
    throw new Error("consumed_output_evidence_file_invalid");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFile(initial, before)) {
      throw new Error("consumed_output_evidence_file_changed");
    }
    assertRetainedTerminalArchivePatchSize(before.size);
    const bytes = collect ? Buffer.allocUnsafe(before.size) : undefined;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const hash = createHash("sha256");
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(buffer, 0,
        Math.min(buffer.length, before.size - position), position);
      if (!bytesRead) throw new Error("consumed_output_evidence_file_truncated");
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      bytes?.set(chunk, position);
      position += bytesRead;
    }
    if (!sameFile(before, await handle.stat()) ||
        !sameFile(before, await lstat(path)) || canonical !== await realpath(path)) {
      throw new Error("consumed_output_evidence_file_changed");
    }
    return { size: before.size, sha256: hash.digest("hex"), ...(bytes ? { bytes } : {}) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function sameFile(a: Stats, b: Stats): boolean {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
