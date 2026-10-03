import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  CodexApiKeyCredentialMissingError,
  codexApiKeyCredentialIdentity,
  loadCodexApiKeyCredential,
} from "../codex-api-key-credential";
import { CodexModelBackend } from "../codex-model-backend";
import { codexJsonHomeConfigToml } from "../codex-session-materializer";

const FAKE_KEY = "tp-fixture-not-a-real-token-plan-key-1111111111";

describe("loadCodexApiKeyCredential", () => {
  it("reads and trims the key from the given env var", () => {
    const redactor = new DefaultRedactor();
    const credential = loadCodexApiKeyCredential({
      backend: CodexModelBackend.XiaomiMimoTokenPlan,
      envVarName: "MY_KEY_VAR",
      sourceEnv: { MY_KEY_VAR: `  ${FAKE_KEY}  ` },
      redactor,
    });
    expect(credential).toEqual({
      backend: CodexModelBackend.XiaomiMimoTokenPlan,
      envVarName: "MY_KEY_VAR",
      apiKey: FAKE_KEY,
    });
  });

  it("registers the key with the redactor before returning", () => {
    const redactor = new DefaultRedactor();
    loadCodexApiKeyCredential({
      backend: CodexModelBackend.XiaomiMimoTokenPlan,
      envVarName: "MY_KEY_VAR",
      sourceEnv: { MY_KEY_VAR: FAKE_KEY },
      redactor,
    });
    expect(redactor.redact(`leaked: ${FAKE_KEY}`)).toBe(
      "leaked: [redacted:codex-api-key-credential]",
    );
  });

  it("throws a typed, non-leaking error when the env var is missing or blank", () => {
    const redactor = new DefaultRedactor();
    for (const sourceEnv of [{}, { MY_KEY_VAR: "" }, { MY_KEY_VAR: "   " }]) {
      expect(() =>
        loadCodexApiKeyCredential({
          backend: CodexModelBackend.XiaomiMimoTokenPlan,
          envVarName: "MY_KEY_VAR",
          sourceEnv,
          redactor,
        }),
      ).toThrow(CodexApiKeyCredentialMissingError);
    }
  });

  it("rejects key env names exposed to hosted shell tools", () => {
    const config = codexJsonHomeConfigToml({ namedPermissions: true });
    const rawAllowlist = config.match(/include_only = \[([^\]]*)\]/)?.[1];
    expect(rawAllowlist).toBeDefined();
    const exposed = JSON.parse(`[${rawAllowlist}]`) as string[];
    for (const name of [...exposed, "SUBSCRIPTION_RUNTIME_MIMO_KEY_FILE"]) {
      expect(() => loadCodexApiKeyCredential({
        backend: CodexModelBackend.XiaomiMimoTokenPlan,
        envVarName: name,
        sourceEnv: { [name]: FAKE_KEY },
        redactor: new DefaultRedactor(),
      })).toThrow("codex_mimo_env_key_unsafe");
    }
  });
});

describe("codexApiKeyCredentialIdentity", () => {
  it("derives a stable, non-reversible identity that never contains the raw key", () => {
    const redactor = new DefaultRedactor();
    const credential = loadCodexApiKeyCredential({
      backend: CodexModelBackend.XiaomiMimoTokenPlan,
      envVarName: "MY_KEY_VAR",
      sourceEnv: { MY_KEY_VAR: FAKE_KEY },
      redactor,
    });
    const identity = codexApiKeyCredentialIdentity(credential);
    expect(identity).toMatch(/^mimo:[0-9a-f]{16}$/);
    expect(identity).not.toContain(FAKE_KEY);

    const other = loadCodexApiKeyCredential({
      backend: CodexModelBackend.XiaomiMimoTokenPlan,
      envVarName: "MY_KEY_VAR",
      sourceEnv: { MY_KEY_VAR: "tp-a-totally-different-key-9999999999999999" },
      redactor,
    });
    expect(codexApiKeyCredentialIdentity(other)).not.toBe(identity);
    expect(codexApiKeyCredentialIdentity(credential)).toBe(identity);
  });
});
