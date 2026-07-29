import {
  makeFailedAgentRuntimeTaskResult,
  type AgentRuntimeTaskResult,
} from "@vioxen/subscription-runtime/agent-runtime-task";
import type {
  AgentCapabilities,
  ProviderTask,
  RuntimeWarning,
} from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeControl,
  AgentRuntimeExecutionMode,
  AgentRuntimeTurnLimitEnforcement,
} from "@vioxen/subscription-runtime/core";
import type {
  ProviderName,
} from "./ports";

export function validateRunnerControls(input: {
  readonly capabilities: AgentCapabilities;
  readonly provider: ProviderName;
  readonly task: ProviderTask;
}): {
  readonly result?: AgentRuntimeTaskResult;
  readonly warnings: readonly RuntimeWarning[];
} {
  const warnings: RuntimeWarning[] = [];
  const controls = input.task.controls;
  const execution = input.task.execution ?? {
    mode: AgentRuntimeExecutionMode.SingleRun,
  };
  const executionCapability = input.capabilities.taskExecutionCapabilities?.find(
    (capability) => capability.mode === execution.mode,
  );
  if (!executionCapability) {
    const warning = unsupportedControlWarning(
      input.provider,
      AgentRuntimeControl.Execution,
    );
    return { result: unsupportedControlResult(warning), warnings: [] };
  }
  if (
    execution.mode === AgentRuntimeExecutionMode.Goal &&
    executionCapability.maxCompletionConditionChars !== undefined &&
    execution.completionCondition.length >
      executionCapability.maxCompletionConditionChars
  ) {
    return {
      result: makeFailedAgentRuntimeTaskResult({
        code: "task_request_invalid",
        safeMessage: "Goal completion condition exceeds provider capability.",
      }),
      warnings: [],
    };
  }
  if (!controls) return { warnings };

  if (
    controls.maxTurns !== undefined &&
    input.capabilities.turnLimitEnforcement !==
      AgentRuntimeTurnLimitEnforcement.ProviderNative
  ) {
    const warning = unsupportedControlWarning(
      input.provider,
      AgentRuntimeControl.MaxTurns,
    );
    return { result: unsupportedControlResult(warning), warnings: [] };
  }

  if (
    controls.accessBoundary !== undefined &&
    input.capabilities.accessBoundaryMode !== "provider-enforced" &&
    input.capabilities.accessBoundaryMode !== "host-scoped"
  ) {
    const warning = unsupportedControlWarning(
      input.provider,
      AgentRuntimeControl.AccessBoundary,
    );
    return { result: unsupportedControlResult(warning), warnings: [] };
  }

  if (
    controls.toolPolicy &&
    input.capabilities.toolPolicyMode !== "provider-enforced" &&
    input.capabilities.toolPolicyMode !== "host-filtered"
  ) {
    const warning = unsupportedControlWarning(
      input.provider,
      AgentRuntimeControl.ToolPolicy,
    );
    if ((controls.toolPolicy.onUnsupported ?? "fail") === "fail") {
      return { result: unsupportedControlResult(warning), warnings: [] };
    }
    warnings.push(warning);
  }

  if (
    controls.budget &&
    !input.capabilities.budgetCapabilities?.some(
      (capability) => capability.metric === controls.budget?.metric,
    )
  ) {
    const warning = unsupportedControlWarning(
      input.provider,
      AgentRuntimeControl.Budget,
    );
    if ((controls.budget.onUnsupported ?? "fail") === "fail") {
      return { result: unsupportedControlResult(warning), warnings: [] };
    }
    warnings.push(warning);
  }

  return { warnings };
}

function unsupportedControlWarning(
  provider: ProviderName,
  control: AgentRuntimeControl,
): RuntimeWarning {
  return {
    code: "agent_runtime_task_control_unsupported",
    safeMessage: `${control} is not supported by the ${provider} agent runtime.`,
    details: {
      control,
      provider,
    },
  };
}

function unsupportedControlResult(warning: RuntimeWarning): AgentRuntimeTaskResult {
  return makeFailedAgentRuntimeTaskResult({
    code: "task_mode_unsupported",
    safeMessage: warning.safeMessage,
    ...(warning.details ? { details: warning.details } : {}),
    warnings: [warning],
  });
}
