import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readFileSync, readSync, statfsSync, type BigIntStats } from "node:fs";
import { lstat, open, opendir, readFile, statfs, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { detectSecretLikeContent } from "../../worker-core/secret-detection";
import { DependencyInstallKeyError, DependencyNpmLockName } from "../../worker-core/dependency-environment/domain/dependency-install-key";
import {
  DependencyLocalClosureKind as Kind, describeDependencyLocalManifest, qualifyDependencyNpmLocalClosure,
  resolveDependencyLocalFileSpec, validateDependencyLocalCopiedInput,
  type DependencyLocalCopiedFile, type DependencyLocalPackage, type DependencyNpmLocalClosure,
} from "../../worker-core/dependency-environment/domain/dependency-local-closure";
import type { DependencyWorkspaceIdentity } from "../../worker-core/dependency-environment/domain/dependency-receipt";
import { NpmInputCaptureStatus as Status, NpmInputCaptureReason as Reason, type NpmInputRevalidation } from "./capture-npm-install-inputs";

export enum NpmLocalPinKind { Directory = "directory", File = "file" }
export enum NpmLocalWatchKind { All = "all", Mandatory = "mandatory" }
export type NpmLocalInputPin = {
  readonly path: string; readonly kind: NpmLocalPinKind; readonly dev: string; readonly ino: string;
  readonly mode: string; readonly mountId: string; readonly size?: string;
};
export type QualifiedNpmLocalInputs = {
  readonly status: Status.Qualified; readonly workspace: DependencyWorkspaceIdentity; readonly lockName: DependencyNpmLockName;
  readonly packageBytes: Uint8Array; readonly lockBytes: Uint8Array; readonly closure: DependencyNpmLocalClosure;
  readonly pins: readonly NpmLocalInputPin[];
  readonly ancestorPins: readonly NpmLocalInputPin[];
  readonly absentPaths: readonly string[];
  readonly watches: readonly { readonly path: string; readonly kind: NpmLocalWatchKind; readonly names: readonly string[] }[];
  readonly closureDigest: string;
};
export type NpmLocalInputCapture = QualifiedNpmLocalInputs |
  { readonly status: Status.Unsupported | Status.Unknown; readonly reason: Reason };
class CaptureFailure extends Error {
  constructor(readonly status: Status.Unsupported | Status.Unknown, readonly reason: Reason) { super(`npm_local_input_capture:${reason}`); }
}
function unknown(reason: Reason): never { throw new CaptureFailure(Status.Unknown, reason); }
function unsupported(reason: Reason = Reason.UnsupportedClosure): never { throw new CaptureFailure(Status.Unsupported, reason); }
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const at = (fd: number, name: string): string => `/proc/self/fd/${fd}${name ? "/" + name : ""}`;
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a: BigIntStats, b: BigIntStats): boolean => same(a, b) && a.nlink === b.nlink &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const mandatory = (name: string): boolean => /^(?:readme|copying|license|licence)(?:\..*[^~$])?$/i.test(name);
function errno(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
function safeName(name: string): void {
  if (!name || name.length > 255 || Buffer.from(name).toString() !== name || detectSecretLikeContent(name) ||
      /[\x00-\x1f\x7f/\\*?!\[\]{}]/.test(name) || name === "." || name === "..") unsupported();
}
function excluded(path: string): boolean {
  const parts = path.toLowerCase().split("/"), base = parts.at(-1)!;
  return parts.some((part) => [".git", ".svn", ".hg", "cvs", "node_modules", ".ds_store", ".ssh"].includes(part) || part.startsWith("._")) ||
    [".npmignore", ".gitignore", ".npmrc", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "npm-debug.log", "auth.json"].includes(base) ||
    /^\..*\.swp$|\.orig$|^\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$|^id_(?:rsa|ed25519)$/.test(base) ||
    path.toLowerCase() === ".lock-wscript" || path.toLowerCase().startsWith(".wafpickle-") ||
    path.toLowerCase() === "build/config.gypi" || parts[0] === "archived-packages";
}
async function present(path: string): Promise<BigIntStats | null> {
  try { return await lstat(path, { bigint: true }); } catch (error) { if (errno(error) === "ENOENT") return null; throw error; }
}
type Anchor = { handle: FileHandle; info: BigIntStats; mount: string; path: string; parent?: Anchor; name?: string };
type Captured = { anchor: Anchor; info: BigIntStats; mount: string; path: string; name: string; bytes?: Uint8Array; handle?: FileHandle };

/** Factual finite capture only. Original input enumeration precedes staged
 * verification. The caller must hold real source/creator exclusion; this
 * observation never supplies admission or permits running a lifecycle. */
export async function captureNpmLocalClosure(input: {
  readonly workspacePath: string; readonly expectedWorkspace?: DependencyWorkspaceIdentity;
  readonly maxInputBytes: number; readonly maxEntries: number; readonly maxPackages: number; readonly maxDurationMs: number;
}): Promise<NpmLocalInputCapture> {
  const anchors: Anchor[] = [], retainedFiles: Captured[] = [], directories = new Map<string, Anchor>();
  try {
    if (process.platform !== "linux" || (await statfs("/proc/self/fd", { bigint: true })).type !== 0x9fa0n) unknown(Reason.UnsupportedPlatform);
    if (!isAbsolute(input.workspacePath) || resolve(input.workspacePath) !== input.workspacePath || input.workspacePath === "/" ||
        input.workspacePath.length > 4096 || input.workspacePath.includes("\0") || Buffer.from(input.workspacePath).toString() !== input.workspacePath ||
        ![input.maxInputBytes, input.maxEntries, input.maxPackages, input.maxDurationMs].every((n) => Number.isSafeInteger(n) && n > 0) ||
        input.maxInputBytes > 64 * 1024 * 1024 || input.maxEntries > 16384 || input.maxPackages > 128) unknown(Reason.InvalidRequest);
    const started = performance.now(); let bytesUsed = 0, entriesUsed = 0;
    const check = (): void => { if (performance.now() - started > input.maxDurationMs) unknown(Reason.Bounds); };
    const mount = async (fd: number): Promise<string> => {
      const text = await readFile(`/proc/self/fdinfo/${fd}`, "utf8"), id = /^mnt_id:\s*(\d+)\s*$/m.exec(text)?.[1];
      if (!id || text.length > 65536) unknown(Reason.UnsafeInput); return id;
    };
    const retain = async (path: string, logical: string, parent?: Anchor, name?: string): Promise<Anchor> => {
      check(); const handle = await open(path, directoryFlags);
      let retained = false;
      try {
        const value: Anchor = { handle, info: await handle.stat({ bigint: true }), mount: "", path: logical,
          ...(parent ? { parent } : {}), ...(name ? { name } : {}) };
        anchors.push(value); retained = true; value.mount = await mount(handle.fd);
        if (!value.info.isDirectory()) unknown(Reason.UnsafeInput); return value;
      } catch (error) { if (!retained) await handle.close(); throw error; }
    };
    let root = await retain("/", "/");
    let absolute = "";
    for (const name of input.workspacePath.split("/").filter(Boolean)) {
      absolute += "/" + name; root = await retain(at(root.handle.fd, name), absolute, root, name);
    }
    const ancestors = anchors.slice(0, -1);
    root.path = ""; directories.set("", root);
    const workspace: DependencyWorkspaceIdentity = { canonicalPath: input.workspacePath, dev: String(root.info.dev), ino: String(root.info.ino) };
    if (input.expectedWorkspace && (input.expectedWorkspace.canonicalPath !== workspace.canonicalPath ||
        input.expectedWorkspace.dev !== workspace.dev || input.expectedWorkspace.ino !== workspace.ino)) unknown(Reason.WorkspaceChanged);
    const directory = async (path: string): Promise<Anchor> => {
      if (directories.has(path)) return directories.get(path)!;
      let current = root, relative = "";
      for (const name of path.split("/")) {
        safeName(name); relative += (relative ? "/" : "") + name;
        if (directories.has(relative)) current = directories.get(relative)!;
        else {
          if (++entriesUsed > input.maxEntries) unknown(Reason.Bounds);
          current = await retain(at(current.handle.fd, name), relative, current, name);
          if (current.info.dev !== root.info.dev || current.mount !== root.mount) unknown(Reason.MountCrossing);
          directories.set(relative, current);
        }
      }
      return current;
    };
    const files = new Map<string, Captured>();
    const captureFile = async (parent: Anchor, name: string, copy: boolean): Promise<Captured> => {
      check(); safeName(name); const path = parent.path ? parent.path + "/" + name : name;
      if (files.has(path)) return files.get(path)!;
      if (++entriesUsed > input.maxEntries) unknown(Reason.Bounds);
      const before = await present(at(parent.handle.fd, name));
      if (!before) unsupported(Reason.InvalidInputs);
      if (!before.isFile() || before.nlink !== 1n || ![0o644n, 0o755n].includes(before.mode & 0o7777n)) unknown(Reason.UnsafeInput);
      const file: Captured = { anchor: parent, info: before, path, name, mount: "" }; files.set(path, file);
      const handle = await open(at(parent.handle.fd, name), fileFlags); file.handle = handle; retainedFiles.push(file);
      if (!sameFile(before, await handle.stat({ bigint: true }))) unknown(Reason.Unstable);
      file.mount = await mount(handle.fd);
      if (before.dev !== root.info.dev || file.mount !== root.mount) unknown(Reason.MountCrossing);
      if (copy) {
        if (before.size > BigInt(input.maxInputBytes - bytesUsed)) unknown(Reason.Bounds);
        bytesUsed += Number(before.size); const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
        while (offset < bytes.length) {
          check(); const read = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
          if (!read.bytesRead) unknown(Reason.Unstable); offset += read.bytesRead;
        }
        if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) unknown(Reason.Unstable);
        file.bytes = bytes;
      }
      if (!sameFile(before, await handle.stat({ bigint: true }))) unknown(Reason.Unstable);
      return file;
    };
    const absentPaths = new Set<string>();
    const refuse = async (parent: Anchor, name: string): Promise<void> => {
      if (await present(at(parent.handle.fd, name))) unsupported(name === ".npmrc" ? Reason.ProjectConfig : Reason.UnsupportedClosure);
      absentPaths.add(parent.path ? parent.path + "/" + name : name);
    };
    const config = async (parent: Anchor, local: boolean, allowRootIgnore: boolean): Promise<void> => {
      for (const name of [".npmrc", ".npmignore", "binding.gyp", ...(local ? ["npm-shrinkwrap.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"] : [])]) {
        await refuse(parent, name);
      }
      if (allowRootIgnore) {
        if (await present(at(parent.handle.fd, ".gitignore"))) await captureFile(parent, ".gitignore", false);
        else absentPaths.add(parent.path ? parent.path + "/.gitignore" : ".gitignore");
      } else await refuse(parent, ".gitignore");
    };
    await config(root, false, true);
    const pkg = await captureFile(root, "package.json", true);
    if (!pkg.bytes) unknown(Reason.InvalidInputs);
    const lockName = await present(at(root.handle.fd, DependencyNpmLockName.Shrinkwrap)) ? DependencyNpmLockName.Shrinkwrap : DependencyNpmLockName.PackageLock;
    if (lockName === DependencyNpmLockName.PackageLock) absentPaths.add(DependencyNpmLockName.Shrinkwrap);
    const lock = await captureFile(root, lockName, true); if (!lock.bytes) unknown(Reason.InvalidInputs);
    const manifest = describeDependencyLocalManifest(pkg.bytes);
    const workspacePaths = new Set(manifest.workspaces), pending = [...manifest.workspaces];
    for (const edge of manifest.dependencies) if (edge.spec.startsWith("file:")) pending.push(resolveDependencyLocalFileSpec("", edge.spec));
    const locals = new Map<string, DependencyLocalPackage>(), physical = new Set<string>();
    const watches: QualifiedNpmLocalInputs["watches"][number][] = [];
    const names = async (parent: Anchor): Promise<string[]> => {
      check(); const result: string[] = [], iterator = await opendir(at(parent.handle.fd, ""), { encoding: "latin1", bufferSize: 32 });
      for await (const entry of iterator) {
        check(); if (result.length >= input.maxEntries) unknown(Reason.Bounds);
        const raw = Buffer.from(entry.name, "latin1");
        const name = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        if (!Buffer.from(name).equals(raw)) unsupported(); safeName(name); result.push(name);
      }
      return result.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    };
    while (pending.length) {
      check(); const path = pending.shift()!; if (locals.has(path)) continue;
      if (locals.size >= input.maxPackages) unknown(Reason.Bounds);
      const parent = await directory(path), physicalId = `${parent.info.dev}:${parent.info.ino}`;
      if (physical.has(physicalId)) unsupported(); physical.add(physicalId);
      const kind = workspacePaths.has(path) ? Kind.PureWorkspaceLink : Kind.PackedDirectory;
      await config(parent, true, kind === Kind.PackedDirectory);
      for (let intermediate = parent.parent; intermediate && intermediate !== root; intermediate = intermediate.parent) await config(intermediate, false, false);
      const packageFile = await captureFile(parent, "package.json", true);
      if (!packageFile.bytes) unknown(Reason.InvalidInputs);
      const description = describeDependencyLocalManifest(packageFile.bytes, kind);
      for (const edge of description.dependencies) if (edge.spec.startsWith("file:")) pending.push(resolveDependencyLocalFileSpec(path, edge.spec));
      const copied = new Map<string, DependencyLocalCopiedFile>(), packDirectories = new Set<string>();
      const leaf = async (parent: Anchor, name: string, relative: string): Promise<void> => {
        if (relative === "package.json") return;
        if (excluded(relative)) unsupported();
        for (let intermediate: Anchor | undefined = parent; intermediate && intermediate.path !== path; intermediate = intermediate.parent) {
          await config(intermediate, false, false);
        }
        const file = await captureFile(parent, name, true); if (!file.bytes) unknown(Reason.InvalidInputs);
        validateDependencyLocalCopiedInput(file.bytes, relative);
        copied.set(relative, { path: relative, mode: Number(file.info.mode & 0o777n), bytes: file.bytes });
      };
      const walk = async (relative: string, depth = 0): Promise<void> => {
        check(); if (depth > 64 || excluded(relative)) unsupported();
        const slash = relative.lastIndexOf("/"), name = relative.slice(slash + 1);
        const base = slash === -1 ? parent : await directory(path + "/" + relative.slice(0, slash));
        const info = await present(at(base.handle.fd, name)); if (!info) unsupported(Reason.InvalidInputs);
        if (info.isFile()) { await leaf(base, name, relative); return; }
        if (!info.isDirectory()) unknown(Reason.UnsafeInput);
        const folder = await directory(path + "/" + relative); await config(folder, false, false);
        packDirectories.add(relative); const before = await names(folder);
        watches.push({ path: folder.path, kind: NpmLocalWatchKind.All, names: before });
        for (const name of before) await walk(relative + "/" + name, depth + 1);
      };
      if (kind === Kind.PackedDirectory) {
        const before = await names(parent), mandatoryNames = before.filter(mandatory);
        watches.push({ path, kind: NpmLocalWatchKind.Mandatory, names: mandatoryNames });
        for (const name of mandatoryNames) await leaf(parent, name, name);
        for (const relative of description.files) await walk(relative);
        for (const relative of description.requiredFiles) {
          const slash = relative.lastIndexOf("/"), base = slash === -1 ? parent : await directory(path + "/" + relative.slice(0, slash));
          await leaf(base, relative.slice(slash + 1), relative);
        }
      }
      locals.set(path, { path, kind, packageBytes: packageFile.bytes, directories: [...packDirectories].sort(),
        files: [...copied.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))) });
    }
    const closure = qualifyDependencyNpmLocalClosure({ packageBytes: pkg.bytes, lockBytes: lock.bytes, packages: [...locals.values()] });
    for (const file of retainedFiles) {
      check(); const fresh = await present(at(file.anchor.handle.fd, file.name));
      if (!fresh || !sameFile(file.info, fresh) || !file.handle || !sameFile(file.info, await file.handle.stat({ bigint: true }))) unknown(Reason.Unstable);
      const reopened = await open(at(file.anchor.handle.fd, file.name), fileFlags);
      try { if (!sameFile(file.info, await reopened.stat({ bigint: true })) || await mount(reopened.fd) !== file.mount) unknown(Reason.Unstable); }
      finally { await reopened.close(); }
    }
    for (const anchor of anchors) {
      check(); if (!same(anchor.info, await anchor.handle.stat({ bigint: true })) || await mount(anchor.handle.fd) !== anchor.mount) unknown(Reason.WorkspaceChanged);
      if (anchor.parent && anchor.name) {
        const reopened = await open(at(anchor.parent.handle.fd, anchor.name), directoryFlags);
        try { if (!same(anchor.info, await reopened.stat({ bigint: true })) || await mount(reopened.fd) !== anchor.mount) unknown(Reason.WorkspaceChanged); }
        finally { await reopened.close(); }
      }
    }
    for (const path of absentPaths) {
      const slash = path.lastIndexOf("/"), parent = directories.get(slash === -1 ? "" : path.slice(0, slash));
      if (!parent || await present(at(parent.handle.fd, path.slice(slash + 1)))) unknown(Reason.Unstable);
    }
    for (const watch of watches) {
      const current = await names(directories.get(watch.path)!);
      if (JSON.stringify(watch.kind === NpmLocalWatchKind.Mandatory ? current.filter(mandatory) : current) !== JSON.stringify(watch.names)) unknown(Reason.Unstable);
    }
    const pin = (anchor: Anchor): NpmLocalInputPin => ({ path: anchor.path, kind: NpmLocalPinKind.Directory,
      dev: String(anchor.info.dev), ino: String(anchor.info.ino), mode: String(anchor.info.mode), mountId: anchor.mount });
    const pins: NpmLocalInputPin[] = [...directories.values()].map(pin);
    for (const file of retainedFiles) pins.push({ path: file.path, kind: NpmLocalPinKind.File, dev: String(file.info.dev), ino: String(file.info.ino),
      mode: String(file.info.mode), mountId: file.mount, size: String(file.info.size) });
    const closureDigest = hash(Buffer.from(JSON.stringify({ version: 1, lockName, root: hash(pkg.bytes), lock: hash(lock.bytes),
      layout: closure.layout, packages: closure.packages.map((local) => ({ path: local.path, kind: local.kind, package: hash(local.packageBytes),
        directories: local.directories, files: local.files.map((file) => ({ path: file.path, mode: file.mode, bytes: file.bytes.length, sha256: hash(file.bytes) })) })),
      edges: closure.edges }) + "\n"));
    check();
    return { status: Status.Qualified, workspace, lockName, packageBytes: Uint8Array.from(pkg.bytes), lockBytes: Uint8Array.from(lock.bytes),
      closure, pins, ancestorPins: ancestors.map(pin), absentPaths: [...absentPaths].sort(), watches, closureDigest };
  } catch (error) {
    if (error instanceof CaptureFailure) return { status: error.status, reason: error.reason };
    if (error instanceof DependencyInstallKeyError) return { status: Status.Unsupported, reason: Reason.UnsupportedClosure };
    return { status: Status.Unknown, reason: ["ELOOP", "ENOTDIR"].includes(errno(error) ?? "") ? Reason.UnsafeInput : Reason.Access };
  } finally {
    let failed = false;
    for (const handle of [...retainedFiles.map((file) => file.handle), ...anchors.slice().reverse().map((anchor) => anchor.handle)]) {
      try { if (handle) await handle.close(); } catch { failed = true; }
    }
    if (failed) return { status: Status.Unknown, reason: Reason.Access };
  }
}

/** Synchronous byte/pin/membership check for the authentic final host fence.
 * It reads only previously captured files, never hashes newly unknown bytes. */
export function revalidateNpmLocalClosure(input: { readonly capture: QualifiedNpmLocalInputs; readonly maxDurationMs: number }): NpmInputRevalidation {
  const opened: number[] = [];
  const retained: { fd: number; pin: NpmLocalInputPin; parent?: number; name?: string }[] = [];
  try {
    if (process.platform !== "linux" || statfsSync("/proc/self/fd", { bigint: true }).type !== 0x9fa0n) unknown(Reason.UnsupportedPlatform);
    const capture = input.capture, started = performance.now();
    if (!Number.isSafeInteger(input.maxDurationMs) || input.maxDurationMs <= 0 || capture.pins.length > 32768 ||
        !isAbsolute(capture.workspace.canonicalPath) || resolve(capture.workspace.canonicalPath) !== capture.workspace.canonicalPath ||
        capture.workspace.canonicalPath === "/" || !Object.values(DependencyNpmLockName).includes(capture.lockName)) unknown(Reason.InvalidRequest);
    const check = (): void => { if (performance.now() - started > input.maxDurationMs) unknown(Reason.Bounds); };
    const mounted = (fd: number): string => {
      const text = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"), id = /^mnt_id:\s*(\d+)\s*$/m.exec(text)?.[1];
      if (!id || text.length > 65536) unknown(Reason.UnsafeInput); return id;
    };
    const expected = new Map([...capture.ancestorPins, ...capture.pins.filter((pin) => pin.kind === NpmLocalPinKind.Directory)].map((pin) => [pin.path, pin]));
    const matches = (info: BigIntStats, pin: NpmLocalInputPin): boolean => String(info.dev) === pin.dev && String(info.ino) === pin.ino && String(info.mode) === pin.mode;
    const retain = (path: string, logical: string, parent?: number, name?: string): number => {
      check(); const fd = openSync(path, directoryFlags); opened.push(fd); const pin = expected.get(logical);
      if (!pin || !matches(fstatSync(fd, { bigint: true }), pin) || mounted(fd) !== pin.mountId) unknown(Reason.WorkspaceChanged);
      retained.push({ fd, pin, ...(parent !== undefined ? { parent } : {}), ...(name ? { name } : {}) });
      return fd;
    };
    let root = retain("/", "/"), absolute = "";
    const dirs = new Map<string, number>();
    for (const name of capture.workspace.canonicalPath.split("/").filter(Boolean)) {
      absolute += "/" + name; root = retain(at(root, name), absolute === capture.workspace.canonicalPath ? "" : absolute, root, name);
    }
    const rootInfo = fstatSync(root, { bigint: true });
    if (String(rootInfo.dev) !== capture.workspace.dev || String(rootInfo.ino) !== capture.workspace.ino) unknown(Reason.WorkspaceChanged);
    dirs.set("", root);
    const directory = (path: string): number => {
      if (dirs.has(path)) return dirs.get(path)!;
      let current = root, logical = "";
      for (const name of path.split("/")) {
        safeName(name); logical += (logical ? "/" : "") + name;
        if (!dirs.has(logical)) dirs.set(logical, retain(at(current, name), logical, current, name));
        current = dirs.get(logical)!;
      }
      return current;
    };
    const current = (parent: number, name: string): BigIntStats | null => {
      try { return lstatSync(at(parent, name), { bigint: true }); } catch (error) { if (errno(error) === "ENOENT") return null; throw error; }
    };
    const membership = (): void => {
      for (const path of capture.absentPaths) {
        check(); const slash = path.lastIndexOf("/"); if (current(directory(path.slice(0, slash === -1 ? 0 : slash)), path.slice(slash + 1))) unknown(Reason.Unstable);
      }
      for (const watch of capture.watches) {
        check(); const iterator = opendirSync(at(directory(watch.path), ""), { encoding: "latin1", bufferSize: 32 }), names: string[] = [];
        try {
          while (true) {
            check(); const entry = iterator.readSync(); if (!entry) break;
            if (names.length >= 16384) unknown(Reason.Bounds);
            const raw = Buffer.from(entry.name, "latin1");
            const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
            if (!Buffer.from(text).equals(raw)) unsupported(); safeName(text); names.push(text);
          }
        } finally { iterator.closeSync(); }
        names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
        if (JSON.stringify(watch.kind === NpmLocalWatchKind.Mandatory ? names.filter(mandatory) : names) !== JSON.stringify(watch.names)) unknown(Reason.Unstable);
      }
    };
    const bytes = new Map<string, Uint8Array>([["package.json", capture.packageBytes], [capture.lockName, capture.lockBytes]]);
    for (const local of capture.closure.packages) {
      bytes.set(local.path + "/package.json", local.packageBytes);
      for (const file of local.files) bytes.set(local.path + "/" + file.path, file.bytes);
    }
    const pinPaths = new Set(capture.pins.map((pin) => pin.path));
    if (pinPaths.size !== capture.pins.length || [...bytes.keys()].some((path) =>
        !capture.pins.some((pin) => pin.path === path && pin.kind === NpmLocalPinKind.File))) unknown(Reason.InvalidRequest);
    qualifyDependencyNpmLocalClosure({ packageBytes: capture.packageBytes, lockBytes: capture.lockBytes, packages: capture.closure.packages });
    membership();
    for (const pin of capture.pins) {
      if (pin.kind === NpmLocalPinKind.Directory) { directory(pin.path); continue; }
      check(); const slash = pin.path.lastIndexOf("/"), parent = directory(slash === -1 ? "" : pin.path.slice(0, slash)), name = pin.path.slice(slash + 1);
      safeName(name); const before = current(parent, name);
      if (!before || !before.isFile() || before.nlink !== 1n || !matches(before, pin) || String(before.size) !== pin.size) unknown(Reason.Unstable);
      const fd = openSync(at(parent, name), fileFlags); opened.push(fd);
      if (!sameFile(before, fstatSync(fd, { bigint: true })) || mounted(fd) !== pin.mountId) unknown(Reason.Unstable);
      const original = bytes.get(pin.path);
      if (original) {
        if (BigInt(original.length) !== before.size) unknown(Reason.Unstable);
        const buffer = Buffer.alloc(Math.min(65536, Math.max(1, original.length))); let offset = 0;
        while (offset < original.length) {
          check(); const count = readSync(fd, buffer, 0, Math.min(buffer.length, original.length - offset), offset);
          if (!count || !buffer.subarray(0, count).equals(original.subarray(offset, offset + count))) unknown(Reason.Unstable); offset += count;
        }
        if (readSync(fd, buffer, 0, 1, offset)) unknown(Reason.Unstable);
      }
      const after = current(parent, name);
      if (!after || !sameFile(before, after) || !sameFile(before, fstatSync(fd, { bigint: true }))) unknown(Reason.Unstable);
      const verify = openSync(at(parent, name), fileFlags); opened.push(verify);
      if (!sameFile(before, fstatSync(verify, { bigint: true })) || mounted(verify) !== pin.mountId) unknown(Reason.Unstable);
    }
    for (const anchor of retained) {
      check(); const { fd, pin } = anchor;
      if (!matches(fstatSync(fd, { bigint: true }), pin) || mounted(fd) !== pin.mountId) unknown(Reason.WorkspaceChanged);
      if (anchor.parent !== undefined && anchor.name) {
        const fresh = openSync(at(anchor.parent, anchor.name), directoryFlags); opened.push(fresh);
        if (!matches(fstatSync(fresh, { bigint: true }), pin) || mounted(fresh) !== pin.mountId) unknown(Reason.WorkspaceChanged);
      }
    }
    membership(); check(); return { status: Status.Qualified };
  } catch (error) {
    if (error instanceof CaptureFailure) return { status: error.status, reason: error.reason };
    return { status: Status.Unknown, reason: ["ELOOP", "ENOTDIR"].includes(errno(error) ?? "") ? Reason.UnsafeInput : Reason.Access };
  } finally {
    let failed = false; for (const fd of opened.reverse()) { try { closeSync(fd); } catch { failed = true; } }
    if (failed) return { status: Status.Unknown, reason: Reason.Access };
  }
}
