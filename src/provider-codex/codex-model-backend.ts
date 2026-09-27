/**
 * A Codex-compatible model backend selects which upstream endpoint the Codex
 * CLI talks to. `OpenAiChatGpt` is the existing, unchanged production path.
 * `XiaomiMimoTokenPlan` reuses the same Codex CLI execution engine against
 * Xiaomi's MiMo Token Plan subscription endpoint instead of standing up a
 * separate provider module. See docs/goal-provider-parity-rfc.md and
 * AGENTS.md's "strict enum, never a string fallback" rule.
 */
export enum CodexModelBackend {
  OpenAiChatGpt = "openai-chatgpt",
  XiaomiMimoTokenPlan = "xiaomi-mimo-token-plan",
}

export const codexMimoModelProviderId = "mimo";

export const codexMimoDefaultModel = "mimo-v2.6-pro";

/**
 * Confirmed during the 2026-09-25 manual Stage 0 smoke test (real Codex CLI,
 * real Token Plan key): this endpoint accepts `wire_api = "responses"`,
 * shell/apply_patch tool calls and a full agent turn. Xiaomi may publish
 * other regional hosts; callers may override it.
 */
export const codexMimoConfirmedBaseUrl = "https://token-plan-sgp.xiaomimimo.com/v1";

export const codexMimoApiKeyEnvVarDefault = "MIMO_TOKEN_PLAN_API_KEY";

/**
 * Builds the `[model_providers.mimo]` config.toml fragment for the MiMo
 * backend, or an empty string for the OpenAI/ChatGPT backend (no config
 * change from today's behavior).
 *
 * `web_search = "disabled"` is required for this backend: the Stage 0 smoke
 * test confirmed MiMo's gateway rejects Codex's default web_search tool with
 * `responses_feature_not_supported`.
 */
export function codexModelBackendModelProvidersConfigToml(input: {
  readonly backend: CodexModelBackend;
  readonly baseUrl?: string;
  readonly envKeyName: string;
}): string {
  if (input.backend === CodexModelBackend.OpenAiChatGpt) {
    return "";
  }
  return [
    `[model_providers.${codexMimoModelProviderId}]`,
    'name = "MiMo Token Plan"',
    `base_url = ${JSON.stringify(input.baseUrl ?? codexMimoConfirmedBaseUrl)}`,
    'wire_api = "responses"',
    `env_key = ${JSON.stringify(input.envKeyName)}`,
    "",
  ].join("\n");
}

export function codexModelBackendDefaultModel(backend: CodexModelBackend, fallback: string): string {
  return backend === CodexModelBackend.XiaomiMimoTokenPlan ? codexMimoDefaultModel : fallback;
}

/** `-c model_provider=<id>` override, or `undefined` to leave Codex's default (ChatGPT) untouched. */
export function codexModelBackendModelProviderName(backend: CodexModelBackend): string | undefined {
  return backend === CodexModelBackend.XiaomiMimoTokenPlan ? codexMimoModelProviderId : undefined;
}

/** Config keys known to be OpenAI-specific that must not be sent to the MiMo backend. */
export function codexModelBackendExcludesConfigKey(backend: CodexModelBackend, key: string): boolean {
  if (backend !== CodexModelBackend.XiaomiMimoTokenPlan) return false;
  return key === "model_verbosity" || key === "service_tier" || key === "fast_mode";
}
