import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, opendirSync, readFileSync, readlinkSync, type BigIntStats } from "node:fs";
import { lstat, open, opendir, readFile, readlink, statfs, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  DependencyManifestEntryKind as Kind, DependencyTreeObservationFailure as Failure,
  DependencyTreeObservationStatus as Status, DependencyTreeAllocationBasis as AllocationBasis, encodeDependencyTreeManifest,
  type DependencyManifestEntry, type DependencyObservedEntryIdentity,
  type DependencyCapturedTreeObservation, type DependencyTreeObservationLimits, type DependencyLogicalSourceLink,
} from "../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import type { DependencyTreeIdentity, DependencyWorkspaceIdentity } from "../../worker-core/dependency-environment/domain/dependency-receipt";
import { DependencySourceBindingError, readDependencySourceLinkSession, dependencySourceLinkAllowsSubset,
  type DependencySourceLinkSession } from "./dependency-source-binding";

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// Linux O_PATH retains even a symlink inode without following it or opening a
// substituted FIFO/device. Node does not expose this Linux flag as a constant.
const pathFlags = 0x200000 | constants.O_NOFOLLOW;
type Anchor = { handle: FileHandle; before: BigIntStats; mountId: string; parent?: FileHandle; name?: Buffer };
type CheckedEntry = { parent: FileHandle; name: Buffer; before: BigIntStats; mountId: string };
type PhysicalPin = { readonly path: readonly Buffer[]; readonly before: BigIntStats; readonly mountId: string;
  readonly full: boolean; names?: readonly Buffer[]; readonly target?: Buffer };
type PhysicalRoot = { readonly pins: PhysicalPin[]; storageBytes: number; namespace: DependencyTreeIdentity | null;
  ancestorBudget: number; directoryBudget: number };
const sourceExposureBrand = Symbol("dependency_source_exposure");
export type DependencySourceExposure = Readonly<{ [sourceExposureBrand]: true }>;
const sourceExposures = new WeakMap<DependencySourceExposure, { readonly roots: readonly PhysicalRoot[];
  readonly limits: DependencyTreeObservationLimits; closed: boolean }>();
const exposureCeilings = { maxEntries: 100000, maxTotalBytes: 2 * 1024 ** 3, maxManifestBytes: 32 * 1024 ** 2, maxDurationMs: 30000 };
class ObservationError extends Error { constructor(readonly reason: Failure) { super(reason); } }
function fail(reason: Failure): never { throw new ObservationError(reason); }
const identity = (s: BigIntStats): DependencyTreeIdentity => ({ dev: String(s.dev), ino: String(s.ino) });
const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino &&
  a.mode === b.mode && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const sameDirectoryIdentity = (a: BigIntStats, b: BigIntStats): boolean => a.isDirectory() && b.isDirectory() &&
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const blocks = (info: BigIntStats): bigint => {
  if (typeof info.blocks !== "bigint" || info.blocks < 0n) fail(Failure.InvalidAllocation);
  return info.blocks;
};
const sameAllocation = (a: BigIntStats, b: BigIntStats): void => {
  const before = blocks(a), after = blocks(b);
  if (a.dev === b.dev && a.ino === b.ino && before !== after) fail(Failure.AllocationChanged);
};
const anchored = (parent: FileHandle, name: Buffer): Buffer => Buffer.concat([Buffer.from(`/proc/self/fd/${parent.fd}/`), name]);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const physicalKey = (path: readonly Buffer[]): string => JSON.stringify(path.map(part => part.toString("base64")));
const samePhysical = (a: BigIntStats, b: BigIntStats, full: boolean): boolean =>
  (full ? same(a, b) : sameDirectoryIdentity(a, b)) && a.uid === b.uid && a.gid === b.gid && b.nlink > 0n;

/** Actual source walk only. This opaque in-process relation is neither install
 * provenance nor writer exclusion; no Complete DTO can create one. */
async function captureExposure(input: {
  readonly roots: readonly { readonly parentPath: string; readonly name: string; readonly expectedTree: DependencyTreeIdentity; readonly expectedWorkspace?: DependencyWorkspaceIdentity }[];
  readonly limits: DependencyTreeObservationLimits;
}, rawPhysical = false): Promise<{ readonly status: Status.Complete; readonly exposure: DependencySourceExposure } |
  { readonly status: Status.Incomplete; readonly reason: Failure }> {
  try {
    if (!Array.isArray(input.roots) || input.roots.length === 0 || input.roots.length > 128 ||
        Object.keys(input.limits).length !== 4 || Object.entries(exposureCeilings).some(([k, ceiling]) => {
          const n = input.limits[k as keyof DependencyTreeObservationLimits]; return !Number.isSafeInteger(n) || n <= 0 || n > ceiling;
        })) fail(Failure.InvalidRequest);
    const limits = Object.freeze({ ...input.limits }), selectedRoots = input.roots.map(root => ({
      parentPath: root.parentPath, name: root.name, expectedTree: { ...root.expectedTree }, ...(root.expectedWorkspace ? { expectedWorkspace: { ...root.expectedWorkspace } } : {}) }));
    const started = performance.now(), roots: PhysicalRoot[] = [], paths: string[] = [];
    let entries = 0, bytes = 0, storage = 0, ancestors = 0, directories = 0;
    for (const root of selectedRoots) {
      if (typeof root.parentPath !== "string" || typeof root.name !== "string" || !root.expectedTree ||
          !/^(?:0|[1-9][0-9]{0,19})$/.test(root.expectedTree.dev) || !/^[1-9][0-9]{0,19}$/.test(root.expectedTree.ino)) fail(Failure.InvalidRequest);
      const path = resolve(root.parentPath, root.name);
      if (paths.some(other => path === other || path.startsWith(other + "/") || other.startsWith(path + "/"))) fail(Failure.InvalidRequest);
      paths.push(path);
      const remaining = { maxEntries: limits.maxEntries - entries, maxTotalBytes: limits.maxTotalBytes - bytes,
        maxManifestBytes: limits.maxManifestBytes - storage, maxDurationMs: Math.floor(limits.maxDurationMs - (performance.now() - started)) };
      if (Object.values(remaining).some(n => n <= 0)) fail(Failure.Bounds);
      const physical: PhysicalRoot = { pins: [], storageBytes: 0, namespace: null, ancestorBudget: 512 - ancestors, directoryBudget: 512 - directories };
      const observed = await observeNamedRoot({ workspacePath: root.parentPath, treeName: root.name, expectedTree: root.expectedTree, ...(root.expectedWorkspace ? { expectedWorkspace: root.expectedWorkspace } : {}), limits: remaining }, physical, rawPhysical);
      if (observed.status !== Status.Complete) return observed;
      if (!physical.namespace) fail(Failure.UnsafeNamespace);
      entries += observed.entries.length; bytes += Number(observed.totalBytes); storage += observed.canonicalBytes.length + physical.storageBytes;
      ancestors += physical.pins.filter(pin => !pin.full).length; directories += physical.pins.filter(pin => pin.full && pin.before.isDirectory()).length;
      if (ancestors > 512 || directories > 512 || storage > limits.maxManifestBytes || performance.now() - started > limits.maxDurationMs) fail(Failure.Bounds);
      roots.push(physical);
    }
    const exposure: DependencySourceExposure = Object.freeze({ [sourceExposureBrand]: true });
    sourceExposures.set(exposure, { roots, limits, closed: false });
    try { assertDependencySourceExposureCurrent(exposure, Math.floor(limits.maxDurationMs - (performance.now() - started))); }
    catch (error) { closeDependencySourceExposure(exposure); throw error; }
    return { status: Status.Complete, exposure };
  } catch (error) { return { status: Status.Incomplete, reason: error instanceof ObservationError ? error.reason : Failure.Access }; }
}

/** Existing generic entry remains strict about all symlink destinations. */
export function captureDependencySourceExposure(input: {
  readonly roots: readonly { readonly parentPath: string; readonly name: string; readonly expectedTree: DependencyTreeIdentity }[];
  readonly limits: DependencyTreeObservationLimits;
}) { return captureExposure(input); }
/** Fixed original node_modules physical facts only. Raw links are never followed
 * or returned as a qualified manifest; only the private opaque baseline escapes. */
export function captureDependencyPhysicalTreeExposure(input: {
  readonly workspace: DependencyWorkspaceIdentity; readonly expectedTree: DependencyTreeIdentity;
  readonly limits: DependencyTreeObservationLimits;
}) {
  return captureExposure({ roots: [{ parentPath: input.workspace.canonicalPath, name: "node_modules", expectedTree: input.expectedTree, expectedWorkspace: input.workspace }],
    limits: input.limits }, true);
}

/** Reopens the ORIGINAL private baseline, never recaptures it. Caller supplies
 * at most a stricter remaining deadline, not a path, DTO or permission callback. */
export function assertDependencySourceExposureCurrent(exposure: DependencySourceExposure, maxDurationMs?: number): void {
  const state = sourceExposures.get(exposure);
  if (!state || state.closed) fail(Failure.InvalidRequest);
  const duration = maxDurationMs ?? state.limits.maxDurationMs, started = performance.now();
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > state.limits.maxDurationMs) { state.closed = true; fail(Failure.Bounds); }
  const checkTime = () => { if (performance.now() - started > duration) fail(Failure.Bounds); };
  const path = (fd: number, name: Buffer): Buffer => Buffer.concat([Buffer.from(`/proc/self/fd/${fd}/`), name]);
  const mount = (fd: number): string => {
    const text = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"), rows = [...text.matchAll(/^mnt_id:\s+([1-9][0-9]{0,19})$/gm)];
    const id = rows[0]?.[1]; if (text.length > 65536 || rows.length !== 1 || !id) fail(Failure.UnsafeNamespace); return id;
  };
  let membershipCount = 0, membershipBytes = 0;
  try {
    for (const root of state.roots) {
      const opened = new Map<string, { readonly fd: number; readonly pin: PhysicalPin }>(), descriptors: number[] = [];
      let closeFailed = false;
      try {
        checkTime(); const ns = openSync("/proc/self/ns/mnt", constants.O_RDONLY); descriptors.push(ns);
        const namespace = identity(fstatSync(ns, { bigint: true }));
        if (!root.namespace || namespace.dev !== root.namespace.dev || namespace.ino !== root.namespace.ino) fail(Failure.UnsafeNamespace);
        for (const pin of root.pins) {
          checkTime(); const parent = pin.path.length ? opened.get(physicalKey(pin.path.slice(0, -1))) : undefined;
          if (pin.path.length && !parent) fail(Failure.UnsafeNamespace);
          const named = parent ? path(parent.fd, pin.path[pin.path.length - 1]!) : "/";
          const directory = pin.before.isDirectory(), fd = openSync(named, directory ? directoryFlags : pathFlags);
          if (directory) { descriptors.push(fd); opened.set(physicalKey(pin.path), { fd, pin }); }
          try {
          if (!samePhysical(pin.before, fstatSync(fd, { bigint: true }), pin.full)) fail(Failure.IdentityChanged);
          if (mount(fd) !== pin.mountId) fail(Failure.MountCrossing);
          if (pin.full && pin.before.isDirectory()) {
            if (!pin.names) fail(Failure.UnsafeNamespace);
            const names: Buffer[] = [], stream = opendirSync(`/proc/self/fd/${fd}`, { encoding: "latin1", bufferSize: 1 });
            try {
              for (let item = stream.readSync(); item; item = stream.readSync()) {
                checkTime(); const name = Buffer.from(item.name, "latin1"); membershipCount++; membershipBytes += name.length;
                if (!name.length || name.includes(0) || name.includes(47)) fail(Failure.UnsafeNamespace);
                if (membershipCount > state.limits.maxEntries || membershipBytes > state.limits.maxManifestBytes) fail(Failure.Bounds);
                names.push(name);
              }
            } finally { stream.closeSync(); }
            names.sort(Buffer.compare);
            if (names.length !== pin.names.length || names.some((name, index) => !name.equals(pin.names![index]!))) fail(Failure.Unstable);
          }
          if (pin.target && !readlinkSync(named, { encoding: "buffer" }).equals(pin.target)) fail(Failure.Unstable);
          if (!directory) {
            const fresh = openSync(named, pathFlags);
            try { if (!samePhysical(pin.before, fstatSync(fd, { bigint: true }), true) ||
                !samePhysical(pin.before, fstatSync(fresh, { bigint: true }), true)) fail(Failure.Unstable);
              if (mount(fd) !== pin.mountId || mount(fresh) !== pin.mountId) fail(Failure.MountCrossing); }
            finally { closeSync(fresh); }
          }
          } finally { if (!directory) closeSync(fd); }
        }
        // Bracket every retained inode and its current parent-anchored name.
        for (const { fd, pin } of opened.values()) {
          checkTime(); if (!samePhysical(pin.before, fstatSync(fd, { bigint: true }), pin.full)) fail(Failure.Unstable);
          const parent = pin.path.length ? opened.get(physicalKey(pin.path.slice(0, -1))) : undefined;
          const named = parent ? path(parent.fd, pin.path[pin.path.length - 1]!) : "/";
          const fresh = openSync(named, pin.before.isDirectory() ? directoryFlags : pathFlags);
          try { if (!samePhysical(pin.before, fstatSync(fresh, { bigint: true }), pin.full)) fail(Failure.IdentityChanged);
            if (mount(fd) !== pin.mountId || mount(fresh) !== pin.mountId) fail(Failure.MountCrossing); }
          finally { closeSync(fresh); }
        }
        checkTime(); const freshNs = openSync("/proc/self/ns/mnt", constants.O_RDONLY);
        try { const fresh = identity(fstatSync(freshNs, { bigint: true }));
          if (fresh.dev !== namespace.dev || fresh.ino !== namespace.ino) fail(Failure.UnsafeNamespace); }
        finally { closeSync(freshNs); }
      } finally { for (const fd of descriptors.reverse()) { try { closeSync(fd); } catch { closeFailed = true; } }
        if (closeFailed) fail(Failure.Access); }
    }
    checkTime();
  } catch (error) { state.closed = true; throw error instanceof ObservationError ? error : new ObservationError(Failure.Access); }
}
export function closeDependencySourceExposure(exposure: DependencySourceExposure): void {
  const state = sourceExposures.get(exposure); if (!state) fail(Failure.InvalidRequest); state.closed = true;
}

/** Bounded factual inventory under a caller-held exclusion gate. This does not
 * acquire admission, establish provenance, or protect against privileged writers.
 * Call only for capture/comparison, never on the hot dependency-reuse path.
 */
export async function observeDependencyTree(input: {
  readonly workspacePath: string; readonly treeName: "node_modules";
  readonly expectedWorkspace?: DependencyWorkspaceIdentity;
  readonly expectedTree?: DependencyTreeIdentity;
  readonly sourceLinkSession?: DependencySourceLinkSession;
  readonly limits: DependencyTreeObservationLimits;
}): Promise<DependencyCapturedTreeObservation> {
  return observeNamedRoot(input);
}

/** Same inventory contract for a pinned npm tool directory. No install claim. */
export async function observeDependencyDirectoryRoot(input: {
  readonly parentPath: string; readonly name: string; readonly limits: DependencyTreeObservationLimits;
  readonly expectedTree?: DependencyTreeIdentity;
  readonly sourceLinkSession?: DependencySourceLinkSession;
}): Promise<DependencyCapturedTreeObservation> {
  return observeNamedRoot({ workspacePath: input.parentPath, treeName: input.name, limits: input.limits,
    ...(input.sourceLinkSession ? { sourceLinkSession: input.sourceLinkSession } : {}),
    ...(input.expectedTree ? { expectedTree: input.expectedTree } : {}) });
}

async function observeNamedRoot(input: {
  readonly workspacePath: string; readonly treeName: string;
  readonly expectedWorkspace?: DependencyWorkspaceIdentity; readonly expectedTree?: DependencyTreeIdentity;
  readonly limits: DependencyTreeObservationLimits;
  readonly sourceLinkSession?: DependencySourceLinkSession;
}, exposure?: PhysicalRoot, rawPhysical = false): Promise<DependencyCapturedTreeObservation> {
  const anchors: Anchor[] = [];
  let sourceNamespace: FileHandle | undefined;
  try {
    if (process.platform !== "linux") fail(Failure.UnsupportedPlatform);
    if (!isAbsolute(input.workspacePath) || resolve(input.workspacePath) !== input.workspacePath ||
        input.workspacePath.length > 4096 || Buffer.from(input.workspacePath).toString() !== input.workspacePath ||
        !input.treeName || input.treeName === "." || input.treeName === ".." || /[\/\0]/.test(input.treeName) ||
        Buffer.from(input.treeName).toString() !== input.treeName ||
        !["maxEntries", "maxTotalBytes", "maxManifestBytes", "maxDurationMs"].every((key) => Object.hasOwn(input.limits, key)) ||
        !Object.values(input.limits).every((n) => Number.isSafeInteger(n) && n > 0) ||
        Object.keys(input.limits).length !== 4) fail(Failure.InvalidRequest);
    if ((await statfs("/proc/self/fd", { bigint: true })).type !== 0x9fa0n) fail(Failure.UnsupportedPlatform);
    if (exposure) { sourceNamespace = await open("/proc/self/ns/mnt", constants.O_RDONLY);
      exposure.namespace = identity(await sourceNamespace.stat({ bigint: true })); }
    const start = performance.now();
    const checkTime = (): void => { if (performance.now() - start > input.limits.maxDurationMs) fail(Failure.Bounds); };
    const retainDirectory = async (path: string | Buffer, parent?: FileHandle, name?: Buffer, target = false): Promise<Anchor> => {
      checkTime();
      const before = await lstat(path, { bigint: true });
      if (!before.isDirectory()) fail(Failure.UnsafeNamespace);
      const handle = await open(path, directoryFlags);
      try {
        const current = await handle.stat({ bigint: true });
        if (target) sameAllocation(before, current);
        if (!same(before, current)) fail(Failure.IdentityChanged);
        const mountId = await mount(handle);
        const item: Anchor = { handle, before: current, mountId,
          ...(parent ? { parent } : {}), ...(name ? { name } : {}) };
        anchors.push(item);
        return item;
      } catch (error) { await handle.close(); throw error; }
    };
    let workspaceAnchor = await retainDirectory("/");
    for (const part of input.workspacePath.split("/").filter(Boolean)) {
      const name = Buffer.from(part);
      workspaceAnchor = await retainDirectory(anchored(workspaceAnchor.handle, name), workspaceAnchor.handle, name);
    }
    const workspace: DependencyWorkspaceIdentity = { canonicalPath: input.workspacePath, ...identity(workspaceAnchor.before) };
    if (input.expectedWorkspace && (input.expectedWorkspace.canonicalPath !== workspace.canonicalPath ||
        !expected(workspaceAnchor.before, input.expectedWorkspace))) fail(Failure.IdentityChanged);
    const treeName = Buffer.from(input.treeName);
    const treeAnchorIndex = anchors.length;
    const root = await retainDirectory(anchored(workspaceAnchor.handle, treeName), workspaceAnchor.handle, treeName, true);
    if (root.mountId !== workspaceAnchor.mountId) fail(Failure.MountCrossing);
    if (input.expectedTree && !expected(root.before, input.expectedTree)) fail(Failure.IdentityChanged);
    const sourceLinks = input.sourceLinkSession ? readDependencySourceLinkSession(input.sourceLinkSession, workspace, input.treeName) : undefined;
    const entries: DependencyManifestEntry[] = [];
    const identities: DependencyObservedEntryIdentity[] = [];
    const checked: CheckedEntry[] = [];
    const prefix = [...input.workspacePath.split("/").filter(Boolean).map(part => Buffer.from(part)), treeName];
    const physicalPins = new Map<string, PhysicalPin>();
    const remember = (path: readonly Buffer[], info: BigIntStats, mountId: string, full: boolean, target?: Buffer): void => {
      if (!exposure) return;
      if ((!full && --exposure.ancestorBudget < 0) || (full && info.isDirectory() && --exposure.directoryBudget < 0)) fail(Failure.Bounds);
      const pin: PhysicalPin = { path, before: info, mountId, full, ...(target ? { target } : {}) };
      exposure.storageBytes += Buffer.byteLength(JSON.stringify([physicalKey(path), String(info.dev), String(info.ino), String(info.mode),
        String(info.uid), String(info.gid), String(info.size), String(info.nlink), String(info.ctimeNs), String(info.mtimeNs), mountId])) + (target?.length ?? 0);
      if (exposure.storageBytes + manifestEstimate > input.limits.maxManifestBytes) fail(Failure.Bounds);
      exposure.pins.push(pin); physicalPins.set(physicalKey(path), pin);
    };
    let totalBytes = 0;
    let manifestEstimate = 26;
    const allocated = { [Kind.Directory]: 0n, [Kind.File]: 0n, [Kind.Symlink]: 0n };
    const inodeCounts = { [Kind.Directory]: 0n, [Kind.File]: 0n, [Kind.Symlink]: 0n };
    const add = (entry: DependencyManifestEntry, info: BigIntStats, mountId: string): void => {
      checkTime();
      if (entries.length >= input.limits.maxEntries) fail(Failure.Bounds);
      manifestEstimate += Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (manifestEstimate > input.limits.maxManifestBytes) fail(Failure.Bounds);
      // Only entries emitted below the retained target root are counted. Opening
      // ancestor anchors or validating a symlink target never adds their blocks.
      allocated[entry.kind] += blocks(info) * 512n;
      inodeCounts[entry.kind] += 1n;
      entries.push(entry);
      identities.push({ path: entry.path, identity: identity(info), mountId });
      if (exposure) remember([...prefix, ...entry.path.map(part => Buffer.from(part, "base64"))], info, mountId, true,
        entry.kind === Kind.Symlink ? Buffer.from(entry.target, "base64") : undefined);
    };
    const names = async (handle: FileHandle): Promise<Buffer[]> => {
      const result: Buffer[] = [];
      const stream = await opendir(`/proc/self/fd/${handle.fd}`, { encoding: "latin1" });
      for await (const item of stream) {
        checkTime();
        if (result.length >= input.limits.maxEntries) fail(Failure.Bounds);
        const name = Buffer.from(item.name, "latin1");
        if (name.length === 0 || name.includes(0) || name.includes(47)) fail(Failure.UnsafeNamespace);
        result.push(name);
      }
      return result.sort(Buffer.compare);
    };
    const walk = async (dir: Anchor, path: readonly string[]): Promise<void> => {
      add({ path, kind: Kind.Directory, mode: Number(dir.before.mode & 0o7777n) }, dir.before, dir.mountId);
      const beforeNames = await names(dir.handle);
      if (exposure) {
        const pin = physicalPins.get(physicalKey([...prefix, ...path.map(part => Buffer.from(part, "base64"))]));
        if (!pin) fail(Failure.UnsafeNamespace); pin.names = beforeNames;
        exposure.storageBytes += beforeNames.reduce((sum, name) => sum + name.length, 0);
        if (exposure.storageBytes + manifestEstimate > input.limits.maxManifestBytes) fail(Failure.Bounds);
      }
      for (const name of beforeNames) {
        checkTime();
        const childPath = anchored(dir.handle, name);
        const metadataHandle = await open(childPath, pathFlags);
        let info: BigIntStats;
        let mountId: string;
        try {
          info = await metadataHandle.stat({ bigint: true });
          mountId = await mount(metadataHandle);
        } finally { await metadataHandle.close(); }
        if (mountId !== root.mountId) fail(Failure.MountCrossing);
        const child = [...path, name.toString("base64")];
        if (info.isDirectory()) {
          const retained = await retainDirectory(childPath, dir.handle, name, true);
          sameAllocation(info, retained.before);
          if (!same(info, retained.before) || retained.mountId !== root.mountId) fail(Failure.Unstable);
          await walk(retained, child);
        } else {
          if (info.nlink !== 1n) fail(Failure.Hardlink);
          const mode = Number(info.mode & 0o7777n);
          if (info.isFile()) {
            if (info.size > BigInt(input.limits.maxTotalBytes - totalBytes)) fail(Failure.Bounds);
            const handle = await open(childPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
              const opened = await handle.stat({ bigint: true });
              sameAllocation(info, opened);
              if (!same(info, opened) || await mount(handle) !== root.mountId) fail(Failure.Unstable);
              const digest = createHash("sha256");
              const buffer = Buffer.alloc(64 * 1024);
              let offset = 0;
              while (offset < Number(info.size)) {
                checkTime();
                const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(info.size) - offset), offset);
                if (bytesRead === 0) fail(Failure.Unstable);
                digest.update(buffer.subarray(0, bytesRead));
                offset += bytesRead;
              }
              if ((await handle.read(buffer, 0, 1, offset)).bytesRead !== 0) fail(Failure.Unstable);
              const after = await handle.stat({ bigint: true });
              sameAllocation(info, after);
              if (!same(info, after)) fail(Failure.Unstable);
              totalBytes += offset;
              add({ path: child, kind: Kind.File, mode, size: String(info.size), sha256: digest.digest("hex") }, info, mountId);
            } finally { await handle.close(); }
          } else if (info.isSymbolicLink()) {
            const target = await readlink(childPath, { encoding: "buffer" });
            totalBytes += target.length;
            if (totalBytes > input.limits.maxTotalBytes) fail(Failure.Bounds);
            add({ path: child, kind: Kind.Symlink, mode, target: target.toString("base64") }, info, mountId);
          } else fail(Failure.SpecialFile);
          checked.push({ parent: dir.handle, name, before: info, mountId });
        }
      }
      const afterNames = await names(dir.handle);
      const after = await dir.handle.stat({ bigint: true });
      sameAllocation(dir.before, after);
      if (beforeNames.length !== afterNames.length || beforeNames.some((name, i) => !name.equals(afterNames[i]!)) ||
          !same(dir.before, after)) fail(Failure.Unstable);
    };
    if (exposure) for (const [index, anchor] of anchors.slice(0, treeAnchorIndex).entries())
      remember(prefix.slice(0, index), anchor.before, anchor.mountId, false);
    await walk(root, []);
    const presentSourceLinks = rawPhysical && exposure ? undefined : validateSymlinks(entries, sourceLinks,
      input.sourceLinkSession ? dependencySourceLinkAllowsSubset(input.sourceLinkSession) : false);
    // Re-open every leaf through its retained directory. A same-device bind
    // substitution is observable in fdinfo even when dev/ino remain identical.
    for (const item of checked) {
      checkTime();
      const handle = await open(anchored(item.parent, item.name), pathFlags);
      try {
        const current = await handle.stat({ bigint: true });
        sameAllocation(item.before, current);
        if (!same(item.before, current)) fail(Failure.Unstable);
        if (await mount(handle) !== item.mountId) fail(Failure.MountCrossing);
      } finally { await handle.close(); }
    }
    for (const [index, item] of anchors.entries()) {
      checkTime();
      const equal = index >= treeAnchorIndex ? same : sameDirectoryIdentity;
      const current = await item.handle.stat({ bigint: true });
      if (index >= treeAnchorIndex) sameAllocation(item.before, current);
      if (!equal(item.before, current)) fail(Failure.Unstable);
      if (await mount(item.handle) !== item.mountId) fail(Failure.MountCrossing);
      if (item.parent && item.name) {
        const handle = await open(anchored(item.parent, item.name), directoryFlags);
        try {
          const reopened = await handle.stat({ bigint: true });
          if (index >= treeAnchorIndex) sameAllocation(item.before, reopened);
          if (!equal(item.before, reopened)) fail(Failure.IdentityChanged);
          if (await mount(handle) !== item.mountId) fail(Failure.MountCrossing);
        } finally { await handle.close(); }
      }
    }
    if (input.sourceLinkSession) readDependencySourceLinkSession(input.sourceLinkSession, workspace, input.treeName);
    const canonicalBytes = Buffer.from(encodeDependencyTreeManifest(entries, presentSourceLinks));
    if (canonicalBytes.length > input.limits.maxManifestBytes) fail(Failure.Bounds);
    checkTime();
    const digest = hash(canonicalBytes);
    if (exposure && exposure.storageBytes + canonicalBytes.length > input.limits.maxManifestBytes) fail(Failure.Bounds);
    checkTime();
    return { status: Status.Complete, workspace, tree: identity(root.before), mountId: root.mountId,
      entries, identities, canonicalBytes, digest, totalBytes: String(totalBytes),
      measurement: { allocationBasis: AllocationBasis.RetainedInodeBlocks512,
        allocatedBytesEstimate: String(allocated[Kind.Directory] + allocated[Kind.File] + allocated[Kind.Symlink]),
        allocationByKind: {
          [Kind.Directory]: { inodeCount: String(inodeCounts[Kind.Directory]), allocatedBytesEstimate: String(allocated[Kind.Directory]) },
          [Kind.File]: { inodeCount: String(inodeCounts[Kind.File]), allocatedBytesEstimate: String(allocated[Kind.File]) },
          [Kind.Symlink]: { inodeCount: String(inodeCounts[Kind.Symlink]), allocatedBytesEstimate: String(allocated[Kind.Symlink]) },
        }, observedScanDurationMs: String(Math.ceil(performance.now() - start)) } };
  } catch (error) {
    return { status: Status.Incomplete, reason: error instanceof ObservationError ? error.reason :
      error instanceof DependencySourceBindingError ? Failure.SourceBinding : Failure.Access };
  } finally {
    let closeFailed = false;
    for (const item of anchors.reverse()) {
      try { await item.handle.close(); } catch { closeFailed = true; }
    }
    if (sourceNamespace) { try { await sourceNamespace.close(); } catch { closeFailed = true; } }
    if (closeFailed) return { status: Status.Incomplete, reason: Failure.Access };
  }
}

function expected(info: BigIntStats, value: DependencyTreeIdentity): boolean {
  return String(info.dev) === value.dev && String(info.ino) === value.ino;
}

async function mount(handle: FileHandle): Promise<string> {
  const info = await readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8");
  const id = /^mnt_id:\s*(\d+)\s*$/m.exec(info)?.[1];
  if (!id || info.length > 65536) fail(Failure.UnsafeNamespace);
  return id;
}

function validateSymlinks(entries: readonly DependencyManifestEntry[], sourceLinks?: readonly DependencyLogicalSourceLink[],
  subset = false): readonly DependencyLogicalSourceLink[] | undefined {
  // Base64 filename components can themselves contain '/'. Preserve component
  // boundaries in the lookup key so a raw root name cannot alias a deep path.
  const links = new Map(entries.filter((entry) => entry.kind === Kind.Symlink).map((entry) => [JSON.stringify(entry.path), entry]));
  const permitted = new Map(sourceLinks?.map(link => [JSON.stringify(link.path), link]));
  const present: DependencyLogicalSourceLink[] = [];
  for (const [path, link] of permitted) {
    const entry = links.get(path);
    if (!entry) { if (!subset) fail(Failure.SourceBinding); continue; }
    if (entry.target !== link.target) fail(Failure.SourceBinding); present.push(link);
  }
  for (const entry of links.values()) {
    if (permitted.has(JSON.stringify(entry.path))) continue;
    let pending = Buffer.from(entry.target, "base64").toString("latin1").split("/");
    let resolved = entry.path.slice(0, -1);
    let hops = 0;
    if (pending[0] === "" || pending.join("/").includes("\0")) fail(Failure.ExternalSymlink);
    while (pending.length > 0) {
      const part = pending.shift()!;
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (resolved.length === 0) fail(Failure.ExternalSymlink);
        resolved = resolved.slice(0, -1);
      } else {
        resolved = [...resolved, Buffer.from(part, "latin1").toString("base64")];
        const link = links.get(JSON.stringify(resolved));
        if (link) {
          if (++hops > 40) fail(Failure.ExternalSymlink);
          const target = Buffer.from(link.target, "base64").toString("latin1").split("/");
          if (target[0] === "") fail(Failure.ExternalSymlink);
          resolved = resolved.slice(0, -1);
          pending = [...target, ...pending];
        }
      }
    }
  }
  return sourceLinks === undefined ? undefined : present;
}
