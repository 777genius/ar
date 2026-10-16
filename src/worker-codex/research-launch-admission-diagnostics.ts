import { join } from "node:path";
import { researchHostCommandFailure, researchHash, researchPublish, researchRead } from "./research-launch-files";

export enum MimoProjectControlTimingKind { OwnedStart = "owned-start" }
export enum MimoProjectControlTimingClock { ProcessUptime = "process-uptime" }
export enum MimoProjectStartControlTimingScope {
  WorkstreamFenceAcquire = "workstream-fence-acquire", RuntimeSelectionAndImport = "runtime-selection-and-import",
  PreBrokerObservation = "pre-broker-observation", BrokerStart = "broker-start",
}
type ControlTimingObserver = (scope: MimoProjectStartControlTimingScope, elapsedMs: number) => void;
export type MimoProjectStartControlTimingObserver = ControlTimingObserver;
export type MimoProjectStartControlTiming = Readonly<{
  schemaVersion: 1; kind: MimoProjectControlTimingKind.OwnedStart; clock: MimoProjectControlTimingClock.ProcessUptime;
  processElapsedMsAtReceipt: number; workstreamFenceAcquireElapsedMs?: number; runtimeSelectionAndImportElapsedMs?: number;
  preBrokerObservationElapsedMs?: number; brokerStartElapsedMs?: number; unattributedElapsedMsAtReceipt?: number;
}>;
function controlClock(): number | undefined {
  try {
    const raw = process.uptime(); if (typeof raw !== "number") return undefined;
    const value = raw * 1000; if (Number.isFinite(value) && value >= 0 && value <= 86_400_000) return value;
  }
  catch { /* Observation cannot alter the operation. */ }
  return undefined;
}
/** Finish at the original callback boundary, without moving its effect or finally. */
export function beginMimoProjectStartControlTiming(scope: MimoProjectStartControlTimingScope,
  observe?: ControlTimingObserver): () => void {
  const started = observe ? controlClock() : undefined;
  return () => { try {
    const finished = observe ? controlClock() : undefined;
    if (started !== undefined && finished !== undefined && finished >= started) observe?.(scope, finished - started);
  } catch { /* Preserve the original result, thrown identity and cleanup. */ } };
}
/** Unlike the synchronous admission measurement, this includes Promise settlement. */
export async function measureMimoProjectStartControlTiming<T>(scope: MimoProjectStartControlTimingScope,
  effect: () => Promise<T>, observe?: ControlTimingObserver): Promise<T> {
  const finish = beginMimoProjectStartControlTiming(scope, observe);
  try { return await effect(); } finally { finish(); }
}
export function createMimoProjectStartControlTiming(): Readonly<{
  observe: ControlTimingObserver; snapshot(): MimoProjectStartControlTiming | undefined;
}> {
  const S = MimoProjectStartControlTimingScope;
  const rows = [
    [S.WorkstreamFenceAcquire, "workstreamFenceAcquireElapsedMs", 1],
    [S.RuntimeSelectionAndImport, "runtimeSelectionAndImportElapsedMs", 1],
    [S.PreBrokerObservation, "preBrokerObservationElapsedMs", 3],
    [S.BrokerStart, "brokerStartElapsedMs", 1],
  ] as const;
  const values = new Map<MimoProjectStartControlTimingScope, { count: number; elapsedMs: number }>();
  return { observe: (scope, elapsedMs) => {
    if (!rows.some(row => row[0] === scope) || !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > 86_400_000) return;
    const previous = values.get(scope); values.set(scope, { count: (previous?.count ?? 0) + 1, elapsedMs: (previous?.elapsedMs ?? 0) + elapsedMs });
  }, snapshot: () => {
    const total = controlClock(); if (total === undefined) return undefined;
    const timing: { -readonly [K in keyof MimoProjectStartControlTiming]: MimoProjectStartControlTiming[K] } = {
      schemaVersion: 1, kind: MimoProjectControlTimingKind.OwnedStart,
      clock: MimoProjectControlTimingClock.ProcessUptime, processElapsedMsAtReceipt: total,
    };
    let sum = 0, complete = true;
    for (const [scope, field, count] of rows) {
      const value = values.get(scope);
      if (!value || value.count !== count || !Number.isFinite(value.elapsedMs) || value.elapsedMs > total) { complete = false; continue; }
      timing[field] = value.elapsedMs; sum += value.elapsedMs;
    }
    // These four scopes are disjoint. Bootstrap, other guards and lock work remain
    // unattributed; the process total is not the PID1 interval or an additive phase.
    if (complete && sum <= total) timing.unattributedElapsedMsAtReceipt = total - sum;
    return timing;
  } };
}
/** Decorate the already serialized wire DTO, never re-evaluate handler accessors.
 * Failure envelopes and response-size behavior remain byte-for-byte unchanged. */
export function mimoProjectStartControlReceipt(serialized: string,
  timing: ReturnType<typeof createMimoProjectStartControlTiming> | undefined): string {
  if (!timing) return serialized;
  try {
    const envelope = JSON.parse(serialized) as { ok?: unknown; result?: Record<string, unknown> };
    const inner = envelope.result;
    if (envelope.ok !== true || !inner || inner.ok !== true || inner.mode !== "project_control_start" ||
        (inner.result as { status?: unknown } | undefined)?.status !== "applied" || Object.hasOwn(inner, "controlTiming")) return serialized;
    const observation = timing.snapshot(); if (!observation) return serialized;
    const decorated = JSON.stringify({ ...envelope, result: { ...inner, controlTiming: observation } }) + "\n";
    return Buffer.byteLength(decorated) <= 1048576 ? decorated : serialized;
  } catch { return serialized; }
}

export enum ResearchAdmissionFailureStage {
  AuthorityCurrent = "authority-current", MaterialCurrent = "material-current",
}
export type ResearchAdmissionTiming = Readonly<{
  admissionAuthorityElapsedMs: number; admissionArtifactElapsedMs: number; admissionExecutableElapsedMs: number;
  /** Inclusive children of authority; never add these to the outer phase sum. */
  admissionAuthorityServiceElapsedMs?: number;
  admissionAuthorityScalarWitnessElapsedMs?: number;
  admissionAuthorityPairedPinElapsedMs?: number;
  /** Query helper phases include custody/JSON work, not isolated subprocess CPU. */
  admissionAuthorityScalarTargetQueryElapsedMs?: number;
  admissionAuthorityPairedTargetQueryElapsedMs?: number;
}>;
/** Source-only observations; callbacks carry no authority or retained decision. */
export type ResearchAuthorityTimingObservers = Readonly<{ scalarWitness?: (elapsedMs: number) => void; pairedPin?: (elapsedMs: number) => void;
  scalarTargetQuery?: (elapsedMs: number) => void; pairedTargetQuery?: (elapsedMs: number) => void }>;
/** Measures one existing synchronous operation; observation cannot change it. */
export function researchAdmissionMeasure<T>(effect: () => T, observe: (elapsedMs: number) => void): T {
  let started: number | undefined;
  try { started = performance.now(); } catch { /* Observation only. */ }
  try { return effect(); }
  finally { try {
    const elapsed = started === undefined ? NaN : performance.now() - started;
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 86_400_000) observe(elapsed);
  } catch { /* Preserve the operation's exact result or exception. */ } }
}
/** Private observation only. The retained immutable bytes bind it to the exact
 * start; diagnostic publication never replaces or retries the original denial. */
export function researchAdmissionObservation(directory: string, specBytes: Buffer, bindingBytes: Buffer):
  <T>(stage: ResearchAdmissionFailureStage, effect: () => T) => T {
  const spec = Buffer.from(specBytes), binding = Buffer.from(bindingBytes);
  const published = new WeakSet<object>();
  return (stage, effect) => {
    try { return effect(); }
    catch (error) {
      const failure = researchHostCommandFailure(error);
      if (failure && !published.has(error as object)) try {
        if (researchRead(join(directory, "spec.json")).equals(spec) &&
            researchRead(join(directory, "binding.json")).equals(binding)) {
          // Identity fields are read from authenticated retained bytes, never errors.
          const identity = JSON.parse(spec.toString("utf8")) as { startId: string; unit: string };
          researchPublish(join(directory, "pre-provider-failure.json"), {
            schemaVersion: 1, startId: identity.startId, runtimeUnit: identity.unit,
            specSha256: researchHash(spec), bindingSha256: researchHash(binding), stage,
            hostCommand: { operation: failure.operation, unitRole: failure.unitRole, elapsedMs: failure.elapsedMs },
          });
          published.add(error as object);
        }
      } catch { /* Observation failure cannot replace the original thrown identity. */ }
      throw error;
    }
  };
}
