import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {performance} from "node:perf_hooks";
import {mkdtempSync,mkdirSync,writeFileSync,lstatSync,renameSync,rmSync,linkSync,symlinkSync} from "node:fs";
import {h1StagedSubjectData,h1StagedManifestData,retainH1StagedCatalogData,requireQualifiedH1StagedConstructor,H1CatalogKind,H1MountOrigin,H1DistroAssurance} from "./dependency-full-h1-staged-tools-TEST.ts";
const digest="a".repeat(64),boot="11111111-1111-1111-1111-111111111111",synthetic="22222222-2222-2222-2222-222222222222";
const id={dev:"1",ino:"1",mode:"16877",uid:"0",gid:"0",nlink:"2",size:"0",mtimeNs:"1",ctimeNs:"1"};
function mount(path:string,origin:H1MountOrigin,readonly:boolean){return {path,origin,reference:digest,readonly,mountId:path==="/"?"10":"11",parentId:path==="/"?"1":"10",device:"1:2",mountRoot:"/",filesystem:path==="/"?"ext4":"proc",source:path==="/"?"/dev/test":"proc",flags:readonly?"ro,nodev":"rw,nosuid",propagation:"private"};}
function subject(){return {schemaVersion:1,sourceSha:"a".repeat(40),validatorSha256:digest,machineId:"a".repeat(32),bootId:boot,rootIdentity:id,catalog:[{path:"usr",kind:H1CatalogKind.Directory,identity:id,sha256:"",target:""},{path:"usr/tool",kind:H1CatalogKind.File,identity:{...id,mode:"33188",nlink:"1",size:"1"},sha256:digest,target:""},{path:"bin",kind:H1CatalogKind.Alias,identity:{...id,mode:"41471",nlink:"1",size:"3"},sha256:"",target:"usr"}],definitions:{mountAll:digest,mountSysfs:digest,mountCgroups:digest,devSetup:digest,inaccessibleNodes:digest,notify:digest,hostReleaseTransform:digest},mounts:[mount("/",H1MountOrigin.Staged,true),mount("/proc",H1MountOrigin.Kernel,false)],hostRelease:{source:"/etc/os-release",sha256:digest,cells:{container_host_id:"ubuntu"}},syntheticBootId:synthetic};}
function manifest(s:ReturnType<typeof subject>){return {mounts:s.mounts,hostRelease:s.hostRelease,syntheticBootId:s.syntheticBootId};}
test("complete DATA subject and captured manifest never qualify a constructor",()=>{const input=subject(),parsed=h1StagedSubjectData(input);h1StagedManifestData(parsed,manifest(input));assert.throws(requireQualifiedH1StagedConstructor,/selected_constructor_rows_not_qualified/);});
test("unknown fields, kinds and missing selected-build definitions refuse",()=>{assert.throws(()=>h1StagedSubjectData({...subject(),approved:true}));const s=subject();assert.throws(()=>h1StagedSubjectData({...s,catalog:[{...s.catalog[0],kind:"device"}]}));const {notify,...definitions}=s.definitions;assert.equal(notify,digest);assert.throws(()=>h1StagedSubjectData({...s,definitions}));});
test("proxy and accessor DATA refuse without executing getters",()=>{let reads=0;const s=subject();Object.defineProperty(s,"catalog",{enumerable:true,get(){reads++;return [];}});assert.throws(()=>h1StagedSubjectData(s));assert.equal(reads,0);assert.throws(()=>h1StagedSubjectData(new Proxy(subject(),{get(){reads++;throw Error("trap");}})));assert.equal(reads,0);});
test("alias escape, missing target, cycle and duplicate physical roster refuse",()=>{const s=subject(),alias=s.catalog[2];for(const target of ["../outside","missing","bin","/usr"])assert.throws(()=>h1StagedSubjectData({...s,catalog:[...s.catalog.slice(0,2),{...alias,target,identity:{...alias?.identity,size:String(Buffer.byteLength(target))}}]}));assert.throws(()=>h1StagedSubjectData({...s,catalog:[...s.catalog,s.catalog[0]]}));});
test("unknown and executable/config shadow mount rows refuse",()=>{for(const path of ["/usr","/usr/bin","/etc","/etc/ld.so.cache","/run/host/unknown"])assert.throws(()=>h1StagedSubjectData({...subject(),mounts:[...subject().mounts,mount(path,H1MountOrigin.HostData,true)]}));const s=subject(),expected=h1StagedSubjectData(s);assert.throws(()=>h1StagedManifestData(expected,{...manifest(s),mounts:s.mounts.slice(0,1)}));assert.throws(()=>h1StagedManifestData(expected,{...manifest(s),mounts:[...s.mounts,s.mounts[1]]}));assert.throws(()=>h1StagedManifestData(expected,{...manifest(s),mounts:s.mounts.map(m=>({...m,reference:"b".repeat(64)}))}));});
test("HOST release branch, bytes and actual cells stay separate and exact",()=>{const s=subject(),expected=h1StagedSubjectData(s);for(const hostRelease of [{...s.hostRelease,source:"/usr/lib/os-release"},{...s.hostRelease,sha256:"b".repeat(64)},{...s.hostRelease,cells:{container_host_id:"other"}},{...s.hostRelease,cells:{container_host_id:"ubuntu",LD_PRELOAD:"/evil"}}])assert.throws(()=>h1StagedManifestData(expected,{...manifest(s),hostRelease}));});
test("synthetic boot ID cannot replace original host boot authority",()=>{const s=subject();assert.throws(()=>h1StagedSubjectData({...s,syntheticBootId:boot}));assert.throws(()=>h1StagedManifestData(h1StagedSubjectData(s),{...manifest(s),syntheticBootId:boot}));});
test("catalog bounds, writable file and nlink2 refuse",()=>{const s=subject(),file=s.catalog[1];for(const identity of [{...file?.identity,nlink:"2"},{...file?.identity,size:String(32*1024*1024+1)},{...file?.identity,mode:"33206"}])assert.throws(()=>h1StagedSubjectData({...s,catalog:[s.catalog[0],{...file,identity},s.catalog[2]]}));});
function measured(path:string){const s=lstatSync(path,{bigint:true});return {dev:String(s.dev),ino:String(s.ino),mode:String(s.mode),uid:String(s.uid),gid:String(s.gid),nlink:String(s.nlink),size:String(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs)};}
test("actual retained physical inode replacement, extra entry, nlink and deadline refuse",{skip:process.platform!=="linux" || process.getuid?.()!==0},()=>{
 const root=mkdtempSync("/root/TEST-h1-staged-data-"),file=root+"/tool";try{writeFileSync(file,"same bytes",{mode:0o644});function physical(){return h1StagedSubjectData({...subject(),rootIdentity:measured(root),catalog:[{path:"tool",kind:H1CatalogKind.File,identity:measured(file),sha256:createHash("sha256").update("same bytes").digest("hex"),target:""}]});}
 const retained=retainH1StagedCatalogData(root,physical(),performance.now()+30000);const originalFd=retained.fileDescriptor("tool");assert.equal(fs.fstatSync(originalFd,{bigint:true}).ino,lstatSync(file,{bigint:true}).ino);renameSync(file,root+"/old");writeFileSync(file,"same bytes",{mode:0o644});assert.throws(()=>retained.fileDescriptor("tool"));assert.throws(()=>fs.fstatSync(originalFd));assert.throws(retained.revalidate);assert.throws(retained.revalidate);retained.close();rmSync(root+"/old");
 const next=retainH1StagedCatalogData(root,physical(),performance.now()+30000);mkdirSync(root+"/extra");assert.throws(next.revalidate);next.close();rmSync(root+"/extra",{recursive:true});linkSync(file,root+"/hardlink");assert.throws(()=>physical());rmSync(root+"/hardlink");
 assert.throws(()=>retainH1StagedCatalogData(root,physical(),performance.now()-1));

 }finally{rmSync(root,{recursive:true,force:true});}
});

test("actual owned read expires at post-I/O monotonic check and closes permanently",{skip:process.platform!=="linux" || process.getuid?.()!==0},context=>{
 const root=mkdtempSync("/root/TEST-h1-staged-late-"),file=root+"/tool";let expired=false,reads=0;const original=fs.readSync;
 try{writeFileSync(file,"owned actual read",{mode:0o644});const parsed=h1StagedSubjectData({...subject(),rootIdentity:measured(root),catalog:[{path:"tool",kind:H1CatalogKind.File,identity:measured(file),sha256:createHash("sha256").update("owned actual read").digest("hex"),target:""}]});
 context.mock.method(performance,"now",()=>expired?101:0);
 const retained=retainH1StagedCatalogData(root,parsed,100);
 context.mock.method(fs,"readSync",(fd:number,buffer:Buffer,offset:number,length:number,position:number|null)=>{const result=original(fd,buffer,offset,length,position);reads++;expired=true;return result;});syncBuiltinESMExports();
 assert.throws(retained.revalidate);assert.equal(reads,1);expired=false;assert.throws(retained.revalidate);assert.equal(reads,1);retained.close();
 }finally{context.mock.restoreAll();syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}
});

test("ordinary Unicode is retained while lone surrogates refuse before byte conversion",()=>{
 const s=subject(),alias=s.catalog[2];assert.doesNotThrow(()=>h1StagedSubjectData({...s,catalog:[...s.catalog,{...s.catalog[0],path:"café"},{...alias,path:"été",target:"café",identity:{...alias?.identity,size:String(Buffer.byteLength("café"))}}]}));
 for(const value of ["usr/\ud800","usr/\udfff"])assert.throws(()=>h1StagedSubjectData({...s,catalog:[{...s.catalog[0],path:value}]}));
});
test("actual invalid literal alias bytes refuse including equal encoded-size case",{skip:process.platform!=="linux" || process.getuid?.()!==0},()=>{
 const root=mkdtempSync("/root/TEST-h1-staged-alias-"),file=root+"/�",alias=root+"/link";try{writeFileSync(file,"target",{mode:0o644});for(const bytes of [Buffer.from([0x80]),Buffer.from([0xf0,0x9f,0x92])]){symlinkSync(bytes,alias);const input={...subject(),rootIdentity:measured(root),catalog:[{path:"�",kind:H1CatalogKind.File,identity:measured(file),sha256:createHash("sha256").update("target").digest("hex"),target:""},{path:"link",kind:H1CatalogKind.Alias,identity:measured(alias),sha256:"",target:"�"}]};assert.throws(()=>retainH1StagedCatalogData(root,h1StagedSubjectData(input),performance.now()+30000));rmSync(alias);}
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("v2 publisher facts bind a separate protected digest, with no compiled or public admission claim",()=>{
 const s=subject(),v2={...s,schemaVersion:2,definitions:{...s.definitions,pythonGetpath:digest},assurance:H1DistroAssurance.SignedPublisher,distroFactsSha256:digest};const parsed=h1StagedSubjectData(v2);assert.equal(parsed.schemaVersion,2);assert.equal(parsed.distroFactsSha256,digest);assert.throws(requireQualifiedH1StagedConstructor,/selected_constructor_rows_not_qualified/);
 for(const changed of [{schemaVersion:1},{distroFactsSha256:"bad"},{assurance:"reproduced_build"},{definitions:s.definitions},{compiledInputEquality:true}])assert.throws(()=>h1StagedSubjectData({...v2,...changed}));
});

const actualRoot=process.platform==="linux" && process.getuid?.()===0;
function retainedTree(base:string){
 const root=base+"/tree",file=root+"/tool";mkdirSync(root,{mode:0o755});writeFileSync(file,"unchanged final bytes",{mode:0o644});
 const data=h1StagedSubjectData({...subject(),rootIdentity:measured(root),catalog:[{path:"tool",kind:H1CatalogKind.File,identity:measured(file),sha256:createHash("sha256").update("unchanged final bytes").digest("hex"),target:""}]});
 return {root,file,data,retained:retainH1StagedCatalogData(root,data,performance.now()+30000)};
}
test("actual original sibling birth/live creation retains full final tree identity",{skip:!actualRoot},()=>{
 const base=mkdtempSync("/root/TEST-h1-ancestor-siblings-");try{const {root,file,data,retained}=retainedTree(base);try{
  mkdirSync(base+"/full-launch-birth",{mode:0o700});mkdirSync(base+"/full-parent-live",{mode:0o700});writeFileSync(base+"/full-parent-live/live.json","DATA",{mode:0o600});
  retained.revalidate();assert.deepEqual(measured(root),data.rootIdentity);assert.deepEqual(measured(file),data.catalog[0]!.identity);assert.equal(fs.readFileSync(retained.fileDescriptor("tool"),"utf8"),"unchanged final bytes");
 }finally{retained.close();}}finally{rmSync(base,{recursive:true,force:true});}
});
for(const mutation of ["inode","symlink","mode"] as const)test("actual ancestor "+mutation+" substitution refuses",{skip:!actualRoot},()=>{
 const base=mkdtempSync("/root/TEST-h1-ancestor-change-"),ancestor=base+"/ancestor";mkdirSync(ancestor,{mode:0o755});
 try{const {retained}=retainedTree(ancestor);try{if(mutation==="mode")fs.chmodSync(ancestor,0o700);else{renameSync(ancestor,base+"/original");if(mutation==="inode")mkdirSync(ancestor,{mode:0o755});else symlinkSync("original",ancestor);}
  assert.throws(retained.revalidate);assert.throws(retained.descriptors);
 }finally{retained.close();}}finally{rmSync(base,{recursive:true,force:true});}
});
test("injected held ancestor mount change refuses despite unchanged actual inode",{skip:!actualRoot},context=>{
 const base=mkdtempSync("/root/TEST-h1-ancestor-mount-");const original=fs.readFileSync;try{const {retained}=retainedTree(base);let calls=0;
  try{context.mock.method(fs,"readFileSync",((path:fs.PathOrFileDescriptor,...args:unknown[])=>{const raw=Reflect.apply(original,fs,[path,...args]);if(typeof path==="string" && /^\/proc\/self\/fdinfo\/[0-9]+$/.test(path)){calls++;assert.equal(typeof raw,"string");return String(raw).replace(/^mnt_id:\s+[0-9]+$/m,"mnt_id:\t999999999");}return raw;}) as typeof fs.readFileSync);syncBuiltinESMExports();assert.throws(retained.revalidate);assert.equal(calls,1);
  }finally{context.mock.restoreAll();syncBuiltinESMExports();retained.close();}
 }finally{rmSync(base,{recursive:true,force:true});}
});
test("actual close failure still attempts every retained descriptor",{skip:!actualRoot},context=>{
 const base=mkdtempSync("/root/TEST-h1-close-all-"),original=fs.closeSync;let blocked:number|undefined;
 try{const {retained}=retainedTree(base),fds=retained.descriptors(),attempts:number[]=[];blocked=fds[0];
  context.mock.method(fs,"closeSync",(fd:number)=>{attempts.push(fd);if(fd===blocked)throw Error("TEST close fault");return original(fd);});syncBuiltinESMExports();assert.throws(retained.close,/TEST close fault/);assert.deepEqual([...attempts].sort((a,b)=>a-b),[...fds].sort((a,b)=>a-b));for(const fd of fds.filter(fd=>fd!==blocked))assert.throws(()=>fs.fstatSync(fd));
 }finally{context.mock.restoreAll();syncBuiltinESMExports();if(blocked!==undefined)original(blocked);rmSync(base,{recursive:true,force:true});}
});

test("actual fresh ancestor bind mount refuses retained same-inode catalog",{skip:!actualRoot || !(/^CapEff:\s+([0-9a-f]+)$/m.exec(actualRoot?fs.readFileSync("/proc/self/status","utf8"):"")?.[1] && (BigInt("0x"+(/^CapEff:\s+([0-9a-f]+)$/m.exec(fs.readFileSync("/proc/self/status","utf8"))![1])) & (1n<<21n))!==0n)},async()=>{
 const {spawnSync}=await import("node:child_process"),base=mkdtempSync("/root/TEST-h1-ancestor-bind-");let mounted=false;
 try{const {retained}=retainedTree(base);try{const result=spawnSync("/usr/bin/mount",["--bind",base,base],{timeout:5000,env:{PATH:"/usr/bin:/bin",LANG:"C"},encoding:"utf8"});assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,0);mounted=true;assert.throws(retained.revalidate);}finally{retained.close();}}
 finally{if(mounted){const result=spawnSync("/usr/bin/umount",["--",base],{timeout:5000,env:{PATH:"/usr/bin:/bin",LANG:"C"},encoding:"utf8"});assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,0);}rmSync(base,{recursive:true,force:true});}
});

for(const mutation of ["root-mode","file-bytes","file-mode"] as const)test("ancestor lenience retains complete final "+mutation+" refusal",{skip:!actualRoot},()=>{
 const base=mkdtempSync("/root/TEST-h1-final-immutable-");try{const {root,file,retained}=retainedTree(base);try{if(mutation==="root-mode")fs.chmodSync(root,0o700);else if(mutation==="file-bytes")fs.writeFileSync(file,"changed final bytes");else fs.chmodSync(file,0o600);assert.throws(retained.revalidate);}finally{retained.close();}}finally{rmSync(base,{recursive:true,force:true});}
});
