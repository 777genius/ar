import { HostedRemovalRetirementMutex, type HostedRemovalRetirementReferences, type HostedRemovalRetirementWitness } from "./hosted-removal-retirement-mutex";
import { assertHostedOrdinaryDependencyNotAdopted } from "./hosted-dependency-origin";
import { hostedFdLaunch } from "./hosted-fd-launch";
import type { ChildProcess } from "node:child_process";
import { decodeHostedInventoryBytes, parseHostedOrdinaryOwnedIdentity, parseHostedInventoryV5, type HostedInventoryV5 } from "../../../core/host-infrastructure/host-inventory";
import { readHostedDependencyBinding, readHostedDependencyAttempt } from "./hosted-dependency-workspace";
import { parseScopedActorChain, bindScopedActorChain, type ScopedActorChain, type ScopedEnqueueActor, parseScopedSubmitter, parseScopedStartCorrelation, parseScopedInvocation, scopedDigest, ScopedTerminationKind,
  type ScopedStartCorrelation } from "@vioxen/subscription-runtime/core";
import { parseImmutableChildSlot, readSystemBusInfrastructureField, readFdCollectorProfileField } from "@vioxen/subscription-runtime/core";
import { verifySystemBusInfrastructure } from "./system-bus-infrastructure";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readlinkSync, readSync, opendirSync, readdirSync, rmdirSync, writeSync, fsyncSync, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertHostedProcessDescriptors } from "./hosted-process-descriptors";
import { hostedToolFilesForChild, revokeHostedToolFilesForChild, assertHostedRetainedToolDescriptors, type HostedRetainedToolFiles } from "./hosted-retained-tool-files";
import { CodexProviderEgressProfileId, codexProviderEgressProfileEnvVar } from "../../codex-provider-egress-policy";
import { CodexModelBackend } from "../../codex-model-backend";
import { HostedMimoProfile } from "../../hosted-mimo-profile";
import { basename, dirname, join } from "node:path";
import type { CodexAppServerChildProcess } from "../application/app-server-process-port";
import { hasHostedActivationOrigin, HostedActivationMode, isHostedContainment, readHostedActivationMode } from "./hosted-host-policy";


const root = "/var/lib/subscription-runtime-host-policy";
const activeFences = new WeakSet<object>();
const acquisitionBusy = new WeakSet<object>();
export function isHostedActivationFenceBusy(error: unknown): boolean {
  return !!error && typeof error === "object" && acquisitionBusy.has(error);
}
// Not a configurable policy root or a public arbitrary filesystem reader.
const recordName = /^(?:readonly-dependency-bindings\/[0-9]{1,20}-[0-9]{1,20}\.json|readonly-dependency-starts\/[a-f0-9-]{36}\.json|dependency-owners\/[0-9]{1,20}-[0-9]{1,20}\.(?:json|lock)|dependency-bindings\/[a-f0-9]{64}\.json|dependency-provider-attempts\/[a-f0-9-]{36}\.json|dependency-attempt-fences\/[a-f0-9-]{36}\.json|readonly-inventory\.json|host-installation\.json|host-activation\.(?:json|next)|ordinary-origins\.json|ordinary-origins\.next|readonly-(?:enrollment\.json|epoch\.(?:json|next|lock))|ordinary-origins\/[a-f0-9]{64}\.json|ordinary-(?:starts|completed|correlations|invocations|submitters|submitter-exits|actor-chains)\/[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}\.json|scoped-(?:terminating|operations|observations|receipts)\/[a-f0-9-]{36}\.json|child-slots\/[a-f0-9]{64}\.json|codex-readonly-(?:custody|revoked)\/[a-f0-9]{64}\.json)$/;
export type HostedActivationFence = Readonly<{ readonly held: true }>;

/** Initial host root is trusted; namespace-local root is not that principal. */
export function assertHostedActivationOperator(): void {
  try {
    if (process.platform !== "linux" || process.getuid?.() !== 0 ||
        !/^0\s+0\s+4294967295$/.test(readFileSync("/proc/self/uid_map", "utf8").trim())) invalid();
    for (const ns of ["user", "mnt", "pid"]) {
      if (readlinkSync(`/proc/self/ns/${ns}`) !== readlinkSync(`/proc/1/ns/${ns}`)) invalid();
    }
  } catch { throw new Error("hosted_readonly_host_operator_required"); }
}

/** Missing final record is distinguishable from unsafe/missing ancestry. Reads
 * do not create authority, initialize directories or recover partial state. */
export function readHostedActivationBytes(name: string): Buffer | null {
  assertHostedActivationOperator();
  if (!recordName.test(name)) invalid();
  const bytes = readActivationPath(join(root, name));
  if (bytes && name === "readonly-inventory.json") decodeHostedInventoryBytes(bytes);
  return bytes;
}
function readActivationPath(path: string, privateFile = true): Buffer | null {
  const parent = dirname(path);
  const parents: string[] = [];
  for (let current = parent;; current = dirname(current)) {
    parents.unshift(current);
    if (current === "/") break;
  }
  for (const current of parents) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) ||
        (privateFile && current === parent && (stat.mode & 0o077))) invalid();
  }
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const before = fstatSync(fd), max = 4 * 1024 * 1024;
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & (privateFile ? 0o077 : 0o022)) || before.size > max) invalid();
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.ctimeMs !== before.ctimeMs ||
        after.mtimeMs !== before.mtimeMs || after.uid !== 0 || after.nlink !== 1 || (after.mode & (privateFile ? 0o077 : 0o022))) invalid();
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
export function decodeHostedActivationBytes(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { invalid(); }
}

/** Same boot-specific mkdir mutex as the managed epoch. No stale lock removal,
 * second lock or missing-epoch fallback. Acquisition can precede enrollment. */
export function withHostedActivationFence<T>(action: (fence: HostedActivationFence) => T): T {
  if (readHostedActivationBytes("readonly-epoch.lock")) throw new Error("hosted_custody_legacy_lock_recovery_required");
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(boot)) {
    throw new Error("hosted_custody_boot_identity_invalid");
  }
  const lock = join(root, `readonly-epoch.${boot}.lock`);
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const busy = new Error("hosted_activation_fence_busy"); acquisitionBusy.add(busy); throw busy;
  }
  const fence = Object.freeze({ held: true as const });
  activeFences.add(fence);
  try {
    const result = action(fence);
    if (result && (typeof result === "object" || typeof result === "function") && "then" in result) {
      throw new Error("hosted_custody_synchronous_fence_required");
    }
    return result;
  } finally {
    activeFences.delete(fence);
    rmdirSync(lock);
  }
}
export function assertHostedActivationFence(fence: HostedActivationFence): void {
  if (!activeFences.has(fence)) throw new Error("hosted_custody_common_fence_required");
}

// Private fixed completed-removal composition; deliberately not provider-index API.
// This REPLACES ordinary finally/rmdir, never nests inside that lifecycle.
const retirementHandles = new WeakMap<object, HostedRemovalRetirementMutex>();
export function assertHostedActivationProcessDescriptors(fence: HostedActivationFence): void {
  assertHostedActivationFence(fence); const handle = retirementHandles.get(fence);
  if (!handle) { assertHostedProcessDescriptors(); return; }
  handle.check();
  for (const fd of [0, 1, 2]) { const s = fstatSync(fd); if (!s.isFIFO() && !s.isSocket()) invalid(); }
  for (const name of readdirSync("/proc/self/fd")) {
    const fd = Number(name); if (!/^\d+$/.test(name)) invalid(); if (fd <= 2) continue;
    try { const s = fstatSync(fd); if ((s.isFile() || s.isDirectory()) && !handle.ownsDescriptor(fd)) invalid(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EBADF") throw e; }
  }
}
export function withHostedRemovalRetirementFence<T>(
  original: (fence: HostedActivationFence) => HostedRemovalRetirementReferences,
  retire: (fence: HostedActivationFence) => T,
  archiveProof: (fence: HostedActivationFence, witness: HostedRemovalRetirementWitness) => void,
): T {
  return removalFence(false, (fence, handle) => { const witness = handle.publishWitness(original(fence));
    const result = retire(fence); synchronous(result); synchronous(archiveProof(fence, witness)); handle.archiveCompleted(); return result; });
}
export function withHostedRemovalRetirementReconciliation<T>(
  completion: (fence: HostedActivationFence, witness: HostedRemovalRetirementWitness) => T,
  archiveProof: (fence: HostedActivationFence, witness: HostedRemovalRetirementWitness) => void,
): T {
  return removalFence(true, (fence, handle) => { const witness = handle.readWitness();
    const result = completion(fence, witness); synchronous(result); synchronous(archiveProof(fence, witness)); handle.archiveCompleted(); return result; });
}
/** Current genuine common fence protects admission while only old archived
 * metadata is acknowledged. Ordinary finally owns its NEW canonical directory. */
export function acknowledgeHostedRemovalRetirementArchive(fence:HostedActivationFence,refs:HostedRemovalRetirementReferences,
  proof:(fence:HostedActivationFence,witness:HostedRemovalRetirementWitness)=>void):void {
  assertHostedActivationFence(fence);assertHostedActivationOperator();if(retirementHandles.has(fence))invalid();
  const handle=HostedRemovalRetirementMutex.openArchived(readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(),refs);
  if(!handle)return;retirementHandles.set(fence,handle);
  try { synchronous(proof(fence,handle.readWitness()));handle.acknowledgeArchived(); }
  finally { retirementHandles.delete(fence);handle.close(); }
}
function synchronous(value: unknown): void {
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value)
    throw new Error("hosted_custody_synchronous_fence_required");
}
function removalFence<T>(existing: boolean, action: (fence: HostedActivationFence, handle: HostedRemovalRetirementMutex) => T): T {
  assertHostedActivationOperator();
  if (readHostedActivationBytes("readonly-epoch.lock")) throw new Error("hosted_custody_legacy_lock_recovery_required");
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), handle = HostedRemovalRetirementMutex.open(boot, existing),
    fence = Object.freeze({ held: true as const });
  activeFences.add(fence); retirementHandles.set(fence, handle);
  try { return action(fence, handle); }
  finally { activeFences.delete(fence); retirementHandles.delete(fence); handle.close(); }
}

function invalid(): never { throw new Error("hosted_activation_evidence_invalid"); }

// Provider-side wire validation is deliberately independent of worker modules.
// These are finite private transport records, not a second enrollment/recovery
// state machine. Only ORDINARY with a retained actual process start is admitted.
type Wire = Record<string, unknown>;
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const unitGroup = (unit: string) => `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`;
function wire(value: unknown, keys: string): Wire {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) invalid();
  return value as Wire;
}
function str(value: unknown, pattern = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return value as number;
}
function digestValue(value: unknown): string { return str(value, /^[a-f0-9]{64}$/); }
function canonical(value: unknown): string {
  const path = str(value, /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/);
  if (path.length > 4096 || path.split("/").some(part => part === "." || part === "..")) invalid();
  return path;
}
function rows(value: unknown): unknown[] { if (!Array.isArray(value) || value.length > 256) invalid(); return value; }
function distinct(values: unknown[]): void { if (new Set(values).size !== values.length) invalid(); }
function requiredWire(name: string, keys: string): { bytes: Buffer; value: Wire } {
  const bytes = readHostedActivationBytes(name);
  if (!bytes) invalid();
  return { bytes, value: wire(decodeHostedActivationBytes(bytes), keys) };
}
function jobFields(value: Wire): void {
  if (value.schemaVersion !== 1) invalid();
  str(value.installationId); str(value.jobId); canonical(value.jobRootDir); canonical(value.workspacePath);
}
function same(left: Wire, right: Wire, keys: string): void {
  if (keys.split(",").some(key => left[key] !== right[key])) invalid();
}
const startKeys = "schemaVersion,installationId,jobId,jobRootDir,workspacePath,activationGeneration,bootId,supervisorId,originSha256,unit,controlGroup,creatorId,creatorPidBirth,grantSha256";
const activationKeys = "schemaVersion,installationId,hostId,bootId,supervisorId,generation,phase,ordinaryOriginsSha256,exclusiveEnrollmentSha256,ordinaryStarts";
const installationKeys = "schemaVersion,installationId,hostId,runtimeDirectory,runtimeSha,runtimeManifestSha256,inventorySha256";

/** No caller identity, environment or profile can select the private start.
 * Every use rereads the same-artifact stage, grant and retained managed history. */
function collectHostedOrdinaryProcessFacts(fence: HostedActivationFence) {
  assertHostedActivationFence(fence); assertHostedActivationOperator();
  const group = readFileSync("/proc/self/cgroup", "utf8").trim();
  const match = new RegExp(`^0::${unitGroup(`subscription-runtime-ordinary-(${uuid}).service`).replace(/\./g, "\\.")}$`).exec(group);
  if (!match) invalid();
  for (const pending of ["host-activation.next", "ordinary-origins.next", "readonly-epoch.next"]) {
    if (readHostedActivationBytes(pending)) invalid();
  }
  const installation = requiredWire("host-installation.json", installationKeys).value;
  const activation = requiredWire("host-activation.json", activationKeys).value;
  if (installation.schemaVersion !== 1 || activation.schemaVersion !== 1 || activation.phase !== "ORDINARY") invalid();
  str(installation.installationId); str(installation.hostId); canonical(installation.runtimeDirectory);
  str(installation.runtimeSha, /^[a-f0-9]{40}$/); digestValue(installation.runtimeManifestSha256); digestValue(installation.inventorySha256);
  same(installation, activation, "installationId,hostId");
  const generation = positive(activation.generation); str(activation.bootId); str(activation.supervisorId);
  digestValue(activation.ordinaryOriginsSha256);
  if (activation.exclusiveEnrollmentSha256 !== null) digestValue(activation.exclusiveEnrollmentSha256);
  const starts = rows(activation.ordinaryStarts).map(value => {
    const row = wire(value, "startId,unit,creatorId,originSha256,generation,state");
    str(row.startId, new RegExp(`^${uuid}$`)); str(row.creatorId); digestValue(row.originSha256);
    if (!["reserved", "terminal"].includes(str(row.state)) || positive(row.generation) > generation ||
        ![`subscription-runtime-ordinary-${row.startId}.service`, `subscription-runtime-hosted-${row.startId}.service`].includes(str(row.unit))) invalid();
    return row;
  });
  distinct(starts.map(row => row.startId)); distinct(starts.map(row => row.unit));
  if (readHostedActivationBytes(`scoped-terminating/${match[1]}.json`)) throw new Error("scoped_termination_fenced");
  const reservation = starts.find(row => row.startId === match[1]);
  if (!reservation || reservation.state !== "reserved") invalid();
  const startRecord = requiredWire(`ordinary-starts/${match[1]}.json`, startKeys);
  const start = startRecord.value;
  jobFields(start); positive(start.activationGeneration); str(start.creatorId); str(start.bootId); str(start.supervisorId);
  str(start.creatorPidBirth, /^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/); digestValue(start.originSha256);
  if (start.grantSha256 !== null) digestValue(start.grantSha256);
  same(start, reservation, "unit,creatorId,originSha256"); same(start, activation, "installationId,bootId,supervisorId");
  if (start.activationGeneration !== reservation.generation || group !== `0::${start.controlGroup}` || start.controlGroup !== unitGroup(str(start.unit))) invalid();
  const catalog = requiredWire("ordinary-origins.json", "schemaVersion,installationId,revision,origins");
  if (catalog.value.schemaVersion !== 1 || catalog.value.installationId !== installation.installationId ||
      sha256(catalog.bytes) !== activation.ordinaryOriginsSha256) invalid();
  positive(catalog.value.revision);
  const origins = rows(catalog.value.origins).map(value => {
    const row = wire(value, "jobId,jobRootDir,workspacePath,birthSha256");
    str(row.jobId); canonical(row.jobRootDir); canonical(row.workspacePath); digestValue(row.birthSha256); return row;
  });
  for (const key of ["jobId", "jobRootDir", "workspacePath", "birthSha256"]) distinct(origins.map(row => row[key]));
  const origin = origins.find(row => row.jobId === start.jobId);
  if (!origin || origin.birthSha256 !== start.originSha256) invalid();
  same(start, origin, "jobId,jobRootDir,workspacePath");
  assertHostedOrdinaryDependencyNotAdopted(fence, canonical(start.workspacePath));
  const jobName = sha256(str(start.jobId)) + ".json";
  const birth = requiredWire("ordinary-origins/" + jobName, "schemaVersion,installationId,jobId,jobRootDir,workspacePath,origin");
  jobFields(birth.value); same(start, birth.value, "installationId,jobId,jobRootDir,workspacePath");
  if (birth.value.origin !== "ordinary" || sha256(birth.bytes) !== start.originSha256 ||
      readHostedActivationBytes("codex-readonly-custody/" + jobName) || readHostedActivationBytes("codex-readonly-revoked/" + jobName)) invalid();
  if (readActivationPath(`/run/user/0/subscription-runtime-host-policy/codex-readonly/${jobName}`)) invalid();
  validateOrdinaryManagedHistory(activation, installation, str(start.jobId));
  const directory = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
  if (installation.runtimeDirectory !== directory) invalid();
  const stage = readActivationPath(`/run/user/0/subscription-runtime-host-policy/codex-readonly-stages/${sha256(directory)}.json`);
  if (!stage) invalid();
  const staged = wire(decodeHostedActivationBytes(stage), "schemaVersion,runtimeDirectory,runtimeSha,runtimeManifestSha256");
  if (staged.schemaVersion !== 1) invalid(); same(staged, installation, "runtimeDirectory,runtimeSha,runtimeManifestSha256");
  const grantBytes = readActivationPath(`/run/user/0/subscription-runtime-host-policy/codex-egress/${jobName}`);
  if ((grantBytes ? sha256(grantBytes) : null) !== start.grantSha256) invalid();
  let profileId = CodexProviderEgressProfileId.FullInternetV1;
  if (grantBytes) {
    const grant = decodeHostedActivationBytes(grantBytes);
    if (typeof grant !== "object" || grant === null || Array.isArray(grant)) invalid();
    if ((grant as Wire).schemaVersion === 2 || (grant as Wire).schemaVersion === 3) {
      readProviderHostedMimoGrantAtPath(
        `/run/user/0/subscription-runtime-host-policy/codex-egress/${jobName}`,
        start as { jobId: unknown; jobRootDir: unknown; workspacePath: unknown },
        str(start.grantSha256, /^[a-f0-9]{64}$/));
      profileId = CodexProviderEgressProfileId.MimoTokenPlan;
    } else {
      const legacy = wire(grant, "schemaVersion,jobId,jobRootDir,workspacePath,profileId");
      if (legacy.schemaVersion !== 1 || (legacy.profileId !== CodexProviderEgressProfileId.TestNpmQualification && legacy.profileId !== CodexProviderEgressProfileId.PublicResearchV1 && legacy.profileId !== CodexProviderEgressProfileId.FullInternetV1)) invalid();
      same(legacy, start, "jobId,jobRootDir,workspacePath"); profileId = legacy.profileId;
    }
  }
  const creator = validateOrdinaryKernel(installation, activation, start);
  if (creator.childSlotSha256 !== undefined) {
    const bytes = readHostedActivationBytes(`child-slots/${sha256(str(creator.creatorId))}.json`);
    if (!bytes || sha256(bytes) !== creator.childSlotSha256 || !grantBytes) invalid();
    const slot = parseImmutableChildSlot(decodeHostedActivationBytes(bytes));
    const grant = decodeHostedActivationBytes(grantBytes) as Wire;
    if (grant.schemaVersion !== 3 || slot.slotId !== grant.slotId || slot.lifetime.accountId !== grant.accountId ||
        slot.grantSha256 !== start.grantSha256 || slot.artifactSha !== installation.runtimeSha ||
        slot.jobId !== start.jobId || slot.jobRootDir !== start.jobRootDir || slot.workspacePath !== start.workspacePath ||
        slot.creatorId !== creator.creatorId || slot.launch.command !== (creator.launch as Wire).command || slot.launch.cwd !== (creator.launch as Wire).cwd || JSON.stringify(slot.launch.args) !== JSON.stringify((creator.launch as Wire).args) ||
        slot.lifetime.deadlineEpochMs <= Date.now()) invalid();
  } else if (grantBytes && (decodeHostedActivationBytes(grantBytes) as Wire).schemaVersion === 3) invalid();
  return { installation, activation, start, reservation, profileId,
    childBound: creator.childSlotSha256 !== undefined, parentStartSha256: sha256(startRecord.bytes) };
}

/** Fixed authenticated process/history facts only. This does not check or grant
 * descriptor authority, dependency ownership, a root purpose or child launch.
 * The selected original-map caller must pair its own genuine descriptor checks
 * before/after collection. Generic callers keep readHostedOrdinaryProcessOrigin.
 * No caller path, FD list, skip flag, callback or registration is accepted. */
export interface HostedOrdinaryProcessOriginFacts {
  readonly installation: Readonly<Record<string, unknown>>;
  readonly activation: Readonly<Record<string, unknown>> & {
    readonly ordinaryStarts: readonly Readonly<Record<string, unknown>>[];
  };
  readonly start: Readonly<Record<string, unknown>>;
  readonly reservation: Readonly<Record<string, unknown>>;
  readonly profileId: CodexProviderEgressProfileId;
  readonly childBound: boolean;
  readonly parentStartSha256: string;
}
export function collectHostedOrdinaryProcessOriginFacts(fence: HostedActivationFence): HostedOrdinaryProcessOriginFacts {
  const facts = collectHostedOrdinaryProcessFacts(fence);
  if (facts.profileId === CodexProviderEgressProfileId.MimoTokenPlan) throw new Error("hosted_mimo_activation_closed");
  const ordinaryStarts = rows(facts.activation.ordinaryStarts).map(value =>
    Object.freeze({ ...wire(value, "startId,unit,creatorId,originSha256,generation,state") }));
  return Object.freeze({ installation: Object.freeze({ ...facts.installation }),
    activation: Object.freeze({ ...facts.activation, ordinaryStarts: Object.freeze(ordinaryStarts) }),
    start: Object.freeze({ ...facts.start }), reservation: Object.freeze({ ...facts.reservation }),
    profileId: facts.profileId, childBound: facts.childBound, parentStartSha256: facts.parentStartSha256 });
}

/** Existing generic ingress retains the exact strict/legacy FD dispatch and
 * deny ordering. The factual extraction is inactive until an original-map C
 * producer joins its own resource, owner, binding and qualifier assertions. */
export function readHostedOrdinaryProcessOrigin(fence: HostedActivationFence, descriptorScope?: HostedRetainedToolFiles) {
  const { installation, activation, start, reservation, profileId, childBound } = collectHostedOrdinaryProcessFacts(fence);
  if (descriptorScope === undefined) assertHostedProcessDescriptors();
  else assertHostedRetainedToolDescriptors(descriptorScope);
  // PR1 prepares the independent reader; later lifecycle PRs must supply
  // bounded controller/child authority before activation can open.
  if (profileId === CodexProviderEgressProfileId.MimoTokenPlan) throw new Error("hosted_mimo_activation_closed");
  return { installation, activation, start, reservation, profileId, childBound };
}

/** Same fixed private-file reader as production, with a path seam for synthetic
 * fixtures. The digest binds the file to the retained ordinary start. */
export function readProviderHostedMimoGrantAtPath(path: string,
  identity: { readonly jobId: unknown; readonly jobRootDir: unknown; readonly workspacePath: unknown },
  expectedSha256: string): void {
  const bytes = readActivationPath(path);
  if (!bytes || sha256(bytes) !== expectedSha256) invalid();
  assertProviderHostedMimoGrant(decodeHostedActivationBytes(bytes), identity);
}

/** Independent provider-side validation of the exact private MiMo grant. */
export function assertProviderHostedMimoGrant(value: unknown,
  identity: { readonly jobId: unknown; readonly jobRootDir: unknown; readonly workspacePath: unknown }): void {
  const version = (value as Wire)?.schemaVersion;
  const grant = wire(value,
    (version === 3 ? "slotId," : "") + "schemaVersion,jobId,jobRootDir,workspacePath,profileId,accountId,hostedProfile,modelBackend,executionEngine,namedPermissions,globalScanGuard,nativeToolSurface");
  if ((grant.schemaVersion !== 2 && grant.schemaVersion !== 3) || grant.profileId !== CodexProviderEgressProfileId.MimoTokenPlan ||
      (version === 2 ? grant.accountId !== "account-q" : typeof grant.accountId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(grant.accountId)) ||
      (grant.hostedProfile !== HostedMimoProfile.Controller && grant.hostedProfile !== HostedMimoProfile.Child) ||
      grant.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan || grant.executionEngine !== "app-server-goal" ||
      grant.namedPermissions !== true || grant.globalScanGuard !== true ||
      grant.nativeToolSurface !== "disabled") invalid();
  if (version === 3 && (grant.hostedProfile !== HostedMimoProfile.Child || !str(grant.slotId))) invalid();
  same(grant, identity as Wire, "jobId,jobRootDir,workspacePath");
}
function validateOrdinaryManagedHistory(activation: Wire, installation: Wire, jobId: string): void {
  const enrollment = readHostedActivationBytes("readonly-enrollment.json"), epochBytes = readHostedActivationBytes("readonly-epoch.json");
  if (activation.exclusiveEnrollmentSha256 === null) { if (enrollment || epochBytes) invalid(); return; }
  if (!enrollment || !epochBytes || sha256(enrollment) !== activation.exclusiveEnrollmentSha256) invalid();
  const parse = (bytes: Buffer) => {
    const value = wire(decodeHostedActivationBytes(bytes), "schemaVersion,hostId,bootId,supervisorId,generation,requirement,identity,phase,revoked,reservations,outerRuntime");
    if (value.schemaVersion !== 1 || value.requirement !== "test_managed_qualification" || value.phase !== "closed" || typeof value.revoked !== "boolean") invalid();
    positive(value.generation); str(value.hostId); str(value.bootId); str(value.supervisorId);
    const identity = wire(value.identity, "jobId,jobRootDir,workspacePath,runtimeSha,runtimeManifestSha256,issuerDeploymentDigest,policySha256,reviewSha256,stageSha256,grantSha256");
    str(identity.jobId); canonical(identity.jobRootDir); canonical(identity.workspacePath); str(identity.runtimeSha, /^[a-f0-9]{40}$/);
    for (const key of ["runtimeManifestSha256", "issuerDeploymentDigest", "policySha256", "reviewSha256", "stageSha256", "grantSha256"]) digestValue(identity[key]);
    const reservations = rows(value.reservations).map(row => wire(row, "startId,unit,creatorId,state"));
    if (value.outerRuntime !== null) {
      const outer = wire(value.outerRuntime, "startId,unit,creatorId,state,generation");
      if (positive(outer.generation) > positive(value.generation)) invalid(); reservations.push(outer);
    }
    for (const row of reservations) {
      str(row.startId); str(row.unit); str(row.creatorId); if (row.state !== "terminal") invalid();
    }
    distinct(reservations.map(row => row.startId)); distinct(reservations.map(row => row.unit));
    return { value, identity, reservations };
  };
  const birth = parse(enrollment), current = parse(epochBytes);
  if (birth.value.generation !== 1 || birth.value.revoked || birth.reservations.length || birth.value.outerRuntime !== null ||
      birth.value.hostId !== installation.hostId || current.value.hostId !== installation.hostId || birth.identity.jobId === jobId) invalid();
  same(birth.identity, current.identity, Object.keys(birth.identity).join(","));
  same(birth.identity, installation, "runtimeSha,runtimeManifestSha256");
}
function validateOrdinaryKernel(installation: Wire, activation: Wire, start: Wire): Wire {
  const inventoryBytes = readHostedActivationBytes("readonly-inventory.json");
  if (!inventoryBytes) invalid();
  const decoded = decodeHostedActivationBytes(inventoryBytes);
  const revision = decoded && typeof decoded === "object" && "schemaVersion" in decoded ? decoded.schemaVersion : undefined;
  const modern = revision === 5 ? parseHostedInventoryV5(decoded) : undefined;
  const inventory = { bytes: inventoryBytes, value: modern ? modern as unknown as Wire : wire(decoded,
    "schemaVersion,hostId,supervisorUnit,units,runtimeLaunch,ordinaryCreators,disabledCreators" +
    (revision === 3 || revision === 4 ? ",systemBusInfrastructure" : "") + (revision === 4 ? ",collectorProfile" : "")) };
  if ((revision !== 2 && revision !== 3 && revision !== 4 && revision !== 5) || inventory.value.hostId !== installation.hostId || sha256(inventory.bytes) !== installation.inventorySha256) invalid();
  const systemBusInfrastructure = readSystemBusInfrastructureField(inventory.value);
  readFdCollectorProfileField(inventory.value);
  const units = rows(inventory.value.units).map(value => {
    const row = modern ? { name: (value as Wire).name, controlGroup: (value as Wire).controlGroup, fragmentSha256: (value as Wire).fragmentSha256 } : wire(value, "name,controlGroup,fragmentSha256"); str(row.name, /^[A-Za-z0-9_@.-]+\.(service|scope)$/);
    if (!modern && str(row.name).startsWith("subscription-runtime-hosted-")) invalid();
    canonical(row.controlGroup);
    if (!(modern && str(row.name).endsWith(".scope") && row.fragmentSha256 === null)) digestValue(row.fragmentSha256);
    return row;
  });
  if (!units.length || units.length > (modern ? 1024 : 128)) invalid();
  distinct(units.map(row => row.name)); distinct(units.map(row => row.controlGroup));
  if (systemBusInfrastructure && (inventory.value.supervisorUnit === "dbus.service" ||
      !units.some(row => row.name === "dbus.service" && row.controlGroup === systemBusInfrastructure.service.controlGroup &&
        row.fragmentSha256 === systemBusInfrastructure.service.fragmentSha256))) invalid();
  const disabled = rows(inventory.value.disabledCreators);
  if (disabled.length > (modern ? 512 : 128)) invalid(); distinct(disabled);
  for (const name of disabled) {
    if (str(name, /^[A-Za-z0-9_@.-]+\.(service|socket|timer)$/).length > 200 || units.some(row => row.name === name) ||
        (systemBusInfrastructure && name === "dbus.socket")) invalid();
  }
  const validateLaunch = (value: unknown) => {
    const launch = wire(value, "command,args,cwd"); canonical(launch.command); canonical(launch.cwd);
    if (!Array.isArray(launch.args) || launch.args.length > 128 || launch.args.some(arg => typeof arg !== "string" || arg.length > 4096 || /[\u0000-\u001f\u007f]/.test(arg))) invalid();
    return { command: canonical(launch.command), cwd: canonical(launch.cwd), args: launch.args as string[] };
  };
  validateLaunch(inventory.value.runtimeLaunch);
  const owner = units.find(row => row.name === inventory.value.supervisorUnit);
  if (!owner) invalid();
  const creators = rows(inventory.value.ordinaryCreators).map(value => {
    const row = wire(value, "creatorId,jobId,jobRootDir,workspacePath,launch" +
      (value && typeof value === "object" && "childSlotSha256" in value ? ",childSlotSha256" : ""));
    if (row.childSlotSha256 !== undefined) digestValue(row.childSlotSha256);
    str(row.creatorId); str(row.jobId); canonical(row.jobRootDir); canonical(row.workspacePath);
    const launch = validateLaunch(row.launch);
    const cli = `${installation.runtimeDirectory}/dist/worker-codex/codex-goal-cli.js`;
    if (launch.cwd !== row.workspacePath || !(launch.command === cli || (launch.command === process.execPath && launch.args[0] === cli))) invalid();
    return row;
  });
  distinct(creators.map(row => row.creatorId));
  if (creators.length > (modern ? 1 : 128)) invalid();
  for (const left of creators) for (const right of creators) {
    if (left !== right && left.jobId === right.jobId && (left.childSlotSha256 || right.childSlotSha256)) invalid();
    if (left.jobId === right.jobId ? left.jobRootDir !== right.jobRootDir || left.workspacePath !== right.workspacePath :
        left.jobRootDir === right.jobRootDir || left.workspacePath === right.workspacePath) invalid();
  }
  const creator = creators.find(row => row.creatorId === start.creatorId);
  if (!creator) invalid(); same(creator, start, "jobId,jobRootDir,workspacePath");
  const show = (name: string) => {
    const result = spawnSync("/usr/bin/systemctl", ["show", "--property=Id,FragmentPath,DropInPaths,ControlGroup,MainPID", "--", name], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 256 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" },
    });
    if (result.error || result.status !== 0) invalid();
    const value: Wire = {};
    for (const line of result.stdout.trim().split("\n")) {
      const at = line.indexOf("="), key = line.slice(0, at);
      if (at < 1 || key in value) invalid(); value[key] = line.slice(at + 1);
    }
    wire(value, "Id,FragmentPath,DropInPaths,ControlGroup,MainPID");
    if (value.Id !== name || (!modern || name !== modern.supervisorUnit) && value.DropInPaths !== "") invalid(); return value;
  };
  const supervisor = show(str(owner.name)), current = show(str(start.unit));
  const fragment = readActivationPath(canonical(supervisor.FragmentPath), false);
  if (supervisor.ControlGroup !== owner.controlGroup || !fragment || sha256(fragment) !== owner.fragmentSha256 ||
      current.ControlGroup !== start.controlGroup) invalid();
  str(current.MainPID, /^[1-9][0-9]*$/);
  if (readFileSync("/etc/machine-id", "utf8").trim() !== activation.hostId ||
      readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== activation.bootId ||
      pidBirth(str(supervisor.MainPID)) !== activation.supervisorId) invalid();
  if (modern) {
    const ownerFacts = modern.units.find(u => u.name === modern.supervisorUnit)!;
    if (modern.bootId !== activation.bootId || modern.supervisor.birth !== activation.supervisorId || Date.now() >= modern.supervisor.workEndEpochMs ||
        supervisor.FragmentPath !== ownerFacts.fragmentPath || supervisor.DropInPaths !== ownerFacts.dropIns.map(p => p.path).join(" ")) invalid();
    for (const pin of ownerFacts.dropIns) {
      const bytes = readActivationPath(pin.path, false); if (!bytes || sha256(bytes) !== pin.sha256) invalid();
    }
    const row = rows(activation.ordinaryStarts).find(v => (v as Wire).unit === start.unit) as Wire | undefined;
    if (!row) invalid();
    const identityBytes = readHostedActivationBytes(`ordinary-starts/${str(row.startId)}.identity.json`);
    if (!identityBytes || identityBytes.length > 4096) invalid();
    const identity = parseHostedOrdinaryOwnedIdentity(decodeHostedActivationBytes(identityBytes)), node = lstatSync(`/sys/fs/cgroup${canonical(start.controlGroup)}`);
    if (identity.installationId !== installation.installationId || identity.startId !== row.startId || identity.unit !== start.unit || identity.bootId !== activation.bootId ||
        identity.startSha256 !== sha256(requiredWire(`ordinary-starts/${str(row.startId)}.json`, startKeys).bytes) || identity.supervisorBirth !== modern.supervisor.birth ||
        identity.creatorBirth !== start.creatorPidBirth || identity.mainPidBirth !== pidBirth(str(current.MainPID)) || identity.controlGroup !== start.controlGroup || identity.dev !== String(node.dev) || identity.ino !== String(node.ino) || !node.isDirectory() || node.isSymbolicLink() || node.uid !== 0) invalid();
    const invocation = spawnSync("/usr/bin/systemctl", ["show", "--property=InvocationID", "--", str(start.unit)], { encoding: "utf8", timeout: 5000 });
    if (invocation.error || invocation.status !== 0 || invocation.stdout.trim() !== `InvocationID=${identity.invocationId}`) invalid();
  }
  const creatorPid = str(start.creatorPidBirth).split(":")[0]!;
  if (pidBirth(creatorPid) !== start.creatorPidBirth ||
      readFileSync(`/proc/${creatorPid}/cgroup`, "utf8").trim() !== `0::${owner.controlGroup}`) invalid();
  if (systemBusInfrastructure) verifySystemBusInfrastructure(systemBusInfrastructure);
  return creator;
}
function pidBirth(pid: string): string {
  str(pid, /^[1-9][0-9]{0,9}$/);
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  if (!stat.startsWith(pid + " (") || stat.lastIndexOf(") ") < 0) invalid();
  return pid + ":" + str(stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19], /^[1-9][0-9]{0,19}$/);
}

const failedOrdinaryWaits = new WeakSet<object>();
const ordinaryReleases = new WeakMap<object, { released: boolean; revalidate: (fence: HostedActivationFence) => void }>();
export function invalidateHostedOrdinaryWait(child: CodexAppServerChildProcess): void {
  failedOrdinaryWaits.add(child); revokeHostedToolFilesForChild(child);
}

/** A retained real submission is rechecked under the same mutex immediately
 * before its one frame. No caller context or stored receipt can reconstruct it. */
export function releaseHostedOrdinaryProcess(child: CodexAppServerChildProcess, release: (fence: HostedActivationFence, revalidate: () => void) => void): void {
  withHostedActivationFence(fence => {
    const retained = ordinaryReleases.get(child);
    if (!retained || retained.released || failedOrdinaryWaits.has(child)) invalid();
    retained.revalidate(fence);
    release(fence, () => {
      if (retained.released || failedOrdinaryWaits.has(child) || ordinaryReleases.get(child) !== retained) invalid();
      retained.revalidate(fence);
    });
    retained.released = true;
  });
}

/** Production default primitive calls this with its private synchronous spawn.
 * It never receives worker factory injection, mount options or a managed ticket. */
/** Fixed actual C reservation/history publication only. No descriptor policy,
 * spawn callback, child, owner/purpose grant or caller-supplied origin is accepted.
 * The selected original map must sandwich this operation with its own actual
 * descriptor/current-purpose proof. Generic submit keeps strict ingress below. */
export function reserveHostedOrdinaryProviderFacts(fence:HostedActivationFence,
  input:Readonly<{cwd:string;env:Readonly<Record<string,string>>}>) {
  assertHostedActivationFence(fence);
    const { activation, start, reservation: parentReservation, profileId, childBound } = collectHostedOrdinaryProcessOriginFacts(fence);
    const jobRoot = canonical(start.jobRootDir);
    const workspacePath = canonical(start.workspacePath);
    const dependency = readHostedDependencyBinding(str(start.jobId));
    if (dependency) {
      if (dependency.jobRootDir !== jobRoot || dependency.workspace.canonicalPath !== workspacePath) invalid();
      readHostedDependencyAttempt(dependency, start, str(parentReservation.startId));
    }
    if (!jobRoot.endsWith(`/jobs/${str(start.jobId)}`) ||
        workspacePath !== `${jobRoot}/workspace`) invalid();
    // The real app-server client starts in its materialized account HOME;
    // workspace belongs to the thread, not the provider process. Neither cwd
    // nor HOME supplies origin authority: that was read from the actual cgroup.
    const cwd = canonical(input.cwd);
    if ((cwd !== start.workspacePath && cwd !== input.env.HOME) || input.env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== "hosted-codex-job" ||
        (input.env[codexProviderEgressProfileEnvVar] ?? CodexProviderEgressProfileId.FullInternetV1) !== profileId) invalid();
    const starts = rows(activation.ordinaryStarts);
    if (childBound && starts.some(row => !!row && typeof row === "object" &&
        "creatorId" in row && row.creatorId === start.creatorId && "unit" in row &&
        typeof row.unit === "string" && row.unit.startsWith("subscription-runtime-hosted-"))) throw new Error("child_invocation_consumed");
    if (starts.length >= 256) invalid();
    const startId = randomUUID(), unit = `subscription-runtime-hosted-${startId}.service`;
    const generation = positive(activation.generation) + 1; positive(generation);
    const reservation = { startId, unit, creatorId: start.creatorId, originSha256: start.originSha256, generation, state: "reserved" };
    const bytes = Buffer.from(JSON.stringify({ ...start, unit, controlGroup: unitGroup(unit), activationGeneration: generation,
      creatorPidBirth: pidBirth(String(process.pid)) }) + "\n");
    const next = { ...activation, generation, ordinaryStarts: [...starts, reservation] };
    const parentId = str(parentReservation.startId);
    const parentBytes = childBound ? readHostedActivationBytes(`ordinary-starts/${parentId}.json`) : null;
    const correlationBytes = childBound ? readHostedActivationBytes(`ordinary-correlations/${parentId}.json`) : null;
    let companion: ScopedStartCorrelation | undefined;
    if (childBound) {
      if (!parentBytes || !correlationBytes) invalid();
      const parent = parseScopedStartCorrelation(decodeHostedActivationBytes(correlationBytes));
      if (!Buffer.from(JSON.stringify(parent) + "\n").equals(correlationBytes) || parent.kind !== ScopedTerminationKind.Runtime || parent.startId !== parentId || parent.startDigest !== sha256(parentBytes) ||
          parent.identity.deadlineEpochMs <= Date.now() ||
          parent.identity.parentStartId !== parentId || parent.identity.grantDigest !== start.grantSha256) invalid();
      const slotBytes = readHostedActivationBytes(`child-slots/${sha256(str(start.creatorId))}.json`);
      if (!slotBytes) invalid();
      const slot = parseImmutableChildSlot(decodeHostedActivationBytes(slotBytes)), identity = parent.identity;
      if (identity.accountId !== slot.lifetime.accountId || identity.slotId !== slot.slotId || identity.sourceSha !== slot.sourceSha || identity.artifactSha !== slot.artifactSha ||
          identity.deadlineEpochMs !== slot.lifetime.deadlineEpochMs || identity.grantDigest !== slot.grantSha256 ||
          identity.installationId !== activation.installationId || identity.hostId !== activation.hostId || identity.inventoryDigest !== wire(decodeHostedActivationBytes(readHostedActivationBytes("host-installation.json")!), installationKeys).inventorySha256 ||
          identity.bootId !== activation.bootId || identity.supervisorId !== activation.supervisorId ||
          slot.creatorId !== start.creatorId || slot.jobId !== start.jobId || slot.jobRootDir !== start.jobRootDir || slot.workspacePath !== start.workspacePath ||
          parent.unit !== start.unit || parent.controlGroup !== start.controlGroup || parent.creatorPidBirth !== start.creatorPidBirth ||
          parent.creatorControlGroup !== identity.supervisorControlGroup) invalid();
      companion = parseScopedStartCorrelation({ ...parent, kind: ScopedTerminationKind.Provider,
        startId, startDigest: sha256(bytes), reservationGeneration: generation, unit, controlGroup: unitGroup(unit),
        creatorPidBirth: pidBirth(String(process.pid)), creatorControlGroup: str(start.controlGroup) });
    }
    assertHostedScopedAdmission(fence, parentId);
    publishOrdinaryActivation(fence, next);
    try {
      createActivationRecord(`ordinary-starts/${startId}.json`, bytes);
      if (companion) createActivationRecord(`ordinary-correlations/${startId}.json`, Buffer.from(JSON.stringify(companion) + "\n"));
      if (dependency) {
        const attempt = readHostedDependencyAttempt(dependency, start, parentId);
        createActivationRecord(`dependency-provider-attempts/${startId}.json`, Buffer.from(JSON.stringify({
          version: 1, parentStartId: parentId, attemptId: attempt.attemptId, epoch: attempt.epoch,
          providerStartId: startId, startDigest: sha256(bytes), unit,
        }) + "\n"));
      }
      assertHostedScopedAdmission(fence, parentId);
      return readHostedOrdinaryProviderFacts(fence,startId);
    } catch (error) {
      if (!childBound) publishOrdinaryActivation(fence,{...next,generation:generation+1,phase:"CLOSED"});
      throw error;
    }
}
/** Fresh exact selected provider row/start/parent/attempt relationship. The
 * current authenticated catalog is collected on every call, never a saved DTO.
 * This read model has no raw child registration or terminal status setter. */
export enum HostedOrdinaryProviderReadPhase { Reserved="reserved", OwnTerminal="own_terminal" }
export function readHostedOrdinaryProviderFacts(fence:HostedActivationFence,startId:string,
  phase:HostedOrdinaryProviderReadPhase=HostedOrdinaryProviderReadPhase.Reserved) {
  assertHostedActivationFence(fence); str(startId,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const parent = collectHostedOrdinaryProcessOriginFacts(fence), startPin = requiredWire(`ordinary-starts/${startId}.json`,startKeys);
  const provider = startPin.value, unit = `subscription-runtime-hosted-${startId}.service`;
  const found = parent.activation.ordinaryStarts.filter(row=>row.startId===startId);
  if (found.length!==1) invalid(); const reservation=found[0]!;
  if (reservation.unit!==unit || reservation.state!==(phase===HostedOrdinaryProviderReadPhase.Reserved ? "reserved":phase===HostedOrdinaryProviderReadPhase.OwnTerminal ? "terminal":invalid()) || reservation.creatorId!==parent.start.creatorId ||
      reservation.originSha256!==parent.start.originSha256 || reservation.generation!==provider.activationGeneration ||
      positive(reservation.generation)>positive(parent.activation.generation) || provider.unit!==unit || provider.controlGroup!==unitGroup(unit) ||
      provider.creatorPidBirth!==pidBirth(String(process.pid))) invalid();
  same(provider,parent.start,"installationId,hostId,bootId,supervisorId,originSha256,creatorId,jobId,jobRootDir,workspacePath,grantSha256");
  const parentId=str(parent.reservation.startId), dependency=readHostedDependencyBinding(str(parent.start.jobId));
  let relation:Wire|undefined;
  if (dependency) {
    const attempt=readHostedDependencyAttempt(dependency,parent.start,parentId);
    const bytes=readHostedActivationBytes(`dependency-provider-attempts/${startId}.json`); if (!bytes) invalid();
    relation=wire(decodeHostedActivationBytes(bytes),"version,parentStartId,attemptId,epoch,providerStartId,startDigest,unit");
    if (relation.version!==1 || relation.parentStartId!==parentId || relation.attemptId!==attempt.attemptId || relation.epoch!==attempt.epoch ||
        relation.providerStartId!==startId || relation.startDigest!==sha256(startPin.bytes) || relation.unit!==unit ||
        !Buffer.from(JSON.stringify(relation)+"\n").equals(bytes)) invalid();
  }
  let companion:ScopedStartCorrelation|undefined;
  if (parent.childBound) {
    const bytes=readHostedActivationBytes(`ordinary-correlations/${startId}.json`); if (!bytes) invalid();
    companion=parseScopedStartCorrelation(decodeHostedActivationBytes(bytes));
    if (companion.kind!==ScopedTerminationKind.Provider || companion.startId!==startId || companion.startDigest!==sha256(startPin.bytes) ||
        companion.identity.parentStartId!==parentId || companion.unit!==unit || companion.reservationGeneration!==reservation.generation ||
        companion.identity.deadlineEpochMs<=Date.now() || !Buffer.from(JSON.stringify(companion)+"\n").equals(bytes)) invalid();
  }
  assertHostedScopedAdmission(fence,parentId);
  return Object.freeze({parent,provider:Object.freeze({...provider}),reservation:Object.freeze({...reservation}),
    startId,unit,parentId,bytes:Buffer.from(startPin.bytes),startSha256:sha256(startPin.bytes),
    ...(relation?{relation:Object.freeze({...relation})}:{}),...(companion?{companion}:{}),dependency});
}

export function submitHostedOrdinaryProcess(input: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
  submit: (unit: string, identity: { readonly jobId: string; readonly workspacePath: string }, fence: HostedActivationFence) => CodexAppServerChildProcess): CodexAppServerChildProcess {
  return withHostedActivationFence(fence => {
    readHostedOrdinaryProcessOrigin(fence); // Generic strict descriptor ingress stays mandatory.
    const actual=reserveHostedOrdinaryProviderFacts(fence,input);
    const {parent:{activation,start,reservation:parentReservation,childBound},startId,unit,parentId,bytes,reservation,dependency,companion}=actual;
    const workspacePath=canonical(start.workspacePath), generation=positive(reservation.generation);
    const next={...activation,generation,ordinaryStarts:[...rows(activation.ordinaryStarts)]};
    try {
      const child = submit(unit, { jobId: str(start.jobId), workspacePath }, fence);
      const descriptorScope = hostedToolFilesForChild(child);
      ordinaryReleases.set(child, { released: false, revalidate: held => {
        const fresh = readHostedOrdinaryProcessOrigin(held, descriptorScope);
        if (JSON.stringify(fresh.start) !== JSON.stringify(start) ||
            JSON.stringify(fresh.reservation) !== JSON.stringify(parentReservation) ||
            fresh.activation.installationId !== activation.installationId || fresh.activation.bootId !== activation.bootId ||
            fresh.activation.supervisorId !== activation.supervisorId) invalid();
        assertHostedScopedAdmission(held, parentId);
        const retained = readHostedActivationBytes(`ordinary-starts/${startId}.json`);
        const current = requiredWire("host-activation.json", activationKeys).value;
        const row = rows(current.ordinaryStarts).find(row => !!row && typeof row === "object" && "startId" in row && row.startId === startId);
        if (!retained?.equals(bytes) || JSON.stringify(row) !== JSON.stringify(reservation)) invalid();
        if (dependency) readHostedDependencyAttempt(dependency, fresh.start, parentId);
        if (companion && companion.identity.deadlineEpochMs <= Date.now()) invalid();
        const inventoryBytes = readHostedActivationBytes("readonly-inventory.json")!;
        const inventory = decodeHostedInventoryBytes(inventoryBytes);
        if ((inventory as Wire).schemaVersion === 5) {
          const v5 = parseHostedInventoryV5(inventory), guard = hostedFdLaunch(child as unknown as ChildProcess);
          if (guard.unit !== unit || !child.pid || failedOrdinaryWaits.has(child) || Date.now() >= v5.supervisor.workEndEpochMs) invalid();
          const result = spawnSync("/usr/bin/systemctl", ["show", "--property=Id,InvocationID,ControlGroup,MainPID,Delegate", "--", unit], { encoding: "utf8", timeout: Math.min(5000, v5.supervisor.workEndEpochMs - Date.now()) });
          if (result.error || result.status !== 0) invalid();
          const facts = Object.fromEntries(result.stdout.trim().split("\n").map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
          const group = unitGroup(unit), node = lstatSync(`/sys/fs/cgroup${group}`);
          if (facts.Id !== unit || facts.ControlGroup !== group || facts.Delegate !== "no" || !/^[a-f0-9]{32}$/.test(facts.InvocationID ?? "") || !node.isDirectory() || node.uid !== 0) invalid();
          createActivationRecord(`ordinary-starts/${startId}.identity.json`, Buffer.from(JSON.stringify({ schemaVersion: 1,
            installationId: activation.installationId, startId, startSha256: sha256(bytes), parentStartId: parentId, unit, bootId: activation.bootId,
            supervisorBirth: v5.supervisor.birth, creatorBirth: pidBirth(String(process.pid)), invocationId: facts.InvocationID,
            controlGroup: group, dev: String(node.dev), ino: String(node.ino), mainPidBirth: pidBirth(facts.MainPID!),
            workEndEpochMs: v5.supervisor.workEndEpochMs, cleanupEndEpochMs: v5.supervisor.cleanupEndEpochMs }) + "\n"));
        }
      } });
      if (companion) retainHostedScopedSubmitter(fence, companion, child);
      child.on("error", () => invalidateHostedOrdinaryWait(child));
      child.stdin.on?.("error", () => invalidateHostedOrdinaryWait(child));
      const schema5Wait = (decodeHostedInventoryBytes(readHostedActivationBytes("readonly-inventory.json")!) as Wire).schemaVersion === 5;
      const retainTerminal = (code: number | null, signal: string | null) => {
        const release = ordinaryReleases.get(child);
        ordinaryReleases.delete(child);
        if (code !== 0 || signal !== null || failedOrdinaryWaits.has(child)) return;
        try {
          withHostedActivationFence(() => {
            const retained = readHostedActivationBytes(`ordinary-starts/${startId}.json`);
            const current = requiredWire("host-activation.json", activationKeys).value;
            const row = rows(current.ordinaryStarts).find(row => !!row && typeof row === "object" && "startId" in row && row.startId === startId);
            if (!retained?.equals(bytes) || JSON.stringify(row) !== JSON.stringify(reservation) ||
                current.installationId !== activation.installationId || current.bootId !== activation.bootId ||
                current.supervisorId !== activation.supervisorId) invalid();
            if (schema5Wait) {
              if (!release?.released) invalid();
              hostedFdLaunch(child as unknown as ChildProcess).assertOriginalZeroWaitClosed();
            }
            createActivationRecord(`ordinary-completed/${startId}.json`, Buffer.from(JSON.stringify({ schemaVersion: 1,
              startId, startSha256: sha256(bytes), waitStatus: 0 }) + "\n"));
          });
        } catch { invalidateHostedOrdinaryWait(child); } // Ambiguity retains the reservation; no synthetic completion.
      };
      if (schema5Wait) (child as unknown as ChildProcess).once("close", retainTerminal);
      else child.on("exit", retainTerminal);
      return child;
    } catch (error) {
      if (!childBound) publishOrdinaryActivation(fence, { ...next, generation: generation + 1, phase: "CLOSED" });
      throw error;
    }
  });
}
/** Same synchronous fence checked by every producer immediately before enqueue. */
export function assertHostedScopedAdmission(fence: HostedActivationFence, parentStartId: string): void {
  assertHostedActivationFence(fence);
  str(parentStartId, new RegExp(`^${uuid}$`));
  if (readHostedActivationBytes(`scoped-terminating/${parentStartId}.json`)) throw new Error("scoped_termination_fenced");
}
export function retainHostedScopedCorrelation(fence: HostedActivationFence, correlation: ScopedStartCorrelation): void {
  assertHostedActivationFence(fence);
  const c = parseScopedStartCorrelation(correlation);
  assertHostedScopedAdmission(fence, c.identity.parentStartId);
  createActivationRecord(`ordinary-correlations/${c.startId}.json`, Buffer.from(JSON.stringify(c) + "\n"));
}
/** Guest consumes this retained data at actual execution; it conveys no fresh
 * admission, deadline renewal, or authority to initialize provider work. */
export interface HostedRetainedLifetimeBinding {
  readonly correlation: ScopedStartCorrelation;
  readonly absoluteDeadlineEpochMs: number;
  readonly cleanupBudgetMs: number;
  readonly dispatcherPidBirth: string;
  readonly authenticatedChannelDigest: string;
}
/** Implemented by the guest's retained channel/FD authority. This port's data
 * never reconstructs FreshKeyedSubmission or grants execution by itself. */
export interface HostedRetainedLifetimePort {
  readAuthenticatedLifetime(parentStartId: string): HostedRetainedLifetimeBinding;
}
/** Subsequent guest integration must implement this using its retained,
 * authenticated channel, not a caller boolean or a procfs observation. Before
 * publish, hold every thread of the creator's scoped submission path and every
 * wrapper/manager descendant against fork/clone/exec/enqueue. Supply the exact
 * role-labelled, parent-ordered graph (direct manager or wrapper-backed).
 * Keep that hold across observation, durable publication and its final reread.
 * Release only after publish returns normally and the original lifetime permits
 * work; a throw, deadline, disconnect or actor/task change keeps the graph held
 * for cleanup. Holds may not be dropped/recreated to renew the original budget.
 * This declaration provides no barrier implementation or execution authority. */
export interface HostedScopedActorBarrierPort {
  retainBeforeRelease(binding: HostedRetainedLifetimeBinding,
    publish: (heldGraph: ScopedActorChain) => void): void;
}

/** Pin only an invocation observed while the originally owned submitter is live.
 * A missing/partial record retains the reservation; no later PID lookup repairs it. */
export function retainHostedScopedSubmitter(fence: HostedActivationFence, correlation: ScopedStartCorrelation,
  child: Pick<CodexAppServerChildProcess, "pid" | "on">): void {
  assertHostedActivationFence(fence);
  const c = parseScopedStartCorrelation(correlation);
  if (!child.pid) invalid();
  const submitter = { schemaVersion: 1, correlationDigest: scopedDigest(c),
    pidBirth: pidBirth(String(child.pid)), controlGroup: readFileSync(`/proc/${child.pid}/cgroup`, "utf8").trim().replace(/^0::/, "") };
  if (!/^0::\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(readFileSync(`/proc/${child.pid}/cgroup`, "utf8").trim())) invalid();
  const bytes = Buffer.from(JSON.stringify(submitter) + "\n");
  createActivationRecord(`ordinary-submitters/${c.startId}.json`, bytes);
  // Wrapper exit is an observation only. The separately owned launcher must
  // close the entire authenticated actor chain through the narrow producer seam.
  // Manager observation failure is retained, not an excuse to adopt a later unit.
  const result = spawnSync("/usr/bin/systemctl", ["show", "--property=Id,InvocationID,ControlGroup", "--", c.unit], {
    encoding: "utf8", timeout: 5000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) invalid();
  const observed: Record<string, string> = {};
  for (const line of result.stdout.trimEnd().split("\n")) { const at = line.indexOf("="); if (at < 1 || line.slice(0, at) in observed) invalid(); observed[line.slice(0, at)] = line.slice(at + 1); }
  if (Object.keys(observed).sort().join(",") !== "ControlGroup,Id,InvocationID" || observed.Id !== c.unit || observed.ControlGroup !== c.controlGroup ||
      pidBirth(String(child.pid)) !== submitter.pidBirth) invalid();
  const invocation = parseScopedInvocation({ schemaVersion: 1, correlationDigest: scopedDigest(c), invocationId: observed.InvocationID });
  createActivationRecord(`ordinary-invocations/${c.startId}.json`, Buffer.from(JSON.stringify(invocation) + "\n"));
}
function createActivationRecord(name: string, bytes: Buffer, verifyEvidence: () => void = () => {}, finalName?: string): void {
  assertHostedActivationOperator();
  if (!recordName.test(name) || bytes.length > 4 * 1024 * 1024) invalid();
  const path = join(root, name), parents: { path: string; fd: number; dev: number; ino: number }[] = [];
  try {
    for (let directory = dirname(path);; directory = dirname(directory)) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & (directory === dirname(path) ? 0o077 : 0o022))) invalid();
      const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      parents.push({ path: directory, fd, dev: stat.dev, ino: stat.ino });
      const opened = fstatSync(fd); if (opened.dev !== stat.dev || opened.ino !== stat.ino) invalid();
      if (directory === "/") break;
    }
    const verify = () => { for (const p of parents) { const stat = lstatSync(p.path); if (stat.dev !== p.dev || stat.ino !== p.ino || !stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) invalid(); } };
    verify(); verifyEvidence();
    let anchored = `/proc/self/fd/${parents[0]!.fd}/${basename(path)}`;
    const fd = openSync(anchored, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset); if (count <= 0) invalid(); offset += count; }
      let before = fstatSync(fd);
      const check = () => {
        const stat = fstatSync(fd), named = lstatSync(anchored), actual = Buffer.alloc(bytes.length + 1);
        let length = 0; while (length < actual.length) { const n = readSync(fd, actual, length, actual.length - length, length); if (!n) break; length += n; }
        if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size !== bytes.length ||
            stat.dev !== before.dev || stat.ino !== before.ino || stat.ctimeMs !== before.ctimeMs || stat.mtimeMs !== before.mtimeMs ||
            named.dev !== stat.dev || named.ino !== stat.ino || length !== bytes.length || !actual.subarray(0, length).equals(bytes)) invalid();
        verify();
      };
      check(); verifyEvidence(); fsyncSync(fd); for (const parent of parents) fsyncSync(parent.fd); check(); verifyEvidence();
      if (finalName !== undefined) {
        if (!recordName.test(finalName) || dirname(join(root, finalName)) !== dirname(path)) invalid();
        const final = `/proc/self/fd/${parents[0]!.fd}/${basename(finalName)}`;
        try { lstatSync(final); throw new Error("scoped_actor_chain_conflict"); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        // Caller must hold the graph across this atomic name publication and
        // final ancestry fsync. Enumeration cannot close that execution race.
        verifyEvidence(); verify(); renameSync(anchored, final); anchored = final;
        before = fstatSync(fd);
        for (const parent of parents) fsyncSync(parent.fd);
        check();
      }
    } finally { closeSync(fd); }
  } finally { for (const p of parents.reverse()) closeSync(p.fd); }
}
function publishOrdinaryActivation(fence: HostedActivationFence, next: Wire): void {
  assertHostedActivationFence(fence);
  createActivationRecord("host-activation.next", Buffer.from(JSON.stringify(next) + "\n"));
  renameSync(join(root, "host-activation.next"), join(root, "host-activation.json"));
  syncActivationDirectory(root);
}
function syncActivationDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function requiresHostedProcessAdmission(env: Readonly<Record<string, string | undefined>>): boolean {
  if (process.platform !== "linux" || (process.getuid?.() !== 0 && !isHostedContainment(env))) return false;
  return readHostedActivationMode() === HostedActivationMode.Required || hasHostedActivationOrigin();
}

/** Guest-owned launcher calls this after observing its full enqueue graph, before
 * releasing any actor to enqueue. All births/groups/parent edges are independently
 * re-read here. No complete=true or caller proof boolean is accepted. This does
 * not implement launcher observation, channel enforcement or manager execution. */
export function retainHostedScopedActorChain(fence: HostedActivationFence, correlation: ScopedStartCorrelation, input: ScopedActorChain): void {
  assertHostedActivationFence(fence); assertHostedActivationOperator();
  const c = parseScopedStartCorrelation(correlation), chain = parseScopedActorChain(input);
  const bytes = readHostedActivationBytes(`ordinary-submitters/${c.startId}.json`);
  if (!bytes) invalid();
  const submitter = parseScopedSubmitter(decodeHostedActivationBytes(bytes));
  bindScopedActorChain(chain, { ...c, invocationId: "0".repeat(32), submitterDigest: sha256(bytes) }, submitter);
  assertHostedScopedAdmission(fence, c.identity.parentStartId);
  const end = performance.now() + 1000;
  const observe = () => chain.actors.map(actor => {
    const pid = actor.pidBirth.split(":")[0]!;
    if (pidBirth(pid) !== actor.pidBirth || readFileSync(`/proc/${pid}/cgroup`, "utf8").trim() !== `0::${actor.controlGroup}`) invalid();
    const stat = scopedTaskStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
    if (actor.parentPidBirth && stat.parent !== actor.parentPidBirth.split(":")[0]) invalid();
    // Creator siblings belong to separately retained scopes. Only the admitted
    // submitter subtree is enumerated; no proc-wide discovery or foreign effect.
    const tasks = actor.parentPidBirth ? observeHostedScopedActorChildren(actor, end) : null;
    const expected = chain.actors.filter(a => a.parentPidBirth === actor.pidBirth).map(a => a.pidBirth.split(":")[0]!).sort();
    if (tasks && tasks.tasks.some(t => t.parent !== stat.parent)) invalid();
    if (tasks && JSON.stringify(tasks.children) !== JSON.stringify(expected)) throw new Error("scoped_actor_chain_incomplete");
    return { birth: actor.pidBirth, parent: stat.parent, tasks };
  });
  const before = observe();
  const verifyMembership = () => {
    if (performance.now() >= end || scopedDigest(before) !== scopedDigest(observe())) throw new Error("scoped_actor_membership_changed");
  };
  verifyMembership();
  const pending = `ordinary-actor-chains/${c.startId}.next.json`, final = `ordinary-actor-chains/${c.startId}.json`;
  // A failed last-fsync observation leaves an obligation, never a readable
  // authenticated final chain. Only a held guest graph may cross this rename.
  if (readHostedActivationBytes(final) || readHostedActivationBytes(pending)) throw new Error("scoped_actor_chain_publication_pending");
  createActivationRecord(pending, Buffer.from(JSON.stringify(chain) + "\n"), verifyMembership, final);
}

/** Bounded facts for one already admitted process, shared by producer and
 * cleanup kernel. Enumeration cannot replace the guest's held execution barrier.
 * The caller supplies the original monotonic end, never a renewed allowance. */
export function observeHostedScopedActorChildren(actor: ScopedEnqueueActor, end: number): {
  readonly children: readonly string[]; readonly tasks: readonly { readonly birth: string; readonly parent: string; readonly children: readonly string[] }[];
} {
  const pid = actor.pidBirth.split(":")[0]!;
  if (!/^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/.test(actor.pidBirth) || !Number.isFinite(end)) invalid();
  const check = () => { if (performance.now() >= end) throw new Error("scoped_actor_observation_budget"); };
  const taskIds = () => {
    check(); const directory = opendirSync(`/proc/${pid}/task`), ids: string[] = [];
    try { for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      check(); if (ids.length >= 256 || !/^[1-9][0-9]{0,9}$/.test(entry.name)) throw new Error("scoped_actor_tasks_ambiguous"); ids.push(entry.name);
    } } finally { directory.closeSync(); }
    if (!ids.includes(pid) || new Set(ids).size !== ids.length) throw new Error("scoped_actor_tasks_ambiguous");
    return ids.sort();
  };
  const ids = taskIds();
  const observe = () => ids.map(tid => {
    check(); const path = `/proc/${pid}/task/${tid}`;
    const stat = scopedTaskStat(tid, readFileSync(path + "/stat", "utf8"));
    const status = readFileSync(path + "/status", "utf8"), raw = readFileSync(path + "/children", "utf8");
    if (status.length > 65536 || status.match(/^Tgid:\s+([0-9]+)$/m)?.[1] !== pid || status.match(/^Pid:\s+([0-9]+)$/m)?.[1] !== tid ||
        readFileSync(path + "/cgroup", "utf8").trim() !== `0::${actor.controlGroup}` || raw.length > 4096 || (raw.trim() && !/^(?:[1-9][0-9]{0,9}\s*)+$/.test(raw))) throw new Error("scoped_actor_tasks_ambiguous");
    const children = raw.trim() ? raw.trim().split(/\s+/).sort() : [];
    if (children.length > 64 || new Set(children).size !== children.length) throw new Error("scoped_actor_tasks_ambiguous");
    return { ...stat, children };
  });
  const tasks = observe(), children = tasks.flatMap(t => t.children).sort();
  // A child appearing under two different tasks is ambiguous, not a union proof.
  if (children.length > 64 || new Set(children).size !== children.length || JSON.stringify(ids) !== JSON.stringify(taskIds()) ||
      scopedDigest(tasks) !== scopedDigest(observe()) || pidBirth(pid) !== actor.pidBirth ||
      readFileSync(`/proc/${pid}/cgroup`, "utf8").trim() !== `0::${actor.controlGroup}` || JSON.stringify(ids) !== JSON.stringify(taskIds())) throw new Error("scoped_actor_membership_changed");
  check(); return { children, tasks };
}
function scopedTaskStat(tid: string, raw: string): { birth: string; parent: string } {
  const close = raw.lastIndexOf(") "), values = raw.slice(close + 2).trim().split(/\s+/);
  if (raw.length > 4096 || !raw.startsWith(tid + " (") || close < 0 || !/^[1-9][0-9]{0,19}$/.test(values[19] ?? "") || !/^(?:0|[1-9][0-9]{0,9})$/.test(values[1] ?? "")) invalid();
  return { birth: `${tid}:${values[19]}`, parent: values[1]! };
}
