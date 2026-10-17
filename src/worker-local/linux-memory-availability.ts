import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";

/**
 * What this process can still allocate on Linux: the host's MemAvailable (swap is never counted) bounded by the
 * remaining allowance of EVERY effective cgroup ancestor (limit minus current usage, so already-charged RSS and
 * page cache are inside the figure). Nothing here reserves memory; it is an admission observation.
 *
 * "Every effective ancestor" needs a TRUSTED HOST CONTEXT that a process cannot establish about itself: a private
 * PID/cgroup namespace makes `self` equal to the visible PID 1 and can remap a visible mount root to "/". The
 * context therefore arrives as an authenticated `reference` (boot, machine and the topology IDENTITIES the
 * supervised installation operator recorded in the installed inventory); this reader never builds, selects or
 * trusts a reference itself, and without one it refuses with `host_authority_not_installed`. The reference is
 * authenticated by the Host composition (`retained-memory-authority.ts`) through the installed boot/runtime chain.
 *
 * Even with a reference nothing is assumed complete. The live boot, machine, cgroup-namespace handle and hierarchy
 * root must equal the reference, the namespace must be the INITIAL one (kernel-fixed inode), exactly ONE cgroup2
 * row may sit at the mapping with mount root "/", no mount may nest inside it or cover an ancestor path, and every
 * level from the root to this process's cgroup must exist and state its own memory-controller availability. The
 * mount rows, level identities, membership, namespace and root are re-read after the limits and must be unchanged.
 * cgroup v1 and hybrid hosts are refused (`cgroup_v1_unsupported`). Level reads are identity-rechecked, not read
 * through held descriptors. Not a reservation: ordinary concurrent-memory uncertainty remains.
 */
export type LinuxMemoryAvailability = {
  readonly hostAvailableBytes: number;
  /** undefined only when every level was read and none imposes a limit. */
  readonly cgroupRemainingBytes: number | undefined;
  /** min(host, tightest cgroup remainder). */
  readonly effectiveBytes: number;
  readonly cgroupVersion: "v2";
  /** The directory whose remainder is the tightest, when one is limiting. */
  readonly limitingCgroup?: string;
};

type Identity = { readonly dev: string; readonly ino: string };
/** Identities and mapping only; never a memory, limit or headroom scalar. */
export type HostMemoryTopology = {
  readonly mountPoint: string;
  readonly cgroupNamespace: Identity;
  readonly hierarchyRoot: Identity;
};
/** Authenticated upstream by the Host composition; this reader trusts nothing else. */
export type HostMemoryReference = {
  readonly bootId: string;
  readonly machineId: string;
  readonly topology: HostMemoryTopology;
};

/** Everything except `reference` is a path/identity SEAM for fixtures. */
export type LinuxMemoryRoots = {
  readonly procRoot?: string;
  readonly cgroupRoot?: string;
  readonly machineIdPath?: string;
  /** Kernel-defined inode of the initial cgroup namespace; fixtures substitute their own. */
  readonly initialCgroupNamespaceIno?: bigint;
  readonly reference?: HostMemoryReference;
  /** Test seam: runs after the limits are read and before the re-checks, to model drift. */
  readonly afterLimitsRead?: () => Promise<void>;
};

/**
 * CGROUP_NS_INIT_INO (0xEFFFFFFB): the fixed nsfs inode of the INITIAL cgroup namespace. The operator reported
 * confirming it against the Linux UAPI nsfs.h; the author did not retrieve it. A constant alone is never authority:
 * it only rejects a private namespace on top of the authenticated reference.
 */
export const INITIAL_CGROUP_NAMESPACE_INO = 4026531835n;

const SMALL_FILE_MAX_BYTES = 64 * 1024;
const MOUNTINFO_MAX_BYTES = 4 * 1024 * 1024;

function unknown(reason: string, cause?: unknown): Error {
  return new Error(`linux_memory_unknown:${reason}`, cause === undefined ? undefined : { cause });
}

/** Bounded read: a kernel file larger than `max` is unknown, never buffered whole. */
function readText(path: string, max: number = SMALL_FILE_MAX_BYTES): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(max + 1);
    let length = 0;
    for (;;) {
      const bytesRead = readSync(fd, buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > max) throw unknown(`oversize:${path}`);
    }
    return buffer.subarray(0, length).toString("utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("linux_memory_unknown:")) throw error;
    throw unknown(`unreadable:${path}`, error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseCount(raw: string, label: string): number {
  const text = raw.trim();
  if (!/^\d{1,19}$/.test(text)) throw unknown(`unparseable:${label}`);
  return Number(text);
}

type Level = { readonly directory: string; readonly remaining: number | undefined };

function tightest(levels: readonly Level[]): { readonly remaining: number | undefined; readonly directory: string | undefined } {
  let best: { remaining: number; directory: string } | undefined;
  for (const level of levels) {
    if (level.remaining !== undefined && (best === undefined || level.remaining < best.remaining)) {
      best = { remaining: level.remaining, directory: level.directory };
    }
  }
  return { remaining: best?.remaining, directory: best?.directory };
}

/** The kernel-reported cgroup path, validated before it is ever joined to a mount root. */
function safeCgroupPath(raw: string): string {
  if (!raw.startsWith("/") || raw.includes("\0") || raw.split("/").some((part) => part === ".." || part === ".")) {
    throw unknown("cgroup_path_invalid");
  }
  return raw;
}

/** Root-first list of directories from the mount root down to the process's cgroup. */
function chain(root: string, path: string): readonly string[] {
  const directories = [root];
  for (const part of path.split("/").filter(Boolean)) directories.push(resolve(directories[directories.length - 1]!, part));
  return directories;
}

type Mount = { readonly id: string; readonly parentId: string; readonly root: string; readonly mountPoint: string; readonly fstype: string };

const unescapeMount = (value: string) => value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));

function parseMountinfo(text: string): readonly Mount[] {
  const mounts: Mount[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const separator = line.indexOf(" - ");
    if (separator < 0) throw unknown("mountinfo_invalid");
    const left = line.slice(0, separator).split(" "), right = line.slice(separator + 3).split(" ");
    if (left.length < 6 || right.length < 3) throw unknown("mountinfo_invalid");
    mounts.push({ id: left[0]!, parentId: left[1]!, root: unescapeMount(left[3]!), mountPoint: unescapeMount(left[4]!), fstype: right[0]! });
  }
  return mounts;
}

const within = (parent: string, child: string) => parent === "/" || child === parent || child.startsWith(`${parent}/`);

/**
 * Prove the cgroup2 hierarchy at `mountPoint` is the single, unmasked, complete mount, and return the rows that
 * establish it (for a later re-check). Row ORDER is never used to pick a "visible" mount. Refused: no cgroup2 row,
 * two rows at the path (competing or stacked), mount root other than "/" (a subtree), any other mount nested inside
 * the hierarchy (it can mask an enforcing ancestor while the root identity is unchanged), a mount-parent chain that
 * is not made of path ancestors, any other mount over an ancestor path, and sibling rows stacked at one path.
 */
function proveHierarchyMount(mounts: readonly Mount[], mountPoint: string): readonly Mount[] {
  const exact = mounts.filter((mount) => mount.mountPoint === mountPoint);
  if (exact.length === 0 || exact[0]!.fstype !== "cgroup2") throw unknown(`cgroup_mount_unproven:${mountPoint}`);
  if (exact.length > 1) throw unknown(`cgroup_mount_ambiguous:${mountPoint}`);
  const top = exact[0]!;
  if (top.root !== "/") throw unknown(`cgroup_mount_is_subtree:${mountPoint}`);
  if (mounts.some((mount) => mount.mountPoint.startsWith(`${mountPoint}/`))) throw unknown(`cgroup_nested_mount:${mountPoint}`);
  const chainRows: Mount[] = [top];
  for (let current = top; chainRows.length <= mounts.length;) {
    const parent = mounts.find((mount) => mount.id === current.parentId);
    if (parent === undefined) break; // top of this mount namespace's tree
    if (!within(parent.mountPoint, mountPoint)) throw unknown(`cgroup_mount_chain_invalid:${mountPoint}`);
    chainRows.push(parent); current = parent;
  }
  const inChain = new Set(chainRows.map((mount) => mount.id));
  if (mounts.some((mount) => !inChain.has(mount.id) && mount.mountPoint !== "/" && within(mount.mountPoint, mountPoint))) {
    throw unknown(`cgroup_ancestor_overmounted:${mountPoint}`);
  }
  for (const mount of chainRows) {
    if (mounts.filter((other) => other.parentId === mount.parentId && other.mountPoint === mount.mountPoint).length > 1) {
      throw unknown(`cgroup_mount_ambiguous:${mount.mountPoint}`);
    }
  }
  return chainRows;
}

/** Live mount proof for the hierarchy mapped at `cgroupRoot`; used by the collector and by every read. */
export function readHierarchyMountProof(roots: Pick<LinuxMemoryRoots, "procRoot" | "cgroupRoot"> = {}): readonly unknown[] {
  return proveHierarchyMount(parseMountinfo(readText(join(roots.procRoot ?? "/proc", "self", "mountinfo"), MOUNTINFO_MAX_BYTES)), roots.cgroupRoot ?? "/sys/fs/cgroup");
}

function identityOf(path: string, directory: boolean): Identity {
  try {
    const value = statSync(path, { bigint: true });
    if (directory && !value.isDirectory()) throw new Error("not_a_directory");
    return { dev: String(value.dev), ino: String(value.ino) };
  } catch (error) { throw unknown(`unreadable:${path}`, error); }
}

/**
 * Live facts read the same way for collection and validation: boot, machine, and the topology IDENTITIES - the
 * cgroup NAMESPACE handle (stat of the nsfs inode, not readlink text) and the cgroup2 hierarchy root directory.
 */
export function observeHostMemoryTopology(roots: Pick<LinuxMemoryRoots, "procRoot" | "cgroupRoot" | "machineIdPath"> = {}): HostMemoryReference {
  const proc = roots.procRoot ?? "/proc", cgroupRoot = roots.cgroupRoot ?? "/sys/fs/cgroup";
  return {
    bootId: readText(join(proc, "sys", "kernel", "random", "boot_id")).trim(),
    machineId: readText(roots.machineIdPath ?? "/etc/machine-id").trim(),
    topology: { mountPoint: cgroupRoot, cgroupNamespace: identityOf(join(proc, "self", "ns", "cgroup"), false), hierarchyRoot: identityOf(cgroupRoot, true) },
  };
}

type Entry = { readonly id: string; readonly controllers: readonly string[]; readonly path: string };

function parseSelfCgroup(text: string): readonly Entry[] {
  return text.split("\n").filter((line) => line.length > 0).map((line) => {
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    if (first < 0 || second < 0) throw unknown("proc_self_cgroup_invalid");
    return { id: line.slice(0, first), controllers: line.slice(first + 1, second).split(",").filter(Boolean), path: line.slice(second + 1) };
  });
}

/**
 * The process's unified (cgroup v2) path. v1 (and hybrid, where memory is a v1 controller) is refused FIRST:
 * nothing here proves it. Shared by the live reader and the installation collector.
 */
export function unifiedCgroupPath(membership: string): string {
  const entries = parseSelfCgroup(membership);
  if (entries.some((entry) => entry.id !== "0" && entry.controllers.includes("memory"))) throw unknown("cgroup_v1_unsupported");
  const v2 = entries.find((entry) => entry.id === "0" && entry.controllers.length === 0);
  if (v2 === undefined) throw unknown("cgroup_hierarchy_unresolved");
  return safeCgroupPath(v2.path);
}

/** The root of the unified hierarchy must itself offer the memory controller. */
export function assertRootOffersMemory(cgroupRoot: string): void {
  if (!readText(join(cgroupRoot, "cgroup.controllers")).trim().split(/\s+/).includes("memory")) throw unknown("cgroup_v2_memory_controller_unavailable");
}

/** dev:ino of every level directory, to detect a level replaced while its files were being read. */
function levelIdentities(directories: readonly string[]): readonly string[] {
  return directories.map((directory) => {
    const { dev, ino } = identityOf(directory, true);
    return `${dev}:${ino}`;
  });
}

function v2Levels(directories: readonly string[]): readonly Level[] {
  const levels: Level[] = [];
  let enabledAbove = true;
  for (const [index, directory] of directories.entries()) {
    // The level must exist and state its own controller availability; a missing directory is never "skipped".
    const enabled = readText(join(directory, "cgroup.controllers")).trim().split(/\s+/).includes("memory");
    if (index === 0 && !enabled) throw unknown("cgroup_v2_memory_controller_unavailable");
    if (enabled && !enabledAbove) throw unknown("cgroup_v2_controller_state_inconsistent");
    enabledAbove = enabled;
    if (!enabled || index === 0) continue; // genuinely not enabled here (the limit comes from an enabled ancestor); the root has no memory.max
    const maxFile = join(directory, "memory.max"), usageFile = join(directory, "memory.current");
    const raw = readText(maxFile).trim();
    levels.push({ directory, remaining: raw === "max" ? undefined : Math.max(0, parseCount(raw, maxFile) - parseCount(readText(usageFile), usageFile)) });
  }
  return levels;
}

/** The authenticated reference must still describe THIS host, boot and namespace right now. */
function assertLiveMatchesReference(reference: HostMemoryReference, live: HostMemoryReference, initialNamespaceIno: bigint): void {
  if (live.bootId !== reference.bootId) throw unknown("host_reference_stale_boot");
  if (live.machineId !== reference.machineId) throw unknown("host_reference_machine_mismatch");
  // The initial host cgroup namespace (kernel-fixed inode) AND the very handle the reference recorded.
  if (BigInt(reference.topology.cgroupNamespace.ino) !== initialNamespaceIno ||
      !isDeepStrictEqual(reference.topology.cgroupNamespace, live.topology.cgroupNamespace)) throw unknown("host_reference_namespace_mismatch");
  if (!isDeepStrictEqual(reference.topology.hierarchyRoot, live.topology.hierarchyRoot) ||
      reference.topology.mountPoint !== live.topology.mountPoint) throw unknown("host_reference_hierarchy_mismatch");
}

export async function readLinuxMemoryAvailability(roots: LinuxMemoryRoots = {}): Promise<LinuxMemoryAvailability> {
  const proc = roots.procRoot ?? "/proc";
  const cgroupRoot = roots.cgroupRoot ?? "/sys/fs/cgroup";
  const meminfo = readText(join(proc, "meminfo"));
  const available = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(meminfo);
  if (available === null) throw unknown("meminfo_mem_available_missing");
  const hostAvailableBytes = parseCount(available[1]!, "MemAvailable") * 1024;
  if (!Number.isSafeInteger(hostAvailableBytes)) throw unknown("meminfo_mem_available_invalid");

  const membership = readText(join(proc, "self", "cgroup"));
  const path = unifiedCgroupPath(membership);

  // No authenticated reference, no capability: the default is refusal.
  if (roots.reference === undefined) throw unknown("host_authority_not_installed");
  const observed = observeHostMemoryTopology(roots);
  assertLiveMatchesReference(roots.reference, observed, roots.initialCgroupNamespaceIno ?? INITIAL_CGROUP_NAMESPACE_INO);
  const mountProof = readHierarchyMountProof(roots);
  const directories = chain(cgroupRoot, path), identities = levelIdentities(directories);
  const levels = v2Levels(directories);
  await roots.afterLimitsRead?.();
  // Observable migration, or a replaced namespace/hierarchy/boot/mount/level, between the first reads and now refuses.
  if (readText(join(proc, "self", "cgroup")) !== membership) throw unknown("cgroup_membership_changed");
  if (!isDeepStrictEqual(observeHostMemoryTopology(roots), observed)) throw unknown("host_topology_changed");
  if (!isDeepStrictEqual(readHierarchyMountProof(roots), mountProof)) throw unknown("host_mount_topology_changed");
  if (!isDeepStrictEqual(levelIdentities(directories), identities)) throw unknown("cgroup_level_replaced");
  const { remaining, directory } = tightest(levels);
  return {
    hostAvailableBytes, cgroupRemainingBytes: remaining, cgroupVersion: "v2",
    effectiveBytes: remaining === undefined ? hostAvailableBytes : Math.min(hostAvailableBytes, remaining),
    ...(remaining === undefined || directory === undefined ? {} : { limitingCgroup: directory }),
  };
}
