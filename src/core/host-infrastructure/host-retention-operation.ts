/**
 * Pure wire contract of the closed RETENTION OPERATOR role. The role is a DISCRIMINATOR of the existing admitted
 * installation supervisor operation: the funded installation packet (schemaVersion 3, see
 * `hosted-ordinary-installation-bootstrap.ts`) carries one closed retention request, and the retention work runs INSIDE the
 * admitted supervisor process after its existing proofs. No other process is admitted: the existing kernel
 * `operatorSession()` requires the caller to BE the V5 inventory supervisor (process birth equality), so an external
 * process always refuses and this module gives it no way around that. Parsing supplies DATA, never process ownership or
 * authority: the Host adapter binds these records to the admitted installation, the live boot, machine, runtime and
 * namespaces.
 *
 * Version contract. The V5 inventory and the installation packet schemaVersion 1/2 stay exactly as they were. The funded
 * installation packet schemaVersion 3 = schemaVersion 2 + `retention`; a retention RECORD packet is schemaVersion 3 with
 * `role: "retention_operator"` and its own record directory, so a hosted-creator packet can never parse as a retention
 * packet and vice versa. The role has no job, no origin and no enrollment: the historical job it retains is only an INPUT
 * named by a private permit. The inventory's creator row stays the pinned installation identity and is never launched.
 */
export const hostedRetentionOperationDirectory = "retention-operations";
export const hostedRetentionTool = "codex_goal_project_retain_nonqualified_attempt" as const;
export const hostedMemoryTopologyMountPoint = "/sys/fs/cgroup";
export enum HostedRetentionLaunchKind { InstallationSupervisor = "installation_supervisor", DockerTest = "docker_test" }

export type HostedRetentionFile = Readonly<{ path: string; sha256: string }>;
/** Identities and the fixed mapping only; never a memory, limit or headroom scalar. */
export type HostedMemoryTopologyIdentity = Readonly<{
  mountPoint: string;
  cgroupNamespace: Readonly<{ dev: string; ino: string }>;
  hierarchyRoot: Readonly<{ dev: string; ino: string }>;
}>;
export type HostedRetentionMount = Readonly<{ source: string; target: string; readonly: boolean }>;
export type HostedRetentionLaunch =
  | Readonly<{ kind: HostedRetentionLaunchKind.InstallationSupervisor }>
  | Readonly<{ kind: HostedRetentionLaunchKind.DockerTest; image: string; fixtureRoot: string; mounts: readonly HostedRetentionMount[] }>;
export type HostedRetentionInvocation = Readonly<{
  tool: typeof hostedRetentionTool; controllerJobId: string; workerJobId: string; permitFile: string;
  expectedPermitSha256: string; confirmRetention: boolean; expectedPlanSha256?: string; registryRootDir?: string;
}>;
export type HostedRetentionPacket = Readonly<{
  schemaVersion: 3; role: "retention_operator"; operationId: string; hostId: string; bootId: string;
  issuedEpochMs: number; workEndEpochMs: number; cleanupEndEpochMs: number; issuedMonotonicNs: string;
  node: HostedRetentionFile; bootstrap: HostedRetentionFile;
  runtimeDirectory: string; runtimeSha: string; runtimeManifestSha256: string;
  installationSha256: string; inventorySha256: string;
  launch: HostedRetentionLaunch; retention: HostedRetentionInvocation;
}>;
/** Written ONCE by the outside operator after it authenticated the installation and observed the live topology. */
export type HostedRetentionAdmittedSession = Readonly<{ hostId: string; bootId: string; supervisorId: string }>;
export type HostedRetentionFunded = Readonly<{
  schemaVersion: 3; role: "retention_operator"; operationId: string; packetSha256: string;
  /** The session the existing kernel operator admission returned when the outside operator funded this operation. */
  session: HostedRetentionAdmittedSession; memoryTopology: HostedMemoryTopologyIdentity;
}>;

function fail(): never { throw new Error("hosted_retention_operation_invalid"); }
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value) || !pattern.test(value)) fail();
  return value;
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const pathPattern = /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/;
function path(value: unknown): string {
  const result = text(value, pathPattern);
  if (result.split("/").some(part => part === "." || part === "..")) fail();
  return result;
}
function epoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail();
  return value as number;
}
function file(value: unknown): HostedRetentionFile {
  const row = object(value, "path,sha256");
  return Object.freeze({ path: path(row.path), sha256: text(row.sha256, digest) });
}
function identity(value: unknown): Readonly<{ dev: string; ino: string }> {
  const row = object(value, "dev,ino");
  return Object.freeze({ dev: text(row.dev, /^[0-9]{1,20}$/), ino: text(row.ino, /^[1-9][0-9]{0,19}$/) });
}
export function parseHostedMemoryTopologyIdentity(value: unknown): HostedMemoryTopologyIdentity {
  const row = object(value, "mountPoint,cgroupNamespace,hierarchyRoot");
  if (row.mountPoint !== hostedMemoryTopologyMountPoint) fail();
  return Object.freeze({ mountPoint: hostedMemoryTopologyMountPoint, cgroupNamespace: identity(row.cgroupNamespace), hierarchyRoot: identity(row.hierarchyRoot) });
}
function launchOf(value: unknown): HostedRetentionLaunch {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  if ((value as { kind?: unknown }).kind === HostedRetentionLaunchKind.InstallationSupervisor) {
    object(value, "kind"); return Object.freeze({ kind: HostedRetentionLaunchKind.InstallationSupervisor });
  }
  const row = object(value, "kind,image,fixtureRoot,mounts");
  if (row.kind !== HostedRetentionLaunchKind.DockerTest || !Array.isArray(row.mounts) || row.mounts.length > 32) fail();
  const mounts = row.mounts.map(raw => {
    const mount = object(raw, "source,target,readonly");
    if (typeof mount.readonly !== "boolean") fail();
    return Object.freeze({ source: path(mount.source), target: path(mount.target), readonly: mount.readonly });
  });
  if (new Set(mounts.map(m => m.target)).size !== mounts.length) fail();
  return Object.freeze({ kind: HostedRetentionLaunchKind.DockerTest, image: text(row.image, /^sha256:[a-f0-9]{64}$/), fixtureRoot: path(row.fixtureRoot), mounts: Object.freeze(mounts) });
}
function invocationOf(value: unknown): HostedRetentionInvocation {
  const optional = value && typeof value === "object"
    ? ["expectedPlanSha256", "registryRootDir"].filter(key => key in value) : [];
  const row = object(value, ["tool", "controllerJobId", "workerJobId", "permitFile", "expectedPermitSha256", "confirmRetention", ...optional].join(","));
  if (row.tool !== hostedRetentionTool || typeof row.confirmRetention !== "boolean") fail();
  return Object.freeze({ tool: hostedRetentionTool, controllerJobId: text(row.controllerJobId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/),
    workerJobId: text(row.workerJobId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/), permitFile: path(row.permitFile),
    expectedPermitSha256: text(row.expectedPermitSha256, digest), confirmRetention: row.confirmRetention,
    ...(row.expectedPlanSha256 === undefined ? {} : { expectedPlanSha256: text(row.expectedPlanSha256, digest) }),
    ...(row.registryRootDir === undefined ? {} : { registryRootDir: path(row.registryRootDir) }) });
}
export function parseHostedRetentionPacket(value: unknown): HostedRetentionPacket {
  const row = object(value, "schemaVersion,role,operationId,hostId,bootId,issuedEpochMs,workEndEpochMs,cleanupEndEpochMs,issuedMonotonicNs,node,bootstrap,runtimeDirectory,runtimeSha,runtimeManifestSha256,installationSha256,inventorySha256,launch,retention");
  if (row.schemaVersion !== 3 || row.role !== "retention_operator") fail();
  const issuedEpochMs = epoch(row.issuedEpochMs), workEndEpochMs = epoch(row.workEndEpochMs), cleanupEndEpochMs = epoch(row.cleanupEndEpochMs);
  if (issuedEpochMs >= workEndEpochMs || workEndEpochMs >= cleanupEndEpochMs) fail();
  return Object.freeze({ schemaVersion: 3, role: "retention_operator", operationId: text(row.operationId, uuid),
    hostId: text(row.hostId, /^[a-f0-9]{32}$/), bootId: text(row.bootId, uuid), issuedEpochMs, workEndEpochMs, cleanupEndEpochMs,
    issuedMonotonicNs: text(row.issuedMonotonicNs, /^[0-9]{1,30}$/), node: file(row.node), bootstrap: file(row.bootstrap),
    runtimeDirectory: path(row.runtimeDirectory), runtimeSha: text(row.runtimeSha, /^[a-f0-9]{40}$/),
    runtimeManifestSha256: text(row.runtimeManifestSha256, digest), installationSha256: text(row.installationSha256, digest),
    inventorySha256: text(row.inventorySha256, digest), launch: launchOf(row.launch), retention: invocationOf(row.retention) });
}
export function parseHostedRetentionFunded(value: unknown): HostedRetentionFunded {
  const row = object(value, "schemaVersion,role,operationId,packetSha256,session,memoryTopology");
  if (row.schemaVersion !== 3 || row.role !== "retention_operator") fail();
  const session = object(row.session, "hostId,bootId,supervisorId");
  return Object.freeze({ schemaVersion: 3, role: "retention_operator", operationId: text(row.operationId, uuid),
    packetSha256: text(row.packetSha256, digest),
    session: Object.freeze({ hostId: text(session.hostId, /^[a-f0-9]{32}$/), bootId: text(session.bootId, uuid),
      supervisorId: text(session.supervisorId, /^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/) }),
    memoryTopology: parseHostedMemoryTopologyIdentity(row.memoryTopology) });
}

/**
 * The closed retention request carried by the funded installation packet. It only DESCRIBES what to ask for; every
 * authority value (host, boot, runtime, installation hash, pins) is observed live inside the admitted supervisor and the
 * finite window is the installation operation's own work/cleanup window, never taken from here.
 */
export type HostedRetentionRequest = Readonly<{ launch: HostedRetentionLaunch; retention: HostedRetentionInvocation }>;
export function parseHostedRetentionRequest(value: unknown): HostedRetentionRequest {
  const row = object(value, "launch,retention");
  return Object.freeze({ launch: launchOf(row.launch), retention: invocationOf(row.retention) });
}

/** Exact container facts the outside operator observed AFTER start and before releasing the in-container supervisor. */
export type HostedRetentionContainerRecord = Readonly<{
  schemaVersion: 3; operationId: string; containerId: string; image: string; cgroup: string;
  startTicks: string; hostPid: number; mounts: readonly HostedRetentionMount[];
}>;
export function parseHostedRetentionContainerRecord(value: unknown): HostedRetentionContainerRecord {
  const row = object(value, "schemaVersion,operationId,containerId,image,cgroup,startTicks,hostPid,mounts");
  if (row.schemaVersion !== 3 || !Number.isSafeInteger(row.hostPid) || (row.hostPid as number) < 1 || !Array.isArray(row.mounts) || row.mounts.length > 32) fail();
  const mounts = row.mounts.map(raw => {
    const mount = object(raw, "source,target,readonly");
    if (typeof mount.readonly !== "boolean") fail();
    return Object.freeze({ source: path(mount.source), target: path(mount.target), readonly: mount.readonly });
  });
  return Object.freeze({ schemaVersion: 3, operationId: text(row.operationId, uuid), containerId: text(row.containerId, /^[a-f0-9]{64}$/),
    image: text(row.image, /^sha256:[a-f0-9]{64}$/), cgroup: path(row.cgroup), startTicks: text(row.startTicks, /^[1-9][0-9]{0,19}$/),
    hostPid: row.hostPid as number, mounts: Object.freeze(mounts) });
}

export type HostedRetentionRecord = "packet" | "funded" | "supervisor" | "result" | "closed" | "held" | "container" | "intent" | "created" | "cleanup";

/**
 * Custody records of the TEST container, written by the admitted supervisor BEFORE the step they announce, so an OUTSIDE
 * cleanup owner can act after the supervisor's death without discovering anything by name:
 * `intent` (before `docker create`: image and label of this operation), `created` (the exact container id returned by create,
 * before `docker start`). `cleanup` is the outside owner's terminal outcome. Absent `intent` means no container can exist;
 * `intent` without `created` is an UNCERTAIN creation (never started, never signalled, never blindly retried).
 */
export enum HostedRetentionCleanupOutcome {
  NoContainer = "no_container", AlreadyStopped = "already_stopped", Stopped = "stopped", CreateUncertain = "create_uncertain", CleanupUnproved = "cleanup_unproved",
}
export type HostedRetentionIntent = Readonly<{ schemaVersion: 3; operationId: string; image: string; label: string }>;
export function parseHostedRetentionIntent(value: unknown): HostedRetentionIntent {
  const row = object(value, "schemaVersion,operationId,image,label");
  if (row.schemaVersion !== 3) fail();
  return Object.freeze({ schemaVersion: 3, operationId: text(row.operationId, uuid), image: text(row.image, /^sha256:[a-f0-9]{64}$/), label: text(row.label, /^[a-z][a-z0-9.-]{0,127}$/) });
}
export type HostedRetentionCreated = Readonly<{ schemaVersion: 3; operationId: string; containerId: string }>;
export function parseHostedRetentionCreated(value: unknown): HostedRetentionCreated {
  const row = object(value, "schemaVersion,operationId,containerId");
  if (row.schemaVersion !== 3) fail();
  return Object.freeze({ schemaVersion: 3, operationId: text(row.operationId, uuid), containerId: text(row.containerId, /^[a-f0-9]{64}$/) });
}
export type HostedRetentionCleanup = Readonly<{ schemaVersion: 3; operationId: string; outcome: HostedRetentionCleanupOutcome; containerId: string | null }>;
export function parseHostedRetentionCleanup(value: unknown): HostedRetentionCleanup {
  const row = object(value, "schemaVersion,operationId,outcome,containerId");
  if (row.schemaVersion !== 3 || !Object.values(HostedRetentionCleanupOutcome).includes(row.outcome as HostedRetentionCleanupOutcome)) fail();
  return Object.freeze({ schemaVersion: 3, operationId: text(row.operationId, uuid), outcome: row.outcome as HostedRetentionCleanupOutcome,
    containerId: row.containerId === null ? null : text(row.containerId, /^[a-f0-9]{64}$/) });
}
/** Only these outcomes close the operation; the rest stay HELD with the container and every record left as evidence. */
export const hostedRetentionCleanupClosing: readonly HostedRetentionCleanupOutcome[] = Object.freeze([
  HostedRetentionCleanupOutcome.NoContainer, HostedRetentionCleanupOutcome.AlreadyStopped, HostedRetentionCleanupOutcome.Stopped]);
/** Relative record names under `retention-operations/`; the packet and funded record sit beside, the rest inside `<id>/`. */
export function hostedRetentionRecordName(operationId: string, record: HostedRetentionRecord): string {
  const id = text(operationId, uuid);
  return record === "packet" ? `${id}.json` : record === "funded" ? `${id}.funded.json` : `${id}/${record}.json`;
}
