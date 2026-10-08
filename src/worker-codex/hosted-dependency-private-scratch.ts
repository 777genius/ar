import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, readSync, writeFileSync, fsyncSync, readdirSync, readlinkSync, unlinkSync, rmdirSync } from "node:fs";
import { basename, join } from "node:path";
import { ChildProcess } from "node:child_process";
import { withHostedActivationFence, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { HostedDependencyRootPurpose, assertCurrentHostedDependencyRootPurpose,
  HostedDependencyRootDescriptorRecipe, openCurrentHostedDependencyRootDescriptor, type HostedDependencyRootDescriptor,
  type HostedDependencyRootPurposeContext, type HostedDependencyManagedGitScope } from "./hosted-dependency-root-purpose";

export enum HostedDependencyScratchStrategy { PrivateUnmountedV1 = "private_unmounted_v1" }
type DirectoryPin = HostedDependencyManagedGitScope["scratchParent"];
type ScratchOperations = Readonly<Pick<HostedDependencyPrivateScratch, "paths" | "pathsWithHeldFence" | "observeChild" | "settleChild">>;
const scratchOperations = new WeakMap<HostedDependencyPrivateScratch, ScratchOperations>();
function fail(): never { throw new Error("dependency_private_scratch_held"); }
function kernelText(path: string, maximum: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunks: Buffer[] = []; let total = 0;
  try {
    while (true) {
      const chunk = Buffer.alloc(Math.min(4096, maximum + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count; if (total > maximum) return fail(); chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { closeSync(fd); }
}
function mountId(fd: number): string {
  const bytes = kernelText(`/proc/self/fdinfo/${fd}`, 4096);
  const ids = [...bytes.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
  if (bytes.length > 4096 || ids.length !== 1) return fail();
  return ids[0]![1]!;
}
function processFields(pid: number): Readonly<{ parent: string; birth: string }> {
  const stat = kernelText(`/proc/${pid}/stat`, 4096), end = stat.lastIndexOf(")");
  if (end < 1 || !stat.startsWith(String(pid) + " (")) return fail();
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const parent = fields[1], birth = fields[19];
  if (parent === undefined || birth === undefined || !/^[1-9][0-9]*$/.test(parent) || !/^[1-9][0-9]*$/.test(birth)) return fail();
  return { parent, birth };
}
function noMounts(path: string): void {
  const table = kernelText("/proc/self/mountinfo", 8 * 1024 * 1024);
  if (table.length > 8 * 1024 * 1024) return fail();
  for (const line of table.trimEnd().split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 10 || !fields.includes("-") || !fields[4]) return fail();
    if (/\\(?!040|011|012|134)/.test(fields[4])) return fail();
    const point = fields[4].replace(/\\(040|011|012|134)/g, (_, digits: string) => String.fromCharCode(parseInt(digits, 8)));
    if (point === path || point.startsWith(path + "/")) return fail();
  }
}
function directory(context: HostedDependencyRootPurposeContext, fence: HostedActivationFence, path: string,
  expected?: DirectoryPin): { pin: DirectoryPin; resource: HostedDependencyRootDescriptor } {
  const named = lstatSync(path, { bigint: true });
  if (!named.isDirectory() || named.isSymbolicLink() || named.uid !== 0n || named.gid !== 0n ||
      (named.mode & 0o7777n) !== 0o700n || realpathSync(path) !== path) return fail();
  const resource = openCurrentHostedDependencyRootDescriptor(context, fence, HostedDependencyRootDescriptorRecipe.DirectoryV1, path);
  const fd = resource.fd;
  try {
    const opened = fstatSync(fd, { bigint: true });
    const pin = { canonicalPath: path, dev: opened.dev.toString(), ino: opened.ino.toString(), mountId: mountId(fd) };
    if (!opened.isDirectory() || opened.dev !== named.dev || opened.ino !== named.ino ||
        expected && (pin.dev !== expected.dev || pin.ino !== expected.ino || pin.mountId !== expected.mountId)) return fail();
    noMounts(path);
    return { pin, resource };
  } catch (error) { resource.close(); throw error; }
}
/** This is a retained resource identity, never authority. Every method requires
 * the same genuine B purpose again; a copied path or resource cannot permit IO. */
export class HostedDependencyPrivateScratch {
  readonly strategy = HostedDependencyScratchStrategy.PrivateUnmountedV1;
  readonly #context: HostedDependencyRootPurposeContext;
  readonly #pin: DirectoryPin;
  readonly #resource: HostedDependencyRootDescriptor;
  #closed = false;
  #uncertain = false;
  readonly #children = new Map<ChildProcess, { readonly pid: number; readonly birth: string; closed: boolean }>();
  private constructor(context: HostedDependencyRootPurposeContext, pin: DirectoryPin, resource: HostedDependencyRootDescriptor) {
    this.#context = context; this.#pin = pin; this.#resource = resource;
  }
  static prepare(context: HostedDependencyRootPurposeContext): HostedDependencyPrivateScratch {
    return withHostedActivationFence(fence => {
      const scope = assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
      const parent = directory(context, fence, scope.scratchParent.canonicalPath, scope.scratchParent);
      try {
        const path = mkdtempSync(join(parent.pin.canonicalPath, "git-"));
        const child = directory(context, fence, path);
        try {
          if (child.pin.dev !== parent.pin.dev || child.pin.mountId !== parent.pin.mountId) return fail();
          mkdirSync(join(path, "objects"), { mode: 0o700 });
          const objects = directory(context, fence, join(path, "objects")); objects.resource.close();
          assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
          const snapshot = new HostedDependencyPrivateScratch(context, child.pin, child.resource); Object.freeze(snapshot);
          scratchOperations.set(snapshot, Object.freeze({ paths: fixedScratchMethods.paths.bind(snapshot),
            pathsWithHeldFence: fixedScratchMethods.pathsWithHeldFence.bind(snapshot), observeChild: fixedScratchMethods.observeChild.bind(snapshot),
            settleChild: fixedScratchMethods.settleChild.bind(snapshot) }));
          return snapshot;
        } catch (error) { child.resource.close(); throw error; }
      } finally { parent.resource.close(); }
    });
  }
  paths(context: HostedDependencyRootPurposeContext): Readonly<{ temporaryDirectory: string; indexPath: string; objectDirectory: string }> {
    return this.#paths(context);
  }
  #paths(context: HostedDependencyRootPurposeContext): Readonly<{ temporaryDirectory: string; indexPath: string; objectDirectory: string }> {
    if (context !== this.#context || this.#closed) return fail();
    return withHostedActivationFence(fence => this.#pathsWithHeldFence(context, fence));
  }
  pathsWithHeldFence(context: HostedDependencyRootPurposeContext, fence: HostedActivationFence): Readonly<{ temporaryDirectory: string; indexPath: string; objectDirectory: string }> {
    return this.#pathsWithHeldFence(context, fence);
  }
  #pathsWithHeldFence(context: HostedDependencyRootPurposeContext, fence: HostedActivationFence): Readonly<{ temporaryDirectory: string; indexPath: string; objectDirectory: string }> {
    if (context !== this.#context || this.#closed) return fail();
      const scope = assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
      if (!this.#pin.canonicalPath.startsWith(scope.scratchParent.canonicalPath + "/git-")) return fail();
      const retained = fstatSync(this.#resource.fd, { bigint: true });
      if (retained.dev.toString() !== this.#pin.dev || retained.ino.toString() !== this.#pin.ino || mountId(this.#resource.fd) !== this.#pin.mountId) return fail();
      const named = directory(context, fence, this.#pin.canonicalPath, this.#pin); named.resource.close();
      const objects = directory(context, fence, join(this.#pin.canonicalPath, "objects"));
      try { if (objects.pin.dev !== this.#pin.dev || objects.pin.mountId !== this.#pin.mountId) return fail(); }
      finally { objects.resource.close(); }
      return Object.freeze({ temporaryDirectory: this.#pin.canonicalPath,
        indexPath: join(this.#pin.canonicalPath, "index"), objectDirectory: join(this.#pin.canonicalPath, "objects") });
  }
  copyLiveIndex(context: HostedDependencyRootPurposeContext, sourceIndexPath: string, sharedIndexPath?: string): void {
    const paths = this.#paths(context);
    withHostedActivationFence(fence => {
      const scope = assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
      if (sourceIndexPath !== join(scope.workspace.canonicalPath, ".git/index") || sharedIndexPath !== undefined &&
          (sharedIndexPath !== join(scope.workspace.canonicalPath, ".git", basename(sharedIndexPath)) ||
           !/^sharedindex\.[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(basename(sharedIndexPath)))) return fail();
      for (const [source, target] of [[sourceIndexPath, paths.indexPath],
        ...(sharedIndexPath === undefined ? [] : [[sharedIndexPath, join(paths.temporaryDirectory, basename(sharedIndexPath))]])]) {
        if (!source || !target) return fail();
        const sourceResource = openCurrentHostedDependencyRootDescriptor(context, fence, HostedDependencyRootDescriptorRecipe.GitIndexV1, source);
        const fd = sourceResource.fd;
        try {
          const stat = fstatSync(fd, { bigint: true });
          if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n || stat.size > 32n * 1024n * 1024n) return fail();
          assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
          const bytes = Buffer.alloc(Number(stat.size)); let offset = 0;
          while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, null); if (count === 0) return fail(); offset += count; }
          const confirmed = fstatSync(fd, { bigint: true }), named = lstatSync(source, { bigint: true });
          if (confirmed.dev !== stat.dev || confirmed.ino !== stat.ino || confirmed.size !== stat.size || confirmed.mtimeNs !== stat.mtimeNs ||
              named.dev !== stat.dev || named.ino !== stat.ino || named.size !== stat.size || named.mtimeNs !== stat.mtimeNs || realpathSync(source) !== source) return fail();
          assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
          writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
          const written = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
          try { fsyncSync(written); } finally { closeSync(written); }
        } finally { sourceResource.close(); }
      }
      assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
    });
  }
  observeChild(context: HostedDependencyRootPurposeContext, child: ChildProcess): void {
    if (context !== this.#context || this.#closed || !(child instanceof ChildProcess)) return fail();
    const pid = child.pid;
    if (pid === undefined || !Number.isSafeInteger(pid) || pid < 1 || this.#children.has(child)) { this.#uncertain = true; return; }
    let birth: string;
    try {
      const fields = processFields(pid);
      if (fields.parent !== String(process.pid)) return fail(); birth = fields.birth;
    } catch { this.#uncertain = true; return; }
    const record = { pid, birth, closed: false }; this.#children.set(child, record);
    child.once("close", () => { record.closed = true; });
  }
  settleChild(context: HostedDependencyRootPurposeContext, child: ChildProcess): void {
    if (context !== this.#context || this.#closed) return fail();
    const record = this.#children.get(child);
    if (!record || !record.closed || child.exitCode === null || child.signalCode !== null) this.#uncertain = true;
    try { this.#paths(context); } catch (error) { this.#uncertain = true; throw error; }
  }
  close(context: HostedDependencyRootPurposeContext): void {
    this.#paths(context);
    if (this.#uncertain) return fail();
    withHostedActivationFence(fence => {
      assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
      for (const [child, record] of this.#children) {
        if (!record.closed || child.exitCode === null || child.signalCode !== null) return fail();
        try { if (processFields(record.pid).birth === record.birth) return fail(); }
        catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
      }
      const fresh = directory(context, fence, this.#pin.canonicalPath, this.#pin); fresh.resource.close();
      const files: string[] = [], directories: string[] = []; let bytes = 0;
      const visit = (path: string, relative: string): void => {
        const entries = readdirSync(path);
        if (files.length + directories.length + entries.length > 10_240) return fail();
        for (const entry of entries) {
          const name = relative ? relative + "/" + entry : entry;
          const absolute = join(path, entry), stat = lstatSync(absolute, { bigint: true });
          if (stat.isSymbolicLink() || stat.uid !== 0n || stat.gid !== 0n || stat.dev.toString() !== this.#pin.dev ||
              (stat.mode & 0o022n) !== 0n || realpathSync(absolute) !== absolute) return fail();
          if (stat.isDirectory()) {
            if (name !== "objects" && !/^objects\/[a-f0-9]{2}$/.test(name)) return fail();
            visit(absolute, name); directories.push(absolute);
          } else {
            if (!stat.isFile() || stat.nlink !== 1n || !/^(?:index|sharedindex\.[a-f0-9]{40}(?:[a-f0-9]{24})?|objects\/[a-f0-9]{2}\/[a-f0-9]{38}(?:[a-f0-9]{24})?)$/.test(name)) return fail();
            bytes += Number(stat.size);
            if (!Number.isSafeInteger(bytes) || bytes > 256 * 1024 * 1024) return fail();
            files.push(absolute);
          }
        }
      };
      visit(this.#pin.canonicalPath, "");
      this.#resource.close(); this.#closed = true;
      const descriptors = readdirSync("/proc/self/fd");
      if (descriptors.length > 4096) return fail();
      for (const descriptor of descriptors) {
        let path: string;
        try { path = readlinkSync(`/proc/self/fd/${descriptor}`); }
        catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue; throw error; }
        if (path === this.#pin.canonicalPath || path.startsWith(this.#pin.canonicalPath + "/")) return fail();
      }
      noMounts(this.#pin.canonicalPath);
      assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
      for (const path of files) unlinkSync(path);
      for (const path of directories) rmdirSync(path);
      rmdirSync(this.#pin.canonicalPath);
      assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
    });
  }
}
// Capture the fixed implementation once, before consumers can mutate public
// prototypes. Issued bound operations never dispatch through caller properties.
const fixedScratchMethods: ScratchOperations = Object.freeze({ paths: HostedDependencyPrivateScratch.prototype.paths,
  pathsWithHeldFence: HostedDependencyPrivateScratch.prototype.pathsWithHeldFence,
  observeChild: HostedDependencyPrivateScratch.prototype.observeChild, settleChild: HostedDependencyPrivateScratch.prototype.settleChild });
export function readHostedDependencyPrivateScratchOperations(snapshot: HostedDependencyPrivateScratch): ScratchOperations {
  const operations = scratchOperations.get(snapshot); if (!operations) return fail(); return operations;
}
export function prepareHostedDependencyPrivateScratch(context: HostedDependencyRootPurposeContext): HostedDependencyPrivateScratch {
  return HostedDependencyPrivateScratch.prepare(context);
}

const environments = new WeakMap<NodeJS.ProcessEnv, { context: HostedDependencyRootPurposeContext; snapshot: HostedDependencyPrivateScratch }>();
/** Environment is a fixed data projection of an actual retained resource. It
 * grants nothing without fresh authentication of the same B context. */
export function managedDependencyPrivateIndexEnvironment(context: HostedDependencyRootPurposeContext, snapshot: HostedDependencyPrivateScratch): NodeJS.ProcessEnv {
  const paths = readHostedDependencyPrivateScratchOperations(snapshot).paths(context);
  const env = Object.freeze({ GIT_INDEX_FILE: paths.indexPath, GIT_OBJECT_DIRECTORY: paths.objectDirectory });
  environments.set(env, { context, snapshot }); return env;
}
export function readManagedDependencyPrivateIndex(context: HostedDependencyRootPurposeContext, env: NodeJS.ProcessEnv): HostedDependencyPrivateScratch {
  const actual = environments.get(env);
  if (!actual || actual.context !== context) return fail();
  readHostedDependencyPrivateScratchOperations(actual.snapshot).paths(context); return actual.snapshot;
}
