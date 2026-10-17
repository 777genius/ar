import assert from "node:assert/strict";
import { test } from "vitest";
import { collectHostedOrdinaryReaderParentCompletion, readHostedOrdinaryReaderParentCompletion } from "../hosted-ordinary-reader-parent-completion";
import { HostedOrdinaryParentRecordKind, readHostedOrdinaryParentRecord } from "../hosted-ordinary-parent-record-facts";
import { assertHostedForegroundResultForChild } from "../../provider-codex/app-server/adapters/hosted-fd-launch";
// A forged DTO or facade must not select a protected path or invoke any field
// getter. No positive fixture issues a root origin, FDA result or native proof.
test("unissued FDA result is refused before caller field access",()=>{
  let reads=0;const fake=new Proxy({}, {get(){reads++;throw new Error("field accessed");}});
  assert.throws(()=>collectHostedOrdinaryReaderParentCompletion(Object.freeze({held:true}),fake as never),/hosted_fd_boundary_unresolved/);
  assert.throws(()=>assertHostedForegroundResultForChild(fake as never,fake as never),/hosted_fd_boundary_unresolved/);
  assert.equal(reads,0);
});
test("unissued fence is refused before fixed historical record selection",()=>{
  const id="11111111-1111-1111-1111-111111111111";
  assert.throws(()=>readHostedOrdinaryReaderParentCompletion(Object.freeze({held:true}),id,"a".repeat(64)),/hosted_custody_common_fence_required/);
  assert.throws(()=>readHostedOrdinaryParentRecord(Object.freeze({held:true}),HostedOrdinaryParentRecordKind.Completion,id),/hosted_custody_common_fence_required/);
});
