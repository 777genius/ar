import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CiEnvelopePublication, publishCiEnvelopeCatalogData } from "./current-h1-tool-inputs-ci.ts";
import { ciIndexOperationalBytes } from "./current-h1-tool-inputs-ci-index.ts";
import { PythonDataCatalogStatus, PythonEnvelopeKind, serializeFixedSignedPythonEnvelopeData, type CapturedEnvelope, type SignedPackage, type EnvelopeEntry, type PythonDataCatalogSerialization } from "../../host-integration/managed-launcher/dependency-full-python-envelope-TEST.ts";
const sha=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
const provenance={signedPackagesSha256:sha("owned signed-packages record"),completeIndicesSha256:sha("owned complete-indices record"),sourceAndToolsSha256:sha("owned source-and-tools record")};
const limits={entries:20000,bytes:512*1024*1024,fileBytes:32*1024*1024,depth:2047,elapsedMs:30000,catalogBytes:131072};
function fixture():CapturedEnvelope {
 const entries:EnvelopeEntry[]=[
  ...["/etc","/etc/python3.12"].map(path=>({path,kind:PythonEnvelopeKind.Directory,mode:0o755,bytes:0,sha256:sha(""),target:""})),
  {path:"/etc/python3.12/sitecustomize.py",kind:PythonEnvelopeKind.Source,mode:0o644,bytes:155,sha256:"43d81125d92376b1a69d53a71126a041cc9a18d8080e92dea0a2ae23be138b1e",target:""},
  {path:"/usr/lib/python3.12/sitecustomize.py",kind:PythonEnvelopeKind.Alias,mode:0o555,bytes:32,sha256:"32f1de153f7e1e3f9b543ada197eb2630524868b92869513a393775d30c77cbd",target:"/etc/python3.12/sitecustomize.py"},
  ...Array.from({length:1000},(_,i)=>({path:`/usr/lib/python3.12/owned_fixture_${String(i).padStart(4,"0")}.py`,kind:PythonEnvelopeKind.Source,mode:0o644,bytes:1,sha256:sha("x"),target:""})),
 ];
 const packages:readonly SignedPackage[]=[{package:"libpython3.12-minimal",version:"3.12.3-1ubuntu0.17",arch:"amd64",sha256:"d646ad7112b5adec21ba0e1af015f04ae8ca7f5efdc619622547dd6673c4c14b",size:838536}];
 return Object.freeze({catalog:Object.freeze({schemaVersion:1,packages:Object.freeze(packages.map(row=>Object.freeze(row))),entries:Object.freeze(entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(row=>Object.freeze(row)))}),measurement:Object.freeze({entries:entries.length,bytes:1187,largestFile:155,depth:4}),elf:new Map()});
}
function ownOutputs(run:(directory:string,publish:(name:CiEnvelopePublication,body:Buffer|string)=>void)=>void):void {
 const directory=mkdtempSync(join(tmpdir(),"TEST-complete-unadmitted-"));
 try{run(directory,(name,body)=>writeFileSync(join(directory,name),body,{flag:"wx",mode:0o600}));}finally{rmSync(directory,{recursive:true});}
}
test("over-cap same DATA capture retains complete canonical body while original candidate stays absent/HOLD",()=>{
 const capture=fixture(),serialized=serializeFixedSignedPythonEnvelopeData(capture.catalog,limits);
 assert.equal(serialized.status,PythonDataCatalogStatus.CapacityHeld);assert.equal(serialized.bytes,null);
 assert(serialized.measurement.serializedBytes>131072);
 ownOutputs((directory,publish)=>{
  assert.equal(publishCiEnvelopeCatalogData("a".repeat(40),capture,serialized,provenance,publish),"HOLD-not-native-qualified");
  const bytes=readFileSync(join(directory,CiEnvelopePublication.CompleteUnadmitted));
  assert(bytes.equals(Buffer.from(JSON.stringify(capture.catalog))));assert.equal(sha(bytes),serialized.measurement.sha256);assert.equal(bytes.length,serialized.measurement.serializedBytes);
  assert(!readdirSync(directory).includes(CiEnvelopePublication.Candidate));
  const retention:unknown=JSON.parse(readFileSync(join(directory,CiEnvelopePublication.Retention),"utf8"));
  assert.deepEqual(retention,{schemaVersion:1,purpose:"COMPLETE_UNADMITTED_DATA_ONLY",sourceSha:"a".repeat(40),body:CiEnvelopePublication.CompleteUnadmitted,serializedBytes:bytes.length,sha256:sha(bytes),entries:1004,packages:1,kindCounts:{directory:2,source:1001,elf:0,alias:1,data:0},elfEntries:0,provenanceRecords:{"signed-packages.json":provenance.signedPackagesSha256,"complete-indices.json":provenance.completeIndicesSha256,"source-and-tools.json":provenance.sourceAndToolsSha256},originalStatus:PythonDataCatalogStatus.CapacityHeld,candidatePresent:false,physicalCatalogQualified:false,nativeQualified:false,originalNamespaceQualified:false,inlineReviewQualified:false});
  assert(readdirSync(directory).includes(CiEnvelopePublication.Held));assert.equal(serialized.bytes,null);
  assert.throws(()=>publishCiEnvelopeCatalogData("a".repeat(40),capture,serialized,provenance,publish),/EEXIST/);assert(readFileSync(join(directory,CiEnvelopePublication.CompleteUnadmitted)).equals(bytes));
 });
});
test("stale size/hash/count commitments refuse before any publication",()=>{
 const capture=fixture(),serialized=serializeFixedSignedPythonEnvelopeData(capture.catalog,limits);
 for(const measurement of [{...serialized.measurement,serializedBytes:serialized.measurement.serializedBytes+1},{...serialized.measurement,sha256:"0".repeat(64)},{...serialized.measurement,entries:0},{...serialized.measurement,packages:0},{...serialized.measurement,kindCounts:{...serialized.measurement.kindCounts,source:0}}]){
  const changed:PythonDataCatalogSerialization={...serialized,measurement};
  ownOutputs((directory,publish)=>{assert.throws(()=>publishCiEnvelopeCatalogData("a".repeat(40),capture,changed,provenance,publish));assert.deepEqual(readdirSync(directory),[]);});
 }
});
test("fixed operational boundary is inclusive but plus one refuses before serialization/write",()=>{
 const capture=fixture(),serialized=serializeFixedSignedPythonEnvelopeData(capture.catalog,limits);
 ownOutputs((directory,publish)=>{
  // No 128 MiB fixture/allocation: the exact-bound claim passes the operational guard,
  // then refuses because the real same-capture bytes cannot match that claim.
  assert.throws(()=>publishCiEnvelopeCatalogData("a".repeat(40),capture,{...serialized,measurement:{...serialized.measurement,serializedBytes:ciIndexOperationalBytes}},provenance,publish),/complete unadmitted byte count/);
  assert.throws(()=>publishCiEnvelopeCatalogData("a".repeat(40),capture,{...serialized,measurement:{...serialized.measurement,serializedBytes:ciIndexOperationalBytes+1}},provenance,publish),/complete unadmitted operational record ceiling/);
  assert.deepEqual(readdirSync(directory),[]);
 });
});
