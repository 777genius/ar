import { describe, expect, it } from "vitest";
import { createSubscriptionRuntime, type AgentDriver, type LeaseStorePort, type SessionStorePort } from "../index";
import { SessionExecutionUseDisposition, type SessionExecutionLifecyclePort } from "../ports/session-execution-lifecycle";
import { FakeAgentDriver, FakeProviderSessionDriver, InMemorySessionStore, makeFakeArtifact, makeFakeRuntimeDeps } from "../testing";

const runContext = () => ({runId:"lifecycle-test",attempt:1,abortSignal:new AbortController().signal});
function seed() {
  const store = new InMemorySessionStore();
  store.seed({providerInstanceId:"account-a",artifact:makeFakeArtifact("session-v1")}); return store;
}
function lifecycle(events:string[], complete:() => Promise<void> = async () => {}) : SessionExecutionLifecyclePort {
  return {begin:async () => { events.push("begin"); return {complete:async () => {
    await complete(); events.push("complete"); return SessionExecutionUseDisposition.Discharged;
  }}; }};
}
function recordedLease(store:LeaseStorePort, events:string[]):LeaseStorePort {
  return {...store,leaseStoreId:store.leaseStoreId,capabilities:store.capabilities,
    acquire:async input => { events.push("acquire"); return await store.acquire(input); },
    finalize:async input => { events.push("finalize"); return await store.finalize(input); },
    markWritebackStarted:async input => { events.push("writeback-start"); await store.markWritebackStarted(input); },
    markWritebackCommitted:async input => { const result = await store.markWritebackCommitted(input); events.push("commit"); return result; },
    release:async input => { await store.release?.(input); events.push("release"); },
  };
}

describe("core session execution lifetime", () => {
  // Regresses if shared-home scheduling completes before the owning credential transition.
  it("completes refresh after its actual commit and workspace disposal", async () => {
    const events:string[] = [], deps = makeFakeRuntimeDeps({store:seed()});
    const runtime = createSubscriptionRuntime({...deps,leaseStore:recordedLease(deps.leaseStore!,events),
      sessionExecutionLifecycle:lifecycle(events),workspace:{...deps.workspace,create:async () => ({path:"/tmp/lifecycle-test",dispose:async () => { events.push("dispose"); }})}});
    const result = await runtime.refreshSession({providerInstanceId:"account-a",runContext:runContext()});
    expect(result.status).toBe("ready");
    expect(events).toEqual(["begin","acquire","finalize","writeback-start","commit","dispose","complete"]);
  });

  it("completes a failed refresh only after the owning lease release", async () => {
    const events:string[] = [], provider = new FakeProviderSessionDriver(); provider.refreshedState = "needs-reconnect";
    const deps = makeFakeRuntimeDeps({store:seed(),provider});
    const runtime = createSubscriptionRuntime({...deps,leaseStore:recordedLease(deps.leaseStore!,events),sessionExecutionLifecycle:lifecycle(events)});
    const result = await runtime.refreshSession({providerInstanceId:"account-a",runContext:runContext()});
    expect(result.status).toBe("blocked"); expect(events).toEqual(["begin","acquire","release","complete"]);
  });

  it.each([false,true])("completes a task without inventing a credential lease (failure=%s)", async failed => {
    const events:string[] = [], baseAgent = new FakeAgentDriver();
    const agent:AgentDriver = {...baseAgent,agentId:baseAgent.agentId,providerId:baseAgent.providerId,capabilities:baseAgent.capabilities,
      classifyRunFailure:() => baseAgent.classifyRunFailure(),runTask:async input => {
        events.push("agent"); if (failed) throw new Error("domain-task-failure"); return await baseAgent.runTask(input);
      }};
    const deps = makeFakeRuntimeDeps({store:seed(),agent});
    const runtime = createSubscriptionRuntime({...deps,leaseStore:recordedLease(deps.leaseStore!,events),sessionExecutionLifecycle:lifecycle(events)});
    if (failed) await expect(runtime.runTask({providerInstanceId:"account-a",task:{kind:"review",prompt:"test"},runContext:runContext()})).rejects.toThrow("domain-task-failure");
    else expect((await runtime.runTask({providerInstanceId:"account-a",task:{kind:"review",prompt:"test"},runContext:runContext()})).status).toBe("completed");
    expect(events).toEqual(["begin","agent","complete"]);
  });

  // The old return-Promise/finally ordering disposes and completes while this write is pending.
  it("awaits task writeback before disposal and completion", async () => {
    const events:string[] = [], physical = seed(); let unblock!:() => void, entered!:() => void;
    const pending = new Promise<void>(resolve => { unblock = resolve; }), writing = new Promise<void>(resolve => { entered = resolve; });
    const store:SessionStorePort = {storeId:physical.storeId,custody:physical.custody,capabilities:physical.capabilities,
      read:input => physical.read(input),write:async input => {
        events.push("write-pending"); entered(); await pending; const result = await physical.write(input); events.push("write-done"); return result;
      }};
    const baseAgent = new FakeAgentDriver();
    const agent:AgentDriver = {agentId:baseAgent.agentId,providerId:baseAgent.providerId,capabilities:baseAgent.capabilities,
      classifyRunFailure:() => baseAgent.classifyRunFailure(),runTask:async input => ({...await baseAgent.runTask(input),sessionUpdate:makeFakeArtifact("session-next")})};
    const deps = makeFakeRuntimeDeps({store,agent});
    const runtime = createSubscriptionRuntime({...deps,sessionExecutionLifecycle:lifecycle(events),
      workspace:{...deps.workspace,create:async () => ({path:"/tmp/lifecycle-test",dispose:async () => { events.push("dispose"); }})}});
    const result = runtime.runTask({providerInstanceId:"account-a",task:{kind:"review",prompt:"test"},runContext:runContext()});
    await writing; expect(events).toEqual(["begin","write-pending"]); unblock();
    expect((await result).status).toBe("completed"); expect(events).toEqual(["begin","write-pending","write-done","dispose","complete"]);
  });

  it("does not report a discharged use when the adapter refuses completion", async () => {
    const events:string[] = [], deps = makeFakeRuntimeDeps({store:seed()});
    const runtime = createSubscriptionRuntime({...deps,sessionExecutionLifecycle:lifecycle(events,async () => { throw new Error("actual-drain-held"); })});
    await expect(runtime.runTask({providerInstanceId:"account-a",task:{kind:"review",prompt:"test"},runContext:runContext()})).rejects.toThrow("actual-drain-held");
    expect(events).toEqual(["begin"]);
  });
});
