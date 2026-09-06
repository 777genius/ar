import type { AppServerExecutionLease } from "./app-server-admission";
import type { AgentUsage } from "@vioxen/subscription-runtime/core";
import type { CodexAppServerJsonRpcResponse } from "../protocol/app-server-json-rpc";

export type TurnState = {
  outputText: string;
  outputBytes: number;
  deliveredOutputBytes: number;
  onTextDelta: ((text: string) => void) | null;
  usage: AgentUsage | undefined;
  usageBaseline?: AgentUsage | undefined;
  completed: boolean;
  error: Error | null;
  waiters: ((state: TurnState) => void)[];
  reconnectGraceTimer: NodeJS.Timeout | null;
};

export type PendingRequest = {
  readonly method: string;
  readonly usageLease?: AppServerExecutionLease;
  readonly resolve: (value: CodexAppServerJsonRpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
};

export function createTurnState(): TurnState {
  return {
    outputText: "",
    outputBytes: 0,
    deliveredOutputBytes: 0,
    onTextDelta: null,
    usage: undefined,
    completed: false,
    error: null,
    waiters: [],
    reconnectGraceTimer: null,
  };
}
