/** Closed capacity facts; never copy arbitrary provider/result details. */
export enum CodexGoalAvailabilityFailureReason {
  QuotaRecheckUnavailable = "quota_recheck_unavailable",
  QuotaRecheckUnresolved = "quota_recheck_unresolved",
  QuotaRecheckFailed = "quota_recheck_failed",
  QuotaLimited = "quota_limited",
  ProviderSessionInvalid = "provider_session_invalid",
}
export enum CodexGoalFailureAvailability {
  Cooldown = "cooldown",
  QuotaExhausted = "quota_exhausted",
  Disabled = "disabled",
}
export type CodexGoalAvailabilityFailure = Readonly<{
  reason: CodexGoalAvailabilityFailureReason;
  availability: CodexGoalFailureAvailability;
  accountSlot?: string;
  attemptNumber?: number;
}>;

export function parseCodexGoalAvailabilityFailure(input: unknown): CodexGoalAvailabilityFailure | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return;
  try {
    const own = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    };
    const reason = Object.values(CodexGoalAvailabilityFailureReason).find(value => value === own("reason"));
    const availability = Object.values(CodexGoalFailureAvailability).find(value => value === own("availability"));
    if (!reason || !availability) return;
    const slot = own("accountId"), attempt = own("attemptNumber");
    // Fixed public slot aliases only; never expose provider identities/auth hashes.
    const accountSlot = typeof slot === "string" && /^account-[a-z]$/.test(slot) ? slot : undefined;
    const attemptNumber = typeof attempt === "string" && /^(?:0|[1-9][0-9]{0,3})$/.test(attempt) &&
      Number(attempt) <= 4096 ? Number(attempt) : undefined;
    return Object.freeze({ reason, availability,
      ...(accountSlot === undefined ? {} : { accountSlot }),
      ...(attemptNumber === undefined ? {} : { attemptNumber }) });
  } catch { return undefined; }
}
