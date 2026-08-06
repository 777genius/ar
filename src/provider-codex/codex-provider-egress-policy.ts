export const codexProviderEgressProfileEnvVar =
  "SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE";

export const codexProviderApiEgressProfileId = "codex-provider-api" as const;

export const codexProviderApiAndNpmRegistryEgressProfileId =
  "codex-provider-api-and-npm-registry" as const;

export type CodexProviderEgressProfileId =
  | typeof codexProviderApiEgressProfileId
  | typeof codexProviderApiAndNpmRegistryEgressProfileId;

export type CodexProviderEgressPolicy = {
  readonly profileId: CodexProviderEgressProfileId;
  readonly domains: readonly (
    | "api.openai.com"
    | "registry.npmjs.org"
  )[];
};

const codexProviderApiDomains = ["api.openai.com"] as const;
const codexProviderApiAndNpmRegistryDomains = [
  "api.openai.com",
  "registry.npmjs.org",
] as const;

const codexProviderEgressPolicies = {
  [codexProviderApiEgressProfileId]: {
    profileId: codexProviderApiEgressProfileId,
    domains: codexProviderApiDomains,
  },
  [codexProviderApiAndNpmRegistryEgressProfileId]: {
    profileId: codexProviderApiAndNpmRegistryEgressProfileId,
    domains: codexProviderApiAndNpmRegistryDomains,
  },
} as const satisfies Record<CodexProviderEgressProfileId, CodexProviderEgressPolicy>;

export function codexProviderApiEgressPolicy(): CodexProviderEgressPolicy {
  return codexProviderEgressPolicy(codexProviderApiEgressProfileId);
}

export function codexProviderApiAndNpmRegistryEgressPolicy(): CodexProviderEgressPolicy {
  return codexProviderEgressPolicy(
    codexProviderApiAndNpmRegistryEgressProfileId,
  );
}

export function codexProviderEgressPolicy(
  profileId: CodexProviderEgressProfileId = codexProviderApiEgressProfileId,
): CodexProviderEgressPolicy {
  return codexProviderEgressPolicies[profileId];
}

export function codexProviderEgressPolicyFromEnv(
  sourceEnv: Readonly<Record<string, string | undefined>> | undefined,
): CodexProviderEgressPolicy | null {
  const profileId = sourceEnv?.[codexProviderEgressProfileEnvVar]?.trim();
  if (!profileId) return null;
  return isCodexProviderEgressProfileId(profileId)
    ? codexProviderEgressPolicy(profileId)
    : null;
}

export function codexProviderEgressEnv(
  profileId: CodexProviderEgressProfileId = codexProviderApiEgressProfileId,
): Record<string, string> {
  return { [codexProviderEgressProfileEnvVar]: profileId };
}

export function codexProviderEgressNetworkAccessFromEnv(
  sourceEnv: Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  return codexProviderEgressPolicyFromEnv(sourceEnv) !== null;
}

export function codexProviderEgressConfigToml(
  profileId: CodexProviderEgressProfileId = codexProviderApiEgressProfileId,
): string {
  const policy = codexProviderEgressPolicy(profileId);
  return [
    "# Provider egress stays constrained to the selected trusted runtime profile.",
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
  profileId: CodexProviderEgressProfileId = codexProviderApiEgressProfileId,
): readonly string[] {
  const policy = codexProviderEgressPolicy(profileId);
  return [
    "--config",
    "sandbox_workspace_write.network_access=true",
    "--config",
    "features.network_proxy.enabled=true",
    "--config",
    `features.network_proxy.domains={ ${tomlDomainRules(policy)} }`,
  ];
}

function isCodexProviderEgressProfileId(
  value: string,
): value is CodexProviderEgressProfileId {
  return value === codexProviderApiEgressProfileId ||
    value === codexProviderApiAndNpmRegistryEgressProfileId;
}

function tomlDomainRules(policy: CodexProviderEgressPolicy): string {
  return policy.domains.map((domain) => `${tomlString(domain)} = "allow"`).join(", ");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
