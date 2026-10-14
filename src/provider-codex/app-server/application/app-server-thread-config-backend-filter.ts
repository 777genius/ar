import {
  CodexModelBackend,
  codexModelBackendExcludesConfigKey,
} from "../../codex-model-backend";

/**
 * Defense in depth for {@link CodexAppServerClient.startThread}: strips any
 * OpenAI/ChatGPT-specific key (`model_verbosity`, `service_tier`,
 * `fast_mode` — see {@link codexModelBackendExcludesConfigKey}) from the
 * `thread/start` `config` overlay for a non-default backend, regardless of
 * which upstream source (a static default, `input.serviceTier`, or
 * `codexAppServerToolConfig`'s fast-mode derivation) put it there. Confirmed
 * empirically in the 2026-09-25 Stage 0 MiMo smoke test: the MiMo gateway
 * rejects `model_verbosity`.
 */
export function excludeCodexModelBackendConfigKeys(
  modelBackend: CodexModelBackend,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (modelBackend === CodexModelBackend.OpenAiChatGpt) return config;
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (codexModelBackendExcludesConfigKey(modelBackend, key)) continue;
    if (
      key === "features" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      filtered[key] = excludeCodexModelBackendConfigKeys(
        modelBackend,
        value as Record<string, unknown>,
      );
      continue;
    }
    filtered[key] = value;
  }
  return filtered;
}
