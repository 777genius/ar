/** Pure finite reviewed configuration contracts; never launches native work. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FullNativeCase, fullNativeCase, fullReviewData } from "../../host-integration/managed-launcher/dependency-full-native-TEST.js";
const keys=["sourceBaseSha","sourceSha","sourceTree","machineId","bootId","nodeSha256","launcherSha256","moduleSha256","parentSha256","catalogSha256","outerReviewSha256","publicReviewSha256","reviewReference","systemdVersion","installedModules"];
const reviewed=()=>({...Object.fromEntries(keys.map(key=>[key,"TEST-finite-data"])),schemaVersion:2,accountName:"account-r",removalCase:"positive",restoreConsumer:"ordinary",hostTools:{}});
test("legacy case requires explicit finite reviewed schema2 selection and preserves existing default",()=>{
  assert.equal(fullNativeCase(undefined),FullNativeCase.ColdRestore);
  const original=reviewed();assert.equal(fullReviewData(original).fullCase,undefined);
  assert.equal(fullReviewData({...original,fullCase:FullNativeCase.LegacyUnverifiedR}).fullCase,FullNativeCase.LegacyUnverifiedR);
  for(const fullCase of [true,null,"legacy","legacy_unverified_r ",{},[FullNativeCase.LegacyUnverifiedR]])assert.throws(()=>fullReviewData({...original,fullCase}));
  for(const changed of [{schemaVersion:1},{removalCase:"parent_crash_h1"},{restoreConsumer:"readonly"}])assert.throws(()=>fullReviewData({...original,fullCase:FullNativeCase.LegacyUnverifiedR,...changed}));
  let calls=0;const hooked={...original};Object.defineProperty(hooked,"fullCase",{enumerable:true,get(){calls++;return FullNativeCase.LegacyUnverifiedR;}});
  assert.throws(()=>fullReviewData(hooked));assert.equal(calls,0);
});
