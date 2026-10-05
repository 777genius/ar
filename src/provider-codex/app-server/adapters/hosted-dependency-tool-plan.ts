import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DependencyAdmissionError, DependencyAdmissionFailure, sameDependencyAttempt } from "../../../core/dependency-environment/dependency-owner";
import { dependencyToolGuestConfigPath, type DependencyToolFile, type DependencyToolQualification } from "../../../core/dependency-environment/dependency-tool-profile";
import { DependencyToolReadyReadStatus, matchesRegistryDependencyToolReady,
  type DependencyToolReadyReader } from "../../../core/dependency-environment/dependency-tool-ready-reader";
import { assertHostedActivationFence, decodeHostedActivationBytes, readHostedActivationBytes, readHostedOrdinaryProcessOrigin,
  type HostedActivationFence } from "./hosted-process-activation";
import { assertHostedDependencyPhysicalWorkspace, readHostedDependencyAttempt, readHostedDependencyBinding, hostedDependencyPolicyRoot, type HostedDependencyBinding } from "./hosted-dependency-workspace";
import { assertHostedDependencyToolProfileFiles, trustedFile } from "./hosted-dependency-tool-files";
import { observeHostedFdProcess, readHostedFdProfile, type HostedFdProcess, type HostedFdUnit } from "./hosted-fd-observation";
import { openHostedRetainedToolFiles, assertHostedRetainedToolDescriptors, retainHostedToolFilesInvocation, bindHostedToolFilesChild,
  revokeHostedRetainedToolFiles, hostedToolFilesForChild, assertHostedToolCapsuleCopy, type HostedRetainedToolFiles } from "./hosted-retained-tool-files";
import type { CodexAppServerProcessInvocation } from "./node-app-server-process";
import { CodexProviderEgressProfileId } from "../../codex-provider-egress-policy";
import { assertHostedDependencyParentEnvironment, assertHostedDependencyParentRecipe } from "./hosted-dependency-parent-recipe";

type Plan = { readonly unit: string; readonly root: string; readonly binding: HostedDependencyBinding;
  readonly readyReader: DependencyToolReadyReader;
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
  const inventory = decodeHostedActivationBytes(inventoryBytes) as Record<string, unknown>, installation = decodeHostedActivationBytes(installationBytes) as Record<string, unknown>;
  if (inventory.schemaVersion !== 4 || installation.inventorySha256 !== hash(inventoryBytes) || !Array.isArray(inventory.ordinaryCreators)) fail();
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
  root: string, writable: readonly string[], sources: readonly string[], readyReader?: DependencyToolReadyReader): { readonly mounts: readonly string[]; readonly cache: string } | undefined {
  assertHostedActivationFence(fence);
  if (binding.version === 1) return undefined;
  if (!readyReader) fail();
  if (pending.has(unit)) fail();
  const origin = readHostedOrdinaryProcessOrigin(fence);
  const attempt = readHostedDependencyAttempt(binding, origin.start, String(origin.reservation.startId));
  const profile = readHostedFdProfile();
  if (!profile || profile.node.path !== binding.toolProfile.node.path || profile.node.sha256 !== binding.toolProfile.node.sha256 ||
      root !== `${hostedDependencyPolicyRoot}/dependency-provider-roots/${providerId(unit)}` || writable.length !== 3 ||
      writable[0] !== binding.workspace.canonicalPath || sources.some(path => path === "/" || path === hostedDependencyPolicyRoot)) fail();
  assertHostedDependencyToolProfileFiles(binding.toolProfile, binding.jobRootDir);
  if (readyReader.readCurrent().status !== DependencyToolReadyReadStatus.Ready) fail();
  const opened = openHostedRetainedToolFiles({ unit, parentStartId: attempt.launch.startId, jobId: binding.jobId, bindingBytes: encode(binding) });
  try {
    const q = opened.qualification, path = opened.capsulePath;
    const parentProcess = observeHostedFdProcess(process.pid);
    const rootStat = lstatSync(root, { bigint: true });
    const plan: Plan = { unit, root, binding, readyReader, qualification: q, descriptorScope: opened.scope, attempt, parentBirth: parentProcess.birth,
      files: Object.freeze([...q.profile.readonlyFiles, q.profile.node].map(pin => {
        const s = lstatSync(pin.path, { bigint: true }); return Object.freeze({ pin, dev: s.dev, ino: s.ino });
      })),
      rootIdentity: Object.freeze({ dev: rootStat.dev, ino: rootStat.ino }),
      parentGroup: parentProcess.group, sources: Object.freeze([...sources, ...writable, `${binding.workspace.canonicalPath}/.git`,
        `${binding.workspace.canonicalPath}/node_modules`, ...binding.toolProfile.readonlyFiles.map(f => f.path),
        binding.toolProfile.node.path, binding.toolProfile.cache.canonicalPath, dependencyToolGuestConfigPath]), closed: false };
    validatePlan(fence, plan);
    prepared.set(plan, true);
    pending.set(unit, plan);
    const tree = `${binding.workspace.canonicalPath}/node_modules`;
    return Object.freeze({ cache: binding.toolProfile.cache.canonicalPath, mounts: Object.freeze([
      `BindReadOnlyPaths=${tree}:${tree}:norbind`,
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
  assertNamespace(plan, bootstrap);
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
  if (ready.status !== DependencyToolReadyReadStatus.Ready ||
      !matchesRegistryDependencyToolReady({ workspace: binding.workspace, coverageRevision: hash(encode(binding)),
        revision: q.readyRevision, installKey: q.installKey, tree: q.tree, manifestDigest: q.manifestDigest }, ready.facts) ||
      q.installationId !== binding.installationId || q.runtimeSha !== binding.runtimeSha || q.grantDigest !== binding.grantDigest ||
      !encode(q.workspace).equals(encode(binding.workspace)) || q.startId !== plan.attempt.launch.startId || q.attemptId !== plan.attempt.attemptId ||
      q.epoch !== plan.attempt.epoch ||
      binding.version !== 2 || !encode(q.profile).equals(encode(binding.toolProfile))) fail();
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

function assertNamespace(plan: Plan, process: HostedFdProcess): void {
  const prefix = `/proc/${process.pid}/root`, q = plan.qualification;
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
  const finitePoints = new Set(["/", ...plan.sources, "/proc", "/dev", "/dev/pts", "/dev/shm", "/sys", "/sys/fs/cgroup", "/sys/module",
    "/proc/sys", "/proc/sysrq-trigger", "/proc/kcore", "/tmp", "/var/tmp"]);
  for (const row of rows) {
    if (!finitePoints.has(row.point)) fail();
    if (row.point.startsWith(tree + "/") || row.point.startsWith(cache + "/")) fail();
    // A host bind ancestor/root/subtree at another path can expose this same
    // tree. The one workspace bind is the sole allowed ancestor, overlaid RO.
    if (row.device === treeMount.device && row.point !== tree && row.point !== plan.binding.workspace.canonicalPath &&
        (row.root === treeMount.root || row.root.startsWith(treeMount.root + "/") || treeMount.root.startsWith(row.root.replace(/\/$/, "") + "/"))) fail();
    if (row.options.includes("rw") && !["/proc", "/tmp", "/var/tmp", "/dev", "/dev/pts", "/dev/shm", cache,
      plan.binding.workspace.canonicalPath, ...plan.sources.filter(path => path.startsWith(plan.binding.jobRootDir + "/home/"))].some(path => row.point === path ||
        (path === "/proc" || path === "/dev") && row.point.startsWith(path + "/"))) fail();
  }
  for (const file of plan.files) {
    const pin = file.pin;
    // Each helper/metadata/Node leaf has an actual nonrecursive RO file mount,
    // even when a preexisting system /usr exposure also covers its parent.
    exact(pin.path, true);
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
  exact(dependencyToolGuestConfigPath, true);
  const fd = openSync(prefix + dependencyToolGuestConfigPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const capsule = fstatSync(fd, { bigint: true });
    assertHostedToolCapsuleCopy(plan.descriptorScope, fd);
    const after = fstatSync(fd, { bigint: true }), current = statSync(prefix + dependencyToolGuestConfigPath, { bigint: true });
    if (after.ctimeNs !== capsule.ctimeNs || after.mtimeNs !== capsule.mtimeNs || current.dev !== capsule.dev || current.ino !== capsule.ino) fail();
  } finally { closeSync(fd); }
}
