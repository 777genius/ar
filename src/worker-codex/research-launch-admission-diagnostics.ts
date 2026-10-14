import { join } from "node:path";
import { researchHostCommandFailure, researchHash, researchPublish, researchRead } from "./research-launch-files";

export enum ResearchAdmissionFailureStage {
  AuthorityCurrent = "authority-current", MaterialCurrent = "material-current",
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
