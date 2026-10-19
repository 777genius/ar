import { closeSync, constants, fstatSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, type Stats } from "node:fs";

/** Legacy launch-boundary check. Explicit stdio alone does not establish peer
 * provenance or close every inherited FD. Reject file/directory handles before provider
 * code runs, including readonly and O_PATH handles reopenable through procfs. */
export function assertHostedProcessDescriptors(): void {
  for (const descriptor of [0, 1, 2]) {
    const stat = fstatSync(descriptor);
    if (!stat.isFIFO() && !stat.isSocket()) throw new Error("hosted_custody_stdio_pipe_required");
  }
  for (const name of readdirSync("/proc/self/fd")) {
    if (!/^\d+$/.test(name)) throw new Error("hosted_custody_descriptor_invalid");
    const descriptor = Number(name);
    if (descriptor <= 2) continue;
    try {
      const stat = fstatSync(descriptor);
      if (stat.isFile() || stat.isDirectory()) throw new Error("hosted_custody_inherited_handle_denied", {
        cause: hostedDescriptorDenialFact(descriptor, stat),
      });
    } catch (error) {
      // The directory FD used by readdir may already be closed. No inherited
      // handle is ignored merely because its readlink target looks harmless.
      if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
    }
  }
}

/** Additional self check in the fixed schema4 prelude, before its ready marker.
 * Actual retained parent peer/closure/qualified-count proof is still required.
 * These finite maxima cannot grant an inherited socket or generic anon_inode. */
export function assertHostedFdPreludeDescriptors(): void {
  assertHostedProcessDescriptors();
  const count = { eventPoll: 0, eventFd: 0, pipe: 0, devNull: 0 };
  const names = readdirSync("/proc/self/fd");
  if (names.length > 256) throw new Error("hosted_fd_prelude_descriptors_denied");
  for (const name of names) {
    if (!/^(?:0|[1-9][0-9]{0,5})$/.test(name)) throw new Error("hosted_fd_prelude_descriptors_denied");
    const fd = Number(name);
    if (fd <= 2) continue;
    try {
      const stat = fstatSync(fd), target = readlinkSync(`/proc/self/fd/${fd}`);
      const flags = /^flags:\s+([0-7]{1,12})$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"));
      const value = flags ? Number.parseInt(flags[1]!, 8) : 0;
      if (!flags || !(value & 0o2000000) || value & 0o10000000) throw new Error("hosted_fd_prelude_descriptors_denied");
      if (target === "anon_inode:[eventpoll]" && !stat.isSocket() && !stat.isFile() && !stat.isDirectory()) count.eventPoll++;
      else if (target === "anon_inode:[eventfd]" && !stat.isSocket() && !stat.isFile() && !stat.isDirectory()) count.eventFd++;
      else if (stat.isFIFO() && /^pipe:\[[1-9][0-9]*\]$/.test(target)) count.pipe++;
      else if (stat.isCharacterDevice() && stat.rdev === 259 && (value & 3) === 0) count.devNull++;
      else throw new Error("hosted_fd_prelude_descriptors_denied");
    } catch (error) {
      try { fstatSync(fd); }
      catch (closed) { if ((closed as NodeJS.ErrnoException).code === "EBADF") continue; }
      throw error;
    }
  }
  if (count.eventPoll > 8 || count.eventFd > 8 || count.pipe > 32 || count.devNull > 8) {
    throw new Error("hosted_fd_prelude_descriptors_denied");
  }
}


enum DescriptorKind { File = "file", Directory = "directory" }
enum DescriptorAccess { Read = "read", Write = "write", ReadWrite = "readwrite", Path = "path", Unknown = "unknown" }
enum DescriptorRole { Event = "event", Progress = "progress", Temp = "temp", CheckpointWriter = "checkpoint_writer",
  CheckpointMutexOwner = "checkpoint_mutex_owner", Unknown = "unknown" }

function sameDescriptor(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.rdev === after.rdev;
}

/** Reads proc metadata only, never the denied descriptor or its target contents. */
function flags(fd: number): number {
  const handle = openSync(`/proc/self/fdinfo/${fd}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(1025), length = readSync(handle, bytes, 0, bytes.length, 0);
    if (length < 1 || length > 1024) throw new Error();
    const matches = [...bytes.subarray(0, length).toString("ascii").matchAll(/^flags:\s+([0-7]{1,12})$/gm)];
    if (matches.length !== 1) throw new Error();
    return Number.parseInt(matches[0]![1]!, 8);
  } finally { closeSync(handle); }
}

function access(value: number): DescriptorAccess {
  if (value & 0o10000000) return DescriptorAccess.Path;
  switch (value & 3) {
    case 0: return DescriptorAccess.Read;
    case 1: return DescriptorAccess.Write;
    case 2: return DescriptorAccess.ReadWrite;
    default: return DescriptorAccess.Unknown;
  }
}

function role(target: string, kind: DescriptorKind): DescriptorRole {
  if (kind !== DescriptorKind.File) return DescriptorRole.Unknown;
  // Lexical categories only; a matching name establishes no ownership or trust.
  if (/\/\.terminal-checkpoint-admission\/writers\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(target)) return DescriptorRole.CheckpointWriter;
  if (/\/\.terminal-checkpoint-admission\/mutex\/owner$/.test(target)) return DescriptorRole.CheckpointMutexOwner;
  const name = target.slice(target.lastIndexOf("/") + 1);
  if (/^[^/\n]{1,200}\.events\.jsonl$/.test(name)) return DescriptorRole.Event;
  if (/^[^/\n]{1,200}\.progress\.json$/.test(name)) return DescriptorRole.Progress;
  if (/^[^/\n]{1,200}\.tmp$/.test(name)) return DescriptorRole.Temp;
  return DescriptorRole.Unknown;
}

/** Closed diagnostic cause. Zero is the numeric unknown-FD sentinel. The
 * original denial remains authoritative even if metadata disappears or drifts. */
function hostedDescriptorDenialFact(descriptor: number, original: Stats): Error {
  const fd = Number.isSafeInteger(descriptor) && descriptor >= 3 && descriptor <= 999999 ? descriptor : 0;
  const kind = original.isDirectory() ? DescriptorKind.Directory : DescriptorKind.File;
  let observedAccess = DescriptorAccess.Unknown, observedRole = DescriptorRole.Unknown;
  if (fd !== 0) {
    try {
      if (!sameDescriptor(original, fstatSync(fd))) throw new Error();
      const target = readlinkSync(`/proc/self/fd/${fd}`);
      if (target.length > 4096) throw new Error();
      const first = flags(fd), second = flags(fd);
      if (first !== second || target !== readlinkSync(`/proc/self/fd/${fd}`) || !sameDescriptor(original, fstatSync(fd))) throw new Error();
      observedAccess = access(first); observedRole = role(target, kind);
    } catch { /* Observation failure cannot release or replace the denial. */ }
  }
  return new Error(`hosted_fd_fact fd=${fd} type=${kind} access=${observedAccess} role=${observedRole}`);
}
