import { beforeEach, expect, it, vi } from "vitest";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { codexGoalAccountCapacityFacts } from "../codex-goal-mcp-account-capacity-facts";
import { fixture } from "./codex-goal-project-account-reservation-fixture";

const state = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("../application/codex-goal-worker-control", () => ({
  codexGoalAccountStatusPayload: state.status,
}));
beforeEach(() => { state.status.mockReset(); });
const oauthBlocked = {
  capacityAware: true,
  summary: { configured: 1, availableDeduped: 0 },
  availableDedupedAccountNames: [],
  accounts: [{ name: "account-q", capacityAvailability: "reconnect_required",
    capacityReason: "provider_session_invalid" }],
};

it("reports MiMo quota as unknown without consulting an invalid OAuth slot", async () => {
  const { manifest, launch } = fixture("/TEST-capacity-facts", "test-mimo");
  state.status.mockResolvedValue(oauthBlocked);
  const result = await codexGoalAccountCapacityFacts({ manifest,
    loadLaunch: async () => ({ ...launch, config: { ...launch.config,
      accounts: [{ name: "account-q" }], modelBackend: CodexModelBackend.XiaomiMimoTokenPlan } }),
  });
  expect(result).toEqual({ ok: true, modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    capacityAware: false, quotaAvailability: "unknown", reason: "quota_endpoint_unavailable" });
  expect(state.status).not.toHaveBeenCalled();
  for (const key of ["summary", "capacityBlockedAccounts", "availableDedupedAccountNames"])
    expect(result).not.toHaveProperty(key);
  expect(JSON.stringify(result)).not.toContain("provider_session_invalid");
});

it("retains OAuth blocked capacity facts and the non-live status request", async () => {
  const { manifest, launch } = fixture("/TEST-capacity-facts", "test-oauth");
  state.status.mockResolvedValue(oauthBlocked);
  const result = await codexGoalAccountCapacityFacts({ manifest, loadLaunch: async () => launch });
  expect(result).toEqual({ ok: true, capacityAware: true, summary: oauthBlocked.summary,
    capacityBlockedAccounts: [{ name: "account-q", availability: "reconnect_required",
      reason: "provider_session_invalid", cooldownUntil: undefined }],
    availableDedupedAccountNames: [] });
  expect(state.status).toHaveBeenCalledExactlyOnceWith(launch, { liveCheck: false });
});

it.each(["launch", "status"])("retains unavailable facts for a %s failure", async phase => {
  const { manifest, launch } = fixture("/TEST-capacity-facts", "test-failure");
  const error = new Error("TEST capacity unavailable");
  state.status.mockRejectedValue(error);
  const result = await codexGoalAccountCapacityFacts({ manifest,
    loadLaunch: async () => { if (phase === "launch") throw error; return launch; },
  });
  expect(result).toEqual({ ok: false, reason: "account_capacity_facts_unavailable",
    error: "TEST capacity unavailable" });
});
