/** Portable DATA regressions, never native admission or provider execution. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPositiveAcceptanceRoster, PositiveAcceptanceRole as Role, positiveAcceptanceRemaining, positiveAcceptanceAdmissionRemaining,
  type PositiveAcceptanceMember, type PositiveAcceptanceCreator } from "./current-positive-acceptance-roster.js";
function fixture() {
  const members:PositiveAcceptanceMember[]=[Role.PrimaryLegacy,Role.PrimaryReference,Role.AuxiliaryLegacyC,Role.AuxiliaryReference].map((role,index)=>{
    const jobId="TEST-os-00000000-0000-4000-8000-"+(index+1).toString().padStart(12,"0"),jobRoot="/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/"+jobId;
    return {role,jobId,jobRoot,workspace:jobRoot+"/workspace"};
  });
  const creators:PositiveAcceptanceCreator[]=members.map(row=>({creatorId:row.jobId,jobId:row.jobId,jobRootDir:row.jobRoot,workspacePath:row.workspace,
    launch:{command:"/TEST/node",args:["/TEST/cli","--job-id",row.jobId],cwd:row.workspace},
    ...([Role.PrimaryLegacy,Role.AuxiliaryLegacyC].includes(row.role)?{authAttachment:{opaque:"metadata-only"}}:{})}));
  return {members,creators,primary:creators[0]!.launch};
}
test("positive fixture requires exactly four distinct inventoried physical scopes and two candidate auth targets",()=>{
  const f=fixture();assert.equal(assertPositiveAcceptanceRoster(f.members,f.creators,f.primary).length,4);
  assert.throws(()=>assertPositiveAcceptanceRoster(f.members.slice(0,2),f.creators.slice(0,2),f.primary));
  assert.throws(()=>assertPositiveAcceptanceRoster([...f.members,f.members[0]!],[...f.creators,f.creators[0]!],f.primary));
  assert.throws(()=>assertPositiveAcceptanceRoster(f.members,[f.creators[0]!,f.creators[1]!,f.creators[2]!,f.creators[2]!],f.primary));
  const noAuth=f.creators.map(({authAttachment,...row})=>row);assert.throws(()=>assertPositiveAcceptanceRoster(f.members,noAuth,f.primary));
  const referenceAuth=f.creators.map(row=>({...row,authAttachment:{}}));assert.throws(()=>assertPositiveAcceptanceRoster(f.members,referenceAuth,f.primary));
});
test("auxiliary launch never replaces primary runtimeLaunch and aliases cannot satisfy the closed roster",()=>{
  const f=fixture();assert.throws(()=>assertPositiveAcceptanceRoster(f.members,f.creators,f.creators[2]!.launch));
  const aliased=f.members.map((row,index)=>index===2?{...row,workspace:f.members[0]!.workspace}:row);
  assert.throws(()=>assertPositiveAcceptanceRoster(aliased,f.creators,f.primary));
  const swapped=[f.members[2]!,f.members[1]!,f.members[0]!,f.members[3]!];assert.throws(()=>assertPositiveAcceptanceRoster(swapped,f.creators,f.primary));
  const escaped=f.members.map((row,index)=>index===2?{...row,jobRoot:row.jobRoot+"/../other"}:row);
  assert.throws(()=>assertPositiveAcceptanceRoster(escaped,f.creators,f.primary));
});
test("positive composition reuses one original absolute deadline without fractional timeout or renewal",()=>{
  const end=1700000;assert.equal(positiveAcceptanceRemaining(end,80000),1620000);
  assert.equal(positiveAcceptanceRemaining(end,1699998.2),1);
  assert.throws(()=>positiveAcceptanceRemaining(end,1699999.5));assert.throws(()=>positiveAcceptanceRemaining(end,end));
  assert.throws(()=>positiveAcceptanceRemaining(end,0));assert.throws(()=>positiveAcceptanceRemaining(Infinity,1));
});

import { assertLegacyRenamedEvidenceData } from "./current-evict-restore-readback.js";
test("legacy renamed-v3 DATA must join original comparison, candidate source and header while installed-v2 is distinct",()=>{
  const expected={version:3 as const,operationId:"TEST-operation",workspace:{dev:"1",ino:"2",canonicalPath:"/TEST/workspace"},epoch:1,
    tree:{dev:"1",ino:"3"},trash:{destinationName:"dependency-TEST-operation"},manifestDigest:"a".repeat(64),headerSha256:"b".repeat(64),
    comparisonEvidenceId:"c".repeat(64),sourceBinding:{path:"/TEST/original-source",sha256:"d".repeat(64),identity:{dev:"1",ino:"4"}}};
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");assertLegacyRenamedEvidenceData(encode(expected),expected);
  for(const field of ["headerSha256","comparisonEvidenceId","sourceBinding"] as const){
    const changed={...expected,[field]:field==="sourceBinding"?{...expected.sourceBinding,sha256:"e".repeat(64)}:"e".repeat(64)};
    assert.throws(()=>assertLegacyRenamedEvidenceData(encode(changed),expected));
  }
  const {comparisonEvidenceId,...installed}=expected;
  assert.throws(()=>assertLegacyRenamedEvidenceData(encode({...installed,version:2}),expected));
  assert.throws(()=>assertLegacyRenamedEvidenceData(Buffer.from(JSON.stringify(expected)),expected));
  assert.throws(()=>assertLegacyRenamedEvidenceData(encode({...expected,extra:true}),expected));
});

test("five-minute original entry window must fit BEFORE composite admission",()=>{
  assert.equal(positiveAcceptanceAdmissionRemaining(500000,200000),300000);
  assert.throws(()=>positiveAcceptanceAdmissionRemaining(500000,200000.1));
});
