import { createHash } from "node:crypto";

/** Retained adapter authority only. Never include this in task/model DTOs. */
export type HostedMimoCapacityRecoveryProof = Readonly<{
  credentialFingerprint: string;
  requestedModel: string;
  requestSha256: string;
  responseIdSha256: string;
  completedResponses: number;
  assertCurrent(): void;
  /** Proves only joined proxy/dispatcher disposal, never native closure. */
  assertDisposed(): void;
}>;

export function mimoResponseProofHash(domain: "request" | "response-id", value: string): string {
  return createHash("sha256").update(`subscription-runtime:mimo-${domain}:v1\0`).update(value).digest("hex");
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Consumes already parsed protocol objects inside the existing bounded parser.
 * No text, usage, HTTP status, SSE event label or [DONE] can mint completion. */
export function observeMimoResponseCompletion(model: string): {
  observe(value: unknown, event?: string): void;
  finish(): string | undefined;
} {
  let invalid = false, responseId: string | undefined;
  return {
    observe(value, event) {
      const frame = record(value), nested = record(frame?.response);
      const response = frame?.type === "response.completed" ? nested : frame;
      if (event === "error" || (event && ["response.failed", "response.incomplete"].includes(event)) ||
          frame?.error != null || nested?.error != null || response?.error != null ||
          nested?.incomplete_details != null || response?.incomplete_details != null ||
          typeof frame?.type === "string" && ["error", "response.error", "response.failed", "response.incomplete"].includes(frame.type) ||
          typeof nested?.status === "string" && ["failed", "incomplete", "cancelled"].includes(nested.status) ||
          typeof response?.status === "string" && ["failed", "incomplete", "cancelled"].includes(response.status)) invalid = true;
      const completion = frame?.type === "response.completed" || frame?.object === "response" && frame.status === "completed";
      if (!completion) return;
      if (!response || response.object !== "response" || response.status !== "completed" ||
          typeof response.id !== "string" || !response.id.trim() || response.id.length > 1024 ||
          response.model !== undefined && response.model !== model ||
          event !== undefined && event !== "response.completed" ||
          responseId !== undefined && responseId !== response.id) { invalid = true; return; }
      responseId = response.id;
    },
    finish() { return invalid ? undefined : responseId; },
  };
}
