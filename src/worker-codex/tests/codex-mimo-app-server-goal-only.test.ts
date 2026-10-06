import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  AgentRuntimeTool,
  DefaultRedactor,
} from "@vioxen/subscription-runtime/core";
import { CodexJsonAgentDriver, CodexModelBackend, codexProviderApiEgressPolicy } from "@vioxen/subscription-runtime/provider-codex";
import { describe, expect, it } from "vitest";
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

    // The public nonreusable prewarm result exposes generated config without
    // starting the engine or evaluating the hosted credential accessor.
    async function generatedMimoConfig(options: Partial<FileBackendCodexWorkerOptions>) {
      const root = await mkdtemp(join(tmpdir(), "TEST-mimo-factory-config-"));
      let starts = 0;
      try {
        await mkdir(join(root,"workspace"));
        const runtime = runtimeFor({ ...options, stateRootDir: join(root,"state"),
          ...(options.workspacePath === undefined ? {} : {workspacePath:join(root,"workspace")}),
          runtimeHomeRootDir: join(root,"runtime"),
          sourceEnv: { ...options.sourceEnv, TMPDIR: root, MIMO_TEST_CONFIG_KEY: "TEST-synthetic-config-key" },
          mimoApiKeyEnvVarName: "MIMO_TEST_CONFIG_KEY",
          appServerProcessFactory: () => { starts++; throw new Error("TEST unexpected provider start"); },
        });
        const driver = runtime.agentDriver;
        if (!(driver instanceof CodexJsonAgentDriver)) throw new Error("TEST expected JSON driver");
        try {
          const materialized = await driver.prewarmSession({ session: null, redactor: new DefaultRedactor() });
          expect(materialized).toMatchObject({ mode: "ephemeral", reusable: false });
          for (const path of [materialized.home,materialized.codexHome]) {
            const selected = relative(root,path);
            expect(selected).not.toBe("");
            expect(isAbsolute(selected) || selected === ".." || selected.startsWith(`..${sep}`)).toBe(false);
          }
          return await readFile(join(materialized.codexHome,"config.toml"),"utf8");
        } finally { await driver.dispose(); }
      } finally {
        await rm(root,{recursive:true,force:true});
        expect(starts).toBe(0);
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

    it("materializes MiMo provider and hosted scan hook in the actual generated config", async () => {
      const config = await generatedMimoConfig({
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

    it("materializes the MiMo boundedWorkspaceTools path with the generated MCP-only config", async () => {
      const driverConfig = await generatedMimoConfig({
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        executionEngine: "app-server-goal",
        workspacePath: "/tmp/does-not-need-to-exist-for-construction/workspace",
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
