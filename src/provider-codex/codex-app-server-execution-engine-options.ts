import { HostedMimoProfile } from "./hosted-mimo-profile";
import { assertHostedMimoCodingEngineAuthority, type HostedMimoCodingEngineAuthority } from "./hosted-mimo-coding-engine-authority";
import {
  AgentRuntimeBudgetEnforcement,
  AgentRuntimeBudgetMetric,
  AgentRuntimeExecutionMode,
  AgentRuntimeTurnLimitEnforcement,
} from "@vioxen/subscription-runtime/core";
import { AppServerExecutionLifetime } from "./app-server/application/app-server-child-lifetime";
import { ChildExecutionBudget } from "@vioxen/subscription-runtime/core";
import type { ManagedRunStorePort } from "@vioxen/subscription-runtime/core";
import type {
  CodexAppServerCommandApprovalPolicy,
  CodexAppServerNativeToolSurface,
} from "./app-server/domain/app-server-types";
import type { CodexAppServerRolloutBudget } from "./app-server/domain/app-server-rollout-budget";
import type { CodexAppServerRateLimitsSnapshotHandler } from "./app-server/application/app-server-rate-limits-monitor";
import type { CodexAppServerProcessFactory } from "./app-server/application/app-server-process-port";
import type { AppServerCompletedTurnCheckpoint } from "./app-server/application/app-server-turn-checkpoint";
import type { AppServerCompletedGoalOutputValidator } from "./app-server/application/app-server-validated-goal-completion";
import type { CodexExecutionProfile } from "./codex-execution-profile";
import type { CodexExecutionEngine } from "./codex-json-execution-engine";
import { CodexModelBackend } from "./codex-model-backend";
import { readHostedMimoWorkerOrigin } from "./hosted-mimo-worker-origin";
import type { CodexProviderEgressPolicy } from "./codex-provider-egress-policy";
import type { PublicResearchSourceReader } from "./app-server/application/public-research-source-port";
import type { HostedControllerDynamicToolAdapter } from "./app-server/domain/hosted-controller-dynamic-tools";
import type { ProviderCallObserver } from "../provider-usage/provider-call-observation";
import { AppServerSlotPool } from "./app-server/application/app-server-slot-pool";
import { signalCodexAppServerChildGroup } from "./app-server/adapters/node-app-server-process";
import { appServerStartupTimeoutMs } from "./app-server/domain/app-server-errors";
import { defaultReconnectGraceMs } from "./app-server/domain/app-server-types";
import type { ResolvedCodexExecutionProfile } from "./codex-execution-profile";

export type CodexAppServerExecutionEngineOptions = {
  /** Fixed engine scope prevents pooled children from mixing invocation telemetry. */
  readonly usageRelay?: { readonly upstreamBaseUrl: string; readonly model: string; readonly observe: ProviderCallObserver };
  readonly codexBinaryPath: string;
  readonly hostedCodingAuthority?: HostedMimoCodingEngineAuthority;
  readonly childBudget?: ChildExecutionBudget;
  readonly executionLifetime?: AppServerExecutionLifetime;
  /**
   * Defaults to {@link CodexModelBackend.OpenAiChatGpt} — existing behavior
   * is unchanged. Fixed for the engine's (and its app-server process pool's)
   * whole lifetime: one execution engine instance serves exactly one backend.
   */
  readonly modelBackend?: CodexModelBackend;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  /** Captured trusted Host policy; environment markers never enable native web tools. */
  readonly providerEgressPolicy?: CodexProviderEgressPolicy;
  readonly publicSourceReader?: PublicResearchSourceReader;
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
  readonly completedTurnCheckpoint?: AppServerCompletedTurnCheckpoint;
  /** Trusted host callback for ordinary structured Goal tasks, not child/controller jobs. */
  readonly completedGoalOutputValidator?: AppServerCompletedGoalOutputValidator;
  readonly maxGoalTurns?: number;
  readonly goalContinuePrompt?: string;
  readonly runStore?: ManagedRunStorePort;
  readonly commandApprovalPolicy?: CodexAppServerCommandApprovalPolicy;
  readonly nativeToolSurface?: CodexAppServerNativeToolSurface;
  /** Source-owned bounded workspace Goal composition; filesystem tools remain disabled. */
  readonly nativeGoalControls?: true;
  readonly hostedControllerTools?: HostedControllerDynamicToolAdapter;
  readonly rolloutBudget?: CodexAppServerRolloutBudget;
  readonly bypassHookTrust?: boolean;
  readonly rateLimitsSnapshotHandler?: CodexAppServerRateLimitsSnapshotHandler;
};

function isOwnedMimoContainedTurn(options: CodexAppServerExecutionEngineOptions): boolean {
  return options.executionLifetime !== undefined && options.goalMode === false &&
    options.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan && options.childBudget === undefined &&
    options.hostedControllerTools === undefined && options.hostedPermissionProfiles === true &&
    readHostedMimoWorkerOrigin() !== null;
}

function isOwnedMimoCodingTurn(options: CodexAppServerExecutionEngineOptions): boolean {
  if (options.nativeToolSurface !== HostedMimoProfile.CodingV1) return false;
  assertHostedMimoCodingEngineAuthority(options.hostedCodingAuthority, {
    processFactory: options.processFactory, executionLifetime: options.executionLifetime, codexBinaryPath: options.codexBinaryPath });
  return options.executionLifetime !== undefined && options.goalMode === false &&
    options.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan && options.childBudget === undefined &&
    options.hostedControllerTools === undefined && options.hostedPermissionProfiles === true;
}
/** MiMo's wire lacks json_schema; the registered report still validates locally. */
export function appServerWireOutputSchema(options: CodexAppServerExecutionEngineOptions,
  schema: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | undefined {
  return schema !== undefined && (isOwnedMimoCodingTurn(options) || isOwnedMimoContainedTurn(options)) ? undefined : schema;
}

/** Resolve and validate the original bounded execution fence before admission. */
export function resolveAppServerEngineLifetime(options: CodexAppServerExecutionEngineOptions): AppServerExecutionLifetime | undefined {
  if (options.completedGoalOutputValidator !== undefined &&
      (typeof options.completedGoalOutputValidator !== "function" || options.goalMode !== true ||
       options.executionLifetime !== undefined || options.childBudget !== undefined ||
       options.hostedControllerTools !== undefined || options.fallback !== undefined)) {
    throw new Error("codex_goal_output_validator_profile_invalid");
  }
  if (options.nativeGoalControls !== undefined && (options.nativeGoalControls !== true ||
      options.goalMode !== true || options.nativeToolSurface !== "disabled" || options.hostedControllerTools !== undefined)) {
    throw new Error("codex_app_server_native_goal_controls_profile_invalid");
  }
  const lifetime = options.executionLifetime ?? (options.childBudget ? new AppServerExecutionLifetime({ childBudget: options.childBudget }) : undefined);
  const coding = isOwnedMimoCodingTurn(options);
  const ownedMimoTurn = coding || isOwnedMimoContainedTurn(options);
  if (options.executionLifetime && (options.executionLifetime.childBudget !== options.childBudget ||
        (!ownedMimoTurn && options.goalMode !== true) || (coding ? options.nativeToolSurface !== HostedMimoProfile.CodingV1 : options.nativeToolSurface !== "disabled") || options.cleanThreadPrewarm !== false || options.fallback !== undefined ||
        options.maxGoalTurns !== options.executionLifetime.maxGoalTurns)) throw new Error("codex_app_server_bounded_profile_conflict");
  return lifetime;
}

export function appServerEngineCapabilities(
  options: CodexAppServerExecutionEngineOptions,
): CodexExecutionEngine["capabilities"] {
  return {
    supportsStructuredOutput: true,
    supportsJsonEvents: true,
    supportsThreadResume: false,
    requiresSchemaFile: false,
    taskExecutionCapabilities: [
      { mode: AgentRuntimeExecutionMode.SingleRun },
      ...(options.goalMode
        ? [{
            mode: AgentRuntimeExecutionMode.Goal,
            maxCompletionConditionChars: 4_000,
          } as const]
        : []),
    ],
    ...(options.goalMode
      ? {
          turnLimitEnforcement:
            AgentRuntimeTurnLimitEnforcement.ProviderNative,
        }
      : {}),
    ...(options.rolloutBudget
      ? {
          budgetCapabilities: [
            {
              metric: AgentRuntimeBudgetMetric.WeightedTokens,
              enforcement: AgentRuntimeBudgetEnforcement.ProviderNative,
            },
          ],
        }
      : {}),
  };
}


export function appServerSlotPoolOptions(input: {
  readonly options: CodexAppServerExecutionEngineOptions;
  readonly executionProfile: ResolvedCodexExecutionProfile;
  readonly runStore: ManagedRunStorePort;
  readonly processFactory: CodexAppServerProcessFactory;
  readonly maxOutputBytes: number;
  readonly modelBackend: CodexModelBackend;
}): ConstructorParameters<typeof AppServerSlotPool>[0] {
  const { options } = input;
  return {

    ...(options.childBudget ? { childBudget: options.childBudget } : {}),
    codexBinaryPath: options.codexBinaryPath,
    ...(options.sourceEnv === undefined ? {} : { sourceEnv: options.sourceEnv }),
    ...(options.providerEgressPolicy ? { providerEgressPolicy: options.providerEgressPolicy } : {}),
    ...(options.publicSourceReader ? { publicSourceReader: options.publicSourceReader } : {}),
    ...(options.hostedPermissionProfiles === undefined ? {} : { hostedPermissionProfiles: options.hostedPermissionProfiles }),
    processFactory: input.processFactory,
    signalChildProcess: signalCodexAppServerChildGroup,
    runStore: input.runStore,
    ...(options.completedTurnCheckpoint ? { completedTurnCheckpoint: options.completedTurnCheckpoint } : {}),
    executionProfile: input.executionProfile,
    ...(options.commandApprovalPolicy === undefined
      ? {}
      : { commandApprovalPolicy: options.commandApprovalPolicy }),
    ...(options.hostedCodingAuthority === undefined ? {} : { hostedCodingAuthority: options.hostedCodingAuthority }),
    ...(options.nativeToolSurface === undefined
      ? {}
      : { nativeToolSurface: options.nativeToolSurface }),
    ...(options.nativeGoalControls === undefined ? {} : { nativeGoalControls: options.nativeGoalControls }),
    ...(options.hostedControllerTools ? { hostedControllerTools: options.hostedControllerTools } : {}),
    ...(options.rolloutBudget === undefined
      ? {}
      : { rolloutBudget: options.rolloutBudget }),
    ...(options.bypassHookTrust === undefined ? {} : { bypassHookTrust: options.bypassHookTrust }),
    ...(options.rateLimitsSnapshotHandler === undefined
      ? {}
      : {
          rateLimitsSnapshotHandler: options.rateLimitsSnapshotHandler,
        }),
    cleanThreadPrewarm: options.cleanThreadPrewarm ?? true,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.startupTimeoutMs === undefined
      ? {}
      : { startupTimeoutMs: options.startupTimeoutMs }),
    ...(options.reconnectGraceMs === undefined
      ? {}
      : { reconnectGraceMs: options.reconnectGraceMs }),
    maxOutputBytes: input.maxOutputBytes,
    ...(options.modelBackend === undefined
      ? {}
      : { modelBackend: options.modelBackend }),
  };
}
