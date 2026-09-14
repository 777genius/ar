import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  CodexJsonAgentDriver, CodexProviderEgressProfileId, codexProviderEgressPolicy,
  codexProviderEgressCliConfigArgs, sessionArtifactFromCodexAuthJson,
} from "@vioxen/subscription-runtime/provider-codex";
import { codexAppServerProcessInvocation } from "../../provider-codex/app-server/adapters/node-app-server-process";
import { FakeAppServerFactory } from "../../provider-codex/app-server/testing/fake-app-server";
import { StaticRunner, validAuthJson } from "../../provider-codex/tests/codex-provider-test-support";
import { NullWorkerObservability } from "../../worker-local/observability";
import { createFileBackendCodexWorkerRuntime, type CodexWorkerExecutionEngine } from "../file-backend-codex-runtime-factory";
import type { FileBackendCodexWorkerOptions } from "../file-backend-codex-worker";

const redactor = new DefaultRedactor();
const clock = { now: () => new Date(), monotonicMs: () => performance.now() };
function runtime(options: FileBackendCodexWorkerOptions) {
  return createFileBackendCodexWorkerRuntime({ options, workerId: "same-worker",
    observability: new NullWorkerObservability(), redactor, clock });
}
describe("factory admitted policy propagation", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it("uses one snapshot for prewarm, task, child CLI and cached homes across ordinary profiles and reopenings; refuses managed factory substitution", async () => {
    const root = await mkdtemp(join(tmpdir(), "egress-factory-"));
    const workspacePath = join(root, "workspace"); await mkdir(workspacePath);
    const homes: string[] = [];
    try {
      const profiles = [CodexProviderEgressProfileId.ProviderApi, CodexProviderEgressProfileId.TestNpmQualification,
        CodexProviderEgressProfileId.TestManagedQualification];
      for (const profileId of [...profiles, ...profiles]) {
        const fake = new FakeAppServerFactory({ goalStatusesAfterTurns: ["blocked", "complete"] });
        const launches: Parameters<typeof fake.create>[0][] = [];
        const admitted = { profileId, domains: ["ignored.invalid"] };
        const options: FileBackendCodexWorkerOptions = {
          providerInstanceId: "synthetic-account", stateRootDir: join(root, "state"), workspacePath,
          codexBinaryPath: "/synthetic/never-executed", encryptionKey: new Uint8Array(32),
          executionEngine: "app-server-goal", warmupPrompt: false,
          providerEgressPolicy: admitted,
          sourceEnv: { PATH: "/synthetic/bin", SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job",
            SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: "forged" },
          appServerProcessFactory: input => { launches.push(input); return fake.create(input); },
        };
        if (profileId === CodexProviderEgressProfileId.TestManagedQualification) {
          expect(() => runtime(options)).toThrow("hosted_readonly_admitted_factory_required");
          expect(launches).toEqual([]);
          continue;
        }
        const parts = runtime(options);
        const driver = parts.agentDriver as CodexJsonAgentDriver;
        // An internal caller retaining its original object cannot mutate a constructed runtime.
        admitted.profileId = CodexProviderEgressProfileId.ProviderApi;
        try {
          const session = sessionArtifactFromCodexAuthJson(validAuthJson);
          const runner = new StaticRunner("");
          await driver.prewarmSession({ session, redactor, workspacePath, runner });
          const result = await driver.runTask({ session, redactor, runner,
            task: { kind: "structured-prompt", prompt: "offline test", controls: { editMode: "allow-edits" }, metadata: { codexManagedRunId: "synthetic-resume" } },
            workspace: { path: workspacePath }, abortSignal: new AbortController().signal });
          expect(result.status).toBe("waiting_for_input");
          if (result.status !== "waiting_for_input") throw new Error("expected synthetic blocked goal");
          const resumed = await driver.resumeManagedRun({ session, redactor, runner,
            runId: result.runId, requestId: result.request.id, answer: "continue offline",
            resumeHandle: result.resumeHandle, task: { controls: { editMode: "allow-edits" } },
            workspace: { path: workspacePath }, abortSignal: new AbortController().signal });
          expect(resumed.status).toBe("completed");
          expect(launches.length).toBeGreaterThan(0);
          for (const launch of launches) {
            expect(launch.env?.SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE).toBe(profileId);
            expect(launch.env?.PATH?.split(":")).toContain("/synthetic/bin");
            expect(launch.args.slice(-6)).toEqual(codexProviderEgressCliConfigArgs(codexProviderEgressPolicy(profileId)));
            const home = launch.env!.CODEX_HOME!;
            const config = await readFile(join(home, "config.toml"), "utf8");
            expect(config.includes("registry.npmjs.org")).toBe(profileId !== CodexProviderEgressProfileId.ProviderApi);
            expect(config.includes("api.github.com")).toBe(false);
            expect(config.includes("raw.githubusercontent.com")).toBe(false);
            expect(config).toContain("[[hooks.PreToolUse]]");
            expect(config).toContain("network_access = true");
          }
          homes.push(launches[0]!.env!.CODEX_HOME!);
          const turns = fake.requests.filter(r => r.method === "turn/start");
          expect(turns.length).toBeGreaterThan(0);
          for (const turn of turns) expect(turn.params).toMatchObject({ sandboxPolicy: { networkAccess: true } });
        } finally { await driver.dispose(); }
      }
      expect(new Set(homes.slice(0, 2)).size).toBe(2);
      expect(homes.slice(2)).toEqual(homes.slice(0, 2));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each([CodexProviderEgressProfileId.TestNpmQualification, CodexProviderEgressProfileId.TestManagedQualification])("defaults inherited spoofed %s to API-only while preserving PATH", async profileId => {
    const root = await mkdtemp(join(tmpdir(), "egress-inherited-"));
    vi.stubEnv("SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE", profileId);
    vi.stubEnv("PATH", "/synthetic/inherited/bin");
    vi.stubEnv("SUBSCRIPTION_RUNTIME_SANDBOX_KIND", "hosted-codex-job");
    const fake = new FakeAppServerFactory();
    const launches: Parameters<typeof fake.create>[0][] = [];
    const parts = runtime({ providerInstanceId: "fake", stateRootDir: join(root, "state"),
      workspacePath: root, codexBinaryPath: "/synthetic", encryptionKey: new Uint8Array(32),
      executionEngine: "app-server-goal", warmupPrompt: false,
      appServerProcessFactory: input => { launches.push(input); return fake.create(input); },
    });
    const driver = parts.agentDriver as CodexJsonAgentDriver;
    try {
      await driver.runTask({ session: sessionArtifactFromCodexAuthJson(validAuthJson), redactor,
        runner: new StaticRunner(""), task: { kind: "structured-prompt", prompt: "offline" },
        workspace: { path: root }, abortSignal: new AbortController().signal });
      expect(launches.length).toBeGreaterThan(0);
      for (const launch of launches) {
        expect(launch.env?.PATH?.split(":" )).toContain("/synthetic/inherited/bin");
        expect(launch.env?.SUBSCRIPTION_RUNTIME_SANDBOX_KIND).toBe("hosted-codex-job");
        const invocation = codexAppServerProcessInvocation({ command: "/synthetic", args: launch.args,
          cwd: root, env: launch.env!, platform: "linux",
          hostedLauncher: "/synthetic/launcher.js", nodePath: "/synthetic/node" });
        expect(invocation.command).toBe(process.execPath);
        expect(invocation.args[1]).toBe("provider");
        expect(JSON.parse(invocation.args[2]!).operation).toBe("provider");
        expect(launch.env?.SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE).toBe(CodexProviderEgressProfileId.ProviderApi);
        expect(launch.args.join(" ")).not.toContain("registry.npmjs.org");
        expect(await readFile(join(launch.env!.CODEX_HOME!, "config.toml"), "utf8")).not.toContain("registry.npmjs.org");
      }
    } finally { await driver.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(["darwin", "win32"])("refuses TEST on %s before provider construction", async platform => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
    const root = await mkdtemp(join(tmpdir(), "egress-platform-"));
    try {
      expect(() => runtime({ providerInstanceId: "fake", stateRootDir: root,
        codexBinaryPath: "/synthetic", encryptionKey: new Uint8Array(32),
        executionEngine: "app-server-goal", sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
        providerEgressPolicy: codexProviderEgressPolicy(CodexProviderEgressProfileId.TestNpmQualification),
        appServerProcessFactory: () => { throw new Error("must not spawn"); },
      })).toThrow("hosted_test_egress_engine_unsupported");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(["plain-exec", "packaged-exec", "app-server", "unknown"])("rejects admitted TEST on %s before a provider spawn", async engine => {
    const root = await mkdtemp(join(tmpdir(), "egress-engine-"));
    const spawn = vi.fn();
    try {
      expect(() => runtime({ providerInstanceId: "fake", stateRootDir: root,
        codexBinaryPath: "/synthetic", encryptionKey: new Uint8Array(32),
        executionEngine: engine as CodexWorkerExecutionEngine,
        sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
        providerEgressPolicy: codexProviderEgressPolicy(CodexProviderEgressProfileId.TestNpmQualification),
        appServerProcessFactory: spawn,
      })).toThrow("hosted_test_egress_engine_unsupported");
      expect(spawn).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
