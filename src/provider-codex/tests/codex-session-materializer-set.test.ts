import { describe, expect, it } from "vitest";
import { codexJsonHomeConfigToml } from "../codex-session-materializer";

describe("Codex shell environment settings", () => {
  it("includes settings in the policy and deduplicates admitted environment keys", () => {
    const config = codexJsonHomeConfigToml({ namedPermissions: true,
      shellEnvironmentSet: { HOME: "/tool/home", TMPDIR: "/tool/tmp", GIT_CONFIG_GLOBAL: '/tool/git/config"quoted' } });
    const policy = config.split("[shell_environment_policy]\n")[1]!.split("\n\n")[0]!;
    expect(policy).toContain('set = { HOME = "/tool/home", TMPDIR = "/tool/tmp", GIT_CONFIG_GLOBAL = "/tool/git/config\\"quoted" }');
    const include = policy.split("\n").find(line => line.startsWith("include_only"))!;
    expect(include.match(/"HOME"/g)).toHaveLength(1);
    expect(include.match(/"TMPDIR"/g)).toHaveLength(1);
    expect(include).toContain('"GIT_CONFIG_GLOBAL"');
  });
  it("rejects PATH replacement and invalid variable names", () => {
    for (const key of ["PATH", "Path", "path", "bad-key", "BAD-KEY", "9KEY", "KEY\n"]) expect(() =>
      codexJsonHomeConfigToml({ shellEnvironmentSet: { [key]: "value" } })).toThrow("codex_shell_environment_set_key_invalid");
  });
  it("accepts lowercase variable names", () => {
    const config = codexJsonHomeConfigToml({ namedPermissions: true, shellEnvironmentSet: { npm_config_cache: "/tool/home/.npm" } });
    expect(config).toContain('set = { npm_config_cache = "/tool/home/.npm" }');
    expect(config).toContain('"npm_config_cache"');
  });
  it("keeps the existing default shell policy byte-identical when settings are absent", () => {
    const policy = codexJsonHomeConfigToml().split("[shell_environment_policy]\n")[1]!.split("\n\n")[0];
    expect(policy).toBe('inherit = "all"\ninclude_only = ["PATH", "HOME", "CI", "CODEX_HOME", "SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_WRAPPER", "SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_FIND_REAL", "SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_REAL", "SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_GREP_REAL"]');
    expect(codexJsonHomeConfigToml()).not.toContain("set =");
  });
});
