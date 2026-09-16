import { CODEX_WORKER_DEFAULT_MODEL, CODEX_WORKER_DEFAULT_REASONING_EFFORT } from "./codex-worker-defaults";
import { createHash } from "node:crypto";
import type {
  ClockPort,
  ProviderFailure,
  SessionArtifact,
} from "@vioxen/subscription-runtime/core";
import {
  codexAuthJsonFromArtifact,
  type CodexReasoningEffort,
  type CodexServiceTier,
  validateCodexAuthJsonBytes,
} from "@vioxen/subscription-runtime/provider-codex";
import type { WorkerCapacitySnapshot } from "@vioxen/subscription-runtime/worker-core";
import type { SubscriptionWorkerState } from "@vioxen/subscription-runtime/worker-core";

export type CodexWorkerCapacityPolicy = {
  readonly softMaxRunsPerWindow?: number;
  readonly windowMs?: number;
  readonly quotaCooldownMs?: number;
  readonly reconnectCooldownMs?: number;
  readonly maxReconnectRetriesPerAccount?: number;
};

export class FileBackendCodexCapacityState {
  private capacityState: WorkerCapacitySnapshot = { availability: "available" };
  private windowStartedAtMs: number;
  private runsInWindow = 0;
  private consecutiveReconnectFailures = 0;
  private quotaGroup: string | null = null;
  private capacityAccountId: string | null;

  constructor(
    private readonly options: {
      readonly clock: ClockPort;
      readonly providerInstanceId: string;
      readonly configuredAccountId?: string | null;
      readonly model?: string;
      readonly reasoningEffort?: CodexReasoningEffort;
      readonly serviceTier?: CodexServiceTier;
      readonly policy?: CodexWorkerCapacityPolicy;
    },
  ) {
    this.windowStartedAtMs = options.clock.now().getTime();
    this.capacityAccountId = normalizeCapacityAccountId(options.configuredAccountId);
  }

  get accountId(): string | null {
    return this.capacityAccountId;
  }

  hasKnownAccountIdentity(): boolean {
    return Boolean(this.quotaGroup || this.capacityAccountId);
  }

  snapshot(input: {
    readonly workerState: SubscriptionWorkerState;
    readonly authSourceChanged: boolean;
  }): WorkerCapacitySnapshot {
    if (input.workerState === "created" || input.workerState === "starting") {
      return this.withCapacityDetails({
        availability: "disabled",
        reason: "not_started",
      });
    }
    if (input.workerState === "prewarming") {
      return this.withCapacityDetails({ availability: "warming" });
    }
    if (input.workerState === "disposed") {
      return this.withCapacityDetails({
        availability: "disabled",
        reason: "disposed",
      });
    }
    if (input.workerState === "failed") {
      return this.withCapacityDetails({
        availability: "degraded",
        reason: "worker_failed",
      });
    }

    this.rollWindow();
    const previousCapacity = this.capacityState;
    this.capacityState = normalizeResettableCapacity(
      this.capacityState,
      this.options.clock.now(),
    );
    if (
      input.authSourceChanged &&
      isAuthReseedableCapacity(this.capacityState)
    ) {
      this.capacityState = {
        availability: "available",
        reason: "auth_reseed_pending",
        lastLimitSignalAt: this.options.clock.now(),
        details: { authSourceChanged: "true" },
      };
      this.consecutiveReconnectFailures = 0;
    }
    if (
      previousCapacity.availability === "cooldown" &&
      previousCapacity.reason === "session_unhealthy" &&
      this.capacityState.availability === "available"
    ) {
      this.consecutiveReconnectFailures = 0;
    }
    return this.withCapacityDetails({
      ...this.capacityState,
      recentRuns: this.runsInWindow,
      ...(this.options.policy?.softMaxRunsPerWindow === undefined
        ? {}
        : {
            softLimitRemainingRuns: Math.max(
              0,
              this.options.policy.softMaxRunsPerWindow -
                this.runsInWindow,
            ),
          }),
    });
  }

  recordSuccessfulRun(): void {
    this.rollWindow();
    this.consecutiveReconnectFailures = 0;
    if (this.capacityState.reason === "reconnect_retry_pending") {
      this.capacityState = { availability: "available" };
    }
    this.runsInWindow += 1;
    const maxRuns = this.options.policy?.softMaxRunsPerWindow;
    if (maxRuns === undefined || this.runsInWindow < maxRuns) return;
    const cooldownUntil = new Date(
      this.windowStartedAtMs + capacityWindowMs(this.options.policy),
    );
    this.capacityState = {
      availability: "cooldown",
      reason: "soft_run_limit",
      cooldownUntil,
    };
  }

  recordFailure(failure: ProviderFailure): void {
    if (failure.code === "quota_limited") {
      this.capacityState = {
        availability: "cooldown",
        reason: "quota_limited",
        cooldownUntil: new Date(
          this.options.clock.now().getTime() +
            (this.options.policy?.quotaCooldownMs ?? 15 * 60 * 1000),
        ),
      };
      return;
    }
    if (failure.code === "provider_session_invalid") {
      this.capacityState = {
        availability: "disabled",
        reason: failure.code,
      };
      return;
    }
    if (failure.reconnectRequired) {
      this.recordReconnectRequired(failure.code);
      return;
    }
    if (!failure.retryable) {
      this.capacityState = {
        availability: "degraded",
        reason: failure.code,
      };
    }
  }

  recordBlocked(reason: string): void {
    if (reason === "quota_limited") {
      this.capacityState = {
        availability: "cooldown",
        reason,
        cooldownUntil: new Date(
          this.options.clock.now().getTime() +
            (this.options.policy?.quotaCooldownMs ?? 15 * 60 * 1000),
        ),
      };
      return;
    }
    if (reason === "provider_reconnect_required") {
      this.recordReconnectRequired(reason);
    }
  }

  recordAuthImported(): void {
    this.capacityState = { availability: "available" };
    this.consecutiveReconnectFailures = 0;
  }

  rememberQuotaGroup(session: SessionArtifact): void {
    try {
      const authJsonBytes = codexAuthJsonFromArtifact(session);
      const validation = validateCodexAuthJsonBytes({ authJsonBytes });
      this.quotaGroup = `codex-chatgpt:${hashText(
        validation.parsed.tokens.refresh_token,
      ).slice(0, 16)}`;
      this.capacityAccountId =
        normalizeCapacityAccountId(this.options.configuredAccountId) ??
        this.quotaGroup;
    } catch {
      this.quotaGroup = null;
      this.capacityAccountId = normalizeCapacityAccountId(
        this.options.configuredAccountId,
      );
    }
  }

  private recordReconnectRequired(reason: string): void {
    const maxRetries =
      this.options.policy?.maxReconnectRetriesPerAccount ?? 4;
    if (this.consecutiveReconnectFailures < maxRetries) {
      this.consecutiveReconnectFailures += 1;
      this.capacityState = {
        availability: "available",
        reason: "reconnect_retry_pending",
        lastLimitSignalAt: this.options.clock.now(),
        details: {
          reconnectReason: reason,
          reconnectRetry: String(this.consecutiveReconnectFailures),
          maxReconnectRetries: String(maxRetries),
        },
      };
      return;
    }

    this.capacityState = {
      availability: "cooldown",
      reason: "session_unhealthy",
      cooldownUntil: new Date(
        this.options.clock.now().getTime() +
          (this.options.policy?.reconnectCooldownMs ??
            this.options.policy?.quotaCooldownMs ??
            15 * 60 * 1000),
      ),
      lastLimitSignalAt: this.options.clock.now(),
      details: {
        reconnectReason: reason,
        maxReconnectRetries: String(maxRetries),
      },
    };
  }

  private rollWindow(): void {
    const nowMs = this.options.clock.now().getTime();
    const windowMs = capacityWindowMs(this.options.policy);
    if (nowMs - this.windowStartedAtMs < windowMs) return;
    this.windowStartedAtMs = nowMs;
    this.runsInWindow = 0;
    if (this.capacityState.availability === "cooldown") {
      this.capacityState = { availability: "available" };
    }
  }

  private withCapacityDetails(
    capacity: WorkerCapacitySnapshot,
  ): WorkerCapacitySnapshot {
    return {
      ...capacity,
      details: {
        ...(capacity.details ?? {}),
        providerInstanceId: this.options.providerInstanceId,
        ...(this.capacityAccountId
          ? { accountId: this.capacityAccountId }
          : {}),
        ...(this.quotaGroup ? { quotaGroup: this.quotaGroup } : {}),
        capacityProvider: "codex",
        capacityModel: this.options.model ?? CODEX_WORKER_DEFAULT_MODEL,
        capacityReasoningEffort: this.options.reasoningEffort ?? CODEX_WORKER_DEFAULT_REASONING_EFFORT,
        ...(this.options.serviceTier
          ? { capacityServiceTier: this.options.serviceTier }
          : {}),
      },
    };
  }
}

export function capacityWindowMs(policy: CodexWorkerCapacityPolicy | undefined): number {
  return policy?.windowMs ?? 5 * 60 * 60 * 1000;
}

export function normalizeResettableCapacity(
  capacity: WorkerCapacitySnapshot,
  now: Date,
): WorkerCapacitySnapshot {
  if (
    !isResettableCapacity(capacity) ||
    !capacity.cooldownUntil ||
    capacity.cooldownUntil.getTime() > now.getTime()
  ) {
    return capacity;
  }

  const {
    cooldownUntil: _cooldownUntil,
    lastLimitSignalAt: _lastLimitSignalAt,
    reason: _reason,
    ...rest
  } = capacity;
  return {
    ...rest,
    availability: "available",
  };
}

export function isAuthReseedableCapacity(capacity: WorkerCapacitySnapshot): boolean {
  return (
    capacity.availability !== "available" &&
    (
      capacity.reason === "auth_invalid" ||
      capacity.reason === "provider_session_invalid" ||
      capacity.reason === "reconnect_required" ||
      capacity.reason === "provider_reconnect_required" ||
      capacity.reason === "session_unhealthy" ||
      capacity.reason === "quota_limited" ||
      capacity.availability === "cooldown" ||
      capacity.availability === "quota_exhausted" ||
      capacity.availability === "disabled"
    )
  );
}

function isResettableCapacity(capacity: WorkerCapacitySnapshot): boolean {
  return (
    capacity.availability === "cooldown" ||
    capacity.availability === "quota_exhausted"
  );
}

export function isSevereCapacity(capacity: WorkerCapacitySnapshot): boolean {
  return (
    capacity.availability === "quota_exhausted" ||
    capacity.availability === "degraded" ||
    capacity.availability === "disabled"
  );
}

export function normalizeCapacityAccountId(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
