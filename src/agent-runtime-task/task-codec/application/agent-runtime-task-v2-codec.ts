import { AgentRuntimeExecutionMode } from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeFailureLifecycleState,
  AgentRuntimePendingAuthority,
  type AgentRuntimeFailureLifecycle,
  type AgentRuntimeTaskPayloadV2,
} from "../domain/agent-runtime-task-contracts";
import {
  assertOnlyKeys,
  booleanAt,
  nonEmptyStringAt,
  objectAt,
  protocolError,
  stringAt,
} from "./agent-runtime-task-validation";

export function parseFailureLifecycle(
  value: unknown,
  path: string,
): AgentRuntimeFailureLifecycle {
  const input = objectAt(value, path);
  const state = stringAt(input.state, `${path}.state`);
  const taskStarted = booleanAt(input.taskStarted, `${path}.taskStarted`);
  if (state === AgentRuntimeFailureLifecycleState.PreflightFailed) {
    assertOnlyKeys(input, ["state", "taskStarted"], path);
    if (taskStarted) {
      throw protocolError(
        "agent_runtime_task_result_invalid",
        `${path}.taskStarted must be false for preflight_failed`,
      );
    }
    return { state, taskStarted: false };
  }
  if (state === AgentRuntimeFailureLifecycleState.ExecutionFailed) {
    assertOnlyKeys(input, ["state", "taskStarted"], path);
    if (!taskStarted) {
      throw protocolError(
        "agent_runtime_task_result_invalid",
        `${path}.taskStarted must be true for execution_failed`,
      );
    }
    return { state, taskStarted: true };
  }
  if (state !== AgentRuntimeFailureLifecycleState.CleanupUnconfirmed) {
    throw protocolError(
      "agent_runtime_task_result_invalid",
      `${path}.state is unsupported`,
    );
  }
  assertOnlyKeys(input, ["state", "taskStarted", "pendingAuthorities"], path);
  if (
    !Array.isArray(input.pendingAuthorities) ||
    input.pendingAuthorities.length === 0
  ) {
    throw protocolError(
      "agent_runtime_task_result_invalid",
      `${path}.pendingAuthorities must be a non-empty array`,
    );
  }
  const pendingAuthorities = input.pendingAuthorities.map((authority, index) => {
    const parsed = stringAt(authority, `${path}.pendingAuthorities[${index}]`);
    if (
      !Object.values(AgentRuntimePendingAuthority).includes(
        parsed as AgentRuntimePendingAuthority,
      )
    ) {
      throw protocolError(
        "agent_runtime_task_result_invalid",
        `${path}.pendingAuthorities[${index}] is unsupported`,
      );
    }
    return parsed as AgentRuntimePendingAuthority;
  });
  return {
    state,
    taskStarted,
    pendingAuthorities: pendingAuthorities as [
      AgentRuntimePendingAuthority,
      ...AgentRuntimePendingAuthority[],
    ],
  };
}

export function parseTaskExecution(
  value: unknown,
  path: string,
): AgentRuntimeTaskPayloadV2["execution"] {
  const input = objectAt(value, path);
  const mode = stringAt(input.mode, `${path}.mode`);
  if (mode === AgentRuntimeExecutionMode.SingleRun) {
    assertOnlyKeys(input, ["mode"], path);
    return { mode: AgentRuntimeExecutionMode.SingleRun };
  }
  if (mode !== AgentRuntimeExecutionMode.Goal) {
    throw protocolError(
      "agent_runtime_task_request_invalid",
      `${path}.mode is unsupported`,
    );
  }
  assertOnlyKeys(input, ["mode", "completionCondition"], path);
  const completionCondition = nonEmptyStringAt(
    input.completionCondition,
    `${path}.completionCondition`,
  );
  if (
    completionCondition.length > 4_000 ||
    /[\u0000-\u001f\u007f]/u.test(completionCondition)
  ) {
    throw protocolError(
      "agent_runtime_task_request_invalid",
      `${path}.completionCondition must be a single control-free line of at most 4000 characters`,
    );
  }
  return {
    mode: AgentRuntimeExecutionMode.Goal,
    completionCondition,
  };
}
