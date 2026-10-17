import { link, mkdir, mkdtemp, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observeHostMemoryTopology, readLinuxMemoryAvailability, type HostMemoryReference, type LinuxMemoryRoots } from "../linux-memory-availability";

// Portable: the readers take injectable /proc, cgroup and machine-id roots, so these tests build real file trees
// (mountinfo, namespace handle files, cgroup levels). The reference stands for what the authenticated Host composition
// hands over (see retained-memory-authority.test.ts for the chain that authenticates it); here we prove what the reader
// does with it. Binding tests: each refusal below admits host memory instead of refusing if the matching check in
// linux-memory-availability.ts is removed. The kernel-fixed initial-namespace inode is NOT portable (fixtures supply
// their own); injected references exercise mechanics only and qualify no authority.
const GIB = 1024 ** 3;
const BOOT = "11111111-2222-3333-4444-555555555555", OTHER_BOOT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const MACHINE = "0123456789abcdef0123456789abcdef";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

type Options = {
  readonly mount?: "v2" | "v2-subtree" | "elsewhere" | "none" | "competing" | "nested-overmount" | "ancestor-overmount";
  /** Which cgroup namespace this process is in: the initial host one, or a private one (typical container). */
  readonly ns?: "host" | "private";
  /** The reference the Host composition handed over: the live topology (default), none, or a stale/forged variant. */
  readonly reference?: "live" | "none" | ((live: HostMemoryReference) => HostMemoryReference);
  /** A self-consistent record pair created beside the reader (by a root inside a container). Nothing reads it. */
  readonly siblingPair?: boolean;
};

/** `files` are relative to the temp root; mountinfo, namespace files and boot/machine ids are generated. */
async function tree(files: Readonly<Record<string, string>>, options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), "linux-memory-TEST-"));
  roots.push(root);
  const procRoot = join(root, "proc"), cgroupRoot = join(root, "cgroup");
  const put = async (relative: string, content: string | Buffer) => { await mkdir(dirname(join(root, relative)), { recursive: true }); await writeFile(join(root, relative), content); };
  for (const [relative, content] of Object.entries(files)) await put(relative, content);
  await mkdir(cgroupRoot, { recursive: true });
  await put("hostns", ""); await put("proc/sys/kernel/random/boot_id", `${BOOT}\n`); await put("machine-id", `${MACHINE}\n`);
  if ((options.ns ?? "host") === "host") { await mkdir(join(procRoot, "self", "ns"), { recursive: true }); await link(join(root, "hostns"), join(procRoot, "self", "ns", "cgroup")); }
  else await put("proc/self/ns/cgroup", "");
  // Real mount ids/parents: "/" is id 22 (parent 1); the hierarchy is a child of "/" unless a case says otherwise.
  const line = (mountPoint: string, rootField = "/", id = 36, parent = 22) => `${id} ${parent} 0:30 ${rootField} ${mountPoint} rw,nosuid - cgroup2 cgroup2 rw\n`;
  const mountinfo = {
    v2: line(cgroupRoot), "v2-subtree": line(cgroupRoot, "/sub"), elsewhere: line(join(root, "other")), none: "",
    // Two rows at the hierarchy path: competing / stacked, so "the last row is the visible one" would be a guess.
    competing: line(cgroupRoot) + line(cgroupRoot, "/", 37),
    // A nested mount inside the hierarchy masks the enforcing ancestor /a while the root row and identity are unchanged.
    "nested-overmount": line(cgroupRoot) + line(join(cgroupRoot, "a"), "/", 37, 36),
    // A second mount over the PARENT path of the hierarchy hides the whole mount.
    "ancestor-overmount": line(cgroupRoot) + line(root, "/", 37),
  }[options.mount ?? "v2"];
  await put("proc/self/mountinfo", `22 1 8:1 / / rw - ext4 /dev/sda rw\n${mountinfo}`);
  if (options.siblingPair) { await put("anchor/anchor.json", "{}"); await put("anchor/binding.json", "{}"); }
  const seams: LinuxMemoryRoots = {
    procRoot, cgroupRoot, machineIdPath: join(root, "machine-id"),
    initialCgroupNamespaceIno: (await stat(join(root, "hostns"), { bigint: true })).ino,
  };
  const live = observeHostMemoryTopology(seams);
  const choice = options.reference ?? "live";
  const reference = choice === "none" ? undefined : choice === "live" ? live : choice(live);
  return { ...seams, ...(reference === undefined ? {} : { reference }), root, procRoot, cgroupRoot } as
    LinuxMemoryRoots & { root: string; procRoot: string; cgroupRoot: string; reference?: HostMemoryReference };
}

const meminfo = (availableGiB: number) =>
  `MemTotal:       99999999 kB\nMemFree:         1000 kB\nMemAvailable:   ${availableGiB * 1024 * 1024} kB\nSwapTotal: 99999999 kB\nSwapFree:  99999999 kB\n`;
const base = (self: string) => ({ "proc/meminfo": meminfo(46), "proc/self/cgroup": self });
const rootCtl = { "cgroup/cgroup.controllers": "cpu memory\n" };
/** An enabled v2 level. */
const level = (path: string, max: string | number, current: string | number, controllers = "cpu memory") => ({
  [`cgroup${path}/cgroup.controllers`]: `${controllers}\n`, [`cgroup${path}/memory.max`]: String(max), [`cgroup${path}/memory.current`]: String(current),
});

describe("authenticated-reference memory availability for the retained expanded policy", () => {
  it("bounds a high host allowance by the tightest enclosing ancestor, even when the container's own limit is generous", async () => {
    const t = await tree({ ...base("0::/a/b\n"), ...rootCtl, ...level("/a", GIB, Math.floor(GIB / 2)), ...level("/a/b", 8 * GIB, 100) });
    const result = await readLinuxMemoryAvailability(t);
    expect(result).toMatchObject({ cgroupVersion: "v2", hostAvailableBytes: 46 * GIB, cgroupRemainingBytes: Math.floor(GIB / 2), effectiveBytes: Math.floor(GIB / 2) });
    expect(result.limitingCgroup).toBe(join(t.cgroupRoot!, "a"));
  });

  it("reports the host allowance only when the referenced real root is proven and every level up the chain is unlimited", async () => {
    const t = await tree({ ...base("0::/a/b\n"), ...rootCtl, ...level("/a", "max", 1), ...level("/a/b", "max", 1) });
    expect(await readLinuxMemoryAvailability(t)).toMatchObject({ cgroupRemainingBytes: undefined, effectiveBytes: 46 * GIB });
  });

  it("accepts the hierarchy root itself only with the memory controller offered there", async () => {
    expect(await readLinuxMemoryAvailability(await tree({ ...base("0::/\n"), ...rootCtl }))).toMatchObject({ effectiveBytes: 46 * GIB });
    await expect(readLinuxMemoryAvailability(await tree({ ...base("0::/\n"), "cgroup/cgroup.controllers": "cpu\n" })))
      .rejects.toThrow("linux_memory_unknown:cgroup_v2_memory_controller_unavailable");
  });

  it("skips a level only when its own cgroup.controllers says memory is not enabled, and still honours the limit above it", async () => {
    const t = await tree({ ...base("0::/a/b\n"), ...rootCtl, ...level("/a", GIB, 0), "cgroup/a/b/cgroup.controllers": "cpu\n" });
    expect(await readLinuxMemoryAvailability(t)).toMatchObject({ effectiveBytes: GIB });
  });

  it("charges usage already inside the cgroup: remaining is limit minus current, never negative", async () => {
    const t = await tree({ ...base("0::/a\n"), ...rootCtl, ...level("/a", GIB, 2 * GIB) });
    expect(await readLinuxMemoryAvailability(t)).toMatchObject({ cgroupRemainingBytes: 0, effectiveBytes: 0 });
  });

  const valid = { ...base("0::/a\n"), ...rootCtl, ...level("/a", "max", 1) };

  it.each([
    // Authority: without an authenticated reference there is nothing but self-observation.
    ["no reference at all", valid, { reference: "none" }, "host_authority_not_installed"],
    ["a self-consistent sibling record pair created beside the reader (it is never read)", valid, { reference: "none", siblingPair: true }, "host_authority_not_installed"],
    ["a private cgroup namespace whose own root produced a fully consistent reference", valid, { ns: "private" }, "host_reference_namespace_mismatch"],
    ["a private cgroup namespace with an apparent root \"/\" and no reference", { ...base("0::/\n"), ...rootCtl }, { ns: "private", reference: "none" }, "host_authority_not_installed"],
    // Stale or substituted references against the live host.
    ["a reference recorded for another boot", valid, { reference: (l: HostMemoryReference) => ({ ...l, bootId: OTHER_BOOT }) }, "host_reference_stale_boot"],
    ["a reference recorded for another machine", valid, { reference: (l: HostMemoryReference) => ({ ...l, machineId: "f".repeat(32) }) }, "host_reference_machine_mismatch"],
    ["a different namespace handle than the one recorded", valid,
      { reference: (l: HostMemoryReference) => ({ ...l, topology: { ...l.topology, cgroupNamespace: { ...l.topology.cgroupNamespace, dev: "999999" } } }) }, "host_reference_namespace_mismatch"],
    ["a hierarchy root replaced after the reference was recorded", valid,
      { reference: (l: HostMemoryReference) => ({ ...l, topology: { ...l.topology, hierarchyRoot: { ...l.topology.hierarchyRoot, ino: "999999999999" } } }) }, "host_reference_hierarchy_mismatch"],
    ["a reference naming a different mapping of the hierarchy", valid,
      { reference: (l: HostMemoryReference) => ({ ...l, topology: { ...l.topology, mountPoint: "/elsewhere" } }) }, "host_reference_hierarchy_mismatch"],
    // Complete-hierarchy proof: never pick a "visible" row by order, never trust the root identity alone.
    ["two competing mount rows at the hierarchy path", valid, { mount: "competing" }, "cgroup_mount_ambiguous"],
    ["a tighter outer ancestor hidden by a nested mount while the root row and identity are unchanged", { ...base("0::/a/b\n"), ...rootCtl, ...level("/a", "max", 1), ...level("/a/b", "max", 1) }, { mount: "nested-overmount" }, "cgroup_nested_mount"],
    ["a mount over an ancestor path of the hierarchy", valid, { mount: "ancestor-overmount" }, "cgroup_ancestor_overmounted"],
    ["a mount that is a subtree of the real hierarchy (ancestors hidden)", valid, { mount: "v2-subtree" }, "cgroup_mount_is_subtree"],
    ["a hierarchy not mounted where the limits would be read", valid, { mount: "elsewhere" }, "cgroup_mount_unproven"],
    ["no cgroup mount at all", valid, { mount: "none" }, "cgroup_mount_unproven"],
    // cgroup structure.
    ["a leaf directory that is missing under the assumed mount", { ...base("0::/a/b\n"), ...rootCtl, ...level("/a", "max", 1) }, {}, "unreadable"],
    ["an intermediate directory that is missing", { ...base("0::/a/b/c\n"), ...rootCtl, ...level("/a", "max", 1), ...level("/a/b/c", "max", 1) }, {}, "unreadable"],
    ["a memory-enabled level without memory.max", { ...base("0::/a\n"), ...rootCtl, "cgroup/a/cgroup.controllers": "memory\n" }, {}, "unreadable"],
    ["a memory-enabled level with usage unreadable", { ...base("0::/a\n"), ...rootCtl, "cgroup/a/cgroup.controllers": "memory\n", "cgroup/a/memory.max": "1024" }, {}, "unreadable"],
    ["an unparseable memory.max", { ...base("0::/a\n"), ...rootCtl, ...level("/a", "garbage", 1) }, {}, "unparseable"],
    ["an oversize kernel file", { ...base("0::/a\n"), ...rootCtl, ...level("/a", "1".repeat(70 * 1024), 1) }, {}, "oversize"],
    ["memory re-enabled below a level that disabled it", { ...base("0::/a/b\n"), ...rootCtl, "cgroup/a/cgroup.controllers": "cpu\n", ...level("/a/b", GIB, 0) }, {}, "cgroup_v2_controller_state_inconsistent"],
    ["no MemAvailable", { "proc/meminfo": "MemTotal: 1 kB\n", "proc/self/cgroup": "0::/\n", ...rootCtl }, {}, "meminfo_mem_available_missing"],
    ["an unresolved hierarchy", base("3:cpu:/x\n"), {}, "cgroup_hierarchy_unresolved"],
    ["a traversing cgroup path", { ...base("0::/a/../../etc\n"), ...rootCtl }, {}, "cgroup_path_invalid"],
    ["a malformed cgroup file", base("garbage\n"), {}, "proc_self_cgroup_invalid"],
    // v1 and hybrid are refused FIRST: nothing may pretend to prove them, with or without a reference.
    ["cgroup v1 memory (even with a valid reference)", base("5:memory:/x/y\n4:cpu:/x/y\n"), {}, "cgroup_v1_unsupported"],
    ["cgroup v1 memory with no reference (refused before the reference is consulted)", base("5:memory:/x\n"), { reference: "none" }, "cgroup_v1_unsupported"],
    ["a hybrid host where memory is a v1 controller", base("12:memory:/m\n0::/unified\n"), {}, "cgroup_v1_unsupported"],
  ] as const)("refuses to guess with %s", async (_name, files, options, reason) => {
    await expect(readLinuxMemoryAvailability(await tree(files, options))).rejects.toThrow(`linux_memory_unknown:${reason}`);
  });

  it("refuses when the process is observed in a different cgroup after the limits were read", async () => {
    const t = await tree(valid);
    await expect(readLinuxMemoryAvailability({ ...t, afterLimitsRead: async () => { await writeFile(join(t.procRoot!, "self", "cgroup"), "0::/other\n"); } }))
      .rejects.toThrow("linux_memory_unknown:cgroup_membership_changed");
  });

  it("refuses when the namespace handle is replaced during measurement", async () => {
    const t = await tree(valid);
    await expect(readLinuxMemoryAvailability({ ...t, afterLimitsRead: async () => {
      await unlink(join(t.procRoot!, "self", "ns", "cgroup")); await writeFile(join(t.procRoot!, "self", "ns", "cgroup"), "");
    } })).rejects.toThrow("linux_memory_unknown:host_topology_changed");
  });

  it("refuses when the hierarchy root is replaced during measurement", async () => {
    const t = await tree(valid);
    await expect(readLinuxMemoryAvailability({ ...t, afterLimitsRead: async () => {
      await rename(t.cgroupRoot!, `${t.cgroupRoot}.old`); await mkdir(t.cgroupRoot!);
    } })).rejects.toThrow("linux_memory_unknown:host_topology_changed");
  });

  it("refuses when an overmount appears over the hierarchy during measurement", async () => {
    const t = await tree(valid);
    await expect(readLinuxMemoryAvailability({ ...t, afterLimitsRead: async () => {
      const row = (id: number, parent: number, point: string) => `${id} ${parent} 0:30 / ${point} rw - cgroup2 cgroup2 rw\n`;
      await writeFile(join(t.procRoot!, "self", "mountinfo"), `22 1 8:1 / / rw - ext4 /dev/sda rw\n${row(36, 22, t.cgroupRoot!)}${row(37, 36, join(t.cgroupRoot!, "a"))}`);
    } })).rejects.toThrow("linux_memory_unknown:cgroup_nested_mount");
  });

  it("refuses when the mount chain of the hierarchy changes during measurement", async () => {
    const t = await tree(valid);
    await expect(readLinuxMemoryAvailability({ ...t, afterLimitsRead: async () => {
      await writeFile(join(t.procRoot!, "self", "mountinfo"), `21 1 8:1 / / rw - ext4 /dev/sda rw\n36 22 0:30 / ${t.cgroupRoot} rw - cgroup2 cgroup2 rw\n`);
    } })).rejects.toThrow("linux_memory_unknown:host_mount_topology_changed");
  });

  it("refuses when a level directory is replaced while its files are read", async () => {
    const t = await tree(valid);
    await expect(readLinuxMemoryAvailability({ ...t, afterLimitsRead: async () => {
      await rename(join(t.cgroupRoot!, "a"), join(t.cgroupRoot!, "a.old")); await mkdir(join(t.cgroupRoot!, "a"));
    } })).rejects.toThrow("linux_memory_unknown:cgroup_level_replaced");
  });
});
