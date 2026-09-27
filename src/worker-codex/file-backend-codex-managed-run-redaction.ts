import type { ManagedRunRecord, RedactorPort } from "@vioxen/subscription-runtime/core";

const credentialField = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|client[_-]?secret|authorization|cookie|credentials?)$/iu;

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
      credentialField.test(key) ? "[redacted:credential-field]" : redactManagedRunValue(item, redactor),
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
