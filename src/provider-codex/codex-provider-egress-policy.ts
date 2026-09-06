export const codexProviderEgressProfileEnvVar =
  "SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE";

export enum CodexProviderEgressProfileId {
  ProviderApi = "codex-provider-api",
  TestNpmQualification = "codex-test-npm-qualification",
  TestManagedQualification = "codex-test-managed-qualification",
}
export const codexProviderApiEgressProfileId = CodexProviderEgressProfileId.ProviderApi;

export type CodexProviderEgressPolicy = {
  readonly profileId: CodexProviderEgressProfileId;
  readonly domains: readonly string[];
};

export function codexProviderEgressPolicy(
  profileId: CodexProviderEgressProfileId,
): CodexProviderEgressPolicy {
  switch (profileId) {
    case CodexProviderEgressProfileId.ProviderApi:
      return Object.freeze({ profileId, domains: Object.freeze(["api.openai.com"]) });
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
    default:
      throw new Error("codex_provider_egress_profile_invalid");
  }
}

export function codexProviderApiEgressPolicy(): CodexProviderEgressPolicy {
  return codexProviderEgressPolicy(CodexProviderEgressProfileId.ProviderApi);
}

/** A marker transports an already admitted policy; it never authorizes a job. */
export function codexProviderEgressPolicyFromEnv(
  sourceEnv: Readonly<Record<string, string | undefined>> | undefined,
): CodexProviderEgressPolicy | null {
  const profileId = sourceEnv?.[codexProviderEgressProfileEnvVar]?.trim();
  if (profileId === CodexProviderEgressProfileId.ProviderApi ||
      profileId === CodexProviderEgressProfileId.TestNpmQualification ||
      profileId === CodexProviderEgressProfileId.TestManagedQualification) {
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
): string {
  return [
    "# Provider egress is selected by trusted host admission.",
    "[sandbox_workspace_write]",
    "network_access = true",
    "",
    "[features.network_proxy]",
    "enabled = true",
    `domains = { ${tomlDomainRules(policy)} }`,
    "",
  ].join("\n");
}

export function codexProviderEgressCliConfigArgs(
  policy: CodexProviderEgressPolicy = codexProviderApiEgressPolicy(),
): readonly string[] {
  return [
    "--config",
    "sandbox_workspace_write.network_access=true",
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
