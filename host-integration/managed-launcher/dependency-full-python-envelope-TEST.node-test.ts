/** Binary fixtures are parsed, never executed. No Python/ELF/tool launch. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, chownSync, lchownSync, lstatSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capturePythonEnvelope, parsePythonEnvelopeCatalog, parsePythonEnvelopeElf, validatePythonEnvelopeLoader, validatePythonEnvelope,
 PythonBackend, PythonEnvelopeKind, type CapturedEnvelope, type EnvelopeEntry, type ElfFacts, type PythonEnvelopeCatalog, type ReviewAuthority } from "./dependency-full-python-envelope-TEST.ts";
if(process.env.TEST_PYTHON_ENVELOPE_ROOT_CI==="1"){
 assert.equal(process.platform,"linux","root CI requires Linux");assert.equal(process.getuid?.(),0,"root CI requires uid0");assert.equal(process.geteuid?.(),0,"root CI requires euid0");
}
const hash=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
const empty=hash("");
const packages=Object.freeze([{package:"python3.12-minimal",version:"3.12.3-1ubuntu0.17",arch:"amd64" as const,sha256:"a".repeat(64),size:100}]);
// Explicit fixture measurement budget, not a proposed production limit.
const budget=Object.freeze({entries:40,bytes:8192,fileBytes:2048,depth:12,elapsedMs:1000,catalogBytes:16384});
function row(path:string,kind=PythonEnvelopeKind.Directory,bytes=0,target=""):EnvelopeEntry{return Object.freeze({path,kind,mode:0o555,bytes,sha256:empty,target});}
function captured(facts:ReadonlyMap<string,ElfFacts>,extra:readonly EnvelopeEntry[]=[]):CapturedEnvelope {
 const entries=[row("/usr/lib"),row("/usr/lib/x86_64-linux-gnu"),row("/usr/lib64"),row("/usr/bin/python3.12",PythonEnvelopeKind.Elf),
 ...[...facts.keys()].filter(p=>p!=="/usr/bin/python3.12").map(p=>row(p,PythonEnvelopeKind.Elf)),...extra].sort((a,b)=>a.path<b.path?-1:1);
 return {catalog:{schemaVersion:1,packages,entries},measurement:{entries:entries.length,bytes:0,largestFile:0,depth:5},elf:facts};
}
/** ELF64 fixture with one PT_LOAD and one PT_DYNAMIC, standard tag values.
 * Invalid fixtures mutate externally meaningful loader routes. */
function elf(needed:readonly string[]=[],tagged:readonly [bigint,string|number][]=[]):Buffer {
 const b=Buffer.alloc(1024);b.set([127,69,76,70,2,1,1]);b.writeUInt16LE(3,16);b.writeUInt16LE(62,18);b.writeUInt32LE(1,20);b.writeBigUInt64LE(64n,32);b.writeUInt16LE(64,52);b.writeUInt16LE(56,54);b.writeUInt16LE(2,56);
 b.writeUInt32LE(1,64);b.writeBigUInt64LE(0n,72);b.writeBigUInt64LE(0n,80);b.writeBigUInt64LE(BigInt(b.length),96);
 b.writeUInt32LE(2,120);b.writeBigUInt64LE(256n,128);b.writeBigUInt64LE(256n,136);
 const records:[bigint,bigint][]=[[5n,640n],[10n,256n]];let offset=1;
 for(const [tag,value] of [...needed.map(n=>[1n,n] as [bigint,string]),...tagged]){
  if(typeof value==="number")records.push([tag,BigInt(value)]);else{const bytes=Buffer.from(value+"\0");b.set(bytes,640+offset);records.push([tag,BigInt(offset)]);offset+=bytes.length;}
 }
 records.push([0n,0n]);b.writeBigUInt64LE(BigInt(records.length*16),152);
 for(const [i,r] of records.entries()){b.writeBigInt64LE(r[0],256+i*16);b.writeBigUInt64LE(r[1],264+i*16);}return b;
}
const leaf=parsePythonEnvelopeElf(elf());
test("catalog requires the independent exact commitment and rejects duplicate/unknown writable candidates",()=>{
 const c:PythonEnvelopeCatalog={schemaVersion:1,packages,entries:[row("/usr/bin/python3.12",PythonEnvelopeKind.Elf),row("/usr/lib"),row("/usr/lib64")]};
 const b=Buffer.from(JSON.stringify(c));assert.equal(parsePythonEnvelopeCatalog(b,hash(b),budget).entries.length,3);
 assert.throws(()=>parsePythonEnvelopeCatalog(b,"b".repeat(64),budget),/commitment/);
 for(const entries of [[...c.entries,c.entries[0]!],[{...c.entries[0]!,path:"/tmp/foreign.py"}], [{...c.entries[0]!,mode:0o777}], [{...c.entries[0]!,kind:PythonEnvelopeKind.Alias,target:"/tmp/foreign.so"}]]){
  const bytes=Buffer.from(JSON.stringify({...c,entries}));assert.throws(()=>parsePythonEnvelopeCatalog(bytes,hash(bytes),budget),/Held/);
 }
 assert.throws(()=>parsePythonEnvelopeCatalog(b,hash(b),{...budget,catalogBytes:b.length-1}),/catalog byte limit/);
 assert.throws(()=>parsePythonEnvelopeCatalog(b,hash(b),{...budget,entries:2}),/schema\/count/);
});
test("ELF64 decodes dependencies and denies audit/config/filter routes before resolution",()=>{
 assert.deepEqual(parsePythonEnvelopeElf(elf(["libbase.so"],[[29n,"$ORIGIN"]])).needed,["libbase.so"]);
 for(const tag of [0x6ffffefan,0x6ffffefbn,0x6ffffefcn,0x7ffffffdn,0x7fffffffn])assert.throws(()=>parsePythonEnvelopeElf(elf([],[[tag,"foreign.so"]])),/audit\/filter\/auxiliary/);
 assert.throws(()=>parsePythonEnvelopeElf(elf(["/tmp/foreign.so"])),/dependency\/soname escape/);
 const bad=elf();bad.writeBigUInt64LE(9999n,32);assert.throws(()=>parsePythonEnvelopeElf(bad),/ELF range/);
 const truncated=elf(["libbase.so"]).subarray(0,300);assert.throws(()=>parsePythonEnvelopeElf(truncated),/ELF range/);
});
test("trusted $ORIGIN RUNPATH and RPATH resolve; relative, token, outside and nonexistent paths refuse",()=>{
 for(const tag of [15n,29n]){
  const facts=new Map([["/usr/lib/x86_64-linux-gnu/extension.so",parsePythonEnvelopeElf(elf(["libbase.so"],[[tag,"$ORIGIN"]]))],["/usr/lib/x86_64-linux-gnu/libbase.so",leaf]]);
  assert.deepEqual(validatePythonEnvelopeLoader(captured(facts),PythonBackend.BuiltinSha256).get("/usr/lib/x86_64-linux-gnu/extension.so"),["/usr/lib/x86_64-linux-gnu/libbase.so"]);
  for(const path of ["/tmp",".","","$ORIGIN/../..","$LIB","/usr/lib/missing"]){const changed=new Map(facts);changed.set("/usr/lib/x86_64-linux-gnu/extension.so",parsePythonEnvelopeElf(elf(["libbase.so"],[[tag,path]])));assert.throws(()=>validatePythonEnvelopeLoader(captured(changed),PythonBackend.BuiltinSha256),/Held/);}
 }
});
test("every hwcaps alternative is authenticated and non-ELF shadow refuses",()=>{
 const main="/usr/lib/x86_64-linux-gnu/extension.so",ordinary="/usr/lib/x86_64-linux-gnu/libbase.so",fast="/usr/lib/x86_64-linux-gnu/glibc-hwcaps/x86-64-v3/libbase.so";
 const facts=new Map([[main,parsePythonEnvelopeElf(elf(["libbase.so"]))],[ordinary,leaf],[fast,leaf]]);
 assert.deepEqual(validatePythonEnvelopeLoader(captured(facts),PythonBackend.BuiltinSha256).get(main),[fast,ordinary].sort());
 facts.delete(fast);const shadow=captured(facts,[row(fast,PythonEnvelopeKind.Data)]);assert.throws(()=>validatePythonEnvelopeLoader(shadow,PythonBackend.BuiltinSha256),/noncode dependency/);
 facts.delete(ordinary);assert.throws(()=>validatePythonEnvelopeLoader(captured(facts),PythonBackend.BuiltinSha256),/unresolved ELF dependency/);
});
test("signed aliases must resolve completely without cycles or unknown targets",()=>{
 const facts=new Map([["/usr/lib/x86_64-linux-gnu/base.so",leaf]]);
 for(const entries of [[row("/usr/lib/alias.so",PythonEnvelopeKind.Alias,0,"/usr/lib/missing.so")], [row("/usr/lib/a.so",PythonEnvelopeKind.Alias,0,"/usr/lib/b.so"),row("/usr/lib/b.so",PythonEnvelopeKind.Alias,0,"/usr/lib/a.so")]])assert.throws(()=>validatePythonEnvelopeLoader(captured(facts,entries),PythonBackend.BuiltinSha256),/alias/);
});
test("OpenSSL backend requires complete signed provider domain and unknown backend holds",()=>{
 const provider="/usr/lib/x86_64-linux-gnu/ossl-modules";
 const facts=new Map([["/usr/bin/python3.12",leaf],[provider+"/legacy.so",leaf]]);
 assert.throws(()=>validatePythonEnvelopeLoader(captured(facts),PythonBackend.OpenSsl3),/uncovered OpenSSL/);
 assert.doesNotThrow(()=>validatePythonEnvelopeLoader(captured(facts,[row(provider)]),PythonBackend.OpenSsl3));
 assert.throws(()=>validatePythonEnvelopeLoader(captured(facts,[row(provider),row(provider+"/evil.conf",PythonEnvelopeKind.Data)]),PythonBackend.OpenSsl3),/provider non-ELF/);
 assert.throws(()=>validatePythonEnvelopeLoader(captured(facts),"unknown" as PythonBackend),/unknown native backend/);
});
test("original authority loaderconfig/cache/build-route refusals occur before catalog read or any result",()=>{
 for(const route of ["build","alias","root","readonly","absent","cache"]){let catalogRead=0;const calls:string[]=[];
 const guard=(name:string)=>{calls.push(name);if(name===route)throw new Error("Original guard Held "+route);};
 const authority:ReviewAuthority={catalogSha256:"a".repeat(64),packagesSha256:"b".repeat(64),limits:budget,backend:PythonBackend.OpenSsl3,
 readAuthenticatedCatalog(){catalogRead++;throw new Error("catalog must not be read");},assertAuthenticatedBuildRoutes(){guard("build");},assertOriginalUsrAliases(){guard("alias");},assertOriginalRetainedRoot(){guard("root");},assertOriginalReadonlyNamespace(){guard("readonly");},assertOriginalAbsentPaths(paths){assert(paths.includes("/etc/ld.so.preload")&&paths.includes("/etc/ld.so.cache")&&paths.includes("/etc/ssl/openssl.cnf"));guard("absent");},assertOriginalEmptyReadonlyDirectory(){guard("cache");},revalidateOriginalCustody(){guard("custody");}};
 assert.throws(()=>validatePythonEnvelope(authority),new RegExp("Original guard Held "+route));assert.equal(catalogRead,0);assert(calls.includes(route));
 }
});
test("native census refuses caller-owned fixture before reading candidate content",{skip:process.getuid?.()===0?"root-owned positive census requires separate Linux integration":false},()=>{
 const path=mkdtempSync(join(tmpdir(),"TEST-python-envelope-owner-"));try{mkdirSync(path+"/usr/lib",{recursive:true});assert.throws(()=>capturePythonEnvelope(path,packages,budget),/prefix custody/);}finally{rmSync(path,{recursive:true});}
});

const nativeSkip=process.platform!=="linux"||process.getuid?.()!==0?"requires root-owned Linux TEST fixture; no host interpreter execution":false;
function fixtureCustody(path:string,directory:boolean):void {
 const s=lstatSync(path,{bigint:true});
 assert(s.uid===0n&&s.gid===0n&&!(s.mode&0o022n)&&s.isDirectory()===directory,
  `owned TEST fixture custody ${path}: uid=${s.uid} gid=${s.gid} mode=${(s.mode&0o7777n).toString(8)} directory=${s.isDirectory()}`);
}
function fixtureFile(path:string,bytes:Buffer|string,mode=0o444):void {
 writeFileSync(path,bytes,{mode});chownSync(path,0,0);fixtureCustody(path,false);
}
function fixtureAlias(literal:string,path:string):void {symlinkSync(literal,path);lchownSync(path,0,0);}
function nativeFixture():string {
 const root=mkdtempSync(join(tmpdir(),"TEST-python-envelope-census-"));
 try{
  // Root uid does not imply root gid: TMPDIR can have an inherited setgid group.
  // Normalize only paths just created by this fixture, never TMPDIR or host ancestors.
  chownSync(root,0,0);chmodSync(root,0o700);fixtureCustody(root,true);
  for(const dir of ["/usr","/usr/lib","/usr/lib/python3.12","/usr/lib/x86_64-linux-gnu","/usr/lib64","/usr/bin"]){
   mkdirSync(root+dir,{mode:0o755});chownSync(root+dir,0,0);chmodSync(root+dir,0o755);fixtureCustody(root+dir,true);
  }
  fixtureFile(root+"/usr/lib/python3.12/json.py","# independently authenticated fixture text\n");
  fixtureFile(root+"/usr/bin/python3.12",elf(),0o555);return root;
 }catch(error){rmSync(root,{recursive:true});throw error;}
}
test("complete native census reconciles all candidates and refuses late unknown source/bytecode",{skip:nativeSkip},()=>{
 const root=nativeFixture();try{const initial=capturePythonEnvelope(root,packages,budget);const bytes=Buffer.from(JSON.stringify(initial.catalog));
  const expected=parsePythonEnvelopeCatalog(bytes,hash(bytes),budget);assert.deepEqual(initial.catalog,expected);
  assert(initial.catalog.entries.some(e=>e.path==="/usr/lib/python3.12/json.py"&&e.kind===PythonEnvelopeKind.Source));
  for(const [uid,gid,mode] of [[1,0,0o700],[0,1,0o700],[0,0,0o722]] as const){
   try{chownSync(root,uid,gid);chmodSync(root,mode);assert.throws(()=>capturePythonEnvelope(root,packages,budget),/prefix custody/);}
   finally{chownSync(root,0,0);chmodSync(root,0o700);fixtureCustody(root,true);}
  }
  fixtureFile(root+"/usr/lib/python3.12/z-unknown.py","# unknown late candidate\n");const changed=capturePythonEnvelope(root,packages,budget);assert.notDeepEqual(changed.catalog,expected);
  fixtureFile(root+"/usr/lib/python3.12/z-unknown.pyc",Buffer.from([0,0,0,0]));assert.throws(()=>capturePythonEnvelope(root,packages,budget),/competing bytecode/);
 }finally{rmSync(root,{recursive:true});}
});
test("native complete EOF is mandatory at exact entry/byte limits and aliases cannot escape",{skip:nativeSkip},()=>{
 const root=nativeFixture();try{const initial=capturePythonEnvelope(root,packages,budget),m=initial.measurement;
  assert.doesNotThrow(()=>capturePythonEnvelope(root,packages,{...budget,entries:m.entries,bytes:m.bytes,fileBytes:m.largestFile,depth:m.depth}));
  assert.throws(()=>capturePythonEnvelope(root,packages,{...budget,entries:m.entries-1}),/entry\/depth limit/);
  assert.throws(()=>capturePythonEnvelope(root,packages,{...budget,bytes:m.bytes-1}),/total\/file byte limit|file bound/);
  fixtureAlias("/tmp/foreign.py",root+"/usr/lib/python3.12/foreign.py");assert.throws(()=>capturePythonEnvelope(root,packages,budget),/alias escape/);
 }finally{rmSync(root,{recursive:true});}
});
test("native candidate metadata refuses hardlinks and writable source even with matching content",{skip:nativeSkip},()=>{
 const root=nativeFixture();try{chmodSync(root+"/usr/lib/python3.12/json.py",0o666);assert.throws(()=>capturePythonEnvelope(root,packages,budget),/metadata\/mount\/owner/);chmodSync(root+"/usr/lib/python3.12/json.py",0o444);linkSync(root+"/usr/lib/python3.12/json.py",root+"/usr/lib/python3.12/hard.py");assert.throws(()=>capturePythonEnvelope(root,packages,budget),/hardlink/);}
 finally{rmSync(root,{recursive:true});}
});

test("ELF interpreter route is fixed and full signed loader alias is mandatory",()=>{
 const withInterpreter=(path:string)=>{const b=elf();b.writeUInt16LE(3,56);b.writeUInt32LE(3,176);b.writeBigUInt64LE(896n,184);const text=Buffer.from(path+"\0");b.writeBigUInt64LE(BigInt(text.length),208);b.set(text,896);return b;};
 assert.throws(()=>parsePythonEnvelopeElf(withInterpreter("/tmp/foreign-loader")),/interpreter escape/);
 const facts=new Map([["/usr/bin/python3.12",parsePythonEnvelopeElf(withInterpreter("/lib64/ld-linux-x86-64.so.2"))],["/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",leaf]]);
 assert.throws(()=>validatePythonEnvelopeLoader(captured(facts),PythonBackend.BuiltinSha256),/missing alias target/);
 assert.doesNotThrow(()=>validatePythonEnvelopeLoader(captured(facts,[row("/usr/lib64/ld-linux-x86-64.so.2",PythonEnvelopeKind.Alias,0,"/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2")]),PythonBackend.BuiltinSha256));
});
test("complete catalog count is governed by trusted measured limits, not selected module cap256",()=>{
 const entries=Array.from({length:300},(_,i)=>row("/usr/lib/python3.12/module"+String(i).padStart(3,"0")+".py",PythonEnvelopeKind.Source));
 const bytes=Buffer.from(JSON.stringify({schemaVersion:1,packages,entries}));
 const measured={...budget,entries:entries.length,catalogBytes:bytes.length};assert.equal(parsePythonEnvelopeCatalog(bytes,hash(bytes),measured).entries.length,300);
 assert.throws(()=>parsePythonEnvelopeCatalog(bytes,hash(bytes),{...measured,entries:299}),/schema\/count/);
});

test("a guard returning after the measured deadline cannot proceed to catalog read",()=>{
 let catalogRead=0;const authority:ReviewAuthority={catalogSha256:"a".repeat(64),packagesSha256:"b".repeat(64),limits:{...budget,elapsedMs:1},backend:PythonBackend.BuiltinSha256,
 readAuthenticatedCatalog(){catalogRead++;throw new Error("late catalog");},
 assertAuthenticatedBuildRoutes(){const end=process.hrtime.bigint()+5000000n;while(process.hrtime.bigint()<end){}},
 assertOriginalUsrAliases(){},assertOriginalRetainedRoot(){},assertOriginalReadonlyNamespace(){},assertOriginalAbsentPaths(){},assertOriginalEmptyReadonlyDirectory(){},revalidateOriginalCustody(){}};
 assert.throws(()=>validatePythonEnvelope(authority),/validation deadline/);assert.equal(catalogRead,0);
});

test("signed extraction public census cannot select the private original live namespace",()=>{
 assert.throws(()=>capturePythonEnvelope("",packages,budget),/noncanonical path/);
 assert.throws(()=>capturePythonEnvelope("/",packages,budget),/noncanonical path/);
});

test("bytecode/archive aliases cannot hide signed bytes behind another suffix",()=>{
 const payload=row("/usr/lib/payload.dat",PythonEnvelopeKind.Data,4),alias=row("/usr/lib/shadow.pyc",PythonEnvelopeKind.Alias,4,"/usr/lib/payload.dat");
 for(const suffix of ["pyc","pyo","zip"]){const renamed={...alias,path:"/usr/lib/shadow."+suffix};const c={schemaVersion:1,packages,entries:[payload,renamed]};const bytes=Buffer.from(JSON.stringify(c));
  assert.throws(()=>parsePythonEnvelopeCatalog(bytes,hash(bytes),budget),/competing bytecode\/archive/);
  assert.throws(()=>validatePythonEnvelopeLoader(captured(new Map(),[payload,renamed]),PythonBackend.BuiltinSha256),/competing bytecode\/archive/);
 }
 for(const path of ["/usr/lib/shadow.py","/usr/lib/shadow.so"]){assert.throws(()=>validatePythonEnvelopeLoader(captured(new Map(),[payload,{...alias,path}]),PythonBackend.BuiltinSha256),/alias type/);}
});
test("alias literal size participates in file bound and largest-file measurement",{skip:nativeSkip},()=>{
 const root=nativeFixture();try{const literal="./".repeat(600)+"json.py";fixtureAlias(literal,root+"/usr/lib/python3.12/alias.py");
  const result=capturePythonEnvelope(root,packages,budget);assert.equal(result.measurement.largestFile,Buffer.byteLength(literal));
  const bytes=Buffer.from(JSON.stringify(result.catalog));assert.doesNotThrow(()=>parsePythonEnvelopeCatalog(bytes,hash(bytes),{...budget,fileBytes:result.measurement.largestFile}));
  assert.throws(()=>capturePythonEnvelope(root,packages,{...budget,fileBytes:Buffer.byteLength(literal)-1}),/alias length\/file limit/);
  fixtureAlias("json.py",root+"/usr/lib/python3.12/shadow.pyc");assert.throws(()=>capturePythonEnvelope(root,packages,budget),/competing bytecode\/archive/);
 }finally{rmSync(root,{recursive:true});}
});
