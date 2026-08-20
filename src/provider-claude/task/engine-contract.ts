import type {
  AgentRuntimeBudgetCapability,
  AgentRuntimeTaskExecution,
  AgentRuntimeTaskExecutionCapability,
  AgentRuntimeTurnLimitEnforcementCode,
  ProviderTaskControls,
  ProviderTaskEvent,
  ProviderTaskResult,
  ProviderTaskTelemetry,
  RedactorPort,
  RunnerPort,
} from "@vioxen/subscription-runtime/core";
import type { ClaudeOAuthSession } from "../session/session-artifact";

export type ClaudeTaskExecutionResult = {
  readonly outputText: string;
  readonly structuredOutput?: unknown;
  readonly telemetry?: ProviderTaskTelemetry;
  readonly warnings: ProviderTaskResult["warnings"];
};

export type ClaudeRuntimeThreadInput = {
  readonly threadId: string;
  readonly resumeSessionId?: string;
};

export type ClaudeTaskEngineInput = {
  readonly prompt: string;
  readonly execution?: AgentRuntimeTaskExecution;
  readonly session: ClaudeOAuthSession;
  readonly workspacePath: string;
  readonly appendSystemPrompt?: string;
  readonly runner: RunnerPort;
  readonly redactor: RedactorPort;
  readonly model: string;
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpConfig?: readonly string[];
  readonly editMode?: ProviderTaskControls["editMode"];
  readonly providerSandboxMode?: ProviderTaskControls["providerSandboxMode"];
  readonly workspaceInstructionPolicy?: ProviderTaskControls["workspaceInstructionPolicy"];
  readonly strictMcpConfig?: boolean;
  readonly outputSchemaName?: string;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly runtimeThread?: ClaudeRuntimeThreadInput;
  readonly abortSignal: AbortSignal;
};

export type ClaudeTaskExecutionEngine = {
  readonly kind: string;
  readonly capabilities: {
    readonly supportsStreaming: boolean;
    readonly supportsToolCalls: boolean;
    readonly supportsUsage: boolean;
    readonly supportsProviderRunId: boolean;
    readonly supportsCleanup: boolean;
    readonly budgetCapabilities?: readonly AgentRuntimeBudgetCapability[];
    readonly taskExecutionCapabilities?: readonly AgentRuntimeTaskExecutionCapability[];
    readonly turnLimitEnforcement?: AgentRuntimeTurnLimitEnforcementCode;
    readonly accessBoundaryMode?: "provider-enforced" | "host-scoped" | "unsupported";
  };
  run(input: ClaudeTaskEngineInput): Promise<ClaudeTaskExecutionResult>;
  stream?(input: ClaudeTaskEngineInput): AsyncIterable<ProviderTaskEvent>;
  dispose?(): Promise<void>;
};
