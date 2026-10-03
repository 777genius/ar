import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../codex-app-server-execution-engine";
import { CodexModelBackend } from "../codex-model-backend";
import { FakeAppServerFactory, type FakeAppServerRequest } from "../app-server/testing/fake-app-server";
import { StaticRunner } from "./codex-provider-test-support";

/**
 * `CodexAppServerClient.startThread` used to hardcode `modelProvider: null`
 * and unconditionally send `model_verbosity` in the `thread/start` `config`
 * overlay — regardless of `config.toml`'s `[model_providers.mimo]` block, a
 * MiMo goal run would silently stay on Codex's default (OpenAI) provider.
 * These tests intercept the raw `thread/start` JSON-RPC request the
 * app-server-goal path actually sends and assert the wire content directly,
 * so a regression here is caught even if a higher layer's config.toml still
 * looks correct.
 *
 * This exercises the engine directly with a hand-built `session` (the
 * `CodexMaterializedSession` shape, not a `SessionArtifact`) — at this layer
 * there is no auth.json and no session-store/refresh concept at all, for
 * either backend, which is exactly the property a MiMo run depends on.
 */
describe("CodexAppServerClient — MiMo model_provider selection (goal mode)", () => {
  it("sends modelProvider: \"mimo\" and drops model_verbosity for a MiMo-backend goal thread", async () => {
    const test = await setup(CodexModelBackend.XiaomiMimoTokenPlan, "fast");
    try {
      expect(test.engine.kind).toBe("app-server-goal");
      const threadStart = test.starts.find((request) => request.method === "thread/start");
      expect(threadStart).toBeDefined();
      expect(threadStart?.params).toMatchObject({ modelProvider: "mimo" });
      const config = threadStart?.params?.config as Record<string, unknown> | undefined;
      expect(config?.model_verbosity).toBeUndefined();
      expect(config?.service_tier).toBeUndefined();
      expect(config?.fast_mode).toBeUndefined();
      expect((config?.features as Record<string, unknown> | undefined)?.fast_mode).toBeUndefined();
      expect(threadStart?.params).not.toHaveProperty("serviceTier");
      // Everything else the app-server needs still goes through unfiltered.
      expect(config?.web_search).toBe("disabled");
      expect(config?.model_reasoning_effort).toBe("low");
    } finally {
      await test.close();
    }
  });

  it("keeps sending modelProvider: null and model_verbosity for the default ChatGPT backend (unchanged)", async () => {
    const test = await setup(undefined);
    try {
      const threadStart = test.starts.find((request) => request.method === "thread/start");
      expect(threadStart?.params).toMatchObject({ modelProvider: null });
      const config = threadStart?.params?.config as Record<string, unknown> | undefined;
      expect(config?.model_verbosity).toBe("low");
    } finally {
      await test.close();
    }
  });
});

async function setup(
  modelBackend: CodexModelBackend | undefined,
  serviceTier?: "fast" | "default",
) {
  const workspace = await mkdtemp(join(tmpdir(), "codex-mimo-model-provider-test-"));
  const factory = new FakeAppServerFactory();
  const starts: FakeAppServerRequest[] = [];
  const engine = new CodexAppServerExecutionEngine({
    codexBinaryPath: "/bin/codex-test",
    cleanThreadPrewarm: false,
    goalMode: true,
    timeoutMs: 5_000,
    ...(modelBackend === undefined ? {} : { modelBackend }),
    processFactory: (processInput) => {
      const child = factory.create(processInput);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk) => {
        const request = JSON.parse(String(chunk)) as FakeAppServerRequest;
        if (request.method === "thread/start") starts.push(request);
        return write(chunk);
      };
      return child;
    },
  });
  const input = {
    session: {
      home: workspace,
      codexHome: workspace,
      env: { CODEX_HOME: workspace },
      sessionHash: "synthetic",
      release: async () => undefined,
    },
    workspacePath: workspace,
    model: modelBackend === CodexModelBackend.XiaomiMimoTokenPlan ? "mimo-v2.6-pro" : "gpt-test",
    reasoningEffort: "low" as const,
    ...(serviceTier === undefined ? {} : { serviceTier }),
    runner: new StaticRunner(""),
    redactor: new DefaultRedactor(),
    abortSignal: new AbortController().signal,
    prompt: "synthetic mimo model-provider check",
    warmupPrompt: "synthetic mimo model-provider check",
  };
  await engine.prewarm(input);
  return {
    engine,
    starts,
    close: async () => {
      await engine.dispose();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}
