export type SubscriptionWorkerErrorCode =
  | "subscription_worker_not_started"
  | "subscription_worker_already_started"
  | "subscription_worker_disposed"
  | "subscription_worker_start_failed"
  | "subscription_worker_start_timeout"
  | "subscription_worker_prewarm_failed"
  | "subscription_worker_run_failed"
  | "subscription_worker_health_failed"
  | "subscription_worker_account_unavailable"
  | "subscription_worker_shutdown_timeout"
  | "subscription_worker_pool_draining"
  | "subscription_worker_pool_capacity_unavailable"
  | "subscription_worker_pool_queue_full"
  | "subscription_worker_pool_run_aborted"
  | "subscription_worker_pool_empty"
  | "subscription_worker_pool_selector_invalid"
  | "subscription_worker_pool_slot_busy"
  | "subscription_worker_pool_slot_not_found"
  | "subscription_worker_pool_slot_restart_failed"
  | "subscription_worker_pool_slot_failed";

export type SubscriptionWorkerUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
};

export class SubscriptionWorkerError extends Error {
  constructor(
    readonly code: SubscriptionWorkerErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, string>>;
      readonly usage?: SubscriptionWorkerUsage;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SubscriptionWorkerError";
    this.details = options.details ?? {};
    this.usage = sanitizedSubscriptionWorkerUsage(options.usage);
  }

  readonly details: Readonly<Record<string, string>>;
  readonly usage: SubscriptionWorkerUsage | undefined;
}

export function isSubscriptionWorkerError(
  error: unknown,
): error is SubscriptionWorkerError {
  return error instanceof SubscriptionWorkerError;
}

export function subscriptionWorkerUsageFromError(
  error: unknown,
): SubscriptionWorkerUsage | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof SubscriptionWorkerError && current.usage) {
      return current.usage;
    }
    current =
      current instanceof Error
        ? (current as Error & { cause?: unknown }).cause
        : undefined;
  }
  return undefined;
}

function sanitizedSubscriptionWorkerUsage(
  usage: SubscriptionWorkerUsage | undefined,
): SubscriptionWorkerUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = sanitizedTokenCount(usage.inputTokens);
  const outputTokens = sanitizedTokenCount(usage.outputTokens);
  const totalTokens = sanitizedTokenCount(usage.totalTokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function sanitizedTokenCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
