import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor, SessionExecutionUseDisposition, type SessionExecutionUse } from "@vioxen/subscription-runtime/core";
import { InMemorySessionStore, makeFakeRuntimeDeps } from "../../core/testing";
import { CodexJsonAgentDriver } from "../../provider-codex/codex-json-agent-driver";
import { sessionArtifactFromCodexAuthJson } from "../../provider-codex/codex-auth-json-codec";
import { CodexEphemeralSessionMaterializer } from "../../provider-codex/codex-session-materializer";
import type { CodexExecutionEngine, CodexMaterializedSession } from "../../provider-codex/codex-json-execution-engine";
import { FileBackendCodexManagedRunCoordinator } from "../file-backend-codex-managed-run-recovery";
import { LocalFileManagedRunStore } from "../file-backend-codex-managed-run-store";

const auth = (token:string) => JSON.stringify({auth_mode:"chatgpt",tokens:{refresh_token:token,access_token:"SYNTHETIC_ACCESS",expiry:"2026-05-31T23:00:00Z"},last_refresh:"2026-05-31T00:00:00Z"});
const first = sessionArtifactFromCodexAuthJson(auth("SYNTHETIC_FIRST"));

// Real coordinator over the real driver: a refused resume (the engine's resume
// validation guard, nothing claimed) must leave the run's native session to its
// next legitimate resume instead of settling it as terminal or recovering beside it.
async function fixture(withUse:boolean) {
  const root = await mkdtemp(join(tmpdir(),"TEST-codex-refused-resume-")), events:string[] = [], resumed:CodexMaterializedSession[] = [];
  const physical = new CodexEphemeralSessionMaterializer(), redactor = new DefaultRedactor(), deps = makeFakeRuntimeDeps();
  let completions = 0, materialized:CodexMaterializedSession | undefined;
  const waiting = (id:string) => ({status:"waiting_for_input" as const,runId:"TEST-run",outputText:"waiting",warnings:[],request:{id,kind:"missing_context" as const,audience:"orchestrator" as const,question:"continue"},resumeHandle:{providerId:"codex",runId:"TEST-run",threadId:"TEST-thread",workspacePath:root}});
  const engine:CodexExecutionEngine = {kind:"TEST-refused-resume",capabilities:{supportsStructuredOutput:true,supportsJsonEvents:true,supportsThreadResume:true,requiresSchemaFile:false},
    run:async () => waiting("TEST-request"),
    resume:async input => { resumed.push(input.session);
      if (!input.resumeHandle.threadId) throw new Error("codex_managed_run_thread_missing");
      if (input.requestId === "TEST-stale") throw new Error("codex_managed_run_request_mismatch");
      return waiting("TEST-request-2"); }};
  const driver = new CodexJsonAgentDriver({engine,model:"gpt-test",sessionMaterializer:{mode:"ephemeral",materialize:async input => {
    const selected = await physical.materialize(input);
    materialized = {...selected,...(input.sessionExecutionUse ? {sessionExecutionUse:input.sessionExecutionUse} : {}),release:async () => { events.push("release"); await selected.release(); }};
    return materialized;
  }}});
  // Hosted use semantics: completion is Retained while the driver still holds the use.
  const use:SessionExecutionUse = {complete:async () => {
    if (driver.retainsSessionExecutionUse(use)) return SessionExecutionUseDisposition.Retained;
    completions++; return SessionExecutionUseDisposition.Discharged; }};
  const memory = new InMemorySessionStore(); memory.seed({providerInstanceId:"codex:TEST",artifact:first});
  const coordinator = new FileBackendCodexManagedRunCoordinator({providerInstanceId:"codex:TEST",workerId:"TEST-worker",agentDriver:driver,sessionStore:memory,
    managedRunStore:new LocalFileManagedRunStore(join(root,"runs"),new DefaultRedactor()),runner:deps.runner,redactor,
    clock:{now:() => new Date("2026-10-08T00:00:00Z"),monotonicMs:() => 1},recordFailure:() => {},recordSuccessfulRun:() => {},
    exportAuthJsonFileQuietly:async () => {},runRecoveryJob:async () => { events.push("recovery"); throw new Error("TEST-no-recovery"); }});
  const started = await driver.runTask({session:first,...(withUse ? {sessionExecutionUse:use} : {}),task:{kind:"structured-prompt",prompt:"TEST only"},workspace:{path:root},runner:deps.runner,redactor,abortSignal:new AbortController().signal});
  if (started.status !== "waiting_for_input") throw new Error("TEST-not-waiting");
  const output = await coordinator.taskResultToOutput(started,{kind:"run",runId:"TEST-run",job:{prompt:"TEST only"},attempt:1});
  if (output.status !== "waiting_for_input") throw new Error("TEST-not-persisted");
  return {root,events,resumed,driver,coordinator,output,get materialized() { return materialized; },get completions() { return completions; },
    cleanup:async () => { await driver.dispose().catch(() => undefined); await rm(root,{recursive:true,force:true}); }};
}

describe("a refused managed resume keeps the run's native session", () => {
  it("does not settle a stale retry as the use's terminal resume", async () => {
    const f = await fixture(true);
    try {
      await expect(f.coordinator.resume({runId:"TEST-run",requestId:"TEST-stale",answer:"TEST",resumeHandle:f.output.resumeHandle}))
        .rejects.toMatchObject({details:{rawCause:"codex_managed_run_request_mismatch"}});
      expect(f.driver.hasManagedRunSession("TEST-run")).toBe(true); expect(f.events).toEqual([]); expect(f.completions).toBe(0);
      const again = await f.coordinator.resume({runId:"TEST-run",requestId:f.output.request.id,answer:"TEST",resumeHandle:f.output.resumeHandle});
      expect(again.status).toBe("waiting_for_input"); expect(f.resumed).toHaveLength(2); expect(f.resumed[1]).toBe(f.materialized);
      await f.coordinator.cancelRetainedSessions();
      expect(f.events).toEqual(["release"]); expect(f.completions).toBe(1); await expect(f.driver.dispose()).resolves.toBeUndefined();
    } finally { await f.cleanup(); }
  }, 20000);

  it("does not recover beside the retained session after a refused handle", async () => {
    const f = await fixture(false), withoutThread = {providerId:"codex",runId:"TEST-run",workspacePath:f.root};
    try {
      await expect(f.coordinator.resume({runId:"TEST-run",requestId:f.output.request.id,answer:"TEST",resumeHandle:withoutThread}))
        .rejects.toMatchObject({details:{rawCause:"codex_managed_run_thread_missing"}});
      expect(f.events).toEqual([]); expect(f.driver.hasManagedRunSession("TEST-run")).toBe(true);
      const again = await f.coordinator.resume({runId:"TEST-run",requestId:f.output.request.id,answer:"TEST",resumeHandle:f.output.resumeHandle});
      expect(again.status).toBe("waiting_for_input"); expect(f.resumed).toHaveLength(2); expect(f.resumed[1]).toBe(f.materialized);
      await f.driver.dispose(); expect(f.events).toEqual(["release"]);
    } finally { await f.cleanup(); }
  }, 20000);
});
