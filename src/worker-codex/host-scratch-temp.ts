import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { inspectVisibleScratchMount, type ScratchMount } from "./host-scratch-mount.js";

const CONFIG_PATH = "/etc/subscription-runtime/scratch-temp.json";
type Info = { uid: number; mode: number; dev: number; ino: number; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };
type Mount = ScratchMount;
type Policy = { root: string; uuid: string; legacyTemps: Record<string, unknown> };
export interface ScratchTempHost {
  lstat(path: string): Info;
  realpath(path: string): string;
  read(path: string): string;
  inspectMount(path: string): Mount | undefined;
  statfs(path: string): { bavail: number; bsize: number };
  mkdir(path: string, mode: number): void;
  chmod(path: string, mode: number): void;
  removeLock(path: string): void;
  entries(path: string): readonly string[];
  bind(source: string, target: string): void;
  uid: number;
}
const systemHost: ScratchTempHost = {
  lstat: lstatSync,
  realpath: realpathSync,
  read: (path) => readFileSync(path, "utf8"),
  inspectMount: inspectVisibleScratchMount,
  statfs: statfsSync,
  mkdir: (path, mode) => { mkdirSync(path, { mode }); },
  chmod: chmodSync,
  removeLock: rmdirSync,
  entries: readdirSync,
  bind: (source, target) => { execFileSync("mount", ["--bind", source, target]); },
  uid: process.getuid?.() ?? 0,
};
function readPolicy(host: ScratchTempHost): Policy | undefined {
  const info = optionalInfo(CONFIG_PATH, host);
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) throw new Error("Scratch config must be a root-owned regular file without group/other writes");
  assertAncestors(dirname(CONFIG_PATH), host);
  const config: unknown = JSON.parse(host.read(CONFIG_PATH));
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid scratch config");
  const { schemaVersion, root, uuid, legacyTemps = {} } = config as Record<string, unknown>;
  if (schemaVersion !== 1 || typeof root !== "string" || !isAbsolute(root) || root === "/" || resolve(root) !== root || typeof uuid !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(uuid) || !legacyTemps || typeof legacyTemps !== "object" || Array.isArray(legacyTemps)) throw new Error("Invalid scratch schema, root, UUID or legacy map");
  assertAncestors(root, host);
  const mount = host.inspectMount(root);
  if (mount?.target !== root || mount.uuid?.toLowerCase() !== uuid.toLowerCase() || mount.fsroot !== "/") throw new Error("Scratch mount target, UUID or filesystem root mismatch");
  for (const volume of ["/", root]) {
    const { bavail, bsize } = host.statfs(volume);
    const available = bavail * bsize;
    if (!Number.isFinite(available) || bavail < 0 || bsize <= 0 || available < 5 * 1024 ** 3) throw new Error(`Scratch launch requires at least 5 GiB available on ${volume}`);
  }
  return { root, uuid, legacyTemps: legacyTemps as Record<string, unknown> };
}
function sourceLayout(policy: Policy, target: string, family: string, host: ScratchTempHost) {
  assertDirectory(join(policy.root, family), host);
  const fsroot = `/${family}/${createHash("sha256").update(target).digest("hex")}`;
  return { source: join(policy.root, fsroot.slice(1)), fsroot };
}
/** Validation only; no parsing-time filesystem mutations. */
export function resolveHostScratchTempRoot(jobRootDir: string, host: ScratchTempHost = systemHost) {
  const policy = readPolicy(host);
  if (!policy) return undefined;
  assertCanonical(jobRootDir);
  return { ...sourceLayout(policy, jobRootDir, "runtime-tmp", host), uuid: policy.uuid };
}
/** Actual-run hook retaining the provider's logical jobRoot/tmp contract. */
export async function prepareHostScratchTemp(jobRootDir: string, sourceEnv: Readonly<Record<string, string | undefined>>, host: ScratchTempHost = systemHost): Promise<void> {
  if (sourceEnv.SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH === "1") return;
  const policy = readPolicy(host);
  if (!policy) return;
  assertDirectory(jobRootDir, host);
  const target = join(jobRootDir, "tmp");
  if (sourceEnv.SUBSCRIPTION_RUNTIME_TMPDIR !== undefined && sourceEnv.SUBSCRIPTION_RUNTIME_TMPDIR !== target) throw new Error("Host scratch requires logical jobRoot/tmp; explicit TMPDIR spill rejected");
  bindTarget(policy, target, "runtime-tmp", host, jobRootDir);
}
/** Invoked under the retained-home materializer lease, before credential writes. */
export async function prepareHostScratchCaches(codexHome: string, sourceEnv: Readonly<Record<string, string | undefined>>, host: ScratchTempHost = systemHost): Promise<void> {
  if (sourceEnv.SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH === "1") return;
  const policy = readPolicy(host);
  if (!policy) return;
  assertDirectory(codexHome, host);
  for (const [parentName, leaf] of [["plugins", "cache"], ["cache", "remote_plugin_catalog"]]) {
    const parent = join(codexHome, parentName!);
    if (!optionalInfo(parent, host)) {
      if (host.uid !== 0) throw new Error("Root privilege required to prepare scratch cache parents");
      host.mkdir(parent, 0o700);
    }
    assertDirectory(parent, host);
    bindTarget(policy, join(parent, leaf!), "runtime-caches", host);
  }
}
/** Read-only facts for an independent provider namespace. Never prepares a mount
 * or accepts caller-selected targets; all three leaves must already be prepared. */
export function resolvePreparedHostScratchBinds(jobRootDir: string, codexHome: string, host: ScratchTempHost = systemHost): readonly { source: string; target: string }[] {
  const policy = readPolicy(host);
  if (!policy) return [];
  assertDirectory(jobRootDir, host); assertDirectory(codexHome, host);
  const binds: { source: string; target: string }[] = [];
  for (const [target, family, hashInput] of [
    [join(jobRootDir, "tmp"), "runtime-tmp", jobRootDir],
    [join(codexHome, "plugins/cache"), "runtime-caches", join(codexHome, "plugins/cache")],
    [join(codexHome, "cache/remote_plugin_catalog"), "runtime-caches", join(codexHome, "cache/remote_plugin_catalog")],
  ] as const) {
    assertDirectory(dirname(target), host);
    const prepared = preparedTarget(policy, target, sourceLayout(policy, hashInput, family, host), host);
    if (prepared === undefined) throw new Error("Selected scratch target is not prepared");
    if (prepared) {
      // A replaced source can leave a valid-looking old bind behind. Require the
      // physical source to still name the exact mounted directory, not its replacement.
      assertPreparedSourceIdentity(prepared, host);
      binds.push(prepared);
    }
  }
  return binds;
}
/** Observe only existing mounts at the two fixed cache leaves. An absent leaf
 * grants no authority; selected provider homes still use the all-three resolver. */
export function resolvePreparedHostScratchCacheBinds(codexHome: string, host: ScratchTempHost = systemHost): readonly { source: string; target: string }[] {
  const policy = readPolicy(host);
  if (!policy) return [];
  assertDirectory(codexHome, host);
  const binds: { source: string; target: string }[] = [];
  for (const suffix of ["plugins/cache", "cache/remote_plugin_catalog"]) {
    const target = join(codexHome, suffix);
    if (!host.inspectMount(target)) continue;
    assertDirectory(dirname(target), host);
    const prepared = preparedTarget(policy, target, sourceLayout(policy, target, "runtime-caches", host), host);
    if (!prepared) throw new Error("Observed scratch cache mount changed");
    assertPreparedSourceIdentity(prepared, host);
    binds.push(prepared);
  }
  return binds;
}
function assertPreparedSourceIdentity(prepared: { source: string; target: string }, host: ScratchTempHost): void {
  const source = host.lstat(prepared.source), mounted = host.lstat(prepared.target);
  if (source.dev !== mounted.dev || source.ino !== mounted.ino) throw new Error("Prepared scratch source identity changed");
}
function matchesScratchMount(policy: Policy, target: string, fsroot: string, mount: Mount | undefined): boolean {
  return mount?.target === target && mount.uuid?.toLowerCase() === policy.uuid.toLowerCase() && mount.fsroot === fsroot;
}
function preparedTarget(policy: Policy, target: string, layout: { source: string; fsroot: string }, host: ScratchTempHost): { source: string; target: string } | null | undefined {
  const info = optionalInfo(target, host);
  if (info) assertDirectory(target, host);
  const mount = host.inspectMount(target);
  if (mount) {
    if (!matchesScratchMount(policy, target, layout.fsroot, mount)) throw new Error("Unknown mount at scratch target");
    assertPrivateSource(layout.source, host);
    return { source: layout.source, target };
  }
  if (Object.prototype.hasOwnProperty.call(policy.legacyTemps, target)) {
    const entry = policy.legacyTemps[target] as { device?: unknown; inode?: unknown } | null;
    if (!entry || typeof entry !== "object" || !Number.isSafeInteger(entry.device) || !Number.isSafeInteger(entry.inode) || (entry.device as number) <= 0 || (entry.inode as number) <= 0) throw new Error("Invalid selected legacy temp identity");
    if (!info || info.dev !== entry.device || info.ino !== entry.inode) throw new Error("Legacy scratch target device/inode changed");
    return null;
  }
  return undefined;
}
function bindTarget(policy: Policy, target: string, family: string, host: ScratchTempHost, hashInput = target): void {
  assertCanonical(target);
  const layout = sourceLayout(policy, hashInput, family, host);
  const checkExisting = () => {
    const prepared = preparedTarget(policy, target, layout, host);
    if (prepared !== undefined) {
      if (prepared) assertPreparedSourceIdentity(prepared, host);
      return true;
    }
    if (optionalInfo(target, host) && host.entries(target).length !== 0) throw new Error("Refusing to hide nonempty legacy scratch directory");
    return false;
  };
  if (checkExisting()) return;
  if (host.uid !== 0) throw new Error("Root privilege required to prepare scratch bind mount");
  const lock = `${layout.source}.lock`;
  try { host.mkdir(lock, 0o700); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Scratch bind target busy"); throw error; }
  try {
    if (checkExisting()) return;
    if (!optionalInfo(layout.source, host)) host.mkdir(layout.source, 0o701);
    assertPrivateSource(layout.source, host);
    host.chmod(layout.source, 0o701);
    if (!optionalInfo(target, host)) host.mkdir(target, 0o701);
    assertDirectory(target, host);
    host.chmod(target, 0o701);
    host.bind(layout.source, target);
    if (!matchesScratchMount(policy, target, layout.fsroot, host.inspectMount(target))) throw new Error("Scratch bind mount verification failed");
    assertPreparedSourceIdentity({ source: layout.source, target }, host);
  } finally { host.removeLock(lock); }
}
function optionalInfo(path: string, host: ScratchTempHost): Info | undefined {
  try { return host.lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function assertCanonical(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Scratch requires canonical absolute paths");
}
function assertDirectory(path: string, host: ScratchTempHost): void {
  assertCanonical(path);
  const info = host.lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) || host.realpath(path) !== path) throw new Error(`Unsafe scratch directory: ${path}`);
}
function assertAncestors(path: string, host: ScratchTempHost): void {
  const parent = dirname(path);
  if (parent !== path) assertAncestors(parent, host);
  assertDirectory(path, host);
}
function assertPrivateSource(path: string, host: ScratchTempHost): void {
  assertDirectory(path, host);
  if (host.lstat(path).mode & 0o066) throw new Error(`Unsafe scratch source permissions: ${path}`);
}
