import { isDependencyProtectedReference, sameDependencyProtectedReference, type DependencyProtectedReference } from "./dependency-protected-reference";
/** Factual admission-pipeline telemetry only. These records never authorize
 * execution, baseline publication, writer effects, custody or native release. */
export enum DependencyContentObservationStage {
  Staged = "staged", Normalized = "normalized", FinalRoot = "final_root", Qualification = "qualification",
}
export enum DependencyContentObservationRecordKind {
  Opened = "opened", Started = "started", Returned = "returned", Closed = "closed",
}
export enum DependencyContentObservationOutcome { Complete = "complete", Incomplete = "incomplete" }
export enum DependencyContentObservationReadStatus { Complete = "complete", Unknown = "unknown" }
export type DependencyContentObservationIdentity = Readonly<{
  attemptId: string; startId: string; epoch: string; scopeSha256: string;
}>;
type Common = Readonly<{ version: 1; identity: DependencyContentObservationIdentity }>;
export type DependencyContentObservationRecord = Common & (
  Readonly<{ kind: DependencyContentObservationRecordKind.Opened }> |
  Readonly<{ kind: DependencyContentObservationRecordKind.Started; ordinal: number; stage: DependencyContentObservationStage }> |
  Readonly<{ kind: DependencyContentObservationRecordKind.Returned; ordinal: number; stage: DependencyContentObservationStage;
    outcome: DependencyContentObservationOutcome }> |
  Readonly<{ kind: DependencyContentObservationRecordKind.Closed; count: number; opened: DependencyProtectedReference;
    observations: readonly Readonly<{ ordinal: number; started: DependencyProtectedReference; returned: DependencyProtectedReference }>[] }>
);
export type DependencyContentObservationReport = Readonly<{
  status: DependencyContentObservationReadStatus.Complete; identity: DependencyContentObservationIdentity;
  attempted: number; completed: number; finalRoot: number;
}> | Readonly<{ status: DependencyContentObservationReadStatus.Unknown;
  attempted: null; completed: null; finalRoot: null }>;
export const dependencyContentObservationLimit = 16;
const unknown = (): DependencyContentObservationReport => ({ status: DependencyContentObservationReadStatus.Unknown,
  attempted: null, completed: null, finalRoot: null });
function object(value: unknown, keys: string): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).every(key => typeof key === "string") && Object.keys(value).sort().join(",") === keys;
}
function identity(value: unknown): value is DependencyContentObservationIdentity {
  return object(value, "attemptId,epoch,scopeSha256,startId") &&
    typeof value.attemptId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.attemptId) &&
    typeof value.startId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.startId) &&
    typeof value.epoch === "string" && /^(?:0|[1-9][0-9]{0,19})$/.test(value.epoch) &&
    typeof value.scopeSha256 === "string" && /^[a-f0-9]{64}$/.test(value.scopeSha256);
}
function same(a: DependencyContentObservationIdentity, b: DependencyContentObservationIdentity): boolean {
  return a.attemptId === b.attemptId && a.startId === b.startId && a.epoch === b.epoch && a.scopeSha256 === b.scopeSha256;
}
function ordinal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= dependencyContentObservationLimit;
}
/** The adapter authenticates protected file identity/content and the complete
 * bounded directory census. This pure read model neither reads files nor grants
 * authority. Missing/open/lost/incomplete intervals cannot be reported as zero. */
export function readDependencyContentObservationFacts(expected: unknown,
  records: readonly unknown[] | undefined, references: readonly DependencyProtectedReference[] | undefined): DependencyContentObservationReport {
  if (!identity(expected) || !records || !Array.isArray(records) || records.length > 2 * dependencyContentObservationLimit + 2 ||
      !references || references.length !== records.length || references.some(ref => !isDependencyProtectedReference(ref))) return unknown();
  let opened: DependencyProtectedReference | undefined, count: number | undefined, seal: Record<string, unknown> | undefined;
  const starts = new Map<number, DependencyContentObservationStage>(), returns = new Map<number, DependencyContentObservationStage>();
  const seen = new Map<string, string>(), actualReferences = new Map<string, DependencyProtectedReference>();
  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const value = records[recordIndex], reference = references[recordIndex]; if (!reference) return unknown();
    if (typeof value !== "object" || value === null || Array.isArray(value)) return unknown();
    const row = value as Record<string, unknown>;
    if (row.version !== 1 || !identity(row.identity) || !same(row.identity, expected)) return unknown();
    let key: string;
    if (row.kind === DependencyContentObservationRecordKind.Opened) {
      if (!object(row, "identity,kind,version")) return unknown(); key = "opened"; opened = reference;
    } else if (row.kind === DependencyContentObservationRecordKind.Closed) {
      if (!object(row, "count,identity,kind,observations,opened,version") || typeof row.count !== "number" || !Number.isSafeInteger(row.count) ||
        row.count < 0 || row.count > dependencyContentObservationLimit || !isDependencyProtectedReference(row.opened) ||
        !Array.isArray(row.observations) || row.observations.length !== row.count) return unknown(); key = "closed"; count = row.count; seal = row;
    } else if (row.kind === DependencyContentObservationRecordKind.Started || row.kind === DependencyContentObservationRecordKind.Returned) {
      if (!object(row, row.kind === DependencyContentObservationRecordKind.Started ? "identity,kind,ordinal,stage,version" :
        "identity,kind,ordinal,outcome,stage,version") || !ordinal(row.ordinal) ||
        !Object.values(DependencyContentObservationStage).includes(row.stage as DependencyContentObservationStage)) return unknown();
      key = row.kind + ":" + row.ordinal;
      if (row.kind === DependencyContentObservationRecordKind.Started) starts.set(row.ordinal, row.stage as DependencyContentObservationStage);
      else {
        if (row.outcome !== DependencyContentObservationOutcome.Complete) return unknown();
        returns.set(row.ordinal, row.stage as DependencyContentObservationStage);
      }
    } else return unknown();
    const encoded = JSON.stringify(row), previous = seen.get(key);
    if (previous !== undefined && (previous !== encoded || !sameDependencyProtectedReference(actualReferences.get(key)!, reference))) return unknown();
    seen.set(key, encoded); actualReferences.set(key, reference);
  }
  if (!opened || !seal || count === undefined || starts.size !== count || returns.size !== count ||
      !isDependencyProtectedReference(seal.opened) || !sameDependencyProtectedReference(opened, seal.opened) || !Array.isArray(seal.observations)) return unknown();
  let finalRoot = 0;
  for (let index = 1; index <= count; index++) {
    const stage = starts.get(index), pair = seal.observations[index - 1],
      started = actualReferences.get(DependencyContentObservationRecordKind.Started + ":" + index),
      returned = actualReferences.get(DependencyContentObservationRecordKind.Returned + ":" + index);
    if (stage === undefined || returns.get(index) !== stage || !object(pair, "ordinal,returned,started") || pair.ordinal !== index ||
        !isDependencyProtectedReference(pair.started) || !isDependencyProtectedReference(pair.returned) || !started || !returned ||
        !sameDependencyProtectedReference(started, pair.started) || !sameDependencyProtectedReference(returned, pair.returned)) return unknown();
    if (stage === DependencyContentObservationStage.FinalRoot) finalRoot++;
  }
  if (finalRoot > 1) return unknown();
  return { status: DependencyContentObservationReadStatus.Complete, identity: { ...expected }, attempted: count, completed: count, finalRoot };
}
