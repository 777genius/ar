import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function assertJsonRecordsTerminal(
  root: string,
  fileName: string,
  terminal: ReadonlySet<string>,
  errorCode: string,
  quarantinedIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(errorCode);
    const value: unknown = JSON.parse(
      await readFile(join(root, entry.name, fileName), "utf8"),
    );
    if (!isRecord(value) || typeof value.status !== "string" ||
      (!terminal.has(value.status) &&
        (typeof value.attemptId !== "string" || !quarantinedIds.has(value.attemptId)))) {
      throw new Error(errorCode);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
