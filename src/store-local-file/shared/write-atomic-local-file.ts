import { randomBytes } from "node:crypto";
import { link, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** Publish a complete record and sync it before acknowledging a custody write. */
export async function writeAtomicLocalFile(path: string, serialized: string, exclusive = false): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const file = await open(tempPath, "wx", 0o600);
    try {
      await file.writeFile(serialized);
      await file.sync();
    } finally {
      await file.close();
    }
    if (exclusive) await link(tempPath, path);
    else await rename(tempPath, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); }
    finally { await directory.close(); }
  } finally {
    await rm(tempPath, { force: true });
  }
}
