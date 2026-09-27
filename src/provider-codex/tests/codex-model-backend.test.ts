import { describe, expect, it } from "vitest";
import {
  CodexModelBackend,
  codexMimoConfirmedBaseUrl,
  codexMimoDefaultModel,
  codexMimoModelProviderId,
  codexModelBackendDefaultModel,
  codexModelBackendExcludesConfigKey,
  codexModelBackendModelProvidersConfigToml,
  codexModelBackendModelProviderName,
} from "../codex-model-backend";

describe("CodexModelBackend", () => {
  it("adds nothing to config.toml for the default OpenAI/ChatGPT backend", () => {
    expect(
      codexModelBackendModelProvidersConfigToml({
        backend: CodexModelBackend.OpenAiChatGpt,
        envKeyName: "UNUSED",
      }),
    ).toBe("");
    expect(codexModelBackendModelProviderName(CodexModelBackend.OpenAiChatGpt)).toBeUndefined();
    expect(codexModelBackendDefaultModel(CodexModelBackend.OpenAiChatGpt, "gpt-5.5")).toBe("gpt-5.5");
    for (const key of ["model_verbosity", "service_tier", "fast_mode", "anything_else"]) {
      expect(codexModelBackendExcludesConfigKey(CodexModelBackend.OpenAiChatGpt, key)).toBe(false);
    }
  });

  it("builds the [model_providers.mimo] block with the Stage 0 confirmed defaults", () => {
    const toml = codexModelBackendModelProvidersConfigToml({
      backend: CodexModelBackend.XiaomiMimoTokenPlan,
      envKeyName: "MY_MIMO_ENV_VAR",
    });
    expect(toml).toContain(`[model_providers.${codexMimoModelProviderId}]`);
    expect(toml).toContain(`base_url = ${JSON.stringify(codexMimoConfirmedBaseUrl)}`);
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('env_key = "MY_MIMO_ENV_VAR"');
  });

  it("honors an explicit base_url override for other Xiaomi regions", () => {
    const toml = codexModelBackendModelProvidersConfigToml({
      backend: CodexModelBackend.XiaomiMimoTokenPlan,
      envKeyName: "MY_MIMO_ENV_VAR",
      baseUrl: "https://token-plan-example.xiaomimimo.com/v1",
    });
    expect(toml).toContain('base_url = "https://token-plan-example.xiaomimimo.com/v1"');
    expect(toml).not.toContain(codexMimoConfirmedBaseUrl);
  });

  it("picks the MiMo model and model_provider name for the MiMo backend", () => {
    expect(codexModelBackendDefaultModel(CodexModelBackend.XiaomiMimoTokenPlan, "gpt-5.5")).toBe(
      codexMimoDefaultModel,
    );
    expect(codexModelBackendModelProviderName(CodexModelBackend.XiaomiMimoTokenPlan)).toBe(
      codexMimoModelProviderId,
    );
  });

  it("excludes only the OpenAI-specific config keys on the MiMo backend", () => {
    for (const key of ["model_verbosity", "service_tier", "fast_mode"]) {
      expect(codexModelBackendExcludesConfigKey(CodexModelBackend.XiaomiMimoTokenPlan, key)).toBe(true);
    }
    expect(
      codexModelBackendExcludesConfigKey(CodexModelBackend.XiaomiMimoTokenPlan, "disable_response_storage"),
    ).toBe(false);
  });
});
