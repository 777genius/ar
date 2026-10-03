import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentRuntimeTaskProvider,
  AuthSourceKind,
  createLocalAgentRuntimeTaskRunner,
} from "../agent-runtime-task-runner";
import { ambientTestFixture } from "../../worker-claude/tests/claude-ambient-test-support";
import { encryptionKey } from "../../worker-claude/tests/file-backend-claude-worker-test-support";

const request = {
  protocolVersion: 1 as const,
  task: { kind: "structured-prompt" as const, prompt: "TEST ambient forwarding" },
};

describe("local runner ambient authorization and forwarding", () => {
  it("forwards the explicit HOME/config selection through a real worker to the fake CLI", async () => {
    const fixture = await ambientTestFixture();
    const configDir = join(fixture.homeDir, "TEST-config");
    await mkdir(configDir);
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir: join(fixture.rootDir, "TEST-runner-state"),
      encryptionKey: encryptionKey(),
      workspaceRoot: fixture.rootDir,
      env: { HOME: join(fixture.rootDir, "TEST-unselected-home") },
      authSource: { kind: AuthSourceKind.ClaudeAmbientHome, homeDir: fixture.homeDir, configDir },
      workerFactory: (input) => fixture.worker(input.env),
    });
    try {
      const result = await runner.run(request);
      expect(result.status).toBe("completed");
      if (result.status !== "completed") throw new Error("TEST ambient task did not complete");
      expect(JSON.parse(result.outputText ?? "null")).toEqual({
        home: fixture.homeDir, configDir, hasOauthToken: false, hasApiKey: false,
      });
      expect(await readFile(join(fixture.homeDir, "synthetic-session.json"), "utf8"))
        .toBe('{"testSession":true}\n');
    } finally {
      await runner.dispose();
      await rm(fixture.rootDir, { recursive: true, force: true });
    }
  });

  it.each(["hosted-TEST-job", ""])("denies programmatic ambient selection with marker %j", async (marker) => {
    const fixture = await ambientTestFixture();
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir: join(fixture.rootDir, "TEST-runner-state"),
      encryptionKey: encryptionKey(),
      workspaceRoot: fixture.rootDir,
      env: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: marker },
      authSource: { kind: AuthSourceKind.ClaudeAmbientHome, homeDir: fixture.homeDir },
      workerFactory: (input) => fixture.worker(input.env),
    });
    try {
      await expect(runner.run(request)).resolves.toMatchObject({
        status: "failed",
        failure: { code: "task_request_invalid", safeMessage: "claude_ambient_home_hosted_context_denied" },
      });
      await expect(readFile(fixture.launchPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await runner.dispose();
      await rm(fixture.rootDir, { recursive: true, force: true });
    }
  });

  it.each(["hosted-TEST-job", ""])("preserves marker %j when opening a preseeded ambient session", async (marker) => {
    const fixture = await ambientTestFixture();
    const seeded = fixture.worker();
    let forwardedMarker: string | undefined;
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir: join(fixture.rootDir, "TEST-runner-state"),
      encryptionKey: encryptionKey(),
      workspaceRoot: fixture.rootDir,
      env: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: marker },
      authSource: { kind: AuthSourceKind.PreseededSession },
      workerFactory: (input) => {
        forwardedMarker = input.env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND;
        return fixture.worker(input.env);
      },
    });
    try {
      await seeded.start();
      await seeded.seedClaudeAmbientHome({ homeDir: fixture.homeDir });
      await seeded.dispose();
      await expect(runner.run(request)).resolves.toMatchObject({
        status: "failed", failure: { code: "unknown_runtime_failure" },
      });
      expect(forwardedMarker).toBe(marker);
      await expect(readFile(fixture.launchPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await seeded.dispose();
      await runner.dispose();
      await rm(fixture.rootDir, { recursive: true, force: true });
    }
  });
});
