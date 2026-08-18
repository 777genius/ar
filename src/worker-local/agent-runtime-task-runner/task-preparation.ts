import {
  AgentRuntimeFailureCode,
  agentRuntimeTaskRequestToProviderTask,
  makeFailedAgentRuntimeTaskResult,
  type AgentRuntimeTaskRequest,
  type AgentRuntimeTaskResult,
} from "@vioxen/subscription-runtime/agent-runtime-task";
import type { ProviderTask } from "@vioxen/subscription-runtime/core";
import { resolveInlineOutputSchemas } from "../inline-output-schema";
import {
  AgentRuntimeTaskProvider,
  type ProviderName,
} from "./ports";
import {
  compileCodexExecutionPlan,
  type CodexExecutionPlan,
} from "./codex-execution-plan";
import { mapProviderToolPolicy } from "./tool-policy";

export type PreparedAgentRuntimeTask = {
  readonly task: ProviderTask;
  readonly outputSchemas?: Readonly<Record<string, unknown>>;
  readonly outputSchemaDigest?: string;
  readonly codexExecutionPlan?: CodexExecutionPlan;
  readonly result?: never;
} | {
  readonly result: AgentRuntimeTaskResult;
};

export function prepareAgentRuntimeTask(
  provider: ProviderName,
  request: AgentRuntimeTaskRequest,
): PreparedAgentRuntimeTask {
  const inlineOutputSchema = resolveInlineOutputSchemas(request.task);
  const mappedTask = mapProviderToolPolicy(
    provider,
    agentRuntimeTaskRequestToProviderTask(request),
  );
  const task = inlineOutputSchema
    ? { ...mappedTask, outputSchemaName: inlineOutputSchema.name }
    : mappedTask;
  if (inlineOutputSchema && provider !== AgentRuntimeTaskProvider.Codex) {
    return unsupportedTaskMode("Inline output schemas require Codex.");
  }
  if (
    task.controls?.workspaceInstructionPolicy !== undefined &&
    provider !== AgentRuntimeTaskProvider.Codex
  ) {
    return unsupportedTaskMode(
      "Workspace instruction isolation is unsupported for this provider.",
    );
  }
  try {
    const codexExecutionPlan = provider === AgentRuntimeTaskProvider.Codex
      ? compileCodexExecutionPlan(task)
      : undefined;
    return {
      task,
      ...(inlineOutputSchema
        ? {
            outputSchemas: inlineOutputSchema.schemas,
            outputSchemaDigest: inlineOutputSchema.digest,
          }
        : {}),
      ...(codexExecutionPlan ? { codexExecutionPlan } : {}),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        "workspace_instruction_policy_requires_bounded_read_only_tools"
    ) return unsupportedTaskMode(error.message);
    throw error;
  }
}

function unsupportedTaskMode(safeMessage: string): PreparedAgentRuntimeTask {
  return {
    result: makeFailedAgentRuntimeTaskResult({
      code: AgentRuntimeFailureCode.TaskModeUnsupported,
      safeMessage,
    }),
  };
}
