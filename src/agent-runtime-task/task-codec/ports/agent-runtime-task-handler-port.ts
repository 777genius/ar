import type {
  ProviderTaskEvent,
  ProviderTaskResult,
} from "@vioxen/subscription-runtime/core";
import type {
  AgentRuntimeTaskEvent,
  AgentRuntimeTaskRequest,
  AgentRuntimeTaskResult,
} from "../domain/agent-runtime-task-contracts";

export type AgentRuntimeTaskHandlerContext = {
  readonly abortSignal: AbortSignal;
  emit(event: AgentRuntimeTaskEvent | ProviderTaskEvent): Promise<void>;
};

export type AgentRuntimeTaskHandlerResult = AgentRuntimeTaskResult | ProviderTaskResult;

export type AgentRuntimeTaskRunFunction = (
  request: AgentRuntimeTaskRequest,
  context: AgentRuntimeTaskHandlerContext,
) => Promise<AgentRuntimeTaskHandlerResult> | AgentRuntimeTaskHandlerResult;

export type AgentRuntimeTaskStreamFunction = (
  request: AgentRuntimeTaskRequest,
  context: AgentRuntimeTaskHandlerContext,
) => AsyncIterable<AgentRuntimeTaskEvent | ProviderTaskEvent>;

export type AgentRuntimeTaskHandler = {
  readonly runTask?: AgentRuntimeTaskRunFunction;
  readonly streamTask?: AgentRuntimeTaskStreamFunction;
};
