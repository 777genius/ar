/** DATA/refusal tests. No test creates the genuine native parent's private slot. */
import test from "node:test";
import assert from "node:assert/strict";
import {h1DistroFactsData,h1DistroAssetName,H1DistroDefinition,H1DistroLocation,H1VerifierRole,retainH1SignedDistroFacts} from "./dependency-full-h1-constructor-build-facts-TEST.js";
import {H1DistroAssurance,requireQualifiedH1StagedConstructor} from "./dependency-full-h1-staged-tools-TEST.js";
import {CiUbuntuPocket,CiUbuntuComponent} from "../../scripts/dependency-retention-os-test/current-h1-tool-inputs-ci-index.ts";
import {ToolInputArchitecture} from "../../scripts/dependency-retention-os-test/current-h1-tool-inputs-package.ts";
const hash="a".repeat(64),other="b".repeat(64),asset={sha256:hash,bytes:1};
function input(){return {schemaVersion:1,assurance:H1DistroAssurance.SignedPublisher,sourceSha:"a".repeat(40),assets:[asset],releases:[{pocket:CiUbuntuPocket.Noble,inRelease:asset,keyring:asset,indices:["main/binary-amd64/Packages","main/source/Sources","universe/binary-amd64/Packages","universe/source/Sources"].map(path=>({path,asset}))}],packages:[{package:"python3.12-minimal",version:"3.12.3-1ubuntu0.17",arch:ToolInputArchitecture.Amd64,archive:asset,releaseSha256:hash,component:CiUbuntuComponent.Main}],members:[{location:H1DistroLocation.Staged,path:"/usr/bin/python3.12",archiveSha256:hash,memberPath:"usr/bin/python3.12"}],semantics:Object.values(H1DistroDefinition).map(definition=>({definition,archiveSha256:hash,extraction:asset,containing:{path:definition===H1DistroDefinition.PythonGetpath?"Modules/getpath.py":"src/nspawn/nspawn.c",asset},helpers:[],review:asset})),verifiers:[{path:"/usr/bin/gpgv",role:H1VerifierRole.Gpgv,sha256:hash},{path:"/usr/bin/dpkg-deb",role:H1VerifierRole.DpkgDeb,sha256:hash},{path:"/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",role:H1VerifierRole.Loader,sha256:hash},{path:"/usr/lib/x86_64-linux-gnu/libc.so.6",role:H1VerifierRole.SharedObject,sha256:hash}],verifierAliases:[],hostAliases:[],verifierReview:asset,compiledInputEquality:false,reproducibleBuild:false};}
test("signed-publisher DATA remains distinct from reproduced compilation and never issues native authority",()=>{
 const parsed=h1DistroFactsData(input());assert.equal(parsed.assurance,H1DistroAssurance.SignedPublisher);assert.equal(parsed.compiledInputEquality,false);assert.equal(parsed.reproducibleBuild,false);assert(Object.isFrozen(parsed)&&Object.isFrozen(parsed.members));assert.throws(requireQualifiedH1StagedConstructor,/selected_constructor_rows_not_qualified/);
 for(const changed of [{compiledInputEquality:true},{reproducibleBuild:true},{approved:true},{assurance:"compiler_reproduced"}])assert.throws(()=>h1DistroFactsData({...input(),...changed}));
});
test("missing HOST/staged package references, source definitions and substituted archive assets refuse",()=>{
 const value=input();for(const changed of [{assets:[asset,{...asset,bytes:2}]},{assets:[]},{packages:[{...value.packages[0],releaseSha256:other}]},{members:[{...value.members[0],archiveSha256:other}]},{semantics:value.semantics.slice(1)},{semantics:[...value.semantics.slice(0,-1),value.semantics[0]]},{semantics:value.semantics.map(s=>({...s,containing:{...s.containing,asset:{sha256:other,bytes:1}}}))},{releases:value.releases.map(r=>({...r,indices:r.indices.slice(1)}))}])assert.throws(()=>h1DistroFactsData({...value,...changed}));
});
test("fixed verifier roles cannot introduce a caller executable or escaping alias",()=>{
 const value=input();for(const path of ["/bin/sh","/usr/bin/curl","/usr/bin/../bin/gpgv","/usr/bin/gpgv/child"])assert.throws(()=>h1DistroFactsData({...value,verifiers:value.verifiers.map((v,i)=>i===0?{...v,path}:v)}));
 for(const target of ["/etc/evil","../../evil",".","..","unknown.so"])assert.throws(()=>h1DistroFactsData({...value,verifierAliases:[{path:"/usr/lib/x86_64-linux-gnu/libalias.so.1",target}]}));
 assert.doesNotThrow(()=>h1DistroFactsData({...value,verifierAliases:[{path:"/usr/lib/x86_64-linux-gnu/libalias.so.1",target:"libc.so.6"}]}));
});
test("DATA parsers reject accessor/proxy/array hooks without invoking them",()=>{
 let calls=0;const getter=input();Object.defineProperty(getter,"verifiers",{enumerable:true,get(){calls++;throw Error("hook");}});assert.throws(()=>h1DistroFactsData(getter));assert.equal(calls,0);
 assert.throws(()=>h1DistroFactsData(new Proxy(input(),{ownKeys(){calls++;throw Error("proxy");}})));assert.equal(calls,0);
 const members=input().members;Object.defineProperty(members,"0",{get(){calls++;throw Error("array hook");}});assert.throws(()=>h1DistroFactsData({...input(),members}));assert.equal(calls,0);
});
test("asset names are derived only from exact hashes; filenames cannot escape original review root",()=>{
 assert.equal(h1DistroAssetName(hash),"h1-distro-"+hash+".bin");for(const value of ["../secret","/etc/passwd",hash+"/x","A".repeat(64),"a".repeat(63)])assert.throws(()=>h1DistroAssetName(value));
});
test("an unqualified DATA subject cannot even start a native verifier",async()=>{
 // No original FD is touched: version1 DATA cannot request a native tool call.
 await assert.rejects(retainH1SignedDistroFacts({subject:{schemaVersion:1} as never,manifestFd:-1,reviewRootFd:-1,bootstrapReviewFd:-1,bootstrapReviewSha256:hash,catalogFiles:[],hostFiles:[],verifierFiles:[],deadline:0}),/TEST H1 signed distro Held/);
 assert.throws(requireQualifiedH1StagedConstructor,/selected_constructor_rows_not_qualified/);
});

test("separate original HOST nspawn/loader/every DSO coverage cannot be supplied by staged binaries",async()=>{
 const {checkH1DistroMemberCoverageData,h1DistroLibraryRouteData}=await import("./dependency-full-h1-constructor-build-facts-TEST.js");
 const actualElf=process.env.TEST_H1_ORIGINAL_NSPAWN_ELF;if(actualElf){const {readFileSync}=await import("node:fs"),{createHash}=await import("node:crypto"),{H1ElfRole,validateH1ElfRole,h1OriginalHostNspawnSha256,h1OriginalHostNspawnRunpath}=await import("./dependency-full-h1-elf-role-TEST.js"),{parsePythonEnvelopeElf}=await import("./dependency-full-python-envelope-TEST.js");const bytes=readFileSync(actualElf);assert.equal(createHash("sha256").update(bytes).digest("hex"),h1OriginalHostNspawnSha256);const checked=validateH1ElfRole(bytes,H1ElfRole.OriginalHostNspawn);assert.equal(checked.interpreter,"/lib64/ld-linux-x86-64.so.2");assert(checked.needed.includes("libsystemd-shared-255.so"));assert.deepEqual(parsePythonEnvelopeElf(bytes).runpath,[h1OriginalHostNspawnRunpath]);assert.throws(()=>validateH1ElfRole(bytes,H1ElfRole.Program),/search\/audit/);const changed=Buffer.from(bytes),offset=changed.indexOf(Buffer.from(h1OriginalHostNspawnRunpath));assert(offset>=0);changed[offset+1]=120;assert.throws(()=>validateH1ElfRole(changed,H1ElfRole.OriginalHostNspawn),/exact bytes/);const bad=Buffer.from(bytes);bad.writeUInt16LE(183,18);assert.throws(()=>validateH1ElfRole(bad,H1ElfRole.OriginalHostNspawn),/exact bytes/);}
 const actualHostAlias=[{path:"/usr/lib/x86_64-linux-gnu/libcap.so.2",target:"libcap.so.2.66"},{path:"/usr/lib/x86_64-linux-gnu/liblzma.so.5",target:"liblzma.so.5.4.5"},{path:"/usr/lib/x86_64-linux-gnu/libacl.so.1",target:"libacl.so.1.1.2302"}];for(const alias of actualHostAlias)assert.equal(h1DistroLibraryRouteData(actualHostAlias,"/usr/lib/x86_64-linux-gnu",alias.path.split("/").at(-1)!),"/usr/lib/x86_64-linux-gnu/"+alias.target);assert.throws(()=>h1DistroLibraryRouteData([...actualHostAlias,actualHostAlias[0]!],"/usr/lib/x86_64-linux-gnu","libcap.so.2"));assert.throws(()=>h1DistroLibraryRouteData([{path:actualHostAlias[0]!.path,target:"../../foreign"}],"/usr/lib/x86_64-linux-gnu","libcap.so.2"));
 const staged=["/usr/bin/python3.12","/usr/bin/nsenter","/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"].map(path=>({path,sha256:hash,fd:-1}));
 const host=["/usr/bin/systemd-nspawn","/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2","/usr/lib/x86_64-linux-gnu/libc.so.6"].map(path=>({path,sha256:hash,fd:-1}));
 const subject={schemaVersion:2,assurance:H1DistroAssurance.SignedPublisher,sourceSha:input().sourceSha,catalog:staged.map(f=>({path:f.path.slice(1),sha256:f.sha256,kind:"file"}))} as never;
 const facts=h1DistroFactsData({...input(),members:[...staged.map(f=>({location:H1DistroLocation.Staged,path:f.path,archiveSha256:hash,memberPath:f.path.slice(1)})),...host.map(f=>({location:H1DistroLocation.Host,path:f.path,archiveSha256:hash,memberPath:f.path.slice(1)}))]});
 assert.doesNotThrow(()=>checkH1DistroMemberCoverageData(subject,facts,staged,host));
 for(const missing of host)assert.throws(()=>checkH1DistroMemberCoverageData(subject,{...facts,members:facts.members.filter(m=>!(m.location===H1DistroLocation.Host&&m.path===missing.path))},staged,host),/distro_load_member_missing/);
 assert.throws(()=>checkH1DistroMemberCoverageData(subject,facts,staged,staged),/distro_load_member_missing/);
 assert.throws(()=>checkH1DistroMemberCoverageData(subject,facts,[...staged,{...staged[0]!}],host),/distro_load_member_missing/);
 const verifier=[{path:"/usr/bin/gpgv",sha256:hash,fd:-1}];const withVerifier={...facts,members:[...facts.members,{location:H1DistroLocation.Verifier,path:"/usr/bin/gpgv",archiveSha256:hash,memberPath:"usr/bin/gpgv"}]};assert.doesNotThrow(()=>checkH1DistroMemberCoverageData(subject,withVerifier,staged,host,verifier));assert.throws(()=>checkH1DistroMemberCoverageData(subject,facts,staged,host,verifier),/distro_load_member_missing/);
 assert.throws(requireQualifiedH1StagedConstructor,/selected_constructor_rows_not_qualified/);
});

test("genuine ROOT Linux source census directory/file/alias rows retain their original discriminated grammar",{skip:process.platform!=="linux"||process.getuid?.()!==0||process.env.CI!=="true"||process.env.GITHUB_ACTIONS!=="true"},async()=>{
 const fs=await import("node:fs"),{join}=await import("node:path"),{censusH1PatchedSource}=await import("../../scripts/dependency-retention-os-test/current-h1-source-extraction-child-TEST.js"),{h1DistroSourceInventoryData}=await import("./dependency-full-h1-constructor-build-facts-TEST.js");
 const scratch=process.env.RUNNER_TEMP;assert(scratch&&scratch.startsWith("/"));const root=fs.mkdtempSync(join(scratch,"TEST-h1-distro-census-"));try{
  fs.mkdirSync(root+"/nested",{mode:0o755});fs.writeFileSync(root+"/nested/file","actual public source bytes",{mode:0o644});fs.writeFileSync(root+"/nested/café","genuine UTF8 source name",{mode:0o644});fs.symlinkSync("nested/file",root+"/alias");
  const actual=censusH1PatchedSource(root,()=>{}),parsed=h1DistroSourceInventoryData(actual);assert.equal(parsed.get("nested")?.sha256,"");assert.equal(parsed.get("nested/file")?.kind,"file");assert.equal(parsed.get("alias")?.target,"nested/file");assert.equal(parsed.get("nested/café")?.kind,"file");
  assert.throws(()=>h1DistroSourceInventoryData({...actual,rows:actual.rows.map(r=>r.kind==="directory"?{...r,sha256:hash}:r)}));assert.throws(()=>h1DistroSourceInventoryData({...actual,bytes:actual.bytes+1}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
