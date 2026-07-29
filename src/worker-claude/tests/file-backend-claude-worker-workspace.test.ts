import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ProviderTaskTelemetry,
} from "@vioxen/subscription-runtime/core";
import type {
  ClaudeTaskEngineInput,
  ClaudeTaskExecutionEngine,
  ClaudeTaskExecutionResult,
} from "@vioxen/subscription-runtime/provider-claude";
import {
  FileBackendClaudeWorker,
  FileClaudeRateLimitTelemetry,
} from "../index";

describe("FileBackendClaudeWorker workspace routing", () => {
  it("runs direct tasks inside the supplied workspace path", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-worker-workspace-test-"));
    const workspacePath = join(rootDir, "borrowed-workspace");
    const engine = new RecordingClaudeEngine();
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-borrowed-workspace",
      stateRootDir: rootDir,
      encryptionKey: Buffer.alloc(32, 1),
      engine,
      workspacePath,
    });

    try {
      await mkdir(workspacePath, { recursive: true, mode: 0o700 });
      await worker.start();
      await worker.seedClaudeOAuth({ oauthToken: "claude-oauth-secret" });
      await worker.run({ prompt: "edit borrowed workspace" });

      expect(engine.records[0]?.workspacePath).toBe(workspacePath);
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("disables Claude BG nested worktree isolation in generated settings", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "claude-worker-settings-test-"));
    const telemetry = new FileClaudeRateLimitTelemetry({
      directory: join(rootDir, "rate-limit-telemetry"),
    });

    try {
      await telemetry.prepare();
      const settings = JSON.parse(await readFile(telemetry.settingsPath, "utf8"));
      expect(settings.worktree).toEqual({ bgIsolation: "none" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

class RecordingClaudeEngine implements ClaudeTaskExecutionEngine {
  readonly kind = "recording-claude-engine";
  readonly capabilities = {
    supportsStreaming: false,
    supportsToolCalls: false,
    supportsUsage: true,
    supportsProviderRunId: true,
    supportsCleanup: true,
  };
  readonly records: ClaudeTaskEngineInput[] = [];

  async run(input: ClaudeTaskEngineInput): Promise<ClaudeTaskExecutionResult> {
    this.records.push(input);
    return {
      outputText: "ok",
      telemetry: {
        providerRunId: `run-${this.records.length}`,
        providerSessionId: `session-${this.records.length}`,
      } satisfies ProviderTaskTelemetry,
      warnings: [],
    };
  }

  async dispose(): Promise<void> {}
}
