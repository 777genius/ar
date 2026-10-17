import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertExactH1PackageSeeds, hashOriginalAcquiredArchive, retainOriginalAcquiredArchive, joinAcquiredSignedPackage, parseAcquiredPackageFields, ToolInputArchitecture, type AcquiredSignedPackage } from "./current-h1-tool-inputs-package.ts";
// Synthetic repository protocol fixtures, NOT a signed acquisition or host pin.
const bytes=Buffer.from("owned TEST package archive protocol bytes\n");
const hash=createHash("sha256").update(bytes).digest("hex");
const deb="Package: libffi8\nVersion: 3.4.6-TEST\nArchitecture: amd64\n";
const stanza=`Package: libffi8\nVersion: 3.4.6-TEST\nArchitecture: amd64\nFilename: pool/main/libf/libffi/libffi8_3.4.6-TEST_amd64.deb\nSHA256: ${hash}\nSize: ${bytes.length}\nDescription: TEST only\n continuation\n`;
const archive={sha256:hash,size:bytes.length};
test("same authenticated stanza must join package, version, architecture, hash and size",()=>{
 const row=joinAcquiredSignedPackage(deb,stanza,archive);assert.equal(row.package,"libffi8");assert.equal(row.version,"3.4.6-TEST");assert.equal(row.size,bytes.length);
 for(const [old,value] of [["Package: libffi8","Package: libffi7"],["Version: 3.4.6-TEST","Version: 3.4.7-TEST"],["Architecture: amd64","Architecture: all"],[`SHA256: ${hash}`,`SHA256: ${"0".repeat(64)}`],[`Size: ${bytes.length}`,`Size: ${bytes.length+1}`]] as const)
  assert.throws(()=>joinAcquiredSignedPackage(deb,stanza.replace(old,value),archive),/Held/);
 assert.throws(()=>joinAcquiredSignedPackage(deb,stanza.replace(`SHA256: ${hash}\n`,"")+"\n"+stanza.replace(`Size: ${bytes.length}\n`,""),archive),/Held/);
});
test("matching first stanza cannot hide a conflicting duplicate signed version or unsafe archive name",()=>{
 assert.throws(()=>joinAcquiredSignedPackage(deb,stanza+"\n"+stanza.replace(hash,"1".repeat(64)),archive),/Held/);
 assert.throws(()=>joinAcquiredSignedPackage(deb,stanza.replace("pool/main/libf/libffi/","pool/../"),archive),/Held/);
 assert.throws(()=>joinAcquiredSignedPackage(deb,stanza+`SHA256: ${hash}\n`,archive),/duplicate/);
 assert.equal(joinAcquiredSignedPackage(deb,stanza+"\n"+stanza,archive).sha256,hash);
});
test("exact five seeds retain transitive rows and refuse missing minimal stdlib or newer fallback",()=>{
 const seeds:AcquiredSignedPackage[]=[
  ["python3.12-minimal","3.12.3-1ubuntu0.17"],["libpython3.12-minimal","3.12.3-1ubuntu0.17"],["libpython3.12-stdlib","3.12.3-1ubuntu0.17"],["libc6","2.39-0ubuntu8.9"],["util-linux","2.39.3-9ubuntu6.6"],
 ].map(([name,version])=>{assert(name&&version);return {package:name,version,arch:ToolInputArchitecture.Amd64,sha256:hash,size:bytes.length,filename:"pool/main/t/test/test.deb"};});
 const dependency=joinAcquiredSignedPackage(deb,stanza,archive);const complete=[...seeds,dependency];
 assert.doesNotThrow(()=>assertExactH1PackageSeeds(complete));assert.equal(complete.at(-1),dependency);
 assert.throws(()=>assertExactH1PackageSeeds(complete.filter(row=>row.package!=="libpython3.12-minimal")),/Held/);
 assert.throws(()=>assertExactH1PackageSeeds(complete.map(row=>row.package==="libc6"?{...row,version:"2.39-0ubuntu8.10"}:row)),/Held/);
 assert.throws(()=>assertExactH1PackageSeeds([...complete,dependency]),/duplicate/);
});
test("deb fields refuse unknown architecture, duplicate keys and malformed input before any extraction",()=>{
 for(const fields of [deb.replace("amd64","arm64"),deb+"Package: libffi8\n",deb.replace("Version: ","Version="),deb+"Unexpected: true\n",deb.replace("Version:","\nVersion:")])
  assert.throws(()=>parseAcquiredPackageFields(fields),/Held/);
});
const rootLinux=process.platform==="linux"&&process.getuid?.()===0;
test("real acquired file hashes retained bytes and refuses post-read deadline/identity mutation",{skip:!rootLinux?"root-owned Linux TEST archive boundary, no target execution":false},()=>{
 const root=mkdtempSync(join(tmpdir(),"TEST-H1-acquisition-")),path=join(root,"fixture.deb");
 try{
  writeFileSync(path,bytes,{flag:"wx",mode:0o600});assert.deepEqual(hashOriginalAcquiredArchive(path,()=>{}),archive);
  let calls=0;assert.throws(()=>hashOriginalAcquiredArchive(path,()=>{if(++calls===3)throw new Error("TEST deadline expired");}),/deadline/);
  assert.throws(()=>hashOriginalAcquiredArchive(path,()=>{if(++calls===5)writeFileSync(path,Buffer.from("changed\n"));}),/Held/);
 }finally{rmSync(root,{recursive:true});}
});
test("ordinary caller-owned file cannot become original root-owned archive authority",{skip:process.getuid?.()===0?"nonroot negative is exercised by separate caller-owned environment":false},()=>{
 const root=mkdtempSync(join(tmpdir(),"TEST-H1-untrusted-archive-")),path=join(root,"fixture.deb");
 try{writeFileSync(path,bytes,{flag:"wx",mode:0o600});assert.throws(()=>hashOriginalAcquiredArchive(path,()=>{}),/custody/);}finally{rmSync(root,{recursive:true});}
});
test("retained original archive rejects equal-byte replacement between verification and extraction",{skip:!rootLinux?"root-owned Linux TEST custody, no target execution":false},()=>{
 const root=mkdtempSync(join(tmpdir(),"TEST-H1-retained-archive-")),path=join(root,"fixture.deb"),replacement=join(root,"replacement.deb");
 try{
  writeFileSync(path,bytes,{flag:"wx",mode:0o600});const original=retainOriginalAcquiredArchive(path,()=>{});
  try{
   original.rejoin();writeFileSync(replacement,bytes,{flag:"wx",mode:0o600});renameSync(replacement,path);
   assert.deepEqual(hashOriginalAcquiredArchive(path,()=>{}),archive); // Hash-only reopening misses this substitution.
   assert.throws(()=>original.rejoin(),/original archive identity changed/);
  }finally{original.close();}
 }finally{rmSync(root,{recursive:true});}
});
