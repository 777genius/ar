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
  return redactManagedRunValueAtDepth(value, redactor, 0);
}

function redactManagedRunValueAtDepth<T>(value: T, redactor: RedactorPort, serializedDepth: number): T {
  if (typeof value === "string") {
    if (serializedDepth >= 8) return "[redacted:deep-serialized-text]" as T;
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // A malformed or embedded JSON fragment still passes the assignment
        // guard below; it must not bypass credential-field filtering.
      }
      if (parsed !== null && (typeof parsed === "object" || typeof parsed === "string")) {
        const serialized = JSON.stringify(redactManagedRunValueAtDepth(parsed, redactor, serializedDepth + 1));
        redactor.assertNoKnownSecret(serialized, "managed-run-recovery-store");
        return serialized as T;
      }
    }
    const redacted = redactor.redact(value);
    if (containsCredentialAssignment(redacted)) {
      return "[redacted:credential-bearing-text]" as T;
    }
    redactor.assertNoKnownSecret(redacted, "managed-run-recovery-store");
    return redacted as T;
  }
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactManagedRunValueAtDepth(item, redactor, serializedDepth)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactManagedRunValueAtDepth(key, redactor, serializedDepth),
      isCredentialField(key) ? "[redacted:credential-field]" :
        redactManagedRunValueAtDepth(item, redactor, serializedDepth),
    ])) as T;
  }
  return value;
}

function containsCredentialAssignment(text: string): boolean {
  // Scan keys only. Consuming a value skips nested credential assignments,
  // while an unanchored greedy regex rescans a long token quadratically.
  for (let index = 0; index < text.length;) {
    const first = text.charCodeAt(index);
    if (!isAsciiLetter(first) && first !== 95) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < text.length && isKeyCharacter(text.charCodeAt(index))) index += 1;
    let separator = index;
    while (text[separator] === "\\") separator += 1;
    if (text[separator] === '"' || text[separator] === "'") separator += 1;
    while (separator < text.length && /\s/u.test(text[separator]!)) separator += 1;
    if ((text[separator] === ":" || text[separator] === "=") &&
        isCredentialField(text.slice(start, index))) return true;
  }
  return false;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isKeyCharacter(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57) ||
    code === 95 || code === 45 || code === 46;
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
