import { join } from "node:path";
import { researchHostCommandFailure, researchHash, researchPublish, researchRead } from "./research-launch-files";

export enum ResearchAdmissionFailureStage {
  AuthorityCurrent = "authority-current", MaterialCurrent = "material-current",
}
export type ResearchAdmissionTiming = Readonly<{
  admissionAuthorityElapsedMs: number; admissionArtifactElapsedMs: number; admissionExecutableElapsedMs: number;
  /** Inclusive children of authority; never add these to the outer phase sum. */
  admissionAuthorityServiceElapsedMs?: number;
  admissionAuthorityScalarWitnessElapsedMs?: number;
  admissionAuthorityPairedPinElapsedMs?: number;
}>;
/** Source-only observations; callbacks carry no authority or retained decision. */
export type ResearchAuthorityTimingObservers = Readonly<{ scalarWitness?: (elapsedMs: number) => void; pairedPin?: (elapsedMs: number) => void }>;
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
