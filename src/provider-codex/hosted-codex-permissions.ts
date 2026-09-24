import type { CodexSandboxMode } from "./codex-json-execution-engine";
import type { CodexProviderEgressPolicy } from "./codex-provider-egress-policy";

export enum HostedCodexPermissionProfileId {
  ReadOnly = "hosted-project-read",
  WorkspaceWrite = "hosted-project-write",
}

export function hostedCodexPermissionProfileId(input: {
  readonly sandboxMode?: CodexSandboxMode;
}): HostedCodexPermissionProfileId {
  switch (input.sandboxMode ?? "read-only") {
    case "read-only": return HostedCodexPermissionProfileId.ReadOnly;
    case "workspace-write": return HostedCodexPermissionProfileId.WorkspaceWrite;
    default: throw new Error("hosted_permission_profile_sandbox_mode_unsupported");
  }
}

export function hostedCodexPermissionProfilesToml(policy: CodexProviderEgressPolicy): string {
  const domains = policy.domains.map(domain => `${JSON.stringify(domain)} = "allow"`).join(", ");
  return [
    "# Bound native Codex tools to the admitted workspace and minimal system files.",
    `[permissions.${HostedCodexPermissionProfileId.ReadOnly}.filesystem]`,
    '":root" = "deny"',
    '":minimal" = "read"',
    "",
    `[permissions.${HostedCodexPermissionProfileId.ReadOnly}.filesystem.\":workspace_roots\"]`,
    '"." = "read"',
    "",
    `[permissions.${HostedCodexPermissionProfileId.ReadOnly}.network]`,
    "enabled = true",
    `domains = { ${domains} }`,
    "",
    `[permissions.${HostedCodexPermissionProfileId.WorkspaceWrite}.filesystem]`,
    '":root" = "deny"',
    '":minimal" = "read"',
    "",
    `[permissions.${HostedCodexPermissionProfileId.WorkspaceWrite}.filesystem.\":workspace_roots\"]`,
    '"." = "write"',
    '".git" = "read"',
    '".codex" = "read"',
    "",
    `[permissions.${HostedCodexPermissionProfileId.WorkspaceWrite}.network]`,
    "enabled = true",
    `domains = { ${domains} }`,
    "",
  ].join("\n");
}
