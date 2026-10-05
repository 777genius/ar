import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, statfsSync } from "node:fs";
import type { DependencyWorkspaceIdentity } from "@vioxen/subscription-runtime/core";
import { collectProcessBirth } from "./hosted-readonly-linux-collector";
import { readDependencyTreeEffectReferenceAnchors, type DependencyTreeEffectReferenceSession } from "../worker-local/dependency-environment/dependency-tree-effects";

/** Factual veto across the finite installed/retained cgroups selected by the
 * trusted transaction. This is neither a host inventory nor admission proof.
 * Missing/changing process/namespace observations remain unresolved. */
export enum DependencyReferenceEffect { Eviction = "eviction", TrashRemoval = "trash_removal" }
export function assertHostedDependencyReferenceVeto(workspace: DependencyWorkspaceIdentity, trashPath: string,
  controlGroups: readonly string[], effect: DependencyReferenceEffect,
  ownEffect?: { readonly session: DependencyTreeEffectReferenceSession; readonly operationId: string }): void {
  if (process.platform !== "linux" || controlGroups.length > 256 ||
      statfsSync("/sys/fs/cgroup", { bigint: true }).type !== 0x63677270n) fail();
  const deadline = performance.now() + 10000;
  function withinBudget(): void { if (performance.now() > deadline) fail(); }
  const roots = effect === DependencyReferenceEffect.Eviction ? [workspace.canonicalPath + "/node_modules", trashPath] : [trashPath];
  const before = pids(controlGroups, withinBudget);
  if (!before.includes(String(process.pid))) fail(); // Actual supervisor must be covered, not an empty invented inventory.
  const ownAnchors = ownEffect ? readDependencyTreeEffectReferenceAnchors(ownEffect.session,
    { workspace, trashPath, operationId: ownEffect.operationId }) : [];
  const ownMounts = readFileSync("/proc/self/mountinfo", "utf8");
  observeHostedDependencyMountReferences(ownMounts, ownMounts, roots);
  for (const pid of before) {
    withinBudget();
    const birth = collectProcessBirth(pid), nsPath = `/proc/${pid}/ns/mnt`;
    const namespace = readlinkSync(nsPath), namespaceFd = openSync(nsPath, constants.O_RDONLY);
    try {
      const nsStat = fstatSync(namespaceFd), mounts = readFileSync(`/proc/${pid}/mountinfo`, "utf8");
      const observation = observeHostedDependencyMountReferences(ownMounts, mounts, roots);
      for (const name of ["cwd", "root", "exe"]) if (observation.references(readlinkSync(`/proc/${pid}/${name}`))) fail();
      const descriptorSnapshot = (): string[] => {
        const names = readdirSync(`/proc/${pid}/fd`);
        if (names.length > 4096 || names.some(fd => !/^[0-9]+$/.test(fd) || Number(fd) >= 4096)) fail();
        if (pid !== String(process.pid)) return names.sort();
        // Reading our own fd directory temporarily opens a sampler descriptor.
        // Observe the actual bounded table with fstat after that sampler closes;
        // no missing descriptor from another process is ever ignored.
        const live: string[] = [];
        for (let fd = 0; fd < 4096; fd++) {
          withinBudget();
          try { fstatSync(fd); live.push(String(fd)); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== "EBADF") throw e; }
        }
        return live.sort();
      };
      const descriptors = descriptorSnapshot();
      if (descriptors.length > 4096) fail();
      for (const fd of descriptors) {
        withinBudget();
        if (!/^[0-9]+$/.test(fd)) fail();
        if (observation.references(readlinkSync(`/proc/${pid}/fd/${fd}`)) &&
            !(pid === String(process.pid) && ownAnchors.some(anchor => anchor.fd === Number(fd)))) fail();
      }
      const maps = readFileSync(`/proc/${pid}/maps`, "utf8");
      if (maps.length > 8 * 1024 * 1024) fail();
      for (const line of maps.split("\n")) {
        const path = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/.exec(line)?.[1];
        if (path?.startsWith("/") && observation.references(unescapePath(path))) fail();
      }
      const after = fstatSync(namespaceFd);
      if (collectProcessBirth(pid) !== birth || readlinkSync(nsPath) !== namespace ||
          nsStat.dev !== after.dev || nsStat.ino !== after.ino ||
          readFileSync(`/proc/${pid}/mountinfo`, "utf8") !== mounts ||
          JSON.stringify(descriptorSnapshot()) !== JSON.stringify(descriptors)) fail();
    } finally { closeSync(namespaceFd); }
  }
  if (JSON.stringify(pids(controlGroups, withinBudget)) !== JSON.stringify(before)) fail();
  if (readFileSync("/proc/self/mountinfo", "utf8") !== ownMounts) fail();
  if (ownEffect) readDependencyTreeEffectReferenceAnchors(ownEffect.session, { workspace, trashPath, operationId: ownEffect.operationId });
  withinBudget();
}

function pids(groups: readonly string[], withinBudget: () => void): string[] {
  const result = new Set<string>(), visited = new Set<string>();
  function walk(path: string): void {
    withinBudget();
    if (visited.has(path)) return;
    if (visited.size >= 512) fail(); visited.add(path);
    let before;
    try { before = lstatSync(path, { bigint: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    if (!before.isDirectory()) fail();
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const retained = fstatSync(fd, { bigint: true }), anchored = `/proc/self/fd/${fd}`;
      if (before.dev !== retained.dev || before.ino !== retained.ino) fail();
      const processes = readFileSync(anchored + "/cgroup.procs", "utf8");
      if (processes.length > 65536) fail();
      for (const pid of processes.trim().split(/\s+/).filter(Boolean)) {
        if (!/^[1-9][0-9]{0,9}$/.test(pid) || result.size >= 2048) fail(); result.add(pid);
      }
      const children = readdirSync(anchored).filter(name => lstatSync(anchored + "/" + name).isDirectory()).sort();
      for (const name of children) walk(path + "/" + name);
      const after = lstatSync(path, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || readFileSync(anchored + "/cgroup.procs", "utf8") !== processes) fail();
    } finally { closeSync(fd); }
  }
  for (const group of groups) {
    if (!/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(group)) fail();
    walk("/sys/fs/cgroup" + group);
  }
  return [...result].sort();
}
function unescapePath(path: string): string { return path.replace(/\\([0-7]{3})/g, (_, value: string) => String.fromCharCode(parseInt(value, 8))); }
type MountRow = { readonly id: string; readonly device: string; readonly root: string; readonly point: string };
function mountRows(text: string): MountRow[] {
  if (!text || text.length > 8 * 1024 * 1024) fail();
  const rows = text.trim().split("\n").map(line => {
    const fields = line.split(" "), separator = fields.indexOf("-");
    const id = fields[0], device = fields[2], root = fields[3], point = fields[4];
    if (separator < 6 || !id || !/^[0-9]+$/.test(id) || !device || !/^[0-9]+:[0-9]+$/.test(device) || !root || !point) fail();
    const row = { id, device, root: unescapePath(root), point: unescapePath(point) };
    for (const path of [row.root, row.point]) if (!path.startsWith("/") ||
      (path !== "/" && path.slice(1).split("/").some(part => !part || part === "." || part === ".."))) fail();
    return row;
  });
  if (new Set(rows.map(row => row.id)).size !== rows.length) fail();
  return rows;
}
function contains(root: string, path: string): boolean { return root === "/" || path === root || path.startsWith(root + "/"); }
function filesystemPath(rows: readonly MountRow[], path: string): { mount: MountRow; path: string } {
  const matches = rows.filter(row => contains(row.point, path)).sort((a, b) => b.point.length - a.point.length);
  const row = matches[0];
  if (!row || matches[1]?.point === row.point) fail(); // Stacked/ambiguous visible mapping is unsupported.
  const suffix = row.point === "/" ? path : path.slice(row.point.length);
  return { mount: row, path: (row.root === "/" ? suffix || "/" : row.root + suffix) };
}
/** Pure factual mount-analysis boundary used by the real collector. It cannot
 * authenticate a namespace, reader, grant or mutation authority. */
export function observeHostedDependencyMountReferences(ownMountinfo: string, namespaceMountinfo: string,
  roots: readonly string[]): { references(path: string): boolean } {
  if (!roots.length || roots.some(path => !path.startsWith("/") || path === "/")) fail();
  const own = mountRows(ownMountinfo), observed = mountRows(namespaceMountinfo);
  const physical = roots.map(path => filesystemPath(own, path));
  for (const row of observed) {
    if (roots.some(root => contains(root, row.point))) fail();
    for (const target of physical) {
      if (row.device !== target.mount.device || (!contains(row.root, target.path) && !contains(target.path, row.root))) continue;
      // Preserve the actual canonical primary mapping, including an nspawn
      // subdirectory root. A secondary '/' alias is never this mapping.
      if (row.root !== target.mount.root || row.point !== target.mount.point ||
          observed.filter(other => other.point === row.point).length !== 1) fail();
    }
  }
  return { references(rawPath: string): boolean {
    const path = rawPath.replace(/ \(deleted\)$/, "");
    if (!path.startsWith("/")) return false;
    // proc readlink may render d_path relative to the collector's root, while
    // maps can use the observed process view. Neither rendering may erase a veto.
    if (roots.some(root => contains(root, path))) return true;
    const actual = [filesystemPath(own, path), filesystemPath(observed, path)];
    return actual.some(reference => physical.some(target => reference.mount.device === target.mount.device && contains(target.path, reference.path)));
  } };
}
function fail(): never { throw new Error("dependency_reference_observation_unresolved"); }
