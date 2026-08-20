import type {
  ProviderTask,
  ProviderTaskControls,
  ProviderTaskResult,
  ProviderLogicalThreadExecution,
  RedactorPort,
  RunnerPort,
  SessionArtifact,
  WorkspaceHandle,
} from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeBudgetMetric,
  AgentRuntimeExecutionMode,
} from "@vioxen/subscription-runtime/core";
import {
  validateClaudeSessionArtifact,
} from "../session/session-artifact";
import { claudeGoalCompletionToolName } from "../process/claude-agent-sdk-goal-protocol";
import { registerClaudeSecrets } from "../session/claude-session-driver";
import type {
  ClaudeTaskEngineInput,
  ClaudeTaskExecutionEngine,
} from "./engine-contract";
import { runtimeThreadFromMetadata } from "./runtime-thread-metadata";

export type ClaudeTaskAgentDriverOptions = {
  readonly engine: ClaudeTaskExecutionEngine;
  readonly appendSystemPrompt?: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpConfig?: readonly string[];
  readonly strictMcpConfig?: boolean;
  readonly outputSchemas?: Readonly<Record<string, unknown>>;
};

export type ClaudeTaskEnginePreparationInput = {
  readonly session: SessionArtifact;
  readonly task: ProviderTask;
  readonly workspace: WorkspaceHandle;
  readonly runner: RunnerPort;
  readonly redactor: RedactorPort;
  readonly abortSignal: AbortSignal;
  readonly logicalThread?: ProviderLogicalThreadExecution;
};

export type PreparedClaudeTaskEngineInput = {
  readonly engineInput: ClaudeTaskEngineInput;
  readonly warnings: readonly ProviderTaskResult["warnings"][number][];
};

export function prepareClaudeTaskEngineInput(
  options: ClaudeTaskAgentDriverOptions,
  defaultModel: string,
  input: ClaudeTaskEnginePreparationInput,
): PreparedClaudeTaskEngineInput {
  const validation = validateClaudeSessionArtifact(input.session);
  registerClaudeSecrets(input.redactor, validation.session.oauthToken);
  const runtimeThread = input.logicalThread === undefined
    ? runtimeThreadFromMetadata(input.task.metadata)
    : {
        threadId: input.logicalThread.threadId,
        ...(input.logicalThread.previousCheckpoint === undefined
          ? {}
          : {
              resumeSessionId: input.logicalThread.previousCheckpoint,
            }),
      };
  if (runtimeThread?.resumeSessionId) {
    input.redactor.registerSecret(
      runtimeThread.resumeSessionId,
      "claude-provider-checkpoint",
    );
  }
  let engineInput: ClaudeTaskEngineInput = {
    prompt: executionPrompt(input.task),
    execution: input.task.execution ?? {
      mode: AgentRuntimeExecutionMode.SingleRun,
    },
    session: validation.session,
    workspacePath: input.workspace.path,
    runner: input.runner,
    redactor: input.redactor,
    model: input.task.controls?.model ?? defaultModel,
    abortSignal: input.abortSignal,
  };
  const maxTurns = input.task.controls?.maxTurns ?? options.maxTurns;
  const maxBudgetUsd = input.task.controls?.budget?.metric === AgentRuntimeBudgetMetric.Usd
    ? input.task.controls.budget.limit
    : undefined;
  const allowedTools =
    input.task.controls?.allowedTools ?? options.allowedTools;
  const disallowedTools =
    input.task.controls?.disallowedTools ?? options.disallowedTools;
  const editMode = input.task.controls?.editMode;
  const providerSandboxMode = input.task.controls?.providerSandboxMode;
  const workspaceInstructionPolicy = input.task.controls?.workspaceInstructionPolicy;
  const outputSchemaName =
    input.task.controls?.outputSchemaName ?? input.task.outputSchemaName;
  const configuredOutputSchema = outputSchemaName === undefined
    ? undefined
    : options.outputSchemas?.[outputSchemaName];
  if (
    outputSchemaName !== undefined &&
    options.outputSchemas !== undefined &&
    configuredOutputSchema === undefined
  ) {
    throw new Error(`claude_output_schema_missing:${outputSchemaName}`);
  }
  if (
    configuredOutputSchema !== undefined &&
    (configuredOutputSchema === null ||
      typeof configuredOutputSchema !== "object" ||
      Array.isArray(configuredOutputSchema))
  ) {
    throw new Error(`claude_output_schema_invalid:${outputSchemaName}`);
  }
  const outputSchema = configuredOutputSchema as
    | Readonly<Record<string, unknown>>
    | undefined;
  const appendSystemPrompt = mergeSystemPrompts(
    options.appendSystemPrompt,
    input.task.systemPrompt,
    goalSystemPrompt(input.task.execution),
  );
  engineInput = withOptionalEngineInputValues(engineInput, {
    appendSystemPrompt,
    maxTurns,
    maxBudgetUsd,
    allowedTools,
    disallowedTools,
    mcpConfig: options.mcpConfig,
    editMode,
    providerSandboxMode,
    workspaceInstructionPolicy,
    strictMcpConfig: options.strictMcpConfig,
    outputSchemaName,
    outputSchema,
    runtimeThread,
  });
  return {
    engineInput,
    warnings: validation.warnings,
  };
}

type OptionalEngineInputKey =
  | "appendSystemPrompt"
  | "maxTurns"
  | "maxBudgetUsd"
  | "allowedTools"
  | "disallowedTools"
  | "mcpConfig"
  | "editMode"
  | "providerSandboxMode"
  | "workspaceInstructionPolicy"
  | "strictMcpConfig"
  | "outputSchemaName"
  | "outputSchema"
  | "runtimeThread";

type OptionalEngineInputValues = {
  readonly [Key in OptionalEngineInputKey]: ClaudeTaskEngineInput[Key] | undefined;
};

function withOptionalEngineInputValues(
  engineInput: ClaudeTaskEngineInput,
  optional: OptionalEngineInputValues,
): ClaudeTaskEngineInput {
  let result = engineInput;
  if (optional.appendSystemPrompt !== undefined) {
    result = { ...result, appendSystemPrompt: optional.appendSystemPrompt };
  }
  if (optional.maxTurns !== undefined) {
    result = { ...result, maxTurns: optional.maxTurns };
  }
  if (optional.maxBudgetUsd !== undefined) {
    result = { ...result, maxBudgetUsd: optional.maxBudgetUsd };
  }
  if (optional.allowedTools !== undefined) {
    result = { ...result, allowedTools: optional.allowedTools };
  }
  if (optional.disallowedTools !== undefined) {
    result = { ...result, disallowedTools: optional.disallowedTools };
  }
  if (optional.mcpConfig !== undefined) {
    result = { ...result, mcpConfig: optional.mcpConfig };
  }
  if (optional.editMode !== undefined) {
    result = { ...result, editMode: optional.editMode };
  }
  if (optional.providerSandboxMode !== undefined) {
    result = {
      ...result,
      providerSandboxMode: optional.providerSandboxMode,
    };
  }
  if (optional.workspaceInstructionPolicy !== undefined) {
    result = {
      ...result,
      workspaceInstructionPolicy: optional.workspaceInstructionPolicy,
    };
  }
  if (optional.strictMcpConfig !== undefined) {
    result = { ...result, strictMcpConfig: optional.strictMcpConfig };
  }
  if (optional.outputSchemaName !== undefined) {
    result = { ...result, outputSchemaName: optional.outputSchemaName };
  }
  if (optional.outputSchema !== undefined) {
    result = { ...result, outputSchema: optional.outputSchema };
  }
  if (optional.runtimeThread !== undefined) {
    result = { ...result, runtimeThread: optional.runtimeThread };
  }
  return result;
}

function mergeSystemPrompts(
  ...values: readonly (string | undefined)[]
): string | undefined {
  const parts = values
    .map((value) => value?.trim())
    .filter((value): value is string => !!value);
  if (parts.length === 0) return undefined;
  return parts.join("\n\n");
}

function goalSystemPrompt(
  execution: ProviderTask["execution"],
): string | undefined {
  if (execution?.mode !== AgentRuntimeExecutionMode.Goal) return undefined;
  return [
    "Agent Runtime execution mode: Goal.",
    "Continue working autonomously within the provided tools and safety controls until the completion condition is satisfied or a hard runtime bound stops execution.",
    `Before returning success, inspect the resulting workspace state, verify the completion condition, and call ${claudeGoalCompletionToolName} with concise evidence.`,
    "Do not stop after only describing a plan. The Goal is incomplete until the completion report tool is accepted.",
  ].join("\n");
}

function executionPrompt(task: ProviderTask): string {
  if (task.execution?.mode !== AgentRuntimeExecutionMode.Goal) {
    return task.prompt;
  }
  return [
    task.prompt,
    "Goal completion condition:",
    task.execution.completionCondition,
  ].join("\n\n");
}
