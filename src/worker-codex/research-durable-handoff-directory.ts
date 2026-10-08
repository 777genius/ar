import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { researchInvalid, researchPath, researchRecord } from "./research-launch-files";
import { researchCommand } from "./research-launch-host";

/** A cold initial-host mount witness. Runtime bind aliases confer no authority. */
export type ResearchDurableDirectory = Readonly<{
  path: string; device: number; inode: number; mountId: number;
  mountDevice: string; mountRoot: string; mountPoint: string; filesystemUuid: string;
}>;
export function parseResearchDurableDirectory(value: unknown, path: string): ResearchDurableDirectory {
  const r = researchRecord(value, "path,device,inode,mountId,mountDevice,mountRoot,mountPoint,filesystemUuid");
  if (r.path !== path || !Number.isSafeInteger(r.device) || (r.device as number) < 0 ||
      !Number.isSafeInteger(r.inode) || (r.inode as number) < 1 ||
      !Number.isSafeInteger(r.mountId) || (r.mountId as number) < 1 ||
      typeof r.mountDevice !== "string" || !/^\d+:\d+$/.test(r.mountDevice) ||
      typeof r.filesystemUuid !== "string" || !/^[a-fA-F0-9-]{8,128}$/.test(r.filesystemUuid)) researchInvalid();
  for (const key of ["mountRoot", "mountPoint"] as const) {
    if (r[key] !== "/") researchPath(r[key]);
  }
  if (r.mountPoint !== "/" && path !== r.mountPoint && !path.startsWith(r.mountPoint + "/")) researchInvalid();
  return Object.freeze(r) as ResearchDurableDirectory;
}
export function researchDurableDirectory(path: string, privateLeaf = true): ResearchDurableDirectory {
  researchPath(path);
  // /proc/1/root intentionally selects the initial Host's directory rather than
  // the runtime's pinned target alias. Never follow links below that fixed root.
  const assertCustody = (): void => { for (let current = path;; current = dirname(current)) {
    const stat = lstatSync("/proc/1/root" + current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) ||
        (privateLeaf && current === path && (stat.mode & 0o777) !== 0o700)) researchInvalid();
    if (current === "/") break;
  } };
  assertCustody();
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const fd = openSync("/proc/1/root" + path, flags);
  try {
    const stat = fstatSync(fd), info = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) || privateLeaf && (stat.mode & 0o777) !== 0o700 || info.length > 4096) researchInvalid();
    const ids = [...info.matchAll(/^mnt_id:\s+([1-9]\d*)$/gm)];
    if (ids.length !== 1) researchInvalid();
    const mountId = Number(ids[0]![1]);
    const rows = coldMountTable().trimEnd().split("\n")
      .filter(row => row.split(" ", 1)[0] === String(mountId));
    if (rows.length !== 1) researchInvalid();
    const parts = rows[0]!.split(" "), separator = parts.indexOf("-");
    if (separator < 6 || parts.length !== separator + 4 || !/^(?:0|[1-9]\d*)$/.test(parts[1] ?? "") ||
        !/^\d+:\d+$/.test(parts[2] ?? "") || !/^[a-zA-Z0-9_,.=:-]+$/.test(parts[5] ?? "") ||
        parts.slice(6, separator).some(field => !/^(?:shared|master|propagate_from):[1-9]\d*$|^unbindable$/.test(field)) ||
        !/^[a-zA-Z0-9_.-]+$/.test(parts[separator + 1] ?? "") || /[\0\r\n\\]/.test(parts[separator + 2] ?? "") ||
        !/^[a-zA-Z0-9_,.=:-]+$/.test(parts[separator + 3] ?? "")) researchInvalid();
    const query: unknown = JSON.parse(researchCommand("/usr/bin/findmnt", ["--kernel", "--task", "1", "--json", "--target", path,
      "--output", "ID,TARGET,UUID,FSROOT,MAJ:MIN"]));
    if (!query || typeof query !== "object" || !("filesystems" in query) || !Array.isArray(query.filesystems) || query.filesystems.length !== 1) researchInvalid();
    const row = researchRecord(query.filesystems[0], "id,target,uuid,fsroot,maj:min");
    const device = BigInt(stat.dev), major = (device >> 8n & 0xfffn) | (device >> 32n & 0xfffff000n), minor = (device & 0xffn) | (device >> 12n & 0xffffff00n);
    if (`${major}:${minor}` !== parts[2]) researchInvalid();
    if (Number(row.id) !== mountId || row.target !== parts[4] || row.fsroot !== parts[3] || row["maj:min"] !== parts[2]) researchInvalid();
    // Native accepted paths contain no escapes; ambiguous mount rows fail closed.
    const witness = parseResearchDurableDirectory({ path, device: stat.dev, inode: stat.ino, mountId,
      mountDevice: parts[2], mountRoot: parts[3], mountPoint: parts[4], filesystemUuid: row.uuid }, path);
    const fresh = lstatSync("/proc/1/root" + path);
    assertCustody();
    if (fresh.dev !== witness.device || fresh.ino !== witness.inode || privateLeaf && (fresh.mode & 0o777) !== 0o700) researchInvalid();
    const reopened = openSync("/proc/1/root" + path, flags);
    try {
      const reopenedStat = fstatSync(reopened), freshInfo = readFileSync(`/proc/self/fdinfo/${reopened}`, "utf8");
      const freshIds = [...freshInfo.matchAll(/^mnt_id:\s+([1-9]\d*)$/gm)];
      const currentRows = coldMountTable().trimEnd().split("\n")
        .filter(row => row.split(" ", 1)[0] === String(mountId));
      if (!reopenedStat.isDirectory() || reopenedStat.uid !== 0 || (reopenedStat.mode & 0o022) ||
          privateLeaf && (reopenedStat.mode & 0o777) !== 0o700 ||
          reopenedStat.dev !== witness.device || reopenedStat.ino !== witness.inode || freshIds.length !== 1 ||
          Number(freshIds[0]![1]) !== mountId || currentRows.length !== 1 || currentRows[0] !== rows[0]) researchInvalid();
    } finally { closeSync(reopened); }
    return witness;
  } finally { closeSync(fd); }
}
function coldMountTable(): string {
  const table = readFileSync("/proc/1/mountinfo", "utf8");
  if (table.length > 8 * 1024 * 1024) researchInvalid();
  return table;
}
export function assertResearchDurableDirectory(identity: ResearchDurableDirectory): void {
  if (JSON.stringify(researchDurableDirectory(identity.path)) !== JSON.stringify(identity)) researchInvalid();
}
export function sameResearchDurableBacking(source: ResearchDurableDirectory, pin: ResearchDurableDirectory): boolean {
  const backing = (value: ResearchDurableDirectory): string => join(value.mountRoot, relative(value.mountPoint, value.path));
  return source.device === pin.device && source.inode === pin.inode && source.mountDevice === pin.mountDevice && source.filesystemUuid === pin.filesystemUuid &&
    backing(source) === backing(pin) && pin.mountPoint === pin.path;
}
