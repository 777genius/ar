import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readlinkSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type ScratchMount = { target?: string; uuid?: string; fsroot?: string };
type Record = { id: number; root: string; target: string };
const fail = (): never => { throw new Error("Ambiguous scratch mount inspection"); };
const integer = (value: unknown): number => {
  const n = typeof value === "number" ? value : typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) return fail();
  return n;
};
function decode(value: string): string {
  if (/\\(?!040|011|012|134)/.test(value)) return fail();
  return value.replace(/\\(040|011|012|134)/g, (_, digits: string) => String.fromCharCode(parseInt(digits, 8)));
}
function mountRecord(id: number, table: string): Record {
  const rows = table.trimEnd().split("\n").filter(line => line.split(" ", 1)[0] === String(id));
  if (rows.length !== 1) return fail();
  const parts = rows[0]!.split(" "), separator = parts.indexOf("-");
  if (separator < 6 || parts.length < separator + 4 || !parts[3] || !parts[4]) return fail();
  const root = decode(parts[3]), target = decode(parts[4]);
  if (!isAbsolute(root) || !isAbsolute(target) || resolve(target) !== target) return fail();
  return { id, root, target };
}
/** Kernel record contract: hidden rows grant no mount authority at the named directory. */
export function selectVisibleScratchMount(path: string, mountId: number, table: string, query: unknown): ScratchMount | undefined {
  if (!isAbsolute(path) || resolve(path) !== path) return fail();
  if (!query || typeof query !== "object" || !("filesystems" in query) || !Array.isArray(query.filesystems)) return fail();
  const rows = query.filesystems.map((value: unknown) => {
    if (!value || typeof value !== "object" || !("id" in value)) return fail();
    return { row: value, id: integer(value.id) };
  });
  const visible = mountRecord(integer(mountId), table);
  if (visible.target !== path) {
    if (visible.target === "/" || path.startsWith(`${visible.target}/`)) return undefined;
    return fail();
  }
  const selected = rows.filter(value => value.id === mountId);
  if (selected.length !== 1) return fail();
  const row: unknown = selected[0]!.row;
  if (!row || typeof row !== "object" || !("target" in row) || row.target !== path ||
      !("fsroot" in row) || row.fsroot !== visible.root || !("uuid" in row) || row.uuid !== null && typeof row.uuid !== "string") return fail();
  return { target: path, fsroot: visible.root, ...(typeof row.uuid === "string" ? { uuid: row.uuid } : {}) };
}
function boundedRead(path: string, maximum: number): string {
  const fd = openSync(path, constants.O_RDONLY), chunks: Buffer[] = [];
  let total = 0;
  try {
    const buffer = Buffer.alloc(Math.min(maximum + 1, 64 * 1024));
    for (;;) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, maximum + 1 - total), null);
      if (n === 0) return Buffer.concat(chunks, total).toString("utf8");
      total += n; if (total > maximum) return fail();
      chunks.push(Buffer.from(buffer.subarray(0, n)));
    }
  } finally { closeSync(fd); }
}
function opened(fd: number) {
  const info = fstatSync(fd), ids = [...boundedRead(`/proc/self/fdinfo/${fd}`, 4096).matchAll(/^mnt_id:\s+([1-9]\d*)$/gm)];
  if (!info.isDirectory() || ids.length !== 1) return fail();
  return { dev: info.dev, ino: info.ino, mountId: integer(ids[0]![1]) };
}
function same(a: ReturnType<typeof opened>, b: ReturnType<typeof opened>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mountId === b.mountId;
}
// Linux O_PATH avoids requiring directory read permission on prepared mode0701 sources.
// O_DIRECTORY also rejects O_PATH|O_NOFOLLOW's special symlink-descriptor behavior.
const directoryFlags = 0x200000 | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export function inspectVisibleScratchMount(path: string): ScratchMount | undefined {
  if (process.platform !== "linux" || !isAbsolute(path) || resolve(path) !== path) return fail();
  const namespace = readlinkSync("/proc/self/ns/mnt");
  let fd: number;
  try { fd = openSync(path, directoryFlags); }
  catch (error) {
    const code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
    if (code && "value" in code && code.value === "ENOENT") return undefined;
    throw error;
  }
  let fresh: number | undefined;
  try {
    const original = opened(fd), before = boundedRead("/proc/self/mountinfo", 8 * 1024 * 1024);
    const record = mountRecord(original.mountId, before);
    let output: string;
    try {
      output = execFileSync("findmnt", ["--json", "--mountpoint", path, "--output", "ID,TARGET,UUID,FSROOT"],
        { encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" });
    } catch (error) {
      const status = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "status") : undefined;
      if (!status || !("value" in status) || status.value !== 1) throw error;
      output = '{"filesystems":[]}';
    }
    const result = selectVisibleScratchMount(path, original.mountId, before, JSON.parse(output) as unknown);
    // A new bind of the same inode changes mount ID without changing named dev/inode.
    fresh = openSync(path, directoryFlags);
    const after = boundedRead("/proc/self/mountinfo", 8 * 1024 * 1024);
    if (!same(original, opened(fd)) || !same(original, opened(fresh)) || readlinkSync("/proc/self/ns/mnt") !== namespace ||
        JSON.stringify(record) !== JSON.stringify(mountRecord(original.mountId, after))) return fail();
    return result;
  } finally { if (fresh !== undefined) closeSync(fresh); closeSync(fd); }
}
