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
    const redacted = redactor.redact(value);
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
