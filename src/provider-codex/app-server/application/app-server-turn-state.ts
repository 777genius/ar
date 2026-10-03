import type { AppServerExecutionLease } from "./app-server-admission";
import type { AgentUsage } from "@vioxen/subscription-runtime/core";
import type { CodexAppServerJsonRpcResponse } from "../protocol/app-server-json-rpc";

export type TurnState = {
  outputText: string;
  outputBytes: number;
  deliveredOutputBytes: number;
  onTextDelta: ((text: string) => void) | null;
  usage: AgentUsage | undefined;
  /** The thread cumulative counter as it stood immediately before this turn. */
  usageBaseline?: AgentUsage | undefined;
  /** The highest cumulative counter this turn has been shown, to detect rewrites. */
  usageTotalSeen?: AgentUsage | undefined;
  /** The thread this turn's usage was observed on, for live-record syncing. */
  usageThreadId?: string | undefined;
  /** Degraded-billing codes already announced for this turn, one warning each. */
  usageWarned: Set<string>;
  /** The provider replaced its cumulative counter under this turn; its delta is dead. */
  usageCounterRewritten: boolean;
  /** A malformed exact snapshot bars this turn from ever reporting usage again. */
  usagePoisoned: boolean;
  completed: boolean;
  error: Error | null;
  waiters: ((state: TurnState) => void)[];
  reconnectGraceTimer: NodeJS.Timeout | null;
};

/**
 * What a caller learns about one finished turn.
 *
 * `usagePoisoned` is part of the contract rather than an internal detail: a
 * caller that reconciles usage against a coarser counter (the goal runner's
 * checkpoint window) must be able to tell "this turn reported no usage" from
 * "this turn's usage is untrusted", because only the first may be backfilled.
 */
export type AppServerTurnResult = {
  readonly outputText: string;
  readonly usage: AgentUsage | undefined;
  readonly usagePoisoned: boolean;
  readonly completed: boolean;
  readonly error: Error | null;
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
    usageWarned: new Set(),
    usageCounterRewritten: false,
    usagePoisoned: false,
    completed: false,
    error: null,
    waiters: [],
    reconnectGraceTimer: null,
  };
}
