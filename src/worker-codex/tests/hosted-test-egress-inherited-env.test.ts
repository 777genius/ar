import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  CodexJsonAgentDriver, CodexProviderEgressProfileId, codexProviderEgressPolicy,
  codexProviderEgressCliConfigArgs, sessionArtifactFromCodexAuthJson,
} from "@vioxen/subscription-runtime/provider-codex";
import { codexAppServerProcessInvocation } from "../../provider-codex/app-server/adapters/node-app-server-process";
import type { CodexAppServerProcessFactory } from "../../provider-codex/app-server/application/app-server-process-port";
import { FakeAppServerFactory } from "../../provider-codex/app-server/testing/fake-app-server";
import { StaticRunner, validAuthJson } from "../../provider-codex/tests/codex-provider-test-support";
import { NullWorkerObservability } from "../../worker-local/observability";
import { createFileBackendCodexWorkerRuntime } from "../file-backend-codex-runtime-factory";
import type { FileBackendCodexWorkerOptions } from "../file-backend-codex-worker";

const hostedEnv = {
  PATH: "/synthetic/inherited/bin",
  SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job",
  SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: CodexProviderEgressProfileId.TestNpmQualification,
};
const redactor = new DefaultRedactor();
function runtime(root: string, options: Partial<FileBackendCodexWorkerOptions>) {
  return createFileBackendCodexWorkerRuntime({
    options: { providerInstanceId: "synthetic", stateRootDir: join(root, "state"),
      workspacePath: root, codexBinaryPath: "/synthetic/never-executed",
      encryptionKey: new Uint8Array(32), executionEngine: "app-server-goal",
      warmupPrompt: false, ...options },
    workerId: "inherited-env", observability: new NullWorkerObservability(), redactor,
    clock: { now: () => new Date(), monotonicMs: () => performance.now() },
  });
}

describe("direct factory hosted environment selection", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let root: string;
  beforeEach(async () => {
    originalEnv = process.env;
    // Exercise inheritance without copying or inspecting the worker's real environment.
    process.env = { ...hostedEnv };
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    root = await mkdtemp(join(tmpdir(), "hosted-inherited-env-"));
  });
  afterEach(async () => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    { name: "inherited hosted TEST", explicit: false, profile: CodexProviderEgressProfileId.TestNpmQualification },
    { name: "explicit hosted TEST", explicit: true, profile: CodexProviderEgressProfileId.TestNpmQualification },
    { name: "inherited hosted managed", explicit: false, profile: CodexProviderEgressProfileId.TestManagedQualification },
    { name: "explicit hosted managed", explicit: true, profile: CodexProviderEgressProfileId.TestManagedQualification },
    { name: "inherited hosted API", explicit: false, profile: CodexProviderEgressProfileId.ProviderApi },
    { name: "inherited hosted default ignores spoofed TEST marker", explicit: false, profile: undefined },
  ])("$name retains hosted namespace and hooks", async ({ explicit, profile }) => {
    const fake = new FakeAppServerFactory();
    const launches: Parameters<CodexAppServerProcessFactory>[0][] = [];
    const explicitEnv = { ...hostedEnv, PATH: "/synthetic/explicit/bin" };
    if (explicit) delete process.env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND;
    const options: Partial<FileBackendCodexWorkerOptions> = {
      ...(explicit ? { sourceEnv: explicitEnv } : {}),
      ...(profile === undefined ? {} : { providerEgressPolicy: codexProviderEgressPolicy(profile) }),
      appServerProcessFactory: input => { launches.push(input); return fake.create(input); },
    };
    if (profile === CodexProviderEgressProfileId.TestManagedQualification) {
      expect(() => runtime(root, options)).toThrow("hosted_readonly_admitted_factory_required");
      expect(launches).toEqual([]);
      return;
    }
    const driver = runtime(root, options).agentDriver as CodexJsonAgentDriver;
    const expectedPolicy = codexProviderEgressPolicy(profile ?? CodexProviderEgressProfileId.ProviderApi);
    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson), redactor,
        runner: new StaticRunner(""), task: { kind: "structured-prompt", prompt: "offline" },
        workspace: { path: root }, abortSignal: new AbortController().signal,
      });
      expect(result.status).toBe("completed");
      expect(launches.length).toBeGreaterThan(0);
      for (const launch of launches) {
        expect(launch.env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND).toBe("hosted-codex-job");
        expect(launch.env.PATH?.split(":" )).toContain(explicit ? explicitEnv.PATH : hostedEnv.PATH);
        expect(launch.env.SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE).toBe(expectedPolicy.profileId);
        expect(launch.args.slice(-6)).toEqual(codexProviderEgressCliConfigArgs(expectedPolicy));
        expect(launch.args).toContain("--dangerously-bypass-hook-trust");
        // Only the synthetic materialized home's config is read; no real session is used.
        const config = await readFile(join(launch.env.CODEX_HOME!, "config.toml"), "utf8");
        expect(config).toContain("[[hooks.PreToolUse]]");
        expect(config.includes("registry.npmjs.org")).toBe(expectedPolicy.profileId !== CodexProviderEgressProfileId.ProviderApi);
        expect(config.includes("api.github.com")).toBe(false);
        const invocation = codexAppServerProcessInvocation({
          ...launch, platform: "linux",
          systemdUnit: "subscription-runtime-hosted-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.service",
        });
        expect(invocation.command).toBe(process.execPath);
        expect(invocation.args[1]).toBe("provider");
        expect(JSON.parse(invocation.args[2]!).operation).toBe("provider");
        expect(invocation.systemdUnit).toBe("subscription-runtime-hosted-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.service");
      }
    } finally { await driver.dispose(); }
  });

  it.each([false, true])("refuses TEST without a selected hosted marker (explicit=%s)", explicit => {
    if (!explicit) delete process.env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND;
    const spawn = vi.fn(() => { throw new Error("must not spawn"); });
    expect(() => runtime(root, {
      ...(explicit ? { sourceEnv: {} } : {}),
      providerEgressPolicy: codexProviderEgressPolicy(CodexProviderEgressProfileId.TestNpmQualification),
      appServerProcessFactory: spawn,
    })).toThrow("hosted_test_egress_engine_unsupported");
    expect(spawn).not.toHaveBeenCalled();
  });
});
