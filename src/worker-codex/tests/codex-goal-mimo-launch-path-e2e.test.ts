import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { AgentRuntimeExecutionMode } from "@vioxen/subscription-runtime/core";
import { CodexModelBackend, codexMimoTokenPlanEgressPolicy } from "@vioxen/subscription-runtime/provider-codex";
import { FileBackendCodexWorker } from "../file-backend-codex-worker";
import { buildCodexGoalExecutorOptions } from "../codex-goal-runner";
import { goalLaunchInput } from "../application/codex-goal-launch-input";
import { goalInputSchema } from "../codex-goal-mcp-input-schemas";
import { parseFlags } from "../codex-goal-cli-support";
import { runConfigFromFlags } from "../codex-goal-cli-run-config";
import { FakeAppServerFactory } from "../../provider-codex/app-server/testing/fake-app-server";
import { MemoryWorkerObservability } from "./file-backend-codex-worker-test-support";

/**
 * The launch-path gap this closes: every earlier MiMo test constructs
 * FileBackendCodexWorkerOptions / FileBackendCodexSafeExecutorOptions
 * directly, bypassing the product-facing launch surface entirely. These
 * tests start from what a real MCP client or CLI invocation actually sends
 * (a raw args object / argv array with modelBackend as a plain string),
 * carry it through the exact same schema validation, launch-input builder,
 * and executor-options builder a real goal job uses, and then run a real
 * task through FileBackendCodexWorker against a fake app-server — proving
 * the whole chain, not just the individual links.
 */
describe("MiMo backend — real launch path (MCP/CLI) through to execution", () => {
  it("MCP path: a raw modelBackend string survives schema validation, goalLaunchInput, and buildCodexGoalExecutorOptions uniformly onto every account, then actually runs a goal task via fake-app-server", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-mimo-mcp-launch-e2e-"));
    const jobRootDir = join(rootDir, "job");

    // Exactly what an MCP client sends: a plain JSON-ish object. modelBackend
    // arrives as the raw string an MCP tool call would carry — not the
    // CodexModelBackend enum imported by test code.
    const rawMcpArgs: Record<string, unknown> = {
      jobRootDir,
      workspacePath: join(rootDir, "workspace"),
      promptPath: join(rootDir, "prompt.md"),
      taskId: "mimo-e2e-task",
      accounts: ["mimo-a"],
      mimoAccounts: [{ name: "mimo-a", envVarName: "MIMO_TOKEN_PLAN_API_KEY_MCP" }],
      modelBackend: "xiaomi-mimo-token-plan",
      // This legacy FileBackend worker exercises the explicit goal protocol.
      // Native contained turns require the separate owned Worker authority.
      executionEngine: "app-server-goal",
    };

    // Prove the real MCP tool schema (shared by every codex_goal_* tool
    // registration) actually accepts this field.
    const parsed = z.object(goalInputSchema()).partial().parse(rawMcpArgs);
    expect(parsed.modelBackend).toBe("xiaomi-mimo-token-plan");
    expect(parsed.mimoAccounts).toEqual([
      { name: "mimo-a", envVarName: "MIMO_TOKEN_PLAN_API_KEY_MCP" },
    ]);

    const launch = await goalLaunchInput(parsed as never);
    expect(launch.config.modelBackend).toBe(CodexModelBackend.XiaomiMimoTokenPlan);
    // Preserve the explicitly requested legacy goal engine.
    expect(launch.config.executionEngine).toBe("app-server-goal");

    const fakeFactory = new FakeAppServerFactory();
    // The worker deletes its temp CODEX_HOME as soon as run() resolves, so
    // config.toml/auth.json must be inspected while the process is "alive"
    // — kick these reads off inside the process factory itself and await
    // the results after the run completes.
    let codexHome: string | undefined;
    let configTomlPromise: Promise<string> | undefined;
    let authJsonExistsPromise: Promise<boolean> | undefined;
    const processFactory = (input: Parameters<typeof fakeFactory.create>[0]) => {
      const home = input.env.CODEX_HOME;
      if (home) {
        codexHome = home;
        configTomlPromise = readFile(join(home, "config.toml"), "utf8");
        authJsonExistsPromise = access(join(home, "auth.json")).then(
          () => true,
          () => false,
        );
      }
      return fakeFactory.create(input);
    };
    const executorOptions = buildCodexGoalExecutorOptions({
      config: launch.config,
      stateRootDir: rootDir,
      encryptionKey: new Uint8Array(32).fill(9),
      appServerProcessFactory: processFactory,
      providerEgressPolicy: codexMimoTokenPlanEgressPolicy(),
      observability: new MemoryWorkerObservability(),
    });

    // The uniformity guarantee: every account in this one launch's pool
    // carries the same modelBackend, propagated from the single
    // config.modelBackend value — never per-account. This is what keeps
    // assertUniformCodexModelBackend's fail-closed rotation guard
    // (file-backend-codex-safe-executor.ts) meaningful once real manifests
    // start setting this field.
    expect(executorOptions.accounts).toHaveLength(1);
    for (const account of executorOptions.accounts) {
      expect(account.worker.modelBackend).toBe(CodexModelBackend.XiaomiMimoTokenPlan);
      expect(account.worker.executionEngine).toBe("app-server-goal");
      expect(account.worker.mimoApiKeyEnvVarName).toBe(
        "MIMO_TOKEN_PLAN_API_KEY_MCP",
      );
      expect(account.codexAuthJsonPath).toBeUndefined();
      expect(account.worker.providerEgressPolicy).toBeUndefined();
    }

    const workerOptions = executorOptions.accounts[0]!.worker;
    const worker = new FileBackendCodexWorker({
      ...workerOptions,
      sourceEnv: {
        MIMO_TOKEN_PLAN_API_KEY_MCP: "tp-fake-mcp-e2e-key",
      },
    });

    try {
      await worker.start();
      const result = await worker.run({
        prompt: "finish the end-to-end MiMo launch-path goal",
        execution: {
          mode: AgentRuntimeExecutionMode.Goal,
          completionCondition: "prove the launch path works end to end",
        },
      });

      // FileBackendCodexWorkerResult's completed variant leaves `status`
      // optional/absent — only the waiting_for_input variant sets it.
      expect(result.status).not.toBe("waiting_for_input");
      expect(result.outputText).toBe(
        "app-server output:finish the end-to-end MiMo launch-path goal",
      );
      // Went through the real goal protocol via the real app-server engine
      // — not a stub, not a direct-construction shortcut.
      expect(fakeFactory.requests.map((request) => request.method)).toEqual(
        expect.arrayContaining(["thread/start", "thread/goal/set", "turn/start"]),
      );
      expect(fakeFactory.envs[0]?.MIMO_TOKEN_PLAN_API_KEY_MCP).toBe(
        "tp-fake-mcp-e2e-key",
      );
      const threadStart = fakeFactory.requests.find(
        (request) => request.method === "thread/start",
      );
      expect(threadStart?.params).toMatchObject({ modelProvider: "mimo" });
      expect(codexHome).toBeTruthy();
      const configToml = await configTomlPromise;
      expect(configToml).toContain("[model_providers.mimo]");
      expect(await authJsonExistsPromise).toBe(false);
    } finally {
      await worker.dispose();
    }
  });

  it("CLI path: --model-backend xiaomi-mimo-token-plan survives flag parsing and propagates uniformly onto every account via buildCodexGoalExecutorOptions", () => {
    const rootDir = "/tmp/does-not-need-to-exist-for-construction/cli-mimo-e2e";
    const jobRootDir = join(rootDir, "job");
    const argv = [
      "--job-root", jobRootDir,
      "--workspace", join(rootDir, "workspace"),
      "--prompt", join(rootDir, "prompt.md"),
      "--accounts", "mimo-a,mimo-b",
      "--model-backend", "xiaomi-mimo-token-plan",
    ];
    const config = runConfigFromFlags(
      parseFlags(argv),
      {},
      rootDir,
      jobRootDir,
      "mimo-cli-e2e-task",
    );
    expect(config.modelBackend).toBe(CodexModelBackend.XiaomiMimoTokenPlan);

    const executorOptions = buildCodexGoalExecutorOptions({
      config,
      stateRootDir: rootDir,
      encryptionKey: new Uint8Array(32).fill(3),
    });
    expect(executorOptions.accounts).toHaveLength(2);
    for (const account of executorOptions.accounts) {
      expect(account.worker.modelBackend).toBe(CodexModelBackend.XiaomiMimoTokenPlan);
      expect(account.worker.executionEngine).toBe("app-server-goal");
    }
  });

  it("CLI path: an unset --model-backend defaults every account to the unchanged ChatGPT backend", () => {
    const rootDir = "/tmp/does-not-need-to-exist-for-construction/cli-chatgpt-default";
    const jobRootDir = join(rootDir, "job");
    const argv = [
      "--job-root", jobRootDir,
      "--workspace", join(rootDir, "workspace"),
      "--prompt", join(rootDir, "prompt.md"),
      "--accounts", "account-a",
    ];
    const config = runConfigFromFlags(
      parseFlags(argv),
      {},
      rootDir,
      jobRootDir,
      "chatgpt-default-task",
    );
    expect(config.modelBackend).toBeUndefined();

    const executorOptions = buildCodexGoalExecutorOptions({
      config,
      stateRootDir: rootDir,
      encryptionKey: new Uint8Array(32).fill(3),
    });
    expect(executorOptions.accounts[0]!.worker.modelBackend).toBe(
      CodexModelBackend.OpenAiChatGpt,
    );
  });

  it("CLI path: an invalid --model-backend value fails closed with a clear error instead of silently defaulting", () => {
    const rootDir = "/tmp/does-not-need-to-exist-for-construction/cli-mimo-invalid";
    const jobRootDir = join(rootDir, "job");
    const argv = [
      "--job-root", jobRootDir,
      "--workspace", join(rootDir, "workspace"),
      "--prompt", join(rootDir, "prompt.md"),
      "--accounts", "account-a",
      "--model-backend", "not-a-real-backend",
    ];
    expect(() =>
      runConfigFromFlags(parseFlags(argv), {}, rootDir, jobRootDir, "invalid-backend-task"),
    ).toThrow("--model-backend must be");
  });
});
