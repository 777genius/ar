import { mapCodexGoalObservations } from "./application/codex-goal-bounded-map";
import { boundedRunWatchResponse, runWatchPage } from "./codex-goal-mcp-run-watch-page";
import {
  LocalFileRunEventProjectionStateStore,
  LocalFileRunEventStore,
} from "@vioxen/subscription-runtime/store-local-file";
import { createLocalProviderRuntimeRegistry } from "@vioxen/subscription-runtime/worker-local";
import {
  RunEventProviderKind,
  RunObservationService,
  RunEventProjectionService,
  projectRunReadModelsFromEvents,
  providerFailedRunObservationSnapshot,
  runEventProviderKindFromString,
  type ProviderRunObservationInput,
  type ProviderRunObservation,
  type ProviderRuntimeRegistry,
  type RunEventReadResult,
  type RunObservationSnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import {
  booleanValue,
  numberValue,
  requiredRawString,
  stringValue,
} from "./codex-goal-mcp-values";
import { jobIdsFromValue } from "./application/codex-goal-worker-control-view";
import {
  optionalRunEventProviderKind,
  registryRootFromArgs,
  runEventRetentionPolicyFromArgs,
  runEventRootFromArgs,
  runEventTypeFilter,
  type AgentRunEventCompactionMcpArgs,
  type AgentRunEventsMcpArgs,
  type AgentRunProjectEventsMcpArgs,
  type AgentRunStateMcpArgs,
  type AgentRunWatchMcpArgs,
} from "./codex-goal-mcp-inputs";
import {
  boundedEventHistoryMetadataResponse,
  boundedRunEventCompactionPlan,
  boundedRunEventResponse,
  boundedRunEventWarnings,
} from "./codex-goal-mcp-run-event-response";

type JsonObject = Readonly<Record<string, unknown>>;

let cachedProviderRuntimeRegistry: ProviderRuntimeRegistry | undefined;

function defaultProviderRuntimeRegistry(): ProviderRuntimeRegistry {
  return (cachedProviderRuntimeRegistry ??= createLocalProviderRuntimeRegistry());
}

const DEFAULT_MCP_EVENT_LIMIT = 100;
const MAX_MCP_EVENT_LIMIT = 500;
const MAX_MCP_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_MCP_SCAN_LINES = 10_000;
const MAX_MCP_WARNINGS = 50;
const MAX_MCP_EVENT_LINE_BYTES = 3 * 1024 * 1024;

function mcpEventLimit(value: unknown): number {
  const requested = numberValue(value);
  if (requested === undefined || !Number.isInteger(requested) || requested <= 0) {
    return DEFAULT_MCP_EVENT_LIMIT;
  }
  return Math.min(requested, MAX_MCP_EVENT_LIMIT);
}

export async function watchAgentRuns(
  args: AgentRunWatchMcpArgs,
  registry: ProviderRuntimeRegistry = defaultProviderRuntimeRegistry(),
): Promise<JsonObject> {
  const providerKindInput = stringValue(args.providerKind) ?? RunEventProviderKind.Codex;
  const providerKind = runEventProviderKindFromString(providerKindInput);
  if (!registry.supported().includes(providerKind)) {
    return {
      ok: false,
      mode: "read_only",
      sideEffects: [],
      providerKind,
      supportedProviderKinds: registry.supported(),
      reason: "provider_observation_not_implemented",
      safeMessage:
        `Run observation for provider '${providerKindInput.slice(0, 256)}' is not implemented yet. Watch did not start, stop, continue, recover or deliver work.`,
    };
  }
  const { observation, service, listedRunIds, tailLines } = await prepareRunObservation(args, registry, providerKind);
  const page = runWatchPage({
    runIds: listedRunIds,
    filter: { providerKind, registryRootDir: registryRootFromArgs(args), stateRootDir: args.stateRootDir,
      runArtifactsRootDir: args.runArtifactsRootDir, cwd: args.cwd,
      jobIds: [...new Set([stringValue(args.jobId), ...jobIdsFromValue(args.jobIds)].filter(Boolean))].sort(),
      staleAfterMs: args.staleAfterMs, tailLines: args.tailLines,
      includeChangedFiles: args.includeChangedFiles === true, includeLogTail: args.includeLogTail === true },
    ...(numberValue(args.limit) === undefined ? {} : { limit: numberValue(args.limit) as number }),
    ...(stringValue(args.cursor) === undefined ? {} : { cursor: stringValue(args.cursor) as string }),
  });
  const snapshots = await mapCodexGoalObservations(page.runIds, (runId) => observeSafely(runId, args, providerKind, observation, service, tailLines));
  return boundedRunWatchResponse({
    base: { ok: true, mode: "read_only", sideEffects: [], providerKind, ...observation.responseLocator },
    snapshots, page,
  });
}

async function prepareRunObservation(args: AgentRunWatchMcpArgs, registry: ProviderRuntimeRegistry, providerKind: RunEventProviderKind) {
  const registryRootDir = registryRootFromArgs(args);
  const staleAfterMs = numberValue(args.staleAfterMs);
  const tailLines = numberValue(args.tailLines);
  const observationInput: ProviderRunObservationInput = {
    registryRootDir,
    ...(args.stateRootDir === undefined ? {} : { stateRootDir: args.stateRootDir }),
    ...(args.runArtifactsRootDir === undefined
      ? {}
      : { runArtifactsRootDir: args.runArtifactsRootDir }),
    ...(stringValue(args.cwd) === undefined
      ? {}
      : { cwd: stringValue(args.cwd) as string }),
    ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
    ...(tailLines === undefined ? {} : { tailLines }),
    includeLogTail: booleanValue(args.includeLogTail) === true,
  };
  const observation = registry.get(providerKind).observation(observationInput);
  const service = new RunObservationService(observation);
  const explicitJobIds = [
    ...(stringValue(args.jobId) ? [stringValue(args.jobId) as string] : []),
    ...jobIdsFromValue(args.jobIds),
  ];
  const listedRunIds = [...new Set(explicitJobIds.length ? explicitJobIds : await service.listRunIds())];
  return { observation, service, listedRunIds, registryRootDir, tailLines };
}

async function observeSafely(
  runId: string, args: AgentRunWatchMcpArgs, providerKind: RunEventProviderKind,
  observation: ProviderRunObservation,
  service: RunObservationService, tailLines: number | undefined,
): Promise<RunObservationSnapshot> {
  try {
    return await service.observeRun({ runId,
      ...(tailLines === undefined ? {} : { tailLines }),
      includeChangedFiles: booleanValue(args.includeChangedFiles) === true,
      includeLogTail: booleanValue(args.includeLogTail) === true,
    });
  } catch (error) {
    return observation.observeFailedRun
      ? observation.observeFailedRun({ runId, error })
      : providerFailedRunObservationSnapshot({ runId, providerKind, error });
  }
}

export async function readAgentRunEvents(
  args: AgentRunEventsMcpArgs,
): Promise<JsonObject> {
  const registryRootDir = registryRootFromArgs(args);
  const eventRootDir = runEventRootFromArgs(args, registryRootDir);
  const providerKind = optionalRunEventProviderKind(args.providerKind);
  const effectiveLimit = mcpEventLimit(args.limit);
  const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
  const result = await eventStore.read({
    ...(stringValue(args.cursor) === undefined
      ? {}
      : { cursor: { value: stringValue(args.cursor) as string } }),
    ...(stringValue(args.jobId) === undefined
      ? {}
      : { runId: stringValue(args.jobId) as string }),
    limit: effectiveLimit,
    maxScannedBytes: MAX_MCP_SCAN_BYTES,
    maxScannedLines: MAX_MCP_SCAN_LINES,
    maxWarnings: MAX_MCP_WARNINGS,
    maxLineBytes: MAX_MCP_EVENT_LINE_BYTES,
    ...(providerKind === undefined ? {} : { sourceProviderKind: providerKind }),
    ...runEventTypeFilter(args),
  });
  return boundedRunEventResponse({
    base: {
    ok: result.warnings.length === 0,
    mode: "read_only",
    sideEffects: [],
    providerKind: providerKind ?? "all",
    registryRootDir,
    eventRootDir,
    },
    read: result,
    ...(stringValue(args.cursor) === undefined
      ? {}
      : { requestedCursor: stringValue(args.cursor) as string }),
    effectiveLimit,
  });
}

export async function readAgentRunState(
  args: AgentRunStateMcpArgs,
): Promise<JsonObject> {
  const registryRootDir = registryRootFromArgs(args);
  const eventRootDir = runEventRootFromArgs(args, registryRootDir);
  const providerKind = optionalRunEventProviderKind(args.providerKind);
  const runId = requiredRawString(args.jobId, "jobId");
  const stateStore = new LocalFileRunEventProjectionStateStore({
    rootDir: eventRootDir,
  });
  let resolvedProvider = providerKind;
  if (resolvedProvider === undefined) {
    const candidates = new Set<RunEventProviderKind>();
    const history = await new LocalFileRunEventStore({ rootDir: eventRootDir }).read({ runId, sourceRegistryRootDir: registryRootDir });
    for (const event of history.events) candidates.add(event.source.providerKind);
    for (const kind of Object.values(RunEventProviderKind)) {
      if (await stateStore.readProjectionState(runId, { providerKind: kind, registryRootDir })) candidates.add(kind);
    }
    if (candidates.size > 1) return { ok: false, mode: "read_only_state", sideEffects: [], runId,
      reason: "run_event_state_source_ambiguous", safeMessage: "Specify providerKind for this registry and run." };
    resolvedProvider = [...candidates][0] ?? RunEventProviderKind.Codex;
  }
  const source = { providerKind: resolvedProvider, registryRootDir };
  const state = await stateStore.readProjectionState(runId, source);
  if (state === null) {
    const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
    const read = await eventStore.read({ runId, sourceProviderKind: source.providerKind, sourceRegistryRootDir: registryRootDir, maxWarnings: MAX_MCP_WARNINGS });
    const replayed = projectRunReadModelsFromEvents(read.events);
    if (
      replayed !== null &&
      (providerKind === undefined || replayed.providerKind === providerKind)
    ) {
      return boundedEventHistoryMetadataResponse({
        ok: read.warnings.length === 0,
        mode: "read_only_state",
        sideEffects: [],
        providerKind: replayed.providerKind,
        registryRootDir,
        eventRootDir,
        runId,
        observedAt: replayed.observedAt,
        replayOnly: true,
        ...boundedRunEventWarnings(read.warnings, {
          totalWarningCount: read.totalWarningCount ?? read.warnings.length,
          warningCounts: read.warningCounts ?? {},
        }),
        readModels: replayed,
      });
    }
    return {
      ok: false,
      mode: "read_only_state",
      sideEffects: [],
      providerKind: providerKind ?? "all",
      registryRootDir,
      eventRootDir,
      runId,
      reason: "projection_state_not_found",
      safeMessage:
        "No projected run state exists yet and no replayable run events were found. Run agent_run_project_events first to observe and project this run.",
    };
  }
  if (providerKind !== undefined && state.providerKind !== providerKind) {
    return {
      ok: false,
      mode: "read_only_state",
      sideEffects: [],
      providerKind,
      registryRootDir,
      eventRootDir,
      runId,
      reason: "projection_state_provider_mismatch",
      safeMessage:
        "Projected run state exists for a different provider. No worker action was taken.",
    };
  }
  return boundedEventHistoryMetadataResponse({
    ok: true,
    mode: "read_only_state",
    sideEffects: [],
    providerKind: state.providerKind,
    registryRootDir,
    eventRootDir,
    runId,
    observedAt: state.observedAt,
    status: state.status,
    liveness: state.liveness,
    readModels: state.readModels,
    state,
  });
}

export async function planAgentRunEventCompaction(
  args: AgentRunEventCompactionMcpArgs,
): Promise<JsonObject> {
  const registryRootDir = registryRootFromArgs(args);
  const eventRootDir = runEventRootFromArgs(args, registryRootDir);
  const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
  const policy = runEventRetentionPolicyFromArgs(args);
  const plan = await eventStore.planCompaction(policy);
  return boundedEventHistoryMetadataResponse({
    ok: plan.warnings.length === 0,
    mode: "compaction_plan",
    sideEffects: [],
    registryRootDir,
    eventRootDir,
    policy,
    plan: boundedRunEventCompactionPlan(plan),
  });
}

export async function compactAgentRunEvents(
  args: AgentRunEventCompactionMcpArgs,
): Promise<JsonObject> {
  const registryRootDir = registryRootFromArgs(args);
  const eventRootDir = runEventRootFromArgs(args, registryRootDir);
  const policy = runEventRetentionPolicyFromArgs(args);
  if (booleanValue(args.confirmCompact) !== true) {
    const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
    const plan = await eventStore.planCompaction(policy);
    return boundedEventHistoryMetadataResponse({
      ok: false,
      mode: "compact_events",
      sideEffects: [],
      registryRootDir,
      eventRootDir,
      policy,
      reason: "confirm_compact_required",
      safeMessage:
        "Compaction rewrites the local event log. Re-run with confirmCompact=true after reviewing the plan.",
      plan: boundedRunEventCompactionPlan(plan),
    });
  }
  const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
  const result = await eventStore.compact(policy);
  return boundedEventHistoryMetadataResponse({
    ok: result.warnings.length === 0 &&
      result.cursorRewrites.every((rewrite) => !rewrite.invalidatedUnreadEvents),
    mode: "compact_events",
    sideEffects: ["rewrite_run_event_log", "rewrite_delivery_cursors"],
    registryRootDir,
    eventRootDir,
    policy,
    result: boundedRunEventCompactionPlan(result),
  });
}

export async function projectAgentRunEvents(
  args: AgentRunProjectEventsMcpArgs,
  registry: ProviderRuntimeRegistry = defaultProviderRuntimeRegistry(),
): Promise<JsonObject> {
  const providerKind = optionalRunEventProviderKind(args.providerKind) ??
    RunEventProviderKind.Codex;
  if (!registry.supported().includes(providerKind)) {
    return {
      ok: false,
      mode: "project_events",
      sideEffects: [],
      providerKind,
      supportedProviderKinds: registry.supported(),
      reason: "provider_event_projection_not_implemented",
      safeMessage:
        `Run event projection for provider '${providerKind}' is not implemented yet. Projection did not start, stop, continue, recover or deliver work.`,
    };
  }
  const registryRootDir = registryRootFromArgs(args);
  const eventRootDir = runEventRootFromArgs(args, registryRootDir);
  const { observation, service, listedRunIds, tailLines } = await prepareRunObservation(args, registry, providerKind);
  // Public watch pagination must never limit the internal projection selection.
  const limit = numberValue(args.limit);
  const runIds = limit === undefined ? listedRunIds : listedRunIds.slice(0, limit);
  const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
  const stateStore = new LocalFileRunEventProjectionStateStore({ rootDir: eventRootDir });
  const snapshots: RunObservationSnapshot[] = [];
  const projectedRuns = [];
  let appendedCount = 0;
  let skippedDuplicateCount = 0;
  let recoveredAppendedCount = 0;
  let recoveredSkippedDuplicateCount = 0;
  const projectionService = new RunEventProjectionService({
    observationPort: {
      observeRun: async ({ runId }) => {
        const snapshot = await observeSafely(runId, { ...args, includeLogTail: false }, providerKind, observation, service, tailLines);
        snapshots.push(snapshot);
        return snapshot;
      },
    },
    eventStore, stateStore, registryRootDir, providerKind,
    ...(stringValue(args.hostId) === undefined ? {} : { hostId: stringValue(args.hostId) as string }),
  });
  for (const runId of runIds) {
    const projection = await projectionService.projectRun({ runId });
    appendedCount += projection.appendResult.appendedCount;
    skippedDuplicateCount += projection.appendResult.skippedDuplicateCount;
    recoveredAppendedCount += projection.recoveryAppendResult?.appendedCount ?? 0;
    recoveredSkippedDuplicateCount += projection.recoveryAppendResult?.skippedDuplicateCount ?? 0;
    projectedRuns.push({
      runId,
      projectedEvents: projection.events.length,
      appendedEvents: projection.appendResult.appendedCount,
      skippedDuplicateEvents: projection.appendResult.skippedDuplicateCount,
      ...(projection.recoveryAppendResult ? { recoveryAppendResult: projection.recoveryAppendResult } : {}),
      eventTypes: projection.events.map((event) => event.type),
      decision: projection.nextState.decisionKind,
      status: projection.nextState.status,
      readModels: projection.nextState.readModels,
    });
  }
  const projectedRunIds = snapshots.map((snapshot) => snapshot.runId);
  const effectiveEventLimit = mcpEventLimit(args.eventLimit);
  const readBack: RunEventReadResult = await eventStore.read({
    ...(stringValue(args.cursor) === undefined
      ? {}
      : { cursor: { value: stringValue(args.cursor) as string } }),
    runIds: projectedRunIds,
    sourceProviderKind: providerKind,
    sourceRegistryRootDir: registryRootDir,
    limit: effectiveEventLimit,
    maxScannedBytes: MAX_MCP_SCAN_BYTES,
    maxScannedLines: MAX_MCP_SCAN_LINES,
    maxWarnings: MAX_MCP_WARNINGS,
    maxLineBytes: MAX_MCP_EVENT_LINE_BYTES,
    ...runEventTypeFilter(args),
  });
  const boundedProjectedRuns = projectedRuns.slice(0, 50);
  return boundedRunEventResponse({
    base: {
    ok: snapshots.every((snapshot) => !snapshot.warnings.some((warning) => warning.code === "run_observation_failed")) && readBack.warnings.length === 0,
    mode: "project_events",
    sideEffects: ["append_run_events", "write_projection_state"],
    providerKind,
    registryRootDir,
    eventRootDir,
    totalRuns: listedRunIds.length,
    returnedRuns: snapshots.length,
    appendedCount,
    skippedDuplicateCount,
    recoveredAppendedCount,
    recoveredSkippedDuplicateCount,
    totalAppendedCount: appendedCount + recoveredAppendedCount,
    totalSkippedDuplicateCount: skippedDuplicateCount + recoveredSkippedDuplicateCount,
    effectiveEventLimit,
    totalProjectedRuns: projectedRuns.length,
    projectedRunsTruncated: boundedProjectedRuns.length < projectedRuns.length,
    projectedRuns: boundedProjectedRuns,
    },
    read: readBack,
    ...(stringValue(args.cursor) === undefined
      ? {}
      : { requestedCursor: stringValue(args.cursor) as string }),
    effectiveLimit: effectiveEventLimit,
  });
}
