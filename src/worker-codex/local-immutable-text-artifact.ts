import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function publishImmutableTextArtifact(input: {
  readonly path: string;
  readonly content: string;
  readonly existingPathUnsafeError: string;
  readonly contentMismatchError: string;
  readonly durable?: boolean;
}): Promise<{ readonly created: boolean }> {
  const parent = await lstat(dirname(input.path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(input.existingPathUnsafeError);
  }
  const tempPath = join(
    dirname(input.path),
    `.${basename(input.path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(tempPath, input.content, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  if (input.durable) {
    const file = await open(tempPath, "r");
    try { await file.sync(); } finally { await file.close(); }
  }
  let created = false;
  try {
    try {
      await link(tempPath, input.path);
      created = true;
      if (input.durable) await syncDirectory(dirname(input.path));
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const item = await lstat(input.path);
    if (item.isSymbolicLink() || !item.isFile()) {
      throw new Error(input.existingPathUnsafeError);
    }
    if ((await readFile(input.path, "utf8")) !== input.content) {
      throw new Error(input.contentMismatchError);
    }
    return { created };
  } finally {
    await unlink(tempPath).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
    if (input.durable) await syncDirectory(dirname(input.path));
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
