import {
  LocalFileRunEventProjectionStateStore,
  LocalFileRunEventStore,
} from "@vioxen/subscription-runtime/store-local-file";
import { createLocalProviderRuntimeRegistry } from "@vioxen/subscription-runtime/worker-local";
import {
  RunEventProviderKind,
  RunObservationService,
  projectRunObservationEvents,
  projectRunReadModelsFromEvents,
  providerFailedRunObservationSnapshot,
  runEventProviderKindFromString,
  type ProviderRunObservationInput,
  type ProviderRuntimeRegistry,
  type RunEventReadResult,
  type RunObservationSnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import {
  summarizeRunObservationSnapshots,
} from "./codex-goal-mcp-observation-projection";
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

type JsonObject = Readonly<Record<string, unknown>>;

let cachedProviderRuntimeRegistry: ProviderRuntimeRegistry | undefined;

function defaultProviderRuntimeRegistry(): ProviderRuntimeRegistry {
  return (cachedProviderRuntimeRegistry ??= createLocalProviderRuntimeRegistry());
}

const DEFAULT_MCP_EVENT_LIMIT = 100;
const MAX_MCP_EVENT_LIMIT = 500;

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
        `Run observation for provider '${providerKindInput}' is not implemented yet. Watch did not start, stop, continue, recover or deliver work.`,
    };
  }
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
  const limit = numberValue(args.limit);
  const listedRunIds = explicitJobIds.length
    ? explicitJobIds
    : await service.listRunIds();
  const runIds = limit === undefined
    ? listedRunIds
    : listedRunIds.slice(0, limit);
  const snapshots = await Promise.all(
    runIds.map(async (runId) => {
      try {
        return await service.observeRun({
          runId,
          ...(tailLines === undefined ? {} : { tailLines }),
          includeChangedFiles: booleanValue(args.includeChangedFiles) === true,
          includeLogTail: booleanValue(args.includeLogTail) === true,
        });
      } catch (error) {
        if (observation.observeFailedRun) {
          return observation.observeFailedRun({ runId, error });
        }
        return providerFailedRunObservationSnapshot({ runId, providerKind, error });
      }
    }),
  );
  const observationFailures = snapshots
    .filter((snapshot) =>
      snapshot.warnings.some((warning) => warning.code === "run_observation_failed")
    )
    .map((snapshot) => ({
      runId: snapshot.runId,
      warnings: snapshot.warnings.filter((warning) =>
        warning.code === "run_observation_failed"
      ),
    }));
  return {
    ok: observationFailures.length === 0,
    mode: "read_only",
    sideEffects: [],
    providerKind,
    ...observation.responseLocator,
    totalRuns: listedRunIds.length,
    returnedRuns: snapshots.length,
    truncated: limit === undefined ? false : listedRunIds.length > runIds.length,
    summary: summarizeRunObservationSnapshots(snapshots),
    ...(observationFailures.length ? { observationFailures } : {}),
    snapshots,
  };
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
    ...(providerKind === undefined ? {} : { sourceProviderKind: providerKind }),
    ...runEventTypeFilter(args),
  });
  return {
    ok: result.warnings.length === 0,
    mode: "read_only",
    sideEffects: [],
    providerKind: providerKind ?? "all",
    registryRootDir,
    eventRootDir,
    effectiveLimit,
    returnedEvents: result.events.length,
    pageFull: result.events.length === effectiveLimit,
    hasMore: result.events.length === effectiveLimit,
    nextCursor: result.nextCursor?.value,
    warnings: result.warnings,
    events: result.events,
  };
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
  const state = await stateStore.readProjectionState(runId);
  if (state === null) {
    const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
    const read = await eventStore.read({ runId });
    const replayed = projectRunReadModelsFromEvents(read.events);
    if (
      replayed !== null &&
      (providerKind === undefined || replayed.providerKind === providerKind)
    ) {
      return {
        ok: read.warnings.length === 0,
        mode: "read_only_state",
        sideEffects: [],
        providerKind: replayed.providerKind,
        registryRootDir,
        eventRootDir,
        runId,
        observedAt: replayed.observedAt,
        replayOnly: true,
        warnings: read.warnings,
        readModels: replayed,
      };
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
  return {
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
  };
}

export async function planAgentRunEventCompaction(
  args: AgentRunEventCompactionMcpArgs,
): Promise<JsonObject> {
  const registryRootDir = registryRootFromArgs(args);
  const eventRootDir = runEventRootFromArgs(args, registryRootDir);
  const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
  const policy = runEventRetentionPolicyFromArgs(args);
  const plan = await eventStore.planCompaction(policy);
  return {
    ok: plan.warnings.length === 0,
    mode: "compaction_plan",
    sideEffects: [],
    registryRootDir,
    eventRootDir,
    policy,
    plan,
  };
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
    return {
      ok: false,
      mode: "compact_events",
      sideEffects: [],
      registryRootDir,
      eventRootDir,
      policy,
      reason: "confirm_compact_required",
      safeMessage:
        "Compaction rewrites the local event log. Re-run with confirmCompact=true after reviewing the plan.",
      plan,
    };
  }
  const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
  const result = await eventStore.compact(policy);
  return {
    ok: result.warnings.length === 0 &&
      result.cursorRewrites.every((rewrite) => !rewrite.invalidatedUnreadEvents),
    mode: "compact_events",
    sideEffects: ["rewrite_run_event_log", "rewrite_delivery_cursors"],
    registryRootDir,
    eventRootDir,
    policy,
    result,
  };
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
  const watch = await watchAgentRuns({
    ...args,
    providerKind,
    includeChangedFiles: booleanValue(args.includeChangedFiles) === true,
    includeLogTail: false,
  }, registry);
  const snapshots = Array.isArray(watch.snapshots)
    ? watch.snapshots as readonly RunObservationSnapshot[]
    : [];
  const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
  const stateStore = new LocalFileRunEventProjectionStateStore({
    rootDir: eventRootDir,
  });
  const projectedRuns = [];
  let appendedCount = 0;
  let skippedDuplicateCount = 0;
  for (const snapshot of snapshots) {
    const previousState = await stateStore.readProjectionState(snapshot.runId);
    const projection = projectRunObservationEvents({
      snapshot,
      previousState,
      ...(stringValue(args.hostId) === undefined
        ? {}
        : { hostId: stringValue(args.hostId) as string }),
      registryRootDir,
    });
    const appendResult = await eventStore.append(projection.events);
    await stateStore.writeProjectionState(projection.nextState);
    appendedCount += appendResult.appendedCount;
    skippedDuplicateCount += appendResult.skippedDuplicateCount;
    projectedRuns.push({
      runId: snapshot.runId,
      projectedEvents: projection.events.length,
      appendedEvents: appendResult.appendedCount,
      skippedDuplicateEvents: appendResult.skippedDuplicateCount,
      eventTypes: projection.events.map((event) => event.type),
      decision: snapshot.readOnlyDecision.kind,
      status: snapshot.status,
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
    ...runEventTypeFilter(args),
  });
  return {
    ok: watch.ok === true && readBack.warnings.length === 0,
    mode: "project_events",
    sideEffects: ["append_run_events", "write_projection_state"],
    providerKind,
    registryRootDir,
    eventRootDir,
    totalRuns: watch.totalRuns,
    returnedRuns: snapshots.length,
    appendedCount,
    skippedDuplicateCount,
    effectiveEventLimit,
    returnedEvents: readBack.events.length,
    pageFull: readBack.events.length === effectiveEventLimit,
    hasMore: readBack.events.length === effectiveEventLimit,
    warnings: readBack.warnings,
    projectedRuns,
    nextCursor: readBack.nextCursor?.value,
    events: readBack.events,
  };
}
