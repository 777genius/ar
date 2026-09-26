import type { AgentRuntimeToolName, ClockPort, ObservabilityPort, RuntimeDeps } from "@vioxen/subscription-runtime/core";
import { CodexModelBackend, type CodexExecutionProfile, type CodexProviderEgressPolicy, type CodexAppServerProcessFactory, type CodexAppServerRateLimitsSnapshotHandler, type CodexReasoningEffort, type CodexServiceTier } from "@vioxen/subscription-runtime/provider-codex";
import type { CommandPolicy } from "@vioxen/subscription-runtime/worker-core";
import type { CodexWorkerExecutionEngine } from "./file-backend-codex-runtime-factory";
import type { CodexWorkerCapacityPolicy } from "./file-backend-codex-capacity";
import {
  assertCodexSessionHomeProfile,
  type CodexSessionHomeProfile,
} from "./codex-session-home-profile";

export type FileBackendCodexWorkerOptions = {
  readonly workerId?: string;
  readonly providerInstanceId: string;
  readonly stateRootDir: string;
  /** Payload-writable homes/cache; defaults to stateRootDir for legacy callers. */
  readonly runtimeHomeRootDir?: string;
  /** Executor-scoped CODEX_HOME lifecycle. Omitted for legacy preservation. */
  readonly sessionHomeProfile?: CodexSessionHomeProfile;
  readonly codexBinaryPath: string;
  readonly encryptionKey: Uint8Array | string;
  /** Defaults to {@link CodexModelBackend.OpenAiChatGpt} — existing Codex jobs are unaffected. */
  readonly modelBackend?: CodexModelBackend;
  /** Env var holding the MiMo Token Plan key. Only read when `modelBackend` is `XiaomiMimoTokenPlan`. */
  readonly mimoApiKeyEnvVarName?: string;
  readonly model?: string;
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly serviceTier?: CodexServiceTier;
  readonly sessionCacheSlots?: number;
  /**
   * Prompt used to fully warm the Codex app-server and model path.
   * Set to false to warm only the daemon process.
   */
  readonly warmupPrompt?: string | false;
  readonly taskTimeoutMs?: number;
  readonly appServerStartupTimeoutMs?: number;
  readonly refreshFreshnessMs?: number;
  readonly refreshBeforeExpiryMs?: number;
  readonly maxSessionAgeMs?: number;
  readonly refreshConflictRetryMaxMs?: number;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly executionEngine?: CodexWorkerExecutionEngine;
  /** Already admitted by the trusted host; never taken from job configuration. */
  readonly providerEgressPolicy?: CodexProviderEgressPolicy;
  readonly appServerProcessFactory?: CodexAppServerProcessFactory;
  readonly rateLimitsSnapshotHandler?: CodexAppServerRateLimitsSnapshotHandler;
  readonly executionProfile?: CodexExecutionProfile;
  readonly boundedWorkspaceTools?: {
    readonly allowedTools: readonly AgentRuntimeToolName[];
    readonly denyProjectInstructions?: boolean;
  };
  readonly rolloutBudget?: {
    readonly weightedTokenLimit: number;
  };
  readonly maxGoalTurns?: number;
  readonly cleanThreadPrewarm?: boolean;
  readonly outputSchemas?: Readonly<Record<string, unknown>>;
  readonly observability?: ObservabilityPort;
  readonly runner?: RuntimeDeps["runner"];
  readonly commandPolicy?: CommandPolicy;
  readonly workspace?: RuntimeDeps["workspace"];
  readonly workspacePath?: string;
  readonly clock?: ClockPort;
  readonly capacityAccountId?: string;
  readonly capacityPolicy?: CodexWorkerCapacityPolicy;
};

export function assertWorkerOptions(options: FileBackendCodexWorkerOptions): void {
  if (!options.providerInstanceId.trim()) {
    throw new Error("file_backend_codex_provider_instance_required");
  }
  if (!options.stateRootDir.trim()) {
    throw new Error("file_backend_codex_state_root_required");
  }
  if (options.runtimeHomeRootDir !== undefined && !options.runtimeHomeRootDir.trim()) {
    throw new Error("file_backend_codex_runtime_home_root_required");
  }
  assertCodexSessionHomeProfile(options.sessionHomeProfile);
  if (!options.codexBinaryPath.trim()) {
    throw new Error("file_backend_codex_binary_required");
  }
  if (options.workspace && options.workspacePath) {
    throw new Error("file_backend_codex_workspace_conflict");
  }
  if (options.boundedWorkspaceTools) {
    if (!options.workspacePath) {
      throw new Error("file_backend_codex_bounded_workspace_path_required");
    }
    if (
      options.executionEngine !== undefined &&
      options.executionEngine !== "app-server" &&
      options.executionEngine !== "app-server-goal"
    ) {
      throw new Error("file_backend_codex_bounded_workspace_engine_invalid");
    }
    if (options.executionProfile !== undefined) {
      throw new Error("file_backend_codex_bounded_workspace_profile_conflict");
    }
  }
  if (
    options.executionEngine !== undefined &&
    options.executionEngine !== "app-server" &&
    options.executionEngine !== "app-server-goal" &&
    options.executionEngine !== "packaged-exec" &&
    options.executionEngine !== "plain-exec"
  ) {
    throw new Error("file_backend_codex_execution_engine_invalid");
  }
  const modelBackend = options.modelBackend ?? CodexModelBackend.OpenAiChatGpt;
  if (
    modelBackend === CodexModelBackend.XiaomiMimoTokenPlan &&
    (options.executionEngine ?? "app-server") !== "app-server-goal"
  ) {
    // SR-AP-2 fail-closed: MiMo is only validated through the app-server
    // goal path. Never let it silently fall back to plain-exec/packaged-exec.
    throw new Error("file_backend_codex_mimo_requires_app_server_goal_engine");
  }
  if (
    modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan &&
    options.mimoApiKeyEnvVarName !== undefined
  ) {
    throw new Error("file_backend_codex_mimo_env_var_requires_mimo_backend");
  }
  if (options.providerEgressPolicy !== undefined && modelBackend === CodexModelBackend.XiaomiMimoTokenPlan) {
    // MiMo's egress domain is fixed and derived from modelBackend; it is not
    // a host-configurable input, unlike the ChatGPT/test-qualification profiles.
    throw new Error("file_backend_codex_mimo_provider_egress_policy_not_configurable");
  }
  const hostedGlobalScanGuard =
    options.sourceEnv?.SUBSCRIPTION_RUNTIME_SANDBOX_KIND === "hosted-codex-job";
  const hostedExecutionEngine = options.executionEngine ?? "app-server";
  if (
    hostedGlobalScanGuard &&
    hostedExecutionEngine !== "app-server" &&
    hostedExecutionEngine !== "app-server-goal"
  ) {
    throw new Error("file_backend_codex_hosted_scan_guard_engine_invalid");
  }
  assertPositiveInteger(
    options.appServerStartupTimeoutMs,
    "file_backend_codex_app_server_startup_timeout_invalid",
  );
  const softMaxRuns = options.capacityPolicy?.softMaxRunsPerWindow;
  if (
    softMaxRuns !== undefined &&
    (!Number.isInteger(softMaxRuns) || softMaxRuns <= 0)
  ) {
    throw new Error("file_backend_codex_soft_max_runs_invalid");
  }
  const windowMs = options.capacityPolicy?.windowMs;
  if (
    windowMs !== undefined &&
    (!Number.isFinite(windowMs) || windowMs <= 0)
  ) {
    throw new Error("file_backend_codex_capacity_window_invalid");
  }
  const quotaCooldownMs = options.capacityPolicy?.quotaCooldownMs;
  if (
    quotaCooldownMs !== undefined &&
    (!Number.isFinite(quotaCooldownMs) || quotaCooldownMs < 0)
  ) {
    throw new Error("file_backend_codex_quota_cooldown_invalid");
  }
}

function assertPositiveInteger(value: number | undefined, code: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) throw new Error(code);
}
