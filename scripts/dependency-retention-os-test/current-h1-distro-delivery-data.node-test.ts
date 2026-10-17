import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync,mkdirSync,renameSync,linkSync,writeFileSync,readFileSync,chmodSync,symlinkSync,truncateSync,rmSync,realpathSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {assembleH1DistroDeliveryData,H1DeliveryMissing,h1DeliveryLimits} from "./current-h1-distro-delivery-data.ts";
import {ubuntuArchive2018Fingerprint} from "./current-h1-tool-inputs-ci-index.ts";
const hash=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex"),sourceSha="a".repeat(40);
function fixture(run:(root:string,input:string)=>void){const root=realpathSync(mkdtempSync(join(tmpdir(),"TEST-h1-delivery-"))),input=join(root,"exports");mkdirSync(input,{mode:0o700});try{run(root,input);}finally{rmSync(root,{recursive:true,force:true});}}
function file(root:string,name:string,body:Buffer|string){writeFileSync(join(root,name),body,{mode:0o600});}
function assemble(root:string,input:string){return assembleH1DistroDeliveryData({exportDirectory:input,outputDirectory:join(root,"delivery"),sourceSha,nowMs:Date.parse("2026-10-16T00:00:00Z")});}
function release(root:string,override=new Map<string,Buffer>()){const indexes=new Map<string,Buffer>();for(const component of ["main","universe"])for(const kind of ["Packages","Sources"])indexes.set(component+"/"+(kind==="Packages"?"binary-amd64/Packages":"source/Sources"),Buffer.from(kind==="Packages"?"Package: unrelated\n\n":"Package: unrelated-source\n\n"));
 for(const [path,bytes] of override)indexes.set(path,bytes);
 const plain="Origin: Ubuntu\nLabel: Ubuntu\nSuite: noble\nCodename: noble\nDate: Thu, 15 Oct 2026 00:00:00 UTC\nSHA256:\n"+[...indexes].map(([path,b])=>` ${hash(b)} ${b.length} ${path}\n`).join("");file(root,"ubuntu-archive-keyring.gpg","public key DATA");file(root,"noble.InRelease","not cryptographically verified here\n");file(root,"noble.Release",plain);file(root,"noble.gpg-status",`[GNUPG:] VALIDSIG ${ubuntuArchive2018Fingerprint} 2026-10-15 1 0 4 0 1 10 00 ${ubuntuArchive2018Fingerprint}\n`);for(const [path,b] of indexes){const [component]=path.split("/");file(root,"noble-"+component+"."+(path.endsWith("Packages")?"Packages":"Sources"),b);}}

test("missing exports produce actionable unsigned DATA without issuer/bootstrap or HOST assertions",()=>fixture((root,input)=>{const candidate=assemble(root,input);assert.equal(candidate.nativeQualified,false);assert.equal(candidate.protectedReviewIssued,false);for(const reason of [H1DeliveryMissing.Host,H1DeliveryMissing.HostAliases,H1DeliveryMissing.Staged,H1DeliveryMissing.Bootstrap,H1DeliveryMissing.Signature,H1DeliveryMissing.Profile,H1DeliveryMissing.Publisher])assert(candidate.missing.some(row=>row.reason===reason));assert.equal(candidate.missing.filter(r=>r.reason===H1DeliveryMissing.Semantic).length,8);assert(!readdirSync(join(root,"delivery")).some(name=>name==="h1-distro-facts.json"||name==="review.json"||name==="h1-verifier-bootstrap-review.json"));}));

test("complete index bytes join Release hashes and flat deduplicated assets remain unsigned",()=>fixture((root,input)=>{release(input);const candidate=assemble(root,input);assert.equal(candidate.releases.length,1);assert.equal(candidate.releases[0]?.indices.length,4);assert(candidate.missing.some(row=>row.reason===H1DeliveryMissing.Signature));for(const asset of candidate.assets){const b=readFileSync(join(root,"delivery",`h1-distro-${asset.sha256}.bin`));assert.equal(b.length,asset.bytes);assert.equal(hash(b),asset.sha256);}const disk=JSON.parse(readFileSync(join(root,"delivery","h1-distro-delivery-candidate-UNSIGNED.json"),"utf8"));assert.deepEqual(disk,candidate);}));

test("tampered present index refuses before candidate publication",()=>fixture((root,input)=>{release(input);file(input,"noble-main.Packages","tampered bytes\n");assert.throws(()=>assemble(root,input));assert(!readdirSync(join(root,"delivery")).includes("h1-distro-delivery-candidate-UNSIGNED.json"));}));

test("aliased and linked original exports refuse instead of following ambient paths",()=>fixture((root,input)=>{file(root,"outside","public but not original");symlinkSync(join(root,"outside"),join(input,"ubuntu-archive-keyring.gpg"));assert.throws(()=>assemble(root,input));}));

test("sparse overflow refuses before allocating or publishing oversized asset",()=>fixture((root,input)=>{file(input,"ubuntu-archive-keyring.gpg","x");truncateSync(join(input,"ubuntu-archive-keyring.gpg"),h1DeliveryLimits.fileBytes+1);assert.throws(()=>assemble(root,input));assert.equal(readdirSync(join(root,"delivery")).length,0);}));

test("runtime source lineage mismatch and existing output refuse without overwriting",()=>fixture((root,input)=>{file(input,"signed-packages.json",JSON.stringify({sourceSha:"b".repeat(40),packages:[],qualifiedNative:false})+"\n");assert.throws(()=>assemble(root,input));file(join(root,"delivery"),"sentinel","keep");assert.throws(()=>assemble(root,input));assert.equal(readFileSync(join(root,"delivery","sentinel"),"utf8"),"keep");}));

test("writable source export refuses and canonical input directory aliases refuse",()=>fixture((root,input)=>{file(input,"ubuntu-archive-keyring.gpg","public key");chmodSync(join(input,"ubuntu-archive-keyring.gpg"),0o666);assert.throws(()=>assemble(root,input));const alias=join(root,"alias");symlinkSync(input,alias);assert.throws(()=>assembleH1DistroDeliveryData({exportDirectory:alias,outputDirectory:join(root,"other"),sourceSha,nowMs:Date.now()}));}));

function sourceFixture(input:string,badDsc=false){const archive=Buffer.from("TEST binary archive DATA, not decoded"),tar=Buffer.from("TEST original tar DATA"),debian=Buffer.from("TEST Debian patch tar DATA"),version="3.12.3-1ubuntu0.17",name="python3.12-minimal",filename=`pool/main/p/python3.12/${name}_${version}_amd64.deb`,tarName="python3.12_3.12.3.orig.tar.xz",debianName=`python3.12_${version}.debian.tar.xz`,dscName=`python3.12_${version}.dsc`;
 const checks=` ${hash(tar)} ${tar.length} ${tarName}\n ${hash(debian)} ${debian.length} ${debianName}\n`,dsc=Buffer.from(`Format: 3.0 (quilt)\nSource: ${badDsc?"wrong":"python3.12"}\nVersion: ${version}\nChecksums-Sha256:\n${checks}`),pkg={package:name,version,arch:"amd64",sha256:hash(archive),size:archive.length,filename},binary=Buffer.from(`Package: ${name}\nVersion: ${version}\nArchitecture: amd64\nSource: python3.12\nSHA256: ${pkg.sha256}\nSize: ${pkg.size}\nFilename: ${filename}\n`),sources=Buffer.from(`Package: python3.12\nVersion: ${version}\nDirectory: pool/main/p/python3.12\nChecksums-Sha256:\n ${hash(dsc)} ${dsc.length} ${dscName}\n${checks}`);
 release(input,new Map([["main/binary-amd64/Packages",binary],["main/source/Sources",sources]]));file(input,filename.split("/").at(-1)!,archive);file(input,tarName,tar);file(input,debianName,debian);file(input,dscName,dsc);file(input,"signed-packages.json",JSON.stringify({sourceSha,packages:[pkg],packageOrigins:[],qualifiedNative:false})+"\n");return {tarName};}

test("same-stanza binary/Sources/dsc joins retain real assets while missing original semantic evidence stays explicit",()=>fixture((root,input)=>{sourceFixture(input);const c=assemble(root,input);assert.equal(c.packages.length,1);assert(!c.missing.some(r=>r.reason===H1DeliveryMissing.Source));assert(c.missing.some(r=>r.reason===H1DeliveryMissing.Extraction&&r.subject==="python3.12"));}));

test("source archive tamper and correctly hashed wrong-source dsc both refuse",()=>{for(const mode of ["archive","dsc"])fixture((root,input)=>{const f=sourceFixture(input,mode==="dsc");if(mode==="archive")file(input,f.tarName,"tampered");assert.throws(()=>assemble(root,input));assert(!readdirSync(join(root,"delivery")).includes("h1-distro-delivery-candidate-UNSIGNED.json"));});});

test("apt epoch local archive names bind by original hash instead of guessed repository filename",()=>fixture((root,input)=>{sourceFixture(input);const path=join(input,"signed-packages.json"),r=JSON.parse(readFileSync(path,"utf8")),remote=r.packages[0].filename.split("/").at(-1),local="python3.12-minimal_2%3a3.12.3-1ubuntu0.17_amd64.deb";renameSync(join(input,remote),join(input,local));r.packageOrigins=[{archive:local,indices:[]}];file(input,"signed-packages.json",JSON.stringify(r)+"\n");const c=assemble(root,input);assert.equal(c.packages.length,1);assert(!c.missing.some(m=>m.subject===remote));}));

test("hardlinked original export refuses before publication",()=>fixture((root,input)=>{file(input,"ubuntu-archive-keyring.gpg","public key");linkSync(join(input,"ubuntu-archive-keyring.gpg"),join(root,"same-inode"));assert.throws(()=>assemble(root,input));assert.equal(readdirSync(join(root,"delivery")).length,0);}));

import {h1SourceOnlyBinaryAssociationData} from "./current-h1-distro-delivery-data.ts";
function sourceOnlyRecord(){return {sourceSha,purpose:"HOST_VERSION_SOURCE_CANDIDATE_ONLY",association:{binary:{package:"systemd-container",version:"255.4-1ubuntu8.18",arch:"amd64",sha256:"4692e521e9330c8d87427ffbeeed3b21d487857804dbdf630df650ba0f2b6573",size:417242,filename:"pool/main/s/systemd/systemd-container_255.4-1ubuntu8.18_amd64.deb"},source:{name:"systemd",version:"255.4-1ubuntu8.18"},indices:[{origin:"https://security.ubuntu.com/ubuntu/dists/noble-security",releaseSha256:"a".repeat(64),path:"main/binary-amd64/Packages",sha256:"b".repeat(64),size:10}]},stagedImageUnchanged:true,hostNspawnProvenance:false,compiledInputEquality:false,nativeQualified:false};}
test("finite source-only HOST archive remains unadmitted and binds the exact producer pin",()=>{
 const r=sourceOnlyRecord(),a=h1SourceOnlyBinaryAssociationData(r,sourceSha);assert.deepEqual(a.binary,r.association.binary);assert.deepEqual(a.source,r.association.source);
 for(const changed of [{...r,nativeQualified:true},{...r,compiledInputEquality:true},{...r,stagedImageUnchanged:false},{...r,hostNspawnProvenance:true},{...r,purpose:"qualified_package"},{...r,association:{...r.association,binary:{...r.association.binary,sha256:"c".repeat(64)}}},{...r,association:{...r.association,source:{name:"systemd",version:"255.4-1ubuntu8.17"}}}])assert.throws(()=>h1SourceOnlyBinaryAssociationData(changed,sourceSha));
});
test("source-only metadata cannot choose another pocket, ignore extra origin fields or relabel runtime source",()=>{
 const r=sourceOnlyRecord();assert.throws(()=>h1SourceOnlyBinaryAssociationData(r,"d".repeat(40)));
 for(const indices of [[{...r.association.indices[0],origin:"https://archive.ubuntu.com/ubuntu/dists/noble"}],[{...r.association.indices[0],extra:true}],[]])assert.throws(()=>h1SourceOnlyBinaryAssociationData({...r,association:{...r.association,indices}},sourceSha));
});
test("present source-only association must rejoin complete original index before extraction or qualification",()=>fixture((root,input)=>{
 release(input);file(input,"source-only-binary-association-UNADMITTED.json",JSON.stringify(sourceOnlyRecord())+"\n");
 assert.throws(()=>assemble(root,input));assert(!readdirSync(join(root,"delivery")).includes("h1-distro-delivery-candidate-UNSIGNED.json"));
}));
test("source-only complete-index selection with missing originals never enters qualified package/image vector",()=>fixture((root,input)=>{
 const r=sourceOnlyRecord(),p=r.association.binary;
 const binary=Buffer.from(`Package: ${p.package}\nVersion: ${p.version}\nArchitecture: amd64\nSource: systemd\nSHA256: ${p.sha256}\nSize: ${p.size}\nFilename: ${p.filename}\n`);
 const sources=Buffer.from(`Package: systemd\nVersion: ${p.version}\nDirectory: pool/main/s/systemd\nChecksums-Sha256:\n ${"a".repeat(64)} 1 systemd_${p.version}.dsc\n ${"b".repeat(64)} 1 systemd_255.4.orig.tar.gz\n ${"c".repeat(64)} 1 systemd_${p.version}.debian.tar.xz\n`);
 release(input,new Map([["main/binary-amd64/Packages",binary],["main/source/Sources",sources]]));
 // Reframe the same fixture's fully hashed release/index bytes as security;
 // no assertion treats this synthetic signature status as cryptographic proof.
 for(const name of readdirSync(input).filter(n=>n.startsWith("noble")))renameSync(join(input,name),join(input,name.replace("noble","noble-security")));
 const releasePath=join(input,"noble-security.Release");file(input,"noble-security.Release",readFileSync(releasePath,"utf8").replace("Suite: noble\n","Suite: noble-security\n"));
 r.association.indices[0]={origin:"https://security.ubuntu.com/ubuntu/dists/noble-security",releaseSha256:hash(readFileSync(join(input,"noble-security.InRelease"))),path:"main/binary-amd64/Packages",sha256:hash(binary),size:binary.length};
 file(input,"source-only-binary-association-UNADMITTED.json",JSON.stringify(r)+"\n");const c=assemble(root,input);
 assert.equal(c.packages.length,0);assert.equal(c.sourceOnlyAssociations.length,0);assert.equal(c.nativeQualified,false);assert.equal(c.protectedReviewIssued,false);
 assert(c.missing.some(row=>row.reason===H1DeliveryMissing.Source&&row.subject==="source_only_systemd"));assert(c.missing.some(row=>row.reason===H1DeliveryMissing.Signature));
}));
