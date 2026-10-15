/** Runs only inside the fresh bubblewrap image. No shell, build or maintainer
 * entry point: dpkg-source3.0(quilt) applies the authenticated source patches. */
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {constants,openSync,closeSync,fstatSync,lstatSync,readdirSync,readlinkSync,readSync,readFileSync,realpathSync,statSync,existsSync,type BigIntStats} from "node:fs";
import {posix} from "node:path";
import {pathToFileURL} from "node:url";
import {types} from "node:util";
import {H1SemanticFamily,H1SourceObjectKind,h1PatchedSourceLimits,readH1UbuntuPatchSeries,selectH1SemanticInputs,type H1SourceObject} from "./current-h1-source-semantics-TEST.ts";
const hash=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(":");
/** Complete nofollow census. Retains file handles while reading and joins both
 * named and handle stamps; source aliases retain O_PATH target facts only.
 * Special files refuse before opening. */
export enum H1SourceCensusProfile {Source="source",ToolImage="tool_image"}
/** The measured CI bootstrap Node exceeds128 MiB. Only its exact private
 * tool-image member receives160 MiB; source and every other image file retain
 * their original limits. This is a byte bound, never a custody/role grant. */
export function h1SourceFileByteLimit(profile:H1SourceCensusProfile,member:string):number {
 return profile===H1SourceCensusProfile.ToolImage?(member==="runtime/node"?160*1024*1024:128*1024*1024):h1PatchedSourceLimits.fileBytes;
}
export enum H1SourceCensusReason {Root="root",Depth="depth",Name="name",Device="device",Ownership="ownership",SetId="set_id",Entries="entries",AliasLexical="alias_lexical",Special="special_object",Identity="identity",Hardlink="source_hardlink",FileBytes="file_bytes",TotalBytes="total_bytes",LinkClosure="hardlink_closure",Membership="directory_membership",AliasExternal="alias_external",AliasTarget="alias_target",Revalidation="input_revalidation",Filesystem="filesystem"}
export enum H1SourceCensusCategory {Root="root",RuntimeNode="runtime_node",RuntimeModule="runtime_module",Binary="usr_binary",Library="usr_library",Packaging="debian_packaging",Other="other"}
export interface H1SourceCensusFacts {readonly reason:H1SourceCensusReason;readonly profile:H1SourceCensusProfile;readonly category:H1SourceCensusCategory;readonly member:string|null;readonly memberSha256:string;readonly objects:number;readonly bytes:number;readonly depth:number;readonly objectBytes:number|null;readonly objectLinks:number|null;readonly objectUid:number|null;readonly objectGid:number|null;readonly objectMode:number|null}
const censusFailureFacts=new WeakMap<object,H1SourceCensusFacts>();
class H1SourceCensusHeld extends Error {constructor(facts:H1SourceCensusFacts){super("TEST H1 source census Held: "+facts.reason);censusFailureFacts.set(this,facts);}}
/** Read only our original frozen finite facts, never an unknown error payload. */
export function readH1SourceCensusFailure(error:unknown):H1SourceCensusFacts|undefined {
 if(types.isProxy(error)||!types.isNativeError(error)||Object.getPrototypeOf(error)!==H1SourceCensusHeld.prototype)return undefined;
 return censusFailureFacts.get(error);
}
export function censusH1PatchedSource(root:string,tick:()=>void,profile=H1SourceCensusProfile.Source){
 assert(Object.values(H1SourceCensusProfile).includes(profile));
 const rows:H1SourceObject[]=[],links=new Map<string,{count:number;expected:bigint;member:string;initial:BigIntStats}>();let bytes=0,member="",depth=0,objectBytes:number|null=null,objectLinks:number|null=null,objectUid:number|null=null,objectGid:number|null=null,objectMode:number|null=null;
 const observe=(s:BigIntStats)=>{objectBytes=s.size<=BigInt(Number.MAX_SAFE_INTEGER)?Number(s.size):null;objectLinks=s.nlink<=BigInt(Number.MAX_SAFE_INTEGER)?Number(s.nlink):null;objectUid=s.uid<=4294967295n?Number(s.uid):null;objectGid=s.gid<=4294967295n?Number(s.gid):null;objectMode=Number(s.mode&0o7777n);};
 const fail=(reason:H1SourceCensusReason):never=>{const category=member===""?H1SourceCensusCategory.Root:member==="runtime/node"?H1SourceCensusCategory.RuntimeNode:member.startsWith("runtime/")?H1SourceCensusCategory.RuntimeModule:member.startsWith("usr/bin/")||member.startsWith("usr/sbin/")?H1SourceCensusCategory.Binary:member.startsWith("usr/lib/")||member.startsWith("usr/lib64/")?H1SourceCensusCategory.Library:member.startsWith("debian/")?H1SourceCensusCategory.Packaging:H1SourceCensusCategory.Other;
  const publicMember=member.length<=512&&/^[A-Za-z0-9_+.%:@=~-]+(?:\/[A-Za-z0-9_+.%:@=~-]+)*$/.test(member)&&member.split("/").every(p=>p!=="."&&p!=="..")?member:null;
  throw new H1SourceCensusHeld(Object.freeze({reason,profile,category,member:publicMember,memberSha256:hash(member),objects:rows.length,bytes,depth,objectBytes,objectLinks,objectUid,objectGid,objectMode}));};
 const need=(value:unknown,reason:H1SourceCensusReason):void=>{if(!value)fail(reason);},check=()=>{try{tick();}catch{fail(H1SourceCensusReason.Revalidation);}};
 const initial=lstatSync(root,{bigint:true});observe(initial);need(initial.isDirectory()&&!initial.isSymbolicLink(),H1SourceCensusReason.Root);const rootFd=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 const walk=(fd:number,path:string,level:number)=>{depth=level;check();need(level<=128,H1SourceCensusReason.Depth);const before=fstatSync(fd,{bigint:true}),names=readdirSync(`/proc/self/fd/${fd}`).sort();
  for(const name of names){depth=level;member=path?path+"/"+name:name;objectBytes=null;objectLinks=null;objectUid=null;objectGid=null;objectMode=null;check();need(name!=="."&&name!==".."&&!/[\x00-\x1f\x7f/]/.test(name),H1SourceCensusReason.Name);const p=member,named=`/proc/self/fd/${fd}/${name}`,s=lstatSync(named,{bigint:true});observe(s);
   need(s.dev===initial.dev,H1SourceCensusReason.Device);need(s.uid===0n&&s.gid===0n,H1SourceCensusReason.Ownership);need((s.mode&0o6000n)===0n,H1SourceCensusReason.SetId);need(rows.length<h1PatchedSourceLimits.entries,H1SourceCensusReason.Entries);const mode=Number(s.mode&0o777n);
   if(s.isSymbolicLink()){const target=readlinkSync(named),dest=posix.normalize(posix.join(posix.dirname(p),target));need((profile===H1SourceCensusProfile.ToolImage||!target.startsWith("/"))&&dest!==".."&&!dest.startsWith("../")&&!/[\x00-\x1f\x7f]/.test(target),H1SourceCensusReason.AliasLexical);rows.push({path:p,kind:H1SourceObjectKind.Alias,mode,bytes:Buffer.byteLength(target),sha256:hash(target),target});}
   else{need(s.isDirectory()||s.isFile(),H1SourceCensusReason.Special);const child=openSync(named,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(s.isDirectory()?constants.O_DIRECTORY:0));try{need(stamp(fstatSync(child,{bigint:true}))===stamp(s),H1SourceCensusReason.Identity);
    if(s.isDirectory()){rows.push({path:p,kind:H1SourceObjectKind.Directory,mode,bytes:0,sha256:"",target:""});walk(child,p,level+1);}else{need(profile===H1SourceCensusProfile.ToolImage?s.nlink>0n:s.nlink===1n,H1SourceCensusReason.Hardlink);need(s.size<=BigInt(h1SourceFileByteLimit(profile,p)),H1SourceCensusReason.FileBytes);const key=s.dev+":"+s.ino,link=links.get(key)??{count:0,expected:s.nlink,member:p,initial:s};need(link.expected===s.nlink,H1SourceCensusReason.LinkClosure);link.count++;links.set(key,link);const body=read(child,Number(s.size),check);bytes+=body.length;need(bytes<=h1PatchedSourceLimits.totalBytes,H1SourceCensusReason.TotalBytes);rows.push({path:p,kind:H1SourceObjectKind.File,mode,bytes:body.length,sha256:hash(body),target:""});}need(stamp(fstatSync(child,{bigint:true}))===stamp(s),H1SourceCensusReason.Identity);
   }finally{closeSync(child);}}member=p;depth=level;observe(s);need(stamp(lstatSync(named,{bigint:true}))===stamp(s),H1SourceCensusReason.Identity);
  }member=path;depth=level;observe(before);const afterNames=readdirSync(`/proc/self/fd/${fd}`).sort();need(afterNames.length===names.length&&afterNames.every((name,i)=>name===names[i]),H1SourceCensusReason.Membership);need(stamp(fstatSync(fd,{bigint:true}))===stamp(before),H1SourceCensusReason.Identity);
 };
 try{need(stamp(fstatSync(rootFd,{bigint:true}))===stamp(initial),H1SourceCensusReason.Identity);walk(rootFd,"",0);for(const link of links.values()){if(BigInt(link.count)!==link.expected){member=link.member;depth=member.split("/").length-1;observe(link.initial);fail(H1SourceCensusReason.LinkClosure);}}member="";depth=0;observe(initial);
  if(profile===H1SourceCensusProfile.Source){
   const canonicalRoot=realpathSync(`/proc/self/fd/${rootFd}`),inside=(path:string)=>path===canonicalRoot||path.startsWith(canonicalRoot+"/");
   // The OS-retained target supplies component-wise symlink/.. containment.
   for(const row of rows){if(row.kind!==H1SourceObjectKind.Alias)continue;member=row.path;depth=member.split("/").length-1;check();const named=`/proc/self/fd/${rootFd}/${row.path}`,before=lstatSync(named,{bigint:true});observe(before);need(before.isSymbolicLink()&&readlinkSync(named)===row.target,H1SourceCensusReason.Identity);const resolved=(()=>{try{return realpathSync(named);}catch{return fail(H1SourceCensusReason.AliasTarget);}})();need(inside(resolved),H1SourceCensusReason.AliasExternal);const target=statSync(named,{bigint:true}),fd=openSync(named,0x200000);
    try{need(target.dev===initial.dev&&(target.isDirectory()||target.isFile()),H1SourceCensusReason.AliasTarget);need(stamp(fstatSync(fd,{bigint:true}))===stamp(target),H1SourceCensusReason.Identity);need(inside(realpathSync(`/proc/self/fd/${fd}`)),H1SourceCensusReason.AliasExternal);need(realpathSync(named)===resolved,H1SourceCensusReason.Identity);need(stamp(statSync(named,{bigint:true}))===stamp(target),H1SourceCensusReason.Identity);need(stamp(lstatSync(named,{bigint:true}))===stamp(before),H1SourceCensusReason.Identity);need(readlinkSync(named)===row.target,H1SourceCensusReason.Identity);need(stamp(fstatSync(rootFd,{bigint:true}))===stamp(initial),H1SourceCensusReason.Identity);need(stamp(lstatSync(root,{bigint:true}))===stamp(initial),H1SourceCensusReason.Identity);check();}finally{closeSync(fd);}
   }
  }
  need(stamp(lstatSync(root,{bigint:true}))===stamp(initial),H1SourceCensusReason.Identity);return Object.freeze({rows:Object.freeze(rows.sort((a,b)=>a.path<b.path?-1:1)),bytes});
 }catch(error){if(readH1SourceCensusFailure(error))throw error;return fail(H1SourceCensusReason.Filesystem);}finally{closeSync(rootFd);}
}
function read(fd:number,size:number,tick:()=>void):Buffer {const b=Buffer.alloc(size+1);let at=0;for(;;){tick();const n=readSync(fd,b,at,b.length-at,at);tick();if(!n)break;at+=n;assert(at<=size);}assert.equal(at,size);return b.subarray(0,at);}
function main(){
 assert(process.platform==="linux"&&process.getuid?.()===0&&process.getgid?.()===0);assert.equal(process.argv.length,4);const [family,dsc]=process.argv.slice(2);assert(Object.values(H1SemanticFamily).includes(family as H1SemanticFamily)&&dsc&&/^[A-Za-z0-9_.+%:~-]+\.dsc$/.test(dsc));
 const deadline=performance.now()+120000,tick=()=>assert(performance.now()<deadline,"one extraction deadline");
 for(const name of ["mnt","net","pid","user"]){assert(process.env["TEST_OUTER_"+name]);assert.notEqual(readlinkSync("/proc/self/ns/"+name),process.env["TEST_OUTER_"+name]);}
 const status=readlinkSync("/proc/self/root");assert.equal(status,"/");
 const actor=readFileSync("/proc/self/status","utf8");assert(/^NoNewPrivs:\s+1$/m.test(actor));for(const cap of ["Inh","Prm","Eff","Bnd","Amb"])assert(new RegExp("^Cap"+cap+":\\s+0000000000000000$","m").test(actor));
 const targets=new Set(["/","/inputs","/output","/tmp","/proc","/dev","/dev/shm","/dev/pts","/dev/ptmx","/dev/null","/dev/zero","/dev/full","/dev/random","/dev/urandom","/dev/tty"]),mounts=readFileSync("/proc/self/mountinfo","utf8").trimEnd().split("\n");assert(mounts.length<=32);const seen=new Set<string>();for(const line of mounts){const cells=line.split(" "),target=cells[4];assert(target&&targets.has(target)&&!seen.has(target));seen.add(target);if(target==="/"||target==="/inputs")assert(cells[5]!.split(",").includes("ro"));}for(const target of ["/","/inputs","/output","/tmp","/proc","/dev"])assert(seen.has(target));
 // Root image and input are read-only binds; output and tmp are bounded tmpfs.
 for(const file of ["/etc/dpkg/dpkg-source.conf","/root/.dpkg-source","/nonexistent/.dpkg-source"])assert(!existsSync(file),"uncontrolled extraction configuration");
 const r=spawnSync("/usr/bin/dpkg-source",["--no-copy","--no-check","--extract","/inputs/"+dsc,"/output/tree"],{shell:false,cwd:"/output",env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",HOME:"/nonexistent",TMPDIR:"/tmp",DEB_VENDOR:"Ubuntu"},timeout:90000,killSignal:"SIGKILL",maxBuffer:2*1024*1024});tick();assert(!r.error&&r.status===0&&r.signal===null,"dpkg-source complete extraction required");
 const census=censusH1PatchedSource("/output/tree",tick),byPath=new Map(census.rows.map(row=>[row.path,row]));
 const original=(p:string):Buffer=>{const row=byPath.get(p);assert(row?.kind===H1SourceObjectKind.File);const named="/output/tree/"+p,stat=lstatSync(named,{bigint:true});assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===BigInt(row.bytes));const fd=openSync(named,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{assert.equal(stamp(fstatSync(fd,{bigint:true})),stamp(stat));const b=read(fd,row.bytes,tick);assert.equal(hash(b),row.sha256);assert.equal(stamp(fstatSync(fd,{bigint:true})),stamp(stat));assert.equal(stamp(lstatSync(named,{bigint:true})),stamp(stat));return b;}finally{closeSync(fd);}};
 const optional=(p:string)=>byPath.has(p)?original(p):undefined,patches=readH1UbuntuPatchSeries(optional),semantic=selectH1SemanticInputs(family as H1SemanticFamily,census.rows,original,tick);
 const after=censusH1PatchedSource("/output/tree",tick);assert.deepEqual(after,census);
 const body=Buffer.from(JSON.stringify({purpose:"PATCHED_SOURCE_UNADMITTED_DATA",family,extractor:"dpkg-source-3.0-quilt",vendor:"Ubuntu",command:{status:r.status,signal:r.signal,stdoutSha256:hash(r.stdout),stderrSha256:hash(r.stderr)},inventory:census,patches,semantic,compiledInputEquality:false,nativeQualified:false}));assert(body.length<=h1PatchedSourceLimits.recordBytes);tick();process.stdout.write(body);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{main();}catch{process.stderr.write("TEST H1 isolated source extraction Held\n");process.exitCode=70;}}
