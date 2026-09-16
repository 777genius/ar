import type { ProviderFailure } from "@vioxen/subscription-runtime/core";

export function workerFailureDetails(
  failure: ProviderFailure,
): Readonly<Record<string, string>> {
  return {
    code: failure.code,
    retryable: String(failure.retryable),
    reconnectRequired: String(failure.reconnectRequired),
    ...(failure.causeCategory === undefined
      ? {}
      : { causeCategory: failure.causeCategory }),
    ...providerDiagnostics(failure.details),
  };
}

const providerDiagnosticKeys = [
  "sdkSubtype",
  "sdkErrors",
  "permissionDenials",
  "hostPolicyDenials",
  "deniedTools",
  "apiRetryCount",
  "apiErrorHttpStatus",
  "terminalReason",
  "lastObservedApiRetryError",
  "lastObservedApiRetryHttpStatus",
  "lastObservedAssistantError",
  "lastObservedRateLimitStatus",
  "lastObservedRateLimitType",
  "lastObservedOverageStatus",
  "lastObservedRateLimitReason",
] as const;

function providerDiagnostics(
  details: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (details === undefined) return {};
  return Object.fromEntries(
    providerDiagnosticKeys.flatMap((key) =>
      details[key] === undefined ? [] : [[key, details[key].slice(0, 1_000)]],
    ),
  );
}
