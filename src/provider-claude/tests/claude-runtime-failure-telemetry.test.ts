import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor, type ProviderTaskEvent, type RunnerPort } from "@vioxen/subscription-runtime/core";
import { ClaudeRuntimeTaskExecutionEngine, ClaudeTaskAgentDriver, sessionArtifactFromClaudeOAuth } from "../index";
import type { ClaudeRuntimeEventLike } from "../protocol/claude-runtime-events";

describe("Claude runtime failure telemetry", () => {
  it.each(["observe", "parse", "redact"] as const)(
    "preserves runtime usage on %s failure in both run and stream paths",
    async (mode) => {
      const workspace = await mkdtemp(join(tmpdir(), "claude-runtime-telemetry-"));
      try {
        for (const streaming of [false, true]) {
          const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
          const fakeProvider = new FakeClaudeRuntimeProvider(mode === "observe"
            ? [{ type: "usage", usage }]
            : [{ type: "result_available", result: { text: "not json", usage } }]);
          if (mode === "observe") {
            fakeProvider.observe = async function* () {
              yield { type: "usage" as const, usage };
              throw new Error("claude task timed out");
            };
          }
          const driver = new ClaudeTaskAgentDriver({
            engine: new ClaudeRuntimeTaskExecutionEngine({
              runtimeModuleLoader: async () => fakeRuntimeModule,
              providerModuleLoader: async () => fakeProviderModule(fakeProvider),
            }),
          });
          const redactor = new DefaultRedactor();
          const redact = redactor.redact.bind(redactor);
          if (mode === "redact") redactor.redact = (text) => {
            if (text === "not json") throw new Error("provider output invalid");
            return redact(text);
          };
          const input = {
            session: sessionArtifactFromClaudeOAuth({ oauthToken: "fake-secret", configDir: workspace }),
            task: { kind: "structured-prompt" as const, prompt: "fake", outputSchemaName: "object" },
            workspace: { path: workspace }, runner: {} as RunnerPort, redactor,
            abortSignal: new AbortController().signal,
          };
          const events = streaming ? await collectEvents(driver.streamTask(input)) : [];
          const terminal = events.at(-1);
          const result = streaming
            ? terminal?.type === "completed" ? terminal.result : undefined
            : await driver.runTask(input);
          expect(result).toMatchObject({
            status: "failed",
            failure: { code: mode === "observe" ? "task_timeout"
              : mode === "parse" ? "provider_output_invalid" : "unknown_runtime_failure" },
            telemetry: { usage },
          });
          expect(result?.telemetry).not.toHaveProperty("providerSessionId");
          expect(result?.telemetry).not.toHaveProperty("providerRunId");
          expect(fakeProvider.removed).toBe(true);
        }
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

});

const fakeRuntimeModule = {
  asCommandId: (value: string) => value,
  asIsoTimestamp: (value: string) => value,
  asThreadId: (value: string) => value,
  FileRuntimeStateStore: class {},
};

function fakeProviderModule(provider: FakeClaudeRuntimeProvider) {
  return { ClaudeBgRuntimeProvider: class {
    readonly id = "fake-claude";
    async start() { return { runId: "private-run", providerSessionId: "private-session" }; }
    observe() { return provider.observe(); }
    async remove() { provider.removed = true; }
  } };
}

class FakeClaudeRuntimeProvider {
  removed = false;
  constructor(private readonly events: readonly ClaudeRuntimeEventLike[]) {}
  async *observe(): AsyncIterable<ClaudeRuntimeEventLike> {
    yield* this.events;
  }
}

async function collectEvents(iterable: AsyncIterable<ProviderTaskEvent>): Promise<ProviderTaskEvent[]> {
  const events: ProviderTaskEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
