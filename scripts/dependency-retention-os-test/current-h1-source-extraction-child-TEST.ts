/** Runs only inside the fresh bubblewrap image. No shell, build or maintainer
 * entry point: dpkg-source3.0(quilt) applies the authenticated source patches. */
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {constants,openSync,closeSync,fstatSync,lstatSync,readdirSync,readlinkSync,readSync,readFileSync,realpathSync,statSync,existsSync,type BigIntStats} from "node:fs";
import {posix} from "node:path";
import {pathToFileURL} from "node:url";
import {H1SemanticFamily,H1SourceObjectKind,h1PatchedSourceLimits,readH1UbuntuPatchSeries,selectH1SemanticInputs,type H1SourceObject} from "./current-h1-source-semantics-TEST.ts";
const hash=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(":");
/** Complete nofollow census. Retains file handles while reading and joins both
 * named and handle stamps; aliases never open targets. Special files refuse. */
export enum H1SourceCensusProfile {Source="source",ToolImage="tool_image"}
export function censusH1PatchedSource(root:string,tick:()=>void,profile=H1SourceCensusProfile.Source){
 const initial=lstatSync(root,{bigint:true});assert(initial.isDirectory()&&!initial.isSymbolicLink());const rootFd=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW),rows:H1SourceObject[]=[],links=new Map<string,{count:number;expected:bigint}>();let bytes=0;
 const walk=(fd:number,path:string,depth:number)=>{tick();assert(depth<=128);const before=fstatSync(fd,{bigint:true}),names=readdirSync(`/proc/self/fd/${fd}`).sort();
  for(const name of names){tick();assert(name!=="."&&name!==".."&&!/[\x00-\x1f\x7f/]/.test(name));const p=path?path+"/"+name:name,named=`/proc/self/fd/${fd}/${name}`,s=lstatSync(named,{bigint:true});assert(s.dev===initial.dev&&s.uid===0n&&s.gid===0n&&(s.mode&0o6000n)===0n);assert(rows.length<h1PatchedSourceLimits.entries);const mode=Number(s.mode&0o777n);
   if(s.isSymbolicLink()){const target=readlinkSync(named),dest=posix.normalize(posix.join(posix.dirname(p),target));assert((profile===H1SourceCensusProfile.ToolImage||!target.startsWith("/"))&&dest!==".."&&!dest.startsWith("../")&&!/[\x00-\x1f\x7f]/.test(target));rows.push({path:p,kind:H1SourceObjectKind.Alias,mode,bytes:Buffer.byteLength(target),sha256:hash(target),target});}
   else{assert(s.isDirectory()||s.isFile(),"special source object refused");const child=openSync(named,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(s.isDirectory()?constants.O_DIRECTORY:0));try{assert.equal(stamp(fstatSync(child,{bigint:true})),stamp(s));
    if(s.isDirectory()){rows.push({path:p,kind:H1SourceObjectKind.Directory,mode,bytes:0,sha256:"",target:""});walk(child,p,depth+1);}else{assert((profile===H1SourceCensusProfile.ToolImage?s.nlink>0n:s.nlink===1n)&&s.size<=BigInt(profile===H1SourceCensusProfile.ToolImage?128*1024*1024:h1PatchedSourceLimits.fileBytes));const key=s.dev+":"+s.ino,link=links.get(key)??{count:0,expected:s.nlink};assert.equal(link.expected,s.nlink);link.count++;links.set(key,link);const body=read(child,Number(s.size),tick);bytes+=body.length;assert(bytes<=h1PatchedSourceLimits.totalBytes);rows.push({path:p,kind:H1SourceObjectKind.File,mode,bytes:body.length,sha256:hash(body),target:""});}assert.equal(stamp(fstatSync(child,{bigint:true})),stamp(s));
   }finally{closeSync(child);}}assert.equal(stamp(lstatSync(named,{bigint:true})),stamp(s));
  }assert.deepEqual(readdirSync(`/proc/self/fd/${fd}`).sort(),names);assert.equal(stamp(fstatSync(fd,{bigint:true})),stamp(before));
 };
 try{assert.equal(stamp(fstatSync(rootFd,{bigint:true})),stamp(initial));walk(rootFd,"",0);for(const link of links.values())assert.equal(BigInt(link.count),link.expected,"complete in-image hardlink closure");
  if(profile===H1SourceCensusProfile.Source){
   const canonicalRoot=realpathSync(`/proc/self/fd/${rootFd}`),inside=(path:string)=>path===canonicalRoot||path.startsWith(canonicalRoot+"/");
   // Use the OS resolver for component-wise symlink/.. semantics. Lexical
   // normalization alone cannot detect chained escapes, cycles or dangling links.
   for(const row of rows){if(row.kind!==H1SourceObjectKind.Alias)continue;tick();const named=`/proc/self/fd/${rootFd}/${row.path}`,before=lstatSync(named,{bigint:true});assert(before.isSymbolicLink()&&readlinkSync(named)===row.target);const resolved=realpathSync(named);assert(inside(resolved),"physical source alias target outside original root");const target=statSync(named,{bigint:true}),fd=openSync(named,0x200000);
    try{assert(target.dev===initial.dev&&(target.isDirectory()||target.isFile()),"original source target object required");assert.equal(stamp(fstatSync(fd,{bigint:true})),stamp(target));assert(inside(realpathSync(`/proc/self/fd/${fd}`)),"retained alias target outside original root");assert.equal(realpathSync(named),resolved);assert.equal(stamp(statSync(named,{bigint:true})),stamp(target));assert.equal(stamp(lstatSync(named,{bigint:true})),stamp(before));assert.equal(readlinkSync(named),row.target);assert.equal(stamp(fstatSync(rootFd,{bigint:true})),stamp(initial));assert.equal(stamp(lstatSync(root,{bigint:true})),stamp(initial));tick();}finally{closeSync(fd);}
   }
  }
  assert.equal(stamp(lstatSync(root,{bigint:true})),stamp(initial));return Object.freeze({rows:Object.freeze(rows.sort((a,b)=>a.path<b.path?-1:1)),bytes});}finally{closeSync(rootFd);}
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
