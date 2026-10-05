import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  statfsSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, posix, resolve } from "node:path";
import { DependencyInstallProfile } from "../../worker-core/dependency-environment/domain/dependency-install-key";
import { DependencyLocalClosureKind, qualifyDependencyNpmLocalClosure } from "../../worker-core/dependency-environment/domain/dependency-local-closure";
import { DependencyInstallProofKind, sameDependencyTree, sameDependencyWorkspace,
  type DependencySourceBindingReference, type DependencyWorkspaceIdentity, type DependencyProofBinding } from "../../worker-core/dependency-environment/domain/dependency-receipt";
import type { DependencyLogicalSourceLink } from "../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import type { DependencyCompletedLocalReady, DependencyLocalInstallProofVerifier, DependencySourceBindingCompletionVerifier,
  DependencySourceBindingOutputVerifier, DependencySourceBindingRecord, DependencySourceDirectoryPin } from "../../worker-core/dependency-environment/ports/dependency-source-binding";
import { NpmInputCaptureStatus } from "./capture-npm-install-inputs";
import { NpmLocalPinKind, revalidateNpmLocalClosure, type QualifiedNpmLocalInputs } from "./capture-npm-local-closure";

export enum DependencySourceBindingFailure { Invalid = "invalid", Changed = "changed", Closed = "closed", Completion = "completion", OutputProof = "output_proof" }
export class DependencySourceBindingError extends Error {
  constructor(readonly reason: DependencySourceBindingFailure) { super(`dependency_source_binding:${reason}`); }
}
function fail(reason = DependencySourceBindingFailure.Invalid): never { throw new DependencySourceBindingError(reason); }
const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 40;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const canonical = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const coordinate = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && (!value || /^[a-zA-Z0-9._@+-]+(?:\/[a-zA-Z0-9._@+-]+)*$/.test(value)
  && !value.split("/").some(part => part === "." || part === ".." || part === "node_modules" || part === ".git"));
const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
function mount(fd: number): string {
  const text = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"), id = /^mnt_id:\s*(\d+)\s*$/m.exec(text)?.[1];
  if (!id || text.length > 65536) fail(); return id;
}
function at(fd: number, name: string): string { return `/proc/self/fd/${fd}${name ? "/" + name : ""}`; }
type Retained = { fd: number; path: string; before: BigIntStats; mountId: string; parent?: number; name?: string };
function retain(path: string, handles: Retained[], parent?: number, name?: string): Retained {
  const fd = openSync(parent === undefined ? path : at(parent, name!), flags);
  try {
    const before = fstatSync(fd, { bigint: true }); if (!before.isDirectory()) fail();
    const item = { fd, path, before, mountId: mount(fd), ...(parent === undefined ? {} : { parent, name: name! }) };
    handles.push(item); return item;
  } catch (error) { closeSync(fd); throw error; }
}
function checkRetained(handles: readonly Retained[]): void {
  for (const item of handles) {
    if (!same(item.before, fstatSync(item.fd, { bigint: true })) || mount(item.fd) !== item.mountId) fail(DependencySourceBindingFailure.Changed);
    if (item.parent !== undefined) {
      const fresh = openSync(at(item.parent, item.name!), flags);
      try { if (!same(item.before, fstatSync(fresh, { bigint: true })) || mount(fresh) !== item.mountId) fail(DependencySourceBindingFailure.Changed); }
      finally { closeSync(fresh); }
    }
  }
}
function close(handles: readonly Retained[]): void {
  let failed = false;
  for (const item of [...handles].reverse()) { try { closeSync(item.fd); } catch { failed = true; } }
  if (failed) fail(DependencySourceBindingFailure.Closed);
}
function boundedBytes(fd: number, maximum: number): Buffer {
  const buffer = Buffer.alloc(maximum + 1); let length = 0;
  while (length < buffer.length) { const read = readSync(fd, buffer, length, buffer.length - length, length); if (!read) break; length += read; }
  if (length > maximum) fail(); return buffer.subarray(0, length);
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}
function pinMatches(item: Retained, pin: DependencySourceDirectoryPin): void {
  if (String(item.before.dev) !== pin.dev || String(item.before.ino) !== pin.ino || String(item.before.mode) !== pin.mode ||
      item.mountId !== pin.mountId) fail(DependencySourceBindingFailure.Changed);
}
function directoryPins(capture: QualifiedNpmLocalInputs): DependencySourceDirectoryPin[] {
  const paths = new Set([""]);
  for (const pkg of capture.closure.packages) {
    let path = pkg.path;
    while (path) { paths.add(path); path = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""; }
  }
  return capture.pins.filter(pin => pin.kind === NpmLocalPinKind.Directory && paths.has(pin.path))
    .map(({ path, dev, ino, mode, mountId }) => ({ path, dev, ino, mode, mountId })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function links(capture: QualifiedNpmLocalInputs): DependencyLogicalSourceLink[] {
  const closure = qualifyDependencyNpmLocalClosure({ packageBytes: capture.packageBytes, lockBytes: capture.lockBytes, packages: capture.closure.packages });
  if (JSON.stringify(closure) !== JSON.stringify(capture.closure)) fail();
  // Independently recompute the existing frozen capture v1 digest contract.
  // This checks actual reconstructed inputs, not the caller's digest label.
  const closureDigest = sha(encode({ version: 1, lockName: capture.lockName, root: sha(capture.packageBytes), lock: sha(capture.lockBytes),
    layout: closure.layout, packages: closure.packages.map(pkg => ({ path: pkg.path, kind: pkg.kind, package: sha(pkg.packageBytes),
      directories: pkg.directories, files: pkg.files.map(file => ({ path: file.path, mode: file.mode, bytes: file.bytes.length, sha256: sha(file.bytes) })) })),
    edges: closure.edges }));
  if (capture.closureDigest !== closureDigest) fail();
  const result = new Map<string, DependencyLogicalSourceLink>();
  for (const edge of closure.edges) if (edge.kind === DependencyLocalClosureKind.PureWorkspaceLink) {
    const pkg = closure.packages.find(value => value.path === edge.targetPath);
    if (!pkg || pkg.kind !== edge.kind) fail();
    for (const installed of edge.installedPaths) {
      const path = installed.slice("node_modules/".length).split("/").map(part => Buffer.from(part).toString("base64"));
      const entry = { path, target: Buffer.from(posix.relative(posix.dirname(installed), pkg.path)).toString("base64"),
        sourcePath: pkg.path, packageManifestSha256: sha(pkg.packageBytes), closureDigest };
      const key = JSON.stringify(path), prior = result.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(entry)) fail(); result.set(key, entry);
    }
  }
  return immutable([...result.values()].sort((a, b) => JSON.stringify(a.path) < JSON.stringify(b.path) ? -1 : JSON.stringify(a.path) > JSON.stringify(b.path) ? 1 : 0));
}
function sourceDirectories(workspace: DependencyWorkspaceIdentity, pins: readonly DependencySourceDirectoryPin[],
  ancestors?: readonly DependencySourceDirectoryPin[], manifests?: readonly DependencyLogicalSourceLink[], observe = false): {
    directories: readonly DependencySourceDirectoryPin[]; ancestors: readonly DependencySourceDirectoryPin[];
  } {
  const handles: Retained[] = [];
  const observed: DependencySourceDirectoryPin[] = [];
  try {
    const expected = new Map((ancestors ?? []).map(pin => [pin.path, pin]));
    let current = retain("/", handles);
    if (ancestors) { const pin = expected.get("/"); if (!pin) fail(); pinMatches(current, pin); }
    for (const part of workspace.canonicalPath.split("/").filter(Boolean)) {
      current = retain(current.path === "/" ? "/" + part : current.path + "/" + part, handles, current.fd, part);
      if (ancestors && current.path !== workspace.canonicalPath) { const pin = expected.get(current.path); if (!pin) fail(); pinMatches(current, pin); }
    }
    if (!sameDependencyTree(workspace, { dev: String(current.before.dev), ino: String(current.before.ino) })) fail(DependencySourceBindingFailure.Changed);
    const root = current, held = new Map([["", root]]);
    const observedAncestors = handles.filter(item => item !== root).map(item => ({ path: item.path, dev: String(item.before.dev),
      ino: String(item.before.ino), mode: String(item.before.mode), mountId: item.mountId }));
    for (const pin of pins) {
      if (!coordinate(pin.path)) fail();
      let parent = root, path = "";
      for (const part of pin.path.split("/").filter(Boolean)) {
        path = path ? path + "/" + part : part;
        const existing = held.get(path);
        parent = existing ?? retain(workspace.canonicalPath + "/" + path, handles, parent.fd, part); held.set(path, parent);
      }
      if (!observe) pinMatches(parent, pin); if (parent.mountId !== root.mountId) fail(DependencySourceBindingFailure.Changed);
      observed.push({ path: pin.path, dev: String(parent.before.dev), ino: String(parent.before.ino), mode: String(parent.before.mode), mountId: parent.mountId });
    }
    for (const entry of manifests ?? []) {
      const target = held.get(entry.sourcePath); if (!target) fail();
      const fd = openSync(at(target.fd, "package.json"), fileFlags);
      try {
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 1024n * 1024n || mount(fd) !== root.mountId) fail();
        const bytes = boundedBytes(fd, 1024 * 1024), after = fstatSync(fd, { bigint: true });
        if (BigInt(bytes.length) !== before.size || !same(before, after) || before.size !== after.size ||
            before.nlink !== after.nlink || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || sha(bytes) !== entry.packageManifestSha256) fail(DependencySourceBindingFailure.Changed);
        const named = lstatSync(at(target.fd, "package.json"), { bigint: true });
        if (!same(before, named) || named.nlink !== 1n) fail(DependencySourceBindingFailure.Changed);
      } finally { closeSync(fd); }
    }
    checkRetained(handles); return { directories: observed, ancestors: observedAncestors };
  } finally { close(handles); }
}
type SessionState = { workspace: DependencyWorkspaceIdentity; name: string; links: readonly DependencyLogicalSourceLink[];
  current(): void; record?: DependencySourceBindingRecord; reference?: DependencySourceBindingReference; closed: boolean };
export type DependencySourceLinkSession = Readonly<{ profile: DependencyInstallProfile.TestNpmLocalNoLifecycleV1 }>;
const sessions = new WeakMap<object, SessionState>();
function session(state: Omit<SessionState, "closed">): DependencySourceLinkSession {
  const value = Object.freeze({ profile: DependencyInstallProfile.TestNpmLocalNoLifecycleV1 }); sessions.set(value, { ...state, closed: false }); return value;
}
export function readDependencySourceLinkSession(value: DependencySourceLinkSession, workspace: DependencyWorkspaceIdentity, name: string): readonly DependencyLogicalSourceLink[] {
  const state = sessions.get(value);
  if (!state || state.closed) fail(DependencySourceBindingFailure.Closed);
  if (!sameDependencyWorkspace(state.workspace, workspace) || state.name !== name) fail();
  state.current(); return state.links;
}
export function dependencySourceLinkProof(value: DependencySourceLinkSession): { record: DependencySourceBindingRecord; reference: DependencySourceBindingReference } {
  const state = sessions.get(value);
  if (!state || state.closed || !state.record || !state.reference) fail(); state.current();
  return { record: state.record, reference: state.reference };
}
export function dependencySourceLinkAllowsSubset(value: DependencySourceLinkSession): boolean {
  const state = sessions.get(value); if (!state || state.closed) fail(); return !!state.record && state.name !== "node_modules";
}
export function closeDependencySourceLinkSession(value: DependencySourceLinkSession): void { const state = sessions.get(value); if (state) state.closed = true; }

/** Capture/stage factual observation only. This cannot provide protected local
 * Ready/effect proof; the protected-session reader below is a separate boundary. */
export function openCapturedDependencySourceLinks(capture: QualifiedNpmLocalInputs,
  observedWorkspace = capture.workspace): DependencySourceLinkSession {
  capture = structuredClone(capture);
  if (capture.status !== NpmInputCaptureStatus.Qualified || !digest(capture.closureDigest) || !canonical(observedWorkspace.canonicalPath) || observedWorkspace.canonicalPath === "/") fail();
  const original = sameDependencyWorkspace(capture.workspace, observedWorkspace), sourceLinks = links(capture), originalPins = directoryPins(capture);
  const ancestorPins = capture.ancestorPins.map(({ path, dev, ino, mode, mountId }) => ({ path, dev, ino, mode, mountId }));
  // Stage coordinates are identical, but stage inode/mount pins are observed
  // independently. Original identities never masquerade as staged identities.
  const stage = original ? { directories: originalPins, ancestors: ancestorPins } : sourceDirectories(observedWorkspace, originalPins, undefined, sourceLinks, true);
  const current = () => {
    if (revalidateNpmLocalClosure({ capture, maxDurationMs: 10000 }).status !== NpmInputCaptureStatus.Qualified) fail(DependencySourceBindingFailure.Changed);
    sourceDirectories(capture.workspace, originalPins, ancestorPins);
    sourceDirectories(observedWorkspace, stage.directories, stage.ancestors, sourceLinks);
  };
  current(); return session({ workspace: { ...observedWorkspace }, name: "node_modules", links: sourceLinks, current });
}

export function capturedDependencySourceBinding(capture: QualifiedNpmLocalInputs, binding: DependencyProofBinding,
  installerCompletionSha256: string): DependencySourceBindingRecord {
  if (!sameDependencyWorkspace(capture.workspace, binding.workspace) ||
      revalidateNpmLocalClosure({ capture, maxDurationMs: 10000 }).status !== NpmInputCaptureStatus.Qualified) fail(DependencySourceBindingFailure.Changed);
  const record: DependencySourceBindingRecord = { ...structuredClone(binding), version: 1,
    profile: DependencyInstallProfile.TestNpmLocalNoLifecycleV1, operationId: binding.generation,
    installerCompletionSha256, closureDigest: capture.closureDigest, sourceLinks: links(capture), directories: directoryPins(capture),
    ancestors: capture.ancestorPins.map(({ path, dev, ino, mode, mountId }) => ({ path, dev, ino, mode, mountId })) };
  validateRecord(record); return immutable(record);
}

function exact(value: unknown, fields: readonly string[]): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
function validateRecord(value: DependencySourceBindingRecord): void {
  if (!value || !exact(value, ["version", "profile", "generation", "workspace", "coverageRevision", "installKey", "tree", "manifestDigest", "operationId",
      "installerCompletionSha256", "closureDigest", "sourceLinks", "directories", "ancestors"]) || value.version !== 1 ||
      value.profile !== DependencyInstallProfile.TestNpmLocalNoLifecycleV1 || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.generation) ||
      value.operationId !== value.generation || !exact(value.workspace, ["canonicalPath", "dev", "ino"]) || !exact(value.tree, ["dev", "ino"]) ||
      !canonical(value.workspace.canonicalPath) || value.workspace.canonicalPath === "/" || typeof value.coverageRevision !== "string" ||
      !value.coverageRevision.length || value.coverageRevision.trim() !== value.coverageRevision || value.coverageRevision.length > 1024 || /[\x00-\x1f\x7f]|sk-[A-Za-z0-9_-]{12,}|Bearer\s/i.test(value.coverageRevision) ||
      ![value.installKey, value.manifestDigest, value.installerCompletionSha256, value.closureDigest].every(digest) ||
      ![value.workspace.dev, value.workspace.ino, value.tree.dev, value.tree.ino].every(decimal) ||
      !Array.isArray(value.sourceLinks) || !Array.isArray(value.directories) || !Array.isArray(value.ancestors) ||
      value.sourceLinks.length > 128 || value.directories.length > 512 || value.ancestors.length > 512) fail();
  const pins = [...value.ancestors, ...value.directories];
  for (const pin of pins) if (!exact(pin, ["path", "dev", "ino", "mode", "mountId"]) ||
      ![pin.dev, pin.ino, pin.mode, pin.mountId].every(decimal)) fail();
  if (!value.directories.some(pin => pin.path === "") || new Set(pins.map(pin => pin.path)).size !== pins.length) fail();
  if (value.ancestors.some(pin => !canonical(pin.path)) || value.directories.some(pin => !coordinate(pin.path))) fail();
  const ancestry = ["/"]; let ancestor = "";
  for (const part of value.workspace.canonicalPath.split("/").filter(Boolean).slice(0, -1)) { ancestor += "/" + part; ancestry.push(ancestor); }
  if (value.ancestors.length !== ancestry.length || ancestry.some(path => !value.ancestors.some(pin => pin.path === path)) ||
      pins.some(pin => (BigInt(pin.mode) & 0o170000n) !== 0o40000n || BigInt(pin.ino) === 0n || BigInt(pin.mountId) === 0n)) fail();
  for (const pin of value.directories) if (pin.path && !value.directories.some(parent => parent.path === (pin.path.includes("/") ? posix.dirname(pin.path) : ""))) fail();
  for (const link of value.sourceLinks) if (!exact(link, ["path", "target", "sourcePath", "packageManifestSha256", "closureDigest"]) ||
      !Array.isArray(link.path) || !coordinate(link.sourcePath) || !link.sourcePath || !digest(link.packageManifestSha256) || link.closureDigest !== value.closureDigest ||
      typeof link.target !== "string" || Buffer.from(link.target, "base64").toString("base64") !== link.target ||
      !value.directories.some(pin => pin.path === link.sourcePath)) fail();
  for (const link of value.sourceLinks) {
    const parts = link.path.map(part => { if (typeof part !== "string" || part.length > 1024) fail(); const bytes = Buffer.from(part, "base64");
      if (!bytes.length || bytes.toString("base64") !== part || bytes.includes(47) || bytes.includes(0)) fail();
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes); });
    const installed = "node_modules/" + parts.join("/");
    if (!/^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(installed) ||
        Buffer.from(posix.relative(posix.dirname(installed), link.sourcePath)).toString("base64") !== link.target) fail();
  }
  if (new Set(value.sourceLinks.map(link => JSON.stringify(link.path))).size !== value.sourceLinks.length) fail();
}

/** Trusted private-record adapter. Independent protected output evidence and
 * actual completion are both mandatory; absence never falls back to caller facts. */
export class LocalDependencySourceBindingStore implements DependencyLocalInstallProofVerifier {
  constructor(readonly rootPath: string, private readonly completion: DependencySourceBindingCompletionVerifier,
    private readonly output?: DependencySourceBindingOutputVerifier) {
    if (process.platform !== "linux" || statfsSync("/proc/self/fd", { bigint: true }).type !== 0x9fa0n || !canonical(rootPath) ||
        !rootPath.endsWith("/dependency-source-bindings")) fail();
  }
  path(record: Pick<DependencySourceBindingRecord, "workspace" | "generation">): string {
    if (![record.workspace.dev, record.workspace.ino].every(decimal) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.generation)) fail();
    return `${this.rootPath}/${record.workspace.dev}-${record.workspace.ino}/${record.generation}.json`;
  }
  private assertCompletion(record: DependencySourceBindingRecord): void {
    try { this.completion.assertInstallerCompletion(record); } catch { fail(DependencySourceBindingFailure.Completion); }
  }
  private assertOutput(record: DependencySourceBindingRecord): void {
    if (!this.output) fail(DependencySourceBindingFailure.OutputProof);
    try { this.output.assertVerifiedOutput(record); } catch { fail(DependencySourceBindingFailure.OutputProof); }
  }
  publish(record: DependencySourceBindingRecord): DependencySourceBindingReference {
    record = immutable(structuredClone(record));
    validateRecord(record); this.assertOutput(record); this.assertCompletion(record);
    sourceDirectories(record.workspace, record.directories, record.ancestors, record.sourceLinks);
    const path = this.path(record), parent = dirname(path);
    const bytes = encode(record); if (bytes.length > 262144) fail();
    const custody = this.parent(this.rootPath + "/publication"), name = path.slice(path.lastIndexOf("/") + 1);
    try {
      const directoryName = parent.slice(parent.lastIndexOf("/") + 1);
      try { mkdirSync(at(custody.item.fd, directoryName), { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      custody.item = retain(parent, custody.handles, custody.item.fd, directoryName);
      if (custody.item.before.uid !== BigInt(process.geteuid!()) || (custody.item.before.mode & 0o7777n) !== 0o700n) fail();
      checkRetained(custody.handles);
      let fd: number;
      try { fd = openSync(at(custody.item.fd, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = this.read(path); if (!existing.bytes.equals(bytes)) fail(DependencySourceBindingFailure.Changed); fd = openSync(at(custody.item.fd, name), fileFlags); }
      try { if (fstatSync(fd).size === 0) writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      checkRetained(custody.handles);
      for (const item of [...custody.handles].reverse()) fsyncSync(item.fd);
      const observed = this.read(path); if (!observed.bytes.equals(bytes)) fail(DependencySourceBindingFailure.Changed);
      this.assertOutput(record); this.assertCompletion(record); sourceDirectories(record.workspace, record.directories, record.ancestors, record.sourceLinks);
      checkRetained(custody.handles); return observed.reference;
    } finally { close(custody.handles); }
  }
  private parent(path: string): { handles: Retained[]; item: Retained } {
    if (!canonical(path) || !path.startsWith(this.rootPath + "/")) fail();
    const handles: Retained[] = [];
    try {
      let item = retain("/", handles);
      for (const part of dirname(path).split("/").filter(Boolean)) {
        item = retain(item.path === "/" ? "/" + part : item.path + "/" + part, handles, item.fd, part);
        if (item.path === this.rootPath || item.path.startsWith(this.rootPath + "/")) {
          if (item.before.uid !== BigInt(process.geteuid!()) || (item.before.mode & 0o7777n) !== 0o700n) fail();
        }
      }
      checkRetained(handles); return { handles, item };
    } catch (error) { close(handles); throw error; }
  }
  private read(path: string): { bytes: Buffer; reference: DependencySourceBindingReference; record: DependencySourceBindingRecord } {
    const parent = this.parent(path);
    let fd: number;
    try { fd = openSync(at(parent.item.fd, path.slice(path.lastIndexOf("/") + 1)), fileFlags); }
    catch (error) { close(parent.handles); throw error; }
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.geteuid!()) || (before.mode & 0o7777n) !== 0o600n || before.size < 1n || before.size > 262144n || mount(fd) !== parent.item.mountId) fail();
      const bytes = boundedBytes(fd, 262144), after = fstatSync(fd, { bigint: true });
      if (BigInt(bytes.length) !== before.size || !same(before, after) || before.size !== after.size || before.nlink !== after.nlink || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs) fail(DependencySourceBindingFailure.Changed);
      let record: DependencySourceBindingRecord;
      try { record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as DependencySourceBindingRecord;
        validateRecord(record); if (this.path(record) !== path || !encode(record).equals(bytes)) fail(); }
      catch { fail(); }
      const named = lstatSync(at(parent.item.fd, path.slice(path.lastIndexOf("/") + 1)), { bigint: true });
      if (!same(before, named) || named.nlink !== 1n) fail(DependencySourceBindingFailure.Changed); checkRetained(parent.handles);
      return { bytes, record: immutable(record), reference: immutable({ path, identity: { dev: String(before.dev), ino: String(before.ino) }, sha256: sha(bytes) }) };
    } finally { try { closeSync(fd); } finally { close(parent.handles); } }
  }
  assertCompletedLocalInstall(receipt: DependencyCompletedLocalReady): void { const opened = this.open(receipt); closeDependencySourceLinkSession(opened); }
  open(receipt: DependencyCompletedLocalReady, target = { workspace: receipt.workspace, name: "node_modules" }): DependencySourceLinkSession {
    receipt = immutable(structuredClone(receipt));
    target = structuredClone(target);
    if (!canonical(target.workspace.canonicalPath) || target.workspace.canonicalPath === "/" || ![target.workspace.dev, target.workspace.ino].every(decimal) ||
        (target.name === "node_modules" ? !sameDependencyWorkspace(target.workspace, receipt.workspace) :
          !/^dependency-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(target.name) || target.workspace.dev !== receipt.tree.dev ||
          target.workspace.canonicalPath === receipt.workspace.canonicalPath || target.workspace.canonicalPath.startsWith(receipt.workspace.canonicalPath + "/"))) fail();
    const reference = receipt.provenance.sourceBinding, path = this.path(receipt);
    if (receipt.provenance.kind !== DependencyInstallProofKind.CompletedLocalInstallV1 || reference.path !== path) fail();
    const current = () => {
      const observed = this.read(path), record = observed.record;
      if (!sameDependencyTree(reference.identity, observed.reference.identity) || reference.sha256 !== observed.reference.sha256 ||
          !sameDependencyWorkspace(record.workspace, receipt.workspace) || !sameDependencyTree(record.tree, receipt.tree) ||
          record.generation !== receipt.generation || record.coverageRevision !== receipt.coverageRevision || record.installKey !== receipt.installKey ||
          record.manifestDigest !== receipt.manifestDigest || record.operationId !== receipt.provenance.operationId ||
          record.installerCompletionSha256 !== receipt.provenance.installerDrainEvidenceId || receipt.provenance.verificationEvidenceId !== record.manifestDigest) fail();
      this.assertOutput(record); this.assertCompletion(record);
      // Historical trash uses physical original pins but deliberately does not
      // compare current manifest/code bytes with the old captured generation.
      sourceDirectories(record.workspace, record.directories, record.ancestors);
      return record;
    };
    const record = current();
    return session({ workspace: { ...target.workspace }, name: target.name, links: record.sourceLinks, record,
      reference: { ...reference, identity: { ...reference.identity } }, current: () => { current(); } });
  }
}
