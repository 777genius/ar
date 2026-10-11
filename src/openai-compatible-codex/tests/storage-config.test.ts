import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOpenAiCompatibleCodexBridgeConfigFromEnv } from "../config";
import { CodexOpenAiBridgeBackend, resolveCodexOpenAiBridgeBackendOptions } from "../chat-completions/adapters/codex/codex-openai-bridge-backend";

const backend = { codexBinaryPath: "codex", authRootDir: "/unread/test-auth",
  timeoutMs: 1000, quotaCooldownMs: 1000, maxAccountCycles: 1,
  maxConcurrentRequests: 1, reasoningEffort: "low" as const };

describe("bridge storage composition", () => {
  it("uses the same root fallback at env loader and typed backend boundary with legacy state precedence", () => {
    const env = { SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_AUTH_ROOT: "/unread/test-auth",
      SUBSCRIPTION_RUNTIME_STORAGE_ROOT: "/external/runtime" };
    expect(loadOpenAiCompatibleCodexBridgeConfigFromEnv(env).stateDir).toBe("/external/runtime/state/openai-codex-bridge");
    expect(resolveCodexOpenAiBridgeBackendOptions({ ...backend, storageRootDir: "/external/runtime" }).stateDir)
      .toBe("/external/runtime/state/openai-codex-bridge");
    expect(loadOpenAiCompatibleCodexBridgeConfigFromEnv({ ...env,
      SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_STATE_DIR: "/legacy/state" }).stateDir).toBe("/legacy/state");
    expect(resolveCodexOpenAiBridgeBackendOptions({ ...backend, storageRootDir: "/external/runtime",
      stateDir: "/legacy/state" }).stateDir).toBe("/legacy/state");
    expect(loadOpenAiCompatibleCodexBridgeConfigFromEnv({
      SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_AUTH_ROOT: "/unread/test-auth",
    }).stateDir).toBe(join(tmpdir(), "subscription-runtime-openai-codex-bridge"));
  });

  it("rejects invalid roots before backend account discovery even with explicit state", () => {
    expect(() => new CodexOpenAiBridgeBackend({ ...backend, storageRootDir: "/external/../root",
      stateDir: "/legacy/state" })).toThrow("Invalid runtime storageRootDir");
  });
});
