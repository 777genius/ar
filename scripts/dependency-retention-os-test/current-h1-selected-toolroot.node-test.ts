import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import * as fs from "node:fs";
import mutableFs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {FixedGnuMemberKind as Kind,readFixedGnuBasicMembers} from "./current-h1-archive-members-TEST.ts";
import {FixedH1Normalization,FixedH1Role,FixedH1Disposition} from "./current-h1-archive-path-graph-TEST.ts";
import {retainOriginalAcquiredArchive,ToolInputArchitecture} from "./current-h1-tool-inputs-package.ts";
import {materializeFixedH1SelectedToolrootData} from "./current-h1-selected-toolroot-TEST.ts";
import {writeOwnedSelectedToolrootData,SelectedPhysicalHeld,SelectedPhysicalHold,SelectedOutputOrigin as Origin,SelectedTransformation as Transform,selectedRecipeSha256,type SelectedFilesystemInput,type SelectedOutputRow} from "./current-h1-selected-toolroot-filesystem-TEST.ts";
const hash=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex"),sourceSha="6dd8c978dd0b8a9beb02929c286a4fb6cfb57a6b";
const rootOnly={skip:process.platform!=="linux"||process.getuid?.()!==0||process.getgid?.()!==0};
const emptyGraph=Object.freeze({schemaVersion:1 as const,role:FixedH1Role.PythonNsenter,packageVectorSha256:hash("unsigned-negative"),archives:[],roots:[],nodes:[],aliases:[],selected:[],unselected:[],disposition:FixedH1Disposition.AwaitingPhysicalRecipe,nativeQualified:false as const,physicalRootCreated:false as const,selectedPlanExecutable:false as const});
const provenance=()=>({sourceSha,packageVectorSha256:hash("UNSIGNED-MECHANICS"),recipeSha256:selectedRecipeSha256,graph:{bytes:0,sha256:hash(""),nodes:0},selection:{bytes:0,sha256:hash(""),selected:0},memberRecords:[],archives:[],unselected:[],heldObjects:[],rootSentinels:[]});
const badRow=(path:string):SelectedOutputRow=>({path,kind:Kind.Directory,origin:Origin.Archive,transformation:Transform.Identity,origins:[],mode:0o755,mtime:0,outputLiteral:""});
test("selected main refuses incomplete fixed image before filesystem writes",async()=>{
 const own=fs.mkdtempSync(join(tmpdir(),"TEST-H1-selected-main-negative-"));
 try{await assert.rejects(materializeFixedH1SelectedToolrootData({sourceSha,scratch:own,evidence:own,deadline:performance.now()+1000,originals:[],graph:emptyGraph,graphBytes:Buffer.from(""),selectionBytes:Buffer.from("")}),/exact original archive count/);assert.deepEqual(fs.readdirSync(own),[]);}finally{fs.rmSync(own,{recursive:true});}
});
test("selected filesystem refuses unsafe namespace budget and expired deadline before any anchor",async()=>{
 const base:SelectedFilesystemInput={sourceSha,scratch:"/must-not-be-opened",evidence:"/must-not-be-opened",deadline:performance.now()+1000,originals:[],rows:[],provenance:provenance()};
 await assert.rejects(writeOwnedSelectedToolrootData({...base,rows:Array.from({length:1056},()=>badRow("usr"))}),e=>e instanceof SelectedPhysicalHeld&&e.reason===SelectedPhysicalHold.Budget);
 await assert.rejects(writeOwnedSelectedToolrootData({...base,deadline:0}),e=>e instanceof SelectedPhysicalHeld&&e.reason===SelectedPhysicalHold.Deadline);
 for(const path of ["/etc/outside","usr/../outside","usr/lib//x","usr/share/secret","usr/bin/su"]){await assert.rejects(writeOwnedSelectedToolrootData({...base,rows:[badRow(path)]}),e=>e instanceof SelectedPhysicalHeld&&e.reason===SelectedPhysicalHold.Namespace);}
});
test("selected filesystem refuses hidden JSON hooks getters and proxies without invoking them",async()=>{
 let calls=0;const base:SelectedFilesystemInput={sourceSha,scratch:"/must-not-be-opened",evidence:"/must-not-be-opened",deadline:performance.now()+1000,originals:[],rows:[badRow("usr")],provenance:provenance()};
 const hidden=badRow("usr");Object.defineProperty(hidden,"toJSON",{value:()=>{calls++;return {};}});
 const getter=badRow("usr");Object.defineProperty(getter,"path",{enumerable:true,get:()=>{calls++;return "usr";}});
 const proxy=new Proxy([badRow("usr")],{get:()=>{calls++;throw new Error("must not invoke");},ownKeys:()=>{calls++;throw new Error("must not invoke");}});
 for(const rows of [[hidden],[getter],proxy])await assert.rejects(writeOwnedSelectedToolrootData({...base,rows}),e=>e instanceof SelectedPhysicalHeld&&e.reason===SelectedPhysicalHold.Plan);
 const input={...base};Object.defineProperty(input,"deadline",{enumerable:true,get:()=>{calls++;return performance.now()+1000;}});await assert.rejects(writeOwnedSelectedToolrootData(input),SelectedPhysicalHeld);assert.equal(calls,0);
});

/** Small new unsigned inert archive/stream files test filesystem mechanics only.
 * No fixture carries the real signed41 vector or passes fixed-image admission. */
function fixture(){
 const own=fs.mkdtempSync(join(tmpdir(),"TEST-H1-selected-fs-")),scratch=join(own,"scratch"),evidence=join(own,"evidence");
 fs.mkdirSync(scratch,{mode:0o700});fs.mkdirSync(evidence,{mode:0o700});
 const seeds:{path:string;kind:Kind;payload?:string;link?:string;mtime?:number}[]=[
  ...["usr","usr/lib","usr/lib64","usr/lib/python3.12","usr/lib/x86_64-linux-gnu","etc","etc/python3.12"].map(path=>({path,kind:Kind.Directory})),
  {path:"usr",kind:Kind.Directory,mtime:321},
  {path:"etc/python3.12/sitecustomize.py",kind:Kind.Regular,payload:"TEST inert site\n"},
  {path:"usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",kind:Kind.Regular,payload:"TEST inert loader\n"},
  {path:"usr/lib/python3.12/sitecustomize.py",kind:Kind.Symlink,link:"/etc/python3.12/sitecustomize.py"},
  {path:"usr/lib64/ld-linux-x86-64.so.2",kind:Kind.Symlink,link:"../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"}];
 const chunks:Buffer[]=[];
 for(const seed of seeds){
  const payload=Buffer.from(seed.payload??""),header=Buffer.alloc(512),mode=seed.kind===Kind.Directory?0o755:seed.kind===Kind.Symlink?0o777:0o644;
  header.write("./"+seed.path,0,"ascii");
  const octal=(at:number,len:number,n:number)=>header.write(n.toString(8).padStart(len-1,"0")+"\0",at,"ascii");
  octal(100,8,mode);octal(108,8,0);octal(116,8,0);octal(124,12,payload.length);octal(136,12,seed.mtime??123);
  header.fill(32,148,156);header[156]=seed.kind===Kind.Directory?53:seed.kind===Kind.Symlink?50:48;
  header.write(seed.link??"",157,"ascii");Buffer.from([117,115,116,97,114,32,32,0]).copy(header,257);
  const checksum=header.reduce((a,b)=>a+b,0);header.write(checksum.toString(8).padStart(6,"0")+"\0 ",148,"ascii");
  chunks.push(header,payload,Buffer.alloc((512-payload.length%512)%512));
 }
 chunks.push(Buffer.alloc(1024));const bytes=Buffer.concat(chunks),path=join(scratch,"unsigned-inert-archive.data");fs.writeFileSync(path,bytes,{mode:0o600,flag:"wx"});
 const archive=retainOriginalAcquiredArchive(path,()=>{}),pkg=Object.freeze({package:"unsigned-mechanics",version:"1",arch:ToolInputArchitecture.Amd64,sha256:archive.sha256,size:archive.size,filename:"pool/main/u/unsigned-mechanics/unsigned-mechanics_1_amd64.deb"});
 const members=readFixedGnuBasicMembers(bytes,pkg,{sha256:hash(bytes),bytes:bytes.length,archiveSha256:archive.sha256,archiveBytes:archive.size},performance.now()+1000);
 const merged=new Map<string,SelectedOutputRow>();members.rows.forEach((row,i)=>{const seed=seeds[i];assert(seed);const rewrite=seed.path==="usr/lib/python3.12/sitecustomize.py",origin=Object.freeze({archiveSha256:archive.sha256,streamSha256:hash(bytes),row,normalization:FixedH1Normalization.DotPrefix}),previous=merged.get(seed.path);if(previous){assert.equal(row.kind,Kind.Directory);merged.set(seed.path,Object.freeze({...previous,origins:Object.freeze([...previous.origins,origin])}));}else merged.set(seed.path,Object.freeze({path:seed.path,kind:row.kind,origin:Origin.Archive,transformation:rewrite?Transform.SitecustomizeRelative:Transform.Identity,origins:Object.freeze([origin]),mode:row.mode,mtime:row.kind===Kind.Directory?0:row.mtime,outputLiteral:row.kind===Kind.Symlink?rewrite?"../../../etc/python3.12/sitecustomize.py":seed.link??"":""}));});const rows=[...merged.values()];
 rows.push(Object.freeze({path:"lib64",kind:Kind.Symlink,origin:Origin.Recipe,transformation:Transform.LoaderNamespace,origins:[],mode:0o777,mtime:0,outputLiteral:"usr/lib64"}));
 const input:SelectedFilesystemInput={sourceSha,scratch,evidence,deadline:performance.now()+10000,originals:[{archive,bytes,members}],rows:Object.freeze(rows),provenance:provenance()};
 return {own,path,bytes,archive,members,input,root:join(scratch,"h1-selected-toolroot-TEST"),close(){archive.close();fs.rmSync(own,{recursive:true});}};
}
test("selected ROOT mechanics writes exact content mode time rewrite and distinct recipe provenance",rootOnly,async()=>{
 const f=fixture();try{
  const result=await writeOwnedSelectedToolrootData(f.input);assert.equal(result.fixedImageQualified,false);assert.equal(result.nativeQualified,false);assert.equal(result.measurement.objects,13);
  assert.equal(fs.readFileSync(join(f.root,"etc/python3.12/sitecustomize.py"),"utf8"),"TEST inert site\n");
  assert.equal(fs.readlinkSync(join(f.root,"usr/lib/python3.12/sitecustomize.py")),"../../../etc/python3.12/sitecustomize.py");assert.equal(fs.readlinkSync(join(f.root,"lib64")),"usr/lib64");
  assert.equal(fs.statSync(f.root,{bigint:true}).mtimeNs,0n);const regular=fs.lstatSync(join(f.root,"etc/python3.12/sitecustomize.py"),{bigint:true});assert.equal(regular.mode&0o7777n,0o644n);assert.equal(regular.mtimeNs,123000000000n);assert.equal(regular.nlink,1n);
  const body=JSON.parse(fs.readFileSync(join(f.input.evidence,"selected-toolroot-source-output-UNADMITTED.json"),"utf8")) as {rows:{path:string;origin:string;origins:{row:{mtime:number}}[];originalLiterals:{base64:string}[];outputLiteral:string}[]};
  const generated=body.rows.find(r=>r.path==="lib64"),site=body.rows.find(r=>r.path==="usr/lib/python3.12/sitecustomize.py");assert(generated&&site);assert.equal(generated.origin,"recipe-data");assert.deepEqual(generated.origins,[]);assert.equal(Buffer.from(site.originalLiterals[0]!.base64,"base64").toString(),"/etc/python3.12/sitecustomize.py");assert.equal(site.outputLiteral,"../../../etc/python3.12/sitecustomize.py");
  assert.deepEqual(body.rows.find(r=>r.path==="usr")?.origins.map(o=>o.row.mtime),[123,321]);assert.equal(fs.lstatSync(join(f.root,"usr"),{bigint:true}).mtimeNs,0n);
  assert.deepEqual(fs.readdirSync(f.input.evidence).sort(),result.records.map(r=>r.name).sort());for(const r of result.records){const b=fs.readFileSync(join(f.input.evidence,r.name));assert.equal(b.length,r.bytes);assert.equal(hash(b),r.sha256);}
 }finally{f.close();}
});
test("selected ROOT mechanics rejects equal-byte archive replacement and existing root without reuse",rootOnly,async()=>{
 for(const replace of [false,true]){const f=fixture();try{if(replace){fs.renameSync(f.path,f.path+".original");fs.writeFileSync(f.path,f.bytes,{flag:"wx",mode:0o600});}else fs.mkdirSync(f.root,{mode:0o700});await assert.rejects(writeOwnedSelectedToolrootData(f.input),SelectedPhysicalHeld);assert.deepEqual(fs.readdirSync(f.input.evidence),[]);assert.equal(fs.existsSync(f.root),!replace);}finally{f.close();}}
});
test("selected ROOT mechanics vetoes original slice mutation after yield with held partial output",rootOnly,async()=>{
 const f=fixture();try{
  const pending=writeOwnedSelectedToolrootData(f.input);setImmediate(()=>{const row=f.members.rows.find(r=>r.kind===Kind.Regular);assert(row);f.bytes[row.payloadOffset]=(f.bytes[row.payloadOffset]??0)^1;});
  await assert.rejects(pending,SelectedPhysicalHeld);assert(!fs.existsSync(join(f.input.evidence,"selected-toolroot-materialization-UNADMITTED.json")));assert.doesNotThrow(()=>f.archive.rejoin());
 }finally{f.close();}
});
test("selected ROOT mechanics observes real signal cancellation at built-in yield and closes owned handles",rootOnly,async()=>{
 const f=fixture(),before=fs.readdirSync("/proc/self/fd").length,term=process.listenerCount("SIGTERM");try{
  const pending=writeOwnedSelectedToolrootData(f.input);setImmediate(()=>process.kill(process.pid,"SIGTERM"));await assert.rejects(pending,e=>e instanceof SelectedPhysicalHeld&&e.reason===SelectedPhysicalHold.Cancelled);
  assert.equal(process.listenerCount("SIGTERM"),term);assert.equal(fs.readdirSync("/proc/self/fd").length,before);assert.deepEqual(fs.readdirSync(f.input.evidence),[]);assert.doesNotThrow(()=>f.archive.rejoin());
 }finally{f.close();}
});
test("selected ROOT mechanics detects output substitution extra entries and unsafe alias plans",rootOnly,async()=>{
 const f=fixture();try{
  const pending=writeOwnedSelectedToolrootData(f.input);const inject=()=>{if(fs.existsSync(f.root)){fs.writeFileSync(join(f.root,"extra"),"TEST extra",{flag:"wx"});}else setImmediate(inject);};setImmediate(inject);
  await assert.rejects(pending,SelectedPhysicalHeld);assert(fs.existsSync(join(f.root,"extra")));assert(!fs.existsSync(join(f.input.evidence,"selected-toolroot-materialization-UNADMITTED.json")));
 }finally{f.close();}
 const g=fixture();try{const rows=g.input.rows.map(r=>r.kind===Kind.Symlink&&r.origin===Origin.Archive?{...r,outputLiteral:"/etc/host-sentinel"}:r);await assert.rejects(writeOwnedSelectedToolrootData({...g.input,rows}),e=>e instanceof SelectedPhysicalHeld&&e.reason===SelectedPhysicalHold.Plan);assert(!fs.existsSync(g.root));}finally{g.close();}
 for(const replace of [false,true]){const h=fixture();let injected=false;try{
  const pending=writeOwnedSelectedToolrootData(h.input),target=join(h.input.evidence,"selected-toolroot-source-output-UNADMITTED.json");
  const inject=()=>{if(fs.existsSync(target)){injected=true;if(replace){const b=fs.readFileSync(target);fs.renameSync(target,target+".held");fs.writeFileSync(target,b,{mode:0o600,flag:"wx"});}else fs.appendFileSync(target,"TEST corrupt");}else setImmediate(inject);};setImmediate(inject);
  await assert.rejects(pending,e=>e instanceof SelectedPhysicalHeld&&(e.reason===SelectedPhysicalHold.Identity||e.reason===SelectedPhysicalHold.Content));assert(injected);assert(!fs.existsSync(join(h.input.evidence,"selected-toolroot-materialization-UNADMITTED.json")));assert.doesNotThrow(()=>h.archive.rejoin());
 }finally{h.close();}}
});
test("selected ROOT mechanics refuses substituted retained parent and preserves outside TEST sentinel",rootOnly,async()=>{
 const f=fixture(),outside=join(f.own,"outside-TEST");fs.mkdirSync(outside,{mode:0o700});fs.writeFileSync(join(outside,"sentinel"),"TEST unchanged",{mode:0o600});
 try{
  const pending=writeOwnedSelectedToolrootData(f.input);const inject=()=>{const usr=join(f.root,"usr");if(fs.existsSync(usr)){fs.renameSync(usr,join(f.root,"usr-held"));fs.symlinkSync(outside,usr);}else setImmediate(inject);};setImmediate(inject);
  await assert.rejects(pending,e=>e instanceof SelectedPhysicalHeld&&e.reason===SelectedPhysicalHold.Identity);assert.deepEqual(fs.readdirSync(outside),["sentinel"]);assert.equal(fs.readFileSync(join(outside,"sentinel"),"utf8"),"TEST unchanged");assert(!fs.existsSync(join(f.input.evidence,"selected-toolroot-materialization-UNADMITTED.json")));
 }finally{f.close();}
});
test("selected ROOT mechanics holds on real write fsync readback and post-I/O deadline faults",rootOnly,async()=>{
 for(const fault of ["write","fsync","readback","deadline","source-after-write","time","cleanup-deadline"] as const){
  const f=fixture(),before=fs.readdirSync("/proc/self/fd").length;
  const originalWrite=mutableFs.writeSync,originalSync=mutableFs.fsyncSync,originalRead=mutableFs.readSync;
  let fired=false;
  try{
   if(fault==="write")mutableFs.writeSync=((...args:Parameters<typeof originalWrite>)=>{fired=true;return 0;}) as typeof originalWrite;
   if(fault==="source-after-write")mutableFs.writeSync=((...args:Parameters<typeof originalWrite>)=>{const n=originalWrite(...args);if(!fired&&n>0){fired=true;const row=f.members.rows.find(r=>r.kind===Kind.Regular);assert(row);f.bytes[row.payloadOffset]=(f.bytes[row.payloadOffset]??0)^1;}return n;}) as typeof originalWrite;
   if(fault==="fsync")mutableFs.fsyncSync=((fd:number)=>{if(!fired){fired=true;throw new Error("injected owned fsync failure");}return originalSync(fd);});
   if(fault==="time")mutableFs.fsyncSync=((fd:number)=>{originalSync(fd);if(!fired&&mutableFs.fstatSync(fd).isFile()){fired=true;mutableFs.futimesSync(fd,456,456);}});
   if(fault==="cleanup-deadline")mutableFs.fsyncSync=((fd:number)=>{originalSync(fd);if(!fired&&mutableFs.fstatSync(fd).isDirectory()&&fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(f.root+"/")&&fs.existsSync(join(f.input.evidence,"selected-toolroot-materialization-UNADMITTED.json"))){fired=true;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);}});
   if(fault==="readback"||fault==="deadline")mutableFs.readSync=((...args:Parameters<typeof originalRead>)=>{const n=originalRead(...args);if(!fired&&n>0){fired=true;if(fault==="deadline")Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);else {const b=args[1];assert(Buffer.isBuffer(b));b[0]=(b[0]??0)^1;}}return n;}) as typeof originalRead;
   syncBuiltinESMExports();
   await assert.rejects(writeOwnedSelectedToolrootData({...f.input,deadline:performance.now()+(fault==="deadline"||fault==="cleanup-deadline"?200:10000)}),e=>e instanceof SelectedPhysicalHeld&&(fault!=="cleanup-deadline"||e.reason===SelectedPhysicalHold.Deadline));
   assert(fired);assert.equal(fs.existsSync(join(f.input.evidence,"selected-toolroot-materialization-UNADMITTED.json")),fault==="cleanup-deadline");assert.equal(fs.readdirSync("/proc/self/fd").length,before);
  }finally{mutableFs.writeSync=originalWrite;mutableFs.fsyncSync=originalSync;mutableFs.readSync=originalRead;syncBuiltinESMExports();f.close();}
 }
});
