import { readFile, stat } from "node:fs/promises";

type Entry = {
  readonly signature: string;
  readonly bytes: number;
  readonly records: readonly unknown[];
};

/** Disposable read acceleration only. Files remain authoritative, including
 * cross-process writes/replacements; domain state and lease time are never cached.
 * Limits bound retained payload bytes and entry overhead, not readable history.
 */
export class ValidatedHistoryCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(
    private readonly maxFiles = 4_096,
    private readonly maxBytes = 16 * 1_024 * 1_024,
  ) {}

  async read<T>(path: string, parse: (text: string) => readonly T[]): Promise<readonly T[]> {
    try {
      const before = await fileSignature(path);
      const cached = this.entries.get(path);
      if (cached?.signature === before) {
        this.entries.delete(path);
        this.entries.set(path, cached);
        // Callers historically received freshly parsed mutable objects and Dates.
        return structuredClone(cached.records) as readonly T[];
      }
      this.forget(path);
      const text = await readFile(path, "utf8");
      const records = parse(text);
      const after = await fileSignature(path);
      const bytes = Buffer.byteLength(text);
      if (before === after && bytes <= this.maxBytes) {
        // Awaiting IO allows concurrent readers; replace any intervening entry.
        this.forget(path);
        while (this.entries.size >= this.maxFiles || this.bytes + bytes > this.maxBytes) {
          const oldest = this.entries.keys().next().value;
          if (oldest === undefined) break;
          this.forget(oldest);
        }
        this.entries.set(path, { signature: after, bytes, records });
        this.bytes += bytes;
        return structuredClone(records);
      }
      return records;
    } catch {
      this.forget(path);
      // Preserve tolerant missing/corrupt-file behavior without caching failures.
      return [];
    }
  }

  private forget(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(path);
  }
}

async function fileSignature(path: string): Promise<string> {
  const value = await stat(path, { bigint: true });
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
}
