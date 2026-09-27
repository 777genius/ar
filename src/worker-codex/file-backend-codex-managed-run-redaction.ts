import type { ManagedRunRecord, RedactorPort } from "@vioxen/subscription-runtime/core";

const credentialField = /^[a-z0-9]*(?:apikey|tokenplankey|token|secret|secretaccesskey|accesskeyid|privatekey|authorizationheader|authorization|authheader|authjson|auth|bearer|password|credentials?|cookies?|cookiejar)$/u;

function isCredentialField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return normalized === "token" || normalized === "secret" || normalized === "auth" ||
    credentialField.test(normalized);
}

export function discardLegacyAnswerSummary(record: ManagedRunRecord): ManagedRunRecord {
  if (!record.recoveryPacket?.attemptSummary) return record;
  return {
    ...record,
    recoveryPacket: {
      ...record.recoveryPacket,
      attemptSummary: "Recovered after a prior blocker.",
    },
  };
}

export function redactManagedRunValue<T>(value: T, redactor: RedactorPort): T {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // A malformed or embedded JSON fragment still passes the assignment
        // guard below; it must not bypass credential-field filtering.
      }
      if (parsed !== null && typeof parsed === "object") {
        const serialized = JSON.stringify(redactManagedRunValue(parsed, redactor));
        redactor.assertNoKnownSecret(serialized, "managed-run-recovery-store");
        return serialized as T;
      }
    }
    const redacted = redactor.redact(value);
    const assignment = /["']?([a-z][a-z0-9_.-]*)["']?\s*[:=]\s*(?:["'][^"']*["']|[^\s,;}\]]+)/giu;
    for (const match of redacted.matchAll(assignment)) {
      if (isCredentialField(match[1]!)) {
        return "[redacted:credential-bearing-text]" as T;
      }
    }
    redactor.assertNoKnownSecret(redacted, "managed-run-recovery-store");
    return redacted as T;
  }
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactManagedRunValue(item, redactor)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactManagedRunValue(key, redactor),
      isCredentialField(key) ? "[redacted:credential-field]" : redactManagedRunValue(item, redactor),
    ])) as T;
  }
  return value;
}

export function assertManagedRunIdentifiersSafe(record: ManagedRunRecord, redactor: RedactorPort): void {
  for (const identifier of [record.runId, record.request?.id, record.resumeHandle?.runId,
    record.resumeHandle?.workspacePath, record.taskId, record.assignedWorkerId,
    record.providerInstanceId, record.workspacePath]) {
    if (identifier === undefined) continue;
    if (redactor.redact(identifier) !== identifier) {
      throw new Error("managed_run_identifier_not_safe");
    }
    redactor.assertNoKnownSecret(identifier, "managed-run-identifier");
  }
}
