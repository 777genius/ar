import type {
  ManagedRunInputRequest,
  ManagedRunResumeHandle,
  ProviderTask,
  ProviderTaskTelemetry,
  RuntimeWarning,
  AgentRuntimeToolName,
} from "@vioxen/subscription-runtime/core";
import { AgentRuntimeExecutionMode } from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeTaskProvider,
  ClaudeAgentRuntimeBackend,
} from "../../../agent-runtime-task-runner/domain";

export { AgentRuntimeTaskProvider };

export type ProviderName = AgentRuntimeTaskProvider;

export type AgentRuntimeTaskWorker = {
  start(): Promise<void>;
  seedClaudeOAuth?(input: { readonly oauthToken: string }): Promise<void>;
  seedCodexAuthJsonFile?(authJsonPath: string): Promise<void>;
  run(job: AgentRuntimeTaskWorkerJob): Promise<AgentRuntimeTaskWorkerResult>;
  dispose?(): Promise<void>;
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
  readonly codexExecutionPlan?: {
    readonly execution: {
      readonly mode: AgentRuntimeExecutionMode;
      readonly goalObjective?: string;
      readonly maxGoalTurns?: number;
    };
    readonly workspaceToolPolicy?: {
      readonly allowedTools: readonly AgentRuntimeToolName[];
    };
    readonly rolloutBudget?: {
      readonly weightedTokenLimit: number;
    };
  };
};

export type AgentRuntimeTaskWorkerFactory = (
  input: AgentRuntimeTaskWorkerFactoryInput,
) => AgentRuntimeTaskWorker;
