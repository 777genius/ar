/** Read-only TEST measurement. Nothing returned authorizes a launch or release. */
import { createHash } from "node:crypto";
import { DependencyContentObservationReadStatus } from "../../dist/core/dependency-environment/dependency-content-observation.js";
import { isDependencyCustodyObject, DependencyConsumerLaunchKind } from "../../dist/core/dependency-environment/dependency-custody-evidence.js";
import { assertHostedForegroundResult, readHostedForegroundLaunchObservation, type HostedForegroundResult } from "../../dist/provider-codex/app-server/adapters/hosted-fd-launch.js";
import { withHostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import { readHostedDependencyBinding } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { readHostedDependencyContentObservationReport } from "../../dist/worker-codex/hosted-dependency-content-observation-reader.js";
import { pinReferenceFile } from "../../dist/worker-codex/hosted-dependency-legacy-reference-records.js";
export enum EntryObservationState { Measured = "measured", Unknown = "unknown" }
const root = "/var/lib/subscription-runtime-host-policy/dependency-generation-source-closures";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const encode = (v: unknown) => Buffer.from(JSON.stringify(v) + "\n");
const unknown = () => ({ state: EntryObservationState.Unknown, attempted: null, completed: null, finalRoot: null } as const);
/** The actual in-process FDA result brand selects this exact native start.
 * Caller JSON, an old receipt, selected UUID, or asserted bool is not accepted.
 * Both C and R source closure schemas are original protected producer records. */
export function readCurrentEntryContentObservation(candidateJobId: string, result: HostedForegroundResult) {
  try {
    // No caller fields, fence, directories or files before the original brand.
    assertHostedForegroundResult(result);
    const native = readHostedForegroundLaunchObservation(result);
    if (typeof candidateJobId !== "string" || !/^TEST-[A-Za-z0-9_.-]{1,123}$/.test(candidateJobId) ||
        !uuid.test(native.startId) || native.closeStatus !== 0 || result.exitCode !== 0) return unknown();
    return withHostedActivationFence(fence => {
      const binding = readHostedDependencyBinding(candidateJobId);
      if (!binding || binding.version !== 2) return unknown();
      const path = `${root}/${native.startId}.json`, before = pinReferenceFile(path, 65536);
      const value: unknown = JSON.parse(before.bytes.toString("utf8"));
      if (isDependencyCustodyObject(value,"attempt,barrier,baseline,binding,final,pending,retirement,version")) {
        if (value.version !== 1) return unknown();
      } else if (isDependencyCustodyObject(value,"attempt,barrier,baseline,binding,identity,outer,parent,pending,providers,retirement,version")) {
        if (value.version !== 2) return unknown();
      } else return unknown();
      if (!encode(value).equals(before.bytes) || !encode(value.binding).equals(encode(binding)) ||
          !isDependencyCustodyObject(value.attempt,"attemptId,epoch,launch")) return unknown();
      const attempt = value.attempt, launch = attempt.launch;
      if (typeof attempt.attemptId !== "string" || !uuid.test(attempt.attemptId) || typeof attempt.epoch !== "number" ||
          !Number.isSafeInteger(attempt.epoch) || attempt.epoch < 1) return unknown();
      if (isDependencyCustodyObject(launch,"bootId,grantDigest,installationId,runtimeSha,startId,unit")) {
        if (value.version !== 1) return unknown();
      } else if (isDependencyCustodyObject(launch,"association,bootId,grantDigest,installationId,kind,origin,runtimeSha,startId,unit")) {
        if (value.version !== 2 || launch.kind !== DependencyConsumerLaunchKind.ManagedReadonlyLocalV1) return unknown();
      } else return unknown();
      if (launch.startId !== native.startId || launch.unit !== native.unit || launch.installationId !== binding.installationId ||
          launch.runtimeSha !== binding.runtimeSha || launch.grantDigest !== binding.grantDigest) return unknown();
      const report = readHostedDependencyContentObservationReport(fence,native.startId,attempt.attemptId);
      if (report.status !== DependencyContentObservationReadStatus.Complete || report.identity.startId !== native.startId ||
          report.identity.attemptId !== attempt.attemptId || report.identity.epoch !== String(attempt.epoch) ||
          report.identity.scopeSha256 !== createHash("sha256").update(encode({attempt,binding})).digest("hex")) return unknown();
      const after = pinReferenceFile(path,65536);
      if (!after.bytes.equals(before.bytes) || !encode(after.reference).equals(encode(before.reference))) return unknown();
      return { state: EntryObservationState.Measured, startId: native.startId, attemptId: attempt.attemptId,
        invocationId: native.invocationId, epoch: report.identity.epoch, scopeSha256: report.identity.scopeSha256,
        sourceClosedSha256: before.reference.sha256, attempted: report.attempted, completed: report.completed, finalRoot: report.finalRoot } as const;
    });
  } catch { return unknown(); }
}
