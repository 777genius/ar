import type { RunObservationSnapshot } from "./run-observability";
import { runEventProviderKindFromString } from "./run-provider-kind";
import type { RunEventProjectionState } from "./run-event-types";
import { runEventReadModelsFromSnapshot } from "./run-event-read-models";
import {
  capacityPayload,
  controlInboxPayload,
  stableJsonString,
  workspaceSignature,
} from "./run-event-payload";

export function runEventProjectionStateFromSnapshot(
  snapshot: RunObservationSnapshot,
): RunEventProjectionState {
  const workspaceSignatureValue = workspaceSignature(snapshot.workspace);
  const capacitySignatureValue = stableJsonString(capacityPayload(snapshot.capacity));
  const controlInboxSignatureValue = stableJsonString(
    controlInboxPayload(snapshot.controlInbox),
  );
  return {
    schemaVersion: 1,
    runId: snapshot.runId,
    providerKind: runEventProviderKindFromString(snapshot.providerKind),
    observedAt: snapshot.observedAt,
    status: snapshot.status,
    liveness: snapshot.liveness,
    lifecycleSignature: JSON.stringify([snapshot.progress?.stale ?? null,
      snapshot.progress?.silentStale ?? null, snapshot.progress?.heartbeatOnlyNoOutput ?? null,
      snapshot.process?.alive ?? null, snapshot.process?.aliveReason ?? null,
      snapshot.process?.supervisor ?? null, snapshot.process?.pid ?? null]),
    ...(snapshot.progress?.status === undefined
      ? {}
      : { progressStatus: snapshot.progress.status }),
    ...(snapshot.progress?.updatedAt === undefined
      ? {}
      : { progressUpdatedAt: snapshot.progress.updatedAt }),
    ...(snapshot.result?.status === undefined ? {} : { resultStatus: snapshot.result.status }),
    ...(snapshot.result?.reason === undefined ? {} : { resultReason: snapshot.result.reason }),
    ...(snapshot.result?.updatedAt === undefined
      ? {}
      : { resultUpdatedAt: snapshot.result.updatedAt }),
    ...(snapshot.logs?.byteLength === undefined
      ? {}
      : { logByteLength: snapshot.logs.byteLength }),
    ...(workspaceSignatureValue === undefined
      ? {}
      : { workspaceSignature: workspaceSignatureValue }),
    capacitySignature: capacitySignatureValue,
    controlInboxSignature: controlInboxSignatureValue,
    decisionKind: snapshot.readOnlyDecision.kind,
    decisionReason: snapshot.readOnlyDecision.reason,
    readModels: runEventReadModelsFromSnapshot(snapshot),
  };
}
