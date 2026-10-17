import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ToolInputArchitecture,type AcquiredSignedPackage} from "./current-h1-tool-inputs-package.ts";
import {joinH1BinarySource,joinH1SourceSelection,validateH1SourceDsc,retainH1SourceArchives,h1SourceLimits,type H1SourceIndexOrigin} from "./current-h1-source-record-TEST.ts";
// Synthetic archive protocol bytes, never authenticated source or a native grant.
const sha=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex"),noop=()=>{};
const binary:AcquiredSignedPackage={package:"libpython3.12-minimal",version:"3.12.3-1ubuntu0.17",arch:ToolInputArchitecture.Amd64,sha256:"a".repeat(64),size:42,filename:"pool/main/p/python3.12/libpython3.12-minimal_TEST_amd64.deb"};
const source={name:"python3.12",version:"2:3.12.3-1ubuntu0.17"};
const binaryText=(field=`Source: ${source.name} (${source.version})\n`)=>`Package: ${binary.package}\nVersion: ${binary.version}\nArchitecture: amd64\n${field}SHA256: ${binary.sha256}\nSize: 42\nFilename: ${binary.filename}\n`;
const origin=(path:string,bytes:Buffer):H1SourceIndexOrigin=>({origin:"https://archive.ubuntu.com/ubuntu/dists/noble-updates",releaseSha256:"b".repeat(64),path,sha256:sha(bytes),size:bytes.length});
const tar=Buffer.from("TEST source tar bytes, not extracted\n"),patch=Buffer.from("TEST distro patch bytes, not applied\n");
const tarName="python3.12_3.12.3.orig.tar.xz",patchName="python3.12_3.12.3-1ubuntu0.17.debian.tar.xz",dscName="python3.12_3.12.3-1ubuntu0.17.dsc";
const checks=` ${sha(tar)} ${tar.length} ${tarName}\n ${sha(patch)} ${patch.length} ${patchName}\n`;
const dscText=`Format: 3.0 (quilt)\nSource: python3.12\nVersion: ${source.version}\nChecksums-Sha256:\n${checks}`;
function fixture(dsc=Buffer.from(dscText),transform=(s:string)=>s){
 const b=Buffer.from(binaryText()),s=Buffer.from(transform(`Package: python3.12\nVersion: ${source.version}\nDirectory: pool/main/p/python3.12\nChecksums-Sha256:\n ${sha(dsc)} ${dsc.length} ${dscName}\n${checks}`));
 const selection=joinH1SourceSelection(binary,source,origin("main/binary-amd64/Packages",b),s,origin("main/source/Sources",s),noop);
 return {selection,dsc,sourceIndex:s,files:new Map([[dscName,dsc],[tarName,tar],[patchName,patch]])};
}
test("binary source defaults and explicit epochs preserve the existing binary vector shape",()=>{
 const keys=Object.keys(binary),copy=JSON.stringify(binary);
 assert.deepEqual(joinH1BinarySource(binary,Buffer.from(binaryText()),noop),source);
 assert.deepEqual(joinH1BinarySource(binary,Buffer.from(binaryText("Source: python3.12\n")),noop),{name:"python3.12",version:binary.version});
 assert.deepEqual(joinH1BinarySource(binary,Buffer.from(binaryText("")),noop),{name:binary.package,version:binary.version});
 assert.equal(JSON.stringify(binary),copy);assert.deepEqual(Object.keys(binary),keys);
});
test("same binary cannot hide a conflicting source stanza or split archive hash and size",()=>{
 for(const raw of [binaryText()+"\n"+binaryText().replace(source.version,"3:3.12.3-1ubuntu0.17"),binaryText()+"\n"+binaryText(""),binaryText().replace("Size: 42","Size: 43"),binaryText()+"Source: forged\n",binaryText("Source: ../outside\n"),binaryText("Source: python3.12 (latest)\n")])assert.throws(()=>joinH1BinarySource(binary,Buffer.from(raw),noop));
 assert.deepEqual(joinH1BinarySource(binary,Buffer.from(binaryText()+"\n"+binaryText()),noop),source);
});
test("source selection requires exact same Release pocket component and full authenticated EOF",()=>{
 const f=fixture(),s=f.sourceIndex,b=origin("main/binary-amd64/Packages",Buffer.from(binaryText())),o=origin("main/source/Sources",s);
 for(const changed of [{...o,origin:o.origin.replace("updates","security")},{...o,releaseSha256:"c".repeat(64)},{...o,path:"universe/source/Sources"},{...o,size:s.length+1},{...o,sha256:"c".repeat(64)}])assert.throws(()=>joinH1SourceSelection(binary,source,b,s,changed,noop));
 assert.throws(()=>fixture(undefined,s=>s.replace("Package: python3.12","Source: python3.12")));
 assert.throws(()=>fixture(undefined,s=>s.replace(source.version,"3:3.12.3-1ubuntu0.17")));
});
test("Sources and dsc require unique complete SHA256 rosters and confined single names",()=>{
 for(const transform of [(s:string)=>s+s,(s:string)=>s+checks,(s:string)=>s.replace("pool/main/p/python3.12","pool/main/../outside"),(s:string)=>s.replace(tarName,"../outside.tar.xz"),(s:string)=>s.replace(tarName,"extra.buildinfo"),(s:string)=>s.replace(` ${sha(tar)} ${tar.length}`,` ${sha(tar)} 134217729`),(s:string)=>s+"Checksums-Sha256:\n"+checks])assert.throws(()=>fixture(undefined,transform));
 const complete=fixture();assert.doesNotThrow(()=>validateH1SourceDsc(complete.selection,complete.dsc));
 for(const raw of [dscText.replace("Source: python3.12","Source: wrong"),dscText.replace(source.version,"3:3.12.3-1ubuntu0.17"),dscText.replace(checks,checks.split("\n")[0]+"\n"),dscText+checks,dscText+"Checksums-Sha256:\n"+checks]){const f=fixture(Buffer.from(raw));assert.throws(()=>validateH1SourceDsc(f.selection,f.dsc));}
 assert.throws(()=>validateH1SourceDsc(complete.selection,Buffer.concat([complete.dsc,Buffer.from("x")])));
});
test("complete clearsigned dsc framing is hashed but never becomes an uploader signature grant",()=>{
 const signed=Buffer.from("-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\n"+dscText+"-----BEGIN PGP SIGNATURE-----\n\nVEVTVA==\n=AAAA\n-----END PGP SIGNATURE-----\n"),f=fixture(signed);
 assert.doesNotThrow(()=>validateH1SourceDsc(f.selection,signed));
 for(const raw of [signed.toString().replace("Hash: SHA512","Unknown: accepted"),signed.toString()+"trailing text",signed.toString().replace("-----END PGP SIGNATURE-----","")]){const other=fixture(Buffer.from(raw));assert.throws(()=>validateH1SourceDsc(other.selection,other.dsc));}
});
test("source protocol deadline refusal cannot publish a partial selection",()=>{
 let calls=0;assert.throws(()=>joinH1BinarySource(binary,Buffer.from(binaryText()),()=>{if(++calls===2)throw Error("TEST expired");}),/expired/);
 const f=fixture();assert.throws(()=>joinH1SourceSelection(binary,source,origin("main/binary-amd64/Packages",Buffer.from(binaryText())),f.sourceIndex,origin("main/source/Sources",f.sourceIndex),()=>{throw Error("TEST expired");}),/expired/);
});
// Exact checksum rows copied from the actual signed noble-updates Sources index
// a22680d4…323b1. This small projected index is DATA, not signed-index authority.
const gccSource={name:"gcc-14",version:"14.2.0-4ubuntu2~24.04.1"};
const gccChecks=` 768c314c11eeab56ccebb91eb42ec4a41122fa94f0d83400126401942622197b 97158172 gcc-14_14.2.0.orig.tar.gz
 cfece214c2fb790ef5f3baffb9a53e40618e7ae12d053610b251e94d77d08ade 1950432 gcc-14_14.2.0-4ubuntu2~24.04.1.debian.tar.xz
 50950080874a6ec6780dd60c243e21d9cda9d736bb32bca98d16095d27cc01b5 46930 gcc-14_14.2.0-4ubuntu2~24.04.1.dsc
`;
function gccSelection(checks=gccChecks){
 const b=Buffer.from(binaryText()),index=Buffer.from(`Package: ${gccSource.name}\nVersion: ${gccSource.version}\nDirectory: pool/main/g/gcc-14\nChecksums-Sha256:\n${checks}`);
 return joinH1SourceSelection(binary,gccSource,origin("main/binary-amd64/Packages",b),index,origin("main/source/Sources",index),noop);
}
test("actual GCC signed checksum metadata fits the bounded source total without archive body allocation",()=>{
 const selected=gccSelection();assert.equal(selected.artifacts.length,3);
 assert.equal(selected.artifacts.find(row=>row.name.endsWith(".orig.tar.gz"))?.size,97158172);
 assert.equal(selected.artifacts.find(row=>row.name.endsWith(".orig.tar.gz"))?.sha256,"768c314c11eeab56ccebb91eb42ec4a41122fa94f0d83400126401942622197b");
 assert.equal(selected.artifacts.reduce((n,row)=>n+row.size,0),99155534);
 assert.deepEqual(h1SourceLimits,{artifactBytes:128*1024*1024,totalBytes:128*1024*1024,dscBytes:256*1024,artifacts:16});
});
test("source artifact and complete aggregate remain capped at 128 MiB",()=>{
 assert.throws(()=>gccSelection(gccChecks.replace("97158172","134217729")));
 // Each individual artifact fits; their complete checksum roster exceeds the total.
 assert.throws(()=>gccSelection(gccChecks.replace("97158172","104857600").replace("1950432","33554432")));
 // Exact total is allowed as metadata; one additional byte still holds.
 const exact=134217728-1950432-46930;
 assert.equal(gccSelection(gccChecks.replace("97158172",String(exact))).artifacts.reduce((n,row)=>n+row.size,0),134217728);
 assert.throws(()=>gccSelection(gccChecks.replace("97158172",String(exact+1))));
});
// Synthetic checksum-bound protocol fixtures; detached signatures are opaque DATA.
function formatFixture(identity:{name:string;version:string},format:string,names:readonly string[],descriptorName?:string,innerNames=names){
 const stem=`${identity.name}_${identity.version.replace(/^[0-9]+:/,"")}`,name=descriptorName??`${stem}.dsc`;
 const bytes=(name:string)=>Buffer.from(`TEST opaque archive/signature ${name}\n`);
 const lines=(names:readonly string[])=>names.map(name=>` ${sha(bytes(name))} ${bytes(name).length} ${name}\n`).join("");
 const dsc=Buffer.from(`Format: ${format}\nSource: ${identity.name}\nVersion: ${identity.version}\nChecksums-Sha256:\n${lines(innerNames)}`);
 const b=Buffer.from(binaryText()),index=Buffer.from(`Package: ${identity.name}\nVersion: ${identity.version}\nDirectory: pool/main/p/${identity.name}\nChecksums-Sha256:\n ${sha(dsc)} ${dsc.length} ${name}\n${lines(names)}`);
 const selection=joinH1SourceSelection(binary,identity,origin("main/binary-amd64/Packages",b),index,origin("main/source/Sources",index),noop);
 return {selection,dsc};
}
const validateFormat=(...args:Parameters<typeof formatFixture>)=>{const f=formatFixture(...args);validateH1SourceDsc(f.selection,f.dsc);return f;};
test("quilt detached signatures retain every checksum-bound original row without signature authority",()=>{
 for(const ext of ["xz","bz2","gz","lzma","zst"]){
  const orig=`python3.12_3.12.3.orig.tar.${ext}`,component=`python3.12_3.12.3.orig-doc.tar.${ext}`;
  const f=validateFormat(source,"3.0 (quilt)",[orig,`${orig}.asc`,component,`${component}.asc`,patchName]);
  assert.equal(f.selection.artifacts.length,6);assert.equal(f.selection.artifacts.filter(row=>row.name.endsWith(".asc")).length,2);
  assert.deepEqual(Object.keys(f.selection),["source","binary","binaryIndex","sourceIndex","stanzaSha256","directory","artifacts"]);
 }
});
test("detached signatures cannot select foreign suffixes missing originals or unjoined inner rows",()=>{
 for(const name of [`${patchName}.asc`,`${dscName}.asc`,"unrelated.asc",`${tarName}.asc.asc`,"other.tar.xz.asc"])
  assert.throws(()=>formatFixture(source,"3.0 (quilt)",[tarName,patchName,name]));
 assert.throws(()=>formatFixture(source,"3.0 (quilt)",[`${tarName}.asc`,patchName]));
 assert.throws(()=>validateFormat(source,"3.0 (quilt)",[tarName,`${tarName}.asc`,patchName],undefined,[tarName,patchName]));
 const f=validateFormat(source,"3.0 (quilt)",[tarName,`${tarName}.asc`,patchName]);
 const altered={...f.selection,artifacts:f.selection.artifacts.map(row=>row.name.endsWith(".asc")?{...row,sha256:"f".repeat(64)}:row)};
 assert.throws(()=>validateH1SourceDsc(altered,f.dsc));
});
test("3.0 native accepts only one exact source-version archive plus its descriptor",()=>{
 const native={name:"dpkg",version:"1.22.6ubuntu6.6"};
 for(const ext of ["xz","gz","bz2","lzma","zst"]){const f=validateFormat(native,"3.0 (native)",[`dpkg_${native.version}.tar.${ext}`]);assert.equal(f.selection.artifacts.length,2);}
 validateFormat({...native,version:`2:${native.version}`},"3.0 (native)",[`dpkg_${native.version}.tar.xz`]);
 for(const names of [[`dpkg_${native.version}.orig.tar.xz`],[`dpkg_${native.version}.debian.tar.xz`],[`dpkg_${native.version}.tar.xz`,tarName],[`dpkg_${native.version}.tar.xz`,`dpkg_${native.version}.tar.gz`],["foreign_1.0.tar.xz"],["dpkg_1.22.6ubuntu6.5.tar.xz"],[`dpkg_${native.version}.tar.xz.asc`]])assert.throws(()=>validateFormat(native,"3.0 (native)",names));
 assert.throws(()=>validateFormat(native,"3.0 (native)",[`dpkg_${native.version}.tar.xz`],"foreign_1.0.dsc"));
 assert.throws(()=>validateFormat(native,"3.0 (quilt)",[`dpkg_${native.version}.tar.xz`]));
});
test("1.0 accepts exact nonnative orig gzip plus distro diff and optional bound signature",()=>{
 const legacy={name:"pcre2",version:"10.42-4ubuntu2.1"},orig="pcre2_10.42.orig.tar.gz",diff="pcre2_10.42-4ubuntu2.1.diff.gz";
 validateFormat(legacy,"1.0",[orig,diff]);validateFormat(legacy,"1.0",[orig,`${orig}.asc`,diff]);
 for(const names of [[orig],[diff],[orig,diff,patchName],[orig,diff,tarName],["pcre2_10.42.orig.tar.xz",diff],["pcre2_10.41.orig.tar.gz",diff],[orig,"pcre2_10.42-4ubuntu2.0.diff.gz"],["pcre2_10.42-4ubuntu2.1.tar.gz"]])assert.throws(()=>validateFormat(legacy,"1.0",names));
 for(const format of ["2.0","3.0 (git)","3.0 (custom)","unknown"])assert.throws(()=>validateFormat(legacy,format,[orig,diff]));
 assert.throws(()=>validateFormat(legacy,"3.0 (native)",[orig,diff]));
 assert.throws(()=>validateFormat(legacy,"3.0 (quilt)",[orig,diff]));
 assert.throws(()=>validateFormat(source,"3.0 (quilt)",[tarName]));
 assert.throws(()=>validateFormat(source,"3.0 (quilt)",[patchName]));
 assert.throws(()=>validateFormat(source,"3.0 (quilt)",[tarName,patchName,"extra.buildinfo"]));
});
const rootLinux=process.platform==="linux"&&process.getuid?.()===0;
function physicalFixture(){const root=fs.mkdtempSync(join(tmpdir(),"TEST-H1-source-")),f=fixture();fs.chmodSync(root,0o700);for(const [name,bytes] of f.files)fs.writeFileSync(join(root,name),bytes,{mode:0o600,flag:"wx"});return {root,...f};}
test("ROOT source originals reject same-byte replacement extra membership hardlinks and symlinks",{skip:!rootLinux},()=>{
 for(const attack of ["replace","extra","hardlink","symlink"]){const f=physicalFixture();try{
  if(attack==="hardlink"){fs.linkSync(join(f.root,tarName),join(f.root,"other"));assert.throws(()=>retainH1SourceArchives(f.root,f.selection,noop));continue;}
  if(attack==="symlink"){fs.unlinkSync(join(f.root,tarName));fs.symlinkSync(join(f.root,patchName),join(f.root,tarName));assert.throws(()=>retainH1SourceArchives(f.root,f.selection,noop));continue;}
  const retained=retainH1SourceArchives(f.root,f.selection,noop);try{assert(retained.read(tarName).equals(tar));
   if(attack==="replace"){fs.renameSync(join(f.root,tarName),join(f.root,"old"));fs.writeFileSync(join(f.root,tarName),tar,{mode:0o600});}else fs.writeFileSync(join(f.root,"extra"),"untouched");
   assert.throws(retained.rejoin);assert.throws(()=>retained.read(tarName));
  }finally{retained.close();}
 }finally{fs.rmSync(f.root,{recursive:true});}}
});
test("ROOT source post-I/O deadline permanently closes the retained originals",{skip:!rootLinux},context=>{
 const f=physicalFixture(),read=fs.readSync;let expired=false,calls=0;
 try{const retained=retainH1SourceArchives(f.root,f.selection,()=>{if(expired)throw Error("TEST expired");});
  context.mock.method(fs,"readSync",(fd:number,b:Buffer,o:number,n:number,p:number|null)=>{const value=read(fd,b,o,n,p);calls++;expired=true;return value;});syncBuiltinESMExports();
  assert.throws(()=>retained.read(tarName),/expired/);assert.equal(calls,1);expired=false;assert.throws(retained.rejoin);assert.throws(()=>retained.read(tarName));assert.equal(calls,1);retained.close();
 }finally{context.mock.restoreAll();syncBuiltinESMExports();fs.rmSync(f.root,{recursive:true});}
});
test("caller-owned source bytes cannot become root-owned acquisition custody",{skip:process.getuid?.()===0},()=>{const f=physicalFixture();try{assert.throws(()=>retainH1SourceArchives(f.root,f.selection,noop));}finally{fs.rmSync(f.root,{recursive:true});}});
