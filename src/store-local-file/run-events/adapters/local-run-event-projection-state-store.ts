import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { runEventSourceKey, sameRunEventSource, runEventProviderKindFromString,
  RunAccountCapacityStatus, RunControlInboxStatus, RunLivenessStatus, RunOutcomeStatus,
  RunRuntimeIssueKind, RunSafetyConfidence, RunSafetyStatus, RunWorkspaceStatus,
  RunEventType, type RunEventSource, type RunEventProjectionState, type RunEventProjectionResult,
  type RunEventProjectionStateStorePort, type RunEventReadModels,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalRunEventProjectionTransaction } from "./local-run-event-projection-transaction";
import { LocalFileRunEventStore, type LocalFileRunEventStoreOptions } from "./local-run-event-store";

export class LocalFileRunEventProjectionStateStore
  implements RunEventProjectionStateStorePort
{
  constructor(private readonly options: LocalFileRunEventStoreOptions) {}

  private transaction() {
    return new LocalRunEventProjectionTransaction(this.options, (id, source) => this.statePath(id, source), parseProjectionState);
  }
  withProjectionLock<T>(runId: string, operation: () => Promise<T>, source?: RunEventSource): Promise<T> {
    return this.transaction().withProjectionLock(runId, operation, source);
  }
  readPendingProjection(runId: string, source?: RunEventSource) { return this.transaction().readPendingProjection(runId, source); }
  writePendingProjection(projection: RunEventProjectionResult) { return this.transaction().writePendingProjection(projection); }
  clearPendingProjection(runId: string, source?: RunEventSource) { return this.transaction().clearPendingProjection(runId, source); }

  async readProjectionState(runId: string, source?: RunEventSource): Promise<RunEventProjectionState | null> {
    const state = await this.readState(runId, source);
    if (source) return state;
    const dir = join(this.options.rootDir, "run-event-projection-state");
    let entries: string[];
    try { entries = await readdir(dir); } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return state;
      throw error;
    }
    const candidates: RunEventProjectionState[] = [];
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}$/.test(entry)) continue;
      let candidate: RunEventProjectionState | null;
      try { candidate = parseProjectionState(JSON.parse(await readFile(join(dir, entry), "utf8"))); }
      catch (error) {
        if (error instanceof SyntaxError || (isNodeError(error) && error.code === "ENOENT")) continue;
        throw error;
      }
      if (candidate?.runId === runId && candidate.source && this.statePath(runId, candidate.source) === join(dir, entry)) candidates.push(candidate);
    }
    if (candidates.length > 1) throw new Error("run_event_projection_source_ambiguous");
    const candidate = candidates[0];
    if (candidate && state && (candidate.providerKind !== state.providerKind ||
        (candidate.revision ?? 0) < (state.revision ?? 0))) throw new Error("run_event_projection_source_ambiguous");
    return candidate ?? state;
  }

  private async readState(
    runId: string, source?: RunEventSource,
  ): Promise<RunEventProjectionState | null> {
    const path = this.statePath(runId, source);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        // Unscoped legacy state cannot establish registry ownership. Never guess.
        if (source) {
          const legacy = await this.readState(runId);
          if (legacy?.providerKind === source.providerKind) {
            const history = await new LocalFileRunEventStore(this.options).read({ runId });
            const owned = history.events.filter(event => sameRunEventSource(event.source, source));
            // Rebuild from the complete source journal instead of adopting unscoped state.
            // A compacted tail cannot prove the missing baseline and must fail closed.
            if (history.warnings.length > 0 || !owned.some(event =>
              event.type === RunEventType.ObservationRecorded && (event.payload.projectionRevision === 1 || event.payload.projectionRevision === undefined))) {
              throw new Error("legacy_run_event_projection_scope_ambiguous");
            }
          }
        }
        return null;
      }
      if (error instanceof SyntaxError) {
        await rm(path, { force: true });
        return null;
      }
      throw error;
    }
    const state = parseProjectionState(parsed);
    if (!state || state.runId !== runId || !sameRunEventSource(state.source, source)) {
      await rm(path, { force: true });
      return null;
    }
    return state;
  }

  async writeProjectionState(state: RunEventProjectionState): Promise<void> {
    await this.transaction().writeAtomic(this.statePath(state.runId, state.source), state);
  }

  private statePath(runId: string, source?: RunEventSource): string {
    const key = createHash("sha256").update(source === undefined ? runId : JSON.stringify([runId, runEventSourceKey(source)])).digest("hex");
    return join(this.options.rootDir, "run-event-projection-state", key);
  }
}

function parseProjectionState(value: unknown): RunEventProjectionState | null {
  if (!isRecord(value)) return null;
  if (
    value.schemaVersion !== 1 ||
    typeof value.runId !== "string" ||
    typeof value.providerKind !== "string" ||
    typeof value.observedAt !== "string" ||
    typeof value.status !== "string" ||
    typeof value.liveness !== "string"
  ) {
    return null;
  }
  if (value.revision !== undefined && (typeof value.revision !== "number" ||
      !Number.isSafeInteger(value.revision) || value.revision < 0)) return null;
  if (!optionalString(value.lifecycleSignature)) return null;
  if (!optionalString(value.progressStatus)) return null;
  if (!optionalString(value.progressUpdatedAt)) return null;
  if (!optionalString(value.resultStatus)) return null;
  if (!optionalString(value.resultReason)) return null;
  if (!optionalString(value.resultUpdatedAt)) return null;
  if (!optionalNumber(value.logByteLength)) return null;
  if (!optionalString(value.workspaceSignature)) return null;
  if (!optionalString(value.capacitySignature)) return null;
  if (!optionalString(value.controlInboxSignature)) return null;
  if (!optionalString(value.decisionKind)) return null;
  if (!optionalString(value.decisionReason)) return null;
  const providerKind = runEventProviderKindFromString(value.providerKind);
  let source: RunEventSource | undefined;
  if (value.source !== undefined) {
    if (!isRecord(value.source) || value.source.providerKind !== providerKind ||
      !optionalString(value.source.registryRootDir) || !optionalString(value.source.hostId)) return null;
    source = { providerKind,
      ...(value.source.registryRootDir === undefined ? {} : { registryRootDir: value.source.registryRootDir }),
      ...(value.source.hostId === undefined ? {} : { hostId: value.source.hostId }),
    };
  }
  return {
    schemaVersion: 1,
    ...(source === undefined ? {} : { source }),
    runId: value.runId,
    ...(value.revision === undefined ? {} : { revision: value.revision as number }),
    providerKind,
    ...(value.lifecycleSignature === undefined ? {} : { lifecycleSignature: value.lifecycleSignature }),
    observedAt: value.observedAt,
    status: value.status,
    liveness: value.liveness,
    ...(value.progressStatus === undefined
      ? {}
      : { progressStatus: value.progressStatus }),
    ...(value.progressUpdatedAt === undefined
      ? {}
      : { progressUpdatedAt: value.progressUpdatedAt }),
    ...(value.resultStatus === undefined ? {} : { resultStatus: value.resultStatus }),
    ...(value.resultReason === undefined ? {} : { resultReason: value.resultReason }),
    ...(value.resultUpdatedAt === undefined
      ? {}
      : { resultUpdatedAt: value.resultUpdatedAt }),
    ...(value.logByteLength === undefined
      ? {}
      : { logByteLength: value.logByteLength }),
    ...(value.workspaceSignature === undefined
      ? {}
      : { workspaceSignature: value.workspaceSignature }),
    ...(value.capacitySignature === undefined
      ? {}
      : { capacitySignature: value.capacitySignature }),
    ...(value.controlInboxSignature === undefined
      ? {}
      : { controlInboxSignature: value.controlInboxSignature }),
    ...(value.decisionKind === undefined ? {} : { decisionKind: value.decisionKind }),
    ...(value.decisionReason === undefined
      ? {}
      : { decisionReason: value.decisionReason }),
    readModels: parseReadModels(value.readModels) ?? unknownReadModels({
      runId: value.runId,
      providerKind,
      observedAt: value.observedAt,
      ...(value.decisionReason === undefined ? {} : { reason: value.decisionReason }),
    }),
  };
}

function parseReadModels(value: unknown): RunEventReadModels | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (
    typeof value.runId !== "string" ||
    typeof value.providerKind !== "string" ||
    typeof value.observedAt !== "string" ||
    !isRecord(value.safety) ||
    !isRecord(value.liveness) ||
    !isRecord(value.workspace) ||
    !isRecord(value.accountCapacity) ||
    !isRecord(value.outcome) ||
    !isRecord(value.controlInbox)
  ) {
    return null;
  }
  if (!Object.values(RunSafetyStatus).includes(value.safety.status as RunSafetyStatus)) {
    return null;
  }
  if (
    typeof value.safety.safeToContinue !== "boolean" ||
    typeof value.safety.reviewOnly !== "boolean" ||
    typeof value.safety.issueKind !== "string" ||
    !Object.values(RunRuntimeIssueKind).includes(
      value.safety.issueKind as RunRuntimeIssueKind,
    ) ||
    typeof value.safety.reason !== "string" ||
    typeof value.safety.confidence !== "string" ||
    !Object.values(RunSafetyConfidence).includes(
      value.safety.confidence as RunSafetyConfidence,
    ) ||
    !stringArray(value.safety.evidence)
  ) {
    return null;
  }
  if (!Object.values(RunLivenessStatus).includes(value.liveness.status as RunLivenessStatus)) {
    return null;
  }
  if (!Object.values(RunWorkspaceStatus).includes(value.workspace.status as RunWorkspaceStatus)) {
    return null;
  }
  if (
    typeof value.workspace.reviewOnly !== "boolean" ||
    !stringArray(value.workspace.changedFilesSample)
  ) {
    return null;
  }
  if (
    !Object.values(RunAccountCapacityStatus).includes(
      value.accountCapacity.status as RunAccountCapacityStatus,
    ) ||
    typeof value.accountCapacity.totalHints !== "number" ||
    typeof value.accountCapacity.blockedCount !== "number" ||
    typeof value.accountCapacity.cooldownCount !== "number" ||
    !stringArray(value.accountCapacity.maskedAccounts) ||
    !stringArray(value.accountCapacity.reasons)
  ) {
    return null;
  }
  if (!Object.values(RunOutcomeStatus).includes(value.outcome.status as RunOutcomeStatus)) {
    return null;
  }
  if (
    !Object.values(RunControlInboxStatus).includes(
      value.controlInbox.status as RunControlInboxStatus,
    ) ||
    typeof value.controlInbox.pendingCount !== "number" ||
    typeof value.controlInbox.deliveredCount !== "number" ||
    typeof value.controlInbox.blockedDeliveryCount !== "number"
  ) {
    return null;
  }
  return value as unknown as RunEventReadModels;
}

function unknownReadModels(input: {
  readonly runId: string;
  readonly providerKind: RunEventReadModels["providerKind"];
  readonly observedAt: string;
  readonly reason?: string;
}): RunEventReadModels {
  return {
    schemaVersion: 1,
    runId: input.runId,
    providerKind: input.providerKind,
    observedAt: input.observedAt,
    safety: {
      status: RunSafetyStatus.Unknown,
      safeToContinue: false,
      reviewOnly: true,
      issueKind: RunRuntimeIssueKind.Unknown,
      reason: input.reason ?? "legacy_projection_without_read_models",
      confidence: RunSafetyConfidence.Low,
      evidence: [],
    },
    liveness: { status: RunLivenessStatus.Unknown },
    workspace: {
      status: RunWorkspaceStatus.Unknown,
      reviewOnly: true,
      changedFilesSample: [],
    },
    accountCapacity: {
      status: RunAccountCapacityStatus.Unknown,
      totalHints: 0,
      blockedCount: 0,
      cooldownCount: 0,
      maskedAccounts: [],
      reasons: [],
    },
    outcome: { status: RunOutcomeStatus.Unknown },
    controlInbox: {
      status: RunControlInboxStatus.Unknown,
      pendingCount: 0,
      deliveredCount: 0,
      blockedDeliveryCount: 0,
    },
  };
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalNumber(value: unknown): value is number | undefined {
  return value === undefined ||
    (typeof value === "number" && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
