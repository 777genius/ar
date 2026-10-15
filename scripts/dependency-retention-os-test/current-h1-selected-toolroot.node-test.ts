import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import mutableCrypto from "node:crypto";
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
import {writeOwnedSelectedToolrootData,readSelectedPhysicalHoldFacts,SelectedPhysicalHeld, SelectedPhysicalIdentitySite,SelectedPhysicalHold,SelectedPhysicalPhase,SelectedOutputOrigin as Origin,SelectedTransformation as Transform,selectedRecipeSha256,type SelectedFilesystemInput,type SelectedOutputRow} from "./current-h1-selected-toolroot-filesystem-TEST.ts";
const hash=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex"),sourceSha="6dd8c978dd0b8a9beb02929c286a4fb6cfb57a6b";
const rootOnly={skip:process.platform!=="linux"||process.getuid?.()!==0||process.getgid?.()!==0};
const emptyGraph=Object.freeze({schemaVersion:1 as const,role:FixedH1Role.PythonNsenter,packageVectorSha256:hash("unsigned-negative"),archives:[],roots:[],nodes:[],aliases:[],selected:[],unselected:[],disposition:FixedH1Disposition.AwaitingPhysicalRecipe,nativeQualified:false as const,physicalRootCreated:false as const,selectedPlanExecutable:false as const});
const provenance=()=>({sourceSha,packageVectorSha256:hash("UNSIGNED-MECHANICS"),recipeSha256:selectedRecipeSha256,graph:{bytes:0,sha256:hash(""),nodes:0},selection:{bytes:0,sha256:hash(""),selected:0},memberRecords:[],archives:[],unselected:[],heldObjects:[],rootSentinels:[]});
const badRow=(path:string):SelectedOutputRow=>({path,kind:Kind.Directory,origin:Origin.Archive,transformation:Transform.Identity,origins:[],mode:0o755,mtime:0,outputLiteral:""});
test("selected main refuses incomplete fixed image before filesystem writes",async()=>{
 const own=fs.mkdtempSync(join(tmpdir(),"TEST-H1-selected-main-negative-"));
 try{await assert.rejects(materializeFixedH1SelectedToolrootData({sourceSha,scratch:own,evidence:own,deadline:performance.now()+1000,originals:[],graph:emptyGraph,graphBytes:Buffer.from(""),selectionBytes:Buffer.from("")}),e=>e instanceof SelectedPhysicalHeld&&e.reason===SelectedPhysicalHold.Unknown&&e.phase===SelectedPhysicalPhase.Input&&e.processedObjects===0&&!e.rootCreated);assert.deepEqual(fs.readdirSync(own),[]);
  await assert.rejects(materializeFixedH1SelectedToolrootData({sourceSha,scratch:own,evidence:own,deadline:0,originals:[],graph:emptyGraph,graphBytes:Buffer.from(""),selectionBytes:Buffer.from("")}),e=>readSelectedPhysicalHoldFacts(e)?.reason===SelectedPhysicalHold.Deadline&&readSelectedPhysicalHoldFacts(e)?.phase===SelectedPhysicalPhase.Input&&readSelectedPhysicalHoldFacts(e)?.processedObjects===0&&!readSelectedPhysicalHoldFacts(e)?.rootCreated);
  let traps=0;const thrown=new Proxy({}, {getPrototypeOf(){traps++;throw new Error("must not invoke");},get(){traps++;throw new Error("must not invoke");},ownKeys(){traps++;throw new Error("must not invoke");}});
  // Invalid empty custody placeholders test only the negative callback catch;
  // they cannot pass source/vector/graph or create a physical root.
  const invalidOriginal={archive:Object.freeze({rejoin(){throw thrown;}}),bytes:Buffer.alloc(0),members:{}} as unknown as SelectedFilesystemInput["originals"][number];
  await assert.rejects(materializeFixedH1SelectedToolrootData({sourceSha,scratch:own,evidence:own,deadline:performance.now()+1000,originals:Array.from({length:41},()=>invalidOriginal),graph:emptyGraph,graphBytes:Buffer.alloc(0),selectionBytes:Buffer.alloc(0)}),e=>{assert.equal(traps,0);return readSelectedPhysicalHoldFacts(e)?.reason===SelectedPhysicalHold.Unknown&&readSelectedPhysicalHoldFacts(e)?.phase===SelectedPhysicalPhase.Originals;});
  const proxyAncestor=Object.create(thrown) as object;assert.equal(readSelectedPhysicalHoldFacts(thrown),undefined);assert.equal(readSelectedPhysicalHoldFacts(proxyAncestor),undefined);
  const spoof=Object.create(SelectedPhysicalHeld.prototype) as object;assert.equal(readSelectedPhysicalHoldFacts(spoof),undefined);
  const genuine=new SelectedPhysicalHeld(SelectedPhysicalHold.Content,true,SelectedPhysicalPhase.Regular,7);assert.deepEqual(readSelectedPhysicalHoldFacts(genuine),{reason:SelectedPhysicalHold.Content,rootCreated:true,phase:SelectedPhysicalPhase.Regular,processedObjects:7,identitySite:SelectedPhysicalIdentitySite.Unknown});
  const named=new SelectedPhysicalHeld(SelectedPhysicalHold.Identity,true,SelectedPhysicalPhase.Regular,15,SelectedPhysicalIdentitySite.DirectoryNamed);assert.equal(readSelectedPhysicalHoldFacts(named)?.identitySite,SelectedPhysicalIdentitySite.DirectoryNamed);Object.defineProperty(named,"identitySite",{value:"/PRIVATE/secret"});assert.equal(readSelectedPhysicalHoldFacts(named),undefined);
  const exotic=new SelectedPhysicalHeld(SelectedPhysicalHold.Content,true);Object.defineProperty(exotic,"reason",{get(){traps++;throw new Error("must not invoke");}});assert.equal(readSelectedPhysicalHoldFacts(exotic),undefined);assert.equal(traps,0);assert.deepEqual(fs.readdirSync(own),[]);}finally{fs.rmSync(own,{recursive:true});}
});
test("selected filesystem refuses unsafe namespace budget and expired deadline before any anchor",async()=>{
 const base:SelectedFilesystemInput={sourceSha,scratch:"/must-not-be-opened",evidence:"/must-not-be-opened",deadline:performance.now()+1000,originals:[],rows:[],provenance:provenance()};
 await assert.rejects(writeOwnedSelectedToolrootData({...base,rows:Array.from({length:1056},()=>badRow("usr"))}),e=>e instanceof SelectedPhysicalHeld&&e.reason===SelectedPhysicalHold.Budget);
 await assert.rejects(writeOwnedSelectedToolrootData({...base,deadline:0}),e=>e instanceof SelectedPhysicalHeld&&e.reason===SelectedPhysicalHold.Deadline&&e.phase===SelectedPhysicalPhase.Plan&&e.processedObjects===0&&!e.rootCreated);
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
function fixture(extraRegular=0){
 const own=fs.mkdtempSync(join(tmpdir(),"TEST-H1-selected-fs-")),scratch=join(own,"scratch"),evidence=join(own,"evidence");
 fs.mkdirSync(scratch,{mode:0o700});fs.mkdirSync(evidence,{mode:0o700});
 const seeds:{path:string;kind:Kind;payload?:string;link?:string;mtime?:number}[]=[
  ...["usr","usr/lib","usr/lib64","usr/lib/python3.12","usr/lib/x86_64-linux-gnu","etc","etc/python3.12"].map(path=>({path,kind:Kind.Directory})),
  {path:"usr",kind:Kind.Directory,mtime:321},
  {path:"etc/python3.12/sitecustomize.py",kind:Kind.Regular,payload:"TEST inert site\n"},
  {path:"usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",kind:Kind.Regular,payload:"TEST inert loader\n"},
  {path:"usr/lib/python3.12/sitecustomize.py",kind:Kind.Symlink,link:"/etc/python3.12/sitecustomize.py"},
  {path:"usr/lib64/ld-linux-x86-64.so.2",kind:Kind.Symlink,link:"../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"},
  ...Array.from({length:extraRegular},(_,i)=>({path:"usr/lib/TEST-inert-"+i,kind:Kind.Regular,payload:"TEST row\n"}))];
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
 let originalRejoins=0;const archive=retainOriginalAcquiredArchive(path,()=>{originalRejoins++;}),pkg=Object.freeze({package:"unsigned-mechanics",version:"1",arch:ToolInputArchitecture.Amd64,sha256:archive.sha256,size:archive.size,filename:"pool/main/u/unsigned-mechanics/unsigned-mechanics_1_amd64.deb"});
 const members=readFixedGnuBasicMembers(bytes,pkg,{sha256:hash(bytes),bytes:bytes.length,archiveSha256:archive.sha256,archiveBytes:archive.size},performance.now()+1000);
 const merged=new Map<string,SelectedOutputRow>();members.rows.forEach((row,i)=>{const seed=seeds[i];assert(seed);const rewrite=seed.path==="usr/lib/python3.12/sitecustomize.py",origin=Object.freeze({archiveSha256:archive.sha256,streamSha256:hash(bytes),row,normalization:FixedH1Normalization.DotPrefix}),previous=merged.get(seed.path);if(previous){assert.equal(row.kind,Kind.Directory);merged.set(seed.path,Object.freeze({...previous,origins:Object.freeze([...previous.origins,origin])}));}else merged.set(seed.path,Object.freeze({path:seed.path,kind:row.kind,origin:Origin.Archive,transformation:rewrite?Transform.SitecustomizeRelative:Transform.Identity,origins:Object.freeze([origin]),mode:row.mode,mtime:row.kind===Kind.Directory?0:row.mtime,outputLiteral:row.kind===Kind.Symlink?rewrite?"../../../etc/python3.12/sitecustomize.py":seed.link??"":""}));});const rows=[...merged.values()];
 rows.push(Object.freeze({path:"lib64",kind:Kind.Symlink,origin:Origin.Recipe,transformation:Transform.LoaderNamespace,origins:[],mode:0o777,mtime:0,outputLiteral:"usr/lib64"}));
 const input:SelectedFilesystemInput={sourceSha,scratch,evidence,deadline:performance.now()+10000,originals:[{archive,bytes,members}],rows:Object.freeze(rows),provenance:provenance()};
 return {own,path,bytes,archive,members,input,originalRejoins:()=>originalRejoins,root:join(scratch,"h1-selected-toolroot-TEST"),close(){archive.close();fs.rmSync(own,{recursive:true});}};
}
/** Force the complete-check branch with129 distinct mutable DATA descendants;
 * this inert fixture is never a signed graph or native qualification. */
function fallbackProvenance():SelectedFilesystemInput["provenance"] {
 return {...provenance(),heldObjects:Array.from({length:129},()=>({path:"TEST-inert",chain:[]})) as unknown as SelectedFilesystemInput["provenance"]["heldObjects"]};
}
test("selected entry rejects inherited hooks without invocation",async()=>{
 for(const prototype of [Object.prototype,Array.prototype]){
  let calls=0;const previous=Object.getOwnPropertyDescriptor(prototype,"toJSON");
  try{Object.defineProperty(prototype,"toJSON",{configurable:true,get(){calls++;throw new Error("hook must not run");}});
   await assert.rejects(writeOwnedSelectedToolrootData({} as SelectedFilesystemInput),e=>e instanceof SelectedPhysicalHeld&&e.reason===SelectedPhysicalHold.Plan);assert.equal(calls,0);
  }finally{if(previous)Object.defineProperty(prototype,"toJSON",previous);else Reflect.deleteProperty(prototype,"toJSON");}
 }
});
test("selected ROOT requires exact recursively frozen original member row bindings before anchor",rootOnly,async()=>{
 for(const mutable of [false,true]){const f=fixture();try{
  const original=f.input.rows.find(row=>row.origins.length>0)!;
  const origin=original.origins[0]!,copy={...origin.row};
  const rows=f.input.rows.map(row=>row===original?{...row,origins:[{...origin,row:mutable?copy:Object.freeze(copy)},...row.origins.slice(1)]}:row);
  await assert.rejects(writeOwnedSelectedToolrootData({...f.input,rows}),e=>e instanceof SelectedPhysicalHeld&&e.reason===SelectedPhysicalHold.Origin&&!e.rootCreated);
  assert.deepEqual(fs.readdirSync(f.input.evidence),[]);assert(!fs.existsSync(f.root));
 }finally{f.close();}}
});
test("selected ROOT preserves every object yield and live joins with one detached plan canonicalization",rootOnly,async()=>{
 const f=fixture(24),originalHash=mutableCrypto.createHash,originalStat=mutableFs.fstatSync;let planPasses=0,planBytes=0,statCalls=0,yields=0,running=true,siblingMutated=false;
 const sharedAncestor=fs.lstatSync(f.own,{bigint:true}),sibling=join(f.own,"TEST-unrelated-sibling");
 const before=f.originalRejoins(),countYield=()=>{if(running){yields++;setImmediate(countYield);}};
 try{
  mutableCrypto.createHash=((...args:Parameters<typeof originalHash>)=>{const h=originalHash(...args),update=h.update.bind(h);
   h.update=((data:Parameters<typeof h.update>[0],encoding?:Parameters<typeof h.update>[1])=>{const b=typeof data==="string"?Buffer.from(data):Buffer.isBuffer(data)?data:undefined;
    if(b?.subarray(0,8).equals(Buffer.from('{"rows":'))){planPasses++;planBytes+=b.length;}return encoding===undefined?update(data):update(data,encoding);}) as typeof h.update;return h;
  }) as typeof originalHash;
  mutableFs.fstatSync=((...args:Parameters<typeof originalStat>)=>{statCalls++;const sampled=originalStat(...args);
   if(!siblingMutated&&sampled.dev===sharedAncestor.dev&&sampled.ino===sharedAncestor.ino&&fs.existsSync(f.root)){
    // The original fstat has already sampled the real retained fixture ancestor.
    // Change only an unrelated sibling before checkDirectory's original lstat.
    siblingMutated=true;fs.mkdirSync(sibling,{mode:0o700});const changed=originalStat(...args);
    assert.equal(changed.ino,sampled.ino);assert.equal(changed.dev,sampled.dev);assert.equal(changed.mode,sampled.mode);
    assert.equal(changed.uid,sampled.uid);assert.equal(changed.gid,sampled.gid);assert.equal(typeof sampled.nlink,"bigint");assert.equal(changed.nlink,BigInt(sampled.nlink)+1n);
   }return sampled;
  }) as typeof originalStat;syncBuiltinESMExports();setImmediate(countYield);
  let result:Awaited<ReturnType<typeof writeOwnedSelectedToolrootData>>;
  try { result=await writeOwnedSelectedToolrootData(f.input); }
  catch(error) {
   const facts=readSelectedPhysicalHoldFacts(error);
   if(facts)process.stderr.write(JSON.stringify({test:"selected-root-positive-canonicalization",...facts})+"\n");
   throw error;
  }
  assert.equal(planPasses,1,"old joinAll recanonicalizes the entire plan at each real checkpoint");
  assert.equal(planBytes,Buffer.byteLength(JSON.stringify({rows:[...f.input.rows].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),provenance:f.input.provenance})),"byte work is exactly one canonical plan body");
  const minimum=2+7+2+24+3+8;assert(yields>=minimum);assert(f.originalRejoins()-before>=minimum*2);assert(statCalls>=minimum*2);
  assert(siblingMutated,"real ancestry mutation must occur inside the retained fstat/lstat window");assert(fs.lstatSync(sibling).isDirectory());
  assert.equal(result.measurement.objects,37);assert.equal(result.fixedImageQualified,false);
  const body=JSON.parse(fs.readFileSync(join(f.input.evidence,"selected-toolroot-source-output-UNADMITTED.json"),"utf8")) as {rows:SelectedOutputRow[];provenance:SelectedFilesystemInput["provenance"]};
  assert.deepEqual(body.rows.map(row=>row.path),f.input.rows.map(row=>row.path).sort());assert.deepEqual(body.provenance,f.input.provenance);
 }finally{running=false;mutableCrypto.createHash=originalHash;mutableFs.fstatSync=originalStat;syncBuiltinESMExports();f.close();}
});
test("selected ROOT detects nested caller mutations at real yields including frozen parents and complete fallback",rootOnly,async()=>{
 for(const mutation of ["graph","selection","held-array","frozen-parent","fallback","proxy","getter","hook","cycle","prototype","keys"] as const){
  const f=fixture();let calls=0;const p=mutation==="fallback"?fallbackProvenance():provenance();
  const child={path:"TEST-inert",chain:[] as string[]};if(mutation==="frozen-parent")Reflect.set(p,"heldObjects",[Object.freeze(child)]);
  try{const pending=writeOwnedSelectedToolrootData({...f.input,provenance:p});setImmediate(()=>{
    if(mutation==="graph"||mutation==="selection")Reflect.set(p[mutation],"bytes",1);
    else if(mutation==="held-array")Reflect.set(p.heldObjects,"0",{path:"late"});
    else if(mutation==="frozen-parent")child.chain.push("late");
    else if(mutation==="fallback")Reflect.set(p.heldObjects[128]!,"path","late");
    else if(mutation==="proxy")Reflect.set(p,"graph",new Proxy({}, {get(){calls++;throw new Error("no trap");},ownKeys(){calls++;throw new Error("no trap");},getPrototypeOf(){calls++;throw new Error("no trap");}}));
    else if(mutation==="getter")Object.defineProperty(p.graph,"bytes",{enumerable:true,get(){calls++;throw new Error("no getter");}});
    else if(mutation==="hook")Object.defineProperty(p.graph,"toJSON",{value(){calls++;throw new Error("no hook");}});
    else if(mutation==="cycle")Reflect.set(p.graph,"loop",p.graph);
    else if(mutation==="prototype")Object.setPrototypeOf(p.heldObjects,new Proxy({}, {get(){calls++;throw new Error("no trap");},getPrototypeOf(){calls++;throw new Error("no trap");}}));
    else Object.defineProperty(p.graph,"hidden",{value:1});
   });await assert.rejects(pending,e=>e instanceof SelectedPhysicalHeld&&e.reason===SelectedPhysicalHold.Plan);assert.equal(calls,0);assert.deepEqual(fs.readdirSync(f.input.evidence),[]);
  }finally{f.close();}
 }
});
test("selected ROOT refuses inherited function and getter hooks at optimized fallback and publication windows",rootOnly,async()=>{
 for(const fallback of [false,true])for(const prototype of [Object.prototype,Array.prototype])for(const getter of [false,true])for(const publication of [false,true]){
  const f=fixture(),previous=Object.getOwnPropertyDescriptor(prototype,"toJSON");let calls=0,injected=false,active=true,prior:Buffer|undefined;
  try{const input={...f.input,provenance:fallback?fallbackProvenance():f.input.provenance},pending=writeOwnedSelectedToolrootData(input);
   const inject=()=>{if(!active)return;if(publication&&!fs.existsSync(join(f.input.evidence,"selected-toolroot-source-output-UNADMITTED.json"))){setImmediate(inject);return;}
    if(publication)prior=fs.readFileSync(join(f.input.evidence,"selected-toolroot-source-output-UNADMITTED.json"));
    injected=true;Object.defineProperty(prototype,"toJSON",getter?{configurable:true,get(){calls++;throw new Error("no inherited getter");}}:{configurable:true,value(){calls++;throw new Error("no inherited hook");}});
   };setImmediate(inject);
   await assert.rejects(pending,e=>e instanceof SelectedPhysicalHeld&&e.reason===SelectedPhysicalHold.Plan);assert(injected);assert.equal(calls,0);assert(!fs.existsSync(join(f.input.evidence,"selected-toolroot-materialization-UNADMITTED.json")));
   if(publication){assert(prior);assert(fs.readFileSync(join(f.input.evidence,"selected-toolroot-source-output-UNADMITTED.json")).equals(prior));assert(!fs.existsSync(join(f.input.evidence,"selected-toolroot-physical-UNADMITTED.json")));}
  }finally{active=false;if(previous)Object.defineProperty(prototype,"toJSON",previous);else Reflect.deleteProperty(prototype,"toJSON");f.close();}
 }
});
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
 // The ancestry waiver must never cover a producer-owned finalized directory.
 const output=fixture(),originalStat=mutableFs.fstatSync;let finalizedSamples=0,outputMutated=false;
 try{const target=join(output.root,"usr");mutableFs.fstatSync=((...args:Parameters<typeof originalStat>)=>{
   const sampled=originalStat(...args);
   if(sampled.isDirectory()&&typeof sampled.mode==="bigint"&&(sampled.mode&0o7777n)===0o755n&&"mtimeNs" in sampled&&sampled.mtimeNs===0n&&fs.readlinkSync(`/proc/self/fd/${args[0]}`).toString()===target&&++finalizedSamples===2){
    // First sample is finalize(); second is its immediate checkDirectory fstat.
    outputMutated=true;fs.utimesSync(target,1,1);
   }return sampled;
  }) as typeof originalStat;syncBuiltinESMExports();
  await assert.rejects(writeOwnedSelectedToolrootData(output.input),e=>readSelectedPhysicalHoldFacts(e)?.reason===SelectedPhysicalHold.Identity&&readSelectedPhysicalHoldFacts(e)?.identitySite===SelectedPhysicalIdentitySite.DirectoryNamed);
  assert(outputMutated);assert(!fs.existsSync(join(output.input.evidence,"selected-toolroot-materialization-UNADMITTED.json")));
 }finally{mutableFs.fstatSync=originalStat;syncBuiltinESMExports();output.close();}
});
test("selected ROOT mechanics refuses substituted retained parent and preserves outside TEST sentinel",rootOnly,async()=>{
 const f=fixture(),outside=join(f.own,"outside-TEST");fs.mkdirSync(outside,{mode:0o700});fs.writeFileSync(join(outside,"sentinel"),"TEST unchanged",{mode:0o600});
 try{
  const pending=writeOwnedSelectedToolrootData(f.input);const inject=()=>{const usr=join(f.root,"usr");if(fs.existsSync(usr)){fs.renameSync(usr,join(f.root,"usr-held"));fs.symlinkSync(outside,usr);}else setImmediate(inject);};setImmediate(inject);
  await assert.rejects(pending,e=>e instanceof SelectedPhysicalHeld&&e.reason===SelectedPhysicalHold.Identity);assert.deepEqual(fs.readdirSync(outside),["sentinel"]);assert.equal(fs.readFileSync(join(outside,"sentinel"),"utf8"),"TEST unchanged");assert(!fs.existsSync(join(f.input.evidence,"selected-toolroot-materialization-UNADMITTED.json")));
 }finally{f.close();}
});
test("selected ROOT mechanics holds on real write fsync readback and post-I/O deadline faults",rootOnly,async()=>{
 for(const fault of ["write","throw-proxy","fsync","readback","deadline","source-after-write","time","cleanup-deadline"] as const){
  const f=fixture(),before=fs.readdirSync("/proc/self/fd").length;
  const originalWrite=mutableFs.writeSync,originalSync=mutableFs.fsyncSync,originalRead=mutableFs.readSync;
  let fired=false,trapCalls=0;
  try{
   if(fault==="throw-proxy")mutableFs.writeSync=(()=>{fired=true;throw new Proxy({}, {getPrototypeOf(){trapCalls++;throw new Error("must not invoke");},get(){trapCalls++;throw new Error("must not invoke");}});}) as typeof originalWrite;
   if(fault==="write")mutableFs.writeSync=((...args:Parameters<typeof originalWrite>)=>{fired=true;return 0;}) as typeof originalWrite;
   if(fault==="source-after-write")mutableFs.writeSync=((...args:Parameters<typeof originalWrite>)=>{const n=originalWrite(...args);if(!fired&&n>0){fired=true;const row=f.members.rows.find(r=>r.kind===Kind.Regular);assert(row);f.bytes[row.payloadOffset]=(f.bytes[row.payloadOffset]??0)^1;}return n;}) as typeof originalWrite;
   if(fault==="fsync")mutableFs.fsyncSync=((fd:number)=>{if(!fired){fired=true;throw new Error("injected owned fsync failure");}return originalSync(fd);});
   if(fault==="time")mutableFs.fsyncSync=((fd:number)=>{originalSync(fd);if(!fired&&mutableFs.fstatSync(fd).isFile()){fired=true;mutableFs.futimesSync(fd,456,456);}});
   if(fault==="cleanup-deadline")mutableFs.fsyncSync=((fd:number)=>{originalSync(fd);if(!fired&&mutableFs.fstatSync(fd).isDirectory()&&fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(f.root+"/")&&fs.existsSync(join(f.input.evidence,"selected-toolroot-materialization-UNADMITTED.json"))){fired=true;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);}});
   if(fault==="readback"||fault==="deadline")mutableFs.readSync=((...args:Parameters<typeof originalRead>)=>{const n=originalRead(...args);if(!fired&&n>0){fired=true;if(fault==="deadline")Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);else {const b=args[1];assert(Buffer.isBuffer(b));b[0]=(b[0]??0)^1;}}return n;}) as typeof originalRead;
   syncBuiltinESMExports();
   await assert.rejects(writeOwnedSelectedToolrootData({...f.input,deadline:performance.now()+(fault==="deadline"||fault==="cleanup-deadline"?200:10000)}),e=>e instanceof SelectedPhysicalHeld&&(fault!=="cleanup-deadline"||e.reason===SelectedPhysicalHold.Deadline)&&e.phase===(fault==="cleanup-deadline"?SelectedPhysicalPhase.Cleanup:SelectedPhysicalPhase.Regular)&&e.processedObjects===(fault==="cleanup-deadline"?12:7)&&e.rootCreated&&e.name==="SelectedPhysicalHeld");
   assert(fired);assert.equal(trapCalls,0);assert.equal(fs.existsSync(join(f.input.evidence,"selected-toolroot-materialization-UNADMITTED.json")),fault==="cleanup-deadline");assert.equal(fs.readdirSync("/proc/self/fd").length,before);
  }finally{mutableFs.writeSync=originalWrite;mutableFs.fsyncSync=originalSync;mutableFs.readSync=originalRead;syncBuiltinESMExports();f.close();}
 }
});
