import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readlinkSync, readSync, rmdirSync, writeSync, fsyncSync, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertHostedProcessDescriptors } from "./hosted-process-descriptors";
import { CodexProviderEgressProfileId, codexProviderEgressProfileEnvVar } from "../../codex-provider-egress-policy";
import { dirname, join } from "node:path";
import type { CodexAppServerChildProcess } from "../application/app-server-process-port";


const root = "/var/lib/subscription-runtime-host-policy";
const activeFences = new WeakSet<object>();
// Not a configurable policy root or a public arbitrary filesystem reader.
const recordName = /^(?:readonly-inventory\.json|host-installation\.json|host-activation\.(?:json|next)|ordinary-origins\.json|ordinary-origins\.next|readonly-(?:enrollment\.json|epoch\.(?:json|next|lock))|ordinary-origins\/[a-f0-9]{64}\.json|ordinary-(?:starts|completed)\/[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}\.json|codex-readonly-(?:custody|revoked)\/[a-f0-9]{64}\.json)$/;
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
  return readActivationPath(join(root, name));
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
  mkdirSync(lock, { mode: 0o700 });
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
export function readHostedOrdinaryProcessOrigin(fence: HostedActivationFence) {
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
  const reservation = starts.find(row => row.startId === match[1]);
  if (!reservation || reservation.state !== "reserved") invalid();
  const start = requiredWire(`ordinary-starts/${match[1]}.json`, startKeys).value;
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
  let profileId = CodexProviderEgressProfileId.ProviderApi;
  if (grantBytes) {
    const grant = wire(decodeHostedActivationBytes(grantBytes), "schemaVersion,jobId,jobRootDir,workspacePath,profileId");
    if (grant.schemaVersion !== 1 || grant.profileId !== CodexProviderEgressProfileId.TestNpmQualification) invalid();
    same(grant, start, "jobId,jobRootDir,workspacePath"); profileId = CodexProviderEgressProfileId.TestNpmQualification;
  }
  validateOrdinaryKernel(installation, activation, start);
  assertHostedProcessDescriptors();
  return { activation, start, reservation, profileId };
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
function validateOrdinaryKernel(installation: Wire, activation: Wire, start: Wire): void {
  const inventory = requiredWire("readonly-inventory.json", "schemaVersion,hostId,supervisorUnit,units,runtimeLaunch,ordinaryCreators,disabledCreators");
  if (inventory.value.schemaVersion !== 2 || inventory.value.hostId !== installation.hostId || sha256(inventory.bytes) !== installation.inventorySha256) invalid();
  const units = rows(inventory.value.units).map(value => {
    const row = wire(value, "name,controlGroup,fragmentSha256"); str(row.name, /^[A-Za-z0-9_@.-]+\.(service|scope)$/);
    if (str(row.name).startsWith("subscription-runtime-hosted-")) invalid();
    canonical(row.controlGroup); digestValue(row.fragmentSha256); return row;
  });
  if (!units.length || units.length > 128) invalid();
  distinct(units.map(row => row.name)); distinct(units.map(row => row.controlGroup));
  const disabled = rows(inventory.value.disabledCreators);
  if (disabled.length > 128) invalid(); distinct(disabled);
  for (const name of disabled) {
    if (str(name, /^[A-Za-z0-9_@.-]+\.(service|socket|timer)$/).length > 200 || units.some(row => row.name === name)) invalid();
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
    const row = wire(value, "creatorId,jobId,jobRootDir,workspacePath,launch");
    str(row.creatorId); str(row.jobId); canonical(row.jobRootDir); canonical(row.workspacePath);
    const launch = validateLaunch(row.launch);
    const cli = `${installation.runtimeDirectory}/dist/worker-codex/codex-goal-cli.js`;
    if (launch.cwd !== row.workspacePath || !(launch.command === cli || (launch.command === process.execPath && launch.args[0] === cli))) invalid();
    return row;
  });
  distinct(creators.map(row => row.creatorId));
  if (creators.length > 128) invalid();
  for (const left of creators) for (const right of creators) {
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
    if (value.Id !== name || value.DropInPaths !== "") invalid(); return value;
  };
  const supervisor = show(str(owner.name)), current = show(str(start.unit));
  const fragment = readActivationPath(canonical(supervisor.FragmentPath), false);
  if (supervisor.ControlGroup !== owner.controlGroup || !fragment || sha256(fragment) !== owner.fragmentSha256 ||
      current.ControlGroup !== start.controlGroup) invalid();
  str(current.MainPID, /^[1-9][0-9]*$/);
  if (readFileSync("/etc/machine-id", "utf8").trim() !== activation.hostId ||
      readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== activation.bootId ||
      pidBirth(str(supervisor.MainPID)) !== activation.supervisorId) invalid();
  const creatorPid = str(start.creatorPidBirth).split(":")[0]!;
  if (pidBirth(creatorPid) !== start.creatorPidBirth ||
      readFileSync(`/proc/${creatorPid}/cgroup`, "utf8").trim() !== `0::${owner.controlGroup}`) invalid();
}
function pidBirth(pid: string): string {
  str(pid, /^[1-9][0-9]{0,9}$/);
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  if (!stat.startsWith(pid + " (") || stat.lastIndexOf(") ") < 0) invalid();
  return pid + ":" + str(stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19], /^[1-9][0-9]{0,19}$/);
}

const failedOrdinaryWaits = new WeakSet<object>();
export function invalidateHostedOrdinaryWait(child: CodexAppServerChildProcess): void { failedOrdinaryWaits.add(child); }

/** Production default primitive calls this with its private synchronous spawn.
 * It never receives worker factory injection, mount options or a managed ticket. */
export function submitHostedOrdinaryProcess(input: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
  submit: (unit: string, identity: { readonly jobId: string; readonly workspacePath: string }) => CodexAppServerChildProcess): CodexAppServerChildProcess {
  return withHostedActivationFence(fence => {
    const { activation, start, profileId } = readHostedOrdinaryProcessOrigin(fence);
    const jobRoot = canonical(start.jobRootDir);
    const workspacePath = canonical(start.workspacePath);
    if (!jobRoot.endsWith(`/jobs/${str(start.jobId)}`) ||
        workspacePath !== `${jobRoot}/workspace`) invalid();
    // The real app-server client starts in its materialized account HOME;
    // workspace belongs to the thread, not the provider process. Neither cwd
    // nor HOME supplies origin authority: that was read from the actual cgroup.
    const cwd = canonical(input.cwd);
    if ((cwd !== start.workspacePath && cwd !== input.env.HOME) || input.env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== "hosted-codex-job" ||
        (input.env[codexProviderEgressProfileEnvVar] ?? CodexProviderEgressProfileId.ProviderApi) !== profileId) invalid();
    const starts = rows(activation.ordinaryStarts);
    if (starts.length >= 256) invalid();
    const startId = randomUUID(), unit = `subscription-runtime-hosted-${startId}.service`;
    const generation = positive(activation.generation) + 1; positive(generation);
    const reservation = { startId, unit, creatorId: start.creatorId, originSha256: start.originSha256, generation, state: "reserved" };
    const bytes = Buffer.from(JSON.stringify({ ...start, unit, controlGroup: unitGroup(unit), activationGeneration: generation,
      creatorPidBirth: pidBirth(String(process.pid)) }) + "\n");
    const next = { ...activation, generation, ordinaryStarts: [...starts, reservation] };
    publishOrdinaryActivation(fence, next);
    try {
      createActivationRecord(`ordinary-starts/${startId}.json`, bytes);
      const child = submit(unit, { jobId: str(start.jobId), workspacePath });
      child.on("error", () => invalidateHostedOrdinaryWait(child));
      child.stdin.on?.("error", () => invalidateHostedOrdinaryWait(child));
      child.on("exit", (code, signal) => {
        if (code !== 0 || signal !== null || failedOrdinaryWaits.has(child)) return;
        try {
          withHostedActivationFence(() => {
            const retained = readHostedActivationBytes(`ordinary-starts/${startId}.json`);
            const current = requiredWire("host-activation.json", activationKeys).value;
            const row = rows(current.ordinaryStarts).find(row => !!row && typeof row === "object" && "startId" in row && row.startId === startId);
            if (!retained?.equals(bytes) || JSON.stringify(row) !== JSON.stringify(reservation) ||
                current.installationId !== activation.installationId || current.bootId !== activation.bootId ||
                current.supervisorId !== activation.supervisorId) invalid();
            createActivationRecord(`ordinary-completed/${startId}.json`, Buffer.from(JSON.stringify({ schemaVersion: 1,
              startId, startSha256: sha256(bytes), waitStatus: 0 }) + "\n"));
          });
        } catch { invalidateHostedOrdinaryWait(child); } // Ambiguity retains the reservation; no synthetic completion.
      });
      return child;
    } catch (error) {
      publishOrdinaryActivation(fence, { ...next, generation: generation + 1, phase: "CLOSED" });
      throw error;
    }
  });
}
function createActivationRecord(name: string, bytes: Buffer): void {
  if (!recordName.test(name) || readHostedActivationBytes(name) !== null || bytes.length > 4 * 1024 * 1024) invalid();
  const path = join(root, name), fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset); if (count <= 0) invalid(); offset += count; }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncActivationDirectory(dirname(path));
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
  if (process.platform !== "linux") return false;
  if (env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND === "hosted-codex-job" ||
      /\/subscription-runtime-(?:ordinary|outer|hosted)-/.test(readFileSync("/proc/self/cgroup", "utf8"))) return true;
  try { lstatSync(root); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
