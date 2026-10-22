import { resolveCodexGoalPaths, resolveCodexGoalStorageRoot } from "./application/codex-goal-storage-paths";
import { assertVerifiedHostedChildConfig } from "./hosted-child-slot-files";
import { parseChildLifetimeJson } from "@vioxen/subscription-runtime/core";
import { assertChildGoalConfig } from "./child-execution-confinement";
import { CODEX_WORKER_DEFAULT_MODEL, CODEX_WORKER_DEFAULT_REASONING_EFFORT } from "./codex-worker-defaults";
import { CodexModelBackend, codexModelBackendDefaultModel } from "@vioxen/subscription-runtime/provider-codex";
import { codexReasoningEfforts, type CodexReasoningEffort } from "../provider-codex/codex-json-execution-engine";
import { join } from "node:path";
import { assertJobStorageIntent, JobStorageHomeStateRequirement, JobStorageIntentKind } from "@vioxen/subscription-runtime/worker-core";
import { assertCodexSessionHomeProfile, CodexSessionHomeProfileKind, type CodexSessionHomeProfile } from "./codex-session-home-profile";
import {
  type ParsedFlags,
  flag,
  option,
  parseOptionalPositiveInteger,
  requiredOption,
  resolvePath,
} from "./codex-goal-cli-support";
import {
  codexGoalAccountSlots,
  type CodexGoalRunConfig,
} from "./codex-goal-runner";
import { optionalCodexGoalModelBackend } from "./codex-goal-model-backend";
import {
  assertCodexGoalProviderSandboxModeAllowed,
  optionalCodexGoalProviderSandboxMode,
  parseCodexGoalEditMode,
} from "./codex-goal-control-modes";
import {
  optionalCodexGoalAccessBoundary,
  optionalCodexGoalNetworkAccess,
  parseCodexGoalProjectAccessScopeJson,
} from "./codex-goal-access-plan";

type CodexGoalRunConfigWithAppServerStartupTimeout = CodexGoalRunConfig & {
  readonly appServerStartupTimeoutMs?: number;
};

export function runConfigFromFlags(
  values: ParsedFlags,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  jobRootDir: string | undefined,
  taskId: string,
  resolvedPaths?: ReturnType<typeof resolveCodexGoalPaths>,
): CodexGoalRunConfig {
  if (values.flags.has("--storage-root")) throw new Error("--storage-root requires a value");
  const pathOption = (flagName: string, envNames: readonly string[] = []): string | undefined => {
    const value = option(values, env, flagName, envNames);
    return value === undefined ? undefined : resolvePath(cwd, value);
  };
  const paths = resolvedPaths ?? resolveCodexGoalPaths({
    taskId, jobId: option(values, env, "--job-id", ["SUBSCRIPTION_RUNTIME_JOB_ID"]),
    storageRootDir: resolveCodexGoalStorageRoot(option(values, env, "--storage-root", ["SUBSCRIPTION_RUNTIME_STORAGE_ROOT"]), cwd),
    jobRootDir: jobRootDir === undefined ? undefined : resolvePath(cwd, jobRootDir),
    workspacePath: pathOption("--workspace", ["SUBSCRIPTION_RUNTIME_WORKSPACE_PATH", "MEMO_STACK_GOAL_WORKSPACE_PATH"]),
    stateRootDir: pathOption("--state-root"), runtimeHomeRootDir: pathOption("--runtime-home-root"),
    encryptionKeyPath: pathOption("--encryption-key-path"),
    durableHandoffRootDir: pathOption("--durable-handoff-root", ["SUBSCRIPTION_RUNTIME_DURABLE_HANDOFF_ROOT"]),
    outputPath: pathOption("--output"), progressPath: pathOption("--progress"),
    runtimeEventsPath: pathOption("--runtime-events"), agentTempRootDir: pathOption("--agent-temp-root"),
    logPath: pathOption("--log"), sourceEnv: env,
  });
  const authRootDir = resolvePath(
    cwd,
    option(values, env, "--auth-root", [
      "SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT",
    ]) ?? "~/.cache/subscription-runtime/live-codex-auth",
  );
  const accounts = codexGoalAccountSlots(
    splitCsv(
      requiredOption(values, env, "--accounts", ["CODEX_ACCOUNTS"]),
    ),
  );
  const effortValue = option(values, env, "--effort", [
    "CODEX_REASONING_EFFORT",
  ]) ?? CODEX_WORKER_DEFAULT_REASONING_EFFORT;
  if (!codexReasoningEfforts.includes(effortValue as CodexReasoningEffort)) {
    throw new Error(`--effort must be one of ${codexReasoningEfforts.join(", ")}`);
  }
  const reasoningEffort = effortValue as CodexGoalRunConfig["reasoningEffort"];
  const serviceTier = (option(values, env, "--service-tier", [
    "CODEX_SERVICE_TIER",
  ]) ?? "default") as CodexGoalRunConfig["serviceTier"];
  const executionEngine = (option(values, env, "--execution-engine", [
    "CODEX_EXECUTION_ENGINE",
  ]) ?? "app-server-goal") as CodexGoalRunConfig["executionEngine"];
  const modelBackend = optionalCodexGoalModelBackend(
    option(values, env, "--model-backend", ["CODEX_MODEL_BACKEND"]),
    "--model-backend",
  );
  const checkpointPublisherSocketPath = option(values, env, "--checkpoint-publisher-socket", [
    "SUBSCRIPTION_RUNTIME_CHECKPOINT_PUBLISHER_SOCKET",
  ]);
  const staleLockMs = parseOptionalPositiveInteger(
    option(values, env, "--stale-lock-ms", []),
    "--stale-lock-ms",
  );
  const editModeFlag = option(values, env, "--edit-mode", []);
  const legacyPermissionModeFlag = option(values, env, "--permission-mode", []);
  const editMode = parseCodexGoalEditMode(
    editModeFlag ?? legacyPermissionModeFlag ?? "allow-edits",
    editModeFlag === undefined && legacyPermissionModeFlag !== undefined
      ? "--permission-mode"
      : "--edit-mode",
  );
  const providerSandboxMode = optionalCodexGoalProviderSandboxMode(
    option(values, env, "--provider-sandbox-mode", []),
    "--provider-sandbox-mode",
  );
  const workerReportMode = parseCodexGoalWorkerReportMode(
    option(values, env, "--worker-report-mode", [
      "SUBSCRIPTION_RUNTIME_WORKER_REPORT_MODE",
    ]),
  );
  const appServerStartupTimeoutMs = parseOptionalPositiveInteger(
    option(values, env, "--app-server-startup-timeout-ms", [
      "SUBSCRIPTION_RUNTIME_APP_SERVER_STARTUP_TIMEOUT_MS",
    ]),
    "--app-server-startup-timeout-ms",
  );
  assertCodexGoalProviderSandboxModeAllowed({
    editMode,
    providerSandboxMode,
    fieldName: "--provider-sandbox-mode",
  });
  const accessBoundary = optionalCodexGoalAccessBoundary(
    option(values, env, "--access-boundary", [
      "SUBSCRIPTION_RUNTIME_ACCESS_BOUNDARY",
    ]),
    "--access-boundary",
  );
  const projectAccessScope = parseCodexGoalProjectAccessScopeJson(
    option(values, env, "--project-access-scope-json", [
      "SUBSCRIPTION_RUNTIME_PROJECT_ACCESS_SCOPE_JSON",
    ]),
    "--project-access-scope-json",
  );
  const networkAccess = optionalCodexGoalNetworkAccess(
    option(values, env, "--network-access", [
      "SUBSCRIPTION_RUNTIME_NETWORK_ACCESS",
    ]),
    "--network-access",
  );
  const resolvedJobRootDir = paths.jobRootDir;
  const runtimeTempRoot =
    paths.sourceEnv?.SUBSCRIPTION_RUNTIME_TMPDIR ?? env.SUBSCRIPTION_RUNTIME_TMPDIR ?? join(resolvedJobRootDir, "tmp");
  const agentTempRoot = paths.agentTempRootDir ?? join(runtimeTempRoot, "agent");
  const sourceEnv = {
    ...(paths.sourceEnv ?? env),
    SUBSCRIPTION_RUNTIME_JOB_ROOT: resolvedJobRootDir,
    SUBSCRIPTION_RUNTIME_TMPDIR: runtimeTempRoot,
    TMPDIR: agentTempRoot,
    TMP: agentTempRoot,
    TEMP: agentTempRoot,
  } as const;
  const childLifetimeJson = option(values, env, "--child-lifetime-json", []);
  const childLifetime = childLifetimeJson === undefined ? undefined : parseChildLifetimeJson(childLifetimeJson);
  const storageData = parseStorageData(values);
  const { logPath: _logPath, ...configPaths } = paths;
  const model = option(values, env, "--model", ["CODEX_MODEL"]) ??
    codexModelBackendDefaultModel(modelBackend.modelBackend ?? CodexModelBackend.OpenAiChatGpt, CODEX_WORKER_DEFAULT_MODEL);
  if (model === "" || model !== model.trim()) throw new Error("--model requires a non-empty value");
  const config: CodexGoalRunConfigWithAppServerStartupTimeout = {
    ...storageData,
    ...configPaths,
    ...(childLifetime ? { childLifetime } : {}),
    ...(option(values, env, "--max-goal-turns", []) === undefined ? {} : { maxGoalTurns: parseOptionalPositiveInteger(option(values, env, "--max-goal-turns", []), "--max-goal-turns")! }),
    ...(option(values, env, "--max-attempts", []) === undefined && option(values, env, "--continuation-mode", []) === undefined ? {} : { safeExecutionPolicy: {
      ...(option(values, env, "--max-attempts", []) === undefined ? {} : { maxAttempts: parseOptionalPositiveInteger(option(values, env, "--max-attempts", []), "--max-attempts")! }),
      ...(option(values, env, "--continuation-mode", []) === undefined ? {} : { continuationMode: option(values, env, "--continuation-mode", []) as "disabled" }),
    } }),
    ...(option(values, env, "--job-id", ["SUBSCRIPTION_RUNTIME_JOB_ID"]) === undefined
      ? {}
      : {
          jobId: option(values, env, "--job-id", [
            "SUBSCRIPTION_RUNTIME_JOB_ID",
          ]) as string,
        }),
    jobRootDir: resolvedJobRootDir,
    durableHandoffRootDir: resolvePath(
      cwd,
      option(values, env, "--durable-handoff-root", [
        "SUBSCRIPTION_RUNTIME_DURABLE_HANDOFF_ROOT",
      ]) ?? join(resolvedJobRootDir, "durable-handoffs"),
    ),
    authRootDir,
    workspacePath: paths.workspacePath,
    promptPath: resolvePath(
      cwd,
      requiredOption(values, env, "--prompt", [
        "SUBSCRIPTION_RUNTIME_PROMPT_PATH",
        "MEMO_STACK_GOAL_PROMPT_PATH",
      ]),
    ),
    ...(option(values, env, "--codex-goal-objective", [
      "SUBSCRIPTION_RUNTIME_CODEX_GOAL_OBJECTIVE",
    ]) === undefined
      ? {}
      : {
          codexGoalObjective: option(values, env, "--codex-goal-objective", [
            "SUBSCRIPTION_RUNTIME_CODEX_GOAL_OBJECTIVE",
          ]) as string,
        }),
    taskId,
    accounts,
    outputPath: resolvePath(
      cwd,
      paths.outputPath ??
        join(resolvedJobRootDir, ...(storageData.storage ? ["output"] : []), `${taskId}.latest-result.json`),
    ),
    progressPath: resolvePath(
      cwd,
      paths.progressPath ??
        join(resolvedJobRootDir, ...(storageData.storage ? ["output"] : []), `${taskId}.progress.json`),
    ),
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(executionEngine ? { executionEngine } : {}),
    ...(checkpointPublisherSocketPath ? { checkpointPublisherSocketPath: resolvePath(cwd, checkpointPublisherSocketPath) } : {}),
    ...(checkpointPublisherSocketPath || flag(values, "--require-turn-checkpoint")
      ? { checkpointRequired: true } : {}),
    ...modelBackend,
    codexBinaryPath: option(values, env, "--codex-binary", [
      "CODEX_BINARY_PATH",
    ]) ?? "codex",
    editMode,
    ...(providerSandboxMode === undefined ? {} : { providerSandboxMode }),
    ...(accessBoundary === undefined ? {} : { accessBoundary }),
    ...(projectAccessScope === undefined ? {} : { projectAccessScope }),
    allowDangerFullAccess: flag(values, "--allow-danger-full-access"),
    ...(networkAccess === undefined ? {} : { networkAccess }),
    taskTimeoutMs: parseOptionalPositiveInteger(
      option(values, env, "--timeout-ms", [
        "SUBSCRIPTION_RUNTIME_TASK_TIMEOUT_MS",
        "MEMO_STACK_GOAL_TASK_TIMEOUT_MS",
      ]),
      "--timeout-ms",
    ) ?? parseDurationMs(option(values, env, "--timeout", []) ?? "72h"),
    ...(appServerStartupTimeoutMs === undefined ? {} : { appServerStartupTimeoutMs }),
    progressHeartbeatMs: parseOptionalPositiveInteger(
      option(values, env, "--progress-heartbeat-ms", [
        "SUBSCRIPTION_RUNTIME_PROGRESS_HEARTBEAT_MS",
      ]),
      "--progress-heartbeat-ms",
    ) ?? 60_000,
    maxAccountCycles: parseOptionalPositiveInteger(
      option(values, env, "--max-account-cycles", [
        "SUBSCRIPTION_RUNTIME_MAX_ACCOUNT_CYCLES",
      ]),
      "--max-account-cycles",
    ) ?? 5,
    ...(staleLockMs === undefined ? {} : { staleLockMs }),
    allowDuplicateAccountIdentities: flag(values, "--allow-duplicate-accounts"),
    requireGitWorkspace: !flag(values, "--no-require-git-workspace"),
    prewarmOnStart: flag(values, "--prewarm"),
    ...(workerReportMode === undefined ? {} : { workerReportMode }),
    sourceEnv,
  };
  assertVerifiedHostedChildConfig(config);
  assertChildGoalConfig(config);
  return config;
}

/** Data only: reconstruct closed runner variants, never receipts or ports. */
function parseStorageData(values: ParsedFlags): Pick<CodexGoalRunConfig, "sessionHomeProfile" | "storage"> {
  // The legacy generic parser accepts only separate option/value tokens.
  // An equals spelling must not turn an explicit NEW opt-in into a legacy run.
  for (const name of [...values.flags, ...values.values.keys()]) {
    if (name.startsWith("--session-home-profile-json=") || name.startsWith("--storage-json=")) {
      throw new Error("codex_goal_cli_storage_data_invalid");
    }
  }
  const profileJson = option(values, {}, "--session-home-profile-json", []);
  const storageJson = option(values, {}, "--storage-json", []);
  if (values.flags.has("--session-home-profile-json") || values.flags.has("--storage-json")) {
    throw new Error("codex_goal_cli_storage_data_invalid");
  }
  if (profileJson === undefined && storageJson === undefined) return {};
  if (profileJson === undefined || storageJson === undefined) throw new Error("codex_goal_cli_storage_profile_required");
  const profile = storageObject(profileJson);
  const storage = storageObject(storageJson);
  const intent = storageObjectValue(storage.intent);
  if (Object.keys(storage).sort().join(",") !== "generationId,intent" ||
      typeof storage.generationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(storage.generationId)) {
    throw new Error("codex_goal_cli_storage_data_invalid");
  }
  let sessionHomeProfile: CodexSessionHomeProfile;
  let parsedIntent: NonNullable<CodexGoalRunConfig["storage"]>["intent"];
  if (profile.kind === CodexSessionHomeProfileKind.Continuation && intent.kind === JobStorageIntentKind.Continuation &&
      Object.keys(profile).sort().join(",") === "kind,sessionId" && Object.keys(intent).sort().join(",") === "kind,sessionId" &&
      typeof profile.sessionId === "string" && profile.sessionId.length <= 128 && profile.sessionId === intent.sessionId) {
    sessionHomeProfile = { kind: CodexSessionHomeProfileKind.Continuation, sessionId: profile.sessionId };
    parsedIntent = { kind: JobStorageIntentKind.Continuation, sessionId: profile.sessionId };
  } else if (profile.kind === CodexSessionHomeProfileKind.OneShot && intent.kind === JobStorageIntentKind.NoResume &&
      Object.keys(profile).join(",") === "kind" && Object.keys(intent).sort().join(",") === "homeStateRequirement,kind" &&
      intent.homeStateRequirement === JobStorageHomeStateRequirement.NoneRequired) {
    sessionHomeProfile = { kind: CodexSessionHomeProfileKind.OneShot };
    parsedIntent = { kind: JobStorageIntentKind.NoResume, homeStateRequirement: JobStorageHomeStateRequirement.NoneRequired };
  } else throw new Error("codex_goal_cli_storage_data_invalid");
  assertCodexSessionHomeProfile(sessionHomeProfile);
  assertJobStorageIntent(parsedIntent);
  return { sessionHomeProfile, storage: { generationId: storage.generationId, intent: parsedIntent } };
}

function storageObject(json: string): Record<string, unknown> {
  if (Buffer.byteLength(json, "utf8") > 4096) throw new Error("codex_goal_cli_storage_data_invalid");
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error("codex_goal_cli_storage_data_invalid"); }
  return storageObjectValue(value);
}

function storageObjectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("codex_goal_cli_storage_data_invalid");
  return value as Record<string, unknown>;
}

function parseDurationMs(value: string): number {
  const match = value.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) throw new Error("--timeout must look like 72h, 30m, 10s or 1000ms");
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return amount * multiplier;
}

function parseCodexGoalWorkerReportMode(
  value: string | undefined,
): CodexGoalRunConfig["workerReportMode"] | undefined {
  if (value === undefined) return undefined;
  if (value === "runtime-only" || value === "structured-output") return value;
  throw new Error("--worker-report-mode must be runtime-only or structured-output");
}

export function splitCsv(value: string): readonly string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
