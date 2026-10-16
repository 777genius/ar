/** Finite tuple/privacy DATA checks. These execute no native helper/authority. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { h1UnregisteredIngressTuples, h1StaleRevision, assertH1IngressNegativeRecord, H1IngressNegativeSite as Site, H1LiveNegativeStatus as Live } from "./current-h1-ingress-negative-observations.js";
test("H1 invalid ingress changes only the fixed unregistered suffix or cwd",()=>{
  const launch={command:"/TEST/node",args:["/TEST/cli","--job-id","TEST-original"],cwd:"/TEST/workspace"};
  const before=structuredClone(launch),[recipe,cwd]=h1UnregisteredIngressTuples(launch);assert.deepEqual(launch,before);
  assert.deepEqual(recipe,{site:Site.Recipe,...launch,args:[...launch.args,"--TEST-unregistered-rollback"]});
  assert.deepEqual(cwd,{site:Site.Cwd,...launch,cwd:launch.cwd+"/packages/live"});
  assert(!("correlation" in recipe!) && !("request" in cwd!));
});
test("stale selection keeps a safe adjacent revision and refuses overflow",()=>{
  assert.equal(h1StaleRevision(12),13);for(const n of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER])assert.throws(()=>h1StaleRevision(n));
});
function record(){const row=(site:Site)=>({site,beforeSha256:"a".repeat(64),afterSha256:"a".repeat(64)});return {schemaVersion:1,sourceSha:"b".repeat(40),jobId:"TEST-original",ingress:[row(Site.Recipe),row(Site.Cwd)],stale:row(Site.Stale),live:{status:Live.Unproved,attemptedCorrectEviction:false,busyCall:"unproved"},historicalExecutable:"not_executed",nativeAllReaders:"unproved"};}
test("factual H1 checkpoint cannot upgrade unobserved live/native/historical outcomes",()=>{
  const v=record();assertH1IngressNegativeRecord(v,v.sourceSha,v.jobId);
  for(const change of [{nativeAllReaders:"proven"},{historicalExecutable:"executed"},{live:{...v.live,busyCall:"passed"}},{live:{...v.live,attemptedCorrectEviction:true}},{privateError:"not allowed"}])assert.throws(()=>assertH1IngressNegativeRecord({...v,...change},v.sourceSha,v.jobId));
  assert.throws(()=>assertH1IngressNegativeRecord(v,"c".repeat(40),v.jobId));
  assert.throws(()=>assertH1IngressNegativeRecord({...v,stale:{...v.stale,afterSha256:"d".repeat(64)}},v.sourceSha,v.jobId));
});
test("observed physical owner still explicitly leaves actual Busy call unproved",()=>{
  const v=record(),live={status:Live.Observed,attemptedCorrectEviction:false,busyCall:"unproved",startId:"00000000-0000-4000-8000-000000000001",ownerSha256:"c".repeat(64),startSha256:"d".repeat(64),nativeSha256:"e".repeat(64)};
  assertH1IngressNegativeRecord({...v,live},v.sourceSha,v.jobId);
  assert.throws(()=>assertH1IngressNegativeRecord({...v,live:{...live,nativeSha256:null}},v.sourceSha,v.jobId));
  assert.throws(()=>assertH1IngressNegativeRecord({...v,live:{...live,pid:123}},v.sourceSha,v.jobId));
});
