import { createHash } from "node:crypto";

export enum ScopedTerminationKind { Runtime = "runtime", Provider = "provider" }
export enum ScopedTerminationReason { Requested = "requested", Deadline = "deadline", Budget = "budget", Completion = "completion" }
export enum ScopedTerminationOutcome { Unresolved = "termination_unresolved", ReceiptBacked = "receipt_backed" }
export enum ScopedTerminationCause { Ownership = "ownership", Correlation = "correlation", Identity = "identity", Creator = "creator", Queue = "queue", Descendants = "descendants", Collection = "collection", Budget = "budget", Durability = "durability", Publication = "publication" }
export enum ScopedSignal { Term = "SIGTERM", Kill = "SIGKILL" }
export interface RetainedScopeIdentity {
  readonly scopeDigest: string; readonly installationId: string; readonly hostId: string; readonly bootId: string;
  readonly supervisorId: string; readonly supervisorUnit: string; readonly supervisorControlGroup: string; readonly accountId: string; readonly grantDigest: string; readonly inventoryDigest: string;
  readonly sourceSha: string; readonly artifactSha: string; readonly deadlineEpochMs: number;
  readonly authorityDigest: string; readonly slotId: string; readonly parentStartId: string;
  readonly dispatchIntentGeneration: number;
}
/** Published before enqueue. Invocation is a separate, immutable observed record;
 * its absence never allows a collector to bind a later replacement. */
export interface ScopedStartCorrelation {
  readonly schemaVersion: 1; readonly kind: ScopedTerminationKind; readonly identity: RetainedScopeIdentity;
  readonly startId: string; readonly startDigest: string; readonly parentStartDigest: string;
  readonly reservationGeneration: number; readonly unit: string; readonly controlGroup: string;
  readonly creatorPidBirth: string; readonly creatorControlGroup: string;
}
export interface ScopedInvocation { readonly schemaVersion: 1; readonly correlationDigest: string; readonly invocationId: string }
export interface ScopedTerminationMember extends ScopedStartCorrelation { readonly invocationId: string; readonly submitterDigest: string }
export interface ScopedTerminationOperation {
  readonly schemaVersion: 1; readonly identity: RetainedScopeIdentity; readonly operationGeneration: number;
  readonly members: readonly ScopedTerminationMember[];
}
export interface ScopedTerminationObservation {
  readonly startId: string; readonly identityUnchanged: boolean; readonly creatorFenced: boolean;
  readonly queueEmpty: boolean; readonly recursiveEmpty: boolean; readonly digest: string;
}
export interface ScopedTerminationReceipt {
  readonly schemaVersion: 1; readonly outcome: ScopedTerminationOutcome.ReceiptBacked;
  readonly operation: ScopedTerminationOperation; readonly publicationGeneration: number;
  readonly observations: readonly ScopedTerminationObservation[];
}
export const scopedDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fields(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) throw new Error("scoped_record_invalid");
  return value as Record<string, unknown>;
}
function match(value: unknown, pattern: RegExp): void { if (typeof value !== "string" || !pattern.test(value)) throw new Error("scoped_record_invalid"); }
function positive(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("scoped_record_invalid"); }
const hash = /^[a-f0-9]{64}$/, id = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/, birth = /^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/;
export function parseRetainedScopeIdentity(value: unknown): RetainedScopeIdentity {
  const v = fields(value, "scopeDigest,installationId,hostId,bootId,supervisorId,supervisorUnit,supervisorControlGroup,accountId,grantDigest,inventoryDigest,sourceSha,artifactSha,deadlineEpochMs,authorityDigest,slotId,parentStartId,dispatchIntentGeneration");
  for (const key of ["scopeDigest", "grantDigest", "inventoryDigest", "authorityDigest"]) match(v[key], hash);
  for (const key of ["installationId", "hostId", "bootId", "supervisorUnit", "accountId", "slotId", "parentStartId"]) match(v[key], id);
  match(v.supervisorId, birth); match(v.supervisorControlGroup, /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/);
  if ((v.supervisorControlGroup as string).split("/").some(p => p === "." || p === "..")) throw new Error("scoped_record_invalid"); match(v.sourceSha, /^[a-f0-9]{40}$/); match(v.artifactSha, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  positive(v.deadlineEpochMs); positive(v.dispatchIntentGeneration);
  return Object.freeze({ ...v }) as unknown as RetainedScopeIdentity;
}
export function parseScopedStartCorrelation(value: unknown): ScopedStartCorrelation {
  const v = fields(value, "schemaVersion,kind,identity,startId,startDigest,parentStartDigest,reservationGeneration,unit,controlGroup,creatorPidBirth,creatorControlGroup");
  if (v.schemaVersion !== 1 || !Object.values(ScopedTerminationKind).includes(v.kind as ScopedTerminationKind)) throw new Error("scoped_record_invalid");
  const identity = parseRetainedScopeIdentity(v.identity);
  match(v.startId, /^[a-f0-9-]{36}$/); match(v.startDigest, hash); match(v.parentStartDigest, hash); positive(v.reservationGeneration);
  match(v.unit, /^subscription-runtime-(?:ordinary|hosted)-[a-f0-9-]{36}\.service$/);
  if (v.unit !== `subscription-runtime-${v.kind === ScopedTerminationKind.Runtime ? "ordinary" : "hosted"}-${v.startId}.service` ||
      v.controlGroup !== `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${v.unit}` ||
      (v.kind === ScopedTerminationKind.Runtime && (v.startId !== identity.parentStartId || v.startDigest !== v.parentStartDigest))) throw new Error("scoped_record_invalid");
  match(v.creatorPidBirth, birth);
  match(v.creatorControlGroup, /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/);
  if ((v.creatorControlGroup as string).split("/").some(p => p === "." || p === "..")) throw new Error("scoped_record_invalid");
  return Object.freeze({ ...v, identity }) as unknown as ScopedStartCorrelation;
}
export function parseScopedInvocation(value: unknown): ScopedInvocation {
  const v = fields(value, "schemaVersion,correlationDigest,invocationId");
  if (v.schemaVersion !== 1) throw new Error("scoped_record_invalid");
  match(v.correlationDigest, hash); match(v.invocationId, /^[a-f0-9]{32}$/);
  return Object.freeze({ ...v }) as unknown as ScopedInvocation;
}
export function parseScopedOperation(value: unknown): ScopedTerminationOperation {
  const v = fields(value, "schemaVersion,identity,operationGeneration,members"), identity = parseRetainedScopeIdentity(v.identity);
  if (v.schemaVersion !== 1 || !Array.isArray(v.members) || !v.members.length || v.members.length > 256) throw new Error("scoped_record_invalid");
  positive(v.operationGeneration);
  const members = v.members.map(raw => {
    const m = fields(raw, "schemaVersion,kind,identity,startId,startDigest,parentStartDigest,reservationGeneration,unit,controlGroup,creatorPidBirth,creatorControlGroup,invocationId,submitterDigest");
    const { invocationId, submitterDigest, ...correlation } = m;
    const c = parseScopedStartCorrelation(correlation); match(invocationId, /^[a-f0-9]{32}$/); match(submitterDigest, hash);
    if (scopedDigest(c.identity) !== scopedDigest(identity)) throw new Error("scoped_record_invalid");
    return Object.freeze({ ...c, invocationId, submitterDigest }) as ScopedTerminationMember;
  });
  if (new Set(members.map(m => m.startId)).size !== members.length || members.filter(m => m.kind === ScopedTerminationKind.Runtime).length !== 1 ||
      members.some(m => m.parentStartDigest !== members[0]!.parentStartDigest)) throw new Error("scoped_record_invalid");
  return Object.freeze({ schemaVersion: 1, identity, operationGeneration: v.operationGeneration as number, members: Object.freeze(members) });
}
export function parseScopedReceipt(value: unknown): ScopedTerminationReceipt {
  const v = fields(value, "schemaVersion,outcome,operation,publicationGeneration,observations"), operation = parseScopedOperation(v.operation);
  positive(v.publicationGeneration);
  if (v.schemaVersion !== 1 || v.outcome !== ScopedTerminationOutcome.ReceiptBacked ||
      (v.publicationGeneration as number) < operation.operationGeneration || !Array.isArray(v.observations) || v.observations.length !== operation.members.length) throw new Error("scoped_record_invalid");
  const observations = v.observations.map((raw, i) => {
    const o = fields(raw, "startId,identityUnchanged,creatorFenced,queueEmpty,recursiveEmpty,digest");
    match(o.digest, hash);
    if (o.startId !== operation.members[i]!.startId || [o.identityUnchanged, o.creatorFenced, o.queueEmpty, o.recursiveEmpty].some(flag => flag !== true)) throw new Error("scoped_record_invalid");
    return Object.freeze({ ...o }) as unknown as ScopedTerminationObservation;
  });
  return Object.freeze({ schemaVersion: 1, outcome: ScopedTerminationOutcome.ReceiptBacked, operation,
    publicationGeneration: v.publicationGeneration as number, observations: Object.freeze(observations) });
}

export interface ScopedSubmitter { readonly schemaVersion: 1; readonly correlationDigest: string; readonly pidBirth: string; readonly controlGroup: string }
export function parseScopedSubmitter(value: unknown): ScopedSubmitter {
  const v = fields(value, "schemaVersion,correlationDigest,pidBirth,controlGroup");
  if (v.schemaVersion !== 1) throw new Error("scoped_record_invalid");
  match(v.correlationDigest, hash); match(v.pidBirth, birth); match(v.controlGroup, /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/);
  if ((v.controlGroup as string).split("/").some(p => p === "." || p === "..")) throw new Error("scoped_record_invalid");
  return Object.freeze({ ...v }) as unknown as ScopedSubmitter;
}
