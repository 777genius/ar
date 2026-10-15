import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readFileSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { FullBackingInstallationContract, readOriginalHostedDependencyBackingStage } from "../provider-codex/app-server/adapters/hosted-full-backing-stage";

const policy = "/var/lib/subscription-runtime-host-policy";
const storage = policy + "/dependency-test-jobs";
export enum HostedDependencyScratchLayoutKind { Existing = "existing", OriginalFull = "original_full" }
export enum HostedDependencyScratchDirectory { Parent = "parent", Quarantine = "quarantine", Trash = "trash" }
export type HostedDependencyScratchLayout = Readonly<{ kind: HostedDependencyScratchLayoutKind; parent: string; quarantine: string; trash: string }>;
function held(): never { throw new Error("hosted_dependency_scratch_layout_held"); }
/** A source-backed installation fact, not a caller-selected layout or grant.
 * This must remain lazy: importing a receipt/history reader performs no I/O. */
export function readHostedDependencyScratchLayout(runtimeSha: string): HostedDependencyScratchLayout {
  const stage = readOriginalHostedDependencyBackingStage();
  if (!/^[a-f0-9]{40}$/.test(runtimeSha) || stage.runtimeSha !== runtimeSha) held();
  if (stage.schemaVersion === 1) return Object.freeze({ kind: HostedDependencyScratchLayoutKind.Existing,
    parent: policy, quarantine: policy + "/dependency-quarantine", trash: policy + "/dependency-trash" });
  if (stage.schemaVersion !== 2 || stage.backingInterval !== FullBackingInstallationContract.OriginalParentProcV1) held();
  // A conflicting old tree is retained, never silently migrated or classified
  // as missing in the new fixed namespace. Empty old directories are harmless.
  for (const path of [policy + "/dependency-quarantine", policy + "/dependency-trash"]) {
    let stat: BigIntStats;
    try { stat = lstatSync(path, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0n || stat.gid !== 0n ||
        (stat.mode & 0o7777n) !== 0o700n || realpathSync(path) !== path) {
      throw new Error("hosted_dependency_scratch_layout_legacy_retained");
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const directory = opendirSync(`/proc/self/fd/${fd}`);
      try { if (directory.readSync()) throw new Error("hosted_dependency_scratch_layout_legacy_retained"); }
      finally { directory.closeSync(); }
      for (const after of [fstatSync(fd, { bigint: true }), lstatSync(path, { bigint: true })])
        if (after.dev !== stat.dev || after.ino !== stat.ino || after.mode !== stat.mode || after.uid !== stat.uid ||
            after.gid !== stat.gid || after.nlink !== stat.nlink || after.ctimeNs !== stat.ctimeNs || after.mtimeNs !== stat.mtimeNs) held();
      if (realpathSync(path) !== path) held();
    } finally { closeSync(fd); }
  }
  return Object.freeze({ kind: HostedDependencyScratchLayoutKind.OriginalFull, parent: storage,
    quarantine: storage + "/dependency-quarantine", trash: storage + "/dependency-trash" });
}
export type HostedDependencyScratchDirectoryPin = Readonly<{ canonicalPath: string; dev: string; ino: string; mountId: string }>;
function mount(fd: number): string {
  const bytes = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"), rows = [...bytes.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
  if (Buffer.byteLength(bytes) > 65536 || rows.length !== 1 || !rows[0]?.[1]) held();
  return rows[0]![1]!;
}
/** Read-only physical rejoin. The original issuers alone create/fsync roots;
 * the low-level operation retains the actual same-mount rename anchors. */
export function readHostedDependencyScratchDirectoryPin(runtimeSha: string, directory: HostedDependencyScratchDirectory): HostedDependencyScratchDirectoryPin {
  const layout = readHostedDependencyScratchLayout(runtimeSha), path = directory === HostedDependencyScratchDirectory.Parent ? layout.parent :
    directory === HostedDependencyScratchDirectory.Quarantine ? layout.quarantine : directory === HostedDependencyScratchDirectory.Trash ? layout.trash : held();
  for (let ancestor = path;; ancestor = dirname(ancestor)) {
    const s = lstatSync(ancestor, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0n || s.gid !== 0n || (s.mode & 0o022n)) held();
    if (ancestor === "/") break;
  }
  if (realpathSync(path) !== path) held();
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true }), id = mount(fd);
    if (s.dev !== named.dev || s.ino !== named.ino || s.mode !== named.mode || s.uid !== 0n || s.gid !== 0n ||
        (s.mode & 0o022n) || directory !== HostedDependencyScratchDirectory.Parent && (s.mode & 0o7777n) !== 0o700n) held();
    const fresh = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const again = fstatSync(fresh, { bigint: true }), after = lstatSync(path, { bigint: true });
      for (const value of [again, after, fstatSync(fd, { bigint: true })])
        if (value.dev !== s.dev || value.ino !== s.ino || value.mode !== s.mode || value.uid !== s.uid || value.gid !== s.gid ||
            value.nlink !== s.nlink || value.ctimeNs !== s.ctimeNs || value.mtimeNs !== s.mtimeNs) held();
      if (mount(fresh) !== id || mount(fd) !== id || realpathSync(path) !== path) held();
    } finally { closeSync(fresh); }
    return Object.freeze({ canonicalPath: path, dev: String(s.dev), ino: String(s.ino), mountId: id });
  } finally { closeSync(fd); }
}
