import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RunEventProviderKind,
  projectScopedControllerToolNames,
  type ControlledAgentProviderEnforcementCapabilities,
} from "@vioxen/subscription-runtime/worker-core";
import {
  CodexModelBackend,
  codexMimoApiKeyEnvVarDefault,
  codexMimoTokenPlanEgressPolicy,
  codexProviderApiEgressPolicy,
  codexModelBackendExcludesConfigKey,
  codexModelBackendModelProvidersConfigToml,
  codexProviderEgressConfigToml,
  codexProviderEgressEnv,
  CodexProviderEgressProfileId,
  codexJsonHomeConfigToml,
  hostedCodexPermissionProfilesToml,
  type CodexProviderEgressPolicy,
} from "@vioxen/subscription-runtime/provider-codex";

export type CodexControlledAgentProfileInput = {
  readonly stateDir: string;
  /** Reserved hosted profile: excludes the project-control MCP subprocess. */
  readonly hostedController?: boolean;
  readonly mcpServerName?: string;
  readonly mcpCommand?: string;
  readonly mcpArgs?: readonly string[];
  readonly mcpCwd?: string;
  readonly rawShellMode?: "disabled-by-provider" | "sandboxed-deny-rules-only";
  /** Defaults to {@link CodexModelBackend.OpenAiChatGpt} — omitting it keeps today's generated config.toml byte-identical. */
  readonly modelBackend?: CodexModelBackend;
  /** Env var holding the MiMo Token Plan key. Only used when `modelBackend` is `XiaomiMimoTokenPlan`. */
  readonly mimoApiKeyEnvVarName?: string;
};

export type CodexControlledAgentProfile = {
  readonly hostedController?: boolean;
  readonly providerEgressPolicy?: CodexProviderEgressPolicy;
  readonly modelBackend: CodexModelBackend;
  readonly mimoApiKeyEnvVarName: string;
  readonly providerKind: RunEventProviderKind.Codex;
  readonly codexHome: string;
  readonly configToml: string;
  readonly rulesText: string;
  readonly enabledTools: readonly string[];
  readonly appServerNativeToolSurface: "disabled" | "default";
  readonly enforcement: ControlledAgentProviderEnforcementCapabilities;
};

export function buildCodexControlledAgentProfile(
  input: CodexControlledAgentProfileInput,
): CodexControlledAgentProfile {
  const mcpServerName = input.mcpServerName ?? "subscription_runtime_project_control";
  const enabledTools = input.hostedController ? [] : projectScopedControllerToolNames();
  const mcpCommand = input.mcpCommand ?? "subscription-runtime-codex-goal-mcp";
  const mcpArgs = input.mcpArgs ?? [];
  const codexHome = join(input.stateDir, "codex-home");
  const rawShellMode = input.rawShellMode ?? "disabled-by-provider";
  const modelBackend = input.modelBackend ?? CodexModelBackend.OpenAiChatGpt;
  if (input.hostedController && (modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan || rawShellMode !== "disabled-by-provider")) {
    throw new Error("hosted_controller_profile_invalid");
  }
  const mimoApiKeyEnvVarName =
    input.mimoApiKeyEnvVarName ?? codexMimoApiKeyEnvVarDefault;
  const providerEgressPolicy = modelBackend === CodexModelBackend.XiaomiMimoTokenPlan
    ? codexMimoTokenPlanEgressPolicy()
    : undefined;
  return {
    ...(input.hostedController ? { hostedController: true } : {}),
    providerKind: RunEventProviderKind.Codex,
    modelBackend,
    mimoApiKeyEnvVarName,
    ...(providerEgressPolicy === undefined
      ? {}
      : { providerEgressPolicy }),
    codexHome,
    enabledTools,
    appServerNativeToolSurface: rawShellMode === "disabled-by-provider"
      ? "disabled"
      : "default",
    configToml: codexConfigToml({
      mcpServerName,
      mcpCommand,
      mcpArgs,
      enabledTools,
      hostedController: input.hostedController === true,
      modelBackend,
      mimoApiKeyEnvVarName,
      ...(providerEgressPolicy === undefined
        ? {}
        : { providerEgressPolicy }),
      ...(input.mcpCwd === undefined ? {} : { mcpCwd: input.mcpCwd }),
    }),
    rulesText: codexControllerRulesText(),
    enforcement: {
      providerKind: RunEventProviderKind.Codex,
      canRestrictToolSurface: true,
      canDisableRawShell: rawShellMode === "disabled-by-provider",
      canEnforceFilesystemSandbox: true,
      canIsolateHome: true,
      canIsolateTemp: true,
      canRestrictNetwork: true,
    },
  };
}

/** Closed-phase hosted controller profile. PR2 supplies its brokered dynamic
 * tools; there is deliberately no project-control MCP subprocess here. */
export function buildHostedMimoControlledAgentProfile(stateDir: string): CodexControlledAgentProfile {
  const policy = codexMimoTokenPlanEgressPolicy();
  const hookPath = fileURLToPath(new URL("../hosted-global-scan-pre-tool-hook.js", import.meta.url));
  const command = `${shellQuote(process.execPath)} ${shellQuote(hookPath)}`;
  return {
    providerKind: RunEventProviderKind.Codex,
    modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    mimoApiKeyEnvVarName: codexMimoApiKeyEnvVarDefault,
    providerEgressPolicy: policy,
    codexHome: join(stateDir, "codex-home"),
    enabledTools: [],
    appServerNativeToolSurface: "disabled",
    configToml: [
      codexJsonHomeConfigToml({ modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        mimoApiKeyEnvVarName: codexMimoApiKeyEnvVarDefault,
        providerEgressPolicy: policy, namedPermissions: true, hooksEnabled: true }),
      hostedCodexPermissionProfilesToml(policy),
      "[hooks]", "[[hooks.PreToolUse]]", 'matcher = "Bash|exec"',
      "[[hooks.PreToolUse.hooks]]", 'type = "command"',
      `command = ${JSON.stringify(command)}`, "timeout = 5", "",
    ].join("\n"),
    rulesText: codexControllerRulesText(),
    enforcement: {
      providerKind: RunEventProviderKind.Codex,
      canRestrictToolSurface: true,
      canDisableRawShell: true,
      canEnforceFilesystemSandbox: true,
      canIsolateHome: true,
      canIsolateTemp: true,
      canRestrictNetwork: true,
    },
  };
}

export function assertHostedMimoControlledAgentProfile(profile: CodexControlledAgentProfile): void {
  const expected = buildHostedMimoControlledAgentProfile(dirname(profile.codexHome));
  if (profile.modelBackend !== expected.modelBackend ||
      profile.mimoApiKeyEnvVarName !== expected.mimoApiKeyEnvVarName ||
      profile.providerEgressPolicy?.profileId !== expected.providerEgressPolicy?.profileId ||
      profile.appServerNativeToolSurface !== "disabled" || profile.enabledTools.length !== 0 ||
      profile.configToml !== expected.configToml) {
    throw new Error("hosted_mimo_effective_confinement_required");
  }
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

function codexConfigToml(input: {
  readonly hostedController: boolean;
  readonly mcpServerName: string;
  readonly mcpCommand: string;
  readonly mcpArgs: readonly string[];
  readonly mcpCwd?: string;
  readonly enabledTools: readonly string[];
  readonly modelBackend: CodexModelBackend;
  readonly mimoApiKeyEnvVarName?: string;
  readonly providerEgressPolicy?: CodexProviderEgressPolicy;
}): string {
  const lines = [
    "# Generated by subscription-runtime controlled-agent. Do not add raw host tools.",
    'cli_auth_credentials_store = "file"',
    'sandbox_mode = "read-only"',
    'approval_policy = "never"',
    'web_search = "disabled"',
    "disable_response_storage = true",
    ...(codexModelBackendExcludesConfigKey(input.modelBackend, "model_verbosity")
      ? []
      : ['model_verbosity = "low"']),
    "",
    "[features]",
    "apps = false",
    "hooks = false",
    "memories = false",
    "multi_agent = false",
    "shell_snapshot = false",
    "skill_mcp_dependency_install = false",
    "",
    "[history]",
    'persistence = "none"',
    "",
    "[otel]",
    'exporter = "none"',
    'metrics_exporter = "none"',
    'trace_exporter = "none"',
    "log_user_prompt = false",
    "",
    ...(input.hostedController ? [] : [
      `[mcp_servers.${quoteTomlKey(input.mcpServerName)}]`,
      `command = ${tomlString(input.mcpCommand)}`,
      `args = ${tomlStringArray(input.mcpArgs)}`,
      `enabled_tools = ${tomlStringArray(input.enabledTools)}`,
      'default_tools_approval_mode = "approve"',
      ...(input.mcpCwd ? [`cwd = ${tomlString(input.mcpCwd)}`] : []),
      "",
    ]),
    "[shell_environment_policy]",
    'inherit = "none"',
    'include_only = ["PATH", "HOME", "CI", "CODEX_HOME"]',
    "",
    "[permissions.controlled_project_controller.filesystem]",
    '":minimal" = "read"',
    "",
    "[permissions.controlled_project_controller.network]",
    "enabled = false",
    "",
    ...(input.modelBackend === CodexModelBackend.OpenAiChatGpt ? [] : [
      codexModelBackendModelProvidersConfigToml({
        backend: input.modelBackend,
        envKeyName: input.mimoApiKeyEnvVarName ?? codexMimoApiKeyEnvVarDefault,
      }),
    ]),
    codexProviderEgressConfigToml(input.providerEgressPolicy),
  ];
  return `${lines.join("\n")}\n`;
}

function codexControllerRulesText(): string {
  return [
    "# Generated by subscription-runtime controlled-agent.",
    "# These rules are a defense-in-depth layer. Provider tool-surface enforcement is still required.",
    forbiddenRule(["git"], "Use project integration broker tools instead of raw git."),
    forbiddenRule(["tmux"], "Use project-control broker tools instead of raw tmux."),
    forbiddenRule(["ssh"], "Remote access is outside project-scoped control."),
    forbiddenRule(["scp"], "Remote file copy is outside project-scoped control."),
    forbiddenRule(["rsync"], "Remote file sync is outside project-scoped control."),
    forbiddenRule(["docker"], "Docker/socket access is outside project-scoped control."),
    forbiddenRule(["docker-compose"], "Docker/socket access is outside project-scoped control."),
    forbiddenRule(["podman"], "Container socket access is outside project-scoped control."),
    forbiddenRule(["sudo"], "Privilege escalation is outside project-scoped control."),
    forbiddenRule(["su"], "Privilege escalation is outside project-scoped control."),
    forbiddenRule(["bash", "-lc"], "Raw shell scripts are outside broker-only controller scope."),
    forbiddenRule(["bash", "-c"], "Raw shell scripts are outside broker-only controller scope."),
    forbiddenRule(["zsh", "-lc"], "Raw shell scripts are outside broker-only controller scope."),
    forbiddenRule(["zsh", "-c"], "Raw shell scripts are outside broker-only controller scope."),
    forbiddenRule(["sh", "-lc"], "Raw shell scripts are outside broker-only controller scope."),
    forbiddenRule(["sh", "-c"], "Raw shell scripts are outside broker-only controller scope."),
    "",
  ].join("\n");
}

function forbiddenRule(pattern: readonly string[], justification: string): string {
  return [
    "prefix_rule(",
    `    pattern = ${starlarkStringArray(pattern)},`,
    '    decision = "forbidden",',
    `    justification = ${tomlString(justification)},`,
    ")",
  ].join("\n");
}

function quoteTomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function starlarkStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

export const codexControlledAgentProviderEgressEnv = codexProviderEgressEnv;

/** Only the adapter applies an authenticated policy to a generated profile. */
export function withControlledAgentEgress(
  profile: CodexControlledAgentProfile, policy: CodexProviderEgressPolicy,
): CodexControlledAgentProfile {
  const effectivePolicy =
    profile.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan
      ? policy.profileId === CodexProviderEgressProfileId.MimoTokenPlan
        ? policy
        : codexMimoTokenPlanEgressPolicy()
      : policy;
  const original = codexProviderEgressConfigToml(
    profile.providerEgressPolicy ?? codexProviderApiEgressPolicy(),
  );
  if (!profile.configToml.endsWith(original + "\n")) {
    throw new Error("controlled_agent_generated_egress_config_required");
  }
  return { ...profile, providerEgressPolicy: effectivePolicy,
    configToml: profile.configToml.slice(0, -original.length - 1) + codexProviderEgressConfigToml(effectivePolicy) + "\n" };
}

export function withControlledAgentModelBackend(
  profile: CodexControlledAgentProfile,
  modelBackend: CodexModelBackend,
  mimoApiKeyEnvVarName = codexMimoApiKeyEnvVarDefault,
): CodexControlledAgentProfile {
  if (
    profile.modelBackend === modelBackend &&
    profile.mimoApiKeyEnvVarName === mimoApiKeyEnvVarName
  ) {
    return profile;
  }
  const sourceEgressPolicy =
    profile.providerEgressPolicy ?? codexProviderApiEgressPolicy();
  const sourceEgressConfig = codexProviderEgressConfigToml(sourceEgressPolicy);
  if (!profile.configToml.endsWith(`${sourceEgressConfig}\n`)) {
    throw new Error("controlled_agent_generated_egress_config_required");
  }
  let configToml = profile.configToml.slice(
    0,
    -(sourceEgressConfig.length + 1),
  );
  if (profile.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan) {
    const sourceProviderConfig = codexModelBackendModelProvidersConfigToml({
      backend: profile.modelBackend,
      envKeyName: profile.mimoApiKeyEnvVarName,
    });
    if (!configToml.includes(sourceProviderConfig)) {
      throw new Error("controlled_agent_generated_model_provider_config_required");
    }
    configToml = configToml.replace(sourceProviderConfig, "");
  }
  if (modelBackend === CodexModelBackend.XiaomiMimoTokenPlan) {
    configToml = configToml.replace(/model_verbosity = "low"\n/g, "");
    configToml += `${configToml.endsWith("\n") ? "" : "\n"}${
      codexModelBackendModelProvidersConfigToml({
        backend: modelBackend,
        envKeyName: mimoApiKeyEnvVarName,
      })
    }`;
  }
  const providerEgressPolicy =
    modelBackend === CodexModelBackend.XiaomiMimoTokenPlan
      ? codexMimoTokenPlanEgressPolicy()
      : codexProviderApiEgressPolicy();
  return {
    ...profile,
    modelBackend,
    mimoApiKeyEnvVarName,
    providerEgressPolicy,
    configToml: `${configToml}${codexProviderEgressConfigToml(providerEgressPolicy)}\n`,
  };
}
