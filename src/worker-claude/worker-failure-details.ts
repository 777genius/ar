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
  };
}
