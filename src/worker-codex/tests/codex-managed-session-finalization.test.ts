import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSubscriptionRuntime, DefaultRedactor, SessionExecutionUseDisposition, type SessionStorePort, type SessionExecutionUse } from "@vioxen/subscription-runtime/core";
import { FakeProviderSessionDriver, fakeProviderCapabilities, InMemorySessionStore, makeFakeRuntimeDeps } from "../../core/testing";
import { CodexJsonAgentDriver } from "../../provider-codex/codex-json-agent-driver";
import { sessionArtifactFromCodexAuthJson } from "../../provider-codex/codex-auth-json-codec";
import { CodexEphemeralSessionMaterializer } from "../../provider-codex/codex-session-materializer";
import type { CodexExecutionEngine, CodexMaterializedSession } from "../../provider-codex/codex-json-execution-engine";
import { FileBackendCodexManagedRunCoordinator } from "../file-backend-codex-managed-run-recovery";
import { FileBackendCodexSessionSeeder } from "../file-backend-codex-session-seeding";
import { LocalFileManagedRunStore } from "../file-backend-codex-managed-run-store";

const auth = (token:string) => JSON.stringify({auth_mode:"chatgpt",tokens:{refresh_token:token,access_token:"SYNTHETIC_ACCESS",expiry:"2026-05-31T23:00:00Z"},last_refresh:"2026-05-31T00:00:00Z"});
const first = sessionArtifactFromCodexAuthJson(auth("SYNTHETIC_FIRST"));
const next = sessionArtifactFromCodexAuthJson(auth("SYNTHETIC_NEXT"));
function barrier() { let release!:() => void; const pending = new Promise<void>(resolve => { release = resolve; }); return {pending,release}; }
class TestSessionDriver extends FakeProviderSessionDriver {
  override readonly providerId = "codex";
  override readonly capabilities = {...fakeProviderCapabilities,providerId:"codex"};
}
// Domain scheduling handles only. No original-origin/native authority is fabricated.
async function fixture(mode:"failed"|"cancelled"|"unchanged"|"waiting"|"missing") {
  const root = await mkdtemp(join(tmpdir(),"TEST-codex-finalize-")), events:string[] = [], materialized:CodexMaterializedSession[] = [];
  const redactor = new DefaultRedactor(), abort = new AbortController(), physical = new CodexEphemeralSessionMaterializer();
  let completions = 0, engineCalls = 0, home = "", failCompletion = false;
  const use:SessionExecutionUse = {complete:async () => { if (failCompletion) { failCompletion = false; throw new Error("TEST-completion-held"); }
    completions++; events.push("complete"); return SessionExecutionUseDisposition.Discharged; }};
  const engine:CodexExecutionEngine = {kind:"TEST-file-effects",capabilities:{supportsStructuredOutput:true,supportsJsonEvents:true,supportsThreadResume:true,requiresSchemaFile:false},
    run:async input => { engineCalls++; home = input.session.codexHome;
      if (mode === "waiting") return {status:"waiting_for_input",runId:"TEST-run",outputText:"waiting",warnings:[],request:{id:"TEST-request",kind:"missing_context",audience:"orchestrator",question:"continue"},resumeHandle:{providerId:"codex",runId:"TEST-run",workspacePath:root}};
      if (mode === "missing") await rm(join(home,"auth.json"));
      else if (mode !== "unchanged") await writeFile(join(home,"auth.json"),auth("SYNTHETIC_NEXT"));
      const error = new Error(mode === "cancelled" ? "codex_app_server_aborted" : "TEST-provider-failure");
      if (mode === "cancelled") abort.abort(error); throw error;
    },resume:async input => { engineCalls++; await writeFile(join(input.session.codexHome,"auth.json"),auth("SYNTHETIC_NEXT")); throw new Error("TEST-provider-failure"); }};
  const driver = new CodexJsonAgentDriver({engine,model:"gpt-test",sessionMaterializer:{mode:"ephemeral",materialize:async input => {
    const selected = await physical.materialize(input); materialized.push(selected);
    return {...selected,...(input.sessionExecutionUse ? {sessionExecutionUse:input.sessionExecutionUse} : {}),
      snapshotSession:async () => { events.push("snapshot"); return await selected.snapshotSession!(); },
      release:async () => { events.push("release"); await selected.release(); }};
  }}});
  const deps = makeFakeRuntimeDeps({provider:new TestSessionDriver()});
  const memory = new InMemorySessionStore(); memory.seed({providerInstanceId:"codex:TEST",artifact:first});
  const input = {session:first,sessionExecutionUse:use,task:{kind:"structured-prompt" as const,prompt:"TEST only"},workspace:{path:root},runner:deps.runner,redactor,abortSignal:abort.signal};
  return {root,events,driver,memory,input,use,abort,get home() {return home;},get completions() {return completions;},get engineCalls() {return engineCalls;},
    failNextCompletion:() => { failCompletion = true; },
    cleanup:async () => { await driver.dispose().catch(() => undefined); for (const selected of materialized) await selected.release(); await rm(root,{recursive:true,force:true}); }};
}

describe("post-drain TEST credential finalization", () => {
  // Old code returns failure without a snapshot, so no CAS occurs and old bytes remain.
  it.each(["failed","cancelled"] as const)("persists changed auth on %s before use completion", async mode => {
    const f = await fixture(mode), writing = barrier(), proceed = barrier();
    const store:SessionStorePort = {storeId:f.memory.storeId,custody:f.memory.custody,capabilities:f.memory.capabilities,read:input => f.memory.read(input),
      write:async input => { writing.release(); await proceed.pending; const result = await f.memory.write(input); f.events.push("write-ack"); return result; }};
    const runtime = createSubscriptionRuntime({...makeFakeRuntimeDeps({provider:new TestSessionDriver(),agent:f.driver,store}),
      sessionExecutionLifecycle:{begin:async () => f.use},workspace:{...makeFakeRuntimeDeps().workspace,create:async () => ({path:f.root})}});
    const pending = runtime.runTask({providerInstanceId:"codex:TEST",task:f.input.task,runContext:{runId:"TEST-task",attempt:1,abortSignal:f.abort.signal}});
    try {
      await Promise.race([writing.pending,pending.then(() => { throw new Error("TEST-update-not-written"); })]);
      expect(f.completions).toBe(0); expect(f.driver.sessionExecutionNeedsWriteback(f.use)).toBe(true);
      proceed.release(); const result = await pending;
      expect(result.status).toBe("failed"); if (mode === "cancelled") expect(result).toMatchObject({failure:{code:"task_cancelled"}});
      const saved = await f.memory.read({providerInstanceId:"codex:TEST",expectedProviderId:"codex",purpose:"run"});
      expect(saved?.artifact.bytes).toEqual(next.bytes); expect(f.completions).toBe(1);
      expect(f.events.indexOf("snapshot")).toBeLessThan(f.events.indexOf("release"));
      expect(f.events.indexOf("write-ack")).toBeLessThan(f.events.indexOf("complete"));
    } finally { proceed.release(); await pending.catch(() => undefined); await f.cleanup(); }
  });

  // No-input retry reuses the real driver's private terminal entry and the exact first CAS intent.
  it.each(["refused","ack-lost"] as const)("keeps the failed DTO and settles the original ordinary intent after two %s responses", async mode => {
    const f = await fixture("failed"), intents:Parameters<SessionStorePort["write"]>[0][] = []; let disposed = 0;
    const store:SessionStorePort = {storeId:f.memory.storeId,custody:f.memory.custody,capabilities:f.memory.capabilities,read:input => f.memory.read(input),
      write:async input => { intents.push(input); if (mode === "refused" && intents.length <= 2) throw new Error("TEST-CAS-refused");
        const result = await f.memory.write(input); if (mode === "ack-lost" && intents.length <= 2) throw new Error("TEST-ACK-lost"); return result; }};
    const runtime = createSubscriptionRuntime({...makeFakeRuntimeDeps({provider:new TestSessionDriver(),agent:f.driver,store}),sessionExecutionLifecycle:{begin:async () => f.use},
      workspace:{...makeFakeRuntimeDeps().workspace,create:async () => ({path:f.root,dispose:async () => { disposed++; }})}});
    try {
      const result = await runtime.runTask({providerInstanceId:"codex:TEST",task:f.input.task,runContext:{runId:"TEST-original",attempt:1,abortSignal:f.abort.signal}});
      expect(result.status).toBe("failed"); expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({code:"task_session_finalization_pending"})]));
      expect(f.completions).toBe(0); expect(disposed).toBe(0); expect(intents).toHaveLength(2);
      await expect(f.driver.dispose()).rejects.toThrow("codex_driver_owned_finalization_pending");
      await runtime.retryPendingTaskFinalizations();
      expect(intents).toHaveLength(3); expect(intents.every(intent => intent === intents[0])).toBe(true);
      const saved = await f.memory.read({providerInstanceId:"codex:TEST",purpose:"run"}); expect(saved?.generation).toBe(2); expect(saved?.artifact.bytes).toEqual(next.bytes);
      expect(f.engineCalls).toBe(1); expect(f.events.filter(event => event === "snapshot")).toHaveLength(1); expect(f.completions).toBe(1); expect(disposed).toBe(1);
      await runtime.retryPendingTaskFinalizations(); expect(intents).toHaveLength(3); await expect(f.driver.dispose()).resolves.toBeUndefined();
    } finally { await f.cleanup(); }
  });

  it("retains ordinary snapshot failure until the same private terminal entry can capture TEST bytes", async () => {
    const f = await fixture("missing"); let disposed = 0;
    const runtime = createSubscriptionRuntime({...makeFakeRuntimeDeps({provider:new TestSessionDriver(),agent:f.driver,store:f.memory}),sessionExecutionLifecycle:{begin:async () => f.use},
      workspace:{...makeFakeRuntimeDeps().workspace,create:async () => ({path:f.root,dispose:async () => { disposed++; }})}});
    try { const result = await runtime.runTask({providerInstanceId:"codex:TEST",task:f.input.task,runContext:{runId:"TEST-missing",attempt:1,abortSignal:f.abort.signal}});
      expect(result.status).toBe("failed"); expect(f.completions).toBe(0); expect(disposed).toBe(0);
      await writeFile(join(f.home,"auth.json"),auth("SYNTHETIC_NEXT")); await runtime.retryPendingTaskFinalizations();
      expect((await f.memory.read({providerInstanceId:"codex:TEST"}))?.artifact.bytes).toEqual(next.bytes);
      expect(f.engineCalls).toBe(1); expect(f.completions).toBe(1); expect(disposed).toBe(1);
    } finally { await f.cleanup(); }
  });

  it("proves unchanged failed auth without inventing a writeback", async () => {
    const f = await fixture("unchanged");
    try { const result = await f.driver.runTask(f.input); expect(result.status).toBe("failed"); expect(result).not.toHaveProperty("sessionUpdate");
      expect(f.events).toEqual(["snapshot","release"]); expect(f.driver.sessionExecutionNeedsWriteback(f.use)).toBe(false);
      await f.driver.retireTaskSession(f.use); expect(f.completions).toBe(1);
    } finally { await f.cleanup(); }
  });

  // Actual private waiting cache, actual auth file, actual idempotent store. This does not prove native root authority.
  it.each(["write","write-unknown","export","completion"] as const)("retains exact cancellation state across %s failure and retries safely", async failure => {
    const f = await fixture("waiting"), writes:string[] = [], ready = barrier(), proceed = barrier(); let failed = false, failedWrites = 0;
    const store:SessionStorePort = {storeId:f.memory.storeId,custody:f.memory.custody,capabilities:f.memory.capabilities,read:input => f.memory.read(input),
      write:async input => { writes.push(input.idempotencyKey); ready.release(); await proceed.pending;
        if (failure === "write" && failedWrites++ < 2) { throw new Error("TEST-CAS-refusal"); }
        const result = await f.memory.write(input); f.events.push(result.status);
        if (failure === "write-unknown" && failedWrites++ < 2) { throw new Error("TEST-ack-lost"); } return result; }};
    const exportPath = join(f.root,"TEST-export-auth.json"), deps = makeFakeRuntimeDeps();
    const seeder = new FileBackendCodexSessionSeeder({providerInstanceId:"codex:TEST",sessionStore:f.memory,observability:deps.observability,clock:deps.clock,
      agentId:"TEST-driver",onFailure:() => {},rememberQuotaGroup:() => {},onAuthImported:() => {}});
    await writeFile(exportPath,auth("SYNTHETIC_FIRST")); await seeder.seedAuthJsonFile(exportPath);
    const coordinator = new FileBackendCodexManagedRunCoordinator({providerInstanceId:"codex:TEST",workerId:"TEST-worker",agentDriver:f.driver,sessionStore:store,
      managedRunStore:new LocalFileManagedRunStore(join(f.root,"runs"),new DefaultRedactor()),runner:f.input.runner,redactor:f.input.redactor,
      clock:{now:() => new Date("2026-10-08T00:00:00Z"),monotonicMs:() => 1},recordFailure:() => {},recordSuccessfulRun:() => {},
      exportAuthJsonFileQuietly:async (context,requireAcknowledgement) => {
        if (failure === "export" && !failed) { failed = true; await rm(exportPath); await mkdir(exportPath); }
        await seeder.exportAuthJsonFileQuietly(context,requireAcknowledgement); f.events.push("export"); },
      runRecoveryJob:async () => { throw new Error("TEST-no-model-recovery"); }});
    try {
      expect((await f.driver.runTask(f.input)).status).toBe("waiting_for_input"); await writeFile(join(f.home,"auth.json"),auth("SYNTHETIC_NEXT"));
      if (failure === "completion") f.failNextCompletion();
      const cancelling = coordinator.cancelRetainedSessions(); void cancelling.catch(() => undefined); await ready.pending;
      expect(f.completions).toBe(0); expect(f.driver.retainedManagedRunIds()).toEqual(["TEST-run"]);
      await expect(f.driver.resumeManagedRun({...f.input,task:{},runId:"TEST-run",requestId:"TEST-request",answer:"do not execute",resumeHandle:{providerId:"codex",runId:"TEST-run",workspacePath:f.root}})).rejects.toThrow("codex_managed_run_finalization_pending");
      proceed.release(); await expect(cancelling).rejects.toThrow(); expect(f.completions).toBe(0);
      expect(f.driver.retainedManagedRunIds()).toEqual(["TEST-run"]);
      if (failure === "export") await rm(exportPath,{recursive:true});
      await coordinator.cancelRetainedSessions();
      expect(f.driver.retainedManagedRunIds()).toEqual([]); expect(f.completions).toBe(1); expect(f.engineCalls).toBe(1);
      expect(writes).toHaveLength(failure === "write" || failure === "write-unknown" ? 3 : 2); expect(new Set(writes).size).toBe(1); expect(f.events.filter(event => event === "snapshot")).toHaveLength(1);
      if (failure !== "write") expect(f.events).toContain("idempotent_replay");
      const saved = await f.memory.read({providerInstanceId:"codex:TEST",expectedProviderId:"codex",purpose:"run"}); expect(saved?.artifact.bytes).toEqual(next.bytes); expect(saved?.generation).toBe(2); expect(await readFile(exportPath,"utf8")).toBe(auth("SYNTHETIC_NEXT"));
      await expect(f.driver.cancelManagedRun({runId:"TEST-foreign",session:first,redactor:f.input.redactor})).rejects.toThrow("codex_managed_run_session_missing");
      await expect(f.driver.dispose()).resolves.toBeUndefined();
    } finally { proceed.release(); await f.cleanup(); }
  });

  it("settles the exact failed resume after two CAS uncertainties without rerunning its provider", async () => {
    const f = await fixture("waiting"), intents:Parameters<SessionStorePort["write"]>[0][] = [];
    const store:SessionStorePort = {storeId:f.memory.storeId,custody:f.memory.custody,capabilities:f.memory.capabilities,read:input => f.memory.read(input),
      write:async input => { intents.push(input); const result = await f.memory.write(input); if (intents.length <= 2) throw new Error("TEST-ACK-lost"); return result; }};
    const coordinator = new FileBackendCodexManagedRunCoordinator({providerInstanceId:"codex:TEST",workerId:"TEST-worker",agentDriver:f.driver,sessionStore:store,
      managedRunStore:new LocalFileManagedRunStore(join(f.root,"runs"),new DefaultRedactor()),runner:f.input.runner,redactor:f.input.redactor,
      clock:{now:() => new Date("2026-10-08T00:00:00Z"),monotonicMs:() => 1},recordFailure:() => {},recordSuccessfulRun:() => {},
      exportAuthJsonFileQuietly:async () => {},runRecoveryJob:async () => { throw new Error("TEST-no-provider-replay"); }});
    try { const waiting = await f.driver.runTask(f.input); if (waiting.status !== "waiting_for_input") throw new Error("TEST-not-waiting");
      const output = await coordinator.taskResultToOutput(waiting,{kind:"run",runId:"TEST-run",job:{prompt:"TEST only"},attempt:1});
      if (output.status !== "waiting_for_input") throw new Error("TEST-not-persisted");
      await expect(coordinator.resume({runId:output.runId,requestId:output.request.id,answer:"TEST",resumeHandle:output.resumeHandle})).rejects.toMatchObject({details:{code:"unknown_runtime_failure",sessionFinalization:"pending"}});
      expect(f.completions).toBe(0); expect(intents).toHaveLength(2); expect(f.driver.hasManagedRunSession("TEST-run")).toBe(false);
      await coordinator.cancelRetainedSessions(); expect(intents).toHaveLength(3); expect(new Set(intents.map(intent => intent.idempotencyKey)).size).toBe(1);
      expect(intents.every(intent => intent.nextArtifact === intents[0]?.nextArtifact && intent.expectedGeneration === 1 && intent.leaseId === intents[0]?.leaseId)).toBe(true);
      const saved = await f.memory.read({providerInstanceId:"codex:TEST"}); expect(saved?.artifact.bytes).toEqual(next.bytes); expect(saved?.generation).toBe(2);
      expect(f.engineCalls).toBe(2); expect(f.events.filter(event => event === "snapshot")).toHaveLength(1); expect(f.completions).toBe(1);
      await coordinator.cancelRetainedSessions(); expect(intents).toHaveLength(3); await expect(f.driver.dispose()).resolves.toBeUndefined();
    } finally { await f.cleanup(); }
  });

  it("settles unchanged cancellation without a credential write", async () => {
    const f = await fixture("waiting");
    try { await f.driver.runTask(f.input);
      const result = await f.driver.cancelManagedRun({runId:"TEST-run",session:first,redactor:f.input.redactor});
      expect(result.status).toBe("failed"); expect(result).not.toHaveProperty("sessionUpdate");
      expect(f.driver.sessionExecutionNeedsWriteback(f.use)).toBe(false); expect(f.events).toEqual(["snapshot","release"]);
      await f.driver.completeManagedRunCancellation("TEST-run"); expect(f.completions).toBe(1); expect(f.engineCalls).toBe(1);
      expect(f.driver.retainedManagedRunIds()).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("retains a missing TEST snapshot and captures it on the same cancellation retry", async () => {
    const f = await fixture("waiting");
    try { await f.driver.runTask(f.input); await rm(join(f.home,"auth.json"));
      await expect(f.driver.cancelManagedRun({runId:"TEST-run",session:first,redactor:f.input.redactor})).rejects.toThrow("codex_session_finalization_unresolved");
      expect(f.events).toEqual(["snapshot"]); expect(f.completions).toBe(0); expect(f.driver.retainedManagedRunIds()).toEqual(["TEST-run"]);
      await writeFile(join(f.home,"auth.json"),auth("SYNTHETIC_FIRST"));
      const result = await f.driver.cancelManagedRun({runId:"TEST-run",session:first,redactor:f.input.redactor});
      expect(result).not.toHaveProperty("sessionUpdate"); await f.driver.completeManagedRunCancellation("TEST-run");
      expect(f.completions).toBe(1); expect(f.engineCalls).toBe(1); expect(f.events.filter(event => event === "release")).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  it("keeps the actual TEST auth file until cancellation capture succeeds", async () => {
    const f = await fixture("waiting");
    try { await f.driver.runTask(f.input); await writeFile(join(f.home,"auth.json"),auth("SYNTHETIC_NEXT"));
      await expect(f.driver.cancelManagedRun({runId:"TEST-run",session:next,redactor:f.input.redactor})).rejects.toThrow("codex_managed_run_session_mismatch");
      expect(await readFile(join(f.home,"auth.json"),"utf8")).toBe(auth("SYNTHETIC_NEXT")); expect(f.driver.retainedManagedRunIds()).toEqual(["TEST-run"]);
      expect(f.completions).toBe(0); expect(f.events).toEqual([]);
    } finally { await f.cleanup(); }
  });
});
