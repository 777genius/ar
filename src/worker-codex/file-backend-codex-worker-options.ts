import type { AgentRuntimeToolName, ClockPort, ObservabilityPort, RuntimeDeps } from "@vioxen/subscription-runtime/core";
import type { CodexExecutionProfile, CodexProviderEgressPolicy, CodexAppServerProcessFactory, CodexAppServerRateLimitsSnapshotHandler, CodexReasoningEffort, CodexServiceTier } from "@vioxen/subscription-runtime/provider-codex";
import type { CommandPolicy } from "@vioxen/subscription-runtime/worker-core";
import type { CodexWorkerExecutionEngine } from "./file-backend-codex-runtime-factory";
import type { CodexWorkerCapacityPolicy } from "./file-backend-codex-capacity";

export type FileBackendCodexWorkerOptions = {
  readonly workerId?: string;
  readonly providerInstanceId: string;
  readonly stateRootDir: string;
  /** Payload-writable homes/cache; defaults to stateRootDir for legacy callers. */
  readonly runtimeHomeRootDir?: string;
  readonly codexBinaryPath: string;
  readonly encryptionKey: Uint8Array | string;
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
