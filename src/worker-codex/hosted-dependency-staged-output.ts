import { closeSync, constants, fchownSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, type BigIntStats } from "node:fs";
import { DependencyAdmissionError, DependencyAdmissionFailure, DependencyManifestEntryKind as Kind,
  DependencyTreeObservationStatus, type DependencyCapturedTreeObservation, type DependencyWorkspaceIdentity } from "@vioxen/subscription-runtime/worker-core";
import { hostedDependencyInstallerUid } from "./hosted-dependency-installer-identity";

type Complete = Extract<DependencyCapturedTreeObservation, { status: DependencyTreeObservationStatus.Complete }>;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const leaf = (fd: number, name: Buffer): Buffer => Buffer.concat([Buffer.from(`/proc/self/fd/${fd}/`), name]);
function fail(): never { throw new DependencyAdmissionError(DependencyAdmissionFailure.UnsafeTree); }
function mount(fd: number): string {
  const matches = [...readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").matchAll(/^mnt_id:\s*([1-9][0-9]*)$/gm)];
  if (matches.length !== 1) fail();
  return matches[0]![1]!;
}
function name(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length < 1 || bytes.length > 255 || bytes.includes(0) || bytes.includes(47) || bytes.equals(Buffer.from(".")) || bytes.equals(Buffer.from(".."))) fail();
  return bytes;
}
function same(stat: BigIntStats, identity: { dev: string; ino: string }): boolean { return String(stat.dev) === identity.dev && String(stat.ino) === identity.ino; }
function openRoot(workspace: DependencyWorkspaceIdentity): number {
  const fd = openSync(workspace.canonicalPath, directoryFlags);
  if (!same(fstatSync(fd, { bigint: true }), workspace)) { closeSync(fd); fail(); }
  return fd;
}

/** Filesystem effect only: caller must have retained actual installer drain and
 * exclusive physical-workspace ownership. This does not supply either proof.
 * Only the independently captured fresh staged tree is touched; raw names stay
 * raw, existing source, .git and unknown node_modules are never normalized. */
export function normalizeCapturedDependencyOutput(observation: Complete, expectedUid: number): void {
  if (process.platform !== "linux" || !Number.isSafeInteger(expectedUid) || expectedUid < 0) fail();
  const identities = new Map(observation.identities.map(item => [JSON.stringify(item.path), item]));
  if (identities.size !== observation.entries.length) fail();
  // Reject the complete captured mode set before the first ownership effect.
  for (const entry of observation.entries) {
    if (entry.kind !== Kind.Symlink && ((entry.mode & ~0o777) !== 0 || (entry.mode & 0o022) !== 0 ||
        (entry.mode & 0o400) === 0 || (entry.kind === Kind.Directory && (entry.mode & 0o700) !== 0o700))) fail();
  }
  const root = openRoot({ canonicalPath: `${observation.workspace.canonicalPath}/node_modules`, ...observation.tree });
  try {
    if (mount(root) !== observation.mountId) fail();
    for (const entry of observation.entries) {
      const identity = identities.get(JSON.stringify(entry.path));
      if (!identity || identity.mountId !== observation.mountId) fail();
      if (entry.kind === Kind.Symlink) continue; // Safe internal links need no ownership change.
      if ((entry.mode & ~0o777) !== 0 || (entry.mode & 0o022) !== 0 || (entry.mode & 0o400) === 0 ||
          (entry.kind === Kind.Directory && (entry.mode & 0o700) !== 0o700)) fail();
      const retained: number[] = [];
      let fd = root;
      try {
        for (const [index, part] of entry.path.entries()) {
          const last = index === entry.path.length - 1;
          const opened = openSync(leaf(fd, name(part)), last && entry.kind === Kind.File
            ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK : directoryFlags);
          retained.push(opened); fd = opened;
          const ancestor = identities.get(JSON.stringify(entry.path.slice(0, index + 1)));
          if (!ancestor || !same(fstatSync(fd, { bigint: true }), ancestor.identity) || mount(fd) !== observation.mountId) fail();
        }
        const before = fstatSync(fd, { bigint: true });
        if (!same(before, identity.identity) || Number(before.mode & 0o7777n) !== entry.mode ||
            (entry.kind === Kind.File ? !before.isFile() || before.nlink !== 1n || String(before.size) !== entry.size : !before.isDirectory()) ||
            (before.uid !== BigInt(hostedDependencyInstallerUid) && before.uid !== BigInt(expectedUid))) fail();
        fchownSync(fd, expectedUid, expectedUid);
        const after = fstatSync(fd, { bigint: true });
        if (!same(after, identity.identity) || after.uid !== BigInt(expectedUid) || Number(after.mode & 0o7777n) !== entry.mode) fail();
        fsyncSync(fd);
      } finally { for (const opened of retained.reverse()) closeSync(opened); }
    }
    fsyncSync(root);
  } finally { closeSync(root); }
}

/** Must run inside the real owner fence, after positive installer drain and
 * final staged inventory. The admitted namespace denies all untrusted writers
 * of these parents; host root remains trusted. Missing is checked through the
 * retained destination, never used as an unmanaged check-then-rename license. */
export function publishCapturedDependencyOutput(observation: Complete, workspace: DependencyWorkspaceIdentity): void {
  const source = openRoot(observation.workspace);
  let target: number | undefined;
  try {
    target = openRoot(workspace);
    if (mount(source) !== observation.mountId || mount(target) !== observation.mountId) fail();
    const sourcePath = leaf(source, Buffer.from("node_modules")), targetPath = leaf(target, Buffer.from("node_modules"));
    const stat = lstatSync(sourcePath, { bigint: true });
    if (!stat.isDirectory() || !same(stat, observation.tree)) fail();
    try { lstatSync(targetPath); fail(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    renameSync(sourcePath, targetPath);
    fsyncSync(source); fsyncSync(target);
    if (!same(lstatSync(targetPath, { bigint: true }), observation.tree)) fail();
  } finally { closeSync(source); if (target !== undefined) closeSync(target); }
}
