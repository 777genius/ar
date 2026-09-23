import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Observed kernel facts only. This is not offline or rescue authorization. */
export type ColdSourceObservation = {
  readonly bootId: string;
  readonly mountPoint: string;
  readonly mountRoot: string;
  readonly mountSource: string;
  readonly device: string;
  readonly filesystem: string;
};
type MountFacts = { readonly point: string; readonly root: string; readonly device: string;
  readonly options: readonly string[]; readonly filesystem: string; readonly source: string;
  readonly superOptions: readonly string[] };

/** Pure check of mountinfo facts; never an offline authority decision. */
export function matchesColdMountFacts(mount: MountFacts, bootId: string,
  expected: ColdSourceObservation): boolean {
  return !!expected && /^[0-9a-f-]{36}$/.test(bootId) &&
    mount.point === expected.mountPoint && mount.root === expected.mountRoot &&
    mount.source === expected.mountSource && mount.device === expected.device &&
    mount.filesystem === expected.filesystem && expected.bootId === bootId &&
    mount.options.includes("ro") && mount.superOptions.includes("ro") &&
    /^\d+:\d+$/.test(mount.device) && mount.source.startsWith("/dev/");
}

function refuse(): never { throw new Error("cold_maintenance_source_not_readonly_or_identity_changed"); }
function decodeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}
function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Check the caller's mount namespace and every visible underlying block device.
 * The Host must separately prove trusted rescue boot/control and source quiescence.
 */
export async function observeColdReadOnlySource(sourceRoot: string,
  expected: ColdSourceObservation): Promise<ColdSourceObservation> {
  if (!isAbsolute(sourceRoot) || resolve(sourceRoot) !== sourceRoot ||
      await realpath(sourceRoot) !== sourceRoot || !(await stat(sourceRoot)).isDirectory()) refuse();
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
  const allMounts = mountInfo.trimEnd().split("\n").map((line) => {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || fields.length < separator + 4) refuse();
    const [device, root, point, options] = fields.slice(2, 6);
    const [filesystem, source, superOptions] = fields.slice(separator + 1, separator + 4);
    if (device === undefined || root === undefined || point === undefined || options === undefined ||
        filesystem === undefined || source === undefined || superOptions === undefined) refuse();
    return { point: decodeMountField(point), root: decodeMountField(root), device,
      options: options.split(","), filesystem, source: decodeMountField(source),
      superOptions: superOptions.split(",") };
  });
  // A nested mount could replace one selected file's backing storage.
  if (allMounts.some((mount) => mount.point !== sourceRoot && contains(sourceRoot, mount.point))) refuse();
  const mounts = allMounts.filter((mount) => contains(mount.point, sourceRoot))
    .sort((a, b) => b.point.length - a.point.length);
  const mount = mounts[0];
  if (!mount || mount.point !== sourceRoot ||
      !matchesColdMountFacts(mount, bootId, expected)) refuse();
  await checkReadOnlyBlockDevice(mount.device);
  const observed = { bootId, mountPoint: mount.point, mountRoot: mount.root,
    mountSource: mount.source, device: mount.device, filesystem: mount.filesystem };
  return observed;
}

/** Traverse partition parents and stacked backing devices; sysfsRoot permits synthetic fixtures. */
export async function checkReadOnlyBlockDevice(device: string,
  sysfsRoot = "/sys/dev/block"): Promise<void> {
  const active = new Set<string>();
  const verified = new Set<string>();
  async function checkSysfs(device: string): Promise<void> {
    if (!/^\d+:\d+$/.test(device) || active.has(device)) refuse();
    if (verified.has(device)) return;
    if (active.size + verified.size >= 32) refuse();
    active.add(device);
    try {
      const base = join(sysfsRoot, device);
      if ((await readFile(`${base}/ro`, "utf8")).trim() !== "1") refuse();
      let partition = false;
      try { partition = /^\d+$/.test((await readFile(`${base}/partition`, "utf8")).trim()); }
      catch (e) { if (!isCode(e, "ENOENT")) throw e; }
      if (partition) {
        const parent = dirname(await realpath(base));
        await checkSysfs((await readFile(join(parent, "dev"), "utf8")).trim());
      }
      let slaves: string[];
      try { slaves = await readdir(`${base}/slaves`); }
      catch (e) { if (!partition || !isCode(e, "ENOENT")) throw e; slaves = []; }
      for (const child of slaves) {
        if (!/^[A-Za-z0-9_.-]+$/.test(child)) refuse();
        const next = (await readFile(`${base}/slaves/${child}/dev`, "utf8")).trim();
        await checkSysfs(next);
      }
      verified.add(device);
    } finally { active.delete(device); }
  }
  await checkSysfs(device);
}
function isCode(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === code;
}
