import { CodexModelBackend } from "./codex-model-backend";

export const codexProviderEgressProfileEnvVar =
  "SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE";

export enum CodexProviderEgressProfileId {
  ProviderApi = "codex-provider-api",
  TestNpmQualification = "codex-test-npm-qualification",
  TestManagedQualification = "codex-test-managed-qualification",
  MimoTokenPlan = "codex-provider-mimo-token-plan",
  PublicResearchV1 = "codex-public-research-v1",
}
export const codexProviderApiEgressProfileId = CodexProviderEgressProfileId.ProviderApi;

export type CodexProviderEgressPolicy = {
  readonly profileId: CodexProviderEgressProfileId;
  readonly domains: readonly string[];
  /** HTTPS GET broker destinations; never raw shell network authority. */
  readonly publicSourceDomains?: readonly string[];
};

export enum CodexSourcePurpose {
  ProviderApi = "provider-api",
  PublicResearch = "public-research",
}

export enum CodexWebSearchMode {
  Disabled = "disabled",
  Live = "live",
}

// Compatibility is pinned by the v1 profile identity. Changing this set or its
// read-only semantics requires another explicit profile and Host grant.
const publicResearchDomains = Object.freeze([
  "postgresql.org", "www.postgresql.org", "docs.rs", "crates.io",
  "static.crates.io", "pglite.dev", "orm.drizzle.team", "v2.tauri.app",
  "nodejs.org",
]);

export function codexProviderSourcePurpose(policy: CodexProviderEgressPolicy): CodexSourcePurpose {
  return policy.profileId === CodexProviderEgressProfileId.PublicResearchV1
    ? CodexSourcePurpose.PublicResearch : CodexSourcePurpose.ProviderApi;
}

/** Only a captured trusted policy can select native discovery, never an env marker. */
export function codexProviderWebSearchMode(
  policy: CodexProviderEgressPolicy | undefined,
  backend: CodexModelBackend = CodexModelBackend.OpenAiChatGpt,
): CodexWebSearchMode {
  return backend === CodexModelBackend.OpenAiChatGpt &&
    policy?.profileId === CodexProviderEgressProfileId.PublicResearchV1
    ? CodexWebSearchMode.Live : CodexWebSearchMode.Disabled;
}

export function codexProviderEgressPolicy(
  profileId: CodexProviderEgressProfileId,
): CodexProviderEgressPolicy {
  switch (profileId) {
    case CodexProviderEgressProfileId.ProviderApi:
      return Object.freeze({ profileId, domains: Object.freeze(["api.openai.com"]) });
    case CodexProviderEgressProfileId.PublicResearchV1:
      return Object.freeze({
        profileId,
        // Public source access is brokered so HTTPS, GET, DNS, credentials and
        // redirects can be enforced. Domain-only shell proxy rules cannot do it.
        domains: Object.freeze(["api.openai.com"]),
        publicSourceDomains: publicResearchDomains,
      });
    case CodexProviderEgressProfileId.TestNpmQualification:
      return Object.freeze({
        profileId,
        domains: Object.freeze([
          "api.openai.com", "registry.npmjs.org", "tuf-repo-cdn.sigstore.dev",
        ]),
      });
    case CodexProviderEgressProfileId.TestManagedQualification:
      return Object.freeze({
        profileId,
        domains: Object.freeze([
          "api.openai.com", "registry.npmjs.org", "tuf-repo-cdn.sigstore.dev",
          "api.github.com", "raw.githubusercontent.com",
        ]),
      });
    case CodexProviderEgressProfileId.MimoTokenPlan:
      // Host confirmed 2026-09-25 during a manual Stage 0 smoke test with a
      // real Token Plan key. Never merged with the OpenAI domain: MiMo runs
      // are a distinct credential and must not silently gain ChatGPT egress.
      return Object.freeze({ profileId, domains: Object.freeze(["token-plan-sgp.xiaomimimo.com"]) });
    default:
      throw new Error("codex_provider_egress_profile_invalid");
  }
}

export function codexProviderApiEgressPolicy(): CodexProviderEgressPolicy {
  return codexProviderEgressPolicy(CodexProviderEgressProfileId.ProviderApi);
}

export function codexMimoTokenPlanEgressPolicy(): CodexProviderEgressPolicy {
  return codexProviderEgressPolicy(CodexProviderEgressProfileId.MimoTokenPlan);
}

/** A marker transports an already admitted policy; it never authorizes a job. */
export function codexProviderEgressPolicyFromEnv(
  sourceEnv: Readonly<Record<string, string | undefined>> | undefined,
): CodexProviderEgressPolicy | null {
  const profileId = sourceEnv?.[codexProviderEgressProfileEnvVar]?.trim();
  if (profileId === CodexProviderEgressProfileId.ProviderApi ||
      profileId === CodexProviderEgressProfileId.TestNpmQualification ||
      profileId === CodexProviderEgressProfileId.TestManagedQualification ||
      profileId === CodexProviderEgressProfileId.PublicResearchV1 ||
      profileId === CodexProviderEgressProfileId.MimoTokenPlan) {
    return codexProviderEgressPolicy(profileId);
  }
  return null;
}

export function codexProviderEgressEnv(
  policy: CodexProviderEgressPolicy = codexProviderApiEgressPolicy(),
): Record<string, string> {
  return { [codexProviderEgressProfileEnvVar]: policy.profileId };
}

export function codexProviderEgressNetworkAccessFromEnv(
  sourceEnv: Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  return codexProviderEgressPolicyFromEnv(sourceEnv) !== null;
}

export function codexProviderEgressConfigToml(
  policy: CodexProviderEgressPolicy = codexProviderApiEgressPolicy(),
  input?: { readonly namedPermissions?: boolean },
): string {
  return [
    "# Provider egress is selected by trusted host admission.",
    ...(input?.namedPermissions ? [] : ["[sandbox_workspace_write]", "network_access = true", ""]),
    "[features.network_proxy]",
    "enabled = true",
    `domains = { ${tomlDomainRules(policy)} }`,
    "",
  ].join("\n");
}

export function codexProviderEgressCliConfigArgs(
  policy: CodexProviderEgressPolicy = codexProviderApiEgressPolicy(),
  input?: { readonly namedPermissions?: boolean },
): readonly string[] {
  return [
    ...(input?.namedPermissions ? [] : ["--config", "sandbox_workspace_write.network_access=true"]),
    "--config",
    "features.network_proxy.enabled=true",
    "--config",
    `features.network_proxy.domains={ ${tomlDomainRules(policy)} }`,
  ];
}

function tomlDomainRules(policy: CodexProviderEgressPolicy): string {
  // Reconstruct the finite policy rather than trusting a caller's domain array.
  return codexProviderEgressPolicy(policy.profileId).domains
    .map((domain) => `${JSON.stringify(domain)} = "allow"`).join(", ");
}
