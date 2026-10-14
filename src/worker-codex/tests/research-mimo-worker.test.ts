import { host, local, request, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRuntimeTool, DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { createFileBackendCodexWorkerRuntime } from "../file-backend-codex-runtime-factory";
import { MemoryWorkerObservability } from "./file-backend-codex-worker-test-support";
import { CodexModelBackend, CodexProviderEgressProfileId, HostedMimoProfile, codexMimoDefaultModel } from "@vioxen/subscription-runtime/provider-codex";
import { grantOwnedMimoWorkerLaunch, grantResearchLaunch, startResearchLaunch } from "../research-launch-owner";
import { bindResearchRuntime, researchCurrentStart } from "../research-launch-admission";
import { parseResearchOperatorRequest, researchRunConfig } from "../research-launch-contract";
import { researchHash, researchRead, researchPublish } from "../research-launch-files";
import { admitHostedTestEgress } from "../hosted-test-egress-admission";
import { admitHostedReadonlyInputs } from "../hosted-readonly-admission";
import { buildCodexGoalExecutorOptions, runCodexGoal } from "../codex-goal-runner";
import { assertWorkerOptions } from "../file-backend-codex-worker-options";
import { readHostedMimoWorkerOrigin } from "../../provider-codex/hosted-mimo-worker-origin";

beforeEach(setupResearchFixture);
afterEach(cleanupResearchFixture);
const mimoRequest = () => parseResearchOperatorRequest({ ...request(), accounts: ["account-q"],
  modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, model: codexMimoDefaultModel,
  maxAccountCycles: 1, prewarmOnStart: false });
function startMimo() {
  const selected = mimoRequest();
  writeFileSync(local("/TEST-operator/request.json"), JSON.stringify(selected) + "\n", { mode: 0o600 });
  grantOwnedMimoWorkerLaunch(selected.jobId, selected.jobRootDir, selected.workspacePath);
  const started = startResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")));
  host.group = `/system.slice/${started.unit}`;
  bindResearchRuntime(started.jobId, started.startId);
  return { ...started, ...researchCurrentStart(started.jobId), selected };
}

describe("owned standalone MiMo worker", () => {
  // RED: positive-only goal validation rejects the admitted worker's zero retries before egress admission.
  it("passes zero reconnect retries through the real goal entry into owned egress admission", async () => {
    const { selected } = startMimo();
    const config = researchRunConfig(selected);
    expect(config.maxReconnectRetriesPerAccount).toBe(0);
    let admitted = false;
    await expect(runCodexGoal(config, { admitProviderEgress: async input => {
      const policy = await admitHostedTestEgress(input);
      expect(policy.profileId).toBe(CodexProviderEgressProfileId.MimoTokenPlan);
      admitted = true;
      throw new Error("TEST-owned-MiMo-egress-admitted");
    } })).rejects.toThrow("TEST-owned-MiMo-egress-admitted");
    expect(admitted).toBe(true);
    expect(host.authReads).toBe(0);
    expect(host.spawn).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses invalid reconnect retry count %s at goal entry", async retries => {
    const { selected } = startMimo();
    await expect(runCodexGoal({ ...researchRunConfig(selected), maxReconnectRetriesPerAccount: retries }))
      .rejects.toThrow("codex_goal_reconnect_retries_invalid");
    expect(host.authReads).toBe(0);
    expect(host.spawn).not.toHaveBeenCalled();
  });

  // RED: the old closed request/egress/options boundaries refuse an independently owned MiMo worker.
  it("admits the exact Worker grant into finite real executor composition", async () => {
    const { spec, selected } = startMimo();
    const config = researchRunConfig(selected);
    if (config.executionEngine === undefined || config.modelBackend === undefined || config.sourceEnv === undefined) {
      throw new Error("Expected an explicit owned MiMo worker execution identity");
    }
    const identity = { jobId: selected.jobId, jobRootDir: selected.jobRootDir, workspacePath: selected.workspacePath,
      executionEngine: config.executionEngine, modelBackend: config.modelBackend, sourceEnv: config.sourceEnv };
    const policy = await admitHostedTestEgress(identity);
    expect(policy.profileId).toBe(CodexProviderEgressProfileId.MimoTokenPlan);
    expect(policy.domains).toEqual(["token-plan-sgp.xiaomimimo.com"]);
    const factory = admitHostedReadonlyInputs({ ...identity, providerEgressPolicy: policy });
    if (factory === undefined) throw new Error("Expected the owned MiMo worker provider factory");
    const options = buildCodexGoalExecutorOptions({ config, appServerProcessFactory: factory,
      providerEgressPolicy: policy, encryptionKey: new Uint8Array(32), stateRootDir: config.stateRootDir! });
    expect(options.accounts).toHaveLength(1);
    expect(options.accounts[0]).not.toHaveProperty("codexAuthJsonPath");
    expect(options.maxAccountCycles).toBe(1);
    expect(options.prewarmOnStart).toBe(false);
    expect(options.safeExecutionPolicy).toMatchObject({ maxAttempts: 1, continuationMode: "disabled", retryOnCapacity: false,
      retryOnAccountUnavailable: false, retryOnReconnectRequired: false });
    const worker = options.accounts[0]!.worker;
    expect(worker.executionEngine).toBe("app-server");
    expect(config.workerReportMode).toBe("structured-output");
    expect(worker.modelBackend).toBe(CodexModelBackend.XiaomiMimoTokenPlan);
    expect(worker.model).toBe(codexMimoDefaultModel);
    expect(worker.maxGoalTurns).toBe(8);
    expect(worker.cleanThreadPrewarm).toBe(false);
    expect(worker.executionLifetime).toBe(options.executionLifetime);
    expect(worker.boundedWorkspaceTools).toEqual({ denyProjectInstructions: true,
      allowedTools: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.EditFile, AgentRuntimeTool.WriteFile, AgentRuntimeTool.SearchFiles] });
    if (!options.outputSchemas) throw new Error("Expected mandatory owned Worker report schemas");
    const runtime = createFileBackendCodexWorkerRuntime({ options: { ...worker, outputSchemas: options.outputSchemas, workspacePath: selected.workspacePath },
      workerId: "TEST-mimo-worker", observability: new MemoryWorkerObservability(), redactor: new DefaultRedactor(),
      clock: { now: () => new Date(), monotonicMs: () => performance.now() } });
    const generated = (runtime.agentDriver as unknown as { options: { mimoConfigToml: string } }).options.mimoConfigToml;
    expect(generated).toContain('[permissions.hosted-project-read.filesystem]');
    expect(generated).toContain('[mcp_servers.agent_runtime_workspace]');
    expect(generated).toContain('enabled_tools = ["edit_file", "read_file", "search_files", "write_file"]');
    expect(generated).toContain('env_vars = ["PATH", "HOME", "CI", "CODEX_HOME"]');
    expect(generated).toContain('shell_tool = false');
    expect(generated).toContain('unified_exec = false');
    expect(generated).toContain('project_doc_max_bytes = 0');
    expect(() => assertWorkerOptions({ ...worker, workspacePath: selected.workspacePath })).not.toThrow();
    expect(readHostedMimoWorkerOrigin()).toEqual({ homeRoot: join(selected.jobRootDir, "home"),
      directory: researchCurrentStart(selected.jobId).directory,
      digest: researchHash(researchRead(join(researchCurrentStart(selected.jobId).directory, "spec.json"))) });
    expect(spec.request.modelBackend).toBe(CodexModelBackend.XiaomiMimoTokenPlan);
    expect(host.authReads).toBe(0);
    expect(host.spawn).not.toHaveBeenCalled();
  });

  // RED: an ordinary Internet grant could be reused for a MiMo request or a MiMo grant for ChatGPT.
  it.each(["internet-grant", "chatgpt-request"])("rejects %s before owned service submission", fault => {
    const selected = mimoRequest();
    if (fault === "internet-grant") grantResearchLaunch(selected.jobId, selected.jobRootDir, selected.workspacePath);
    else grantOwnedMimoWorkerLaunch(selected.jobId, selected.jobRootDir, selected.workspacePath);
    const changed = fault === "internet-grant" ? selected : request();
    writeFileSync(local("/TEST-operator/request.json"), JSON.stringify(changed) + "\n", { mode: 0o600 });
    expect(() => startResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")))).toThrow();
    expect(host.calls.some(call => call.command === "/usr/bin/systemd-run")).toBe(false);
  });

  // RED: mutable account/model/cycle values or controller handoff bags widen a Worker request.
  it.each([{ accounts: ["account-s"] }, { accounts: ["account-q", "account-s"] }, { model: "gpt-6.1-sol" },
    { modelBackend: "unknown" }, { maxAccountCycles: 2 }, { maxAccountCycles: undefined }, { prewarmOnStart: true },
    { taskTimeoutMs: Infinity },
    { sourceEnv: { MIMO_TOKEN_PLAN_API_KEY: "TEST-only" } }])("refuses widened operator inputs %j", changed => {
    expect(() => parseResearchOperatorRequest({ ...mimoRequest(), ...changed })).toThrow();
  });

  it("refuses a durable handoff without registered authority before owned submission", () => {
    const selected = parseResearchOperatorRequest({ ...mimoRequest(), durableHandoffRootDir: "/TEST-registry/durable-handoffs" });
    grantOwnedMimoWorkerLaunch(selected.jobId, selected.jobRootDir, selected.workspacePath);
    writeFileSync(local("/TEST-operator/request.json"), JSON.stringify(selected) + "\n", { mode: 0o600 });
    expect(() => startResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")))).toThrow();
    expect(host.calls.some(call => call.command === "/usr/bin/systemd-run")).toBe(false);
  });

  // RED: profile labels alone or stale private records could authorize key bytes.
  it.each(["controller", "child", "account", "grant-drift", "mainpid", "birth", "namespace", "closing", "global"])(
    "independent provider origin refuses %s before a secret read", fault => {
      const current = startMimo();
      const grantPath = join("/run/user/subscription-runtime-research-v1", researchHash(current.jobId), "grant.json");
      const grant = JSON.parse(researchRead(grantPath).toString()) as Record<string, unknown>;
      if (fault === "controller" || fault === "child") researchPublish(grantPath, { ...grant,
        hostedProfile: fault === "controller" ? HostedMimoProfile.Controller : HostedMimoProfile.Child });
      if (fault === "grant-drift") researchPublish(grantPath, { ...grant, grantId: "b".repeat(36) });
      if (fault === "account") {
        const spec = { ...current.spec, request: { ...current.spec.request, accounts: ["account-s"] } };
        researchPublish(join(current.directory, "spec.json"), spec);
      }
      if (fault === "mainpid") host.units.get(current.unit)!.pid++;
      if (fault === "birth") host.birth = "99999";
      if (fault === "namespace") host.namespaceRoot = true;
      if (fault === "closing") researchPublish(join(current.directory, "closing.json"), { schemaVersion: 1 });
      if (fault === "global") host.global = true;
      expect(() => readHostedMimoWorkerOrigin()).toThrow();
      expect(host.authReads).toBe(0);
      expect(host.spawn).not.toHaveBeenCalled();
    });

  // RED: matching retained records could hide replaced executable/artifact bytes or unpinned roots.
  it.each(["artifact", "node", "codex", "job-pin", "workspace-pin", "job", "workspace"])(
    "independently refuses real TEST %s material drift", fault => {
      const current = startMimo();
      expect(readHostedMimoWorkerOrigin()).not.toBeNull(); // Warm signature cache before mutation.
      if (fault === "artifact") writeFileSync(local("/TEST-artifact/dist/main.js"), "TEST replaced artifact", { mode: 0o644 });
      if (fault === "node" || fault === "codex") writeFileSync(local(fault === "node" ? process.execPath : current.selected.codexBinaryPath), "TEST replaced executable", { mode: 0o755 });
      if (fault === "job-pin" || fault === "workspace-pin") {
        const name = fault === "job-pin" ? "job" : "workspace";
        const path = join(current.directory, "pins", name);
        host.pins.delete(path); // Reveal the empty real TEST mount anchor.
      }
      if (fault === "job" || fault === "workspace") {
        const path = local(fault === "job" ? current.selected.jobRootDir : current.selected.workspacePath);
        renameSync(path, path + "-retained"); mkdirSync(path, { mode: 0o700 });
      }
      expect(() => readHostedMimoWorkerOrigin()).toThrow();
      expect(host.authReads).toBe(0);
      expect(host.spawn).not.toHaveBeenCalled();
    });

  // RED: a genuine Worker factory could admit an opposite backend at public egress admission.
  it("refuses a ChatGPT/backend substitution and caller-supplied factory", async () => {
    const { selected } = startMimo();
    await expect(admitHostedTestEgress({ ...selected, executionEngine: "app-server-goal",
      modelBackend: CodexModelBackend.OpenAiChatGpt })).rejects.toThrow();
    const config = researchRunConfig(selected);
    const options = buildCodexGoalExecutorOptions({ config, encryptionKey: new Uint8Array(32), stateRootDir: config.stateRootDir! });
    expect(() => assertWorkerOptions({ ...options.accounts[0]!.worker, appServerProcessFactory: () => { throw new Error("TEST factory"); } }))
      .toThrow("file_backend_codex_mimo_requires_app_server_goal_engine");
    expect(host.authReads).toBe(0);
    expect(host.spawn).not.toHaveBeenCalled();
  });
});
