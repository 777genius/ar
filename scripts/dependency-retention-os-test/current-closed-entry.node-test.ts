/** Independent relation regression: replacement/later release cannot reuse old completion. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { DependencyOwnerRecord } from "../../dist/core/dependency-environment/dependency-owner.js";
import type { HostedDependencyBinding } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { currentIdleClosureMatches } from "./current-closed-entry.js";
const startId = "11111111-1111-4111-8111-111111111111";
const workspace = {canonicalPath:"/TEST/workspace",dev:"1",ino:"2"};
const binding: HostedDependencyBinding = {version:1,jobId:"TEST-data",jobRootDir:"/TEST",workspace,
  installationId:startId,runtimeSha:"a".repeat(40),grantDigest:"b".repeat(64)};
const owner: DependencyOwnerRecord = {version:1,workspace,revision:8,epoch:2,owner:null};
const closure = {path:"/TEST/source-closed",identity:{dev:"1",ino:"3"},sha256:"c".repeat(64)};
const idle = {version:1,binding,attempt:{attemptId:startId,epoch:2,launch:{installationId:binding.installationId,
  bootId:startId,runtimeSha:binding.runtimeSha,grantDigest:binding.grantDigest,startId,unit:"TEST.service"}},
  previousOwnerSha256:"d".repeat(64),releasedOwner:owner,
  releasedOwnerSha256:createHash("sha256").update(JSON.stringify(owner)+"\n").digest("hex"),sourceClosed:closure};
test("only exact current released-owner and sealed source identity reconcile", () => {
  // Pure DATA relation, never a positive launch/release/native receipt.
  assert.equal(currentIdleClosureMatches(owner,binding,idle,closure,startId),true);
  assert.equal(currentIdleClosureMatches(owner,binding,idle,{...closure,sha256:"e".repeat(64)},startId),false);
  assert.equal(currentIdleClosureMatches({...owner,revision:9},binding,idle,closure,startId),false);
  const nextStart = "22222222-2222-4222-8222-222222222222";
  assert.equal(currentIdleClosureMatches(owner,binding,{...idle,attempt:{...idle.attempt,launch:{...idle.attempt.launch,startId:nextStart}}},closure,startId),false);
});
