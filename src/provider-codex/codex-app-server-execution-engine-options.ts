import type { ManagedRunStorePort } from "@vioxen/subscription-runtime/core";
import type {
  CodexAppServerCommandApprovalPolicy,
  CodexAppServerNativeToolSurface,
} from "./app-server/domain/app-server-types";
import type { CodexAppServerRolloutBudget } from "./app-server/domain/app-server-rollout-budget";
import type { CodexAppServerRateLimitsSnapshotHandler } from "./app-server/application/app-server-rate-limits-monitor";
import type { CodexAppServerProcessFactory } from "./app-server/application/app-server-process-port";
import type { CodexExecutionProfile } from "./codex-execution-profile";
import type { CodexExecutionEngine } from "./codex-json-execution-engine";
import type { CodexModelBackend } from "./codex-model-backend";

export type CodexAppServerExecutionEngineOptions = {
  readonly codexBinaryPath: string;
  /**
   * Defaults to {@link CodexModelBackend.OpenAiChatGpt} — existing behavior
   * is unchanged. Fixed for the engine's (and its app-server process pool's)
   * whole lifetime: one execution engine instance serves exactly one backend.
   */
  readonly modelBackend?: CodexModelBackend;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  /** Set only with a generated CODEX_HOME containing the hosted profiles. */
  readonly hostedPermissionProfiles?: boolean;
  readonly timeoutMs?: number;
  readonly startupTimeoutMs?: number;
  /**
   * Maximum retained turn output. App-server JSON-RPC frames allow sixfold
   * JSON escaping headroom and reject values requiring more than 64 MiB.
   */
  readonly maxOutputBytes?: number;
  readonly fallback?: CodexExecutionEngine;
  readonly processFactory?: CodexAppServerProcessFactory;
  readonly executionProfile?: CodexExecutionProfile;
  readonly cleanThreadPrewarm?: boolean;
  readonly reconnectGraceMs?: number;
  readonly goalMode?: boolean;
  readonly maxGoalTurns?: number;
  readonly goalContinuePrompt?: string;
  readonly runStore?: ManagedRunStorePort;
  readonly commandApprovalPolicy?: CodexAppServerCommandApprovalPolicy;
  readonly nativeToolSurface?: CodexAppServerNativeToolSurface;
  readonly rolloutBudget?: CodexAppServerRolloutBudget;
  readonly bypassHookTrust?: boolean;
  readonly rateLimitsSnapshotHandler?: CodexAppServerRateLimitsSnapshotHandler;
};
