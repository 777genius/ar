import { describe, expect, it } from "vitest";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { listCodexGoalAccountStatuses } from "../codex-goal-account-status";

const FAKE_MIMO_KEY_A = "tp-fixture-account-a-not-a-real-token-plan-key";
const FAKE_MIMO_KEY_B = "tp-fixture-account-b-not-a-real-token-plan-key";

describe("Codex goal account status — MiMo backend", () => {
  it("reports a MiMo slot quota_unknown when its env var holds a key, without touching disk", async () => {
    const accounts = await listCodexGoalAccountStatuses({
      // Deliberately points at a directory that does not exist — the MiMo
      // branch must never read authRootDir, so this must not matter.
      authRootDir: "/nonexistent/auth-root-must-not-be-read",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      mimoAccounts: [{ name: "mimo-a", envVarName: "MIMO_TOKEN_PLAN_API_KEY_A" }],
      sourceEnv: { MIMO_TOKEN_PLAN_API_KEY_A: FAKE_MIMO_KEY_A },
    });

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      name: "mimo-a",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      status: "quota_unknown",
      availability: "unknown",
      capacityAvailability: "unknown",
      capacityReason: "quota_endpoint_unavailable",
      schedulerEligible: false,
      recommendedAction: "inspect",
      identitySource: "mimo_api_key",
    });
    expect(accounts[0]?.safeMessage).toContain("quota and rate-limit state are unknown");
    expect(accounts[0]?.identityHashPrefix).toMatch(/^mimo:[a-f0-9]{16}$/);
    expect(accounts[0]?.authJsonPath).toBe("mimo-env:MIMO_TOKEN_PLAN_API_KEY_A");
    // The raw key must never appear anywhere in the returned status object.
    expect(JSON.stringify(accounts)).not.toContain(FAKE_MIMO_KEY_A);
  });

  it("reports auth_missing when the MiMo env var is unset or blank, and is not scheduler eligible", async () => {
    const accounts = await listCodexGoalAccountStatuses({
      authRootDir: "/nonexistent/auth-root-must-not-be-read",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      mimoAccounts: [
        { name: "mimo-missing", envVarName: "MIMO_TOKEN_PLAN_API_KEY_MISSING" },
        { name: "mimo-blank", envVarName: "MIMO_TOKEN_PLAN_API_KEY_BLANK" },
      ],
      sourceEnv: { MIMO_TOKEN_PLAN_API_KEY_BLANK: "   " },
    });

    expect(accounts).toHaveLength(2);
    for (const account of accounts) {
      expect(account).toMatchObject({
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        status: "auth_missing",
        availability: "reconnect_required",
        schedulerEligible: false,
      });
      expect(account.identityHashPrefix).toBeUndefined();
    }
  });

  it("uses the default MIMO_TOKEN_PLAN_API_KEY env var when a slot omits envVarName", async () => {
    const accounts = await listCodexGoalAccountStatuses({
      authRootDir: "/nonexistent/auth-root-must-not-be-read",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      mimoAccounts: [{ name: "mimo-default" }],
      sourceEnv: { MIMO_TOKEN_PLAN_API_KEY: FAKE_MIMO_KEY_B },
    });

    expect(accounts[0]).toMatchObject({
      status: "quota_unknown",
      availability: "unknown",
      name: "mimo-default",
    });
    expect(accounts[0]?.authJsonPath).toBe("mimo-env:MIMO_TOKEN_PLAN_API_KEY");
  });

  it("produces distinct identities for distinct keys, and never collides with a ChatGPT identity shape", async () => {
    const accounts = await listCodexGoalAccountStatuses({
      authRootDir: "/nonexistent/auth-root-must-not-be-read",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      mimoAccounts: [
        { name: "mimo-a", envVarName: "MIMO_TOKEN_PLAN_API_KEY_A" },
        { name: "mimo-b", envVarName: "MIMO_TOKEN_PLAN_API_KEY_B" },
      ],
      sourceEnv: {
        MIMO_TOKEN_PLAN_API_KEY_A: FAKE_MIMO_KEY_A,
        MIMO_TOKEN_PLAN_API_KEY_B: FAKE_MIMO_KEY_B,
      },
    });

    const [first, second] = accounts;
    expect(first?.identityHashPrefix).not.toBe(second?.identityHashPrefix);
    // ChatGPT identity hashes are plain lowercase hex with no "mimo:" prefix
    // (see sanitizedCodexIdentity/hashText below) — the "mimo:" namespace
    // prefix makes cross-backend identity collisions structurally impossible
    // wherever identityHashPrefix is used for dedup (codex-goal-accounts.ts).
    expect(first?.identityHashPrefix).toMatch(/^mimo:/);
    expect(/^[a-f0-9]{16}$/.test(first?.identityHashPrefix ?? "")).toBe(false);
  });

  it("defaults modelBackend to OpenAiChatGpt and leaves the existing auth.json discovery path untouched", async () => {
    // No modelBackend, no mimoAccounts — this must behave exactly as before.
    const accounts = await listCodexGoalAccountStatuses({
      authRootDir: "/nonexistent/auth-root-must-not-be-read",
    });
    expect(accounts).toEqual([]);
  });
});
