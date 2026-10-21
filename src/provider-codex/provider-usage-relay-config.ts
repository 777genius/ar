import { CodexModelBackend } from "./codex-model-backend";

/** Only endpoint selection changes; existing OAuth/API-key custody stays intact. */
export function providerUsageRelayArgs(backend: CodexModelBackend, baseUrl: string): string[] {
  const provider = backend === CodexModelBackend.XiaomiMimoTokenPlan ? "mimo" : "runtime_usage";
  return ["-c", `model_provider=${JSON.stringify(provider)}`, "-c", `model_providers.${provider}.base_url=${JSON.stringify(baseUrl)}`,
    ...(provider === "runtime_usage" ? ["-c", 'model_providers.runtime_usage.name="Observed OpenAI"', "-c", 'model_providers.runtime_usage.wire_api="responses"', "-c", "model_providers.runtime_usage.requires_openai_auth=true"] : [])];
}
