import { host, local, request, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { AppServerExecutionReadiness, AppServerExecutionLifetime, CodexJsonAgentDriver, CodexModelBackend, codexMimoDefaultModel,
  type CodexAppServerProcessFactory, type AppServerExecutionReadyEvent } from "@vioxen/subscription-runtime/provider-codex";
import { ControlledPeer } from "../../provider-codex/tests/app-server/controlled-readiness-peer";
import { grantOwnedMimoWorkerLaunch, startResearchLaunch } from "../research-launch-owner";
import { bindResearchRuntime } from "../research-launch-admission";
import { researchHash, researchRead } from "../research-launch-files";
import { parseResearchOperatorRequest, researchRunConfig } from "../research-launch-contract";
import { admitHostedTestEgress } from "../hosted-test-egress-admission";
import { admitHostedReadonlyInputs } from "../hosted-readonly-admission";
import { buildCodexGoalExecutorOptions } from "../codex-goal-runner";
import { createFileBackendCodexWorkerRuntime } from "../file-backend-codex-runtime-factory";
import { assertWorkerOptions } from "../file-backend-codex-worker-options";
import { codexWorkerReportSystemPrompt } from "../codex-goal-report-schema";
import { StaticRunner, MemoryWorkerObservability } from "./file-backend-codex-worker-test-support";

// Replace only the native transport below real factory selection/admission.
// The independent peer never provides a GoalAPI completion response.
const transport = vi.hoisted(() => ({ peer: undefined as ControlledPeer | undefined,
  admittedFactory: undefined as CodexAppServerProcessFactory | undefined }));
vi.mock("../../provider-codex/app-server/adapters/egress-bound-process", () => ({
  egressBoundCodexProcessFactory: (_policy: unknown, factory: CodexAppServerProcessFactory) => {
    transport.admittedFactory = factory;
    return () => {
      if (!transport.peer) throw new Error("TEST transport missing");
      return transport.peer;
    };
  },
}));
beforeEach(() => { setupResearchFixture(); transport.peer = new ControlledPeer(); transport.admittedFactory = undefined; });
afterEach(cleanupResearchFixture);

async function containedWorker() {
  host.physicalPaths = true;
  const selected = parseResearchOperatorRequest({ ...request(), accounts: ["account-q"],
    modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, model: codexMimoDefaultModel,
    maxAccountCycles: 1, prewarmOnStart: false });
  writeFileSync(local("/TEST-operator/request.json"), JSON.stringify(selected), { mode: 0o600 });
  grantOwnedMimoWorkerLaunch(selected.jobId, selected.jobRootDir, selected.workspacePath);
  const started = startResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")));
  host.group = "/system.slice/" + started.unit; bindResearchRuntime(started.jobId, started.startId);
  const config = researchRunConfig(selected), events: AppServerExecutionReadyEvent[] = [];
  if (!config.executionEngine || !config.modelBackend || !config.sourceEnv) throw new Error("Expected explicit owned execution config");
  const identity = { jobId: selected.jobId, jobRootDir: selected.jobRootDir, workspacePath: selected.workspacePath,
    executionEngine: config.executionEngine, modelBackend: config.modelBackend, sourceEnv: config.sourceEnv };
  const policy = await admitHostedTestEgress(identity);
  const factory = admitHostedReadonlyInputs({ ...identity, providerEgressPolicy: policy });
  if (!factory || !transport.peer) throw new Error("Expected a genuine Worker factory and TEST peer");
  const lifetime = new AppServerExecutionLifetime({ deadlineEpochMs: Date.now() + 60_000, maxGoalTurns: 8,
    binding: { allocationId: started.jobId, incarnationId: started.startId }, onReadiness: event => events.push(event) });
  const options = buildCodexGoalExecutorOptions({ config, appServerProcessFactory: factory, providerEgressPolicy: policy,
    executionLifetime: lifetime, encryptionKey: new Uint8Array(32), stateRootDir: config.stateRootDir! });
  const worker = { ...options.accounts[0]!.worker, workspacePath: selected.workspacePath };
  if (!options.outputSchemas) throw new Error("Expected mandatory owned Worker report schemas");
  const runtime = createFileBackendCodexWorkerRuntime({ options: { ...worker, outputSchemas: options.outputSchemas, workspacePath: selected.workspacePath },
    workerId: "TEST-contained-worker", observability: new MemoryWorkerObservability(), redactor: new DefaultRedactor(),
    clock: { now: () => new Date(), monotonicMs: () => performance.now() } });
  const driver = runtime.agentDriver;
  if (!(driver instanceof CodexJsonAgentDriver)) throw new Error("Expected the genuine owned MiMo JSON driver");
  const credential = "/etc/subscription-runtime/secrets/shared/mimo-token-plan-api-key";
  mkdirSync(dirname(local(credential)), { recursive: true, mode: 0o700 });
  writeFileSync(local(credential), "TEST-only-mimo-credential", { mode: 0o600 });
  const run = () => driver.runTask({ session: null, task: { kind: "structured-prompt", prompt: "TEST bounded worker",
    systemPrompt: codexWorkerReportSystemPrompt, outputSchemaName: "codex-worker-report" }, workspace: { path: selected.workspacePath }, redactor: new DefaultRedactor(),
    runner: new StaticRunner({ exitCode: 0, stdout: "", stderr: "" }), abortSignal: new AbortController().signal });
  return { driver, peer: transport.peer, events, lifetime, factory, worker, run };
}

describe("genuine owned MiMo contained turn", () => {
  // RED: a completed native turn accepts an incomplete report despite its schema.
  it("rejects an actual malformed turn report without replay", async () => {
    const f = await containedWorker(), pending = f.run();
    try {
      await f.peer.initialize(); await f.peer.thread();
      const turn = await f.peer.next("turn/start");
      expect(turn.params.outputSchema).toBeNull();
      f.peer.reply(turn, { turn: { id: "TEST-invalid-turn" } });
      f.peer.stdout.emit("data", JSON.stringify({ method: "item/agentMessage/delta", params: {
        threadId: "actual-TEST-thread", turnId: "TEST-invalid-turn", delta: '{"outcome":"done"}' } }) + "\n");
      f.peer.stdout.emit("data", JSON.stringify({ method: "turn/completed", params: { threadId: "actual-TEST-thread",
        turn: { id: "TEST-invalid-turn", status: "completed" } } }) + "\n");
      expect(await pending).toMatchObject({ status: "failed", failure: { code: "provider_output_invalid" } });
      expect(f.peer.requests.filter(r => r.method === "turn/start")).toHaveLength(1);
      expect(f.peer.requests.filter(r => r.method.startsWith("thread/goal/"))).toEqual([]);
      expect(f.peer.ended).toBe(true);
    } finally { await f.driver.dispose(); }
  });

  // RED: the goal engine emits goal/set and cannot finish when native goals are disabled.
  it("selects a contained turn and reports readiness only after the actual thread", async () => {
    const f = await containedWorker(), pending = f.run();
    try {
      expect(transport.admittedFactory).toBe(f.factory);
      expect(f.worker.executionEngine).toBe("app-server");
      await f.peer.initialize();
      const thread = await f.peer.next("thread/start");
      const instructions = thread.params.developerInstructions;
      if (typeof instructions !== "string") throw new Error("Expected mandatory Worker developer instructions on the wire");
      const schemaLine = instructions.split("\n").find(line => line.startsWith("JSON schema: "));
      if (!schemaLine) throw new Error("Expected the complete Worker JSON schema in developer instructions");
      expect(JSON.parse(schemaLine.slice("JSON schema: ".length))).toEqual({
        type: "object", additionalProperties: false,
        required: ["outcome", "evidence", "blockers", "nextActionHint", "summary"],
        properties: {
          outcome: { type: "string", enum: ["done", "partial", "blocked", "failed"] },
          evidence: { type: "array", items: { type: "string" } },
          blockers: { type: "array", items: { type: "string" } },
          nextActionHint: { type: "string" }, summary: { type: "string" },
        },
      });
      expect(f.events.map(event => event.state)).toEqual([AppServerExecutionReadiness.Starting, AppServerExecutionReadiness.Initialized]);
      f.peer.reply(thread, { thread: { id: "actual-TEST-thread" } });
      const turn = await f.peer.next("turn/start");
      expect(f.events.at(-1)).toMatchObject({ state: AppServerExecutionReadiness.Ready, threadId: "actual-TEST-thread" });
      expect(turn.params.outputSchema).toBeNull();
      const report = { outcome: "blocked", evidence: ["TEST MCP work finished"], blockers: ["TEST input needed"],
        nextActionHint: "ask_user", summary: "TEST blocked" };
      f.peer.reply(turn, { turn: { id: "TEST-contained-turn" } });
      f.peer.stdout.emit("data", JSON.stringify({ method: "item/agentMessage/delta", params: {
        threadId: "actual-TEST-thread", turnId: "TEST-contained-turn", delta: JSON.stringify(report) } }) + "\n");
      f.peer.stdout.emit("data", JSON.stringify({ method: "turn/completed", params: { threadId: "actual-TEST-thread",
        turn: { id: "TEST-contained-turn", status: "completed" } } }) + "\n");
      expect(await pending).toMatchObject({ status: "completed", structuredOutput: report,
        warnings: expect.arrayContaining([expect.objectContaining({ code: "codex_app_server_output_schema_not_native" })]) });
      expect(f.peer.requests.filter(r => r.method.startsWith("thread/goal/"))).toEqual([]);
      expect(f.peer.requests.filter(r => r.method === "turn/start")).toHaveLength(1);
      expect(f.peer.requests.filter(r => r.method === "thread/start")).toHaveLength(1);
      expect(() => assertWorkerOptions({ ...f.worker, appServerProcessFactory: () => f.peer })).toThrow("file_backend_codex_mimo_requires_app_server_goal_engine");
    } finally { await f.driver.dispose(); }
    expect(host.authReads).toBe(0);
  });

  // RED: initialize success alone or a rejected thread produces false READY.
  it.each(["initialize", "thread/start"])("never reports READY after failed %s", async stage => {
    const f = await containedWorker(), pending = f.run();
    try {
      if (stage === "thread/start") await f.peer.initialize();
      f.peer.fail(await f.peer.next(stage));
      expect(await pending).toMatchObject({ status: "failed" });
      expect(f.events.some(event => event.state === AppServerExecutionReadiness.Ready)).toBe(false);
      expect(f.peer.requests.some(r => r.method === "turn/start" || r.method.startsWith("thread/goal/"))).toBe(false);
    } finally { await f.driver.dispose(); }
  });
});
