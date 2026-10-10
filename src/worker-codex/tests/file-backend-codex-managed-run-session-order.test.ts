import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor, SessionExecutionUseDisposition, type ManagedRunStorePort, type SessionStorePort, type SessionExecutionUse } from "@vioxen/subscription-runtime/core";
import { InMemorySessionStore } from "../../core/testing/fakes";
import { CodexJsonAgentDriver } from "../../provider-codex/codex-json-agent-driver";
import { sessionArtifactFromCodexAuthJson } from "../../provider-codex/codex-auth-json-codec";
import type { CodexExecutionEngine, CodexExecutionWaitingForInputResult } from "../../provider-codex/codex-json-execution-engine";
import { FileBackendCodexManagedRunCoordinator } from "../file-backend-codex-managed-run-recovery";
import { LocalFileManagedRunStore } from "../file-backend-codex-managed-run-store";
import { StaticRunner, codexAuthJson, waitUntil } from "./file-backend-codex-worker-test-support";
function barrier() {
  let release!:() => void; const pending = new Promise<void>(resolve => { release = resolve; });
  return {pending,release};
}
// Real driver private waiting cache + coordinator/domain ports. This creates NO original-origin/home authority.
async function fixture(mode:"failed"|"completed"|"waiting",rejectCompletion=false) {
  const root = await mkdtemp(join(tmpdir(),"managed-use-order-")), events:string[] = [], write = barrier(), persist = barrier(), exported = barrier(), complete = barrier();
  const redactor = new DefaultRedactor(), runner = new StaticRunner({exitCode:0,stdout:"",stderr:""}), clock = {now:() => new Date("2026-10-06T00:00:00Z"),monotonicMs:() => performance.now()};
  const first = sessionArtifactFromCodexAuthJson(codexAuthJson("SYNTHETIC_INITIAL_TOKEN")), next = sessionArtifactFromCodexAuthJson(codexAuthJson("SYNTHETIC_NEXT_TOKEN"));
  const waiting:CodexExecutionWaitingForInputResult = {status:"waiting_for_input",runId:"test-run",outputText:"blocked",warnings:[],
    request:{id:"request-1",kind:"missing_context",audience:"orchestrator",question:"continue"},
    resumeHandle:{providerId:"codex",runId:"test-run",workspacePath:root}};
  const engine:CodexExecutionEngine = {kind:"test-domain-engine",capabilities:{supportsStructuredOutput:true,supportsJsonEvents:true,supportsThreadResume:true,requiresSchemaFile:false},
    run:async () => waiting,resume:async () => { if (mode === "failed") throw new Error("synthetic resume failure"); return mode === "waiting" ? waiting : {outputText:"done",warnings:[]}; }};
  let driver:CodexJsonAgentDriver;
  const use:SessionExecutionUse = {complete:async () => { events.push("complete.begin"); await complete.pending;
    if (rejectCompletion) throw new Error("old-use-held"); events.push("complete.done"); return driver.retainsSessionExecutionUse(use) ? SessionExecutionUseDisposition.Retained : SessionExecutionUseDisposition.Discharged; }};
  driver = new CodexJsonAgentDriver({engine,model:"gpt-test",sessionMaterializer:{mode:"ephemeral",materialize:async input => { if (input.sessionExecutionUse !== use) throw new Error("wrong test domain use"); return {home:root,codexHome:root,env:{},sessionExecutionUse:use,
    snapshotSession:async () => next,release:async () => { events.push("materialized.release"); }}; }}});
  const memory = new InMemorySessionStore(); memory.seed({providerInstanceId:"codex:test",artifact:first});
  const sessionStore:SessionStorePort = {storeId:memory.storeId,custody:memory.custody,capabilities:memory.capabilities,read:input => memory.read(input),
    write:async input => { events.push("write.begin"); await write.pending; const result = await memory.write(input); events.push("write.done"); return result; }};
  const physical = new LocalFileManagedRunStore(join(root,"runs"),redactor);
  let seed = true;
  const managedRunStore:ManagedRunStorePort = {get:input => physical.get(input),resume:input => physical.resume(input),complete:input => physical.complete(input),fail:input => physical.fail(input),
    saveWaitingInput:async input => { if (!seed) { events.push("persist.begin"); await persist.pending; } const result = await physical.saveWaitingInput(input); if (!seed) events.push("persist.done"); return result; }};
  const coordinator = new FileBackendCodexManagedRunCoordinator({providerInstanceId:"codex:test",workerId:"worker-test",agentDriver:driver,sessionStore,managedRunStore,runner,redactor,clock,
    recordFailure:() => {},recordSuccessfulRun:() => {},exportAuthJsonFileQuietly:async () => { events.push("export.begin"); await exported.pending; events.push("export.done"); },
    runRecoveryJob:async () => { events.push("recovery"); return {outputText:"recovered",warnings:[]}; }});
  try {
    const result = await driver.runTask({session:first,sessionExecutionUse:use,task:{kind:"structured-prompt",prompt:"test waiting task"},workspace:{path:root},runner,redactor,abortSignal:new AbortController().signal});
    if (result.status !== "waiting_for_input") throw new Error("fixture did not create real driver waiting cache");
    const output = await coordinator.taskResultToOutput(result,{kind:"run",runId:waiting.runId,job:{prompt:"original test task"},attempt:1});
    if (output.status !== "waiting_for_input") throw new Error("fixture did not persist real waiting result"); seed = false; events.length = 0;
    return {events,write,persist,exported,complete,driver,resume:() => coordinator.resume({runId:output.runId,requestId:output.request.id,answer:"test answer",resumeHandle:output.resumeHandle}),
      cleanup:async () => { write.release(); persist.release(); exported.release(); complete.release(); await coordinator.cancelRetainedSessions().catch(() => undefined); await driver.dispose().catch(() => undefined); await rm(root,{recursive:true,force:true}); }};
  } catch (error) { await coordinator.cancelRetainedSessions().catch(() => undefined); await driver.dispose().catch(() => undefined); await rm(root,{recursive:true,force:true}); throw error; }
}
describe("managed resume exact-use completion ordering", () => {
  it("does not restart failed resume before old auth export and exact use completion", async () => {
    const f = await fixture("failed"); const pending = f.resume();
    try {
      await waitUntil(() => f.events.includes("write.begin")); expect(f.events).not.toContain("export.begin"); expect(f.events).not.toContain("complete.begin");
      f.write.release(); await waitUntil(() => f.events.includes("export.begin")); expect(f.events).not.toContain("recovery"); expect(f.events).not.toContain("complete.begin");
      f.exported.release(); await waitUntil(() => f.events.includes("complete.begin")); expect(f.events).not.toContain("recovery");
      f.complete.release(); await expect(pending).resolves.toMatchObject({outputText:"recovered"});
      expect(f.events).toEqual(["materialized.release","write.begin","write.done","export.begin","export.done","complete.begin","complete.done","recovery"]);
    } finally { await f.cleanup(); }
  });
  it("does not dispatch recovery when exact old-use completion rejects", async () => {
    const f = await fixture("failed",true); const pending = f.resume(); void pending.catch(() => {});
    try {
      await waitUntil(() => f.events.includes("write.begin")); f.write.release(); await waitUntil(() => f.events.includes("export.begin")); f.exported.release(); await waitUntil(() => f.events.includes("complete.begin")); f.complete.release();
      await expect(pending).rejects.toMatchObject({details:{code:"unknown_runtime_failure",sessionFinalization:"pending"}}); expect(f.events).not.toContain("complete.done"); expect(f.events).not.toContain("recovery");
    } finally { await f.cleanup(); }
  });
  it("holds auth export and use completion until resumed direct session write finishes", async () => {
    const f = await fixture("completed"); const pending = f.resume();
    try {
      await waitUntil(() => f.events.includes("write.begin")); expect(f.events).not.toContain("export.begin"); expect(f.events).not.toContain("complete.begin");
      f.write.release(); await waitUntil(() => f.events.includes("export.begin")); expect(f.events).not.toContain("complete.begin");
      f.exported.release(); await waitUntil(() => f.events.includes("complete.begin")); f.complete.release(); await expect(pending).resolves.toMatchObject({outputText:"done"});
      expect(f.events.indexOf("write.done")).toBeLessThan(f.events.indexOf("export.begin")); expect(f.events).not.toContain("recovery");
    } finally { await f.cleanup(); }
  });
  it("persists resumed waiting result before export and retaining the same use", async () => {
    const f = await fixture("waiting"); const pending = f.resume();
    try {
      await waitUntil(() => f.events.includes("persist.begin")); expect(f.events).not.toContain("export.begin"); expect(f.events).not.toContain("complete.begin");
      f.persist.release(); await waitUntil(() => f.events.includes("export.begin")); f.exported.release(); await waitUntil(() => f.events.includes("complete.begin"));
      f.complete.release(); await expect(pending).resolves.toMatchObject({status:"waiting_for_input"}); expect(f.driver.hasManagedRunSession("test-run")).toBe(true); expect(f.events).not.toContain("recovery");
    } finally { await f.cleanup(); }
  });
});
