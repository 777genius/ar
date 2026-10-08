import { decodeHostedInventoryBytes } from "../../../core/host-infrastructure/host-inventory";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DependencyAdmissionError, DependencyAdmissionFailure, sameDependencyAttempt } from "../../../core/dependency-environment/dependency-owner";
import { dependencyToolGuestConfigPath, type DependencyToolFile, type DependencyToolQualification } from "../../../core/dependency-environment/dependency-tool-profile";
import { DependencyToolReadyReadStatus, DependencyToolReadyProvenanceKind, matchesRegistryDependencyToolReady, matchesDependencyToolReadyIdentity,
  type DependencyToolReadyReader, type DependencyToolReadyFacts } from "../../../core/dependency-environment/dependency-tool-ready-reader";
import { assertHostedActivationFence, decodeHostedActivationBytes, readHostedActivationBytes, readHostedOrdinaryProcessOrigin,
  type HostedActivationFence } from "./hosted-process-activation";
import { assertHostedDependencyPhysicalWorkspace, readHostedDependencyAttempt, readHostedDependencyBinding, hostedDependencyPolicyRoot, type HostedDependencyBinding } from "./hosted-dependency-workspace";
import { assertHostedDependencyToolProfileFiles, trustedFile } from "./hosted-dependency-tool-files";
import { observeHostedFdProcess, readHostedFdProfile, hostedFdGroupPids, assertHostedFdInternals, type HostedFdProcess, type HostedFdUnit } from "./hosted-fd-observation";
import { openHostedRetainedToolFiles, assertHostedRetainedToolDescriptors, retainHostedToolFilesInvocation, bindHostedToolFilesChild,
  revokeHostedRetainedToolFiles, hostedToolFilesForChild, assertHostedToolCapsuleCopy, type HostedRetainedToolFiles } from "./hosted-retained-tool-files";
import type { CodexAppServerProcessInvocation } from "./node-app-server-process";
import { CodexProviderEgressProfileId } from "../../codex-provider-egress-policy";
import { assertHostedDependencyParentEnvironment, assertHostedDependencyParentRecipe } from "./hosted-dependency-parent-recipe";

type Plan = { readonly unit: string; readonly root: string; readonly binding: HostedDependencyBinding;
  readonly readyReader: DependencyToolReadyReader;
  readonly provenance: DependencyToolReadyFacts["provenance"];
  readonly sourceAncestors: readonly Readonly<{ canonicalPath: string; dev: string; ino: string }>[];
  readonly qualification: DependencyToolQualification; readonly descriptorScope: HostedRetainedToolFiles;
  readonly attempt: ReturnType<typeof readHostedDependencyAttempt>; readonly parentBirth: string;
  readonly parentGroup: string; readonly sources: readonly string[];
  readonly rootIdentity: Readonly<{ dev: bigint; ino: bigint }>;
  readonly files: readonly Readonly<{ pin: DependencyToolFile; dev: bigint; ino: bigint }>[]; closed: boolean };
const invocations = new WeakMap<object, Plan>(), children = new WeakMap<ChildProcess, Plan>();
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fail(): never { throw new DependencyAdmissionError(DependencyAdmissionFailure.Unsupported); }

/** The protected actual ordinary start, rather than frame fields, selects this
 * pre-payload parent boundary. Owner/FD guard is independently held by caller. */
export function assertHostedDependencyToolParentFrame(fence: HostedActivationFence, unit: string, frame: string | Buffer): void {
  assertHostedActivationFence(fence);
  const id = /^subscription-runtime-ordinary-([a-f0-9-]{36})\.service$/.exec(unit)?.[1];
  if (!id) return;
  const bytes = readHostedActivationBytes(`ordinary-starts/${id}.json`); if (!bytes) fail();
  const start = decodeHostedActivationBytes(bytes) as Record<string, unknown>, binding = readHostedDependencyBinding(String(start.jobId));
  if (binding?.version !== 2) return;
  if (start.unit !== unit || start.installationId !== binding.installationId || start.jobRootDir !== binding.jobRootDir ||
      start.workspacePath !== binding.workspace.canonicalPath || start.grantSha256 !== binding.grantDigest) fail();
  const inventoryBytes = readHostedActivationBytes("readonly-inventory.json"), installationBytes = readHostedActivationBytes("host-installation.json");
  if (!inventoryBytes || !installationBytes) fail();
  const inventory = decodeHostedInventoryBytes(inventoryBytes) as Record<string, unknown>, installation = decodeHostedActivationBytes(installationBytes) as Record<string, unknown>;
  if ((inventory.schemaVersion !== 4 && inventory.schemaVersion !== 5) || installation.inventorySha256 !== hash(inventoryBytes) || !Array.isArray(inventory.ordinaryCreators)) fail();
  const rows = inventory.ordinaryCreators.filter(value => !!value && typeof value === "object" && value.creatorId === start.creatorId);
  if (rows.length !== 1) fail();
  const launch = rows[0].launch as { command: unknown; cwd: unknown; args: unknown };
  if (!launch || launch.command !== process.execPath || launch.cwd !== binding.workspace.canonicalPath || !Array.isArray(launch.args)) fail();
  assertHostedDependencyParentRecipe(launch.args, binding.jobRootDir, binding.workspace.canonicalPath);
  const data = decodeHostedActivationBytes(Buffer.from(frame)) as Record<string, unknown>;
  if (!data || typeof data !== "object" || Object.keys(data).sort().join(",") !== "env,schemaVersion" || data.schemaVersion !== 1 ||
      !data.env || typeof data.env !== "object" || Array.isArray(data.env)) fail();
  assertHostedDependencyParentEnvironment(data.env as Record<string, string>, binding.jobRootDir);
  assertParentAuthWriterScope(binding, launch.args as string[]);
}

/** Metadata only: never open auth.json or derive authority from a credential.
 * The exact inventoried auth leaf and its capacity sibling must stay beneath
 * the root-owned job namespace before any privileged migration can execute. */
function assertParentAuthWriterScope(binding: HostedDependencyBinding, args: readonly string[]): void {
  assertHostedDependencyPhysicalWorkspace(binding); // Includes all bind/mount aliases.
  const job = lstatSync(binding.jobRootDir, { bigint: true });
  const authPath = `${binding.jobRootDir}/auth`, auth = lstatSync(authPath, { bigint: true });
  if ((job.mode & 0o777n) !== 0o700n || !auth.isDirectory() || auth.uid !== 0n || auth.gid !== 0n ||
      (auth.mode & 0o777n) !== 0o700n || auth.dev !== job.dev || realpathSync(authPath) !== authPath) fail();
  // Capacity derives dirname(realpath(auth)), not the nominal CLI string.
  // All existing migration/store descendants are metadata-checked; a future
  // root-owned writer creates missing leaves under this nonreplaceable parent.
  let count = 0;
  const walk = (path: string, depth: number, strictCapacity: boolean): void => {
    if (++count > 4096 || depth > 16) fail();
    let s;
    try { s = lstatSync(path, { bigint: true }); }
    catch (error) { if (depth === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (depth === 0 && !s.isDirectory()) fail();
    if (s.uid !== 0n || s.gid !== 0n || s.dev !== job.dev || realpathSync(path) !== path) fail();
    if (s.isDirectory()) {
      if ((s.mode & 0o777n) !== 0o700n) fail();
      const names = readdirSync(path); if (names.length + count > 4096) fail();
      for (const name of names) walk(join(path, name), depth + 1, strictCapacity);
    } else if (!s.isFile() || s.nlink !== 1n || (s.mode & 0o022n) ||
        strictCapacity && (s.mode & 0o777n) !== 0o600n) fail();
  };
  walk(`${binding.jobRootDir}/.subscription-runtime-account-capacity`, 0, true);
  // Other actual fixed startup/migration writers cannot be redirected by a
  // preexisting state/handoff directory or flat event/key/log leaf alias.
  for (const name of ["state", "durable-handoffs"]) walk(join(binding.jobRootDir, name), 0, false);
  const task = args[args.indexOf("--task-id") + 1]; if (!task) fail();
  for (const name of ["encryption-key.hex", `${task}.events.jsonl`, `${task}.log`, `${task}.progress.json`]) {
    const path = join(binding.jobRootDir, name);
    try {
      const leaf = lstatSync(path, { bigint: true });
      if (!leaf.isFile() || leaf.uid !== 0n || leaf.nlink !== 1n || (leaf.mode & 0o022n) ||
          leaf.dev !== job.dev || realpathSync(path) !== path) fail();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  assertHostedDependencyPhysicalWorkspace(binding);
  const after = lstatSync(authPath, { bigint: true }), parent = lstatSync(binding.jobRootDir, { bigint: true });
  if (after.dev !== auth.dev || after.ino !== auth.ino || after.ctimeNs !== auth.ctimeNs ||
      parent.dev !== job.dev || parent.ino !== job.ino) fail();
}

/** Only a live enrolled origin and its reserved provider can prepare the plan.
 * The returned configuration is not a permit; the retained record FD is private. */
export function prepareHostedDependencyToolPlan(fence: HostedActivationFence, unit: string, binding: HostedDependencyBinding,
  root: string, writable: readonly string[], sources: readonly string[], readyReader?: DependencyToolReadyReader): { readonly mounts: readonly string[]; readonly cache: string; readonly sourcePaths: readonly string[] } | undefined {
  assertHostedActivationFence(fence);
  if (binding.version === 1) return undefined;
  // Reference purpose has no N3/provider path, even with a supplied reader.
  if (binding.version === 3) fail();
  if (!readyReader) fail();
  if (pending.has(unit)) fail();
  const origin = readHostedOrdinaryProcessOrigin(fence);
  const attempt = readHostedDependencyAttempt(binding, origin.start, String(origin.reservation.startId));
  const profile = readHostedFdProfile();
  if (!profile || profile.node.path !== binding.toolProfile.node.path || profile.node.sha256 !== binding.toolProfile.node.sha256 ||
      root !== `${hostedDependencyPolicyRoot}/dependency-provider-roots/${providerId(unit)}` || writable.length !== 3 ||
      writable[0] !== binding.workspace.canonicalPath || sources.some(path => path === "/" || path === hostedDependencyPolicyRoot)) fail();
  assertHostedDependencyToolProfileFiles(binding.toolProfile, binding.jobRootDir);
  const initial = readyReader.readCurrent();
  if (initial.status !== DependencyToolReadyReadStatus.Ready) fail();
  assertLocalSources(binding, initial.facts.provenance);
  const localRoots = initial.facts.provenance.kind === DependencyToolReadyProvenanceKind.LocalCompleted ?
    initial.facts.provenance.readonlySources : [];
  const sourceAncestors = localSourceAncestors(binding, initial.facts.provenance);
  const opened = openHostedRetainedToolFiles({ unit, parentStartId: attempt.launch.startId, jobId: binding.jobId, bindingBytes: encode(binding) });
  try {
    const q = opened.qualification, path = opened.capsulePath;
    const parentProcess = observeHostedFdProcess(process.pid);
    const rootStat = lstatSync(root, { bigint: true });
    const plan: Plan = { unit, root, binding, readyReader, provenance: initial.facts.provenance, sourceAncestors,
      qualification: q, descriptorScope: opened.scope, attempt, parentBirth: parentProcess.birth,
      files: Object.freeze([...q.profile.readonlyFiles, q.profile.node].map(pin => {
        const s = lstatSync(pin.path, { bigint: true }); return Object.freeze({ pin, dev: s.dev, ino: s.ino });
      })),
      rootIdentity: Object.freeze({ dev: rootStat.dev, ino: rootStat.ino }),
      parentGroup: parentProcess.group, sources: Object.freeze([...sources, ...writable, `${binding.workspace.canonicalPath}/.git`,
        `${binding.workspace.canonicalPath}/node_modules`, ...binding.toolProfile.readonlyFiles.map(f => f.path),
        binding.toolProfile.node.path, binding.toolProfile.cache.canonicalPath, dependencyToolGuestConfigPath,
        ...localRoots.map(source => source.canonicalPath), ...sourceAncestors.map(ancestor => ancestor.canonicalPath)]), closed: false };
    validatePlan(fence, plan);
    prepared.set(plan, true);
    pending.set(unit, plan);
    const tree = `${binding.workspace.canonicalPath}/node_modules`;
    return Object.freeze({ cache: binding.toolProfile.cache.canonicalPath,
      sourcePaths: Object.freeze([...sourceAncestors.map(ancestor => ancestor.canonicalPath), ...localRoots.map(source => source.canonicalPath)]), mounts: Object.freeze([
      `BindReadOnlyPaths=${tree}:${tree}:norbind`,
      // Each ancestor is a RW mountpoint: rename/replacement cannot redirect a
      // source link around the RO leaf, while ordinary sibling writes remain.
      ...sourceAncestors.map(ancestor => `BindPaths=${ancestor.canonicalPath}:${ancestor.canonicalPath}:norbind`),
      ...localRoots.map(source => `BindReadOnlyPaths=${source.canonicalPath}:${source.canonicalPath}:norbind`),
      ...binding.toolProfile.readonlyFiles.map(f => `BindReadOnlyPaths=${f.path}:${f.path}:norbind`),
      ...(sources.includes(binding.toolProfile.node.path) ? [] : [`BindReadOnlyPaths=${binding.toolProfile.node.path}:${binding.toolProfile.node.path}:norbind`]),
      `BindPaths=${binding.toolProfile.cache.canonicalPath}:${binding.toolProfile.cache.canonicalPath}:norbind`,
      `BindReadOnlyPaths=${path}:${dependencyToolGuestConfigPath}:norbind`,
    ]) });
  } catch (error) { revokeHostedRetainedToolFiles(opened.scope); throw error; }
}
// The only cross-function handle is keyed by the real just-reserved unit. It is
// consumed synchronously by the same fixed producer, never exported as data.
const pending = new Map<string, Plan>(), prepared = new WeakMap<Plan, boolean>();
function closePlan(plan: Plan): void {
  if (plan.closed) return; plan.closed = true;
  revokeHostedRetainedToolFiles(plan.descriptorScope);
}
export function abandonHostedDependencyToolPlan(unit: string): void {
  const plan = pending.get(unit); if (!plan) return;
  pending.delete(unit); closePlan(plan);
}
export function abandonHostedDependencyToolInvocation(invocation: CodexAppServerProcessInvocation): void {
  const plan = invocations.get(invocation); if (!plan) return;
  invocations.delete(invocation); closePlan(plan);
}
export function retainHostedDependencyToolInvocation(fence: HostedActivationFence, invocation: CodexAppServerProcessInvocation): void {
  assertHostedActivationFence(fence);
  const unit = invocation.systemdUnit; if (!unit) fail();
  const plan = pending.get(unit);
  const origin = readHostedOrdinaryProcessOrigin(fence, plan?.descriptorScope), binding = readHostedDependencyBinding(String(origin.start.jobId));
  if (binding?.version !== 2) return;
  if (!plan || !prepared.has(plan) || invocations.has(invocation)) fail();
  try { validatePlan(fence, plan); retainHostedToolFilesInvocation(plan.descriptorScope, invocation); invocations.set(invocation, plan); pending.delete(unit); }
  catch (error) { abandonHostedDependencyToolPlan(unit); throw error; }
}
export function bindHostedDependencyToolChild(invocation: CodexAppServerProcessInvocation, child: ChildProcess): void {
  const plan = invocations.get(invocation); if (!plan) return;
  if (plan.closed || !child.pid || children.has(child)) fail();
  bindHostedToolFilesChild(plan.descriptorScope, invocation, child);
  invocations.delete(invocation); children.set(child, plan);
  const close = () => {
    children.delete(child); closePlan(plan);
  };
  child.once("close", close); child.once("error", close);
}

/** Called by the fixed FD guard only after its current actual collection. The
 * observation is internal to that guard; caller PID/config cannot choose it. */
export function assertHostedDependencyToolRelease(child: ChildProcess, fence: HostedActivationFence,
  bootstrap: HostedFdProcess, unit: HostedFdUnit): void {
  assertHostedActivationFence(fence);
  // The separate managed custody route does not have an ordinary origin. Only
  // actual self cgroup facts, never an env/profile flag, select this boundary.
  if (!/^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-ordinary-[a-f0-9-]{36}\.service$/.test(readFileSync("/proc/self/cgroup", "utf8").trim())) {
    if (children.has(child)) fail(); return;
  }
  const plan = children.get(child);
  const scope = hostedToolFilesForChild(child);
  if (plan && scope !== plan.descriptorScope) fail();
  const origin = readHostedOrdinaryProcessOrigin(fence, scope), binding = readHostedDependencyBinding(String(origin.start.jobId));
  if (binding?.version !== 2) { if (plan) fail(); return; }
  if (!plan || plan.closed || plan.unit !== unit.unit || !child.pid || unit.root !== plan.root) fail();
  validatePlan(fence, plan);
  assertNamespace(plan, bootstrap, unit);
  const after = observeHostedFdProcess(bootstrap.pid);
  if (after.birth !== bootstrap.birth || after.mount !== bootstrap.mount || after.group !== bootstrap.group ||
      after.user !== bootstrap.user || after.pidNamespace !== bootstrap.pidNamespace) fail();
  validatePlan(fence, plan);
}
function validatePlan(fence: HostedActivationFence, plan: Plan): void {
  assertHostedActivationFence(fence);
  if (plan.closed) fail();
  const origin = readHostedOrdinaryProcessOrigin(fence, plan.descriptorScope), q = plan.qualification, binding = plan.binding;
  const root = lstatSync(plan.root, { bigint: true }), parentDirectory = lstatSync(dirname(plan.root), { bigint: true });
  if (!root.isDirectory() || root.uid !== 0n || root.gid !== 0n || (root.mode & 0o777n) !== 0o700n ||
      root.dev !== plan.rootIdentity.dev || root.ino !== plan.rootIdentity.ino || !parentDirectory.isDirectory() ||
      parentDirectory.uid !== 0n || (parentDirectory.mode & 0o777n) !== 0o700n) fail();
  if (origin.profileId !== CodexProviderEgressProfileId.TestNpmQualification) fail();
  if (!encode(readHostedDependencyBinding(binding.jobId)).equals(encode(binding)) ||
      !sameDependencyAttempt(readHostedDependencyAttempt(binding, origin.start, String(origin.reservation.startId)), plan.attempt)) fail();
  const provider = readHostedActivationBytes(`ordinary-starts/${providerId(plan.unit)}.json`),
    relation = readHostedActivationBytes(`dependency-provider-attempts/${providerId(plan.unit)}.json`);
  if (!provider || !relation) fail();
  const row = decodeHostedActivationBytes(relation) as Record<string, unknown>, start = decodeHostedActivationBytes(provider) as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "attemptId,epoch,parentStartId,providerStartId,startDigest,unit,version" || row.version !== 1 ||
      row.parentStartId !== plan.attempt.launch.startId || row.attemptId !== plan.attempt.attemptId || row.epoch !== plan.attempt.epoch ||
      row.providerStartId !== providerId(plan.unit) || row.unit !== plan.unit || row.startDigest !== hash(provider) ||
      start.jobId !== binding.jobId || start.unit !== plan.unit || start.workspacePath !== binding.workspace.canonicalPath ||
      start.installationId !== binding.installationId || start.grantSha256 !== binding.grantDigest) fail();
  // The admitted worker-owned reader opens only established history and closes
  // every temporary descriptor before the FD-table checks below. It is retained
  // with this actual invocation/child, never reconstructed from serialized facts.
  const ready = plan.readyReader.readCurrent();
  const expected = { workspace: binding.workspace, coverageRevision: hash(encode(binding)),
    revision: q.readyRevision, installKey: q.installKey, tree: q.tree, manifestDigest: q.manifestDigest };
  if (ready.status !== DependencyToolReadyReadStatus.Ready ||
      !(ready.facts.provenance.kind === DependencyToolReadyProvenanceKind.RegistryCompleted ?
        matchesRegistryDependencyToolReady(expected, ready.facts) :
        ready.facts.provenance.kind === DependencyToolReadyProvenanceKind.LocalCompleted && matchesDependencyToolReadyIdentity(expected, ready.facts)) ||
      !encode(ready.facts.provenance).equals(encode(plan.provenance)) ||
      q.installationId !== binding.installationId || q.runtimeSha !== binding.runtimeSha || q.grantDigest !== binding.grantDigest ||
      !encode(q.workspace).equals(encode(binding.workspace)) || q.startId !== plan.attempt.launch.startId || q.attemptId !== plan.attempt.attemptId ||
      q.epoch !== plan.attempt.epoch ||
      binding.version !== 2 || !encode(q.profile).equals(encode(binding.toolProfile))) fail();
  assertLocalSources(binding, ready.facts.provenance);
  if (!encode(localSourceAncestors(binding, ready.facts.provenance)).equals(encode(plan.sourceAncestors))) fail();
  assertHostedRetainedToolDescriptors(plan.descriptorScope);
  assertHostedDependencyToolProfileFiles(q.profile, binding.jobRootDir);
  for (const file of plan.files) {
    const s = lstatSync(file.pin.path, { bigint: true });
    if (s.dev !== file.dev || s.ino !== file.ino || trustedFile(file.pin.path).sha256 !== file.pin.sha256) fail();
  }
  const profile = readHostedFdProfile();
  if (!profile || profile.node.path !== q.profile.node.path || profile.node.sha256 !== q.profile.node.sha256) fail();
  const tree = lstatSync(`${binding.workspace.canonicalPath}/node_modules`, { bigint: true });
  if (!tree.isDirectory() || String(tree.dev) !== q.tree.dev || String(tree.ino) !== q.tree.ino) fail();
  const parent = observeHostedFdProcess(process.pid);
  if (parent.birth !== plan.parentBirth || parent.group !== plan.parentGroup || parent.group !== `0::${String(origin.start.controlGroup)}`) fail();
  // Temporary history/profile IO has closed. Only the continuously retained
  // two leaves may remain: state journals and same-inode alias opens deny too.
  assertHostedRetainedToolDescriptors(plan.descriptorScope);
}
function providerId(unit: string): string {
  const id = /^subscription-runtime-hosted-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.service$/.exec(unit)?.[1];
  if (!id) fail(); return id;
}

/** Only the captive current reader selects these paths. Directory pins are
 * mount facts; the worker-owned per-entry exposure separately checks every
 * source member, hardlink and inner link against its retained physical walk. */
function assertLocalSources(binding: HostedDependencyBinding, provenance: DependencyToolReadyFacts["provenance"]): void {
  if (provenance.kind === DependencyToolReadyProvenanceKind.RegistryCompleted) return;
  if (provenance.kind !== DependencyToolReadyProvenanceKind.LocalCompleted) fail();
  assertHostedDependencyPhysicalWorkspace(binding);
  const reference = provenance.sourceBinding, parent = `${hostedDependencyPolicyRoot}/dependency-source-bindings/${binding.workspace.dev}-${binding.workspace.ino}`;
  if (!reference.path.startsWith(parent + "/") ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(reference.path.slice(parent.length + 1)) ||
      !/^[a-f0-9]{64}$/.test(reference.sha256)) fail();
  const before = lstatSync(reference.path, { bigint: true }), directory = lstatSync(parent, { bigint: true });
  if (!before.isFile() || before.uid !== 0n || before.gid !== 0n || before.nlink !== 1n ||
      (before.mode & 0o7777n) !== 0o600n || before.size < 1n || before.size > 262144n ||
      String(before.dev) !== reference.identity.dev || String(before.ino) !== reference.identity.ino ||
      !directory.isDirectory() || directory.uid !== 0n || (directory.mode & 0o7777n) !== 0o700n ||
      trustedFile(reference.path).sha256 !== reference.sha256) fail();
  const after = lstatSync(reference.path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs) fail();
  const roots = provenance.readonlySources;
  if (roots.length > 128) fail();
  for (let index = 0; index < roots.length; index++) {
    const source = roots[index]!, path = source.canonicalPath;
    // Fixed systemd mount syntax has no payload-selected escaping/expansion.
    if (!path.startsWith(binding.workspace.canonicalPath + "/") || /[\s:%\\"'\x00-\x1f\x7f]/.test(path) || path.length > 4096 ||
        [".git", "node_modules"].some(name => path === `${binding.workspace.canonicalPath}/${name}` || path.startsWith(`${binding.workspace.canonicalPath}/${name}/`)) ||
        roots.slice(0, index).some(other => other.canonicalPath >= path || path.startsWith(other.canonicalPath + "/"))) fail();
    for (let ancestor = path;; ancestor = dirname(ancestor)) {
      const info = lstatSync(ancestor);
      if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) || realpathSync(ancestor) !== ancestor) fail();
      if (ancestor === "/") break;
    }
    const info = lstatSync(path, { bigint: true });
    if (String(info.dev) !== source.identity.dev || String(info.ino) !== source.identity.ino) fail();
  }
}

/** Derive the finite topology only from the same captive source roots. No
 * caller can nominate an ancestor or substitute a mount/identity descriptor. */
function localSourceAncestors(binding: HostedDependencyBinding, provenance: DependencyToolReadyFacts["provenance"]) {
  const paths = new Set<string>();
  if (provenance.kind === DependencyToolReadyProvenanceKind.LocalCompleted) {
    for (const source of provenance.readonlySources) {
      if (source.canonicalPath.slice(binding.workspace.canonicalPath.length + 1).split("/").some(part => part === ".git" || part === "node_modules")) fail();
      for (let path = dirname(source.canonicalPath); path !== binding.workspace.canonicalPath; path = dirname(path)) {
        if (!path.startsWith(binding.workspace.canonicalPath + "/") || paths.size >= 512 && !paths.has(path)) fail();
        paths.add(path);
      }
    }
  }
  return Object.freeze([...paths].sort().map(canonicalPath => {
    const info = lstatSync(canonicalPath, { bigint: true });
    if (!info.isDirectory() || info.uid !== 0n || (info.mode & 0o022n) || realpathSync(canonicalPath) !== canonicalPath) fail();
    return Object.freeze({ canonicalPath, dev: String(info.dev), ino: String(info.ino) });
  }));
}

function assertNamespaceMounts(plan: Plan, process: HostedFdProcess) {
  const prefix = `/proc/${process.pid}/root`, q = plan.qualification;
  const root = statSync(prefix, { bigint: true });
  if (!root.isDirectory() || root.dev !== plan.rootIdentity.dev || root.ino !== plan.rootIdentity.ino) fail();
  const mounts = readFileSync(`/proc/${process.pid}/mountinfo`, "utf8");
  if (Buffer.byteLength(mounts) > 1024 * 1024) fail();
  const rows = mounts.trim().split("\n").map(line => {
    const fields = line.split(" "), at = fields.indexOf("-");
    if (fields.length < 10 || at < 6) fail();
    const decode = (s: string) => s.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
    return { point: decode(fields[4]!), root: decode(fields[3]!), device: fields[2]!, options: fields[5]!.split(",") };
  });
  const tree = `${plan.binding.workspace.canonicalPath}/node_modules`, cache = q.profile.cache.canonicalPath;
  const exact = (path: string, readonly: boolean) => {
    const found = rows.filter(row => row.point === path);
    if (found.length !== 1 || !found[0]!.options.includes(readonly ? "ro" : "rw")) fail();
    return found[0]!;
  };
  const treeMount = exact(tree, true); exact(cache, false);
  const directory = (path: string, expected: { dev: string; ino: string }) => {
    const s = statSync(prefix + path, { bigint: true });
    if (!s.isDirectory() || String(s.dev) !== expected.dev || String(s.ino) !== expected.ino) fail();
  };
  directory(plan.binding.workspace.canonicalPath, plan.binding.workspace); directory(tree, q.tree); directory(cache, q.profile.cache);
  const localRoots = plan.provenance.kind === DependencyToolReadyProvenanceKind.LocalCompleted ? plan.provenance.readonlySources : [];
  const workspaceMount = exact(plan.binding.workspace.canonicalPath, false);
  const physicalRoot = (path: string) => workspaceMount.root.replace(/\/$/, "") + path.slice(plan.binding.workspace.canonicalPath.length);
  const ancestorMounts = plan.sourceAncestors.map(ancestor => {
    directory(ancestor.canonicalPath, ancestor);
    const mount = exact(ancestor.canonicalPath, false);
    if (mount.device !== workspaceMount.device || mount.root !== physicalRoot(ancestor.canonicalPath)) fail();
    return mount;
  });
  const localMounts = localRoots.map(source => {
    directory(source.canonicalPath, source.identity);
    const mount = exact(source.canonicalPath, true);
    if (mount.device !== workspaceMount.device || mount.root !== physicalRoot(source.canonicalPath)) fail();
    return mount;
  });
  const finitePoints = new Set(["/", ...plan.sources, "/proc", "/dev", "/dev/pts", "/dev/shm", "/sys", "/sys/fs/cgroup", "/sys/module",
    "/proc/sys", "/proc/sysrq-trigger", "/proc/kcore", "/tmp", "/var/tmp"]);
  for (const row of rows) {
    if (!finitePoints.has(row.point)) fail();
    if (row.point.startsWith(tree + "/") || row.point.startsWith(cache + "/")) fail();
    for (const mount of localMounts) {
      // Waive only the actual verified RW self-bind tuple on THIS source's
      // exact derived ancestor. General same-device ancestors still deny.
      const protectedAncestor = ancestorMounts.some(ancestor => row === ancestor && mount.point.startsWith(ancestor.point + "/"));
      if (row.point.startsWith(mount.point + "/") || row.device === mount.device && row.point !== mount.point &&
          row.point !== plan.binding.workspace.canonicalPath && !protectedAncestor && (row.root === mount.root || row.root.startsWith(mount.root + "/") ||
          mount.root.startsWith(row.root.replace(/\/$/, "") + "/"))) fail();
    }
    // A host bind ancestor/root/subtree at another path can expose this same
    // tree. The one workspace bind is the sole allowed ancestor, overlaid RO.
    if (row.device === treeMount.device && row.point !== tree && row.point !== plan.binding.workspace.canonicalPath &&
        (row.root === treeMount.root || row.root.startsWith(treeMount.root + "/") || treeMount.root.startsWith(row.root.replace(/\/$/, "") + "/"))) fail();
    if (row.options.includes("rw") && !["/proc", "/tmp", "/var/tmp", "/dev", "/dev/pts", "/dev/shm", cache,
      plan.binding.workspace.canonicalPath, ...ancestorMounts.map(ancestor => ancestor.point),
      ...plan.sources.filter(path => path.startsWith(plan.binding.jobRootDir + "/home/"))].some(path => row.point === path ||
        (path === "/proc" || path === "/dev") && row.point.startsWith(path + "/"))) fail();
  }
  return rows;
}
function assertNamespace(plan: Plan, process: HostedFdProcess, unit: HostedFdUnit): void {
  const rows = assertNamespaceMounts(plan, process);
  const prefix = `/proc/${process.pid}/root`, tree = `${plan.binding.workspace.canonicalPath}/node_modules`;
  const exact = (path: string) => {
    const found = rows.filter(row => row.point === path);
    if (found.length !== 1 || !found[0]!.options.includes("ro")) fail();
  };
  for (const file of plan.files) {
    const pin = file.pin;
    // Each helper/metadata/Node leaf has an actual nonrecursive RO file mount,
    // even when a preexisting system /usr exposure also covers its parent.
    exact(pin.path);
    const fd = openSync(prefix + pin.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || before.dev !== file.dev || before.ino !== file.ino ||
          before.size > 256n * 1024n * 1024n || (before.mode & 0o022n)) fail();
      const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true });
      if (hash(bytes) !== pin.sha256 || BigInt(bytes.length) !== before.size || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs ||
          trustedFile(pin.path).sha256 !== pin.sha256) fail();
    } finally { closeSync(fd); }
  }
  exact(dependencyToolGuestConfigPath);
  const fd = openSync(prefix + dependencyToolGuestConfigPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const capsule = fstatSync(fd, { bigint: true });
    assertHostedToolCapsuleCopy(plan.descriptorScope, fd);
    const after = fstatSync(fd, { bigint: true }), current = statSync(prefix + dependencyToolGuestConfigPath, { bigint: true });
    if (after.ctimeNs !== capsule.ctimeNs || after.mtimeNs !== capsule.mtimeNs || current.dev !== capsule.dev || current.ino !== capsule.ino) fail();
  } finally { closeSync(fd); }
  if (plan.provenance.kind === DependencyToolReadyProvenanceKind.LocalCompleted) {
    assertLocalLinkRoutes(prefix, tree, plan.provenance.readonlySources.map(source => source.canonicalPath));
    assertLocalProcessDescriptors(plan, process, unit);
  }
}

/** Check the actual mounted dependency links, without following directory
 * symlinks while walking. Every reachable target must resolve within the RO
 * tree or one independently authenticated direct source overlay. */
function assertLocalLinkRoutes(prefix: string, tree: string, roots: readonly string[]): void {
  const pending = [tree]; let entries = 0, linkBytes = 0;
  while (pending.length) {
    const directory = pending.pop()!, before = lstatSync(prefix + directory, { bigint: true });
    if (!before.isDirectory()) fail();
    const names = readdirSync(prefix + directory);
    if ((entries += names.length) > 100000) fail();
    for (const name of names) {
      const path = join(directory, name); if (path.length > 4096) fail();
      const info = lstatSync(prefix + path, { bigint: true });
      if (info.isDirectory()) pending.push(path);
      else if (info.isSymbolicLink()) {
        const target = readlinkSync(prefix + path);
        if ((linkBytes += Buffer.byteLength(target)) > 32 * 1024 * 1024 || target.startsWith("/")) fail();
        // Resolve actual guest components, not host realpath text from a proc
        // magic-link. Intermediate links must also remain in the finite RO set.
        const intended = resolveLocalGuestLink(prefix, `${dirname(path)}/${target}`, [tree, ...roots]);
        const actual = statSync(prefix + path, { bigint: true }), targetInfo = statSync(prefix + intended, { bigint: true });
        if (actual.dev !== targetInfo.dev || actual.ino !== targetInfo.ino) fail();
        const after = lstatSync(prefix + path, { bigint: true });
        if (after.dev !== info.dev || after.ino !== info.ino || after.ctimeNs !== info.ctimeNs || after.mtimeNs !== info.mtimeNs ||
            readlinkSync(prefix + path) !== target) fail();
      } else if (!info.isFile() || info.nlink !== 1n) fail();
    }
    const after = lstatSync(prefix + directory, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs) fail();
  }
}

function resolveLocalGuestLink(prefix: string, path: string, roots: readonly string[]): string {
  if (path.length > 4096) fail();
  let links = 0, steps = 0;
  const pending = path.slice(1).split("/"), components: string[] = [];
  while (pending.length) {
    if (++steps > 4096) fail();
    const name = pending.shift()!;
    if (!name || name === ".") continue;
    // Expand a preceding actual link before consuming '..'; lexical path
    // normalization here would disagree with the kernel's route semantics.
    if (name === "..") { components.pop(); continue; }
    const current = "/" + [...components, name].join("/");
    if (current.length > 4096 || !roots.some(root => current === root || current.startsWith(root + "/") || root.startsWith(current + "/"))) fail();
    const before = lstatSync(prefix + current, { bigint: true });
    if (!before.isSymbolicLink()) {
      if (pending.length && !before.isDirectory()) fail();
      components.push(name); continue;
    }
    const target = readlinkSync(prefix + current);
    if (++links > 40 || target.startsWith("/") || Buffer.byteLength(target) > 4096) fail();
    const after = lstatSync(prefix + current, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs ||
        before.mtimeNs !== after.mtimeNs || readlinkSync(prefix + current) !== target) fail();
    pending.unshift(...target.split("/"));
  }
  const resolved = "/" + components.join("/");
  if (!roots.some(root => resolved === root || resolved.startsWith(root + "/"))) fail();
  return resolved;
}

/** No open writable source alias or closed-FD shared writable mapping may
 * survive in any actual waiting process. The existing FDA proof owns bootstrap
 * capabilities/namespaces and the genuine three-channel stdio peer relation. */
function assertLocalProcessDescriptors(plan: Plan, bootstrap: HostedFdProcess, unit: HostedFdUnit): void {
  const profile = readHostedFdProfile(); if (!profile) fail();
  const pids = hostedFdGroupPids(unit.group);
  for (const pid of pids) {
    const current = observeHostedFdProcess(pid);
    if (current.group !== `0::${unit.group}`) fail();
    assertNamespaceMounts(plan, current);
    assertHostedFdInternals(current, profile);
    for (const number of [0, 1, 2]) {
      const fd = current.descriptors.find(fd => fd.fd === number), expected = bootstrap.descriptors.find(fd => fd.fd === number);
      if (!fd || !expected || fd.dev !== expected.dev || fd.ino !== expected.ino || fd.socket !== expected.socket ||
          (fd.flags & 3) !== (expected.flags & 3)) fail();
    }
    assertNoSharedWritableFileMap(pid);
    const after = observeHostedFdProcess(pid);
    if (after.birth !== current.birth || after.group !== current.group || after.mount !== current.mount ||
        !encode(after.descriptors).equals(encode(current.descriptors))) fail();
  }
  assertNoSharedWritableFileMap(process.pid);
  if (!encode([...pids].sort((a, b) => a - b)).equals(encode([...hostedFdGroupPids(unit.group)].sort((a, b) => a - b)))) fail();
}
function assertNoSharedWritableFileMap(pid: number): void {
  const maps = readFileSync(`/proc/${pid}/maps`, "utf8"); if (Buffer.byteLength(maps) > 1024 * 1024) fail();
  for (const line of maps.trim().split("\n")) {
    const fields = /^([a-f0-9]+-[a-f0-9]+) ([r-][w-][x-][ps]) [a-f0-9]+ [a-f0-9]+:[a-f0-9]+ ([0-9]+)(?:\s|$)/.exec(line);
    if (!fields || fields[2]![1] === "w" && fields[2]![3] === "s" && fields[3] !== "0") fail();
  }
}
