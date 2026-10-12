import { readHostedOriginalUsableParentRoots } from "./hosted-original-usable-parent-recipe";
import { matchesDependencyToolExecution, type DependencyToolAdmissionQualification } from "../core/dependency-environment/dependency-tool-execution";
import type { DependencyToolReadyRead, DependencyToolSourceRoot } from "../core/dependency-environment/dependency-tool-ready-reader";
import { readHostedOrdinaryDependencyParentFrame } from "./hosted-ordinary-dependency-reader";
import { fileURLToPath } from "node:url";
import { hostedCodexExecutableReadPath } from "../provider-codex/hosted-codex-permissions";
import { encodeHostedAppServerLaunchFrame } from "../provider-codex/app-server/adapters/hosted-app-server-launch-frame";
import { hostedFdSystemdProperties } from "../provider-codex/app-server/adapters/hosted-fd-prelude";
import { hostedDependencySystemdRunExecutable } from "../provider-codex/app-server/adapters/hosted-dependency-systemd-command";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, symlinkSync, writeFileSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DependencyAdmissionError, DependencyAdmissionFailure, sameDependencyAttempt, parseDependencyOwner,
  isDependencyConsumerOwner, DependencyOwnerPhase } from "../core/dependency-environment/dependency-owner";
import { DependencyConsumerLaunchKind } from "../core/dependency-environment/dependency-custody-evidence";
import { sameDependencyProtectedReference, isDependencyProtectedReference } from "../core/dependency-environment/dependency-custody-evidence";
import { HostedCustodyPhase, HostedCustodyReservationState, parseHostedCustodyEpoch } from "../worker-core/hosted-custody/domain/hosted-custody-epoch";
import { parseHostedReadonlyHostInventory } from "../worker-core/hosted-custody/domain/hosted-readonly-inventory";
import { readHostedReadonlyDependencyStart, readHostedReadonlyDependencyAssociation } from "../provider-codex/app-server/adapters/hosted-dependency-origin";
import { dependencyToolGuestConfigPath, type DependencyToolFile } from "../core/dependency-environment/dependency-tool-profile";
import { DependencyToolReadyReadStatus, DependencyToolReadyProvenanceKind, matchesRegistryDependencyToolReady, matchesDependencyToolReadyIdentity,
  type DependencyToolReadyFacts } from "../core/dependency-environment/dependency-tool-ready-reader";
import { assertHostedActivationFence, decodeHostedActivationBytes, readHostedActivationBytes,
  type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedDependencyPhysicalWorkspace, readHostedDependencyAttempt, readHostedDependencyBinding, hostedDependencyPolicyRoot, isHostedDependencyWorkspace, type HostedDependencyBinding } from "./hosted-dependency-workspace";
import { assertHostedDependencyToolProfileFiles, trustedFile } from "../provider-codex/app-server/adapters/hosted-dependency-tool-files";
import { observeHostedFdProcess, observeHostedFdUnit, readHostedFdProfile, hostedFdGroupPids, assertHostedFdBootstrap, assertHostedFdConfinement, assertHostedFdInternals, type HostedFdProcess, type HostedFdUnit } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { hostedFdLaunch } from "../provider-codex/app-server/adapters/hosted-fd-launch";
import type { CodexAppServerProcessInvocation } from "../provider-codex/app-server/adapters/node-app-server-process";
import { readCurrentHostedDependencyRootQualification } from "./hosted-dependency-tool-profile";
import { assertHostedDependencyParentEnvironment, assertHostedDependencyParentRecipe, readHostedDependencyParentRecipe } from "./hosted-dependency-parent-recipe";
import { isHostedManagedReadonlyOuterRuntime, assertCurrentHostedDependencyAttempt, readCurrentHostedManagedDependencyProvider,
  prepareCurrentHostedManagedDependencyProviderTools, readCurrentHostedManagedDependencyProviderTools,
  closeCurrentHostedManagedDependencyProviderTools, assertCurrentHostedManagedDependencyCapsuleCopy,
  readCurrentHostedDependencyProviderSessionHome,
  type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";

type Plan = { readonly refresh: boolean; readonly writable: readonly Readonly<{path:string;dev:string;ino:string}>[]; readonly unit: string; readonly root: string; readonly binding: HostedDependencyBinding;
  readonly managedOrigin: CurrentHostedDependencyOrigin; invocation?: CodexAppServerProcessInvocation;
  readonly admission: Exclude<DependencyToolReadyRead,{status:DependencyToolReadyReadStatus.Unknown}>;
  readonly sourceAncestors: readonly Readonly<{ canonicalPath: string; dev: string; ino: string }>[];
  readonly qualification: DependencyToolAdmissionQualification;
  readonly attempt: ReturnType<typeof readHostedDependencyAttempt>; readonly parentBirth: string;
  readonly parentGroup: string; readonly sources: readonly string[];
  readonly rootIdentity: Readonly<{ dev: bigint; ino: bigint }>;
  readonly files: readonly Readonly<{ pin: DependencyToolFile; dev: bigint; ino: bigint }>[]; closed: boolean };
const invocations = new WeakMap<object, Plan>(), children = new WeakMap<ChildProcess, Plan>();
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fail(): never { throw new DependencyAdmissionError(DependencyAdmissionFailure.Unsupported); }

/** The actual reserved outer unit selects the first R frame boundary. */
export function assertHostedManagedDependencyToolParentFrame(fence: HostedActivationFence, unit: string, frame: string | Buffer): void {
  assertHostedActivationFence(fence);
  const id = /^subscription-runtime-outer-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.service$/.exec(unit)?.[1];
  if (!id) fail();
  assertManagedParentFrame(fence,unit,id,frame);
}

/** C foreground frame derives its writer scope from the actual reserved
 * ordinary parent/preclaim and exact signed inventory recipe. No root issuer. */
export function assertHostedOrdinaryDependencyToolParentFrame(fence:HostedActivationFence,startId:string,frame:string|Buffer):void {
  const selected=readHostedOrdinaryDependencyParentFrame(fence,startId,frame); if (!selected) return;
  const recipe=readHostedDependencyParentRecipe(selected.launch,selected.binding.jobRootDir,selected.binding.workspace.canonicalPath);
  assertParentAuthWriterScope(selected.binding,recipe.args,selected.launch);
  readHostedOrdinaryDependencyParentFrame(fence,startId,frame);
}

/** Before the R CLI exists, the real FDA foreground unit selects its fixed
 * reserved start/preclaim and signed original C argv. No origin is issued. */
function assertManagedParentFrame(fence: HostedActivationFence, unit: string, startId: string, frame: string | Buffer): void {
  const epochBytes = readHostedActivationBytes("readonly-epoch.json"); if (!epochBytes) fail();
  const epoch = parseHostedCustodyEpoch(decodeHostedActivationBytes(epochBytes)), row = epoch.outerRuntime;
  if (epoch.phase !== HostedCustodyPhase.Ready || epoch.revoked || !row || row.unit !== unit || row.startId !== startId ||
      row.generation !== epoch.generation || row.state !== HostedCustodyReservationState.Reserved) fail();
  if (!isHostedDependencyWorkspace(epoch.identity.workspacePath)) return;
  const start = readHostedReadonlyDependencyStart(fence,startId), binding = readHostedDependencyBinding(start.value.candidateJobId);
  if (!binding || binding.version !== 2 || start.value.unit !== unit || start.value.readonlyJobId !== epoch.identity.jobId ||
      start.value.generation !== epoch.generation || start.value.hostId !== epoch.hostId || start.value.bootId !== epoch.bootId ||
      start.value.supervisorId !== epoch.supervisorId || binding.jobRootDir !== epoch.identity.jobRootDir ||
      binding.workspace.canonicalPath !== epoch.identity.workspacePath || start.value.installationId !== binding.installationId ||
      start.value.grantDigest !== binding.grantDigest) fail();
  const association = readHostedReadonlyDependencyAssociation(fence,binding.workspace);
  if (!association || !sameDependencyProtectedReference(association.reference,start.value.association) ||
      association.evidence.candidate.jobId !== binding.jobId || association.evidence.readonlyCustody.jobId !== epoch.identity.jobId) fail();
  const inventoryBytes = readHostedActivationBytes("readonly-inventory.json"); if (!inventoryBytes || hash(inventoryBytes) !== start.value.inventoryDigest) fail();
  const inventory = parseHostedReadonlyHostInventory(decodeHostedActivationBytes(inventoryBytes));
  const originals = inventory.ordinaryCreators.filter(value => value.jobId === binding.jobId && value.jobRootDir === binding.jobRootDir &&
    value.workspacePath === binding.workspace.canonicalPath);
  if (originals.length !== 1 || !encode(inventory.runtimeLaunch).equals(encode(originals[0]!.launch)) ||
      inventory.runtimeLaunch.command !== process.execPath || inventory.runtimeLaunch.cwd !== binding.workspace.canonicalPath) fail();
  assertHostedDependencyParentRecipe(inventory.runtimeLaunch.args,binding.jobRootDir,binding.workspace.canonicalPath);
  const ownerBytes = readHostedActivationBytes(`dependency-owners/${binding.workspace.dev}-${binding.workspace.ino}.json`);
  if (!ownerBytes) fail(); const owner = parseDependencyOwner(decodeHostedActivationBytes(ownerBytes));
  if (owner.version !== 3 || !sameDependencyProtectedReference(owner.custodyBinding,association.reference) ||
      !isDependencyConsumerOwner(owner.owner) || owner.owner.phase !== DependencyOwnerPhase.ExclusiveMutation ||
      !("kind" in owner.owner.attempt.launch) || owner.owner.attempt.launch.kind !== DependencyConsumerLaunchKind.ManagedReadonlyLocalV1 ||
      owner.owner.attempt.launch.startId !== startId || !sameDependencyProtectedReference(owner.owner.attempt.launch.origin,start.reference)) fail();
  // The existing issuer alone writes the fixed producer. Temporary protected
  // reads close before FDA's final current collector/enqueue.
  const producerPath = `${hostedDependencyPolicyRoot}/dependency-reader-starts/${startId}.json`;
  const producerBytes = readManagedParentProducer(producerPath), producer = decodeHostedActivationBytes(producerBytes) as Record<string,unknown>;
  if (!producer || Object.keys(producer).sort().join(",") !== "attempt,binding,custody,kind,origin,ownerRevision,ownerSha256,receipt,version,workspace" ||
      producer.version !== 1 || producer.kind !== DependencyConsumerLaunchKind.ManagedReadonlyLocalV1 ||
      producer.ownerRevision !== owner.revision || producer.ownerSha256 !== hash(encode(owner)) ||
      !encode(producer.attempt).equals(encode(owner.owner.attempt)) || !isDependencyProtectedReference(producer.origin) ||
      !sameDependencyProtectedReference(producer.origin,start.reference) || !isDependencyProtectedReference(producer.custody) ||
      !sameDependencyProtectedReference(producer.custody,association.reference) || !encode(producer.workspace).equals(encode(binding.workspace))) fail();
  const data = decodeHostedActivationBytes(Buffer.from(frame)) as Record<string,unknown>;
  if (!data || Object.keys(data).sort().join(",") !== "env,schemaVersion" || data.schemaVersion !== 1 ||
      !data.env || typeof data.env !== "object" || Array.isArray(data.env)) fail();
  assertHostedDependencyParentEnvironment(data.env as Record<string,string>,binding.jobRootDir);
  assertParentAuthWriterScope(binding,inventory.runtimeLaunch.args);
  if (!readHostedActivationBytes("readonly-epoch.json")?.equals(epochBytes) ||
      !readHostedActivationBytes(`dependency-owners/${binding.workspace.dev}-${binding.workspace.ino}.json`)?.equals(ownerBytes)) fail();
}
function readManagedParentProducer(path: string): Buffer {
  const parents: {path:string;dev:bigint;ino:bigint;mode:bigint}[] = [];
  for (let p = dirname(path);; p = dirname(p)) {
    const named = lstatSync(p,{bigint:true});
    if (!named.isDirectory() || named.uid !== 0n || named.gid !== 0n || (named.mode & 0o022n) || realpathSync(p) !== p ||
        (p === dirname(path) && (named.mode & 0o7777n) !== 0o700n)) fail();
    parents.push({path:p,dev:named.dev,ino:named.ino,mode:named.mode}); if (p === "/") break;
    if (parents.length >= 128) fail();
  }
  const fd = openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd,{bigint:true}), entry = lstatSync(path,{bigint:true});
    if (!before.isFile() || before.uid !== 0n || before.gid !== 0n || before.nlink !== 1n || (before.mode & 0o7777n) !== 0o600n ||
        before.size < 1n || before.size > 16384n || before.dev !== entry.dev || before.ino !== entry.ino || realpathSync(path) !== path) fail();
    const bytes = Buffer.alloc(Number(before.size)+1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd,bytes,length,bytes.length-length,length); if (!count) break; length += count; }
    const after = fstatSync(fd,{bigint:true}), named = lstatSync(path,{bigint:true});
    if (BigInt(length) !== before.size || [after,named].some(value => value.dev !== before.dev || value.ino !== before.ino ||
        value.mode !== before.mode || value.uid !== before.uid || value.gid !== before.gid || value.nlink !== before.nlink ||
        value.size !== before.size || value.ctimeNs !== before.ctimeNs || value.mtimeNs !== before.mtimeNs)) fail();
    for (const parent of parents) { const current = lstatSync(parent.path,{bigint:true});
      if (!current.isDirectory() || current.dev !== parent.dev || current.ino !== parent.ino || current.mode !== parent.mode ||
          current.uid !== 0n || current.gid !== 0n) fail(); }
    return bytes.subarray(0,length);
  } finally { closeSync(fd); }
}

/** Metadata only: never open auth.json or derive authority from a credential.
 * Generic writers stay in the root-owned job namespace. The original Usable
 * producer alone selects its sealed broker and registry metadata scope. */
function assertParentAuthWriterScope(binding: HostedDependencyBinding, args: readonly string[], raw?: import("../core/host-infrastructure/host-inventory").HostedInventoryLaunch): void {
  const original = raw ? readHostedOriginalUsableParentRoots(raw, binding.jobRootDir, binding.workspace.canonicalPath) : null;
  assertHostedDependencyPhysicalWorkspace(binding); // Includes all bind/mount aliases.
  const job = lstatSync(binding.jobRootDir, { bigint: true });
  const authPath = original?.auth ?? `${binding.jobRootDir}/auth`, auth = lstatSync(authPath, { bigint: true });
  if (original) {
    const parentPath = dirname(authPath), parent = lstatSync(parentPath, { bigint: true });
    if (!parent.isDirectory() || parent.uid !== 0n || parent.gid !== 0n || (parent.mode & 0o777n) !== 0o700n ||
        parent.dev !== job.dev || realpathSync(parentPath) !== parentPath) fail();
  }
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
  walk(original?.capacity ?? `${binding.jobRootDir}/.subscription-runtime-account-capacity`, 0, true);
  // Other actual fixed startup/migration writers cannot be redirected by a
  // preexisting state/handoff directory or flat event/key/log leaf alias.
  for (const path of original ? [original.state, original.registry] : [join(binding.jobRootDir, "state"), join(binding.jobRootDir, "durable-handoffs")]) walk(path, 0, false);
  const taskIndex = args.indexOf("--task-id"), task = args[taskIndex + 1]; if (taskIndex < 0 || !task) fail();
  for (const path of [join(binding.jobRootDir, "encryption-key.hex"), join(binding.jobRootDir, `${task}.events.jsonl`),
    original?.log ?? join(binding.jobRootDir, `${task}.log`), original?.progress ?? join(binding.jobRootDir, `${task}.progress.json`)]) {
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
  if (original && (!raw || JSON.stringify(readHostedOriginalUsableParentRoots(raw, binding.jobRootDir, binding.workspace.canonicalPath)) !== JSON.stringify(original))) fail();
}

/** Only a live enrolled origin and its reserved provider can prepare the plan.
 * The returned configuration is not a permit; the retained record FD is private. */
function prepareHostedDependencyToolPlan(fence: HostedActivationFence, unit: string, binding: HostedDependencyBinding,
  root: string, writable: readonly string[], sources: readonly string[], managedOrigin: CurrentHostedDependencyOrigin): { readonly mounts: readonly string[]; readonly cache: string; readonly sourcePaths: readonly string[] } | undefined {
  assertHostedActivationFence(fence);
  const actualManaged = assertCurrentHostedDependencyAttempt(managedOrigin,fence,DependencyOwnerPhase.Running);
  if (!encode(actualManaged.binding).equals(encode(binding)) || binding.version !== 2 || pending.has(unit)) fail();
  const attempt = actualManaged.attempt;
  const session = readCurrentHostedDependencyProviderSessionHome(managedOrigin,fence,writable[1],writable[2]);
  if (writable[0] !== (session.refresh ? session.emptyWorkdir : binding.workspace.canonicalPath)) fail();
  const profile = readHostedFdProfile();
  if (!profile || profile.node.path !== binding.toolProfile.node.path || profile.node.sha256 !== binding.toolProfile.node.sha256 ||
      root !== `${hostedDependencyPolicyRoot}/dependency-provider-roots/${providerId(unit)}` || writable.length !== 3 ||
      !writable[0] || sources.some(path => path === "/" || path === hostedDependencyPolicyRoot)) fail();
  assertHostedDependencyToolProfileFiles(binding.toolProfile, binding.jobRootDir);
  const managedTools = prepareCurrentHostedManagedDependencyProviderTools(managedOrigin,fence,unit);
  try {
  const initial=managedTools.admission;
  if(initial.status===DependencyToolReadyReadStatus.Ready)assertLocalSources(binding,initial.facts.provenance);
  else assertUsableSources(binding,initial.execution.sourceRoots);
  const localRoots=admissionSourceRoots(initial),sourceAncestors=admissionSourceAncestors(binding,initial);
  try {
    const qualification=managedTools.qualification,q=qualification.version===1?qualification:qualification.execution,path=managedTools.capsulePath;
    const parentProcess = observeHostedFdProcess(process.pid);
    const rootStat = lstatSync(root, { bigint: true });
    const plan: Plan = { refresh:session.refresh,writable:Object.freeze(writable.map(path => { const stat = lstatSync(path,{bigint:true});
        return Object.freeze({path,dev:String(stat.dev),ino:String(stat.ino)}); })),unit, root, binding, managedOrigin, admission: initial, sourceAncestors,
      qualification, attempt, parentBirth: parentProcess.birth,
      files: Object.freeze([...q.profile.readonlyFiles, q.profile.node,...managedDependencyHookFiles()].map(pin => {
        const s = lstatSync(pin.path, { bigint: true }); return Object.freeze({ pin, dev: s.dev, ino: s.ino });
      })),
      rootIdentity: Object.freeze({ dev: rootStat.dev, ino: rootStat.ino }),
      parentGroup: parentProcess.group, sources: Object.freeze([...sources, ...writable, binding.workspace.canonicalPath, `${binding.workspace.canonicalPath}/.git`,
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
      ...sourceAncestors.map(ancestor => `${session.refresh ? "BindReadOnlyPaths" : "BindPaths"}=${ancestor.canonicalPath}:${ancestor.canonicalPath}:norbind`),
      ...localRoots.map(source => `BindReadOnlyPaths=${source.canonicalPath}:${source.canonicalPath}:norbind`),
      ...binding.toolProfile.readonlyFiles.map(f => `BindReadOnlyPaths=${f.path}:${f.path}:norbind`),
      ...(sources.includes(binding.toolProfile.node.path) ? [] : [`BindReadOnlyPaths=${binding.toolProfile.node.path}:${binding.toolProfile.node.path}:norbind`]),
      `BindPaths=${binding.toolProfile.cache.canonicalPath}:${binding.toolProfile.cache.canonicalPath}:norbind`,
      `BindReadOnlyPaths=${path}:${dependencyToolGuestConfigPath}:norbind`,
    ]) });
  } catch (error) { closeCurrentHostedManagedDependencyProviderTools(managedOrigin,unit); throw error; }
  } catch (error) { closeCurrentHostedManagedDependencyProviderTools(managedOrigin,unit); throw error; }
}
// The only cross-function handle is keyed by the real just-reserved unit. It is
// consumed synchronously by the same fixed producer, never exported as data.
const pending = new Map<string, Plan>(), prepared = new WeakMap<Plan, boolean>();
function closePlan(plan: Plan): void {
  if (plan.closed) return; plan.closed = true;
  closeCurrentHostedManagedDependencyProviderTools(plan.managedOrigin,plan.unit);
}
function abandonHostedDependencyToolPlan(unit: string): void {
  const plan = pending.get(unit); if (!plan) return;
  pending.delete(unit); closePlan(plan);
}
export function abandonHostedDependencyToolInvocation(invocation: CodexAppServerProcessInvocation): void {
  const plan = invocations.get(invocation); if (!plan) fail();
  invocations.delete(invocation); closePlan(plan);
}
function retainHostedDependencyToolInvocation(fence: HostedActivationFence, invocation: CodexAppServerProcessInvocation): void {
  assertHostedActivationFence(fence);
  const unit = invocation.systemdUnit; if (!unit) fail();
  const plan = pending.get(unit);
  if (!plan || !prepared.has(plan) || invocations.has(invocation)) fail();
  try { validatePlan(fence,plan);
    plan.invocation = invocation; invocations.set(invocation,plan); pending.delete(unit); }
  catch (error) { abandonHostedDependencyToolPlan(unit); throw error; }
}
export function bindHostedDependencyToolChild(invocation: CodexAppServerProcessInvocation, child: ChildProcess): void {
  const plan = invocations.get(invocation); if (!plan) fail();
  if (plan.closed || !child.pid || children.has(child)) fail();
  invocations.delete(invocation); children.set(child, plan);
  const close = () => {
    children.delete(child); plan.closed = true;
    // Native events fence future Plan use; only the original-owned awaited
    // manager/queue/cgroup/FD collector can discharge its physical resources.
  };
  child.once("close", close); child.once("error", close);
}

/** Current unit and bootstrap are collected here from the genuine retained child.
 * No caller observation or PID can substitute for this original-map join. */
export function assertHostedManagedDependencyToolRelease(child: ChildProcess, fence: HostedActivationFence): void {
  assertHostedActivationFence(fence);
  const plan = children.get(child), guard = hostedFdLaunch(child);
  if (!plan || plan.closed || !plan.invocation || !child.pid || guard.unit !== plan.unit) fail();
  validatePlan(fence,plan);
  const remaining = () => guard.remainingSetupMs();
  const args = plan.invocation.args, at = args.indexOf("--"); if (at < 0) fail();
  const unit = observeHostedFdUnit(plan.unit,args.slice(at+1),remaining), profile = readHostedFdProfile(remaining);
  if (!profile || unit.root !== plan.root) fail();
  const candidates = hostedFdGroupPids(unit.group).map(observeHostedFdProcess);
  const bootstraps = candidates.filter(value => value.exe === profile.node.path &&
    value.argv[1] === fileURLToPath(new URL("../provider-codex/app-server/adapters/hosted-app-server-launcher.js",import.meta.url)));
  if (bootstraps.length !== 1 || !candidates.some(value => value.pid === unit.mainPid)) fail();
  const bootstrap = bootstraps[0]!;
  assertHostedFdBootstrap(bootstrap,profile,remaining); assertHostedFdConfinement(bootstrap,args.slice(at+1),unit.root);
  assertNamespace(plan,bootstrap,unit,fence);
  const after = observeHostedFdProcess(bootstrap.pid);
  if (after.birth !== bootstrap.birth || after.mount !== bootstrap.mount || after.group !== bootstrap.group ||
      after.user !== bootstrap.user || after.pidNamespace !== bootstrap.pidNamespace) fail();
  validatePlan(fence,plan); remaining();
}
function validatePlan(fence: HostedActivationFence, plan: Plan): void {
  assertHostedActivationFence(fence);
  if (plan.closed) fail();
  // Recheck the original private qualifier's inputs and physical source walk,
  // both before and after asynchronous setup's namespace observations. Cached
  // Ready facts alone cannot detect source members or inner links changing.
  const qualified = readCurrentHostedDependencyRootQualification(fence);
  if (qualified.context !== plan.managedOrigin || qualified.phase !== DependencyOwnerPhase.Running ||
      !encode(qualified.binding).equals(encode(plan.binding)) || !sameDependencyAttempt(qualified.attempt, plan.attempt)) fail();
  const managed = readCurrentHostedManagedDependencyProviderTools(plan.managedOrigin,fence,plan.unit);
  const session = readCurrentHostedDependencyProviderSessionHome(plan.managedOrigin,fence,plan.writable[1]?.path,plan.writable[2]?.path);
  if (session.refresh !== plan.refresh) fail();
  const qualification=plan.qualification,q=qualification.version===1?qualification:qualification.execution,binding=plan.binding;
  const root = lstatSync(plan.root, { bigint: true }), parentDirectory = lstatSync(dirname(plan.root), { bigint: true });
  if (!root.isDirectory() || root.uid !== 0n || root.gid !== 0n || (root.mode & 0o777n) !== 0o700n ||
      root.dev !== plan.rootIdentity.dev || root.ino !== plan.rootIdentity.ino || !parentDirectory.isDirectory() ||
      parentDirectory.uid !== 0n || (parentDirectory.mode & 0o777n) !== 0o700n) fail();
  if (!encode(readHostedDependencyBinding(binding.jobId)).equals(encode(binding)) ||
      !sameDependencyAttempt(managed.provider.attempt, plan.attempt)) fail();
  if(!encode(managed.qualification).equals(encode(qualification)) || !encode(managed.admission).equals(encode(plan.admission)))fail();
  // The admitted worker-owned reader opens only established history and closes
  // every temporary descriptor before the FD-table checks below. It is retained
  // with this actual invocation/child, never reconstructed from serialized facts.
  const ready:Plan["admission"]=qualified.status===DependencyToolReadyReadStatus.Ready ?
    {status:DependencyToolReadyReadStatus.Ready,facts:qualified.providerReady} :
    qualified.status===DependencyToolReadyReadStatus.Baseline ?
    {status:qualified.status,execution:qualified.execution} :
    {status:qualified.status,execution:qualified.execution};
  if(!encode(ready).equals(encode(managed.admission)))fail();
  if(qualification.version===1) {
    const legacy=qualification;
    const expected={workspace:binding.workspace,coverageRevision:hash(encode(binding)),revision:legacy.readyRevision,
      installKey:legacy.installKey,tree:legacy.tree,manifestDigest:legacy.manifestDigest};
    if(ready.status!==DependencyToolReadyReadStatus.Ready ||
      !(ready.facts.provenance.kind===DependencyToolReadyProvenanceKind.RegistryCompleted ? matchesRegistryDependencyToolReady(expected,ready.facts) :
        (ready.facts.provenance.kind===DependencyToolReadyProvenanceKind.LocalCompleted || ready.facts.provenance.kind===DependencyToolReadyProvenanceKind.LocalCompared) && matchesDependencyToolReadyIdentity(expected,ready.facts)))fail();
    assertLocalSources(binding,ready.facts.provenance);
  } else {
    if((ready.status!==DependencyToolReadyReadStatus.Usable && ready.status!==DependencyToolReadyReadStatus.Baseline) || !matchesDependencyToolExecution(qualification.execution,ready.execution))fail();
    assertUsableSources(binding,ready.execution.sourceRoots);
  }
  if(q.installationId!==binding.installationId || q.runtimeSha!==binding.runtimeSha || q.grantDigest!==binding.grantDigest ||
    !encode(q.workspace).equals(encode(binding.workspace)) || q.startId!==plan.attempt.launch.startId || q.attemptId!==plan.attempt.attemptId ||
    q.epoch!==plan.attempt.epoch || binding.version!==2 || !encode(q.profile).equals(encode(binding.toolProfile)) ||
    !encode(admissionSourceAncestors(binding,ready)).equals(encode(plan.sourceAncestors)))fail();
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
  if (parent.birth !== plan.parentBirth || parent.group !== plan.parentGroup) fail();
  // Temporary history/profile IO has closed. Only the continuously retained
  // two leaves may remain: state journals and same-inode alias opens deny too.
  readCurrentHostedManagedDependencyProviderTools(plan.managedOrigin,fence,plan.unit);
}
function providerId(unit: string): string {
  const id = /^subscription-runtime-hosted-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.service$/.exec(unit)?.[1];
  if (!id) fail(); return id;
}

function admissionSourceRoots(admission:Plan["admission"]):readonly DependencyToolSourceRoot[] {
  if(admission.status===DependencyToolReadyReadStatus.Usable || admission.status===DependencyToolReadyReadStatus.Baseline)return admission.execution.sourceRoots;
  const provenance=admission.facts.provenance;
  return provenance.kind===DependencyToolReadyProvenanceKind.RegistryCompleted?[]:provenance.readonlySources;
}
function admissionSourceAncestors(binding:HostedDependencyBinding,admission:Plan["admission"]) {
  return localSourceAncestors(binding,admissionSourceRoots(admission));
}
/** Current source directory facts only, never generated install provenance. */
function assertUsableSources(binding:HostedDependencyBinding,roots:readonly DependencyToolSourceRoot[]):void {
  assertHostedDependencyPhysicalWorkspace(binding);if(roots.length>128)fail();
  for(let index=0;index<roots.length;index++) {
    const root=roots[index]!,path=root.canonicalPath;
    if(!path.startsWith(binding.workspace.canonicalPath+"/") || /[\s:%\\"'\x00-\x1f\x7f]/.test(path) || path.length>4096 ||
      path.slice(binding.workspace.canonicalPath.length+1).split("/").some(part=>part===".git" || part==="node_modules") ||
      roots.slice(0,index).some(other=>other.canonicalPath>=path || path.startsWith(other.canonicalPath+"/")))fail();
    for(let ancestor=path;;ancestor=dirname(ancestor)) {
      const stat=lstatSync(ancestor);
      if(!stat.isDirectory() || stat.uid!==0 || (stat.mode&0o022) || realpathSync(ancestor)!==ancestor)fail();if(ancestor==="/")break;
    }
    const stat=lstatSync(path,{bigint:true});if(String(stat.dev)!==root.identity.dev || String(stat.ino)!==root.identity.ino)fail();
  }
}

/** Only the captive current reader selects these paths. Directory pins are
 * mount facts; the worker-owned per-entry exposure separately checks every
 * source member, hardlink and inner link against its retained physical walk. */
function assertLocalSources(binding: HostedDependencyBinding, provenance: DependencyToolReadyFacts["provenance"]): void {
  if (provenance.kind === DependencyToolReadyProvenanceKind.RegistryCompleted) return;
  if (provenance.kind !== DependencyToolReadyProvenanceKind.LocalCompleted && provenance.kind !== DependencyToolReadyProvenanceKind.LocalCompared) fail();
  assertHostedDependencyPhysicalWorkspace(binding);
  const reference = provenance.sourceBinding, parent = `${hostedDependencyPolicyRoot}/dependency-source-bindings/${binding.workspace.dev}-${binding.workspace.ino}`;
  if (!reference.path.startsWith(parent + "/") ||
      !(provenance.kind === DependencyToolReadyProvenanceKind.LocalCompleted
        ? /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(reference.path.slice(parent.length + 1))
        : /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.compared-local\.json$/.test(reference.path.slice(parent.length + 1))) ||
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
function localSourceAncestors(binding: HostedDependencyBinding, sources: readonly DependencyToolSourceRoot[]) {
  const paths = new Set<string>();
  for (const source of sources) {
    if (source.canonicalPath.slice(binding.workspace.canonicalPath.length + 1).split("/").some(part => part === ".git" || part === "node_modules")) fail();
    for (let path = dirname(source.canonicalPath); path !== binding.workspace.canonicalPath; path = dirname(path)) {
      if (!path.startsWith(binding.workspace.canonicalPath + "/") || paths.size >= 512 && !paths.has(path)) fail();
      paths.add(path);
    }
  }
  return Object.freeze([...paths].sort().map(canonicalPath => {
    const info = lstatSync(canonicalPath, { bigint: true });
    if (!info.isDirectory() || info.uid !== 0n || (info.mode & 0o022n) || realpathSync(canonicalPath) !== canonicalPath) fail();
    return Object.freeze({ canonicalPath, dev: String(info.dev), ino: String(info.ino) });
  }));
}

function assertNamespaceMounts(plan: Plan, process: HostedFdProcess) {
  const prefix=`/proc/${process.pid}/root`,q=plan.qualification.version===1?plan.qualification:plan.qualification.execution;
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
  for (const pin of plan.writable) { exact(pin.path,false); directory(pin.path,pin);
    const named = lstatSync(pin.path,{bigint:true}), guest = statSync(prefix+pin.path,{bigint:true});
    if (named.uid !== 0n || named.gid !== 0n || (pin.path.startsWith(plan.binding.jobRootDir+"/home/") ? (named.mode & 0o7777n) !== 0o700n : !!(named.mode & 0o022n)) || guest.mode !== named.mode) fail(); }
  const localRoots=admissionSourceRoots(plan.admission);
  const workspaceMount = exact(plan.binding.workspace.canonicalPath, plan.refresh);
  const physicalRoot = (path: string) => workspaceMount.root.replace(/\/$/, "") + path.slice(plan.binding.workspace.canonicalPath.length);
  const ancestorMounts = plan.sourceAncestors.map(ancestor => {
    directory(ancestor.canonicalPath, ancestor);
    const mount = exact(ancestor.canonicalPath, plan.refresh);
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
function assertNamespace(plan: Plan, process: HostedFdProcess, unit: HostedFdUnit, fence: HostedActivationFence): void {
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
    assertCurrentHostedManagedDependencyCapsuleCopy(plan.managedOrigin,fence,plan.unit,fd);
    const after = fstatSync(fd, { bigint: true }), current = statSync(prefix + dependencyToolGuestConfigPath, { bigint: true });
    if (after.ctimeNs !== capsule.ctimeNs || after.mtimeNs !== capsule.mtimeNs || current.dev !== capsule.dev || current.ino !== capsule.ino) fail();
  } finally { closeSync(fd); }
  if(plan.admission.status===DependencyToolReadyReadStatus.Usable || plan.admission.status===DependencyToolReadyReadStatus.Baseline || plan.admission.facts.provenance.kind===DependencyToolReadyProvenanceKind.LocalCompleted || plan.admission.facts.provenance.kind===DependencyToolReadyProvenanceKind.LocalCompared) {
    assertLocalLinkRoutes(prefix,tree,admissionSourceRoots(plan.admission).map(source=>source.canonicalPath));
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

/** Called inside the real private provider reservation fence, before enclosure.
 * The guest never reads host authority. No payload-selected mounts or root dirs.
 */
export function hostedManagedDependencyProviderInvocation(fence: HostedActivationFence, unit: string,
  input: { readonly command: string; readonly args: readonly string[]; readonly cwd: string;
    readonly env: Readonly<Record<string, string>> }, managedOrigin: CurrentHostedDependencyOrigin): CodexAppServerProcessInvocation | undefined {
  assertHostedActivationFence(fence);
  const fdProfile = readHostedFdProfile(), actual = assertCurrentHostedDependencyAttempt(managedOrigin,fence), binding = actual.binding;
  const session = readCurrentHostedDependencyProviderSessionHome(managedOrigin,fence,input.env.HOME,input.env.CODEX_HOME);
  const workspace = session.refresh ? session.emptyWorkdir : binding.workspace.canonicalPath;
  if (binding.version !== 2 || !fdProfile || input.cwd !== workspace ||
      !/^subscription-runtime-hosted-[a-f0-9-]{36}\.service$/.test(unit)) invalid();
  const providerId = unit.slice("subscription-runtime-hosted-".length,-".service".length);
  readCurrentHostedManagedDependencyProvider(managedOrigin,fence,unit);

  const packageRoot = hostedCodexExecutableReadPath({ codexBinaryPath: input.command, sourceEnv: input.env });
  if (!packageRoot) invalid();
  const executable = resolveExecutable(input.command, input.env.PATH);
  const node = trusted(realpathSync(process.execPath));
  const launcher = trusted(fileURLToPath(new URL("../provider-codex/app-server/adapters/hosted-app-server-launcher.js", import.meta.url)));
  const root = `/var/lib/subscription-runtime-host-policy/dependency-provider-roots/${providerId}`;
  privateDirectory(dirname(root));
  // Each provider reservation gets a fresh finite root. Existing roots are
  // unresolved effects, not reusable descriptions or silently cleaned state.
  mkdirSync(root, { mode: 0o700 });
  const hookSupport = managedDependencyHookFiles().map(pin => pin.path);
  const launcherSupport = ["hosted-process-descriptors.js", "hosted-app-server-launch-frame.js", "hosted-fd-prelude.js"]
    .map(name => trusted(`${dirname(launcher)}/${name}`));
  const readOnly = new Set<string>(["/usr", packageRoot, executable, node, launcher, ...launcherSupport,...hookSupport]);
  for (const alias of ["/bin", "/sbin", "/lib", "/lib64"]) {
    let info;
    try { info = lstatSync(alias); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    if (info.isSymbolicLink()) {
      const target = readlinkSync(alias);
      if (realpathSync(alias).startsWith("/usr/")) { symlinkSync(target, join(root, alias)); continue; }
    }
    readOnly.add(trusted(alias));
  }
  const mounts: string[] = [];
  const mounted = [...readOnly].filter(path => ![...readOnly].some(parent => parent !== path && path.startsWith(parent + "/")));
  for (const source of mounted) {
    trusted(source);
    placeholder(root, source, lstatSync(source).isDirectory());
    mounts.push(`BindReadOnlyPaths=${source}:${source}:norbind`);
  }
  for (const source of hookSupport) {
    placeholder(root,source,false);
    if (!mounted.includes(source)) mounts.push(`BindReadOnlyPaths=${source}:${source}:norbind`);
  }
  // This is a finite ESM closure, not a bind of the installed runtime tree.
  // Package resolution must not depend on a host package.json outside the root.
  writeFileSync(join(root, dirname(launcher), "package.json"), '{"type":"module"}\n', { flag: "wx", mode: 0o644 });
  writeFileSync(join(root,dirname(dirname(dirname(dirname(launcher)))),"package.json"), '{"type":"module"}\n', {flag:"wx",mode:0o644});
  // The finite skeleton supplies only parent directories. Host job metadata,
  // encryption keys/state/results are absent, not shared via a broad job bind.
  // ProtectSystem makes these skeleton parents read-only; only leaves write.
  placeholder(root, binding.jobRootDir, true);
  const home = input.env.HOME, codexHome = input.env.CODEX_HOME;
  if (!home || !codexHome || !home.startsWith(binding.jobRootDir + "/home/") ||
      home !== `${dirname(home)}/home` || codexHome !== `${dirname(home)}/codex-home`) invalid();
  for (const writable of [workspace, home, codexHome]) {
    trustedDirectory(writable);
    placeholder(root, writable, true);
    mounts.push(`BindPaths=${writable}:${writable}:norbind`);
  }
  if (session.refresh) {
    placeholder(root,binding.workspace.canonicalPath,true);
    mounts.push(`BindReadOnlyPaths=${binding.workspace.canonicalPath}:${binding.workspace.canonicalPath}:norbind`);
  }
  const git = `${binding.workspace.canonicalPath}/.git`;
  placeholder(root, git, true);
  mounts.push(`BindReadOnlyPaths=${git}:${git}:norbind`);
  let toolCache: string | undefined;
  if (binding.version === 2) {
    for (const file of binding.toolProfile.readonlyFiles) placeholder(root, file.path, false);
    placeholder(root, `${binding.workspace.canonicalPath}/node_modules`, true);
    placeholder(root, binding.toolProfile.cache.canonicalPath, true);
    // The protected capsule is created exclusively by the plan producer, not
    // supplied by payload env or the provider launch frame.
    mkdirSync(join(root, dirname(dependencyToolGuestConfigPath)), { recursive: true, mode: 0o700 });
  }
  for (const name of ["resolv.conf", "hosts", "nsswitch.conf", "services"]) {
    publicSnapshot(root, `/etc/${name}`);
  }
  publicSnapshot(root, "/etc/ssl/certs/ca-certificates.crt", 1024 * 1024);
  placeholder(root, "/proc", true); placeholder(root, "/tmp", true); placeholder(root, "/var/tmp", true);
  try {
  if (binding.version === 2) {
    const tools = prepareHostedDependencyToolPlan(fence, unit, binding, root,
      [workspace, home, codexHome], mounted, managedOrigin);
    if (!tools) invalid();
    // These are construction data from the actual retained plan, never caller
    // selected source paths. Release independently verifies each actual mount.
    for (const source of tools.sourcePaths) placeholder(root, source, true);
    toolCache = tools.cache; mounts.push(...tools.mounts);
  }
  syncDirectory(root);
  // The old launcher profiles hide this backing prefix wholesale. This finite
  // root exposes only the exact admitted job; host policy siblings do not exist.
  const properties = ["Slice=subscription-runtime-hosted.slice", "KillMode=control-group", "SendSIGKILL=yes",
    "Delegate=no", "Restart=no", "ProtectControlGroups=yes", "PrivateDevices=yes", "ProtectKernelModules=yes",
    "RestrictSUIDSGID=yes", "AmbientCapabilities=", "CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SETPCAP CAP_SETFCAP",
    "ProtectSystem=strict", "NoNewPrivileges=yes", "MemorySwapMax=0", "LimitCORE=0", "TimeoutStopSec=30s",
    "RuntimeMaxSec=8h", "TasksMax=512", "MemoryMax=4G", "CPUQuota=200%", `RootDirectory=${root}`,
    ...(fdProfile ? hostedFdSystemdProperties : []),
    "MountAPIVFS=yes", ...mounts,
    `ReadWritePaths=${workspace} ${home} ${codexHome}${toolCache ? " " + toolCache : ""}`,
    "TemporaryFileSystem=/tmp:rw,nosuid,nodev,mode=1777,size=256M /var/tmp:rw,nosuid,nodev,mode=1777,size=64M"];
  const invocation: CodexAppServerProcessInvocation = { command: hostedDependencySystemdRunExecutable, systemdUnit: unit,
    args: ["--quiet", "--wait", "--pipe", `--unit=${unit}`, "--service-type=exec",
      "--expand-environment=no", `--working-directory=${input.cwd}`, ...properties.map(p => `--property=${p}`), "--",
      "/usr/bin/unshare", "--map-user=65532", "--map-group=65532", "--keep-caps", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL",
      "/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
      "/usr/bin/tini", "--", node, launcher, ...(fdProfile ? ["--fd-ready-v1"] : [])],
    stdinBootstrap: encodeHostedAppServerLaunchFrame({ schemaVersion: 1, ...input, command: executable, args: [...input.args] }) };
  Object.freeze(invocation.args); Object.freeze(invocation);
  retainHostedDependencyToolInvocation(fence, invocation);
  return invocation;
  } catch (error) { abandonHostedDependencyToolPlan(unit); throw error; }
}
function resolveExecutable(command: string, path: string | undefined): string {
  for (const candidate of command.startsWith("/") ? [command] : (path ?? "").split(":").filter(Boolean).map(p => `${p}/${command}`)) {
    try {
      trustedDirectory(dirname(candidate));
      const target = trusted(realpathSync(candidate));
      const stat = lstatSync(target);
      if (stat.isFile() && (stat.mode & 0o111)) return target;
    } catch { /* An unresolved/untrusted PATH entry cannot expand the root. */ }
  }
  return invalid();
}
function trusted(path: string): string {
  if (!path.startsWith("/") || realpathSync(path) !== path) invalid();
  for (let current = path;; current = dirname(current)) {
    const info = lstatSync(current);
    if (info.uid !== 0 || (info.mode & 0o022) || info.isSymbolicLink()) invalid();
    if (current === "/") break;
  }
  return path;
}
function trustedDirectory(path: string): void { trusted(path); if (!lstatSync(path).isDirectory()) invalid(); }
function privateDirectory(path: string): void {
  const paths: string[] = [];
  for (let p = path;; p = dirname(p)) { paths.unshift(p); if (p === "/") break; }
  for (const p of paths) {
    try { lstatSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; mkdirSync(p, { mode: 0o700 }); }
    trustedDirectory(p);
  }
}
function placeholder(root: string, target: string, directory: boolean): void {
  const path = join(root, target);
  mkdirSync(directory ? path : dirname(path), { recursive: true, mode: 0o755 });
  if (!directory) writeFileSync(path, "", { flag: "wx", mode: 0o644 });
}
function publicSnapshot(root: string, source: string, max = 65536): void {
  const path = realpathSync(source);
  trusted(path);
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > max) invalid();
  placeholder(root, source, false);
  writeFileSync(join(root, source), readFileSync(path));
  const fd = openSync(join(root, source), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function invalid(): never { throw new DependencyAdmissionError(DependencyAdmissionFailure.Unsupported); }

function managedDependencyHookFiles(): readonly DependencyToolFile[] {
  return ["./hosted-global-scan-pre-tool-hook.js","./hosted-global-scan-hook-policy.js","./code-mode-exec-command-parser.js",
    "../worker-core/host-command/global-filesystem-scan-policy.js"].map(name => trustedFile(trusted(fileURLToPath(new URL(name,import.meta.url)))));
}
