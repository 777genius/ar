import { createHash } from "node:crypto";
import { boundCodexGoalBriefCompactMcpEnvelope } from "./codex-goal-mcp-compact-bounds";
import { CodexGoalBriefDetail } from "./codex-goal-mcp-inputs";

type JsonObject = Readonly<Record<string, unknown>>;

export type CodexGoalBriefResponseOptions = Readonly<{
  detail: CodexGoalBriefDetail;
  registryRootDir?: string;
  jobId?: string;
  staleAfterMs?: number;
  targetCommit?: string;
  targetWorkspacePath?: string;
  logTailLines: number;
  afterRevision?: string;
}>;

const briefKeys = [
  "workerAlive", "workerSupervisorKind", "workerAliveReason", "workerProcessAlive",
  "workerFreshProgressAlive", "workerHealth", "statusView", "baseRevision",
  "baseRevisionStatus", "baseRevisionReasons", "handoffArtifacts", "handoffBaseCommit",
  "handoffPatchPath", "handoffSummaryPath", "handoffManifestPath",
  "handoffManifestSha256", "handoffArtifactError", "activeWriterRisk",
  "activeWriterRiskReasons", "isStale", "silentStale", "heartbeatOnlyNoOutput",
  "progressStatus", "progressResultStatus", "progressResultReason", "progressAttemptCount",
  "progressCurrentAccount", "currentAccount", "lastFailureReason", "changedFiles",
  "safeToContinue", "hasAvailableAccount", "availableDedupedAccounts",
  "needsHumanRelogin", "invalidAccounts", "duplicateAccounts", "lifecycleMarkers",
  "lifecycleMarkerTypes", "maintenancePaused", "capacityBlockedAccounts",
  "nextBestTool", "nextBestReason", "nextBestCommand",
] as const;

const statusKeys = [
  "tmuxAlive", "resultExists", "resultStatus", "resultReason", "workspaceExists",
  "workspaceDirty", "changedFiles", "logExists", "progressExists",
  "progressStatus", "progressProcessAlive", "appServerProcessAlive",
  "progressResultStatus", "progressResultReason", "progressAttemptCount",
  "progressCurrentAccount", "runtimeEventsExists",
  "lastRuntimeEvent", "lastRuntimeEventLevel", "recommendedAction", "warnings",
  "dirtyFileCount", "dirtyFilesCount",
] as const;

const workerHealthKeys = [
  "alive", "freshProgressAlive", "stale", "silentStale", "heartbeatOnlyNoOutput",
  "blocked", "safeToContinue", "liveness", "progressFreshness", "activeWriterRisk",
  "reasons",
] as const;

const statusViewKeys = [
  "model", "effort", "serviceTier", "account", "runtimeVersion", "runtimeBuild",
  "accessBoundary", "baseCommit", "targetCommit", "baseStatus", "staleAfterMs",
  "handoffStatus", "dirtyFilesCount", "activeWriterRisk", "safeToContinue",
  "nextBestActionHint",
] as const;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(source: JsonObject, keys: readonly string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) output[key] = source[key];
  }
  return output;
}

function withChangedFileCounts(brief: Record<string, unknown>, status: Record<string, unknown>): void {
  const briefChangedFiles = brief.changedFiles;
  const statusChangedFiles = status.changedFiles;
  if (Array.isArray(briefChangedFiles) && brief.changedFileCount === undefined) {
    brief.changedFileCount = briefChangedFiles.length;
  }
  if (Array.isArray(statusChangedFiles)) {
    if (status.changedFileCount === undefined) status.changedFileCount = statusChangedFiles.length;
    if (status.dirtyFileCount === undefined) status.dirtyFileCount = statusChangedFiles.length;
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function semanticRevision(value: JsonObject, options: CodexGoalBriefResponseOptions): string {
  const scope = {
    schema: "codex_goal_brief.compact.v1",
    registryRootDir: options.registryRootDir ?? null,
    jobId: options.jobId ?? null,
    staleAfterMs: options.staleAfterMs ?? null,
    targetCommit: options.targetCommit ?? null,
    targetWorkspacePath: options.targetWorkspacePath ?? null,
    logTailLines: options.logTailLines,
  };
  return createHash("sha256")
    .update(JSON.stringify(stableValue({ scope, value })))
    .digest("hex");
}

/** Project the application/full view only after its shape has been verified. */
export function buildCodexGoalBriefMcpResponse(
  full: JsonObject,
  options: CodexGoalBriefResponseOptions,
): JsonObject {
  if (options.detail === CodexGoalBriefDetail.Full) return full;
  if (full.ok !== true || typeof full.registryRootDir !== "string" ||
      typeof full.jobId !== "string" || !isObject(full.brief) || !isObject(full.status)) {
    return full;
  }

  const brief = pick(full.brief, briefKeys);
  const status = pick(full.status, statusKeys);
  if (isObject(full.brief.workerHealth)) {
    brief.workerHealth = pick(full.brief.workerHealth, workerHealthKeys);
  }
  if (isObject(full.brief.statusView)) {
    brief.statusView = pick(full.brief.statusView, statusViewKeys);
  }
  if (options.logTailLines > 0) {
    brief.recentCommands = full.brief.recentCommands;
    brief.recentLogTail = full.brief.recentLogTail;
  }
  withChangedFileCounts(brief, status);
  const semanticProjected: JsonObject = {
    ok: true,
    registryRootDir: full.registryRootDir,
    jobId: full.jobId,
    detail: CodexGoalBriefDetail.Compact,
    unchanged: false,
    brief,
    status,
  };
  // Hash before bounding. A change after a visible array/string prefix must still
  // invalidate afterRevision, otherwise polling can falsely report unchanged.
  const revision = semanticRevision(semanticProjected, {
    ...options,
    registryRootDir: full.registryRootDir,
    jobId: full.jobId,
  });
  if (options.afterRevision === revision) {
    return boundCodexGoalBriefCompactMcpEnvelope({
      ok: true,
      registryRootDir: full.registryRootDir,
      jobId: full.jobId,
      detail: CodexGoalBriefDetail.Compact,
      unchanged: true,
      revision,
    });
  }
  return boundCodexGoalBriefCompactMcpEnvelope({ ...semanticProjected, revision });
}
