import { describe, expect, it } from "vitest";
import {
  CodexProviderEgressProfileId,
  codexMimoTokenPlanEgressPolicy,
  codexProviderApiEgressPolicy,
  codexProviderEgressPolicy,
  codexProviderEgressPolicyFromEnv,
  codexProviderEgressEnv,
} from "../codex-provider-egress-policy";

describe("MiMo Token Plan egress policy", () => {
  it("is a distinct, frozen, single-domain profile that never includes api.openai.com", () => {
    const policy = codexMimoTokenPlanEgressPolicy();
    expect(policy.profileId).toBe(CodexProviderEgressProfileId.MimoTokenPlan);
    expect(policy.domains).toEqual(["token-plan-sgp.xiaomimimo.com"]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.domains)).toBe(true);
    expect(policy.domains).not.toContain("api.openai.com");
    expect(codexProviderApiEgressPolicy().domains).not.toContain("token-plan-sgp.xiaomimimo.com");
  });

  it("round-trips through the env marker used to admit a policy across process boundaries", () => {
    const policy = codexMimoTokenPlanEgressPolicy();
    expect(codexProviderEgressPolicyFromEnv(codexProviderEgressEnv(policy))).toEqual(policy);
  });

  it("is reachable through the same finite profileId switch as the other profiles", () => {
    expect(codexProviderEgressPolicy(CodexProviderEgressProfileId.MimoTokenPlan)).toEqual(
      codexMimoTokenPlanEgressPolicy(),
    );
  });
});
