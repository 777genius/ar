import { createHash } from "node:crypto";
import type { RedactorPort } from "@vioxen/subscription-runtime/core";
import type { CodexModelBackend } from "./codex-model-backend";

export type CodexApiKeyCredential = {
  readonly backend: CodexModelBackend;
  readonly envVarName: string;
  readonly apiKey: string;
};

export class CodexApiKeyCredentialMissingError extends Error {
  constructor(readonly envVarName: string) {
    super(`codex_api_key_credential_missing:${envVarName}`);
    this.name = "CodexApiKeyCredentialMissingError";
  }
}

/**
 * Reads a static API key credential (for example the MiMo Token Plan `tp-...`
 * key) from an environment variable. Unlike the ChatGPT session path, this
 * credential is never written to `auth.json` and is never refreshed — it is
 * valid for the lifetime of the env var the host injected for this job.
 *
 * The key is registered with the redactor before this function returns, so
 * every call site that might log or echo process output is protected even if
 * it never sees the key value directly.
 */
export function loadCodexApiKeyCredential(input: {
  readonly backend: CodexModelBackend;
  readonly envVarName: string;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly redactor: RedactorPort;
}): CodexApiKeyCredential {
  const raw = (input.sourceEnv ?? process.env)[input.envVarName];
  const apiKey = raw?.trim();
  if (!apiKey) {
    throw new CodexApiKeyCredentialMissingError(input.envVarName);
  }
  input.redactor.registerSecret(apiKey, "codex-api-key-credential");
  return { backend: input.backend, envVarName: input.envVarName, apiKey };
}

/**
 * A stable, non-reversible identity for an account slot: never the raw key,
 * only a short hash prefix. Safe to use in logs, run events and manifests.
 */
export function codexApiKeyCredentialIdentity(credential: CodexApiKeyCredential): string {
  const hash = createHash("sha256").update(credential.apiKey).digest("hex").slice(0, 16);
  return `mimo:${hash}`;
}
