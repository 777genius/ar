/** A malformed/duplicate or foreign unit must never inflate a native count. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeInstallerUnitState, parseNativeInstallerUnit, retainedInstallerStartsComplete, selectNativeInstallerWorkspace, NativeInstallerWorkspaceSelection } from "./native-installer-observations.js";
const unit = "subscription-runtime-installer-12345678-1234-1234-1234-123456789abc.service";
const id = "0123456789abcdef0123456789abcdef";
const show = `Id=${unit}\nLoadState=loaded\nActiveState=active\nInvocationID=${id}\n`;
test("native measurement requires exactly one matching unit and one complete invocation", () => {
  assert.deepEqual(parseNativeInstallerUnit(unit,show),{state:NativeInstallerUnitState.Observed,invocationId:id});
  for (const text of [show + "InvocationID=" + id + "\n",show.replace(unit,"other.service"),show.replace(id,"TEST-private-secret"),
    show + "Environment=TEST-private-secret\n",show.replace("InvocationID=" + id + "\n","")]) {
    const observed = parseNativeInstallerUnit(unit,text);
    assert.deepEqual(observed,{state:NativeInstallerUnitState.Unknown,invocationId:null});
    assert(!JSON.stringify(observed).includes("TEST-private-secret"));
  }
});
test("missing or prepared-before-invocation is not a launched install", () => {
  assert.deepEqual(parseNativeInstallerUnit(unit,`Id=${unit}\nLoadState=not-found\nActiveState=inactive\nInvocationID=\n`),
    {state:NativeInstallerUnitState.Missing,invocationId:null});
  assert.deepEqual(parseNativeInstallerUnit(unit,`Id=${unit}\nLoadState=loaded\nActiveState=activating\nInvocationID=\n`),
    {state:NativeInstallerUnitState.Pending,invocationId:null});
});

test("seen protected starts cannot disappear before native observation or change physical record", () => {
  const hash = "a".repeat(64), seen = new Map([["start",hash]]);
  const complete = [{startId:"start",startSha256:hash,complete:true}], native = new Set(["start"]);
  assert.equal(retainedInstallerStartsComplete(seen,complete,native,false),true);
  assert.equal(retainedInstallerStartsComplete(seen,[],new Set(),false),false);
  assert.equal(retainedInstallerStartsComplete(seen,complete,new Set(),false),false);
  assert.equal(retainedInstallerStartsComplete(seen,[{...complete[0]!,startSha256:"b".repeat(64)}],native,false),false);
  assert.equal(retainedInstallerStartsComplete(seen,[{...complete[0]!,complete:false}],native,false),false);
});

test("an unreadable transient prefix cannot disappear into an empty measured history", () => {
  assert.equal(retainedInstallerStartsComplete(new Map(),[],new Set(),false),true);
  assert.equal(retainedInstallerStartsComplete(new Map(),[],new Set(),true),false);
});

test("physical selection ignores insertion order but refuses malformed or conflicting identities", () => {
  const own = {canonicalPath:"/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-C/workspace",dev:"123",ino:"456"};
  assert.equal(selectNativeInstallerWorkspace({ino:own.ino,dev:own.dev,canonicalPath:own.canonicalPath},own),NativeInstallerWorkspaceSelection.Selected);
  assert.equal(selectNativeInstallerWorkspace({...own,extra:"TEST-private"},own),NativeInstallerWorkspaceSelection.Unknown);
  assert.equal(selectNativeInstallerWorkspace({...own,canonicalPath:own.canonicalPath.replace("TEST-C","TEST-ref")},own),NativeInstallerWorkspaceSelection.Unknown);
  assert.equal(selectNativeInstallerWorkspace({...own,ino:"789"},own),NativeInstallerWorkspaceSelection.Unknown);
  assert.equal(selectNativeInstallerWorkspace({...own,canonicalPath:own.canonicalPath.replace("TEST-C","TEST-ref"),ino:"789"},own),NativeInstallerWorkspaceSelection.Foreign);
  let calls = 0;
  const accessor = {dev:own.dev,ino:own.ino,get canonicalPath(){calls++;return "TEST-private";}};
  assert.equal(selectNativeInstallerWorkspace(accessor,own),NativeInstallerWorkspaceSelection.Unknown);
  const proxy = new Proxy(own,{ownKeys(){calls++;return Reflect.ownKeys(own);}});
  assert.equal(selectNativeInstallerWorkspace(proxy,own),NativeInstallerWorkspaceSelection.Unknown);
  const revoked = Proxy.revocable(own,{}); revoked.revoke();
  assert.equal(selectNativeInstallerWorkspace(revoked.proxy,own),NativeInstallerWorkspaceSelection.Unknown);
  assert.equal(calls,0);
});
