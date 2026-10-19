import assert from "node:assert/strict";
import test from "node:test";
import {hostedFdNamespacePrefix,hostedFdNamespaceStage,assertHostedFdNamespaceAncestry,type HostedFdNamespaceProcess} from "../../../../dist/provider-codex/app-server/adapters/hosted-fd-namespace-stages.js";

// These exercise factual recipe validation only. No supplied facts can enter
// the original child or original parent WeakMaps or become a custody grant.
const argv=[...hostedFdNamespacePrefix,"/trusted/node","/trusted/bootstrap.js","--fd-ready-v1"];
const stage=(at:number,pid:number,parentPid:number):HostedFdNamespaceProcess=>({pid,parentPid,exe:argv[at]!,argv:argv.slice(at)});
test("repeated unshare has two exact finite positions",()=>{
  assert.equal(hostedFdNamespaceStage(argv,stage(0,70,1)),0);
  assert.equal(hostedFdNamespaceStage(argv,stage(7,71,70)),7);
  assert.equal(hostedFdNamespaceStage(argv,stage(13,72,71)),13);
  assert.equal(hostedFdNamespaceStage(argv,stage(18,73,70)),18);
});
test("actual MainPID must be outer setup and ancestors advance through fixed stages",()=>{
  const processes=[stage(0,70,1),stage(18,73,70),{pid:74,parentPid:73,exe:argv[20]!,argv:argv.slice(20)}];
  assert.doesNotThrow(()=>assertHostedFdNamespaceAncestry(argv,processes,70));
  assert.throws(()=>assertHostedFdNamespaceAncestry(argv,processes,73));
  assert.throws(()=>assertHostedFdNamespaceAncestry(argv,[stage(0,70,1),stage(18,73,99)],70));
});
test("a trusted executable basename or repeated argv suffix does not select a role",()=>{
  assert.throws(()=>hostedFdNamespaceStage(argv,{exe:"/usr/bin/unshare",argv:["/usr/bin/unshare","--user"]}));
  assert.throws(()=>hostedFdNamespaceStage([...argv,"/usr/bin/unshare"],{exe:"/usr/bin/unshare",argv:["/usr/bin/unshare"]}));
  assert.throws(()=>hostedFdNamespaceStage(argv,{exe:"/foreign/unshare",argv:argv.slice(7)}));
});
test("reversed user/mount creation, repeated stages and cyclic parent trees refuse",()=>{
  const reversed=[...argv];reversed[1]="--user";assert.throws(()=>assertHostedFdNamespaceAncestry(reversed,[stage(0,70,1)],70));
  assert.throws(()=>assertHostedFdNamespaceAncestry(argv,[stage(0,70,1),stage(18,73,70),stage(18,75,70)],70));
  assert.throws(()=>assertHostedFdNamespaceAncestry(argv,[stage(0,70,1),stage(7,71,73),stage(18,73,71)],70));
});
