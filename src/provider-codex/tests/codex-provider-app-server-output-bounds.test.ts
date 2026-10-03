import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine, CodexJsonAgentDriver, sessionArtifactFromCodexAuthJson } from "../index";
import { mergeTurnOutput } from "../app-server/application/app-server-turn-output";
import { createTurnState } from "../app-server/application/app-server-turn-state";
import { FakeAppServerFactory } from "../app-server/testing/fake-app-server";
import { RecordingJsonEngine, StaticRunner, validAuthJson } from "./codex-provider-test-support";

describe("Codex app-server output bounds", () => {
  it("counts replacement-only alias text against the streamed output budget", () => {
    const expected = createTurnState();
    expected.outputText = "x"; expected.outputBytes = 1; expected.deliveredOutputBytes = 1_000;
    const actual = createTurnState();
    actual.outputText = "x".repeat(500); actual.outputBytes = 500;
    let rejected = false;
    expect(mergeTurnOutput({ expected, actual, maxOutputBytes: 1_024, reject: () => { rejected = true; } })).toBe(false);
    expect(rejected).toBe(true);
    expect(expected.error?.message).toBe("codex_app_server_output_too_large");
  });

  it("rejects oversized streamed output before delivering later chunks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-stream-limit-test-"));
    const delta = "x".repeat(1_024);
    const fakeFactory = new FakeAppServerFactory({ agentMessageDeltas: Array.from({ length: 20 }, () => delta), turnUsage: { input_tokens: 123, output_tokens: 45 }, suppressTurnCompletion: true });
    const fallback = new RecordingJsonEngine("fallback must not run");
    const driver = new CodexJsonAgentDriver({ engine: new CodexAppServerExecutionEngine({ codexBinaryPath: "/bin/codex-test", processFactory: fakeFactory.create, fallback, cleanThreadPrewarm: false, maxOutputBytes: 1_024, timeoutMs: 250 }), model: "gpt-test", reasoningEffort: "low" });
    const delivered: string[] = [];
    try {
      const result = await driver.runTask({ session: sessionArtifactFromCodexAuthJson(validAuthJson), task: { kind: "review", prompt: "stream limit" }, workspace: { path: workspace }, runner: new StaticRunner(""), redactor: new DefaultRedactor(), abortSignal: new AbortController().signal, onTextDelta: (text) => delivered.push(text) });
      const deliveredText = delivered.join("");
      expect(result.status).toBe("failed");
      expect(deliveredText).not.toBe("");
      expect(deliveredText).toBe(delta.slice(0, deliveredText.length));
      expect(Buffer.byteLength(deliveredText, "utf8")).toBeLessThanOrEqual(1_024);
      expect(fakeFactory.prompts).toEqual(["stream limit"]);
      expect(result).toMatchObject({ telemetry: { usage: { inputTokens: 123, outputTokens: 45, totalTokens: 168 } } });
      expect(fallback.prompts).toEqual([]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts streamed UTF-8 output exactly at the configured byte limit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-stream-exact-limit-test-"));
    const delta = "é".repeat(512);
    const driver = new CodexJsonAgentDriver({ engine: new CodexAppServerExecutionEngine({ codexBinaryPath: "/bin/codex-test", processFactory: new FakeAppServerFactory({ agentMessageDeltas: [delta] }).create, cleanThreadPrewarm: false, maxOutputBytes: 1_024 }), model: "gpt-test", reasoningEffort: "low" });
    try {
      const result = await driver.runTask({ session: sessionArtifactFromCodexAuthJson(validAuthJson), task: { kind: "review", prompt: "exact stream limit" }, workspace: { path: workspace }, runner: new StaticRunner(""), redactor: new DefaultRedactor(), abortSignal: new AbortController().signal });
      expect(result).toMatchObject({ status: "completed", outputText: delta });
      expect(Buffer.byteLength(delta, "utf8")).toBe(1_024);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("closes an oversized protocol frame before turn acknowledgement without fallback", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-frame-limit-test-"));
    const fakeFactory = new FakeAppServerFactory();
    const fallback = new RecordingJsonEngine("fallback must not run");
    let injected = false;
    const processFactory = (input: Parameters<typeof fakeFactory.create>[0]) => {
      const child = fakeFactory.create(input);
      const emit = child.stdout.emit.bind(child.stdout);
      child.stdout.emit = ((event: string | symbol, ...args: unknown[]) => {
        if (event === "data" && !injected) {
          const packet = JSON.parse(String(args[0])) as { readonly id?: number };
          const request = fakeFactory.requests.find((entry) => entry.id === packet.id);
          if (request?.method === "turn/start") {
            injected = true;
            return emit("data", "x".repeat(5 * 1024 * 1024));
          }
        }
        return emit(event, ...args);
      }) as typeof child.stdout.emit;
      return child;
    };
    const driver = new CodexJsonAgentDriver({ engine: new CodexAppServerExecutionEngine({ codexBinaryPath: "/bin/codex-test", processFactory, fallback, cleanThreadPrewarm: false }), model: "gpt-test", reasoningEffort: "low" });
    try {
      const result = await driver.runTask({ session: sessionArtifactFromCodexAuthJson(validAuthJson), task: { kind: "review", prompt: "frame limit" }, workspace: { path: workspace }, runner: new StaticRunner(""), redactor: new DefaultRedactor(), abortSignal: new AbortController().signal });
      expect(result).toMatchObject({ status: "failed", failure: { details: { rawCause: expect.stringContaining("codex_app_server_json_rpc_frame_limit_exceeded") } } });
      expect(fallback.prompts).toEqual([]);
      expect(fakeFactory.processes[0]?.isExited()).toBe(true);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
