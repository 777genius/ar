import type { CodexAppServerJsonRpcResponse } from "../protocol/app-server-json-rpc";
import { nestedString } from "../protocol/app-server-content-parser";
import type { AppServerProviderReceiptTracker } from "./app-server-provider-receipt-tracker";

export function bindStartedTurnResponse(input: {
  readonly response: CodexAppServerJsonRpcResponse;
  readonly threadId: string;
  readonly attestationMode: "none" | "provider-receipt" | undefined;
  readonly providerReceipt: AppServerProviderReceiptTracker;
}): string {
  if (input.response.error) {
    input.providerReceipt.cancel(input.threadId);
    throw new Error(
      `codex_app_server_turn_start_failed:${input.response.error.message ?? "unknown"}`,
    );
  }
  const turnId = nestedString(input.response.result, ["turn", "id"]);
  if (!turnId) {
    input.providerReceipt.cancel(input.threadId);
    throw new Error("codex_app_server_turn_id_missing");
  }
  if (input.attestationMode === "provider-receipt") {
    input.providerReceipt.bind(input.threadId, turnId);
  }
  return turnId;
}
