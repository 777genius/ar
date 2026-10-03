import { sameRunEventSource } from "./run-event-source";
import type { RunEventSource } from "./run-event-types";
import {
  type RunObservationPort,
  type RunObservationRequest,
  RunObservationService,
  type RunObservationSnapshot,
} from "./run-observability";
import {
  RunEventSeverity,
  RunEventType,
  type JsonObject,
  type JsonValue,
  type RunEvent,
  type RunEventAppendResult,
  type RunEventProjectionResult,
  type RunEventProjectionState,
  type RunEventProjectionStateStorePort,
  type RunEventStorePort,
} from "./run-event-types";
import { makeRunEvent } from "./run-event-codec";
import { runEventProjectionStateFromSnapshot } from "./run-event-projection-state";
import { runEventProjectionStateFromEvents } from "./run-event-replay";
import {
  capacityPayload,
  capacitySeverity,
  compactJsonObject,
  controlInboxPayload,
  controlInboxSeverity,
  decisionSeverity,
  jsonArray,
  resultSeverity,
  runEventSourceFromSnapshot,
  snapshotPayload,
  workspacePayload,
} from "./run-event-payload";

export class RunEventProjectionService {
  private readonly observationService: RunObservationService;

  constructor(private readonly options: {
    readonly observationPort: RunObservationPort;
    readonly eventStore: RunEventStorePort;
    readonly stateStore: RunEventProjectionStateStorePort;
    readonly providerKind?: RunEventSource["providerKind"];
    readonly hostId?: string;
    readonly registryRootDir?: string;
    readonly clock?: { now(): Date };
  }) {
    this.observationService = new RunObservationService(
      options.observationPort,
      options.clock === undefined ? {} : { clock: options.clock },
    );
  }

  async projectRun(
    input: RunObservationRequest,
  ): Promise<RunEventProjectionResult & {
    readonly appendResult: RunEventAppendResult;
    readonly recoveryAppendResult?: RunEventAppendResult;
  }> {
    const transact = async (source: RunEventSource) =>
      this.options.stateStore.withProjectionLock(input.runId, async () => {
        const pending = await this.options.stateStore.readPendingProjection(input.runId, source);
        if (pending && !sameRunEventSource(pending.nextState.source, source)) {
          throw new Error("run_event_projection_source_mismatch");
        }
        const recoveryAppendResult = pending ? await this.commitProjection(pending) : undefined;
        const snapshot = await this.observationService.observeRun(input);
        if (snapshot.runId !== input.runId || snapshot.providerKind !== source.providerKind) {
          throw new Error("run_event_projection_source_mismatch");
        }
        const storedState = await this.options.stateStore.readProjectionState(snapshot.runId, source);
        if (storedState && !sameRunEventSource(storedState.source, source)) {
          throw new Error("run_event_projection_source_mismatch");
        }
        const previousState = storedState ?? await this.recoverProjectionStateFromEvents(snapshot.runId, source);
        const projected = projectRunObservationEvents({ snapshot, previousState, ...source });
        await this.options.stateStore.writePendingProjection(projected);
        const appendResult = await this.commitProjection(projected);
        return { ...projected, appendResult,
          ...(recoveryAppendResult === undefined ? {} : { recoveryAppendResult }),
        };
      }, source);
    const sourceOptions = {
      ...(this.options.hostId === undefined ? {} : { hostId: this.options.hostId }),
      ...(this.options.registryRootDir === undefined ? {} : { registryRootDir: this.options.registryRootDir }),
    };
    if (this.options.providerKind !== undefined) {
      return transact({ providerKind: this.options.providerKind, ...sourceOptions });
    }
    // Compatibility discovery does not publish state; observe afresh under the source lock.
    const snapshot = await this.observationService.observeRun(input);
    return transact({ providerKind: snapshot.providerKind, ...sourceOptions });
  }

  private async commitProjection(projected: RunEventProjectionResult): Promise<RunEventAppendResult> {
    const appendResult = await this.options.eventStore.append(projected.events);
    await this.options.stateStore.writeProjectionState(projected.nextState);
    await this.options.stateStore.clearPendingProjection(projected.nextState.runId, projected.nextState.source);
    return appendResult;
  }

  private async recoverProjectionStateFromEvents(
    runId: string, source: RunEventSource,
  ): Promise<RunEventProjectionState | null> {
    const replayed = await this.options.eventStore.read({ runId, sourceProviderKind: source.providerKind,
      ...(source.registryRootDir === undefined ? {} : { sourceRegistryRootDir: source.registryRootDir }) });
    return runEventProjectionStateFromEvents(replayed.events.filter(event => sameRunEventSource(event.source, source)));
  }
}

export function projectRunObservationEvents(input: {
  readonly snapshot: RunObservationSnapshot;
  readonly previousState?: RunEventProjectionState | null;
  readonly hostId?: string;
  readonly registryRootDir?: string;
  readonly sequenceStart?: number;
}): RunEventProjectionResult {
  const revision = (input.previousState?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("run_event_projection_revision_exhausted");
  }
  let nextState = { ...runEventProjectionStateFromSnapshot(input.snapshot), revision };
  const previous = input.previousState ?? null;
  const events: RunEvent[] = [];
  const source = runEventSourceFromSnapshot({
    snapshot: input.snapshot,
    providerKind: nextState.providerKind,
    ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
    ...(input.registryRootDir === undefined
      ? {}
      : { registryRootDir: input.registryRootDir }),
  });
  nextState = { ...nextState, source };
  if (previous && previous.source && !sameRunEventSource(previous.source, source)) throw new Error("run_event_projection_source_mismatch");
  const push = (
    type: RunEventType,
    severity: RunEventSeverity,
    payload: JsonObject,
    idempotencyParts: readonly JsonValue[],
  ) => {
    const sequence = input.sequenceStart === undefined
      ? undefined
      : input.sequenceStart + events.length;
    events.push(makeRunEvent({
      runId: input.snapshot.runId,
      type,
      severity,
      occurredAt: input.snapshot.observedAt,
      ...(sequence === undefined ? {} : { sequence }),
      source,
      payload: { ...payload, projectionRevision: revision },
      idempotencyParts: ["projection", revision, ...idempotencyParts],
    }));
  };

  const lifecycleChanged = !previous || previous.status !== nextState.status ||
    previous.liveness !== nextState.liveness ||
    previous.lifecycleSignature !== nextState.lifecycleSignature;
  if (lifecycleChanged) {
    push(
      RunEventType.ObservationRecorded,
      RunEventSeverity.Info,
      { ...snapshotPayload(input.snapshot), progress: compactJsonObject({ ...input.snapshot.progress }),
        process: compactJsonObject({ alive: input.snapshot.process?.alive,
          aliveReason: input.snapshot.process?.aliveReason, supervisor: input.snapshot.process?.supervisor,
          pid: input.snapshot.process?.pid }) },
      ["initial", nextState.status, nextState.liveness],
    );
  }

  if (
    !previous ||
    previous.progressStatus !== nextState.progressStatus ||
    previous.progressUpdatedAt !== nextState.progressUpdatedAt
  ) {
    push(
      RunEventType.ProgressUpdated,
      RunEventSeverity.Info,
      compactJsonObject({
        status: input.snapshot.progress?.status,
        updatedAt: input.snapshot.progress?.updatedAt,
        attemptCount: input.snapshot.progress?.attemptCount,
        currentAccount: input.snapshot.progress?.currentAccount,
        heartbeatAgeMs: input.snapshot.progress?.heartbeatAgeMs,
        staleAfterMs: input.snapshot.progress?.staleAfterMs,
        stale: input.snapshot.progress?.stale,
        silentStale: input.snapshot.progress?.silentStale,
        heartbeatOnlyNoOutput: input.snapshot.progress?.heartbeatOnlyNoOutput,
      }),
      ["progress", nextState.progressStatus ?? null, nextState.progressUpdatedAt ?? null],
    );
  }

  if (
    previous?.logByteLength !== undefined &&
    nextState.logByteLength !== undefined &&
    nextState.logByteLength > previous.logByteLength
  ) {
    push(
      RunEventType.OutputGrew,
      RunEventSeverity.Info,
      compactJsonObject({
        byteLength: nextState.logByteLength,
        previousByteLength: previous.logByteLength,
        updatedAt: input.snapshot.logs?.updatedAt,
      }),
      ["output", nextState.logByteLength, input.snapshot.logs?.updatedAt ?? null],
    );
  }

  if (!previous || previous.workspaceSignature !== nextState.workspaceSignature) {
    push(
      RunEventType.WorkspaceChanged,
      input.snapshot.workspace?.dirty ? RunEventSeverity.Warning : RunEventSeverity.Info,
      workspacePayload(input.snapshot.workspace),
      ["workspace", nextState.workspaceSignature ?? null],
    );
  }

  if (
    !previous ||
    previous.resultStatus !== nextState.resultStatus ||
    previous.resultReason !== nextState.resultReason ||
    previous.resultUpdatedAt !== nextState.resultUpdatedAt
  ) {
    push(
      RunEventType.ResultUpdated,
      resultSeverity(input.snapshot.result?.status),
      compactJsonObject({
        exists: input.snapshot.result?.exists,
        status: input.snapshot.result?.status,
        reason: input.snapshot.result?.reason,
        updatedAt: input.snapshot.result?.updatedAt,
      }),
      [
        "result",
        nextState.resultStatus ?? null,
        nextState.resultReason ?? null,
        nextState.resultUpdatedAt ?? null,
      ],
    );
  }

  if (
    !previous ||
    previous.decisionKind !== nextState.decisionKind ||
    previous.decisionReason !== nextState.decisionReason
  ) {
    push(
      RunEventType.DecisionChanged,
      decisionSeverity(input.snapshot.readOnlyDecision.kind),
      compactJsonObject({
        kind: input.snapshot.readOnlyDecision.kind,
        reason: input.snapshot.readOnlyDecision.reason,
        evidence: jsonArray(input.snapshot.readOnlyDecision.evidence),
      }),
      [
        "decision",
        nextState.decisionKind ?? null,
        nextState.decisionReason ?? null,
      ],
    );
  }

  if (!previous || previous.capacitySignature !== nextState.capacitySignature) {
    push(
      RunEventType.CapacityChanged,
      capacitySeverity(input.snapshot.capacity),
      compactJsonObject({ capacity: capacityPayload(input.snapshot.capacity) }),
      ["capacity", nextState.capacitySignature ?? null],
    );
  }

  if (!previous || previous.controlInboxSignature !== nextState.controlInboxSignature) {
    push(
      RunEventType.ControlInboxChanged,
      controlInboxSeverity(input.snapshot.controlInbox),
      compactJsonObject({ controlInbox: controlInboxPayload(input.snapshot.controlInbox) }),
      ["controlInbox", nextState.controlInboxSignature ?? null],
    );
  }

  if (
    input.snapshot.progress?.status === "maintenance_paused" &&
    previous?.progressStatus !== "maintenance_paused"
  ) {
    push(
      RunEventType.MaintenancePaused,
      RunEventSeverity.Warning,
      compactJsonObject({
        reason: input.snapshot.result?.reason,
        progressUpdatedAt: input.snapshot.progress.updatedAt,
      }),
      ["maintenance", input.snapshot.progress.updatedAt ?? null],
    );
  }

  if (
    (input.snapshot.liveness === "stale" || input.snapshot.progress?.stale === true) &&
    previous?.liveness !== input.snapshot.liveness
  ) {
    push(
      RunEventType.Stale,
      RunEventSeverity.Warning,
      compactJsonObject({
        liveness: input.snapshot.liveness,
        heartbeatAgeMs: input.snapshot.progress?.heartbeatAgeMs,
        staleAfterMs: input.snapshot.progress?.staleAfterMs,
      }),
      ["stale", input.snapshot.liveness, input.snapshot.progress?.heartbeatAgeMs ?? null],
    );
  }

  if (
    input.snapshot.readOnlyDecision.kind === "unsafe_state_mismatch" &&
    previous?.decisionKind !== "unsafe_state_mismatch"
  ) {
    push(
      RunEventType.UnsafeStateDetected,
      RunEventSeverity.Critical,
      compactJsonObject({
        reason: input.snapshot.readOnlyDecision.reason,
        evidence: jsonArray(input.snapshot.readOnlyDecision.evidence),
      }),
      ["unsafe", input.snapshot.readOnlyDecision.reason],
    );
  }

  if (input.snapshot.status === "failed" && previous?.status !== "failed") {
    push(
      RunEventType.Failed,
      RunEventSeverity.Critical,
      compactJsonObject({
        reason: input.snapshot.result?.reason,
        classification: input.snapshot.classification,
        recommendedAction: input.snapshot.recommendedAction,
      }),
      ["failed", input.snapshot.result?.reason ?? null],
    );
  }

  if (
    input.snapshot.readOnlyDecision.kind === "manual_review_required" &&
    input.snapshot.status !== "failed" &&
    previous?.decisionKind !== "manual_review_required"
  ) {
    push(
      RunEventType.Blocked,
      RunEventSeverity.Blocked,
      compactJsonObject({
        reason: input.snapshot.readOnlyDecision.reason,
        status: input.snapshot.status,
        liveness: input.snapshot.liveness,
      }),
      ["blocked", input.snapshot.readOnlyDecision.reason],
    );
  }

  if (input.snapshot.status === "completed" && previous?.status !== "completed") {
    push(
      RunEventType.Completed,
      RunEventSeverity.Info,
      compactJsonObject({
        resultStatus: input.snapshot.result?.status,
        workspaceDirty: input.snapshot.workspace?.dirty,
        changedFilesCount: input.snapshot.workspace?.changedFilesCount,
      }),
      ["completed", input.snapshot.result?.updatedAt ?? input.snapshot.observedAt],
    );
  }

  return {
    events,
    nextState,
  };
}
