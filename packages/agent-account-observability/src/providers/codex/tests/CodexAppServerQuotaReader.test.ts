import { describe, expect, it } from "vitest";
import { ObservationPolicy } from "../../../domain/ObservationPolicy";
import {
  AgentProvider,
  AuthSessionStatus,
  QuotaLimitState,
  QuotaWindowKind,
} from "../../../domain/enums";
import {
  CodexAppServerQuotaReader,
  codexMainQuotaSummary,
  quotaSnapshotFromRateLimits,
} from "../CodexAppServerQuotaReader";
import type {
  CodexAccountSlot,
  CodexAppServerClientFactoryPort,
  CodexAppServerClientPort,
} from "../codexTypes";

const now = new Date("2026-07-09T10:00:00.000Z");
const account: CodexAccountSlot = {
  provider: AgentProvider.Codex,
  slotId: "account-a",
  authHome: "/tmp/account-a",
  email: "operator@example.com",
};

describe("CodexAppServerQuotaReader", () => {
  it("maps app-server account and multi-bucket rate limits", async () => {
    const reader = new CodexAppServerQuotaReader({
      clientFactory: fakeFactory({
        "account/read": {
          account: {
            id: "chatgpt-account-a",
            email: "operator@example.com",
          },
        },
        "account/rateLimits/read": {
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              limitName: "Codex",
              usedPercent: 100,
              windowDurationMins: 300,
              resetsAt: 1783602000,
              rateLimitReachedType: "five_hour_limit",
            },
            weekly: {
              limitId: "weekly",
              usedPercent: 41,
              windowDurationMins: 10080,
              resetsAt: 1783861200,
            },
          },
          rateLimitResetCredits: { available: 1 },
        },
      }),
    });

    const result = await reader.readAuthAndQuota({ account, now });

    expect(result.auth).toMatchObject({
      status: AuthSessionStatus.Authenticated,
      identity: {
        safeIdentity: "op***@ex***",
        providerAccountId: "chatgpt-account-a",
      },
    });
    expect(result.quota).toMatchObject({
      provider: AgentProvider.Codex,
      windows: [
        {
          kind: QuotaWindowKind.FiveHour,
          limitId: "codex",
          usedPercent: 100,
          state: QuotaLimitState.Limited,
          reachedType: "five_hour_limit",
        },
        {
          kind: QuotaWindowKind.SevenDay,
          limitId: "weekly",
          usedPercent: 41,
          state: QuotaLimitState.Clear,
        },
      ],
    });
    expect(result.evidence.map((item) => item.source)).toEqual([
      "codex_app_server",
      "codex_app_server",
    ]);
    expect(codexMainQuotaSummary(result.quota)).toMatchObject({
      fiveHour: { limitId: "codex" },
      sevenDay: { limitId: "weekly" },
    });
  });

  it("classifies revoked refresh token errors as relogin required", async () => {
    const reader = new CodexAppServerQuotaReader({
      clientFactory: fakeFactory({
        "account/read": new Error("refresh token was revoked"),
      }),
    });

    const result = await reader.readAuthAndQuota({ account, now });

    expect(result.auth).toMatchObject({
      status: AuthSessionStatus.ReloginRequired,
      reason: "refresh_token_revoked",
    });
    expect(result.quota).toBeNull();
  });

  it("maps current app-server primary and secondary rate limit buckets", async () => {
    const reader = new CodexAppServerQuotaReader({
      clientFactory: fakeFactory({
        "account/read": {
          account: {
            email: "operator@example.com",
          },
        },
        "account/rateLimits/read": {
          rateLimits: {
            limitId: "codex",
            primary: {
              usedPercent: 99,
              windowDurationMins: 300,
              resetsAt: 1783611003,
            },
            secondary: {
              usedPercent: 83,
              windowDurationMins: 10080,
              resetsAt: 1784125535,
            },
            planType: "pro",
            rateLimitReachedType: "rate_limit_reached",
          },
          rateLimitsByLimitId: {
            codex_bengalfox: {
              limitId: "codex_bengalfox",
              limitName: "GPT-5.3-Codex-Spark",
              primary: {
                usedPercent: 0,
                windowDurationMins: 300,
                resetsAt: 1783619797,
              },
              secondary: {
                usedPercent: 0,
                windowDurationMins: 10080,
                resetsAt: 1783607140,
              },
              planType: "pro",
            },
          },
        },
      }),
    });

    const result = await reader.readAuthAndQuota({ account, now });

    expect(result.quota).toMatchObject({
      planType: "pro",
      windows: [
        {
          kind: QuotaWindowKind.FiveHour,
          limitId: "codex_bengalfox",
          limitName: "GPT-5.3-Codex-Spark",
          usedPercent: 0,
          state: QuotaLimitState.Clear,
        },
        {
          kind: QuotaWindowKind.SevenDay,
          limitId: "codex_bengalfox",
          limitName: "GPT-5.3-Codex-Spark",
          usedPercent: 0,
          state: QuotaLimitState.Clear,
        },
        {
          kind: QuotaWindowKind.FiveHour,
          limitId: "codex",
          usedPercent: 99,
          state: QuotaLimitState.Limited,
          reachedType: "rate_limit_reached",
        },
        {
          kind: QuotaWindowKind.SevenDay,
          limitId: "codex",
          usedPercent: 83,
          state: QuotaLimitState.Limited,
          reachedType: "rate_limit_reached",
        },
      ],
    });
    expect(codexMainQuotaSummary(result.quota)).toMatchObject({
      fiveHour: {
        limitId: "codex",
        usedPercent: 99,
      },
      sevenDay: {
        limitId: "codex",
        usedPercent: 83,
      },
    });
  });

  it("classifies token_invalidated rate limit errors as relogin required", async () => {
    const reader = new CodexAppServerQuotaReader({
      clientFactory: fakeFactory({
        "account/read": {
          account: {
            email: "operator@example.com",
          },
        },
        "account/rateLimits/read": new Error(
          "failed to fetch codex rate limits: token_invalidated Your authentication token has been invalidated",
        ),
      }),
    });

    const result = await reader.readAuthAndQuota({ account, now });

    expect(result.auth).toMatchObject({
      status: AuthSessionStatus.ReloginRequired,
      reason: "refresh_token_revoked",
    });
    expect(result.quota).toBeNull();
  });
});

function fakeFactory(
  responses: Readonly<Record<string, unknown>>,
): CodexAppServerClientFactoryPort {
  return {
    async open() {
      return {
        async call(input) {
          const response = responses[input.method];
          if (response instanceof Error) throw response;
          return response ?? {};
        },
        async close() {},
      } satisfies CodexAppServerClientPort;
    },
  };
}

describe("Codex included allowance with usable credits", () => {
  const snapshot = (credits: unknown, limitId = "codex", reachedType?: string) => quotaSnapshotFromRateLimits({ now, result: {
    rateLimitsByLimitId: { [limitId]: { limitId, planType: "pro", credits,
      primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1783861200,
        ...(reachedType ? { rateLimitReachedType: reachedType } : {}) } } },
  } });
  it.each([
    { hasCredits: true, unlimited: false, balance: "42408.6990600000" },
    { hasCredits: true, unlimited: false, balance: "0.0001" },
    { hasCredits: true, unlimited: true, balance: "0" },
  ])("permits Codex with actual usable credits %j", credits => {
    const quota = snapshot(credits);
    expect(quota?.windows[0]?.usedPercent).toBe(100);
    expect(new ObservationPolicy().decide({ auth: { status: AuthSessionStatus.Authenticated, checkedAt: now }, quota }))
      .toMatchObject({ availability: "available", schedulerEligible: true });
  });
  it.each([
    undefined, { hasCredits: false, unlimited: false, balance: "42" },
    { hasCredits: true, unlimited: false, balance: "0" }, { hasCredits: true, unlimited: false, balance: "-1" },
    { hasCredits: true, unlimited: false, balance: "NaN" }, { hasCredits: true, unlimited: false, balance: "Infinity" },
    { hasCredits: true, unlimited: false, balance: "1e4" }, { hasCredits: "true", unlimited: false, balance: "42" },
    { hasCredits: true, unlimited: "true", balance: "0" }, { resetCreditsAvailable: 3 },
  ])("keeps absent, exhausted or malformed credit state blocked %j", credits => {
    expect(snapshot(credits)?.windows[0]?.state).toBe(QuotaLimitState.Limited);
  });
  it("does not clear another model bucket from Codex credit metadata", () => {
    expect(snapshot({ hasCredits: true, unlimited: false, balance: "42" }, "another_model")?.windows[0]?.state)
      .toBe(QuotaLimitState.Limited);
  });
  it("does not mask an explicit reached-type provider signal", () => {
    expect(snapshot({ hasCredits: true, unlimited: false, balance: "42" }, "codex", "provider_hard_limit")?.windows[0]?.state)
      .toBe(QuotaLimitState.Limited);
  });
});


describe("paid-credit provider rejection and balance authority regressions", () => {
  const decide = (quota: ReturnType<typeof quotaSnapshotFromRateLimits>) =>
    new ObservationPolicy().decide({
      auth: { status: AuthSessionStatus.Authenticated, checkedAt: now }, quota,
    });

  it.each([
    { parent: "provider_hard_limit", nested: undefined, reason: "provider_hard_limit" },
    { parent: "provider_hard_limit", nested: "", reason: "provider_hard_limit" },
    { parent: "", nested: "nested_hard_limit", reason: "nested_hard_limit" },
    { parent: "parent_hard_limit", nested: "nested_hard_limit", reason: "nested_hard_limit" },
  ])("preserves parent/nested rejection precedence %j", ({ parent, nested, reason }) => {
    const quota = quotaSnapshotFromRateLimits({ now, result: {
      rateLimits: {
        limitId: "codex",
        rateLimitReachedType: parent,
        credits: { hasCredits: true, unlimited: false, balance: "42408.6990600000" },
        primary: { usedPercent: 20, windowDurationMins: 300, rateLimitReachedType: nested },
        secondary: { usedPercent: 100, windowDurationMins: 10080, rateLimitReachedType: nested },
      },
    } });
    expect(quota.windows).toHaveLength(2);
    for (const window of quota.windows) {
      expect(window).toMatchObject({ state: QuotaLimitState.Limited, reachedType: reason,
        creditsRemaining: 42408.69906 });
    }
    expect(quota.windows[1]?.usedPercent).toBe(100);
    expect(decide(quota)).toMatchObject({ schedulerEligible: false, reason });
  });

  it.each([
    { balance: "0", remaining: 42, expected: 0, eligible: false },
    { balance: "NaN", remaining: 42, expected: undefined, eligible: false },
    { balance: null, remaining: 42, expected: undefined, eligible: false },
    { balance: "42408.6990600000", remaining: 0, expected: 42408.69906, eligible: true },
    { balance: 0.0001, remaining: 0, expected: 0.0001, eligible: true },
  ])("uses modern balance for display and authorization %j", ({ balance, remaining, expected, eligible }) => {
    const quota = quotaSnapshotFromRateLimits({ now, result: {
      rateLimitsByLimitId: { codex: {
        credits: { hasCredits: true, unlimited: false, balance, remaining },
        secondary: { usedPercent: 100, windowDurationMins: 10080 },
      } },
    } });
    expect(quota.windows[0]?.creditsRemaining).toBe(expected);
    expect(quota.windows[0]?.usedPercent).toBe(100);
    expect(quota.windows[0]?.state).toBe(eligible ? QuotaLimitState.Clear : QuotaLimitState.Limited);
    expect(decide(quota).schedulerEligible).toBe(eligible);
  });

  it("keeps legacy remaining display separate from modern paid authorization", () => {
    const quota = quotaSnapshotFromRateLimits({ now, result: {
      rateLimits: { limitId: "codex", credits: { hasCredits: true, unlimited: false, remaining: 42 },
        secondary: { usedPercent: 100, windowDurationMins: 10080 } },
    } });
    expect(quota.windows[0]).toMatchObject({ creditsRemaining: 42, usedPercent: 100,
      state: QuotaLimitState.Limited });
    expect(decide(quota).schedulerEligible).toBe(false);
  });
});

describe("paid credits with classified included limits and spend controls", () => {
  const observedAccountWRead = {
    "ordinaryUsageAllowed": false,
    "rateLimits": {
      "limitId": "codex",
      "limitName": null,
      "normalModelSlug": null,
      "primary": {
        "usedPercent": 100,
        "windowDurationMins": 10080,
        "resetsAt": 1791580409
      },
      "secondary": null,
      "credits": {
        "hasCredits": true,
        "unlimited": false,
        "balance": "37338.9693840000"
      },
      "individualLimit": null,
      "spendControlReached": false,
      "planType": "pro",
      "rateLimitReachedType": "rate_limit_reached"
    },
    "rateLimitsByLimitId": {
      "codex": {
        "limitId": "codex",
        "limitName": null,
        "normalModelSlug": null,
        "primary": {
          "usedPercent": 100,
          "windowDurationMins": 10080,
          "resetsAt": 1791580409
        },
        "secondary": null,
        "credits": {
          "hasCredits": true,
          "unlimited": false,
          "balance": "37338.9693840000"
        },
        "individualLimit": null,
        "spendControlReached": false,
        "planType": "pro",
        "rateLimitReachedType": "rate_limit_reached"
      }
    },
    "rateLimitResetCredits": {
      "availableCount": 1,
      "credits": [
        {
          "id": "[field_omitted]",
          "resetType": "codexRateLimits",
          "status": "available",
          "grantedAt": 1790709080,
          "expiresAt": 1793301080,
          "title": "Full reset",
          "description": "Thanks for using Codex! You've been granted one free rate limit reset."
        }
      ]
    },
    "accountId": "[field_omitted]",
    "rateLimitUpsell": null
  };
  const credits = { hasCredits: true, unlimited: false, balance: "37338.9693840000" };
  const bucket = (overrides: Record<string, unknown> = {}) => ({
    limitId: "codex", credits, spendControlReached: false,
    rateLimitReachedType: "rate_limit_reached",
    primary: { usedPercent: 100, windowDurationMins: 10080 }, ...overrides,
  });
  const snapshot = (value: Record<string, unknown>) =>
    quotaSnapshotFromRateLimits({ now, result: { rateLimits: value } });
  const decide = (quota: ReturnType<typeof quotaSnapshotFromRateLimits>) =>
    new ObservationPolicy().decide({
      auth: { status: AuthSessionStatus.Authenticated, checkedAt: now }, quota,
    });

  it("permits the observed account-w included-limit snapshot through verified paid credits", () => {
    const quota = quotaSnapshotFromRateLimits({ now, result: observedAccountWRead });
    expect(quota.windows).toHaveLength(1);
    expect(quota.windows[0]).toMatchObject({
      state: QuotaLimitState.Clear, usedPercent: 100, creditsRemaining: 37338.969384,
      reachedType: "rate_limit_reached", kind: QuotaWindowKind.SevenDay,
    });
    expect(decide(quota)).toMatchObject({ availability: "available", schedulerEligible: true });
  });

  it("blocks explicit spend control below included usage limits", () => {
    const quota = snapshot(bucket({
      spendControlReached: true, rateLimitReachedType: null,
      primary: { usedPercent: 3, windowDurationMins: 10080 },
    }));
    expect(quota.windows[0]?.state).toBe(QuotaLimitState.Limited);
    expect(decide(quota).schedulerEligible).toBe(false);
  });

  it.each([
    "workspace_owner_credits_depleted", "workspace_member_credits_depleted",
    "workspace_owner_usage_limit_reached", "workspace_member_usage_limit_reached",
    "future_provider_denial",
  ])("preserves parent hard or unknown reason %s over a nested generic limit", reason => {
    const quota = snapshot(bucket({
      rateLimitReachedType: reason,
      primary: { usedPercent: 100, windowDurationMins: 10080, rateLimitReachedType: "rate_limit_reached" },
    }));
    expect(quota.windows[0]).toMatchObject({ state: QuotaLimitState.Limited, reachedType: reason });
    expect(decide(quota)).toMatchObject({ schedulerEligible: false, reason });
  });

  it.each([
    { parent: true, nested: false }, { parent: false, nested: true },
    { parent: false, nested: null }, { parent: null, nested: false },
    { parent: false, nested: "false" }, { parent: "false", nested: false },
    { parent: false, nested: 0 }, { parent: 0, nested: false },
    { parent: undefined, nested: undefined },
  ])("does not grant credits for conflicting or unavailable spend control %j", ({ parent, nested }) => {
    const quota = snapshot(bucket({
      spendControlReached: parent,
      primary: { usedPercent: 100, windowDurationMins: 10080, spendControlReached: nested },
    }));
    expect(quota.windows[0]?.state).toBe(QuotaLimitState.Limited);
    expect(decide(quota).schedulerEligible).toBe(false);
  });

  it("accepts matching explicit false spend controls", () => {
    expect(decide(snapshot(bucket({
      primary: { usedPercent: 100, windowDurationMins: 10080, spendControlReached: false },
    }))).schedulerEligible).toBe(true);
  });

  it.each([null, "false", 0])("keeps malformed parent spend control %j blocked", spendControlReached => {
    expect(decide(snapshot(bucket({ spendControlReached }))).schedulerEligible).toBe(false);
  });

  it("keeps an absent parent spend control blocked", () => {
    const value: Record<string, unknown> = bucket();
    delete value.spendControlReached;
    expect(decide(snapshot(value)).schedulerEligible).toBe(false);
  });

  it.each([
    undefined, { hasCredits: false, unlimited: false, balance: "42" },
    { hasCredits: true, unlimited: false, balance: "0" },
    { hasCredits: true, unlimited: false, balance: "NaN" },
    { hasCredits: true, unlimited: false, remaining: 42 },
    { resetCreditsAvailable: 1 },
  ])("requires verified modern paid credit metadata %j for the generic exception", creditState => {
    expect(decide(snapshot(bucket({ credits: creditState }))).schedulerEligible).toBe(false);
  });

  it("does not apply the paid generic exception to another bucket", () => {
    expect(decide(snapshot(bucket({ limitId: "another_model" }))).schedulerEligible).toBe(false);
  });

  it.each([true, false])("retains hard denial across contradictory same-bucket views (hard map=%s)", hardMap => {
    const hard = bucket({ rateLimitReachedType: "workspace_owner_usage_limit_reached" });
    const clear = bucket();
    const quota = quotaSnapshotFromRateLimits({ now, result: {
      rateLimitsByLimitId: { codex: hardMap ? hard : clear },
      rateLimits: hardMap ? clear : hard,
    } });
    expect(quota.windows).toHaveLength(1);
    expect(quota.windows[0]).toMatchObject({
      state: QuotaLimitState.Limited, reachedType: "workspace_owner_usage_limit_reached",
    });
    expect(decide(quota)).toMatchObject({
      schedulerEligible: false, reason: "workspace_owner_usage_limit_reached",
    });
  });

  it("does not convert a real quota-read 429 into an available credit snapshot", async () => {
    const reader = new CodexAppServerQuotaReader({ clientFactory: fakeFactory({
      "account/read": { account: { email: "operator@example.com" } },
      "account/rateLimits/read": new Error("HTTP 429 rate_limit_reached"),
    }) });
    await expect(reader.readAuthAndQuota({ account, now }))
      .rejects.toThrow("codex_app_server_quota_read_failed:HTTP 429 rate_limit_reached");
  });
});
