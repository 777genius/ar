/** Provider-neutral safety state. Host adapters own locking, durable publication,
 * inventory, kernel observations and process creation. A parsed record is never
 * evidence that those effects happened. */
export enum HostedCustodyPhase {
  Closed = "closed",
  Ready = "ready",
}
export enum HostedCustodyReservationState {
  Reserved = "reserved",
  Terminal = "terminal",
}
export enum HostedCustodyRequirement {
  TestManagedQualification = "test_managed_qualification",
}
export type HostedCustodyIdentity = {
  readonly jobId: string;
  readonly jobRootDir: string;
  readonly workspacePath: string;
  readonly runtimeSha: string;
  readonly runtimeManifestSha256: string;
  readonly issuerDeploymentDigest: string;
  readonly policySha256: string;
  readonly reviewSha256: string;
  readonly stageSha256: string;
  readonly grantSha256: string;
};
export type HostedCustodyReservation = {
  readonly startId: string;
  readonly unit: string;
  readonly creatorId: string;
  readonly state: HostedCustodyReservationState;
};
export type HostedCustodyOuterRuntime = HostedCustodyReservation & { readonly generation: number };
export type HostedCustodyEpoch = {
  readonly schemaVersion: 1;
  readonly hostId: string;
  readonly bootId: string;
  readonly supervisorId: string;
  readonly generation: number;
  readonly requirement: HostedCustodyRequirement.TestManagedQualification;
  readonly identity: HostedCustodyIdentity;
  readonly phase: HostedCustodyPhase;
  readonly revoked: boolean;
  readonly reservations: readonly HostedCustodyReservation[];
  readonly outerRuntime: HostedCustodyOuterRuntime | null;
};

const identityKeys = "grantSha256,issuerDeploymentDigest,jobId,jobRootDir,policySha256,reviewSha256,runtimeManifestSha256,runtimeSha,stageSha256,workspacePath";
const epochKeys = "bootId,generation,hostId,identity,outerRuntime,phase,requirement,reservations,revoked,schemaVersion,supervisorId";
function closed(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function path(value: unknown): value is string {
  return text(value, 4096) && /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(value) &&
    !value.split("/").some(part => part === "." || part === "..");
}
export function parseHostedCustodyIdentity(value: unknown): HostedCustodyIdentity {
  const input = closed(value, identityKeys);
  if (!text(input.jobId) || !path(input.jobRootDir) || !path(input.workspacePath)) invalid();
  for (const key of identityKeys.split(",").filter(key => !["jobId", "jobRootDir", "workspacePath"].includes(key))) {
    if (typeof input[key] !== "string" || !(key === "runtimeSha" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(input[key])) invalid();
  }
  return Object.freeze({ ...input }) as HostedCustodyIdentity;
}
export function parseHostedCustodyEpoch(value: unknown): HostedCustodyEpoch {
  const input = closed(value, epochKeys);
  if (input.schemaVersion !== 1 || input.requirement !== HostedCustodyRequirement.TestManagedQualification ||
      !text(input.hostId) || !text(input.bootId) ||
      !text(input.supervisorId) || !Number.isSafeInteger(input.generation) ||
      (input.generation as number) < 1 || typeof input.revoked !== "boolean" ||
      !Object.values(HostedCustodyPhase).includes(input.phase as HostedCustodyPhase) ||
      !Array.isArray(input.reservations) || input.reservations.length > 256) invalid();
  if (input.revoked && input.phase !== HostedCustodyPhase.Closed) invalid();
  const reservations = input.reservations.map(value => {
    const record = closed(value, "creatorId,startId,state,unit");
    if (!text(record.startId) || !text(record.creatorId) || !text(record.unit) ||
        !Object.values(HostedCustodyReservationState).includes(record.state as HostedCustodyReservationState)) invalid();
    return Object.freeze({ ...record }) as HostedCustodyReservation;
  });
  if (new Set(reservations.map(record => record.startId)).size !== reservations.length ||
      new Set(reservations.map(record => record.unit)).size !== reservations.length) invalid();
  if (reservations.filter(record => record.state === HostedCustodyReservationState.Reserved).length > 1) invalid();
  let outerRuntime: HostedCustodyOuterRuntime | null = null;
  if (input.outerRuntime !== null) {
    const record = closed(input.outerRuntime, "creatorId,generation,startId,state,unit");
    if (!text(record.startId) || !text(record.creatorId) || !text(record.unit) ||
        !Object.values(HostedCustodyReservationState).includes(record.state as HostedCustodyReservationState) ||
        !Number.isSafeInteger(record.generation) || (record.generation as number) < 1 ||
        (record.generation as number) > (input.generation as number) ||
        reservations.some(item => item.unit === record.unit || item.startId === record.startId)) invalid();
    outerRuntime = Object.freeze({ ...record }) as HostedCustodyOuterRuntime;
  }
  return Object.freeze({ ...input, outerRuntime, identity: parseHostedCustodyIdentity(input.identity),
    reservations: Object.freeze(reservations) }) as HostedCustodyEpoch;
}
export function assertHostedCustodyIdentity(actual: HostedCustodyIdentity, expected: HostedCustodyIdentity): void {
  const left = parseHostedCustodyIdentity(actual), right = parseHostedCustodyIdentity(expected);
  if (identityKeys.split(",").some(key => left[key as keyof HostedCustodyIdentity] !== right[key as keyof HostedCustodyIdentity])) {
    throw new Error("hosted_custody_identity_mismatch");
  }
}
export function closeHostedCustodyEpoch(epoch: HostedCustodyEpoch, revoke = false): HostedCustodyEpoch {
  return parseHostedCustodyEpoch({ ...epoch, phase: HostedCustodyPhase.Closed, revoked: epoch.revoked || revoke });
}
export function assertHostedCustodySession(epoch: HostedCustodyEpoch, session: {
  readonly hostId: string; readonly bootId: string; readonly supervisorId: string;
}): void {
  if (epoch.hostId !== session.hostId || epoch.bootId !== session.bootId || epoch.supervisorId !== session.supervisorId) {
    throw new Error("hosted_custody_recovery_required");
  }
}

/** Called only after the application has obtained fresh port evidence while the
 * common host fence is CLOSED and held. No user-supplied readiness flag exists. */
export function readyHostedCustodyEpoch(epoch: HostedCustodyEpoch, session: {
  readonly hostId: string; readonly bootId: string; readonly supervisorId: string;
}): HostedCustodyEpoch {
  if (epoch.hostId !== session.hostId || epoch.revoked || epoch.phase !== HostedCustodyPhase.Closed ||
      (epoch.outerRuntime !== null && epoch.outerRuntime.state !== HostedCustodyReservationState.Terminal) ||
      epoch.reservations.some(record => record.state !== HostedCustodyReservationState.Terminal)) {
    throw new Error("hosted_custody_recovery_required");
  }
  return parseHostedCustodyEpoch({ ...epoch, ...session, phase: HostedCustodyPhase.Ready });
}
export function reserveHostedCustodyStart(epoch: HostedCustodyEpoch, identity: HostedCustodyIdentity,
  reservation: Omit<HostedCustodyReservation, "state">): HostedCustodyEpoch {
  assertHostedCustodyIdentity(epoch.identity, identity);
  if (epoch.phase !== HostedCustodyPhase.Ready || epoch.revoked ||
      epoch.reservations.some(record => record.state !== HostedCustodyReservationState.Terminal)) {
    throw new Error("hosted_custody_start_denied");
  }
  return parseHostedCustodyEpoch({ ...epoch, reservations: [...epoch.reservations,
    { ...reservation, state: HostedCustodyReservationState.Reserved }] });
}
export function terminalHostedCustodyStart(epoch: HostedCustodyEpoch, startId: string): HostedCustodyEpoch {
  if (!epoch.reservations.some(record => record.startId === startId)) throw new Error("hosted_custody_unknown_start");
  return parseHostedCustodyEpoch({ ...epoch, reservations: epoch.reservations.map(record =>
    record.startId === startId ? { ...record, state: HostedCustodyReservationState.Terminal } : record) });
}
/** One trusted outer runtime per generation. A recovered next generation may
 * replace only a terminal outer record; exit alone never makes it terminal. */
export function reserveHostedOuterRuntime(epoch: HostedCustodyEpoch,
  reservation: Omit<HostedCustodyReservation, "state">): HostedCustodyEpoch {
  if (epoch.phase !== HostedCustodyPhase.Ready || epoch.revoked ||
      epoch.reservations.some(item => item.state !== HostedCustodyReservationState.Terminal) ||
      (epoch.outerRuntime !== null && (epoch.outerRuntime.state !== HostedCustodyReservationState.Terminal ||
        epoch.outerRuntime.generation >= epoch.generation))) throw new Error("hosted_custody_outer_runtime_held");
  return parseHostedCustodyEpoch({ ...epoch, outerRuntime: { ...reservation, generation: epoch.generation,
    state: HostedCustodyReservationState.Reserved } });
}
export function terminalHostedOuterRuntime(epoch: HostedCustodyEpoch, startId: string): HostedCustodyEpoch {
  if (epoch.outerRuntime?.startId !== startId) throw new Error("hosted_custody_unknown_outer_runtime");
  return parseHostedCustodyEpoch({ ...epoch, outerRuntime: { ...epoch.outerRuntime, state: HostedCustodyReservationState.Terminal } });
}
function invalid(): never { throw new Error("hosted_custody_epoch_invalid"); }
