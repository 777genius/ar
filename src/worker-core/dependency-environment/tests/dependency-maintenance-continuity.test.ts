import { test } from "vitest";
import assert from "node:assert/strict";
import { claimDependencyMaintenance, releaseDependencyMaintenance } from "../application/dependency-maintenance-ownership";
import { DependencyGenerationContinuityKind } from "@vioxen/subscription-runtime/core";
import { parseDependencyOwner, type DependencyOwnerRecord } from "../domain/dependency-owner";
import type { DependencyOwnerStore } from "../ports/dependency-owner-store";

// This is the pure persistence contract, not physical host/Ready authority.
// Dropping v2 continuity during a real claim makes the first assertion fail.
const workspace = {canonicalPath:"/TEST/maintenance/workspace",dev:"1",ino:"2"};
const reference = (name:string) => ({path:`/TEST/history/${name}.json`,identity:{dev:"1",ino:name==="ready"?"3":"4"},sha256:"a".repeat(64)});
const continuity = {version:1 as const,kind:DependencyGenerationContinuityKind.RetiredReadyV1,
  operationId:"11111111-1111-1111-1111-111111111111",generation:"original-generated-output",
  readyRevision:1,unverifiedRevision:2,previousReady:reference("ready"),retiredUnverified:reference("unverified")};
const host = {installationId:"22222222-2222-2222-2222-222222222222",bootId:"33333333-3333-3333-3333-333333333333",
  runtimeSha:"b".repeat(40),inventoryDigest:"c".repeat(64),grantDigest:"d".repeat(64),supervisorId:"42:123"};
for (const version of [2,3] as const) test(`Maintenance preserves v${version} continuity through claim and idle release`,() => {
  let current:DependencyOwnerRecord = parseDependencyOwner({version,workspace,revision:4,epoch:2,owner:null,generationContinuity:continuity,
    ...(version===3 ? {custodyBinding:reference("custody")} : {}),activity:{lastEntry:{epoch:2,atMs:null},lastRelease:{epoch:2,atMs:null}}});
  const original=current;
  const store:DependencyOwnerStore = {
    read(selected) { assert.deepEqual(selected,workspace); return current; },
    compareAndSwap(selected,expected,next) {
      assert.deepEqual(selected,workspace); assert.equal(expected,current.revision);
      current=parseDependencyOwner(next); return current;
    },
  };
  const attempt=claimDependencyMaintenance(store,workspace,host,"44444444-4444-4444-4444-444444444444");
  assert.equal(current.version,version);
  assert.notEqual(current.owner,null);
  if (current.version===1) assert.fail("managed version lost");
  assert.deepEqual(current.generationContinuity,continuity);
  assert.deepEqual(current.activity,original.activity);
  if (current.version===3 && original.version===3) assert.deepEqual(current.custodyBinding,original.custodyBinding);
  releaseDependencyMaintenance(store,workspace,attempt);
  assert.equal(current.owner,null);
  assert.equal(current.revision,original.revision+2);
  if (current.version===1) assert.fail("managed version lost");
  assert.deepEqual(current.generationContinuity,continuity);
  assert.deepEqual(current.activity,original.activity);
});
