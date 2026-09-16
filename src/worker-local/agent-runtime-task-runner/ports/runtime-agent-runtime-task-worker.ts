import type {
  ManagedRunInputRequest,
  ManagedRunResumeHandle,
  ProviderLogicalThreadExecution,
  ProviderTask,
  ProviderTaskTelemetry,
  RuntimeWarning,
  AgentRuntimeToolName,
} from "@vioxen/subscription-runtime/core";
import { AgentRuntimeExecutionMode } from "@vioxen/subscription-runtime/core";
import type {
  AgentRuntimeTaskReasoningEffort,
  AgentRuntimeTaskServiceTier,
} from "../../../agent-runtime-task-runner/domain";
import {
  AgentRuntimeTaskProvider,
  ClaudeAgentRuntimeBackend,
} from "../../../agent-runtime-task-runner/domain";

export { AgentRuntimeTaskProvider, ClaudeAgentRuntimeBackend };

export type ProviderName = AgentRuntimeTaskProvider;

export type AgentRuntimeTaskWorker = {
  start(): Promise<void>;
  seedClaudeOAuth?(input: { readonly oauthToken: string }): Promise<void>;
  seedCodexAuthJsonFile?(authJsonPath: string): Promise<void>;
  run(
    job: AgentRuntimeTaskWorkerJob,
    options?: AgentRuntimeTaskWorkerRunOptions,
  ): Promise<AgentRuntimeTaskWorkerResult>;
  dispose?(): Promise<void>;
};

export type AgentRuntimeTaskWorkerRunOptions = {
  readonly abortSignal?: AbortSignal;
  readonly onProviderTaskStarted?: () => Promise<void> | void;
};

export type AgentRuntimeTaskWorkerJob = {
  readonly runId?: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly kind?: ProviderTask["kind"];
  readonly outputSchemaName?: string;
  readonly controls?: ProviderTask["controls"];
  readonly execution?: ProviderTask["execution"];
  readonly abortSignal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly logicalThread?: ProviderLogicalThreadExecution;
};

export type AgentRuntimeTaskWorkerResult = {
  readonly status?: "completed" | "waiting_for_input";
  readonly runId?: string;
  readonly outputText: string;
  readonly request?: ManagedRunInputRequest;
  readonly resumeHandle?: ManagedRunResumeHandle;
  readonly structuredOutput?: unknown;
  readonly telemetry?: ProviderTaskTelemetry;
  readonly warnings: readonly RuntimeWarning[];
};

export type AgentRuntimeTaskWorkerFactoryInput = {
  readonly provider: ProviderName;
  readonly stateRootDir: string;
  readonly providerInstanceId: string;
  readonly encryptionKey: Uint8Array | string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly claudePath?: string;
  readonly claudeBackend?: ClaudeAgentRuntimeBackend;
  readonly claudeRuntimeDistDir?: string;
  readonly codexBinaryPath?: string;
  readonly reasoningEffort?: AgentRuntimeTaskReasoningEffort;
  readonly serviceTier?: AgentRuntimeTaskServiceTier;
  readonly outputSchemas?: Readonly<Record<string, unknown>>;
  readonly codexExecutionPlan?: {
    readonly execution: {
      readonly mode: AgentRuntimeExecutionMode;
      readonly goalObjective?: string;
      readonly maxGoalTurns?: number;
    };
    readonly workspaceToolPolicy?: {
      readonly allowedTools: readonly AgentRuntimeToolName[];
      readonly denyProjectInstructions?: true;
    };
    readonly rolloutBudget?: {
      readonly weightedTokenLimit: number;
    };
  };
};

export type AgentRuntimeTaskWorkerFactory = (
  input: AgentRuntimeTaskWorkerFactoryInput,
) => AgentRuntimeTaskWorker;
