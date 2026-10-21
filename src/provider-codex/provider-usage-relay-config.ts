import { startProviderUsageRelay } from "../provider-usage/provider-usage-relay";
import type { ProviderCallObserver } from "../provider-usage/provider-call-observation";
import type { CodexAppServerProcessFactory } from "./app-server/application/app-server-process-port";
import { CodexModelBackend } from "./codex-model-backend";

/** Only endpoint selection changes; existing OAuth/API-key custody stays intact. */
export function providerUsageRelayArgs(backend: CodexModelBackend, baseUrl: string): string[] {
  const provider = backend === CodexModelBackend.XiaomiMimoTokenPlan ? "mimo" : "runtime_usage";
  return ["-c", `model_provider=${JSON.stringify(provider)}`, "-c", `model_providers.${provider}.base_url=${JSON.stringify(baseUrl)}`,
    ...(provider === "runtime_usage" ? ["-c", 'model_providers.runtime_usage.name="Observed OpenAI"', "-c", 'model_providers.runtime_usage.wire_api="responses"', "-c", "model_providers.runtime_usage.requires_openai_auth=true"] : [])];
}

/** Owns the optional app-server transport without affecting unobserved startup. */
export class CodexUsageRelay {
  private relay: Awaited<ReturnType<typeof startProviderUsageRelay>> | undefined;
  private starting: Promise<void> | undefined;
  constructor(private readonly options: { upstreamBaseUrl: string; model: string; observe: ProviderCallObserver; timeoutMs: number }) {}
  async prepare(model: string): Promise<void> {
    if (model !== this.options.model) throw new Error("usage_relay_model_scope_invalid");
    this.starting ??= startProviderUsageRelay(this.options).then(relay => { this.relay = relay; });
    await this.starting;
  }
  wrapProcessFactory(backend: CodexModelBackend, factory: CodexAppServerProcessFactory): CodexAppServerProcessFactory {
    return input => factory({ ...input, args: [...providerUsageRelayArgs(backend, this.baseUrl), ...input.args] });
  }
  get baseUrl(): string {
    if (!this.relay) throw new Error("usage_relay_not_initialized");
    return this.relay.baseUrl;
  }
  async close(): Promise<void> {
    await this.starting;
    await this.relay?.close();
  }
}
