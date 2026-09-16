import {
  isSubscriptionWorkerError,
} from "@vioxen/subscription-runtime/worker-core";

export function errorDetails(
  error: unknown,
): Readonly<Record<string, string>> | undefined {
  const details: Record<string, string> = {};
  for (const item of errorChain(error)) {
    const nestedDetails = objectDetails(item);
    copyProviderDiagnostics(details, nestedDetails);
    if (isSubscriptionWorkerError(item)) {
      if (isSafeIdentifier(item.code)) {
        details.subscriptionWorkerCode ??= item.code;
      }
    }
    const nestedCode = safeNestedIdentifier(nestedDetails, "code");
    if (nestedCode !== undefined) {
      if (isSubscriptionWorkerError(item)) {
        details.providerFailureCode ??= nestedCode;
      } else {
        details.subscriptionWorkerCode ??= nestedCode;
      }
    }
    const runtimeReason = safeNestedIdentifier(nestedDetails, "reason");
    if (runtimeReason !== undefined) {
      details.runtimeReason ??= runtimeReason;
    }
    if (
      isObject(item) &&
      typeof item["code"] === "string" &&
      isSafeIdentifier(item["code"])
    ) {
      details.subscriptionWorkerCode ??= item["code"];
    }

    if (isObject(item)) {
      const exitCode = item["exitCode"];
      if (
        typeof exitCode === "number" ||
        (typeof exitCode === "string" && /^-?\d+$/.test(exitCode))
      ) {
        details.exitCode ??= String(exitCode);
      }
    }

    const message = item instanceof Error ? item.message : undefined;
    const match = message?.match(
      /(?:codex_json_exec_failed|node_process_runner_failed):(-?\d+):/,
    );
    if (match) {
      details.exitCode ??= match[1]!;
    }
  }

  return Object.keys(details).length === 0 ? undefined : details;
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

function copyProviderDiagnostics(
  destination: Record<string, string>,
  source: Readonly<Record<string, unknown>> | undefined,
): void {
  for (const key of providerDiagnosticKeys) {
    const value = source?.[key];
    if (typeof value === "string" && value.length > 0) {
      destination[key] ??= value.slice(0, 1_000);
    }
  }
}

export function optionalFailureDetails(
  details: Readonly<Record<string, string>> | undefined,
): { readonly details?: Readonly<Record<string, string>> } {
  return details === undefined || Object.keys(details).length === 0
    ? {}
    : { details };
}

function errorChain(error: unknown): readonly unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = isObject(current) ? current["cause"] : undefined;
  }
  return chain;
}

function isSafeIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9_.:-]{1,100}$/.test(value);
}

function objectDetails(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined;
  const details = value["details"];
  return isObject(details) ? details : undefined;
}

function safeNestedIdentifier(
  details: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && isSafeIdentifier(value)
    ? value
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
