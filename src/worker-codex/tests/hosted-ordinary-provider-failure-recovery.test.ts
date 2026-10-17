import assert from "node:assert/strict";
import { it as test } from "vitest";
import { parseHostedOrdinaryProviderFailureReceipt, assertHostedOrdinaryProviderFailureCreator } from "../hosted-ordinary-provider-failure-recovery";
import { HostedManagedProviderWaitKind, HostedManagedProviderResult } from "../hosted-managed-provider-terminal-facts";
const root="/var/lib/subscription-runtime-host-policy",parent="11111111-1111-1111-1111-111111111111",provider="22222222-2222-2222-2222-222222222222";
const reference=(path:string)=>({path,identity:{dev:"1",ino:"2"},sha256:"a".repeat(64)});
const receipt=()=>({schemaVersion:2,parentAttempt:{attemptId:"33333333-3333-3333-3333-333333333333",epoch:3,
  launch:{installationId:"44444444-4444-4444-4444-444444444444",bootId:"55555555-5555-5555-5555-555555555555",runtimeSha:"b".repeat(40),grantDigest:"c".repeat(64),startId:parent,unit:`subscription-runtime-ordinary-${parent}.service`}},
  unit:`subscription-runtime-hosted-${provider}.service`,providerStartId:provider,
  providerReference:reference(`${root}/dependency-managed-provider-starts/${provider}.json`),
  ordinaryProviderReference:reference(`${root}/ordinary-starts/${provider}.json`),parentReference:reference(`${root}/ordinary-starts/${parent}.json`),
  relation:{version:1,parentStartId:parent,attemptId:"33333333-3333-3333-3333-333333333333",epoch:3,providerStartId:provider,startDigest:"a".repeat(64),unit:`subscription-runtime-hosted-${provider}.service`},
  invocationId:"d".repeat(32),proxyBirth:"123:456",waitStatus:143,
  home:{canonicalPath:"/jobs/test/home/codex-session-cache/dependency-33333333-3333-3333-3333-333333333333",dev:"1",ino:"9",mountId:"2"},
  use:{accountId:"test-account",restoredHash:"e".repeat(64)},
  terminal:{unit:`subscription-runtime-hosted-${provider}.service`,invocationId:"d".repeat(32),kind:HostedManagedProviderWaitKind.Exited,status:143,result:HostedManagedProviderResult.ExitCode}});
const bytes=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
// Old zero-only fencing cannot represent these truthful failed child outcomes.
// This is codec evidence only; no parsed fixture acquires a root purpose/fence.
test("C failed-provider codec preserves exact native nonzero and v255 signal mapping",()=>{
  const exited=receipt();assert.equal(parseHostedOrdinaryProviderFailureReceipt(bytes(exited)).waitStatus,143);
  const killed=receipt();killed.waitStatus=255;killed.terminal.kind=HostedManagedProviderWaitKind.Killed;killed.terminal.status=15;killed.terminal.result=HostedManagedProviderResult.Signal;
  assert.equal(parseHostedOrdinaryProviderFailureReceipt(bytes(killed)).terminal.status,15);
  killed.waitStatus=143;assert.throws(()=>parseHostedOrdinaryProviderFailureReceipt(bytes(killed)));
});
test("C failed-provider codec refuses foreign row, attempt, reference and unknown wait",()=>{
  const row=receipt();row.relation.providerStartId=parent;assert.throws(()=>parseHostedOrdinaryProviderFailureReceipt(bytes(row)));
  const attempt=receipt();attempt.relation.epoch++;assert.throws(()=>parseHostedOrdinaryProviderFailureReceipt(bytes(attempt)));
  const reference=receipt();reference.providerReference.path=`${root}/dependency-managed-provider-starts/${parent}.json`;assert.throws(()=>parseHostedOrdinaryProviderFailureReceipt(bytes(reference)));
  const invocation=receipt();invocation.terminal.invocationId="f".repeat(32);assert.throws(()=>parseHostedOrdinaryProviderFailureReceipt(bytes(invocation)));
  const zero=receipt();zero.waitStatus=0;assert.throws(()=>parseHostedOrdinaryProviderFailureReceipt(bytes(zero)));
  assert.throws(()=>parseHostedOrdinaryProviderFailureReceipt(bytes({...receipt(),terminal:null})));
  assert.throws(()=>parseHostedOrdinaryProviderFailureReceipt(bytes({...receipt(),schemaVersion:1})));
  assert.throws(()=>parseHostedOrdinaryProviderFailureReceipt(bytes({...receipt(),extra:true})));
});
test("creator reader refuses unissued fence before any protected path selection",()=>{
  assert.throws(()=>assertHostedOrdinaryProviderFailureCreator(Object.freeze({held:true}),provider,"a".repeat(64)),/hosted_custody_common_fence_required/);
});
