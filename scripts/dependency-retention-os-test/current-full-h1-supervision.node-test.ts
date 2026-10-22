import assert from "node:assert/strict";
import test from "node:test";
import { FullRemovalCase } from "../../host-integration/managed-launcher/dependency-full-native-TEST.js";
import { originalH1Continuation, type H1SupervisionPorts } from "./current-full-h1-supervision.js";
function fixture(){const calls:string[]=[];
  const ports:H1SupervisionPorts={ready:async()=>{calls.push("wait");await new Promise<void>(resolve=>setTimeout(resolve,1));calls.push("wait");await new Promise<void>(resolve=>setTimeout(resolve,1));calls.push("ready");},recover:async()=>{calls.push("recover");return {pid:102,code:0,signal:null};},complete:()=>{calls.push("complete");},publish:(parent,recovery)=>{assert.equal(parent,101);assert.equal(recovery,102);calls.push("publish");}};
  return {ports,calls};
}
const killed={pid:101,code:null,signal:"SIGKILL"} as const;
// Red if recovery races protected readiness or duplicate close retries a child.
test("H1 waits for delayed protected readiness and consumes exactly one continuation",async()=>{const f=fixture(),run=originalH1Continuation(FullRemovalCase.ParentCrashH1,f.ports);await run(killed);assert.deepEqual(f.calls,["wait","wait","ready","recover","complete","publish"]);await assert.rejects(run(killed));assert.equal(f.calls.filter(x=>x==="recover").length,1);});
// Red if ordinary FULL or an unverified child result enters the H1 continuation.
test("ordinary case and non SIGKILL close cannot recover",async()=>{for(const [selected,close] of [[FullRemovalCase.Positive,killed],[FullRemovalCase.ParentCrashH1,{pid:101,code:0,signal:null}]] as const){const f=fixture();await assert.rejects(originalH1Continuation(selected,f.ports)(close));assert.deepEqual(f.calls,[]);}});
test("protected readiness authentication conflict is never retried",async()=>{const f=fixture();let calls=0;const run=originalH1Continuation(FullRemovalCase.ParentCrashH1,{...f.ports,ready:()=>{calls++;throw Error("contradictory protected evidence");}});await assert.rejects(run(killed));assert.equal(calls,1);assert(!f.calls.includes("recover") && !f.calls.includes("publish"));});
test("failed recovery and incomplete protected record cannot publish",async()=>{for(const failed of [true,false]){const f=fixture();const run=originalH1Continuation(FullRemovalCase.ParentCrashH1,{...f.ports,recover:async()=>({pid:102,code:failed?1:0,signal:null}),complete:()=>{throw Error("incomplete");}});await assert.rejects(run(killed));assert(!f.calls.includes("publish"));}});
