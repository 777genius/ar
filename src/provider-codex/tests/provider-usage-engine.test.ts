import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { PackagedCodexJsonExecutionEngine } from "../codex-json-execution-engine";
import { CodexUsageRelay } from "../provider-usage-relay-config";
import { CodexModelBackend } from "../codex-model-backend";
import type { CodexAppServerProcessFactory } from "../app-server/application/app-server-process-port";
import { StaticRunner } from "./codex-provider-test-support";
import type { ProviderCallObservation } from "../../provider-usage/provider-call-observation";

it("routes the actual child-selected endpoint through telemetry even when the child exits nonzero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "TEST-runtime-usage-"));
  const facts: ProviderCallObservation[] = [], nativeFetch = globalThis.fetch;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).startsWith("https://provider.test/")) return new Response('{"status":"completed","usage":{"input_tokens":8,"output_tokens":2}}', { headers: { "content-type": "application/json" } });
    return nativeFetch(url, init);
  });
  const runner = new StaticRunner("");
  vi.spyOn(runner, "run").mockImplementation(async input => {
    const selected = input.args?.find(arg => arg.startsWith("model_providers.runtime_usage.base_url="));
    expect(input.args).toContain("model_providers.runtime_usage.requires_openai_auth=true");
    const base = JSON.parse(selected!.slice(selected!.indexOf("=") + 1)) as string;
    const response = await nativeFetch(base + "/responses", { method: "POST", body: '{"model":"test"}' });
    expect(response.status).toBe(200); await response.text();
    return { exitCode: 7, stdout: "", stderr: "", durationMs: 1 };
  });
  const engine = new PackagedCodexJsonExecutionEngine({ codexBinaryPath: "test-codex", usageRelay: { upstreamBaseUrl: "https://provider.test/v1", observe: f => { facts.push(f); } } });
  try {
    await expect(engine.run({ prompt: "private", session: { home: directory, codexHome: directory, env: {}, release: async () => {} },
      workspacePath: directory, runner, redactor: new DefaultRedactor(), model: "test", reasoningEffort: "low", abortSignal: new AbortController().signal,
    })).rejects.toThrow("codex_json_exec_failed:7");
    expect(facts.map(f => f.state)).toEqual(["dispatched", "completed"]);
    expect(facts[1]?.tokens.total).toBe(10);
  } finally { fetchSpy.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});

it("does not turn optional telemetry model metadata into app-server execution admission", async () => {
  const relay = new CodexUsageRelay({ upstreamBaseUrl: "https://api.anthropic.com", model: "sonnet", observe: () => {}, timeoutMs: 1000 });
  try { await expect(relay.prepare("claude-haiku-4-5")).resolves.toBeUndefined(); expect(relay.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/); }
  finally { await relay.close(); }
});

it("preserves the original storage-context marker through the usage relay process factory", () => {
  const relay = new CodexUsageRelay({ upstreamBaseUrl: "https://api.anthropic.com", model: "sonnet", observe: () => {}, timeoutMs: 1000 });
  const base = Object.assign((() => { throw new Error("not spawned"); }) as unknown as CodexAppServerProcessFactory, { originalProviderStorageContext: true as const });
  const wrapped = relay.wrapProcessFactory(CodexModelBackend.XiaomiMimoTokenPlan, base);
  expect(wrapped.originalProviderStorageContext).toBe(true);
});

it("retries a later prepare after a failed relay start and disposes cleanly", async () => {
  const options = { upstreamBaseUrl: "http://insecure.test", model: "sonnet", observe: () => {}, timeoutMs: 1000 };
  const relay = new CodexUsageRelay(options);
  await expect(relay.prepare("sonnet")).rejects.toThrow("usage_relay_target_invalid");
  await expect(relay.close()).resolves.toBeUndefined();
  options.upstreamBaseUrl = "https://api.anthropic.com";
  await expect(relay.prepare("sonnet")).resolves.toBeUndefined();
  await expect(relay.close()).resolves.toBeUndefined();
});
