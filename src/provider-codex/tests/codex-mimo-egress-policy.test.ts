import { CodexModelBackend } from "../codex-model-backend";
import { describe, expect, it } from "vitest";
import {
  CodexProviderEgressProfileId,
  codexMimoTokenPlanEgressPolicy,
  codexProviderApiEgressPolicy,
  codexProviderEgressPolicy,
  codexProviderEgressPolicyFromEnv,
  codexProviderEgressEnv, codexProviderEgressConfigToml, codexProviderEgressCliConfigArgs,
  codexProviderHasPublicSources, codexProviderWebSearchMode, CodexWebSearchMode,
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

describe("managed public Internet native policy", () => {
  const policy = codexProviderEgressPolicy(CodexProviderEgressProfileId.ManagedPublicInternetV1);
  it("pins the explicit public profile and ignores caller local/domain substitutions", () => {
    expect(Object.isFrozen(policy)).toBe(true); expect(Object.isFrozen(policy.domains)).toBe(true);
    expect(policy.domains).toEqual(["*"]);
    expect(codexProviderEgressPolicyFromEnv(codexProviderEgressEnv(policy))).toEqual(policy);
    expect(codexProviderHasPublicSources(policy)).toBe(true);
    expect(codexProviderWebSearchMode(policy, CodexModelBackend.XiaomiMimoTokenPlan)).toBe(CodexWebSearchMode.Disabled);
    const forged = { ...policy, domains: ["localhost", "127.0.0.1", "169.254.169.254", "private.example"] };
    expect(codexProviderEgressConfigToml(forged)).toBe(codexProviderEgressConfigToml(policy));
  });
  it("keeps managed proxy enabled with every private escape path explicitly disabled in TOML and CLI", () => {
    const settings = ['enabled = true', 'domains = { "*" = "allow" }', 'mode = "full"',
      'allow_local_binding = false', 'allow_upstream_proxy = false', 'enable_socks5 = false',
      'enable_socks5_udp = false', 'dangerously_allow_non_loopback_proxy = false',
      'dangerously_allow_all_unix_sockets = false', 'credential_broker = false'];
    const toml = codexProviderEgressConfigToml(policy, { namedPermissions: true });
    expect(toml).toBe(['# Provider egress is selected by trusted host admission.', '[features.network_proxy]', ...settings, ''].join("\n"));
    const args = codexProviderEgressCliConfigArgs(policy, { namedPermissions: true });
    expect(args).toEqual(settings.flatMap(line => ["--config", "features.network_proxy." + line.replace(" = ", "=")]));
    expect(toml.split("\n").some(line => line.startsWith("unix_sockets ="))).toBe(false); expect(toml).not.toContain("proxy_url");
  });
  it("preserves legacy unrestricted FullInternetV1 config and proxy-disabled semantics", () => {
    const legacy = codexProviderEgressPolicy(CodexProviderEgressProfileId.FullInternetV1);
    expect(legacy.domains).toEqual([]);
    expect(codexProviderEgressConfigToml(legacy, { namedPermissions: true })).toBe([
      '# Provider egress is selected by trusted host admission.', '[features.network_proxy]',
      'enabled = false', 'domains = {  }', '',
    ].join("\n"));
    expect(codexProviderEgressCliConfigArgs(legacy, { namedPermissions: true })).toEqual([
      '--config', 'features.network_proxy.enabled=false', '--config', 'features.network_proxy.domains={  }',
    ]);
  });
});
