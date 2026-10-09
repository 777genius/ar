import {
  AgentRuntimeTool,
  DefaultRedactor,
} from "@vioxen/subscription-runtime/core";
import { CodexModelBackend, codexProviderApiEgressPolicy } from "@vioxen/subscription-runtime/provider-codex";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFileBackendCodexWorkerRuntime } from "../file-backend-codex-runtime-factory";
import { assertWorkerOptions, type FileBackendCodexWorkerOptions } from "../file-backend-codex-worker-options";
import { MemoryWorkerObservability } from "./file-backend-codex-worker-test-support";

/**
 * SR-AP-2 fail-closed: MiMo must only ever run through the app-server goal
 * path. Nothing about MiMo may silently fall back to plain-exec,
 * packaged-exec, or plain app-server — any other engine choice combined
 * with the MiMo backend must be an explicit, loud error at construction
 * time, both at the options-validation layer (`assertWorkerOptions`, used by
 * `FileBackendCodexWorker`) and at the driver-construction layer
 * (`createFileBackendCodexWorkerRuntime`, for any direct caller that bypasses
 * `FileBackendCodexWorker`).
 */
describe("MiMo backend — app-server-goal-only enforcement", () => {
  const baseOptions: FileBackendCodexWorkerOptions = {
    providerInstanceId: "codex:mimo-guard-test",
    stateRootDir: "/tmp/does-not-need-to-exist-for-construction/state",
    codexBinaryPath: "codex",
    encryptionKey: new Uint8Array(32).fill(7),
  };

  describe("assertWorkerOptions", () => {
    it("accepts MiMo with the default engine unspecified plus explicit app-server-goal", () => {
      expect(() =>
        assertWorkerOptions({
          ...baseOptions,
          modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
          executionEngine: "app-server-goal",
        }),
      ).not.toThrow();
    });

    it("rejects MiMo with the default engine (app-server, not app-server-goal)", () => {
      expect(() =>
        assertWorkerOptions({
          ...baseOptions,
          modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        }),
      ).toThrow("file_backend_codex_mimo_requires_app_server_goal_engine");
    });

    for (const executionEngine of ["app-server", "packaged-exec", "plain-exec"] as const) {
      it(`rejects MiMo with executionEngine="${executionEngine}" instead of silently running it`, () => {
        expect(() =>
          assertWorkerOptions({
            ...baseOptions,
            modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
            executionEngine,
          }),
        ).toThrow("file_backend_codex_mimo_requires_app_server_goal_engine");
      });
    }

    it("leaves ChatGPT (the default backend) unaffected for every engine choice", () => {
      for (const executionEngine of ["app-server", "app-server-goal", "packaged-exec", "plain-exec"] as const) {
        expect(() => assertWorkerOptions({ ...baseOptions, executionEngine })).not.toThrow();
      }
    });

    it("rejects a MiMo env var override combined with the ChatGPT backend", () => {
      expect(() =>
        assertWorkerOptions({
          ...baseOptions,
          mimoApiKeyEnvVarName: "SOME_KEY",
        }),
      ).toThrow("file_backend_codex_mimo_env_var_requires_mimo_backend");
    });

    it("rejects a host-supplied providerEgressPolicy combined with the MiMo backend", () => {
      expect(() =>
        assertWorkerOptions({
          ...baseOptions,
          modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
          executionEngine: "app-server-goal",
          providerEgressPolicy: codexProviderApiEgressPolicy(),
        }),
      ).toThrow("file_backend_codex_mimo_provider_egress_policy_not_configurable");
    });

    it("keeps hosted MiMo worker activation closed at the options boundary", () => {
      expect(() => assertWorkerOptions({ ...baseOptions,
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        executionEngine: "app-server-goal",
        sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
      })).toThrow("hosted_mimo_activation_closed");
    });
  });

  describe("createFileBackendCodexWorkerRuntime (defense in depth for direct callers)", () => {
    function runtimeFor(options: Partial<FileBackendCodexWorkerOptions>) {
      return createFileBackendCodexWorkerRuntime({
        options: { ...baseOptions, ...options },
        workerId: "mimo-guard-test-worker",
        observability: new MemoryWorkerObservability(),
        redactor: new DefaultRedactor(),
        clock: {
          now: () => new Date("2026-09-25T00:00:00.000Z"),
          monotonicMs: () => 1,
        },
      });
    }

    // Observe real config before provider startup or hosted credential
    // resolution. The existing task-start hook deliberately ends this TEST turn.
    async function observedConfig(options: Partial<FileBackendCodexWorkerOptions>): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), "TEST-mimo-config-")), temp = join(root,"temp");
      await mkdir(temp);
      const spawn = vi.fn(() => { throw new Error("TEST-provider-must-not-start"); });
      const parts = runtimeFor({...options,stateRootDir:join(root,"state"),workspacePath:root,
        sourceEnv:{MIMO_TEST_TOKEN_PLAN_KEY:"TEST-not-a-credential",...options.sourceEnv,TMPDIR:temp},
        mimoApiKeyEnvVarName:"MIMO_TEST_TOKEN_PLAN_KEY",appServerProcessFactory:spawn});
      let config: string | undefined;
      try {
        const result = await parts.agentDriver.runTask({session:null,task:{kind:"structured-prompt",prompt:"TEST config only"},
          workspace:{path:root},runner:parts.runner,redactor:new DefaultRedactor(),abortSignal:new AbortController().signal,
          onTaskStarted:async () => {
            const directories = await readdir(temp); expect(directories).toHaveLength(1);
            config = await readFile(join(temp,directories[0]!,"codex-home","config.toml"),"utf8");
            throw new Error("TEST-config-observed-before-provider");
          }});
        expect(result.status).toBe("failed"); expect(spawn).not.toHaveBeenCalled();
        expect(config).toBeTypeOf("string");
        if (config === undefined) throw new Error("TEST-config-not-observed");
        return config;
      } finally {
        if ("dispose" in parts.agentDriver) await parts.agentDriver.dispose();
        await rm(root,{recursive:true,force:true});
      }
    }

    it("throws an explicit error for MiMo combined with a non-goal engine, instead of silently building a plain-exec/packaged-exec/app-server driver", () => {
      for (const executionEngine of ["app-server", "packaged-exec", "plain-exec"] as const) {
        expect(() =>
          runtimeFor({
            modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
            executionEngine,
          }),
        ).toThrow("codex_mimo_backend_requires_app_server_goal_engine");
      }
    });

    it("does not throw the app-server-goal-only guard for MiMo with executionEngine=app-server-goal", () => {
      expect(() =>
        runtimeFor({
          modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
          executionEngine: "app-server-goal",
        }),
      ).not.toThrow();
    });

    it("builds a MiMo runtime whose sessionDriver declares sessionRequirement 'none' (no auth.json/session store path)", () => {
      const runtime = runtimeFor({
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        executionEngine: "app-server-goal",
      });
      expect(runtime.sessionDriver.capabilities.sessionRequirement.kind).toBe("none");
    });

    it("builds a ChatGPT runtime (default backend) whose sessionDriver still requires a session, unchanged", () => {
      const runtime = runtimeFor({ executionEngine: "app-server-goal" });
      expect(runtime.sessionDriver.capabilities.sessionRequirement.kind).toBe("required");
    });

    it("passes MiMo provider and hosted scan hook into the effective driver config", async () => {
      const config = await observedConfig({
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        executionEngine: "app-server-goal",
        sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
      });
      expect(config).toContain("[model_providers.mimo]");
      expect(config).toContain('hooks = true');
      expect(config).toContain("[[hooks.PreToolUse]]");
      expect(config).toContain('[permissions.hosted-project-read.filesystem]');
    });

    it("leaves the ChatGPT hosted global-scan guard path completely unaffected", () => {
      expect(() =>
        runtimeFor({
          executionEngine: "app-server-goal",
          sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
        }),
      ).not.toThrow();
    });

    it("builds the MiMo boundedWorkspaceTools path with the generated MCP-only config", async () => {
      const driverConfig = await observedConfig({
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        executionEngine: "app-server-goal",
        boundedWorkspaceTools: {
          allowedTools: [AgentRuntimeTool.ReadFile],
        },
      });
      expect(driverConfig).toContain("[mcp_servers.agent_runtime_workspace]");
      expect(driverConfig).toContain('enabled_tools = ["read_file"]');
      expect(driverConfig).toContain("shell_tool = false");
      expect(driverConfig).toContain("unified_exec = false");
      expect(driverConfig).toContain("[model_providers.mimo]");
    });

    it("leaves the ChatGPT boundedWorkspaceTools path completely unaffected", () => {
      expect(() =>
        runtimeFor({
          executionEngine: "app-server-goal",
          workspacePath: "/tmp/does-not-need-to-exist-for-construction/workspace",
          boundedWorkspaceTools: { allowedTools: [] },
        }),
      ).not.toThrow();
    });
  });
});
