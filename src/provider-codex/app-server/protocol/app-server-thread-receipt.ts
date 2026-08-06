import type {
  CodexReasoningEffort,
  CodexServiceTier,
} from "../../codex-json-execution-engine";
import type { AppServerThreadExecutionReceipt } from "../domain/app-server-types";
import {
  nestedString,
  readRecord,
  stringField,
} from "./app-server-content-parser";

export function readAppServerThreadExecutionReceipt(
  value: unknown,
): AppServerThreadExecutionReceipt {
  const result = readRecord(value);
  const threadId = nestedString(result ?? undefined, ["thread", "id"]);
  const model = stringField(result, "model");
  const modelProvider = stringField(result, "modelProvider");
  const reasoningEffort = reasoningEffortField(result, "reasoningEffort");
  const serviceTierValue = result?.serviceTier;
  const serviceTier = serviceTierValue === null || serviceTierValue === undefined
    ? undefined
    : typeof serviceTierValue === "string" && serviceTierValue.trim()
      ? serviceTierValue as CodexServiceTier
      : null;
  if (!threadId || !model || !modelProvider || !reasoningEffort || serviceTier === null) {
    throw new Error("codex_app_server_thread_receipt_invalid");
  }
  return {
    threadId,
    model,
    modelProvider,
    reasoningEffort,
    ...(serviceTier === undefined ? {} : { serviceTier }),
  };
}

function reasoningEffortField(
  record: Record<string, unknown> | null,
  key: string,
): CodexReasoningEffort | null {
  const value = stringField(record, key);
  return value === "minimal" || value === "low" || value === "medium" ||
      value === "high" || value === "xhigh"
    ? value
    : null;
}
