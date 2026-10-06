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
  DependencySourceBindingOutputVerifier, DependencySourceBindingRecord, DependencySourceBindingRecordV1, DependencySourceBindingOutputBody,
  DependencyLocalOutputEvidence, DependencySourceDirectoryPin, DependencyLegacyLocalSourceBindingRecord,
  DependencyLegacyLocalSourceVerifier, DependencyLegacyComparedReady, DependencyLegacyLocalDetachedTarget } from "../../worker-core/dependency-environment/ports/dependency-source-binding";
import { DependencyLegacyLocalSourceBindingKind } from "../../worker-core/dependency-environment/ports/dependency-source-binding";
import { assertDependencyLegacyLocalSourceBindingRecord, assertDependencySourceBindingRecord, assertDependencyOutputReference, assertDependencyLocalOutputEvidence,
  encodeDependencySourceBindingOutputBody } from "../../worker-core/dependency-environment/domain/dependency-source-binding-record";
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
  current(): void; record?: DependencySourceBindingRecord; reference?: DependencySourceBindingReference; compared?: DependencyLegacyLocalSourceBindingRecord; capture?: QualifiedNpmLocalInputs; closed: boolean };
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
export enum DependencySourceLinkEffectProofKind { InstalledLocal = "installed_local", LegacyLocalCompared = "legacy_local_compared" }
/** Closed effect selector over authentic private sessions. A capture session or
 * caller record cannot supply either branch. Both revalidate current authority. */
export function dependencySourceLinkEffectProof(value: DependencySourceLinkSession):
  | { kind: DependencySourceLinkEffectProofKind.InstalledLocal; record: DependencySourceBindingRecord; reference: DependencySourceBindingReference }
  | { kind: DependencySourceLinkEffectProofKind.LegacyLocalCompared; record: DependencyLegacyLocalSourceBindingRecord; reference: DependencySourceBindingReference } {
  const state = sessions.get(value);
  if (!state || state.closed || !state.reference) fail(); state.current();
  if (state.record && !state.compared) return { kind: DependencySourceLinkEffectProofKind.InstalledLocal, record: state.record, reference: state.reference };
  if (state.compared && !state.record) return { kind: DependencySourceLinkEffectProofKind.LegacyLocalCompared, record: state.compared, reference: state.reference };
  return fail();
}
/** Separate protected comparison accessor; installed accessor stays exact. */
export function dependencyComparedSourceLinkProof(value: DependencySourceLinkSession): {
  record: DependencyLegacyLocalSourceBindingRecord; reference: DependencySourceBindingReference;
} {
  const state = sessions.get(value);
  if (!state || state.closed || !state.compared || !state.reference) fail(); state.current();
  return { record: state.compared, reference: state.reference };
}
export function dependencySourceLinkAllowsSubset(value: DependencySourceLinkSession): boolean {
  const state = sessions.get(value); if (!state || state.closed) fail(); return !!(state.record || state.compared) && state.name !== "node_modules";
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
  current(); return session({ workspace: { ...observedWorkspace }, name: "node_modules", links: sourceLinks, current, capture });
}

/** Current capture facts only. No installer placeholder or protected grant. */
export function capturedDependencyLegacyLocalSourceFields(capture: QualifiedNpmLocalInputs):
  Pick<DependencyLegacyLocalSourceBindingRecord, "closureDigest" | "sourceLinks" | "directories" | "ancestors"> {
  capture = structuredClone(capture);
  if (revalidateNpmLocalClosure({ capture, maxDurationMs: 10000 }).status !== NpmInputCaptureStatus.Qualified) fail(DependencySourceBindingFailure.Changed);
  return immutable({ closureDigest: capture.closureDigest, sourceLinks: links(capture), directories: directoryPins(capture),
    ancestors: capture.ancestorPins.map(({ path, dev, ino, mode, mountId }) => ({ path, dev, ino, mode, mountId })) });
}

export function capturedDependencySourceBinding(capture: QualifiedNpmLocalInputs, binding: DependencyProofBinding,
  installerCompletionSha256: string): DependencySourceBindingRecordV1 {
  if (!sameDependencyWorkspace(capture.workspace, binding.workspace) ||
      revalidateNpmLocalClosure({ capture, maxDurationMs: 10000 }).status !== NpmInputCaptureStatus.Qualified) fail(DependencySourceBindingFailure.Changed);
  const record: DependencySourceBindingRecordV1 = { ...structuredClone(binding), version: 1,
    profile: DependencyInstallProfile.TestNpmLocalNoLifecycleV1, operationId: binding.generation,
    installerCompletionSha256, closureDigest: capture.closureDigest, sourceLinks: links(capture), directories: directoryPins(capture),
    ancestors: capture.ancestorPins.map(({ path, dev, ino, mode, mountId }) => ({ path, dev, ino, mode, mountId })) };
  validateRecord(record); return immutable(record);
}

function validateRecord(value: DependencySourceBindingRecord): void {
  try { assertDependencySourceBindingRecord(value); } catch { fail(); }
}

/** Derived body only. Does not issue a protected reference or install proof. */
export function capturedDependencySourceBindingOutputBody(capture: QualifiedNpmLocalInputs, binding: DependencyProofBinding,
  installerCompletionSha256: string): DependencySourceBindingOutputBody {
  const record = capturedDependencySourceBinding(capture, binding, installerCompletionSha256);
  const body = { ...record, version: 2 as const }; encodeDependencySourceBindingOutputBody(body); return immutable(body);
}

/** Retained private-file facts for trusted composition. These bytes alone do
 * not authenticate a producer/completion; production additionally fixes root,
 * operator identity and all execution/manifest custody. No file is created. */
export function readDependencyProtectedReference(reference: DependencySourceBindingReference,
  custodyRoot: DependencyWorkspaceIdentity, expectedUid: bigint): Buffer {
  assertDependencyOutputReference(reference);
  if (!canonical(custodyRoot.canonicalPath) || custodyRoot.canonicalPath === "/" || expectedUid < 0n ||
      !reference.path.startsWith(custodyRoot.canonicalPath + "/")) fail(DependencySourceBindingFailure.OutputProof);
  const handles: Retained[] = []; let fd: number | undefined;
  try {
    let parent = retain("/", handles); let protectedParent = false, custodyMount = "";
    for (const part of dirname(reference.path).split("/").filter(Boolean)) {
      parent = retain(parent.path === "/" ? "/" + part : parent.path + "/" + part, handles, parent.fd, part);
      if (parent.path === custodyRoot.canonicalPath) {
        if (!sameDependencyTree(custodyRoot, { dev: String(parent.before.dev), ino: String(parent.before.ino) })) fail(DependencySourceBindingFailure.OutputProof);
        protectedParent = true; custodyMount = parent.mountId;
      }
      if (protectedParent && (parent.before.uid !== expectedUid || (parent.before.mode & 0o7777n) !== 0o700n || parent.mountId !== custodyMount)) fail(DependencySourceBindingFailure.OutputProof);
    }
    if (!protectedParent) fail(DependencySourceBindingFailure.OutputProof);
    checkRetained(handles);
    fd = openSync(at(parent.fd, reference.path.slice(reference.path.lastIndexOf("/") + 1)), fileFlags);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== expectedUid || (before.mode & 0o7777n) !== 0o600n ||
        before.size < 1n || before.size > 65536n || mount(fd) !== parent.mountId ||
        String(before.dev) !== reference.identity.dev || String(before.ino) !== reference.identity.ino) fail(DependencySourceBindingFailure.OutputProof);
    const bytes = boundedBytes(fd, 65536), after = fstatSync(fd, { bigint: true }), named = lstatSync(at(parent.fd, reference.path.slice(reference.path.lastIndexOf("/") + 1)), { bigint: true });
    if (BigInt(bytes.length) !== before.size || !same(before, after) || before.uid !== after.uid || before.size !== after.size || before.nlink !== after.nlink ||
        before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || !same(before, named) || before.uid !== named.uid || named.nlink !== 1n || sha(bytes) !== reference.sha256) fail(DependencySourceBindingFailure.OutputProof);
    const fresh = openSync(at(parent.fd, reference.path.slice(reference.path.lastIndexOf("/") + 1)), fileFlags);
    try {
      const namedStat = fstatSync(fresh, { bigint: true });
      if (!same(before, namedStat) || before.uid !== namedStat.uid || namedStat.nlink !== 1n || mount(fresh) !== custodyMount || mount(fd) !== custodyMount) fail(DependencySourceBindingFailure.OutputProof);
    } finally { closeSync(fresh); }
    checkRetained(handles);
    for (const item of handles) if (item.path === custodyRoot.canonicalPath || item.path.startsWith(custodyRoot.canonicalPath + "/")) {
      if (fstatSync(item.fd, { bigint: true }).uid !== expectedUid) fail(DependencySourceBindingFailure.OutputProof);
    }
    return bytes;
  } finally { try { if (fd !== undefined) closeSync(fd); } finally { close(handles); } }
}

/** Exact relation between an already authenticated evidence record and claim.
 * This function neither authenticates the file nor proves who issued it. */
export function assertDependencyLocalOutputBinding(record: DependencySourceBindingRecord, evidence: DependencyLocalOutputEvidence): void {
  validateRecord(record); assertDependencyLocalOutputEvidence(evidence);
  if (record.version !== 2) fail(DependencySourceBindingFailure.OutputProof);
  const { outputReference, ...body } = record;
  const directory = dirname(evidence.start.path);
  if (outputReference.path !== `${directory}/verified-local-output.json` || evidence.start.path !== `${directory}/start.json` ||
      evidence.creator.path !== `${directory}/creator.json` || evidence.completion.path !== `${directory}/creator-completion.json` ||
      evidence.terminal.path !== `${directory}/terminal.json`) fail(DependencySourceBindingFailure.OutputProof);
  if (evidence.profile !== record.profile || evidence.generation !== record.generation || evidence.operationId !== record.operationId ||
      !sameDependencyWorkspace(evidence.workspace, record.workspace) || evidence.coverageRevision !== record.coverageRevision ||
      evidence.installKey !== record.installKey || evidence.closureDigest !== record.closureDigest || !sameDependencyTree(evidence.tree, record.tree) ||
      evidence.manifestDigest !== record.manifestDigest || evidence.completion.sha256 !== record.installerCompletionSha256 ||
      sha(Buffer.from(encodeDependencySourceBindingOutputBody(body))) !== evidence.verifiedBindingSha256) fail(DependencySourceBindingFailure.OutputProof);
}

/** Trusted private-record adapter. Independent protected output evidence and
 * actual completion are both mandatory; absence never falls back to caller facts. */
export class LocalDependencySourceBindingStore implements DependencyLocalInstallProofVerifier {
  constructor(readonly rootPath: string, private readonly completion: DependencySourceBindingCompletionVerifier,
    private readonly output?: DependencySourceBindingOutputVerifier, private readonly legacyLocal?: DependencyLegacyLocalSourceVerifier) {
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
  private read(path: string): { bytes: Buffer; reference: DependencySourceBindingReference; record: DependencySourceBindingRecord };
  private read(path: string, compared: true): { bytes: Buffer; reference: DependencySourceBindingReference; record: DependencyLegacyLocalSourceBindingRecord };
  private read(path: string, compared = false): { bytes: Buffer; reference: DependencySourceBindingReference; record: DependencySourceBindingRecord | DependencyLegacyLocalSourceBindingRecord } {
    const parent = this.parent(path);
    let fd: number;
    try { fd = openSync(at(parent.item.fd, path.slice(path.lastIndexOf("/") + 1)), fileFlags); }
    catch (error) { close(parent.handles); throw error; }
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.geteuid!()) || (before.mode & 0o7777n) !== 0o600n || before.size < 1n || before.size > 262144n || mount(fd) !== parent.item.mountId) fail();
      const bytes = boundedBytes(fd, 262144), after = fstatSync(fd, { bigint: true });
      if (BigInt(bytes.length) !== before.size || !same(before, after) || before.size !== after.size || before.nlink !== after.nlink || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs) fail(DependencySourceBindingFailure.Changed);
      let record: DependencySourceBindingRecord | DependencyLegacyLocalSourceBindingRecord;
      try { record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (compared) { assertDependencyLegacyLocalSourceBindingRecord(record); if (this.comparedPath(record) !== path) fail(); }
        else { assertDependencySourceBindingRecord(record); if (this.path(record) !== path) fail(); }
        if (!encode(record).equals(bytes)) fail(); }
      catch { fail(); }
      const named = lstatSync(at(parent.item.fd, path.slice(path.lastIndexOf("/") + 1)), { bigint: true });
      if (!same(before, named) || named.nlink !== 1n) fail(DependencySourceBindingFailure.Changed);
      if (compared) {
        if (before.uid !== after.uid || before.gid !== after.gid || before.uid !== named.uid || before.gid !== named.gid) fail(DependencySourceBindingFailure.Changed);
        for (const item of parent.handles) if (item.path === this.rootPath || item.path.startsWith(this.rootPath + "/")) {
          if (fstatSync(item.fd, { bigint: true }).uid !== BigInt(process.geteuid!()) || item.mountId !== parent.item.mountId) fail();
        }
      }
      checkRetained(parent.handles);
      return { bytes, record: immutable(record), reference: immutable({ path, identity: { dev: String(before.dev), ino: String(before.ino) }, sha256: sha(bytes) }) };
    } finally { try { closeSync(fd); } finally { close(parent.handles); } }
  }
  private comparedPath(record: DependencyLegacyLocalSourceBindingRecord): string {
    assertDependencyLegacyLocalSourceBindingRecord(record);
    return `${this.rootPath}/${record.candidate.workspace.dev}-${record.candidate.workspace.ino}/${record.candidate.generation}.${record.operationId}.compared-local.json`;
  }
  private synchronous(action: () => unknown): void {
    try { if (action() !== undefined) fail(DependencySourceBindingFailure.OutputProof); }
    catch { fail(DependencySourceBindingFailure.OutputProof); }
  }
  readInstalledHistory(reference: DependencySourceBindingReference): DependencySourceBindingRecord {
    assertDependencyOutputReference(reference);
    const observed = this.read(reference.path);
    if (!sameDependencyTree(reference.identity, observed.reference.identity) || reference.sha256 !== observed.reference.sha256) fail(DependencySourceBindingFailure.OutputProof);
    return observed.record;
  }
  /** Protected history only: deliberately opens neither sources nor stage. */
  readLegacyLocalCompared(reference: DependencySourceBindingReference): DependencyLegacyLocalSourceBindingRecord {
    assertDependencyOutputReference(reference);
    const observed = this.read(reference.path, true);
    if (!sameDependencyTree(reference.identity, observed.reference.identity) || reference.sha256 !== observed.reference.sha256) fail(DependencySourceBindingFailure.OutputProof);
    return observed.record;
  }
  /** Finite retained-capture publisher. No caller mapping DTO or permission
   * callback is accepted. Trusted composition must hold the actual owner fence. */
  publishLegacyLocalCompared(input: {
    readonly capture: QualifiedNpmLocalInputs; readonly sourceSession: DependencySourceLinkSession;
    readonly candidate: DependencyProofBinding; readonly operationId: string;
    readonly original: DependencyLegacyLocalSourceBindingRecord["original"];
    readonly referenceOutput: DependencySourceBindingReference;
  }): DependencySourceBindingReference {
    if (!this.legacyLocal) fail(DependencySourceBindingFailure.OutputProof);
    const capture = structuredClone(input.capture), candidate = structuredClone(input.candidate);
    const sourceLinks = readDependencySourceLinkSession(input.sourceSession, candidate.workspace, "node_modules");
    const retained = sessions.get(input.sourceSession);
    if (!retained?.capture || JSON.stringify(retained.capture) !== JSON.stringify(capture)) fail();
    if (!sameDependencyWorkspace(capture.workspace, candidate.workspace) ||
        revalidateNpmLocalClosure({ capture, maxDurationMs: 10000 }).status !== NpmInputCaptureStatus.Qualified ||
        JSON.stringify(sourceLinks) !== JSON.stringify(links(capture))) fail(DependencySourceBindingFailure.Changed);
    const record: DependencyLegacyLocalSourceBindingRecord = immutable({ version: 1,
      kind: DependencyLegacyLocalSourceBindingKind.LegacyLocalComparedSourceV1,
      profile: DependencyInstallProfile.TestNpmLocalNoLifecycleV1, operationId: input.operationId, candidate,
      original: structuredClone(input.original), referenceOutput: structuredClone(input.referenceOutput), closureDigest: capture.closureDigest,
      sourceLinks: links(capture), directories: directoryPins(capture),
      ancestors: capture.ancestorPins.map(({ path, dev, ino, mode, mountId }) => ({ path, dev, ino, mode, mountId })) });
    assertDependencyLegacyLocalSourceBindingRecord(record);
    const current = () => {
      this.synchronous(() => this.legacyLocal!.assertReferenceOutput(record));
      readDependencySourceLinkSession(input.sourceSession, candidate.workspace, "node_modules");
      if (revalidateNpmLocalClosure({ capture, maxDurationMs: 10000 }).status !== NpmInputCaptureStatus.Qualified) fail(DependencySourceBindingFailure.Changed);
      sourceDirectories(candidate.workspace, record.directories, record.ancestors, record.sourceLinks);
    };
    current(); const path = this.comparedPath(record), bytes = encode(record); if (bytes.length > 262144) fail();
    const custody = this.parent(this.rootPath + "/publication");
    try {
      const directoryName = `${candidate.workspace.dev}-${candidate.workspace.ino}`;
      try { mkdirSync(at(custody.item.fd, directoryName), { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      custody.item = retain(dirname(path), custody.handles, custody.item.fd, directoryName);
      if (custody.item.before.uid !== BigInt(process.geteuid!()) || (custody.item.before.mode & 0o7777n) !== 0o700n) fail();
      checkRetained(custody.handles);
      // Every collision fails; no preexisting leaf can be rewritten or adopted.
      const fd = openSync(at(custody.item.fd, path.slice(path.lastIndexOf("/") + 1)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fstatSync(fd, { bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.geteuid!()) || (stat.mode & 0o7777n) !== 0o600n || mount(fd) !== custody.item.mountId) fail();
        writeFileSync(fd, bytes); fsyncSync(fd);
      } finally { closeSync(fd); }
      for (const item of [...custody.handles].reverse()) fsyncSync(item.fd);
      const observed = this.read(path, true); if (!observed.bytes.equals(bytes)) fail(DependencySourceBindingFailure.Changed);
      current(); checkRetained(custody.handles); return observed.reference;
    } finally { close(custody.handles); }
  }
  openLegacyLocalCompared(receipt: DependencyLegacyComparedReady, reference: DependencySourceBindingReference,
    target?: DependencyLegacyLocalDetachedTarget): DependencySourceLinkSession {
    if (!this.legacyLocal || receipt.provenance.kind !== DependencyInstallProofKind.LegacyCompared) fail(DependencySourceBindingFailure.OutputProof);
    receipt = immutable(structuredClone(receipt)); reference = immutable(structuredClone(reference));
    const detached = target ? immutable(structuredClone(target)) : undefined;
    if (detached && (!canonical(detached.workspace.canonicalPath) || detached.workspace.canonicalPath === "/" ||
        ![detached.workspace.dev, detached.workspace.ino].every(decimal) || !/^dependency-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(detached.name) ||
        detached.workspace.dev !== receipt.tree.dev || detached.workspace.canonicalPath === receipt.workspace.canonicalPath ||
        detached.workspace.canonicalPath.startsWith(receipt.workspace.canonicalPath + "/"))) fail();
    const current = () => {
      const record = this.readLegacyLocalCompared(reference), binding = record.candidate;
      if (!sameDependencyWorkspace(binding.workspace, receipt.workspace) || !sameDependencyTree(binding.tree, receipt.tree) ||
          binding.generation !== receipt.generation || binding.coverageRevision !== receipt.coverageRevision ||
          binding.installKey !== receipt.installKey || binding.manifestDigest !== receipt.manifestDigest) fail();
      this.synchronous(() => this.legacyLocal!.assertComparedSource(receipt, record, reference));
      if (detached) {
        if (!this.legacyLocal!.assertDetachedTarget) fail(DependencySourceBindingFailure.OutputProof);
        assertDependencyOutputReference(detached.reference);
        this.synchronous(() => this.legacyLocal!.assertDetachedTarget!(receipt, record, detached));
      }
      sourceDirectories(binding.workspace, record.directories, record.ancestors, detached ? undefined : record.sourceLinks);
      return record;
    };
    const record = current();
    return session({ workspace: { ...(detached?.workspace ?? receipt.workspace) }, name: detached?.name ?? "node_modules",
      links: record.sourceLinks, compared: record, reference, current: () => { current(); } });
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
