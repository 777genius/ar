import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeTool, DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { AppServerExecutionLifetime, CodexModelBackend, CodexProviderEgressProfileId, HostedMimoProfile,
  codexMimoDefaultModel, type CodexAppServerProcessFactory } from "@vioxen/subscription-runtime/provider-codex";
import { createFileBackendCodexWorkerRuntime } from "../file-backend-codex-runtime-factory";
import { codexWorkerReportSchema, codexWorkerReportSchemaName } from "../codex-goal-report-schema";
import { MemoryWorkerObservability } from "./file-backend-codex-worker-test-support";
import type { FileBackendCodexWorkerOptions } from "../file-backend-codex-worker-options";

// Exercise actual factory policy composition; native origin/effect qualification is separate.
const captured = vi.hoisted(() => ({ owned: true, coding: true,
  engine: undefined as Record<string, unknown> | undefined,
  authority: undefined as Record<string, unknown> | undefined,
  policy: undefined as { profileId: string } | undefined,
  wrapped: undefined as CodexAppServerProcessFactory | undefined }));
vi.mock("@vioxen/subscription-runtime/core", async importOriginal => ({
  ...await importOriginal<typeof import("@vioxen/subscription-runtime/core")>(), createSubscriptionRuntime: () => ({}),
}));
vi.mock("../research-launch-admission", () => ({ ownedMimoWorkerStart: () => captured.owned ? {
  request: { hostedProfile: captured.coding ? "mimo-coding-v1" : undefined,
    model: codexMimoDefaultModel, workspacePath: "/TEST-workspace", codexBinaryPath: "/TEST-codex" },
} : undefined }));
vi.mock("../../provider-codex/app-server/adapters/hosted-host-policy", async importOriginal => ({
  ...await importOriginal<typeof import("../../provider-codex/app-server/adapters/hosted-host-policy")>(),
  isHostedContainment: () => true,
}));
vi.mock("../research-mimo-worker-result", () => ({ researchMimoWorkerLifecycle: () => undefined }));
vi.mock("@vioxen/subscription-runtime/provider-codex", async importOriginal => {
  const actual = await importOriginal<typeof import("@vioxen/subscription-runtime/provider-codex")>();
  return { ...actual,
    CodexJsonAgentDriver: class { constructor(readonly options: unknown) {} },
    hostedCodexExecutableReadClosure: () => undefined,
    hostedCodexResolverReadPaths: () => [],
    CodexAppServerExecutionEngine: class { readonly executionLifetime: unknown;
      constructor(options: Record<string, unknown>) { captured.engine = options; this.executionLifetime = options.executionLifetime; } },
    egressBoundCodexProcessFactory: (policy: { profileId: string }, factory: CodexAppServerProcessFactory) => {
      captured.policy = policy; captured.wrapped = input => factory(input); return captured.wrapped;
    },
    prepareHostedMimoCodingEngineAuthority: (options: Record<string, unknown>) => {
      captured.authority = options; return Object.freeze({ TEST: "opaque-authority" });
    },
  };
});
afterEach(() => { captured.owned = true; captured.coding = true; captured.engine = undefined;
  captured.authority = undefined; captured.policy = undefined; captured.wrapped = undefined; });
const processFactory: CodexAppServerProcessFactory = () => { throw new Error("TEST must not launch"); };
function makeOptions(): FileBackendCodexWorkerOptions {
  return { providerInstanceId: "TEST-coding", stateRootDir: "/tmp/TEST-coding-state",
    workspacePath: "/TEST-workspace", codexBinaryPath: "/TEST-codex", model: codexMimoDefaultModel,
    encryptionKey: new Uint8Array(32), modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    executionEngine: "app-server", appServerProcessFactory: processFactory,
    executionLifetime: new AppServerExecutionLifetime({ deadlineEpochMs: Date.now() + 60_000, maxGoalTurns: 64,
      binding: { allocationId: "TEST-job", incarnationId: "TEST-start" } }),
    maxGoalTurns: 64, cleanThreadPrewarm: false,
    sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
    outputSchemas: { [codexWorkerReportSchemaName]: codexWorkerReportSchema } };
}
function create(options: FileBackendCodexWorkerOptions) {
  return createFileBackendCodexWorkerRuntime({ options, workerId: "TEST-coding", redactor: new DefaultRedactor(),
    observability: new MemoryWorkerObservability(), clock: { now: () => new Date(), monotonicMs: () => performance.now() } });
}
describe("closed hosted CodingV1 factory composition", () => {
  it("selects native coding only from the owned profile and binds the final factory/lifetime", () => {
    const options = makeOptions(); create(options);
    expect(captured.policy?.profileId).toBe(CodexProviderEgressProfileId.ManagedPublicInternetV1);
    expect(captured.wrapped).not.toBe(processFactory);
    expect(captured.authority).toMatchObject({ processFactory: captured.wrapped, executionLifetime: options.executionLifetime,
      workspacePath: options.workspacePath, model: options.model, codexBinaryPath: options.codexBinaryPath });
    expect(captured.engine?.processFactory).toBe(captured.wrapped);
    expect(captured.engine).toMatchObject({ nativeToolSurface: HostedMimoProfile.CodingV1,
      executionProfile: { kind: "custom", disableTools: false, historyMode: "none" },
      maxGoalTurns: 64, cleanThreadPrewarm: false, goalMode: false });
    expect(captured.engine).not.toHaveProperty("bypassHookTrust");
    expect(captured.engine).not.toHaveProperty("fallback");
  });
  it.each(["workspace", "model", "executable", "turns", "tools", "profile"])("rejects substituted %s before authority issuance", fault => {
    const options = makeOptions();
    const changes: Partial<FileBackendCodexWorkerOptions> = fault === "workspace" ? { workspacePath: "/other" }
      : fault === "model" ? { model: "other" } : fault === "executable" ? { codexBinaryPath: "/other" }
      : fault === "turns" ? { maxGoalTurns: 8 }
      : fault === "tools" ? { boundedWorkspaceTools: { denyProjectInstructions: true, allowedTools: [AgentRuntimeTool.ReadFile] } }
      : { executionProfile: { kind: "custom", developerInstructions: "caller", disableTools: false, historyMode: "none" } };
    expect(() => create({ ...options, ...changes })).toThrow("codex_bounded_factory_profile_conflict");
    expect(captured.authority).toBeUndefined(); expect(captured.engine).toBeUndefined();
  });
  it("does not accept an unowned process callback as a coding launch", () => {
    captured.owned = false;
    expect(() => create(makeOptions())).toThrow();
    expect(captured.authority).toBeUndefined();
  });
});
