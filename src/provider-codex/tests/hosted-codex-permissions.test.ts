import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codexJsonHomeConfigToml } from "../codex-session-materializer";
import { codexProviderApiEgressPolicy, codexProviderEgressPolicy,
  CodexProviderEgressProfileId } from "../codex-provider-egress-policy";
import { hostedCodexExecutableReadPath, hostedCodexPermissionProfilesToml,
  hostedCredentialDenyDirectories } from "../hosted-codex-permissions";

/** Drops the environment-dependent Node executable read rule so the golden text is stable on CI and macOS. */
function withoutExecutableRule(toml: string): string {
  const executable = JSON.stringify(realpathSync(process.execPath));
  return toml.split("\n").filter(line => !line.startsWith(`${executable} = `)).join("\n");
}

const goldenDenyLines = ['":root" = "deny"', '":minimal" = "read"',
  '"/var/lib/subscription-runtime-full-parent-live" = "deny"', '"/run/TEST-full-flow-outbox" = "deny"',
  '"/etc/subscription-runtime" = "deny"', '"/etc/ssh" = "deny"', '"/etc/ssl/private" = "deny"'];

function goldenProfiles(networkLines: readonly string[]): string {
  return [
    "# Bound native Codex tools to the admitted workspace and minimal system files.",
    "[permissions.hosted-project-read.filesystem]", ...goldenDenyLines, "",
    '[permissions.hosted-project-read.filesystem.":workspace_roots"]', '"." = "read"', "",
    "[permissions.hosted-project-read.network]", "enabled = true", ...networkLines, "",
    "[permissions.hosted-project-write.filesystem]", ...goldenDenyLines, "",
    '[permissions.hosted-project-write.filesystem.":workspace_roots"]', '"." = "write"', '".git" = "read"',
    '".codex" = "read"', "",
    "[permissions.hosted-project-write.network]", "enabled = true", ...networkLines, "",
  ].join("\n");
}

describe("hosted Codex permission profiles", () => {
  it("removes the legacy sandbox override and limits both profiles to workspace roots", () => {
    const config = codexJsonHomeConfigToml({
      providerEgressPolicy: codexProviderApiEgressPolicy(),
      namedPermissions: true,
    }) + hostedCodexPermissionProfilesToml(codexProviderApiEgressPolicy());
    expect(config).not.toContain('sandbox_mode = "read-only"');
    expect(config).not.toContain("[sandbox_workspace_write]");
    expect(config).toContain('default_permissions = "hosted-project-read"');
    expect(config).toContain('[permissions.hosted-project-read.filesystem]');
    expect(config).toContain('[permissions.hosted-project-write.filesystem]');
    expect(config.match(/":root" = "deny"/g)).toHaveLength(2);
    expect(config).toContain('[permissions.hosted-project-read.filesystem.":workspace_roots"]\n"." = "read"');
    expect(config).toContain('[permissions.hosted-project-write.filesystem.":workspace_roots"]\n"." = "write"');
    expect(config).toContain('".git" = "read"');
    expect(config).toContain('".codex" = "read"');
    for (const dir of hostedCredentialDenyDirectories) {
      expect(config.split(`"${dir}" = "deny"`)).toHaveLength(3);
    }
    expect(config).not.toContain('"/etc/subscription-runtime/secrets"');
    expect(config).not.toContain('extends = ":workspace"');
    expect(config).not.toContain('"*" = "allow"');
  });

  it("refuses to turn a shallow Node install into broad filesystem access", () => {
    expect(hostedCodexExecutableReadPath({ codexBinaryPath: "/bin/node", sourceEnv: {} }))
      .toBeUndefined();
    const config = hostedCodexPermissionProfilesToml(codexProviderApiEgressPolicy());
    expect(config).not.toContain('"/" = "read"');
    expect(config).not.toContain('"/srv" = "read"');
    const scoped = hostedCodexPermissionProfilesToml(
      codexProviderApiEgressPolicy(), "/opt/codex/lib/node_modules/@openai/codex");
    expect(scoped).toContain('"/opt/codex/lib/node_modules/@openai/codex" = "read"');
    expect(scoped).not.toContain('"/opt" = "read"');
  });

  it("denies the secret tree without serializing the canonical MiMo key locator", () => {
    const config = hostedCodexPermissionProfilesToml(codexProviderApiEgressPolicy());
    expect(config.split('"/etc/subscription-runtime" = "deny"')).toHaveLength(3);
    expect(config).not.toContain("mimo-token-plan-api-key");
  });

  it("does not grant recursive reads when an executable path names a directory", () => {
    expect(hostedCodexExecutableReadPath({
      codexBinaryPath: "/usr/local/bin",
      sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
    })).toBeUndefined();
  });

  it("renders the exact profile text for the provider API and full internet egress", () => {
    expect(withoutExecutableRule(hostedCodexPermissionProfilesToml(codexProviderApiEgressPolicy())))
      .toBe(goldenProfiles(['domains = { "api.openai.com" = "allow" }']));
    expect(withoutExecutableRule(hostedCodexPermissionProfilesToml(
      codexProviderEgressPolicy(CodexProviderEgressProfileId.FullInternetV1)))).toBe(goldenProfiles([]));
  });

  it("keeps credential deny entries flat and adds at most one outside key file mask", () => {
    for (const dir of hostedCredentialDenyDirectories) {
      expect(resolve(dir)).toBe(dir);
      expect(dir.endsWith("/")).toBe(false);
      for (const other of hostedCredentialDenyDirectories) {
        if (other !== dir) expect(`${other}/`.startsWith(`${dir}/`)).toBe(false);
      }
    }
    const baseline = hostedCodexPermissionProfilesToml(codexProviderApiEgressPolicy());
    for (const inside of ["/etc/subscription-runtime/backup/k", "/etc/ssl/private/k", "/etc/ssh/k"]) {
      expect(hostedCodexPermissionProfilesToml(codexProviderApiEgressPolicy(), undefined, inside))
        .toBe(baseline);
    }
    const outside = hostedCodexPermissionProfilesToml(codexProviderApiEgressPolicy(), undefined,
      "/srv/k");
    expect(outside.split('"/srv/k" = "deny"')).toHaveLength(3);
  });
});

it("gives both managed-public permission profiles exact ProxyOnly settings without broadening filesystem custody", () => {
  const policy = codexProviderEgressPolicy(CodexProviderEgressProfileId.ManagedPublicInternetV1);
  const network = ['domains = { "*" = "allow" }', 'mode = "full"', 'allow_local_binding = false',
    'allow_upstream_proxy = false', 'enable_socks5 = false', 'enable_socks5_udp = false',
    'dangerously_allow_non_loopback_proxy = false', 'dangerously_allow_all_unix_sockets = false'];
  const rendered = withoutExecutableRule(hostedCodexPermissionProfilesToml(policy));
  expect(rendered).toBe(goldenProfiles(network));
  expect(rendered).not.toContain('credential_broker');
  expect(rendered).not.toContain('proxy_url');
  expect(rendered.match(/":root" = "deny"/g)).toHaveLength(2);
  expect(rendered).toContain('".git" = "read"'); expect(rendered).toContain('".codex" = "read"');
  expect(hostedCodexPermissionProfilesToml({ ...policy, domains: ["127.0.0.1"] })).toBe(hostedCodexPermissionProfilesToml(policy));
});
