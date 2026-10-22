import { closeSync, constants, fstatSync, statSync, statfsSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";

/** Kernel observation only. A live proc pair is neither custody nor a grant. */
export interface FullParentProcIdentity {
  readonly pid: number;
  readonly startTicks: string;
  readonly stat: Readonly<{ dev: string; ino: string }>;
  readonly status: Readonly<{ dev: string; ino: string }>;
  readonly capabilities: readonly string[];
}
function invalid(): never { throw new Error("hosted_full_parent_live_join_failed"); }
function requireValue(value: unknown): asserts value { if (!value) invalid(); }
/** Linux proc magiclink resolves the held file's actual f_path. This is a
 * filesystem fact only; the caller retains the FD and proc/birth/mount joins. */
export function fullRetainedFilesystemType(fd:number):bigint {
  requireValue(process.platform==="linux" && Number.isSafeInteger(fd) && fd>=0);
  const before=fstatSync(fd,{bigint:true}),path=`/proc/self/fd/${fd}`;
  const matches=(stat:typeof before)=>stat.dev===before.dev && stat.ino===before.ino && stat.mode===before.mode
    && stat.uid===before.uid && stat.gid===before.gid && stat.rdev===before.rdev;
  requireValue(matches(statSync(path,{bigint:true})));
  const type=statfsSync(path,{bigint:true}).type;
  requireValue(matches(fstatSync(fd,{bigint:true})) && matches(statSync(path,{bigint:true})));
  return type;
}
const procMagic = 0x9fa0n;
const sets = ["Inh", "Prm", "Eff", "Bnd", "Amb"] as const;

export function fullProcBirth(raw: string): Readonly<{ pid: number; startTicks: string; state: string }> {
  requireValue(Buffer.byteLength(raw) <= 4096 && raw.endsWith("\n"));
  const first = /^([1-9][0-9]*) \(/.exec(raw), end = raw.lastIndexOf(") ");
  requireValue(first && end > 0);
  const fields = raw.slice(end + 2).trim().split(/\s+/), state = fields[0], ticks = fields[19];
  requireValue(state && /^[RSDTtIWP]$/.test(state) && ticks && /^[1-9][0-9]*$/.test(ticks));
  const pid = Number(first[1]); requireValue(Number.isSafeInteger(pid));
  return Object.freeze({ pid, startTicks: ticks, state });
}
function statusCaps(raw: string, expected: FullParentProcIdentity): void {
  requireValue(Buffer.byteLength(raw) <= 16384 && raw.endsWith("\n"));
  requireValue(new RegExp("^Pid:\\s+" + expected.pid + "$", "m").test(raw));
  requireValue(/^Uid:\s+0\s+0\s+0\s+0$/m.test(raw) && /^Gid:\s+0\s+0\s+0\s+0$/m.test(raw));
  requireValue(/^NoNewPrivs:\s+1$/m.test(raw) && !/^State:\s+[ZX]/m.test(raw));
  requireValue(expected.capabilities.length === sets.length);
  for (const [index, set] of sets.entries()) {
    const rows = [...raw.matchAll(new RegExp("^Cap" + set + ":\\s+([0-9a-f]{16})$", "gm"))];
    requireValue(rows.length === 1 && rows[0]?.[1] === expected.capabilities[index]);
  }
}
/** Fresh open/read each call: never reuse a seq_file buffer after owner death.
 * Bound proc inodes keep their original pid object; matching copied text fails
 * the procfs/inode joins. Numeric PID reuse cannot replace the retained object. */
export function assertFullParentProcFiles(statPath: string, statusPath: string, expected: FullParentProcIdentity): void {
  const opened: number[] = [];
  function sample(path: string, target: Readonly<{ dev: string; ino: string }>, bound: number): string {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    opened.push(fd);
    const before = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    requireValue(before.isFile() && !named.isSymbolicLink() && String(before.dev) === target.dev && String(before.ino) === target.ino);
    requireValue(named.dev === before.dev && named.ino === before.ino && fullRetainedFilesystemType(fd) === procMagic);
    const buffer = Buffer.alloc(bound + 1); let size = 0, count = 0;
    while ((count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) {
      size += count; requireValue(size <= bound);
    }
    const after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
    requireValue(after.dev === before.dev && after.ino === before.ino && current.dev === before.dev && current.ino === before.ino);
    // Join the currently named mount, not only the old held descriptor.
    const fresh = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = (entry: number): string => {
        const raw = readFileSync(`/proc/self/fdinfo/${entry}`, "utf8");
        requireValue(Buffer.byteLength(raw) <= 4096);
        const rows = [...raw.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
        const id=rows[0]?.[1]; requireValue(rows.length === 1 && id); return id;
      };
      requireValue(info(fresh) === info(fd));
      const now = fstatSync(fresh, { bigint: true }); requireValue(now.dev === before.dev && now.ino === before.ino);
    } finally { closeSync(fresh); }
    return buffer.subarray(0, size).toString("utf8");
  }
  try {
    const before = fullProcBirth(sample(statPath, expected.stat, 4096));
    requireValue(before.pid === expected.pid && before.startTicks === expected.startTicks);
    statusCaps(sample(statusPath, expected.status, 16384), expected);
    const after = fullProcBirth(sample(statPath, expected.stat, 4096));
    requireValue(after.pid === before.pid && after.startTicks === before.startTicks);
  } finally { for (const fd of opened.reverse()) closeSync(fd); }
}
