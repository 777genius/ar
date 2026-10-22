import { lstat, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { code, custodyError } from "./project-control-evidence-custody-errors";

/**
 * Prove that `lexical` is absent using ONE held canonical parent descriptor. The leaf is probed with
 * lstat (never followed) relative to that descriptor; before returning, the held parent must still be
 * the canonical lexical parent (same device/inode as a fresh no-follow open, canonical /proc path
 * unchanged) and the leaf must still be absent. A missing, dangling or aliased parent (the open
 * throws), a symlink or newly appeared leaf, and a parent substituted at the boundary all refuse.
 */
export async function proveLeafAbsentUnderHeldParent(
  lexical: string,
  openDirectory: (path: string) => Promise<FileHandle>,
  cause: unknown,
  boundary: (lexical: string) => Promise<void>,
): Promise<void> {
  const dir = dirname(lexical);
  const parent = await openDirectory(dir);
  try {
    const absent = () => lstat(`/proc/self/fd/${parent.fd}/${basename(lexical)}`)
      .then(() => false, (probe: unknown) => code(probe) === "ENOENT");
    const unproven = () => custodyError("evidence_custody_absence_unproven", cause);
    if (!await absent()) throw unproven();
    await boundary(lexical);
    const identity = await parent.stat();
    const reopened = await openDirectory(dir).catch(() => { throw unproven(); });
    try {
      const current = await reopened.stat();
      if (current.dev !== identity.dev || current.ino !== identity.ino ||
        await realpath(`/proc/self/fd/${parent.fd}`) !== dir || !await absent()) throw unproven();
    } finally { await reopened.close(); }
  } finally { await parent.close(); }
}
