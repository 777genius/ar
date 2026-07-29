import {
  AgentRuntimeThreadOutcome,
  type AgentRuntimeTaskRequestV3,
  type AgentRuntimeThreadResult,
} from "../domain/agent-runtime-task-contracts";
import {
  assertOnlyKeys,
  nonEmptyStringAt,
  objectAt,
  protocolError,
  stringAt,
} from "./agent-runtime-task-validation";

export function parseLogicalThread(
  value: unknown,
  path: string,
): AgentRuntimeTaskRequestV3["thread"] {
  const input = objectAt(value, path);
  assertOnlyKeys(input, ["id"], path);
  return { id: nonEmptyStringAt(input.id, `${path}.id`) };
}

export function parseThreadResult(
  value: unknown,
  path: string,
): AgentRuntimeThreadResult {
  const input = objectAt(value, path);
  assertOnlyKeys(input, ["id", "outcome"], path);
  const outcome = stringAt(input.outcome, `${path}.outcome`);
  if (
    !Object.values(AgentRuntimeThreadOutcome).includes(
      outcome as AgentRuntimeThreadOutcome,
    )
  ) {
    throw protocolError(
      "agent_runtime_task_result_invalid",
      `${path}.outcome is unsupported`,
    );
  }
  return {
    id: nonEmptyStringAt(input.id, `${path}.id`),
    outcome: outcome as AgentRuntimeThreadOutcome,
  };
}
