import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type Dirent, type Stats } from "node:fs";
import { join } from "node:path";

export type InspectedLegacyAccountRecord = Readonly<{ accountId: string; demandKey: string | null; restrictive: boolean }>;

/** Read-only compatibility fence. Unknown or changing legacy state is never availability. */
export function assertNoRestrictiveLegacyAccountRecords(
  rootDir: string,
  prefixes: readonly string[],
  inspect: (value: unknown, recordPath: string, claim: boolean) => InspectedLegacyAccountRecord | null,
): void {
  if (prefixes.length === 0) return;
  if (readLegacyAccountCapacityRecords(rootDir, inspect).some(record => record.restrictive && prefixes.some(prefix => record.accountId.startsWith(prefix))))
    throw new Error("worker_account_capacity_legacy_identity_unresolved");
}

export type LegacyAccountCapacityRecord = InspectedLegacyAccountRecord & Readonly<{ path: string; sha256: string; custodySha256: string; value: unknown; claim: boolean }>;

/** Custody-checked immutable projection; it grants no dispatch or availability. */
export function readLegacyAccountCapacityRecords(
  rootDir: string,
  inspect: (value: unknown, recordPath: string, claim: boolean) => InspectedLegacyAccountRecord | null,
): readonly LegacyAccountCapacityRecord[] {
  const records: LegacyAccountCapacityRecord[] = [];
  const fail = (): never => { throw new Error("worker_account_capacity_legacy_identity_unresolved"); };
  const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
  let remainingEntries = 4096, remainingBytes = 8 * 1024 * 1024;
  const same = (a: Stats, b: Stats): boolean =>
    (["dev", "ino", "mode", "uid", "gid", "nlink", "size", "ctimeMs", "mtimeMs"] as const)
      .every(key => a[key] === b[key]);
  const missing = (error: unknown): boolean =>
    error instanceof Error && "code" in error && error.code === "ENOENT";
  let root: number;
  try { root = openSync(rootDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) { if (missing(error)) return records; fail(); }
  try {
    const rootBefore = fstatSync(root!);
    const check = (path: string, fd: number, before: Stats): void => {
      if (!same(before, fstatSync(fd)) || !same(before, lstatSync(path)) ||
          before.uid !== rootBefore.uid || (before.mode & 0o022) !== 0) fail();
    };
    check(rootDir, root!, rootBefore);
    const visit = (path: string, accountHash: string | null, legacy: boolean): void => {
      let directory: number;
      try { directory = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (error) { if (missing(error) && accountHash === null) return; fail(); }
      try {
        const before = fstatSync(directory!);
        check(path, directory!, before);
        const entries: Dirent[] = [], listing = opendirSync(path, { bufferSize: 1 });
        try {
          for (let entry = listing.readSync(); entry; entry = listing.readSync()) {
            if (--remainingEntries < 0) fail();
            entries.push(entry);
          }
        } finally { listing.closeSync(); }
        const names = new Set(entries.map(entry => entry.name));
        for (const entry of entries) {
          const leaf = join(path, entry.name);
          if (!legacy && accountHash === null) {
            if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) fail();
            visit(leaf, entry.name, false);
            continue;
          }
          // Only validated record-bound claims are known sidecars; locks/temporary state remain uncertain.
          const claim = entry.name.endsWith(".recheck-claim.json");
          const recordName = claim ? entry.name.slice(0, -".recheck-claim.json".length) : entry.name;
          if (claim && !names.has(recordName)) fail();
          if (!entry.isFile() || !(legacy ? /^[a-f0-9]{64}$/ : /^(?:account|[a-f0-9]{64})\.json$/).test(recordName)) fail();
          const file = openSync(leaf, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const fileBefore = fstatSync(file);
            if (!fileBefore.isFile() || fileBefore.nlink !== 1 || fileBefore.size > 64 * 1024) fail();
            check(leaf, file, fileBefore);
            remainingBytes -= fileBefore.size;
            if (remainingBytes < 0) fail();
            const bytes = Buffer.alloc(64 * 1024 + 1);
            let count = 0, read: number;
            while (count < bytes.length && (read = readSync(file, bytes, count, bytes.length - count, count)) > 0) count += read;
            if (count !== fileBefore.size || count > 64 * 1024) fail();
            const value: unknown = JSON.parse(bytes.subarray(0, count).toString("utf8"));
            const record = inspect(value, join(path, recordName), claim);
            check(leaf, file, fileBefore);
            if (!record) return fail();
            if (digest(record.accountId) !== (legacy ? recordName : accountHash) ||
                (!legacy && recordName !== (record.demandKey === null ? "account.json" : `${digest(record.demandKey)}.json`))) fail();
            records.push(Object.freeze({ ...record, path: join(path, recordName),
              sha256: createHash("sha256").update(bytes.subarray(0, count)).digest("hex"),
              custodySha256: digest(JSON.stringify(["dev", "ino", "mode", "uid", "gid", "nlink", "size", "ctimeMs", "mtimeMs"].map(key => fileBefore[key as keyof Stats]))), value, claim }));
          } finally { closeSync(file); }
        }
        check(path, directory!, before);
      } finally { closeSync(directory!); }
    };
    visit(join(rootDir, "account-capacity"), null, true);
    visit(join(rootDir, "account-capacity-v2"), null, false);
    check(rootDir, root!, rootBefore);
    return records;
  } catch { return fail(); }
  finally { closeSync(root!); }
}
