import type { DependencyWorkspaceIdentity } from "./dependency-receipt";

export enum DependencyOwnerPhase {
  ExclusiveMutation = "exclusive_mutation",
  Running = "running",
  Fenced = "fenced",
}

/** Facts resolved from the private retained launch, never request JSON. */
export type DependencyLaunchBinding = {
  readonly installationId: string;
  readonly bootId: string;
  readonly runtimeSha: string;
  readonly grantDigest: string;
  readonly startId: string;
  readonly unit: string;
};
export type DependencyAttempt = {
  readonly attemptId: string;
  readonly epoch: number;
  readonly launch: DependencyLaunchBinding;
};
export type DependencyOwnerRecord = {
  readonly version: 1;
  readonly workspace: DependencyWorkspaceIdentity;
  readonly revision: number;
  readonly epoch: number;
  readonly owner: null | { readonly phase: DependencyOwnerPhase; readonly attempt: DependencyAttempt };
};

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
  const invalid = (): never => { throw new DependencyAdmissionError(DependencyAdmissionFailure.InvalidRecord); };
  if (!object(value, "epoch,owner,revision,version,workspace") || value.version !== 1 ||
      !positive(value.revision) || !positive(value.epoch)) invalid();
  const workspace = value.workspace;
  if (!object(workspace, "canonicalPath,dev,ino") || typeof workspace.canonicalPath !== "string" ||
      workspace.canonicalPath.length > 4096 || !workspace.canonicalPath.startsWith("/") || workspace.canonicalPath === "/" ||
      workspace.canonicalPath.includes("\0") || workspace.canonicalPath.split("/").slice(1).some(p => !p || p === "." || p === "..") ||
      typeof workspace.dev !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(workspace.dev) ||
      typeof workspace.ino !== "string" || !/^[1-9][0-9]{0,19}$/.test(workspace.ino)) invalid();
  if (value.owner !== null) {
    const owner = value.owner;
    if (!object(owner, "attempt,phase") || !Object.values(DependencyOwnerPhase).includes(owner.phase as DependencyOwnerPhase)) invalid();
    const attempt = owner.attempt;
    if (!object(attempt, "attemptId,epoch,launch") || typeof attempt.attemptId !== "string" ||
        !uuid.test(attempt.attemptId) || attempt.epoch !== value.epoch) invalid();
    const launch = attempt.launch;
    if (!object(launch, "bootId,grantDigest,installationId,runtimeSha,startId,unit") ||
        ![launch.installationId, launch.bootId, launch.startId].every(v => typeof v === "string" && uuid.test(v)) ||
        typeof launch.runtimeSha !== "string" || !/^[a-f0-9]{40}$/.test(launch.runtimeSha) ||
        typeof launch.grantDigest !== "string" || !digest.test(launch.grantDigest) ||
        launch.unit !== `subscription-runtime-ordinary-${launch.startId}.service`) invalid();
  }
  // Roundtrip detaches caller-owned nested values before protected persistence.
  return JSON.parse(JSON.stringify(value)) as DependencyOwnerRecord;
}

export function sameDependencyAttempt(a: DependencyAttempt, b: DependencyAttempt): boolean {
  return a.epoch === b.epoch && a.attemptId === b.attemptId &&
    a.launch.installationId === b.launch.installationId && a.launch.bootId === b.launch.bootId &&
    a.launch.runtimeSha === b.launch.runtimeSha && a.launch.grantDigest === b.launch.grantDigest &&
    a.launch.startId === b.launch.startId && a.launch.unit === b.launch.unit;
}
