import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readlinkSync, realpathSync, readSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export type ScratchMount = { target?: string; uuid?: string; fsroot?: string; mountId?: number; isPrivate?: boolean };
type Record = { id: number; root: string; target: string; propagation: string[] };
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
function mountLine(id: number, table: string): string {
  const prefix = String(id) + " ";
  const rows = table.trimEnd().split("\n").filter(line => line.startsWith(prefix));
  if (rows.length !== 1) return fail();
  return rows[0]!;
}
function parseMountRecord(id: number, line: string): Record {
  const parts = line.split(" "), separator = parts.indexOf("-");
  if (separator < 6 || parts.length < separator + 4 || !parts[3] || !parts[4]) return fail();
  const root = decode(parts[3]), target = decode(parts[4]);
  if (!isAbsolute(root) || !isAbsolute(target) || resolve(target) !== target) return fail();
  const propagation = parts.slice(6, separator), known = new Set<string>();
  for (const field of propagation) {
    const tag = field.split(":")[0]!;
    if (["shared", "master", "propagate_from", "unbindable"].includes(tag)) {
      if (known.has(tag) || (tag === "unbindable" ? field !== tag : !/^[a-z_]+:[1-9]\d*$/.test(field))) return fail();
      if (tag !== "unbindable") integer(field.slice(tag.length + 1));
      known.add(tag);
    }
  }
  return { id, root, target, propagation };
}
function mountRecord(id: number, table: string): Record {
  return parseMountRecord(id, mountLine(id, table));
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
  return { target: path, fsroot: visible.root, mountId: visible.id, isPrivate: visible.propagation.length === 0,
    ...(typeof row.uuid === "string" ? { uuid: row.uuid } : {}) };
}
function boundedRead(path: string, maximum: number): string {
  const fd = openSync(path, constants.O_RDONLY), chunks: Buffer[] = [];
  let total = 0;
  try {
    const buffer = Buffer.alloc(Math.min(maximum + 1, 1024 * 1024));
    for (;;) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, maximum + 1 - total), null);
      if (n === 0) return Buffer.concat(chunks, total).toString("utf8");
      total += n; if (total > maximum) return fail();
      chunks.push(Buffer.from(buffer.subarray(0, n)));
    }
  } finally { closeSync(fd); }
}
/** Fixed native Host observation; all consumers retain the complete bounded table. */
export function readKernelMountTable(): string { return boundedRead("/proc/self/mountinfo", 8 * 1024 * 1024); }
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
    const original = opened(fd), before = readKernelMountTable();
    const line = mountLine(original.mountId, before), record = parseMountRecord(original.mountId, line);
    let result: ScratchMount | undefined;
    if (record.target === path) {
      let output: string;
      let snapshot: number | undefined;
      try {
        // Only the unique FD-selected original row needs libmount's UUID query.
        // The full table remains the topology/duplicate-ID witness before and
        // after the query; hidden same-target rows never supply authority.
        // Linux O_TMPFILE keeps the snapshot unnamed; O_EXCL prevents relinking.
        // Node's default stdin is a socket that findmnt cannot reopen via procfs.
        snapshot = openSync("/tmp", 0x410000 | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_EXCL, 0o600);
        writeFileSync(snapshot, line + "\n", { encoding: "utf8" });
        output = execFileSync("findmnt", ["--kernel", "--tab-file", "/proc/self/fd/0", "--json", "--mountpoint", path, "--output", "ID,TARGET,UUID,FSROOT"],
          { stdio: [snapshot, "pipe", "pipe"], encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" });
      } catch (error) {
        const status = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "status") : undefined;
        if (!status || !("value" in status) || status.value !== 1) throw error;
        output = '{"filesystems":[]}';
      } finally { if (snapshot !== undefined) closeSync(snapshot); }
      result = selectVisibleScratchMount(path, original.mountId, before, JSON.parse(output) as unknown);
    } else if (record.target !== "/" && !path.startsWith(record.target + "/")) return fail();
    // An authenticated containing ancestor means absence. It still requires
    // the same current FD, named mount ID, namespace and full-table rechecks.
    // A new bind of the same inode changes mount ID without changing named dev/inode.
    fresh = openSync(path, directoryFlags);
    const after = readKernelMountTable();
    if (!same(original, opened(fd)) || !same(original, opened(fresh)) || readlinkSync("/proc/self/ns/mnt") !== namespace ||
        JSON.stringify(record) !== JSON.stringify(mountRecord(original.mountId, after))) return fail();
    return result;
  } finally { if (fresh !== undefined) closeSync(fresh); closeSync(fd); }
}

/** Read-only FD-selected backing for admission. This grants no writer authority.
 * The mount id, rather than lexical longest-prefix selection, resolves aliases.
 */
export type KernelPathBacking = Readonly<{ device: string; backingPath: string }>;
export function inspectKernelPathBacking(path: string): KernelPathBacking {
  if (process.platform !== "linux" || !isAbsolute(path) || resolve(path) !== path) return fail();
  if (realpathSync(path) !== path) return fail();
  const namespace = readlinkSync("/proc/self/ns/mnt");
  const flags = 0x200000 | constants.O_NOFOLLOW;
  const inspect = (fd: number) => {
    const info = fstatSync(fd), ids = [...boundedRead(`/proc/self/fdinfo/${fd}`, 4096).matchAll(/^mnt_id:\s+([1-9]\d*)$/gm)];
    if ((!info.isDirectory() && !info.isFile()) || info.isFile() && info.nlink !== 1 || ids.length !== 1) return fail();
    return { dev: info.dev, ino: info.ino, mountId: integer(ids[0]![1]) };
  };
  const fd = openSync(path, flags); let fresh: number | undefined;
  try {
    const identity = inspect(fd), table = readKernelMountTable();
    const result = selectKernelPathBacking(path, identity.mountId, identity.dev, table);
    fresh = openSync(path, flags);
    if (!same(identity, inspect(fd)) || !same(identity, inspect(fresh)) ||
        realpathSync(path) !== path || readlinkSync("/proc/self/ns/mnt") !== namespace || readKernelMountTable() !== table) return fail();
    return result;
  } finally { if (fresh !== undefined) closeSync(fresh); closeSync(fd); }
}

/** Finite kernel data transformation; only an actual open FD selects mountId. */
export function selectKernelPathBacking(path: string, mountId: number, dev: number, table: string): KernelPathBacking {
  if (!isAbsolute(path) || resolve(path) !== path || !Number.isSafeInteger(dev) || dev < 0) return fail();
  const line = mountLine(integer(mountId), table), record = parseMountRecord(mountId, line);
  if ((record.target !== path && record.target !== "/" && !path.startsWith(record.target + "/")) ||
      resolve(record.root) !== record.root || /[\x00-\x1f\x7f]/.test(record.root)) return fail();
  const device = line.split(" ")[2], native = BigInt(dev);
  const major = (native >> 8n & 0xfffn) | (native >> 32n & 0xfffff000n), minor = (native & 0xffn) | (native >> 12n & 0xffffff00n);
  if (typeof device !== "string" || device !== `${major}:${minor}`) return fail();
  return Object.freeze({ device, backingPath: join(record.root, relative(record.target, path)) });
}

/** Include visible descendant binds: target writes may reach another backing.
 * Hidden stacked records never supply authority; each path is reopened by FD.
 */
export function inspectKernelPathBackings(path: string): readonly KernelPathBacking[] {
  const namespace = readlinkSync("/proc/self/ns/mnt");
  const table = readKernelMountTable(), lines = table.trimEnd().split("\n");
  if (lines.length > 32768) return fail();
  const paths = new Set([path]);
  for (const line of lines) {
    const fields = line.split(" "), point = fields[4];
    if (point === undefined) return fail();
    const decoded = decode(point);
    if (decoded.startsWith(path === "/" ? "/" : path + "/")) paths.add(decoded);
  }
  if (paths.size > 512) return fail();
  const roots = [...paths].map(inspectKernelPathBacking);
  if (readKernelMountTable() !== table || readlinkSync("/proc/self/ns/mnt") !== namespace) return fail();
  return roots;
}
