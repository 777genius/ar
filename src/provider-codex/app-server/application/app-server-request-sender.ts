import type { AppServerExecutionLease } from "./app-server-admission";
import { encodeJsonRpcMessage, type CodexAppServerJsonRpcResponse } from "../protocol/app-server-json-rpc";
import type { PendingRequest } from "./app-server-turn-state";
import { AppServerRequestMayHaveReachedProviderError } from "../domain/app-server-execution-safety";

export function sendAppServerRequest(input: {
  readonly id: number;
  readonly method: string;
  readonly usageLease?: AppServerExecutionLease;
  readonly params: unknown;
  readonly timeoutMs: number;
  readonly abortSignal?: AbortSignal;
  readonly pending: Map<number, PendingRequest>;
  readonly write: (message: string) => void;
}): Promise<CodexAppServerJsonRpcResponse> {
  return new Promise((resolve, reject) => {
    let requestMayHaveReachedProvider = false;
    const rejectForRequestState = (error: unknown) => reject(
      requestMayHaveReachedProvider
        ? new AppServerRequestMayHaveReachedProviderError(error, input.method)
        : error instanceof Error ? error : new Error("codex_app_server_request_failed"),
    );
    const timer = setTimeout(() => {
      input.pending.delete(input.id);
      input.abortSignal?.removeEventListener("abort", abort);
      rejectForRequestState(new Error(`codex_app_server_request_timeout:${input.method}`));
    }, input.timeoutMs);
    const abort = () => {
      clearTimeout(timer);
      input.pending.delete(input.id);
      rejectForRequestState(new Error(`codex_app_server_aborted:${input.method}`));
    };
    input.abortSignal?.addEventListener("abort", abort, { once: true });
    input.pending.set(input.id, {
      method: input.method,
      ...(input.usageLease === undefined ? {} : { usageLease: input.usageLease }),
      resolve: (value) => {
        input.abortSignal?.removeEventListener("abort", abort);
        resolve(value);
      },
      reject: (error) => {
        input.abortSignal?.removeEventListener("abort", abort);
        rejectForRequestState(error);
      },
      timer,
    });
    try {
      requestMayHaveReachedProvider = input.method === "turn/start";
      input.write(encodeJsonRpcMessage({ id: input.id, method: input.method, params: input.params }));
    } catch (error) {
      clearTimeout(timer);
      input.abortSignal?.removeEventListener("abort", abort);
      input.pending.delete(input.id);
      rejectForRequestState(
        error instanceof Error ? error : new Error("codex_app_server_write_failed"),
      );
    }
  });
}
