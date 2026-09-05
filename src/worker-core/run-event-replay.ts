import { RunProcessAliveReason, RunProcessSupervisorKind } from "./run-observability";
import { sameRunEventSource } from "./run-event-source";
import type {
  RunCapacityHint,
  RunControlInboxSummary,
  RunLogExcerpt,
  RunObservationProgress,
  RunObservationResult,
  RunObservationSnapshot,
  RunObservationWorkspace,
} from "./run-observability";
import {
  RunEventType,
  type JsonObject,
  type RunEvent,
  type RunEventProjectionState,
  type RunEventReadModels,
} from "./run-event-types";
import { runEventReadModelsFromSnapshot } from "./run-event-read-models";
import { runEventProjectionStateFromSnapshot } from "./run-event-projection-state";
import {
  booleanFromJson,
  numberFromJson,
  objectArrayFromJson,
  objectFromJson,
  stringArrayFromJson,
  stringFromJson,
} from "./run-event-payload";

export function projectRunReadModelsFromEvents(
  events: readonly RunEvent[],
): RunEventReadModels | null {
  const replayed = replayRunObservationSnapshotFromEvents(events);
  return replayed === null ? null : runEventReadModelsFromSnapshot(replayed);
}

export function runEventProjectionStateFromEvents(
  events: readonly RunEvent[],
): RunEventProjectionState | null {
  const replayed = replayRunObservationSnapshotFromEvents(events);
  return replayed === null ? null : {
    ...runEventProjectionStateFromSnapshot(replayed),
    source: events[0]!.source,
    revision: events.reduce((latest, event) => {
      const revision = event.payload.projectionRevision;
      return typeof revision === "number" && Number.isSafeInteger(revision)
        ? Math.max(latest, revision) : latest;
    }, 0),
  };
}

function replayRunObservationSnapshotFromEvents(
  events: readonly RunEvent[],
): RunObservationSnapshot | null {
  const first = events[0];
  if (first === undefined) return null;
  const runId = first.runId;
  if (events.some(event => event.runId !== runId || !sameRunEventSource(event.source, first.source))) {
    throw new Error("run_event_replay_source_mismatch");
  }
  const sourceEvents = events;
  const latest = sourceEvents[sourceEvents.length - 1] ?? first;
  let status: RunObservationSnapshot["status"] = "unknown";
  let liveness: RunObservationSnapshot["liveness"] = "unknown";
  let readOnlyDecision: RunObservationSnapshot["readOnlyDecision"] = {
    kind: "manual_review_required",
    reason: "event_replay_without_runtime_snapshot",
    safeMessage:
      "Projected state was rebuilt from events only. Inspect live runtime before control actions.",
    evidence: ["run-events"],
  };
  let workspace: RunObservationWorkspace | undefined;
  let progress: RunObservationProgress | undefined;
  let process: RunObservationSnapshot["process"];
  let result: RunObservationResult | undefined;
  let logs: RunLogExcerpt | undefined;
  let capacity: readonly RunCapacityHint[] | undefined;
  let controlInbox: RunControlInboxSummary | undefined;

  for (const event of sourceEvents) {
    switch (event.type) {
      case RunEventType.ObservationRecorded:
        if (event.payload.progress !== undefined) progress = progressFromPayload(objectFromJson(event.payload.progress) ?? {});
        if (event.payload.process !== undefined) {
          const value = objectFromJson(event.payload.process) ?? {};
          const alive = booleanFromJson(value.alive), pid = numberFromJson(value.pid);
          const aliveReason = stringFromJson(value.aliveReason) as RunProcessAliveReason | undefined;
          const supervisor = stringFromJson(value.supervisor) as RunProcessSupervisorKind | undefined;
          process = { ...(alive === undefined ? {} : { alive }), ...(pid === undefined ? {} : { pid }),
            ...(aliveReason !== undefined && Object.values(RunProcessAliveReason).includes(aliveReason) ? { aliveReason } : {}),
            ...(supervisor !== undefined && Object.values(RunProcessSupervisorKind).includes(supervisor) ? { supervisor } : {}),
          };
        }
        status = observationStatusFromPayload(event.payload) ?? status;
        liveness = observationLivenessFromPayload(event.payload) ?? liveness;
        readOnlyDecision = decisionFromPayload(event.payload) ?? readOnlyDecision;
        break;
      case RunEventType.ProgressUpdated:
        progress = progressFromPayload(event.payload);
        break;
      case RunEventType.OutputGrew:
        logs = outputFromPayload(event.payload);
        break;
      case RunEventType.WorkspaceChanged:
        workspace = workspaceFromPayload(event.payload);
        break;
      case RunEventType.ResultUpdated:
        result = resultFromPayload(event.payload);
        break;
      case RunEventType.DecisionChanged:
        readOnlyDecision = decisionFromPayload(event.payload) ?? readOnlyDecision;
        break;
      case RunEventType.CapacityChanged:
        capacity = capacityFromEventPayload(event.payload);
        break;
      case RunEventType.ControlInboxChanged:
        controlInbox = controlInboxFromEventPayload(event.payload);
        break;
      case RunEventType.MaintenancePaused:
        progress = {
          ...(progress ?? {}),
          status: "maintenance_paused",
          ...(stringFromJson(event.payload.progressUpdatedAt) === undefined
            ? {}
            : { updatedAt: stringFromJson(event.payload.progressUpdatedAt) as string }),
        };
        break;
      case RunEventType.Completed:
        status = "completed";
        result = {
          ...(result ?? {}),
          exists: true,
          ...(stringFromJson(event.payload.resultStatus) === undefined
            ? {}
            : { status: stringFromJson(event.payload.resultStatus) as string }),
        };
        break;
      case RunEventType.Failed:
        status = "failed";
        result = {
          ...(result ?? {}),
          exists: true,
          status: "failed",
          ...(stringFromJson(event.payload.reason) === undefined
            ? {}
            : { reason: stringFromJson(event.payload.reason) as string }),
        };
        break;
      case RunEventType.Blocked:
        readOnlyDecision = {
          kind: "manual_review_required",
          reason: stringFromJson(event.payload.reason) ?? "run_blocked",
          safeMessage:
            "Run was blocked according to the event log. Inspect runtime before control actions.",
          evidence: ["run.blocked"],
        };
        break;
      case RunEventType.Stale:
        liveness = "stale";
        progress = {
          ...(progress ?? {}),
          stale: true,
          ...(numberFromJson(event.payload.heartbeatAgeMs) === undefined
            ? {}
            : { heartbeatAgeMs: numberFromJson(event.payload.heartbeatAgeMs) as number }),
          ...(numberFromJson(event.payload.staleAfterMs) === undefined
            ? {}
            : { staleAfterMs: numberFromJson(event.payload.staleAfterMs) as number }),
        };
        break;
      case RunEventType.UnsafeStateDetected:
        readOnlyDecision = {
          kind: "unsafe_state_mismatch",
          reason: stringFromJson(event.payload.reason) ?? "unsafe_state_detected",
          safeMessage:
            "Unsafe state was detected according to the event log. Inspect runtime before control actions.",
          evidence: stringArrayFromJson(event.payload.evidence),
        };
        break;
    }
  }

  return {
    runId,
    providerKind: first.source.providerKind,
    observedAt: latest.observedAt,
    status,
    liveness,
    warnings: [],
    readOnlyDecision,
    ...(workspace === undefined ? {} : { workspace }),
    ...(progress === undefined ? {} : { progress }),
    ...(process === undefined ? {} : { process }),
    ...(result === undefined ? {} : { result }),
    ...(logs === undefined ? {} : { logs }),
    ...(capacity === undefined ? {} : { capacity }),
    ...(controlInbox === undefined ? {} : { controlInbox }),
  };
}

function observationStatusFromPayload(
  payload: JsonObject,
): RunObservationSnapshot["status"] | undefined {
  const status = stringFromJson(payload.status);
  switch (status) {
    case "running":
    case "stopped":
    case "completed":
    case "failed":
    case "unknown":
      return status;
    default:
      return undefined;
  }
}

function observationLivenessFromPayload(
  payload: JsonObject,
): RunObservationSnapshot["liveness"] | undefined {
  const liveness = stringFromJson(payload.liveness);
  switch (liveness) {
    case "alive":
    case "dead":
    case "stale":
    case "unknown":
      return liveness;
    default:
      return undefined;
  }
}

function decisionFromPayload(
  payload: JsonObject,
): RunObservationSnapshot["readOnlyDecision"] | undefined {
  const source = objectFromJson(payload.readOnlyDecision) ?? payload;
  const kind = stringFromJson(source.kind);
  const reason = stringFromJson(source.reason);
  if (!kind || !reason) return undefined;
  switch (kind) {
    case "keep_watching":
    case "review_completed":
    case "manual_review_required":
    case "capacity_blocked":
    case "stale_needs_inspection":
    case "unsafe_state_mismatch":
      return {
        kind,
        reason,
        safeMessage:
          "Decision was rebuilt from run events. Inspect live runtime before control actions.",
        evidence: stringArrayFromJson(source.evidence),
      };
    default:
      return undefined;
  }
}

function progressFromPayload(payload: JsonObject): RunObservationProgress {
  return {
    ...(stringFromJson(payload.status) === undefined
      ? {}
      : { status: stringFromJson(payload.status) as string }),
    ...(stringFromJson(payload.updatedAt) === undefined
      ? {}
      : { updatedAt: stringFromJson(payload.updatedAt) as string }),
    ...(numberFromJson(payload.heartbeatAgeMs) === undefined
      ? {}
      : { heartbeatAgeMs: numberFromJson(payload.heartbeatAgeMs) as number }),
    ...(numberFromJson(payload.staleAfterMs) === undefined
      ? {}
      : { staleAfterMs: numberFromJson(payload.staleAfterMs) as number }),
    ...(booleanFromJson(payload.stale) === undefined
      ? {}
      : { stale: booleanFromJson(payload.stale) as boolean }),
    ...(booleanFromJson(payload.silentStale) === undefined
      ? {}
      : { silentStale: booleanFromJson(payload.silentStale) as boolean }),
    ...(booleanFromJson(payload.heartbeatOnlyNoOutput) === undefined
      ? {}
      : {
        heartbeatOnlyNoOutput: booleanFromJson(
          payload.heartbeatOnlyNoOutput,
        ) as boolean,
      }),
    ...(numberFromJson(payload.attemptCount) === undefined
      ? {}
      : { attemptCount: numberFromJson(payload.attemptCount) as number }),
    ...(stringFromJson(payload.currentAccount) === undefined
      ? {}
      : { currentAccount: stringFromJson(payload.currentAccount) as string }),
  };
}

function workspaceFromPayload(payload: JsonObject): RunObservationWorkspace {
  return {
    ...(stringFromJson(payload.path) === undefined
      ? {}
      : { path: stringFromJson(payload.path) as string }),
    ...(stringFromJson(payload.key) === undefined
      ? {}
      : { key: stringFromJson(payload.key) as string }),
    ...(booleanFromJson(payload.exists) === undefined
      ? {}
      : { exists: booleanFromJson(payload.exists) as boolean }),
    ...(booleanFromJson(payload.dirty) === undefined
      ? {}
      : { dirty: booleanFromJson(payload.dirty) as boolean }),
    ...(numberFromJson(payload.changedFilesCount) === undefined
      ? {}
      : { changedFilesCount: numberFromJson(payload.changedFilesCount) as number }),
    changedFiles: stringArrayFromJson(payload.changedFiles),
    ...(stringFromJson(payload.warning) === undefined
      ? {}
      : { warning: stringFromJson(payload.warning) as string }),
  };
}

function resultFromPayload(payload: JsonObject): RunObservationResult {
  return {
    ...(booleanFromJson(payload.exists) === undefined
      ? {}
      : { exists: booleanFromJson(payload.exists) as boolean }),
    ...(stringFromJson(payload.status) === undefined
      ? {}
      : { status: stringFromJson(payload.status) as string }),
    ...(stringFromJson(payload.reason) === undefined
      ? {}
      : { reason: stringFromJson(payload.reason) as string }),
    ...(stringFromJson(payload.updatedAt) === undefined
      ? {}
      : { updatedAt: stringFromJson(payload.updatedAt) as string }),
  };
}

function outputFromPayload(payload: JsonObject): RunLogExcerpt {
  return {
    exists: true,
    ...(numberFromJson(payload.byteLength) === undefined
      ? {}
      : { byteLength: numberFromJson(payload.byteLength) as number }),
    ...(stringFromJson(payload.updatedAt) === undefined
      ? {}
      : { updatedAt: stringFromJson(payload.updatedAt) as string }),
  };
}

function capacityFromEventPayload(
  payload: JsonObject,
): readonly RunCapacityHint[] | undefined {
  const items = objectArrayFromJson(payload.capacity);
  if (items === undefined) return undefined;
  return items.map((item) => ({
    ...(stringFromJson(item.account) === undefined
      ? {}
      : { account: stringFromJson(item.account) as string }),
    ...(stringFromJson(item.status) === undefined
      ? {}
      : { status: stringFromJson(item.status) as string }),
    ...(stringFromJson(item.availability) === undefined
      ? {}
      : { availability: stringFromJson(item.availability) as string }),
    ...(stringFromJson(item.reason) === undefined
      ? {}
      : { reason: stringFromJson(item.reason) as string }),
    ...(stringFromJson(item.cooldownUntil) === undefined
      ? {}
      : { cooldownUntil: stringFromJson(item.cooldownUntil) as string }),
    ...(stringFromJson(item.warning) === undefined
      ? {}
      : { warning: stringFromJson(item.warning) as string }),
  }));
}

function controlInboxFromEventPayload(
  payload: JsonObject,
): RunControlInboxSummary | undefined {
  const source = objectFromJson(payload.controlInbox);
  if (source === undefined) return undefined;
  return {
    ...(numberFromJson(source.pendingCount) === undefined
      ? {}
      : { pendingCount: numberFromJson(source.pendingCount) as number }),
    ...(numberFromJson(source.deliveredCount) === undefined
      ? {}
      : { deliveredCount: numberFromJson(source.deliveredCount) as number }),
    ...(numberFromJson(source.blockedDeliveryCount) === undefined
      ? {}
      : {
        blockedDeliveryCount: numberFromJson(
          source.blockedDeliveryCount,
        ) as number,
      }),
    ...(booleanFromJson(source.safeToContinue) === undefined
      ? {}
      : { safeToContinue: booleanFromJson(source.safeToContinue) as boolean }),
    ...(stringFromJson(source.latestSignalAt) === undefined
      ? {}
      : { latestSignalAt: stringFromJson(source.latestSignalAt) as string }),
    ...(stringFromJson(source.latestDeliveredAt) === undefined
      ? {}
      : { latestDeliveredAt: stringFromJson(source.latestDeliveredAt) as string }),
  };
}
