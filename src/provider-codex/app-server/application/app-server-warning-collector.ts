import type { RedactorPort } from "@vioxen/subscription-runtime/core";
import type { AppServerWarning } from "../domain/app-server-types";

/**
 * Keeps app-server diagnostics useful without allowing an untrusted peer to
 * retain an unbounded amount of warning text. Warning producers must avoid
 * copying raw provider payloads; public result boundaries redact every field.
 */
export const defaultAppServerWarningMaxBytes = 64 * 1024;
export const defaultAppServerWarningMaxEntries = 256;

const omissionCode = "codex_app_server_warnings_omitted";
const omissionMessage = "Codex app-server warnings were omitted due to the diagnostic limit.";
const omissionBytes = warningBytes(omissionWarning(Number.MAX_SAFE_INTEGER));

export type AppServerWarningCollector = {
  push(warning: AppServerWarning): void;
  drain(): AppServerWarning[];
};

export function createBoundedAppServerWarningCollector(input: {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
} = {}): AppServerWarningCollector {
  const maxBytes = input.maxBytes ?? defaultAppServerWarningMaxBytes;
  const maxEntries = input.maxEntries ?? defaultAppServerWarningMaxEntries;
  if (!Number.isInteger(maxBytes) || maxBytes <= omissionBytes) {
    throw new Error("codex_app_server_warning_bytes_invalid");
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 2) {
    throw new Error("codex_app_server_warning_entries_invalid");
  }

  let warnings: AppServerWarning[] = [];
  // The opening bracket is the one byte not covered by per-item JSON and
  // separator accounting below. The final bracket is covered by the first
  // separator reservation.
  let bytes = 1;
  let omitted = 0;
  let seen = new Set<string>();

  const push = (warning: AppServerWarning): void => {
    const key = `${warning.code}\u0000${warning.safeMessage}`;
    const warningSize = warningBytes(warning);
    // Reserve space for one fixed omission marker. This avoids retaining or
    // truncating oversized provider text just to describe the limit.
    if (
      seen.has(key) ||
      warnings.length >= maxEntries - 1 ||
      warningSize > maxBytes - omissionBytes ||
      bytes + warningSize + omissionBytes > maxBytes
    ) {
      omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1);
      return;
    }
    seen.add(key);
    warnings.push(warning);
    bytes += warningSize;
  };

  return {
    push,
    drain(): AppServerWarning[] {
      const drained = omitted === 0
        ? warnings
        : [...warnings, omissionWarning(omitted)];
      warnings = [];
      bytes = 1;
      omitted = 0;
      seen = new Set();
      return drained;
    },
  };
}

export function redactBoundedAppServerWarnings(input: {
  readonly warnings: readonly AppServerWarning[];
  readonly redactor: RedactorPort;
  readonly context: string;
}): AppServerWarning[] {
  const collector = createBoundedAppServerWarningCollector();
  for (const warning of input.warnings) {
    collector.push(redactAppServerWarning({
      warning,
      redactor: input.redactor,
      context: input.context,
    }));
  }
  return collector.drain();
}

export function redactAppServerWarning(input: {
  readonly warning: AppServerWarning;
  readonly redactor: RedactorPort;
  readonly context: string;
}): AppServerWarning {
  const code = input.redactor.redact(input.warning.code);
  const safeMessage = input.redactor.redact(input.warning.safeMessage);
  input.redactor.assertNoKnownSecret(code, `${input.context}-code`);
  input.redactor.assertNoKnownSecret(safeMessage, `${input.context}-message`);
  return { code, safeMessage };
}

function warningBytes(warning: AppServerWarning): number {
  // Account for the JSON envelope and a separator, because warnings are
  // emitted as an array in public provider results.
  return Buffer.byteLength(JSON.stringify(warning), "utf8") + 1;
}

function omissionWarning(count: number): AppServerWarning {
  return {
    code: omissionCode,
    safeMessage: `${omissionMessage} Count: ${count}.`,
  };
}
