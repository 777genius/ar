export { parseHostedInstallation, type HostedInstallation } from "../../../core/host-infrastructure/hosted-installation";
import { assertOrdinaryReaderFinalSuccessor } from "./ordinary-reader-final-successor";
import { parseScopedReceipt, parseScopedProviderOnlyReceipt, parseScopedOrdinaryReaderFinalReceipt, type ScopedOrdinaryReaderFinalReceipt, type ScopedTerminationReceipt, type ScopedProviderOnlyReceipt } from "./scoped-termination";
/** Closed scheduling records, not proof of host authority. Adapters must bind
 * inspected bytes and independent creator/queue/descendant observations under
 * the common host mutex before publishing these transitions. */
import { HostedCustodyReservationState } from "./hosted-custody-epoch";

export enum HostedActivationPhase {
  Closed = "CLOSED",
  Ordinary = "ORDINARY",
  EnteringExclusive = "ENTERING_EXCLUSIVE",
  Exclusive = "EXCLUSIVE",
  LeavingExclusive = "LEAVING_EXCLUSIVE",
}
export enum HostedOriginKind { Ordinary = "ordinary" }
export type HostedOrdinaryBirth = {
  readonly schemaVersion: 1; readonly installationId: string; readonly jobId: string;
  readonly jobRootDir: string; readonly workspacePath: string; readonly origin: HostedOriginKind.Ordinary;
};
export type HostedOrdinaryOrigins = {
  readonly schemaVersion: 1; readonly installationId: string; readonly revision: number;
  readonly origins: readonly { readonly jobId: string; readonly jobRootDir: string;
    readonly workspacePath: string; readonly birthSha256: string }[];
};
export type HostedOrdinaryReservation = {
  readonly startId: string; readonly unit: string; readonly creatorId: string;
  readonly originSha256: string; readonly generation: number; readonly state: HostedCustodyReservationState;
};
export type HostedActivation = {
  readonly schemaVersion: 1; readonly installationId: string; readonly hostId: string;
  readonly bootId: string; readonly supervisorId: string; readonly generation: number;
  readonly phase: HostedActivationPhase; readonly ordinaryOriginsSha256: string;
  readonly exclusiveEnrollmentSha256: string | null;
  readonly ordinaryStarts: readonly HostedOrdinaryReservation[];
};
export type HostedOrdinaryStart = Omit<HostedOrdinaryBirth, "origin"> & {
  readonly activationGeneration: number; readonly bootId: string; readonly supervisorId: string;
  readonly originSha256: string; readonly unit: string; readonly controlGroup: string;
  readonly creatorId: string; readonly creatorPidBirth: string; readonly grantSha256: string | null;
};

function invalid(): never { throw new Error("hosted_activation_invalid"); }
function record(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/.test(value);
}
function path(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 &&
    /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(value) &&
    !value.split("/").some(part => part === "." || part === "..");
}
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function generation(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function base(input: Record<string, unknown>): void {
  if (input.schemaVersion !== 1 || !id(input.installationId)) invalid();
}
function job(input: Record<string, unknown>): void {
  base(input);
  if (!id(input.jobId) || !path(input.jobRootDir) || !path(input.workspacePath)) invalid();
}
function unique(rows: readonly Record<string, unknown>[], keys: readonly string[]): void {
  for (const key of keys) if (new Set(rows.map(row => row[key])).size !== rows.length) invalid();
}
export function parseHostedOrdinaryBirth(value: unknown): HostedOrdinaryBirth {
  const input = record(value, "schemaVersion,installationId,jobId,jobRootDir,workspacePath,origin");
  job(input);
  if (input.origin !== HostedOriginKind.Ordinary) invalid();
  return Object.freeze({ ...input }) as HostedOrdinaryBirth;
}
export function parseHostedOrdinaryOrigins(value: unknown): HostedOrdinaryOrigins {
  const input = record(value, "schemaVersion,installationId,revision,origins");
  base(input);
  if (!generation(input.revision) || !Array.isArray(input.origins) || input.origins.length > 256) invalid();
  const origins = input.origins.map(value => {
    const row = record(value, "jobId,jobRootDir,workspacePath,birthSha256");
    job({ ...row, schemaVersion: 1, installationId: input.installationId });
    if (!digest(row.birthSha256)) invalid();
    return Object.freeze({ ...row });
  });
  unique(origins, ["jobId", "jobRootDir", "workspacePath", "birthSha256"]);
  return Object.freeze({ ...input, origins: Object.freeze(origins) }) as HostedOrdinaryOrigins;
}
export function parseHostedOrdinaryStart(value: unknown): HostedOrdinaryStart {
  const input = record(value, "schemaVersion,installationId,jobId,jobRootDir,workspacePath,activationGeneration,bootId,supervisorId,originSha256,unit,controlGroup,creatorId,creatorPidBirth,grantSha256");
  job(input);
  if (!generation(input.activationGeneration) || !id(input.bootId) || !id(input.supervisorId) ||
      !digest(input.originSha256) || !id(input.unit) || !input.unit.endsWith(".service") ||
      !path(input.controlGroup) || !id(input.creatorId) || typeof input.creatorPidBirth !== "string" ||
      !/^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/.test(input.creatorPidBirth) ||
      (input.grantSha256 !== null && !digest(input.grantSha256))) invalid();
  return Object.freeze({ ...input }) as HostedOrdinaryStart;
}
export function parseHostedActivation(value: unknown): HostedActivation {
  const input = record(value, "schemaVersion,installationId,hostId,bootId,supervisorId,generation,phase,ordinaryOriginsSha256,exclusiveEnrollmentSha256,ordinaryStarts");
  base(input);
  if (!id(input.hostId) || !id(input.bootId) || !id(input.supervisorId) || !generation(input.generation) ||
      !Object.values(HostedActivationPhase).includes(input.phase as HostedActivationPhase) ||
      !digest(input.ordinaryOriginsSha256) || (input.exclusiveEnrollmentSha256 !== null && !digest(input.exclusiveEnrollmentSha256)) ||
      !Array.isArray(input.ordinaryStarts) || input.ordinaryStarts.length > 256) invalid();
  const ordinaryStarts = input.ordinaryStarts.map(value => {
    const row = record(value, "startId,unit,creatorId,originSha256,generation,state");
    if (!id(row.startId) || !id(row.unit) || !row.unit.endsWith(".service") || !id(row.creatorId) ||
        !digest(row.originSha256) || !generation(row.generation) || row.generation > (input.generation as number) ||
        !Object.values(HostedCustodyReservationState).includes(row.state as HostedCustodyReservationState)) invalid();
    return Object.freeze({ ...row }) as HostedOrdinaryReservation;
  });
  unique(ordinaryStarts, ["startId", "unit"]);
  if (input.phase === HostedActivationPhase.Exclusive && (input.exclusiveEnrollmentSha256 === null ||
      ordinaryStarts.some(row => row.state !== HostedCustodyReservationState.Terminal))) invalid();
  return Object.freeze({ ...input, ordinaryStarts: Object.freeze(ordinaryStarts) }) as HostedActivation;
}

/** Structural publication guard only. Positive OS evidence remains mandatory.
 * Each mutation advances exactly once; crash recovery may publish only that
 * retained immediate successor, never reconstruct or discard reservations. */
export function assertHostedActivationSuccessor(before: HostedActivation, after: HostedActivation, evidence?: ScopedTerminationReceipt | ScopedProviderOnlyReceipt | ScopedOrdinaryReaderFinalReceipt): void {
  const prior = parseHostedActivation(before), next = parseHostedActivation(after);
  if (prior.installationId !== next.installationId || prior.hostId !== next.hostId ||
      next.generation !== prior.generation + 1 ||
      (prior.exclusiveEnrollmentSha256 !== null && prior.exclusiveEnrollmentSha256 !== next.exclusiveEnrollmentSha256)) invalid();
  if (evidence!==undefined && (!evidence || evidence.schemaVersion!==1 && evidence.schemaVersion!==2 && evidence.schemaVersion!==3)) invalid();
  const providerReceipt=evidence?.schemaVersion===2 ? parseScopedProviderOnlyReceipt(evidence):null;
  const finalReaderReceipt=evidence?.schemaVersion===3 ? parseScopedOrdinaryReaderFinalReceipt(evidence):null;
  if (finalReaderReceipt) assertOrdinaryReaderFinalSuccessor(prior,next,finalReaderReceipt);
  const receipt = evidence?.schemaVersion===1 ? parseScopedReceipt(evidence) : null;
  if (providerReceipt) {
    const identity=providerReceipt.identity,parent=prior.ordinaryStarts.find(row=>row.startId===providerReceipt.parent.startId);
    const provider=prior.ordinaryStarts.find(row=>row.startId===providerReceipt.provider.startId);
    const nextProvider=next.ordinaryStarts.find(row=>row.startId===providerReceipt.provider.startId);
    const exact=(row:HostedOrdinaryReservation|undefined,facts:ScopedProviderOnlyReceipt["parent"])=>row &&
      row.unit===facts.unit && row.creatorId===facts.creatorId && row.originSha256===facts.originSha256 && row.generation===facts.generation;
    if (prior.phase!==HostedActivationPhase.Ordinary || next.phase!==HostedActivationPhase.Ordinary ||
        identity.installationId!==prior.installationId || identity.hostId!==prior.hostId || identity.bootId!==prior.bootId || identity.supervisorId!==prior.supervisorId ||
        providerReceipt.publicationGeneration!==next.generation || !exact(parent,providerReceipt.parent) || !exact(provider,providerReceipt.provider) ||
        parent!.state!==HostedCustodyReservationState.Reserved || provider!.state!==HostedCustodyReservationState.Reserved ||
        nextProvider?.state!==HostedCustodyReservationState.Terminal ||
        next.ordinaryStarts.length!==prior.ordinaryStarts.length || next.ordinaryOriginsSha256!==prior.ordinaryOriginsSha256) invalid();
  }
  if (receipt && (receipt.operation.identity.installationId !== prior.installationId || receipt.operation.identity.hostId !== prior.hostId ||
      receipt.operation.identity.bootId !== prior.bootId || receipt.operation.identity.supervisorId !== prior.supervisorId)) invalid();
  const authorized = new Map<string,{unit:string;reservationGeneration:number}>(receipt?.operation.members.map(m => [m.startId, m]) ?? []);
  if (providerReceipt) authorized.set(providerReceipt.provider.startId,{unit:providerReceipt.provider.unit,reservationGeneration:providerReceipt.provider.generation});
  if (finalReaderReceipt) authorized.set(finalReaderReceipt.reader.startId,{unit:finalReaderReceipt.reader.unit,reservationGeneration:finalReaderReceipt.reader.generation});
  const phaseChanged = prior.phase !== next.phase;
  const edges: Record<HostedActivationPhase, readonly HostedActivationPhase[]> = {
    CLOSED: [HostedActivationPhase.Ordinary, HostedActivationPhase.EnteringExclusive],
    ORDINARY: [HostedActivationPhase.Closed, HostedActivationPhase.EnteringExclusive],
    ENTERING_EXCLUSIVE: [HostedActivationPhase.Closed, HostedActivationPhase.Exclusive],
    EXCLUSIVE: [HostedActivationPhase.LeavingExclusive, HostedActivationPhase.Closed],
    LEAVING_EXCLUSIVE: [HostedActivationPhase.Closed],
  };
  if (phaseChanged && !edges[prior.phase].includes(next.phase)) invalid();
  const sessionChanged = prior.bootId !== next.bootId || prior.supervisorId !== next.supervisorId;
  if (sessionChanged && (prior.phase !== HostedActivationPhase.Closed || next.phase !== HostedActivationPhase.Closed ||
      prior.ordinaryStarts.some(row => row.state !== HostedCustodyReservationState.Terminal))) invalid();
  if (prior.ordinaryOriginsSha256 !== next.ordinaryOriginsSha256 &&
      (prior.phase !== HostedActivationPhase.Closed || next.phase !== HostedActivationPhase.Closed)) invalid();
  if (prior.exclusiveEnrollmentSha256 !== next.exclusiveEnrollmentSha256 &&
      (prior.phase !== HostedActivationPhase.EnteringExclusive ||
        ![HostedActivationPhase.EnteringExclusive, HostedActivationPhase.Exclusive].includes(next.phase))) invalid();
  if (next.ordinaryStarts.length < prior.ordinaryStarts.length || next.ordinaryStarts.length > prior.ordinaryStarts.length + 1) invalid();
  prior.ordinaryStarts.forEach((row, index) => {
    const current = next.ordinaryStarts[index];
    if (!current || Object.keys(row).some(key => key !== "state" &&
        row[key as keyof typeof row] !== current[key as keyof typeof row]) ||
        (row.state === HostedCustodyReservationState.Terminal && current.state !== row.state) ||
        (row.state !== current.state && next.phase === HostedActivationPhase.Ordinary &&
          (!authorized.has(row.startId) || current.state !== HostedCustodyReservationState.Terminal ||
            authorized.get(row.startId)!.unit !== row.unit || authorized.get(row.startId)!.reservationGeneration !== row.generation))) invalid();
  });
  if (next.ordinaryStarts.length > prior.ordinaryStarts.length) {
    const added = next.ordinaryStarts[next.ordinaryStarts.length - 1]!;
    if (prior.phase !== HostedActivationPhase.Ordinary || next.phase !== HostedActivationPhase.Ordinary ||
        sessionChanged || added.generation !== next.generation || added.state !== HostedCustodyReservationState.Reserved) invalid();
  }
  if (phaseChanged && [HostedActivationPhase.Ordinary, HostedActivationPhase.Exclusive].includes(next.phase) &&
      prior.ordinaryStarts.some(row => row.state !== HostedCustodyReservationState.Terminal)) invalid();
}
