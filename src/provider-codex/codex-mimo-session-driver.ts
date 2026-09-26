import type { NoSessionDriver, ProviderCapabilities, ProviderFailure } from "@vioxen/subscription-runtime/core";
import { codexMimoNoSessionCapabilities, codexProviderId } from "./capabilities";
import { classifyCodexFailure } from "./failure-classifier";

/**
 * Session driver for the MiMo Token Plan backend. Unlike
 * {@link CodexCliSessionDriver} (ChatGPT OAuth, always requires a
 * `SessionArtifact`), this driver declares `sessionRequirement: "none"` so
 * `createSubscriptionRuntime` never reads/writes a session for MiMo jobs —
 * no `sessionStore` entry, no lease, no refresh. The MiMo credential itself
 * is loaded straight from its env var at task-execution time by
 * {@link loadCodexApiKeyCredential} / `CodexJsonAgentDriver.materializeMimoSession`,
 * never persisted through the session-custody path used by the ChatGPT
 * backend.
 */
export class CodexMimoNoSessionDriver implements NoSessionDriver {
  readonly providerId = codexProviderId;
  readonly capabilities = codexMimoNoSessionCapabilities as ProviderCapabilities & {
    readonly sessionRequirement: { readonly kind: "none" };
  };

  classifySessionFailure(error: unknown): ProviderFailure {
    return classifyCodexFailure(error);
  }
}
