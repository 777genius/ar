import { CodexModelBackend } from "../../codex-model-backend";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { inspectKernelPathBacking, inspectKernelPathBackings, inspectKernelProcessPathBackings, type KernelPathBacking } from "../../../core/host-infrastructure/kernel-path-backing";
import { assertHostedActivationFence, decodeHostedActivationBytes, readHostedActivationBytes,
  readHostedOrdinaryProcessOrigin, withHostedActivationFence, type HostedActivationFence } from "./hosted-process-activation";

export enum HostedOrdinaryWriterProfile { LifetimeV1 = "ordinary-lifetime-rw-v1" }
type PathPin = Readonly<{ path: string; ancestor: string; device: number; inode: number; roots: readonly KernelPathBacking[] }>;
export type HostedOrdinaryWriterExtent = Readonly<{
  schemaVersion: 1; profile: HostedOrdinaryWriterProfile.LifetimeV1; startId: string; startSha256: string;
  runtimeSha: string; runtimeManifestSha256: string; inventorySha256: string; launchSha256: string;
  configSha256: string; taskId: string; promptPath: string; modelBackend: CodexModelBackend; registryRootDir: string | null;
  homes: readonly Readonly<{ home: string; codexHome: string }>[]; paths: readonly PathPin[];
  publication: Readonly<{ jobId: string; durableHandoffRootDir: string; paths: readonly PathPin[] }> | null;
}>;
function invalid(): never { throw new Error("hosted_ordinary_writer_extent_invalid"); }
export const ordinaryExtentHash = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const inside = (root: string, path: string): boolean => path === root || path.startsWith(root === "/" ? "/" : root + "/");
const canonical = (path: unknown): path is string => typeof path === "string" && isAbsolute(path) && resolve(path) === path;
function keys(value: unknown, expected: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== expected.split(",").sort().join(",")) invalid();
}
function hash(value: unknown): void { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid(); }

/** Existing ancestors stay pinned even while the planned leaf is absent. Only
 * ENOENT allows projection; a symlink, unreadable leaf or unsupported backing
 * cannot become prospective writable authority. */
export function observeOrdinaryWriterPath(path: string, retainParent = false): PathPin {
  if (!canonical(path) || path === "/") invalid();
  let ancestor = path;
  for (;;) {
    let before: ReturnType<typeof lstatSync>;
    try { before = lstatSync(ancestor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) invalid();
      ancestor = parent;
      continue;
    }
    if (before.isSymbolicLink() || realpathSync(ancestor) !== ancestor ||
        (!before.isDirectory() && (!before.isFile() || ancestor !== path || before.nlink !== 1))) invalid();
    const suffix = relative(ancestor, path);
    const roots = suffix ? [inspectKernelPathBacking(ancestor)].map(root => ({ device: root.device, backingPath: join(root.backingPath, suffix) }))
      : inspectKernelPathBackings(path);
    const after = lstatSync(ancestor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.ctimeMs !== before.ctimeMs) invalid();
    // The existing scratch owner may mount its predeclared source on this
    // target. Pin its stable parent, while retaining the original backing too.
    if (retainParent && ancestor === path) {
      ancestor = dirname(path);
      const pin = lstatSync(ancestor);
      if (!pin.isDirectory() || pin.isSymbolicLink() || realpathSync(ancestor) !== ancestor) invalid();
      return { path, ancestor, device: pin.dev, inode: pin.ino, roots };
    }
    return { path, ancestor, device: before.dev, inode: before.ino, roots };
  }
}

export function parseHostedOrdinaryWriterExtent(value: unknown): HostedOrdinaryWriterExtent {
  // Existing job-local seals remain readable; they grant no shared publication.
  if (value && typeof value === "object" && !("publication" in value)) value = { ...value, publication: null };
  keys(value, "schemaVersion,profile,startId,startSha256,runtimeSha,runtimeManifestSha256,inventorySha256,launchSha256,configSha256,taskId,promptPath,modelBackend,registryRootDir,homes,paths,publication");
  if (value.schemaVersion !== 1 || value.profile !== HostedOrdinaryWriterProfile.LifetimeV1 ||
      typeof value.startId !== "string" || !/^[a-f0-9-]{36}$/.test(value.startId) ||
      typeof value.runtimeSha !== "string" || !/^[a-f0-9]{40}$/.test(value.runtimeSha) ||
      typeof value.taskId !== "string" || !value.taskId || !canonical(value.promptPath) ||
      (value.registryRootDir !== null && !canonical(value.registryRootDir)) ||
      !Object.values(CodexModelBackend).includes(value.modelBackend as CodexModelBackend) || !Array.isArray(value.homes) || value.homes.length === 0 ||
      !Array.isArray(value.paths) || value.paths.length === 0) invalid();
  for (const field of ["startSha256", "runtimeManifestSha256", "inventorySha256", "launchSha256", "configSha256"]) hash(value[field]);
  for (const home of value.homes) { keys(home, "home,codexHome"); if (!canonical(home.home) || !canonical(home.codexHome)) invalid(); }
  let publicationPaths: unknown[] = [];
  if (value.publication !== null) {
    keys(value.publication, "jobId,durableHandoffRootDir,paths");
    if (typeof value.publication.jobId !== "string" || !value.publication.jobId ||
        !canonical(value.publication.durableHandoffRootDir) || !Array.isArray(value.publication.paths) || value.publication.paths.length === 0) invalid();
    publicationPaths = value.publication.paths;
  }
  for (const pin of [...value.paths, ...publicationPaths]) {
    keys(pin, "path,ancestor,device,inode,roots");
    if (!canonical(pin.path) || !canonical(pin.ancestor) || !inside(pin.ancestor, pin.path) ||
        !Number.isSafeInteger(pin.device) || (pin.device as number) < 0 || !Number.isSafeInteger(pin.inode) || (pin.inode as number) <= 0 || !Array.isArray(pin.roots) || pin.roots.length === 0) invalid();
    for (const root of pin.roots) {
      keys(root, "device,backingPath");
      if (typeof root.device !== "string" || !/^[0-9]+:[0-9]+$/.test(root.device) || !canonical(root.backingPath)) invalid();
    }
  }
  return value as unknown as HostedOrdinaryWriterExtent;
}

/** Private exact-start record. It never grants authority to a legacy start,
 * another creator or a later provider reservation with the same job id. */
export function readHostedOrdinaryWriterExtent(fence: HostedActivationFence, startId: string,
  startBytes: Buffer, installation: { readonly runtimeSha: unknown; readonly runtimeManifestSha256: unknown; readonly inventorySha256: unknown }): HostedOrdinaryWriterExtent | undefined {
  assertHostedActivationFence(fence);
  const bytes = readHostedActivationBytes(`ordinary-starts/${startId}.extent.json`);
  if (!bytes) return undefined;
  const extent = parseHostedOrdinaryWriterExtent(decodeHostedActivationBytes(bytes));
  if (extent.startId !== startId || extent.startSha256 !== ordinaryExtentHash(startBytes) ||
      extent.runtimeSha !== installation.runtimeSha || extent.runtimeManifestSha256 !== installation.runtimeManifestSha256 ||
      extent.inventorySha256 !== installation.inventorySha256) invalid();
  return extent;
}

export function assertHostedOrdinaryWriterPaths(extent: HostedOrdinaryWriterExtent, paths: readonly string[]): void {
  const roots = extent.paths.flatMap(pin => pin.roots);
  for (const pin of extent.paths) {
    const actual = lstatSync(pin.ancestor);
    if (actual.isSymbolicLink() || actual.dev !== pin.device || actual.ino !== pin.inode || realpathSync(pin.ancestor) !== pin.ancestor) invalid();
  }
  for (const path of paths) {
    // Logical membership and physical containment are both necessary. A new
    // alias under the job root cannot acquire an unsealed scratch/store extent.
    if (!extent.paths.some(pin => inside(pin.path, path))) invalid();
    for (const current of observeOrdinaryWriterPath(path).roots) {
      if (!roots.some(root => root.device === current.device && inside(root.backingPath, current.backingPath))) invalid();
    }
  }
}

/** Shared creator publications are cold pinned separately from provider writes.
 * Only the existing registry/packet owners use this bounded destination check. */
export function assertHostedOrdinaryPublicationPaths(extent: HostedOrdinaryWriterExtent, paths: readonly string[]): void {
  assertHostedOrdinaryWriterPaths(extent, extent.paths.map(pin => pin.path));
  if (!extent.publication) { assertHostedOrdinaryWriterPaths(extent, paths); return; }
  assertHostedOrdinaryWriterPaths({ ...extent, paths: extent.publication.paths }, paths);
  for (const path of paths) {
    const pin = extent.publication.paths.filter(pin => inside(pin.path, path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!pin || pin.roots.length !== 1) invalid();
    const root = pin.roots[0]!, expected = join(root.backingPath, relative(pin.path, path));
    for (const current of observeOrdinaryWriterPath(path).roots) {
      if (current.device !== root.device || current.backingPath !== expected) invalid();
    }
  }
}
export function assertHostedOrdinaryRegistryPublication(registryRootDir: string, lockRootDir: string, paths: readonly string[] = [], jobRootDir?: string): void {
  withCurrentOrdinaryExtent((extent, originalJobRoot) => {
    if (extent.registryRootDir !== registryRootDir || (jobRootDir !== undefined && jobRootDir !== originalJobRoot)) invalid();
    if (extent.publication) {
      const jobDir = join(registryRootDir, extent.publication.jobId), manifest = join(jobDir, "job.json");
      for (const path of paths) if (path !== registryRootDir && path !== jobDir && path !== manifest &&
          !(path.startsWith(join(jobDir, ".job.json.")) && path.endsWith(".tmp")) && !inside(lockRootDir, path)) invalid();
    }
    assertHostedOrdinaryPublicationPaths(extent, [registryRootDir, lockRootDir, ...paths]);
  });
}

/** Raw effect guard for trusted built-in writers. It neither suppresses nor
 * adopts the independent quota daemon into the job's provider reservation. */
export function assertHostedOrdinaryEffectPaths(paths: readonly string[]): void {
  withCurrentOrdinaryExtent(extent => assertHostedOrdinaryWriterPaths(extent, paths));
}
export function currentHostedOrdinaryWriterExtent(): HostedOrdinaryWriterExtent | undefined {
  let current: HostedOrdinaryWriterExtent | undefined;
  withCurrentOrdinaryExtent(extent => { current = extent; });
  return current;
}
function withCurrentOrdinaryExtent(action: (extent: HostedOrdinaryWriterExtent, jobRootDir: string) => void): void {
  if (process.platform !== "linux") return;
  const routed = /^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-ordinary-([a-f0-9-]{36})\.service$/.exec(readFileSync("/proc/self/cgroup", "utf8").trim());
  if (!routed) return;
  withHostedActivationFence(fence => {
    // Cgroup only selects whether a protected modern seal exists. It grants no
    // authority; positive guards below still resolve the actual original owner.
    // Legacy diagnostics/disposal must retain their original revocation behavior.
    if (!readHostedActivationBytes(`ordinary-starts/${routed[1]}.extent.json`)) return;
    const origin = readHostedOrdinaryProcessOrigin(fence), startId = origin.reservation.startId as string;
    const bytes = readHostedActivationBytes(`ordinary-starts/${startId}.json`);
    if (!bytes) invalid();
    const extent = readHostedOrdinaryWriterExtent(fence, startId, bytes, origin.installation as { runtimeSha: unknown; runtimeManifestSha256: unknown; inventorySha256: unknown });
    if (!extent) return; // Unsupported legacy allocations stay Unknown in census.
    const start = decodeHostedActivationBytes(bytes);
    if (typeof start.jobRootDir !== "string") invalid();
    action(extent, start.jobRootDir);
  });
}

/** Production materializer seam before mkdir, cache preparation or auth/config writes. */
export function assertHostedOrdinaryMaterializedHome(home: string, codexHome: string): void {
  withCurrentOrdinaryExtent(extent => {
    if (!extent.homes.some(row => row.home === home && row.codexHome === codexHome)) invalid();
    assertHostedOrdinaryWriterPaths(extent, [home, codexHome, join(codexHome, "plugins/cache"),
      join(codexHome, "cache/remote_plugin_catalog")]);
  });
}

/** Final acquired provider namespace must reach only the sealed physical roots,
 * including every writable child mount below the actual job root. */
export function assertHostedOrdinaryProviderNamespace(extent: HostedOrdinaryWriterExtent, pid: number, pin: HostedOrdinaryProviderJobRoot): void {
  const roots = extent.paths.flatMap(pin => pin.roots);
  for (const current of inspectKernelProcessPathBackings(pid, pin.path, pin)) {
    if (!roots.some(root => root.device === current.device && inside(root.backingPath, current.backingPath))) invalid();
  }
}
export type HostedOrdinaryProviderJobRoot = Readonly<{ path: string; device: number; inode: number }>;
