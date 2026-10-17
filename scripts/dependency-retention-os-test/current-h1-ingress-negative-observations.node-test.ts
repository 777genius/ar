/** Finite tuple/privacy DATA checks. These execute no native helper/authority. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { h1UnregisteredIngressTuples, h1StaleRevision, assertH1IngressNegativeRecord, H1IngressNegativeSite as Site, H1LiveNegativeStatus as Live, h1HistoricalDataOrigin, assertH1HistoricalDataOrigin, h1HistoricalVersionLaunch } from "./current-h1-ingress-negative-observations.js";
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
function record(){const row=(site:Site)=>({site,beforeSha256:"a".repeat(64),afterSha256:"a".repeat(64)});return {schemaVersion:2,historicalVersion:{origin:h1HistoricalDataOrigin("b".repeat(40)),site:"normal_foreground_request_denied",beforeSha256:"a".repeat(64),afterSha256:"a".repeat(64),assetsSha256:"c".repeat(64),originalLaunchSha256:"d".repeat(64),attemptedLaunchSha256:"e".repeat(64),oldBodyExecuted:false,newCreatorCount:0,restorePerformed:false},sourceSha:"b".repeat(40),jobId:"TEST-original",ingress:[row(Site.Recipe),row(Site.Cwd)],stale:row(Site.Stale),live:{status:Live.Unproved,attemptedCorrectEviction:false,busyCall:"unproved"},historicalExecutable:"not_executed",nativeAllReaders:"unproved"};}
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

test("historical version attempt changes only the actual earlier CLI member, never original namespace flags",()=>{
  const launch={command:"/TEST/runtime/toolchain/bin/node",args:["/TEST/runtime/dist/worker-codex/codex-goal-cli.js","run","--job-id","TEST-original","--output","/TEST/state/result.json"],cwd:"/TEST/workspace"};
  const original=structuredClone(launch),attempt=h1HistoricalVersionLaunch(launch,"/TEST/runtime",launch.command);
  assert.deepEqual(launch,original);assert.equal(attempt.command,original.command);assert.equal(attempt.cwd,original.cwd);assert.deepEqual(attempt.args.slice(1),original.args.slice(1));
  assert.equal(attempt.args[0],"/TEST/runtime/dist/retained-rollback/9c24f11254dceb3094556271bfab1b7fb2f439c7/codex-goal-cli.js");
  assert.throws(()=>h1HistoricalVersionLaunch({...launch,command:"/foreign/node"},"/TEST/runtime",launch.command));
  assert.throws(()=>h1HistoricalVersionLaunch({...launch,args:["/foreign/cli",...launch.args.slice(1)]},"/TEST/runtime",launch.command));
});
test("historical DATA lineage cannot borrow delivery source or upgrade compilation/execution/authority",()=>{
  const source="b".repeat(40),origin=h1HistoricalDataOrigin(source);assertH1HistoricalDataOrigin(origin,source);
  assert.equal(origin.member.bytes,28065);assert.equal(origin.member.sha256,"9d99f8b351817328c721d4d0618017bafe02777374e4cb2d28bb763f3628ee4f");
  for(const value of [{...origin,deliverySourceSha:"c".repeat(40)},{...origin,compiledByCurrentBuild:true},{...origin,oldBodyExecuted:true},{...origin,nativeQualified:true},
    {...origin,member:{...origin.member,sha256:"0".repeat(64)}},{...origin,destination:{...origin.destination,mode:0o444}},{...origin,unknownGrant:true}])assert.throws(()=>assertH1HistoricalDataOrigin(value,source));
  const v=record();for(const changed of [{oldBodyExecuted:true},{newCreatorCount:1},{restorePerformed:true},{afterSha256:"f".repeat(64)},{attemptedLaunchSha256:v.historicalVersion.originalLaunchSha256}])
    assert.throws(()=>assertH1IngressNegativeRecord({...v,historicalVersion:{...v.historicalVersion,...changed}},v.sourceSha,v.jobId));
});
