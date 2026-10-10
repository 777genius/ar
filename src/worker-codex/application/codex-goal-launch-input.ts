import { assertCodexGoalStorageTransportSupported, parseCodexGoalStorageData } from "./codex-goal-storage-data";
import { optionalWorkerMode } from "../project-control-worker-mode";
import { childConfigFromRecord, assertChildGoalConfig } from "../child-execution-confinement";
import { CODEX_WORKER_DEFAULT_MODEL, CODEX_WORKER_DEFAULT_REASONING_EFFORT } from "../codex-worker-defaults";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { defaultCodexGoalAuthRoot } from "./codex-goal-account-roots";
import {
  assertCodexGoalProviderSandboxModeAllowed,
  optionalCodexGoalProviderSandboxMode,
  parseCodexGoalEditMode,
} from "../codex-goal-control-modes";
import {
  optionalCodexGoalAccessBoundary,
  optionalCodexGoalNetworkAccess,
  parseCodexGoalProjectAccessScope,
} from "../codex-goal-access-plan";
import type { CodexGoalInput } from "./codex-goal-use-case-inputs";
import { optionalCodexGoalModelBackend } from "../codex-goal-model-backend";
import { optionalCodexGoalMimoAccountSlots } from "../codex-goal-mimo-account-slots";
import {
  accountNames,
  booleanValue,
  positiveIntegerValue,
  requiredRawString,
  requiredString,
  resolvePath,
  stringValue,
  workerReportModeValue,
} from "./codex-goal-input-values";
import type {
  CodexGoalLaunchInput,
  CodexGoalOutputFormat,
} from "../codex-goal-ops";
import {
  codexGoalAccountSlots,
  codexGoalProgressPath,
  type CodexGoalRunConfig,
} from "../codex-goal-runner";

import { CODEX_GOAL_DEFAULT_TIMEOUT_MS } from "./codex-goal-launch-defaults";
export { CODEX_GOAL_DEFAULT_TIMEOUT_MS } from "./codex-goal-launch-defaults";

type JsonObject = Readonly<Record<string, unknown>>;

const defaultAuthRoot = defaultCodexGoalAuthRoot;
const defaultTimeoutMs = CODEX_GOAL_DEFAULT_TIMEOUT_MS;

export async function goalLaunchInput(args: CodexGoalInput): Promise<CodexGoalLaunchInput> {
  // Capture the caller's closed pair before config-file IO can yield control.
  const argumentStorage = parseCodexGoalStorageData(args);
  const argumentSnapshot = { ...args, ...argumentStorage };
  const cwd = resolvePath(process.cwd(), argumentSnapshot.cwd ?? process.cwd());
  const fileConfig = argumentSnapshot.configPath
    ? await readGoalConfigFile(resolvePath(cwd, argumentSnapshot.configPath))
    : {};
  // Validate each explicit source before merging; partial/malformed NEW data
  // must not disappear behind an override and silently become a legacy run.
  parseCodexGoalStorageData(fileConfig);
  const merged = mergeDefined(fileConfig, argumentSnapshot);
  return goalLaunchInputFromRecord(merged, cwd);
}

/** Stored manifests have no config-file transport. Keep their planning pure,
 * sharing every resolved default with the asynchronous public loader. */
export function goalLaunchInputFromRecord(merged: JsonObject, cwd: string): CodexGoalLaunchInput {
  const storageData = parseCodexGoalStorageData(merged);
  assertCodexGoalStorageTransportSupported(merged);
  const jobRootDir = requiredString(merged.jobRootDir, "jobRootDir", cwd);
  const durableHandoffRootDir = stringValue(merged.durableHandoffRootDir);
  const taskId = requiredRawString(merged.taskId, "taskId");
  const jobId = stringValue(merged.jobId);
  const authRootDir = resolvePath(
    cwd,
    stringValue(merged.authRootDir) ?? defaultAuthRoot,
  );
  const workspacePath = requiredString(merged.workspacePath, "workspacePath", cwd);
  const promptPath = requiredString(merged.promptPath, "promptPath", cwd);
  const accounts = codexGoalAccountSlots(
    accountNames(merged.accounts),
    optionalCodexGoalMimoAccountSlots(merged.mimoAccounts).mimoAccounts,
  );
  if (!accounts.length) throw new Error("accounts are required");
  const controlModes = goalControlModesFromRecord(merged);
  const accessBoundary = optionalCodexGoalAccessBoundary(merged.accessBoundary);
  const projectAccessScope = parseCodexGoalProjectAccessScope(
    merged.projectAccessScope,
  );
  const networkAccess = optionalCodexGoalNetworkAccess(merged.networkAccess);
  const workerMode = optionalWorkerMode(merged.workerMode);
  const taskTimeoutMs = positiveIntegerValue(merged.taskTimeoutMs, "taskTimeoutMs") ??
    defaultTimeoutMs;
  const appServerStartupTimeoutMs = positiveIntegerValue(
    merged.appServerStartupTimeoutMs,
    "appServerStartupTimeoutMs",
  );
  const progressHeartbeatMs = positiveIntegerValue(
    merged.progressHeartbeatMs,
    "progressHeartbeatMs",
  ) ?? 60_000;
  const staleLockMs = positiveIntegerValue(merged.staleLockMs, "staleLockMs");
  const maxAccountCycles = positiveIntegerValue(
    merged.maxAccountCycles,
    "maxAccountCycles",
  ) ?? 5;
  const config: CodexGoalRunConfig = {
    ...storageData,
    ...childConfigFromRecord(merged),
    ...(storageData.storage ? { runtimeHomeRootDir: join(jobRootDir, "home"),
      durableHandoffRootDir: join(jobRootDir, "durable-handoffs") } : {}),
    ...(jobId === undefined ? {} : { jobId }),
    jobRootDir,
    ...(durableHandoffRootDir === undefined
      ? {}
      : {
          durableHandoffRootDir: resolvePath(
            cwd,
            durableHandoffRootDir,
          ),
        }),
    authRootDir,
    workspacePath,
    promptPath,
    ...(stringValue(merged.codexGoalObjective)
      ? { codexGoalObjective: stringValue(merged.codexGoalObjective) as string }
      : {}),
    taskId,
    accounts,
    ...optionalCodexGoalMimoAccountSlots(merged.mimoAccounts),
    outputPath: resolvePath(
      cwd,
      stringValue(merged.outputPath) ??
        join(storageData.storage ? join(jobRootDir, "output") : jobRootDir, `${taskId}.latest-result.json`),
    ),
    progressPath: resolvePath(
      cwd,
      stringValue(merged.progressPath) ??
        (storageData.storage ? join(jobRootDir, "output", `${taskId}.progress.json`) : codexGoalProgressPath({ jobRootDir, taskId })),
    ),
    model: stringValue(merged.model) ?? CODEX_WORKER_DEFAULT_MODEL,
    reasoningEffort:
      (stringValue(merged.reasoningEffort) ?? CODEX_WORKER_DEFAULT_REASONING_EFFORT) as NonNullable<CodexGoalRunConfig["reasoningEffort"]>,
    serviceTier:
      (stringValue(merged.serviceTier) ?? "default") as NonNullable<CodexGoalRunConfig["serviceTier"]>,
    executionEngine:
      (stringValue(merged.executionEngine) ?? "app-server-goal") as NonNullable<CodexGoalRunConfig["executionEngine"]>,
    ...(booleanValue(merged.checkpointRequired) ? { checkpointRequired: true } : {}),
    ...optionalCodexGoalModelBackend(merged.modelBackend),
    codexBinaryPath: stringValue(merged.codexBinaryPath) ?? "codex",
    ...controlModes,
    ...(accessBoundary === undefined ? {} : { accessBoundary }),
    ...(projectAccessScope === undefined ? {} : { projectAccessScope }),
    allowDangerFullAccess: booleanValue(merged.allowDangerFullAccess) ?? false,
    ...(networkAccess === undefined ? {} : { networkAccess }),
    ...(workerMode === undefined ? {} : { workerMode }),
    taskTimeoutMs,
    ...(appServerStartupTimeoutMs === undefined
      ? {}
      : { appServerStartupTimeoutMs }),
    progressHeartbeatMs,
    ...(staleLockMs === undefined ? {} : { staleLockMs }),
    maxAccountCycles,
    allowDuplicateAccountIdentities:
      booleanValue(merged.allowDuplicateAccountIdentities) ?? false,
    requireGitWorkspace: booleanValue(merged.requireGitWorkspace) ?? true,
    prewarmOnStart: booleanValue(merged.prewarmOnStart) ?? false,
    ...(workerReportModeValue(merged.workerReportMode) === undefined
      ? {}
      : { workerReportMode: workerReportModeValue(merged.workerReportMode) }),
  };
  const stateRootDir = stringValue(merged.stateRootDir) ?? (storageData.storage ? join(jobRootDir, "state") : undefined);
  const finalConfig = stateRootDir
    ? { ...config, stateRootDir: resolvePath(cwd, stateRootDir) }
    : config;
  assertChildGoalConfig(finalConfig);
  return {
    config: finalConfig,
    ...(stringValue(merged.tmuxSession)
      ? { tmuxSession: stringValue(merged.tmuxSession) as string }
      : {}),
    cwd,
    logPath: resolvePath(
      cwd,
      stringValue(merged.logPath) ?? join(jobRootDir, `${taskId}.log`),
    ),
    format: (stringValue(merged.outputFormat) ?? "json") as CodexGoalOutputFormat,
    cliCommand: defaultCliCommand(import.meta.url),
  };
}

export function goalControlModesFromRecord(
  value: JsonObject,
): Pick<CodexGoalRunConfig, "editMode" | "providerSandboxMode"> {
  const editModeValue = stringValue(value.editMode);
  const legacyPermissionModeValue = stringValue(value.permissionMode);
  const editMode = parseCodexGoalEditMode(
    editModeValue ?? legacyPermissionModeValue ?? "allow-edits",
    editModeValue === undefined && legacyPermissionModeValue !== undefined
      ? "permissionMode"
      : "editMode",
  );
  const providerSandboxMode = optionalCodexGoalProviderSandboxMode(
    stringValue(value.providerSandboxMode),
    "providerSandboxMode",
  );
  assertCodexGoalProviderSandboxModeAllowed({
    editMode,
    providerSandboxMode,
    fieldName: "providerSandboxMode",
  });
  return {
    editMode,
    ...(providerSandboxMode === undefined ? {} : { providerSandboxMode }),
  };
}

async function readGoalConfigFile(path: string): Promise<JsonObject> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("configPath must contain a JSON object");
  return parsed;
}

function defaultCliCommand(importMetaUrl: string): readonly string[] {
  return [
    execPath,
    join(dirname(fileURLToPath(importMetaUrl)), "..", "codex-goal-cli.js"),
  ];
}

function mergeDefined(...items: readonly JsonObject[]): JsonObject {
  const merged: Record<string, unknown> = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
