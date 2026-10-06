import type { DependencyWorkspaceIdentity } from "./dependency-workspace";
import { DependencyConsumerLaunchKind, isDependencyCustodyObject, isDependencyProtectedReference, sameDependencyProtectedReference,
  type DependencyProtectedReference } from "./dependency-custody-evidence";

import { parseDependencyGenerationContinuityInvalidation, type DependencyGenerationContinuityInvalidation } from "./dependency-generation-continuity";

export enum DependencyOwnerPhase {
  ExclusiveMutation = "exclusive_mutation",
  Running = "running",
  Fenced = "fenced",
}
export enum DependencyOwnerKind { Consumer = "consumer", Maintenance = "maintenance" }

/** Facts resolved from the private retained launch, never request JSON. */
export type DependencyOrdinaryLaunchBinding = {
  readonly installationId: string;
  readonly bootId: string;
  readonly runtimeSha: string;
  readonly grantDigest: string;
  readonly startId: string;
  readonly unit: string;
};
export type DependencyCustodyLaunchBinding = DependencyOrdinaryLaunchBinding & {
  readonly kind: DependencyConsumerLaunchKind;
  readonly association: DependencyProtectedReference; readonly origin: DependencyProtectedReference;
};
export type DependencyLaunchBinding = DependencyOrdinaryLaunchBinding | DependencyCustodyLaunchBinding;
export function isDependencyCustodyLaunch(launch: DependencyLaunchBinding): launch is DependencyCustodyLaunchBinding {
  return "kind" in launch;
}
export type DependencyAttempt = {
  readonly attemptId: string;
  readonly epoch: number;
  readonly launch: DependencyLaunchBinding;
};
export type DependencyMaintenanceAttempt = {
  readonly operationId: string; readonly epoch: number;
  readonly host: { readonly installationId: string; readonly bootId: string; readonly runtimeSha: string;
    readonly inventoryDigest: string; readonly grantDigest: string; readonly supervisorId: string };
};
export type DependencyConsumerOwner = { readonly kind?: DependencyOwnerKind.Consumer;
  readonly phase: DependencyOwnerPhase; readonly attempt: DependencyAttempt };
export type DependencyMaintenanceOwner = { readonly kind: DependencyOwnerKind.Maintenance;
  readonly phase: DependencyOwnerPhase.ExclusiveMutation | DependencyOwnerPhase.Fenced; readonly attempt: DependencyMaintenanceAttempt };
type DependencyOwnerFields = {
  readonly workspace: DependencyWorkspaceIdentity;
  readonly revision: number;
  readonly epoch: number;
  readonly owner: null | DependencyConsumerOwner | DependencyMaintenanceOwner;
  // Protected transition facts for ranking only, never TTL/drain authority.
  readonly activity?: {
    readonly lastEntry: { readonly epoch: number; readonly atMs: string | null } | null;
    readonly lastRelease: { readonly epoch: number; readonly atMs: string | null } | null;
  };
};
export type DependencyOwnerRecord = DependencyOwnerFields & (
  { readonly version: 1 | 2 } | { readonly version: 3; readonly custodyBinding: DependencyProtectedReference;
    readonly generationContinuity?: DependencyGenerationContinuityInvalidation }
);

export enum DependencyAdmissionFailure {
  Busy = "busy",
  StaleAttempt = "stale_attempt",
  InvalidRecord = "invalid_record",
  WorkspaceChanged = "workspace_changed",
  NeedsInstall = "needs_install",
  Unsupported = "unsupported",
  UnsafeTree = "unsafe_tree",
}
export class DependencyAdmissionError extends Error {
  constructor(readonly reason: DependencyAdmissionFailure) { super(`dependency_admission:${reason}`); }
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const object = (v: unknown, keys: string): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).sort().join(",") === keys;
export function parseDependencyOwner(value: unknown): DependencyOwnerRecord {
  function invalid(): never { throw new DependencyAdmissionError(DependencyAdmissionFailure.InvalidRecord); }
  const hasActivity = typeof value === "object" && value !== null && Object.hasOwn(value, "activity");
  const versionDescriptor = typeof value === "object" && value !== null ? Object.getOwnPropertyDescriptor(value, "version") : undefined;
  if (versionDescriptor && !Object.hasOwn(versionDescriptor, "value")) invalid();
  const custody = versionDescriptor?.value === 3;
  const hasContinuity = custody && typeof value === "object" && value !== null && Object.hasOwn(value, "generationContinuity");
  const keys = (hasActivity ? "activity," : "") + (custody ? "custodyBinding," : "") +
    "epoch," + (hasContinuity ? "generationContinuity," : "") + "owner,revision,version,workspace";
  if (!object(value, keys) || (custody && !isDependencyCustodyObject(value, keys)) ||
      ("activity" in value && !hasActivity) || (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
      !positive(value.revision) || !positive(value.epoch)) invalid();
  if (custody && !isDependencyProtectedReference(value.custodyBinding)) invalid();
  if (hasContinuity) {
    try { parseDependencyGenerationContinuityInvalidation(value.generationContinuity); } catch { invalid(); }
  }
  if (hasActivity) {
    const activity = value.activity, epoch = value.epoch;
    const closed = (v: unknown, keys: string): v is Record<string, unknown> =>
      object(v, keys) && Reflect.ownKeys(v).length === keys.split(",").length && (!custody || isDependencyCustodyObject(v, keys));
    const event = (v: unknown): v is { epoch: number; atMs: string | null } =>
      closed(v, "atMs,epoch") && positive(v.epoch) && v.epoch <= epoch &&
      (v.atMs === null || (typeof v.atMs === "string" && /^(?:0|[1-9][0-9]{0,127})$/.test(v.atMs)));
    if ((value.version !== 2 && value.version !== 3) || !closed(activity, "lastEntry,lastRelease") ||
        (activity.lastEntry !== null && !event(activity.lastEntry)) ||
        (activity.lastRelease !== null && !event(activity.lastRelease))) invalid();
    if (custody && ((activity.lastEntry !== null && !isDependencyCustodyObject(activity.lastEntry, "atMs,epoch")) ||
        (activity.lastRelease !== null && !isDependencyCustodyObject(activity.lastRelease, "atMs,epoch")))) invalid();
    if (activity.lastRelease !== null && (activity.lastEntry === null ||
        activity.lastRelease.epoch > activity.lastEntry.epoch)) invalid();
  }
  if (custody && (!isDependencyCustodyObject(value.workspace, "canonicalPath,dev,ino") ||
      (hasActivity && !isDependencyCustodyObject(value.activity, "lastEntry,lastRelease")))) invalid();
  const workspace = value.workspace;
  if (!object(workspace, "canonicalPath,dev,ino") || typeof workspace.canonicalPath !== "string" ||
      workspace.canonicalPath.length > 4096 || !workspace.canonicalPath.startsWith("/") || workspace.canonicalPath === "/" ||
      workspace.canonicalPath.includes("\0") || workspace.canonicalPath.split("/").slice(1).some(p => !p || p === "." || p === "..") ||
      typeof workspace.dev !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(workspace.dev) ||
      typeof workspace.ino !== "string" || !/^[1-9][0-9]{0,19}$/.test(workspace.ino)) invalid();
  if (value.owner !== null) {
    const owner = value.owner;
    if (!object(owner, value.version === 1 ? "attempt,phase" : "attempt,kind,phase") ||
        (custody && !isDependencyCustodyObject(owner, "attempt,kind,phase")) || !Object.values(DependencyOwnerPhase).includes(owner.phase as DependencyOwnerPhase)) invalid();
    const attempt = owner.attempt;
    if ((value.version === 2 || value.version === 3) && owner.kind === DependencyOwnerKind.Maintenance) {
      if (owner.phase === DependencyOwnerPhase.Running || !object(attempt, "epoch,host,operationId") ||
          (custody && !isDependencyCustodyObject(attempt, "epoch,host,operationId")) ||
          typeof attempt.operationId !== "string" || !uuid.test(attempt.operationId) || attempt.epoch !== value.epoch) invalid();
      const host = attempt.host;
      if (custody && !isDependencyCustodyObject(host, "bootId,grantDigest,installationId,inventoryDigest,runtimeSha,supervisorId")) invalid();
      if (!object(host, "bootId,grantDigest,installationId,inventoryDigest,runtimeSha,supervisorId") ||
          ![host.installationId, host.bootId].every(v => typeof v === "string" && uuid.test(v)) ||
          typeof host.runtimeSha !== "string" || !/^[a-f0-9]{40}$/.test(host.runtimeSha) ||
          ![host.inventoryDigest, host.grantDigest].every(v => typeof v === "string" && digest.test(v)) ||
          typeof host.supervisorId !== "string" || !/^[1-9][0-9]{0,19}:[0-9]{1,20}$/.test(host.supervisorId)) invalid();
    } else {
      if ((value.version === 2 || value.version === 3) && owner.kind !== DependencyOwnerKind.Consumer) invalid();
      if (!object(attempt, "attemptId,epoch,launch") || (custody && !isDependencyCustodyObject(attempt, "attemptId,epoch,launch")) ||
          typeof attempt.attemptId !== "string" ||
          !uuid.test(attempt.attemptId) || attempt.epoch !== value.epoch) invalid();
      const launch = attempt.launch;
      const launchKeys = custody ? "association,bootId,grantDigest,installationId,kind,origin,runtimeSha,startId,unit" :
        "bootId,grantDigest,installationId,runtimeSha,startId,unit";
      if (!object(launch, launchKeys) || (custody && !isDependencyCustodyObject(launch, launchKeys)) ||
          ![launch.installationId, launch.bootId, launch.startId].every(v => typeof v === "string" && uuid.test(v)) ||
          typeof launch.runtimeSha !== "string" || !/^[a-f0-9]{40}$/.test(launch.runtimeSha) ||
          typeof launch.grantDigest !== "string" || !digest.test(launch.grantDigest)) invalid();
      if (custody) {
        if (!isDependencyProtectedReference(launch.association) || !isDependencyProtectedReference(launch.origin) ||
            !isDependencyProtectedReference(value.custodyBinding)) invalid();
        if (launch.kind === DependencyConsumerLaunchKind.ManagedReadonlyLocalV1) {
          if (launch.unit !== `subscription-runtime-outer-${launch.startId}.service` ||
              !sameDependencyProtectedReference(launch.association, value.custodyBinding)) invalid();
        } else if (launch.kind === DependencyConsumerLaunchKind.OrdinaryReadonlySuccessorV1) {
          if (launch.unit !== `subscription-runtime-ordinary-${launch.startId}.service` ||
              sameDependencyProtectedReference(launch.association, value.custodyBinding)) invalid();
        } else invalid();
      } else if (launch.unit !== `subscription-runtime-ordinary-${launch.startId}.service`) invalid();
    }
  }
  // Roundtrip detaches caller-owned nested values before protected persistence.
  const bytes = JSON.stringify(value);
  if (custody && new TextEncoder().encode(bytes).length > 16384) invalid();
  return JSON.parse(bytes) as DependencyOwnerRecord;
}

/** Legacy consumer is recognized for authenticated release only. Admission
 * additionally requires v2; this guard never upgrades an active v1 owner. */
export function isDependencyConsumerOwner(owner: DependencyOwnerRecord["owner"]): owner is DependencyConsumerOwner {
  return owner !== null && owner.kind !== DependencyOwnerKind.Maintenance;
}
export function sameDependencyMaintenanceAttempt(a: DependencyMaintenanceAttempt, b: DependencyMaintenanceAttempt): boolean {
  return a.operationId === b.operationId && a.epoch === b.epoch && a.host.installationId === b.host.installationId &&
    a.host.bootId === b.host.bootId && a.host.runtimeSha === b.host.runtimeSha && a.host.inventoryDigest === b.host.inventoryDigest &&
    a.host.grantDigest === b.host.grantDigest && a.host.supervisorId === b.host.supervisorId;
}
export function sameDependencyOwnerIdentity(a: NonNullable<DependencyOwnerRecord["owner"]>, b: NonNullable<DependencyOwnerRecord["owner"]>): boolean {
  if (a.kind === DependencyOwnerKind.Maintenance) return b.kind === DependencyOwnerKind.Maintenance && sameDependencyMaintenanceAttempt(a.attempt, b.attempt);
  return isDependencyConsumerOwner(b) && sameDependencyAttempt(a.attempt, b.attempt);
}

export function sameDependencyAttempt(a: DependencyAttempt, b: DependencyAttempt): boolean {
  return a.epoch === b.epoch && a.attemptId === b.attemptId &&
    a.launch.installationId === b.launch.installationId && a.launch.bootId === b.launch.bootId &&
    a.launch.runtimeSha === b.launch.runtimeSha && a.launch.grantDigest === b.launch.grantDigest &&
    a.launch.startId === b.launch.startId && a.launch.unit === b.launch.unit && sameLaunchCustody(a.launch, b.launch);
}
function sameLaunchCustody(a: DependencyLaunchBinding, b: DependencyLaunchBinding): boolean {
  if (!isDependencyCustodyLaunch(a)) return !isDependencyCustodyLaunch(b);
  return isDependencyCustodyLaunch(b) && a.kind === b.kind &&
    sameDependencyProtectedReference(a.association, b.association) && sameDependencyProtectedReference(a.origin, b.origin);
}
