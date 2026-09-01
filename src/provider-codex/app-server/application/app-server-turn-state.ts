import type { AgentUsage } from "@vioxen/subscription-runtime/core";
import type { CodexAppServerJsonRpcResponse } from "../protocol/app-server-json-rpc";

export type TurnState = {
  outputText: string;
  onTextDelta: ((text: string) => void) | null;
  usage: AgentUsage | undefined;
  completed: boolean;
  error: Error | null;
  waiters: ((state: TurnState) => void)[];
  reconnectGraceTimer: NodeJS.Timeout | null;
};

export type PendingRequest = {
  readonly method: string;
  readonly resolve: (value: CodexAppServerJsonRpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
};

export function createTurnState(): TurnState {
  return {
    outputText: "",
    onTextDelta: null,
    usage: undefined,
    completed: false,
    error: null,
    waiters: [],
    reconnectGraceTimer: null,
  };
}
