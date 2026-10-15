import assert from "node:assert/strict";
import test from "node:test";
import { readHostedFdUnitPolicy, assertHostedFdUnitPolicy, sameHostedFdUnitLifecycle, HostedFdPolicySelectionKind } from "./hosted-fd-unit-policy.ts";
import { decodeHostedFdUnitLifecycle } from "./hosted-fd-unit-lifecycle.ts";
const rows=new Map(Object.entries({Type:"exec",ExitType:"main",RemainAfterExit:"no",KillMode:"control-group",SendSIGKILL:"yes",
  Restart:"no",Delegate:"no",ProtectControlGroups:"yes",TimeoutStopUSec:"30s",KillSignal:"15",FinalKillSignal:"9"}));
const actual=decodeHostedFdUnitLifecycle(rows);
const options=["--service-type=exec","--property=KillMode=control-group","--property=ProtectControlGroups=yes","--property=TimeoutStopSec=30s","--"];
test("original selected values normalize precisely and preserve manager omissions",()=>{
  const policy=readHostedFdUnitPolicy(options);assertHostedFdUnitPolicy(policy,actual);
  assert.equal(policy.TimeoutStopUSec.kind,HostedFdPolicySelectionKind.Explicit);
  assert.deepEqual(policy.Restart,{kind:HostedFdPolicySelectionKind.Absent});
  assert(Object.isFrozen(policy));assert(Object.values(policy).every(Object.isFrozen));
  const timed=readHostedFdUnitPolicy(["--service-type=exec","--property=TimeoutStopSec=0.001","--"]);
  assertHostedFdUnitPolicy(timed,{...actual,TimeoutStopUSec:"1000"});
  assert.throws(()=>assertHostedFdUnitPolicy(timed,actual));
});
test("selected protection and variable source stop budget must match actual facts",()=>{
  const policy=readHostedFdUnitPolicy(options);
  for(const changed of [{...actual,ProtectControlGroups:"no" as const},{...actual,TimeoutStopUSec:"29999999"}])assert.throws(()=>assertHostedFdUnitPolicy(policy,changed));
  const installer=readHostedFdUnitPolicy(["--service-type=exec","--property=ProtectControlGroups=no","--property=TimeoutStopSec=12.345","--"]);
  assertHostedFdUnitPolicy(installer,{...actual,ProtectControlGroups:"no",TimeoutStopUSec:"12345000"});
});
test("legacy absence never becomes a selected default and exact observed policy must rejoin",()=>{
  const legacy=readHostedFdUnitPolicy(["--service-type=exec","--"]);
  assert.deepEqual(legacy.TimeoutStopUSec,{kind:HostedFdPolicySelectionKind.Absent});
  assert.deepEqual(legacy.ProtectControlGroups,{kind:HostedFdPolicySelectionKind.Absent});
  assertHostedFdUnitPolicy(legacy,actual);
  for(const key of Object.keys(actual))assert.equal(sameHostedFdUnitLifecycle(actual,{...actual,[key]:"foreign"}),false);
  assert(sameHostedFdUnitLifecycle(actual,{...actual}));
});
test("duplicates, alias collisions and invalid stop selections refuse before submit",()=>{
  for(const args of [["--service-type=exec","--property=Type=exec","--"],["--property=TimeoutStopSec=30","--property=TimeoutStopUSec=30","--"],
    ["--property=ProtectControlGroups=yes","--property=ProtectControlGroups=yes","--"],...["infinity","0","-1","0.0000001","18446744073709.551615"].map(value=>["--property=TimeoutStopSec="+value,"--"]),[]])assert.throws(()=>readHostedFdUnitPolicy(args));
  const policy=readHostedFdUnitPolicy(["--", "--property=ProtectControlGroups=no"]);
  assert.equal(policy.ProtectControlGroups.kind,HostedFdPolicySelectionKind.Absent);
});
