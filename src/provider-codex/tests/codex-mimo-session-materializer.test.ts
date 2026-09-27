import { describe, expect, it } from "vitest";
import { codexJsonHomeConfigToml } from "../codex-session-materializer";
import { CodexModelBackend, codexMimoConfirmedBaseUrl } from "../codex-model-backend";

describe("codexJsonHomeConfigToml MiMo backend", () => {
  it("keeps the default (no modelBackend) output unchanged from the OpenAI/ChatGPT shape", () => {
    const withoutBackend = codexJsonHomeConfigToml();
    const withExplicitChatGpt = codexJsonHomeConfigToml({ modelBackend: CodexModelBackend.OpenAiChatGpt });
    expect(withExplicitChatGpt).toBe(withoutBackend);
    expect(withoutBackend).toContain('model_verbosity = "low"');
    expect(withoutBackend).not.toContain("[model_providers.mimo]");
  });

  it("adds the [model_providers.mimo] block and drops model_verbosity for the MiMo backend", () => {
    const toml = codexJsonHomeConfigToml({
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      mimoApiKeyEnvVarName: "MY_MIMO_ENV_VAR",
    });
    expect(toml).toContain("[model_providers.mimo]");
    expect(toml).toContain(`base_url = ${JSON.stringify(codexMimoConfirmedBaseUrl)}`);
    expect(toml).toContain('env_key = "MY_MIMO_ENV_VAR"');
    expect(toml).not.toContain('model_verbosity = "low"');
    expect(toml).toContain('web_search = "disabled"');
    expect(toml).toContain('"token-plan-sgp.xiaomimimo.com" = "allow"');
    expect(toml).not.toContain('"api.openai.com" = "allow"');
  });

  it("passes only validated job temp variables to hosted native tools", () => {
    const hosted = codexJsonHomeConfigToml({
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      namedPermissions: true,
    });
    const ordinary = codexJsonHomeConfigToml({
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    });
    const hostedShellEnv = hosted.match(/include_only = \[([^\]]*)\]/)?.[1] ?? "";
    const ordinaryShellEnv = ordinary.match(/include_only = \[([^\]]*)\]/)?.[1] ?? "";
    for (const name of ["TMPDIR", "TMP", "TEMP"]) {
      expect(hostedShellEnv).toContain(`"${name}"`);
      expect(ordinaryShellEnv).not.toContain(`"${name}"`);
    }
    expect(hostedShellEnv).not.toContain("MIMO_TOKEN_PLAN_API_KEY");
  });
});
