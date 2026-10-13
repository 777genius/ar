import { resolveCodexGoalPaths, resolveCodexGoalStorageRoot } from "./codex-goal-storage-paths";
import { CodexModelBackend, codexMimoDefaultModel } from "@vioxen/subscription-runtime/provider-codex";
import { assertCodexGoalStorageTransportSupported, parseCodexGoalStorageData } from "./codex-goal-storage-data";
import { childConfigFromRecord } from "../child-execution-confinement";
import { CODEX_WORKER_DEFAULT_MODEL, CODEX_WORKER_DEFAULT_REASONING_EFFORT } from "../codex-worker-defaults";
import { join } from "node:path";
import {
  defaultCodexGoalJobRoot,
  type CodexGoalJobManifestInput,
  type CodexGoalJobManifestPatch,
} from "../codex-goal-jobs";
import {
  optionalCodexGoalEditMode,
  optionalCodexGoalProviderSandboxMode,
} from "../codex-goal-control-modes";
import {
  optionalCodexGoalAccessBoundary,
  optionalCodexGoalNetworkAccess,
  parseCodexGoalProjectAccessScope,
} from "../codex-goal-access-plan";
import { defaultCodexGoalAuthRoot } from "./codex-goal-account-roots";
import { CodexGoalAccountSelectionMode } from "../codex-goal-account-selection-mode";
import { optionalCodexGoalModelBackend } from "../codex-goal-model-backend";
import { optionalCodexGoalMimoAccountSlots } from "../codex-goal-mimo-account-slots";
import { CODEX_GOAL_DEFAULT_TIMEOUT_MS } from "./codex-goal-launch-defaults";
import { goalControlModesFromRecord } from "./codex-goal-launch-input";
import type {
  CodexGoalJobCreateInput,
  CodexGoalJobUpdateInput,
} from "./codex-goal-use-case-inputs";
import {
  accountNames,
  booleanValue,
  numberValue,
  putIfDefined,
  requiredRawString,
  requiredString,
  resolvePath,
  stringValue,
  tagValues,
  workerReportModeValue,
} from "./codex-goal-input-values";

type JsonObject = Readonly<Record<string, unknown>>;

const defaultAuthRoot = defaultCodexGoalAuthRoot;
const defaultTimeoutMs = CODEX_GOAL_DEFAULT_TIMEOUT_MS;

export function jobManifestInputFromArgs(args: CodexGoalJobCreateInput): CodexGoalJobManifestInput {
  assertCodexGoalStorageTransportSupported(args);
  const cwd = resolvePath(process.cwd(), args.cwd ?? process.cwd());
  const jobId = requiredRawString(args.jobId, "jobId");
  const sourceEnv = args.sourceEnv ?? process.env;
  const storageRootDir = args.storageRootDir ?? sourceEnv.SUBSCRIPTION_RUNTIME_STORAGE_ROOT;
  const selectedPath = (value: string | undefined): string | undefined => value === undefined ? undefined : resolvePath(cwd, value);
  const paths = resolveCodexGoalPaths({
    taskId: args.taskId ?? jobId, jobId,
    storageRootDir: resolveCodexGoalStorageRoot(storageRootDir, cwd),
    jobRootDir: selectedPath(args.jobRootDir ?? sourceEnv.SUBSCRIPTION_RUNTIME_JOB_ROOT ?? (storageRootDir === undefined ? defaultCodexGoalJobRoot(jobId) : undefined)),
    workspacePath: selectedPath(args.workspacePath ?? sourceEnv.SUBSCRIPTION_RUNTIME_WORKSPACE_PATH),
    stateRootDir: selectedPath(args.stateRootDir), runtimeHomeRootDir: selectedPath(args.runtimeHomeRootDir),
    encryptionKeyPath: selectedPath(args.encryptionKeyPath), durableHandoffRootDir: selectedPath(args.durableHandoffRootDir),
    outputPath: selectedPath(args.outputPath), progressPath: selectedPath(args.progressPath),
    runtimeEventsPath: selectedPath(args.runtimeEventsPath), agentTempRootDir: selectedPath(args.agentTempRootDir),
    logPath: selectedPath(args.logPath), sourceEnv,
  });
  const jobRootDir = paths.jobRootDir;
  const modelBackend = optionalCodexGoalModelBackend(args.modelBackend);
  const mimo = modelBackend.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan;
  const controlModes = goalControlModesFromRecord(args as unknown as JsonObject);
  const accessBoundary = optionalCodexGoalAccessBoundary(args.accessBoundary);
  const projectAccessScope = parseCodexGoalProjectAccessScope(
    args.projectAccessScope,
  );
  const networkAccess = optionalCodexGoalNetworkAccess(args.networkAccess);
  return {
    ...parseCodexGoalStorageData(args),
    ...childConfigFromRecord(args as unknown as JsonObject),
    jobId,
    ...(stringValue(args.description) ? { description: stringValue(args.description) as string } : {}),
    ...(tagValues(args.tags).length ? { tags: tagValues(args.tags) } : {}),
    ...manifestPaths(paths),
    jobRootDir,
    authRootDir: resolvePath(cwd, args.authRootDir ?? defaultAuthRoot),
    ...(args.stateRootDir ? { stateRootDir: resolvePath(cwd, args.stateRootDir) } : {}),
    workspacePath: paths.workspacePath,
    promptPath: resolvePath(cwd, args.promptPath ?? join(jobRootDir, "prompt.md")),
    ...(stringValue(args.codexGoalObjective)
      ? { codexGoalObjective: stringValue(args.codexGoalObjective) as string }
      : {}),
    taskId: args.taskId ?? jobId,
    accounts: accountNames(args.accounts),
    ...optionalCodexGoalMimoAccountSlots(args.mimoAccounts),
    ...(args.outputPath ? { outputPath: resolvePath(cwd, args.outputPath) } : {}),
    ...(args.progressPath ? { progressPath: resolvePath(cwd, args.progressPath) } : {}),
    progressHeartbeatMs: args.progressHeartbeatMs ?? 60_000,
    ...(args.codexBinaryPath ? { codexBinaryPath: args.codexBinaryPath } : {}),
    model: args.model ?? (mimo ? codexMimoDefaultModel : CODEX_WORKER_DEFAULT_MODEL),
    reasoningEffort: args.reasoningEffort ?? CODEX_WORKER_DEFAULT_REASONING_EFFORT,
    serviceTier: args.serviceTier ?? "default",
    executionEngine: args.executionEngine ?? (mimo ? "app-server" : "app-server-goal"),
    ...(args.checkpointRequired === true ? { checkpointRequired: true } : {}),
    ...modelBackend,
    taskTimeoutMs: args.taskTimeoutMs ?? defaultTimeoutMs,
    ...(args.appServerStartupTimeoutMs
      ? { appServerStartupTimeoutMs: args.appServerStartupTimeoutMs }
      : {}),
    ...(args.staleLockMs ? { staleLockMs: args.staleLockMs } : {}),
    maxAccountCycles: args.maxAccountCycles ?? (mimo ? 1 : 5),
    ...controlModes,
    ...(accessBoundary === undefined ? {} : { accessBoundary }),
    ...(projectAccessScope === undefined ? {} : { projectAccessScope }),
    ...(args.allowDangerFullAccess === undefined
      ? {}
      : { allowDangerFullAccess: args.allowDangerFullAccess }),
    ...(networkAccess === undefined ? {} : { networkAccess }),
    allowDuplicateAccountIdentities: args.allowDuplicateAccountIdentities ?? false,
    requireGitWorkspace: args.requireGitWorkspace ?? true,
    prewarmOnStart: args.prewarmOnStart ?? false,
    ...(args.workerReportMode ? { workerReportMode: args.workerReportMode } : {}),
    tmuxSession: args.tmuxSession ?? jobId,
    ...(args.cwd ? { cwd } : {}),
    ...(args.logPath ? { logPath: resolvePath(cwd, args.logPath) } : {}),
    outputFormat: args.outputFormat ?? "json",
  };
}

function manifestPaths(paths: ReturnType<typeof resolveCodexGoalPaths>) {
  const { sourceEnv: _env, storageRootDir: _root, ...resolved } = paths;
  return resolved;
}

export function jobManifestPatchFromArgs(args: CodexGoalJobUpdateInput): CodexGoalJobManifestPatch {
  const cwd = resolvePath(process.cwd(), args.cwd ?? process.cwd());
  const patch: Record<string, unknown> = { ...parseCodexGoalStorageData(args) };
  putIfDefined(patch, "description", stringValue(args.description));
  const tags = tagValues(args.tags);
  if (args.tags !== undefined) patch.tags = tags;
  putIfDefined(patch, "jobRootDir", args.jobRootDir && resolvePath(cwd, args.jobRootDir));
  putIfDefined(patch, "authRootDir", args.authRootDir && resolvePath(cwd, args.authRootDir));
  putIfDefined(patch, "stateRootDir", args.stateRootDir && resolvePath(cwd, args.stateRootDir));
  putIfDefined(patch, "runtimeHomeRootDir", args.runtimeHomeRootDir && resolvePath(cwd, args.runtimeHomeRootDir));
  putIfDefined(patch, "encryptionKeyPath", args.encryptionKeyPath && resolvePath(cwd, args.encryptionKeyPath));
  putIfDefined(patch, "runtimeEventsPath", args.runtimeEventsPath && resolvePath(cwd, args.runtimeEventsPath));
  putIfDefined(patch, "agentTempRootDir", args.agentTempRootDir && resolvePath(cwd, args.agentTempRootDir));
  putIfDefined(patch, "durableHandoffRootDir", args.durableHandoffRootDir && resolvePath(cwd, args.durableHandoffRootDir));
  putIfDefined(patch, "workspacePath", args.workspacePath && resolvePath(cwd, args.workspacePath));
  putIfDefined(patch, "promptPath", args.promptPath && resolvePath(cwd, args.promptPath));
  putIfDefined(patch, "codexGoalObjective", stringValue(args.codexGoalObjective));
  putIfDefined(patch, "taskId", stringValue(args.taskId));
  if (args.accounts !== undefined) {
    patch.accounts = accountNames(args.accounts);
    patch.accountSelectionMode = CodexGoalAccountSelectionMode.Explicit;
  }
  putIfDefined(
    patch,
    "mimoAccounts",
    optionalCodexGoalMimoAccountSlots(args.mimoAccounts).mimoAccounts,
  );
  putIfDefined(patch, "outputPath", args.outputPath && resolvePath(cwd, args.outputPath));
  putIfDefined(patch, "progressPath", args.progressPath && resolvePath(cwd, args.progressPath));
  putIfDefined(patch, "progressHeartbeatMs", numberValue(args.progressHeartbeatMs));
  putIfDefined(patch, "codexBinaryPath", stringValue(args.codexBinaryPath));
  putIfDefined(patch, "model", stringValue(args.model));
  putIfDefined(patch, "reasoningEffort", stringValue(args.reasoningEffort));
  putIfDefined(patch, "serviceTier", stringValue(args.serviceTier));
  putIfDefined(patch, "executionEngine", stringValue(args.executionEngine));
  putIfDefined(
    patch,
    "modelBackend",
    optionalCodexGoalModelBackend(args.modelBackend).modelBackend,
  );
  putIfDefined(patch, "taskTimeoutMs", numberValue(args.taskTimeoutMs));
  putIfDefined(
    patch,
    "appServerStartupTimeoutMs",
    numberValue(args.appServerStartupTimeoutMs),
  );
  putIfDefined(patch, "staleLockMs", numberValue(args.staleLockMs));
  putIfDefined(patch, "maxAccountCycles", numberValue(args.maxAccountCycles));
  putIfDefined(
    patch,
    "editMode",
    optionalCodexGoalEditMode(stringValue(args.editMode), "editMode"),
  );
  putIfDefined(
    patch,
    "providerSandboxMode",
    optionalCodexGoalProviderSandboxMode(
      stringValue(args.providerSandboxMode),
      "providerSandboxMode",
    ),
  );
  putIfDefined(
    patch,
    "accessBoundary",
    optionalCodexGoalAccessBoundary(args.accessBoundary),
  );
  putIfDefined(
    patch,
    "projectAccessScope",
    parseCodexGoalProjectAccessScope(args.projectAccessScope),
  );
  putIfDefined(
    patch,
    "allowDangerFullAccess",
    booleanValue(args.allowDangerFullAccess),
  );
  putIfDefined(
    patch,
    "networkAccess",
    optionalCodexGoalNetworkAccess(args.networkAccess),
  );
  putIfDefined(
    patch,
    "allowDuplicateAccountIdentities",
    booleanValue(args.allowDuplicateAccountIdentities),
  );
  putIfDefined(patch, "requireGitWorkspace", booleanValue(args.requireGitWorkspace));
  putIfDefined(patch, "prewarmOnStart", booleanValue(args.prewarmOnStart));
  putIfDefined(patch, "workerReportMode", workerReportModeValue(args.workerReportMode));
  putIfDefined(patch, "tmuxSession", stringValue(args.tmuxSession));
  putIfDefined(patch, "cwd", args.cwd && cwd);
  putIfDefined(patch, "logPath", args.logPath && resolvePath(cwd, args.logPath));
  putIfDefined(patch, "outputFormat", stringValue(args.outputFormat));
  return patch as CodexGoalJobManifestPatch;
}
