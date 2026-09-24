import { describe, expect, it } from "vitest";
import { codexJsonHomeConfigToml } from "../codex-session-materializer";
import { codexProviderApiEgressPolicy } from "../codex-provider-egress-policy";
import { hostedCodexExecutableReadPath, hostedCodexPermissionProfilesToml } from "../hosted-codex-permissions";

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
    expect(config).not.toContain('extends = ":workspace"');
    expect(config).not.toContain('"*" = "allow"');
  });

  it("refuses to turn a shallow Node install into broad filesystem access", () => {
    expect(hostedCodexExecutableReadPath({ codexBinaryPath: "/bin/node", sourceEnv: {} }))
      .toBeUndefined();
    const config = hostedCodexPermissionProfilesToml(codexProviderApiEgressPolicy());
    expect(config).not.toContain('"/" = "read"');
    expect(config).not.toContain('"/srv" = "read"');
  });
});
