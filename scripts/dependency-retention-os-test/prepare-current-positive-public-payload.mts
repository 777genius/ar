/** Fixed first Positive PUBLIC DATA producer. No archive decoding, installation or admission. */
import * as fs from "node:fs";
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {dirname,join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {setImmediate as yieldNow} from "node:timers/promises";
import {MAGIC,Role,parseManifest,safeRelative,type Manifest,type FrameRow} from "./stage-current-positive-public.mts";
const C=fs.constants,MAX=1024**3,LEAF=128*1024**2;
type Pin={path:string;bytes:number;sha256:string};
type SelectionInputs={sourceRoot:string;sourceSha:string;sourceTree:string;dependencyRoot:string;toolchainRoot:string;rows:FrameRow[];links:Manifest["links"];toolchainDirectories:string[];compilerReceipt:Pin;artifactReceipt:Pin;nodeArchive:Pin;publicPackageImportAudit:Pin};
export type SelectionV1=SelectionInputs&{schemaVersion:1;kind:"FULL_POSITIVE_PUBLIC_INPUT_SELECTION_V1"};
/** These are finite file selectors, not compiler receipts or origin authority. */
export type EmittedMapping={path:string;origins:{root:number;relativePath:string}[]};
export const PublicProducerOutputMode={Local:"local",ManagedTestWorkspace:"managed_test_workspace"} as const;
export type PublicProducerOutputMode=typeof PublicProducerOutputMode[keyof typeof PublicProducerOutputMode];
export type SelectionV2=SelectionInputs&{schemaVersion:2;kind:"FULL_POSITIVE_PUBLIC_INPUT_SELECTION_V2";emittedRoots:string[];emittedMappings:EmittedMapping[];outputMode:PublicProducerOutputMode};
/** Installed dependencies remain DATA: only manifest-validated source links may be observed. */
export type SelectionV3=Omit<SelectionV2,"schemaVersion"|"kind">&{schemaVersion:3;kind:"FULL_POSITIVE_PUBLIC_INPUT_SELECTION_V3"};
export type Selection=SelectionV1|SelectionV2|SelectionV3;
function hold(v:unknown,why:string):asserts v {if(!v)throw Error(`PUBLIC_PRODUCER_HOLD:${why}`);}
const digest=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
function fields(v:unknown,keys:string):asserts v is Record<string,unknown>{hold(v!==null&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join(",")===keys,"fields");}
const trustedDirectory=(s:fs.BigIntStats)=>s.isDirectory()&&(s.uid===0n||s.uid===BigInt(process.getuid!()))&&((s.mode&0o022n)===0n||(s.uid===0n&&(s.mode&0o1000n)!==0n));
const stamp=(s:fs.BigIntStats)=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":");
const dirStamp=(s:fs.BigIntStats)=>[s.dev,s.ino,s.mode,s.uid,s.gid].map(String).join(":");
export function parseSelection(bytes:Buffer,sha:string):Selection {
 hold(/^[a-f0-9]{64}$/.test(sha)&&bytes.length<=32*1024**2&&digest(bytes)===sha,"selection_digest");const v:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
 hold(v!==null&&typeof v==="object"&&!Array.isArray(v),"fields");const version=(v as Record<string,unknown>).schemaVersion;
 const common="artifactReceipt,compilerReceipt,dependencyRoot,kind,links,nodeArchive,publicPackageImportAudit,rows,schemaVersion,sourceRoot,sourceSha,sourceTree,toolchainDirectories,toolchainRoot";
 fields(v,version===2||version===3?[...common.split(","),"emittedRoots","emittedMappings","outputMode"].sort().join(","):common);
 hold((version===1&&v.kind==="FULL_POSITIVE_PUBLIC_INPUT_SELECTION_V1"||version===2&&v.kind==="FULL_POSITIVE_PUBLIC_INPUT_SELECTION_V2"||version===3&&v.kind==="FULL_POSITIVE_PUBLIC_INPUT_SELECTION_V3")&&typeof v.sourceSha==="string"&&/^[a-f0-9]{40}$/.test(v.sourceSha)&&typeof v.sourceTree==="string"&&/^[a-f0-9]{40}$/.test(v.sourceTree),"selection_identity");
 for(const k of ["sourceRoot","dependencyRoot","toolchainRoot"] as const)hold(typeof v[k]==="string"&&resolve(v[k])===v[k]&&!/[\x00-\x1f\x7f]/.test(v[k]),"input_root");
 for(const k of ["compilerReceipt","artifactReceipt","nodeArchive","publicPackageImportAudit"] as const){const p=v[k];fields(p,"bytes,path,sha256");hold(typeof p.path==="string"&&resolve(p.path)===p.path&&Number.isSafeInteger(p.bytes)&&Number(p.bytes)>0&&Number(p.bytes)<=MAX&&typeof p.sha256==="string"&&/^[a-f0-9]{64}$/.test(p.sha256),"selection_pin");}
 hold(Array.isArray(v.rows)&&Array.isArray(v.links)&&Array.isArray(v.toolchainDirectories),"selection_arrays");
 if(version===3)hold(v.dependencyRoot===v.sourceRoot+"/node_modules","installed_dependency_root");
 if(version===2||version===3){
  hold(Object.values(PublicProducerOutputMode).includes(v.outputMode as PublicProducerOutputMode),"output_mode");
  hold(Array.isArray(v.emittedRoots)&&v.emittedRoots.length>0&&v.emittedRoots.length<=5&&new Set(v.emittedRoots).size===v.emittedRoots.length,"emitted_roots");
  for(const root of v.emittedRoots)hold(typeof root==="string"&&root!=="/"&&resolve(root)===root&&!/[\x00-\x1f\x7f]/.test(root),"emitted_root");
  hold(Array.isArray(v.emittedMappings)&&v.emittedMappings.length<=100000,"emitted_mappings");
  const delivered=new Set<string>(),origins=new Set<string>();let count=0;
  for(const value of v.emittedMappings){
   fields(value,"origins,path");safeRelative(value.path);hold(!delivered.has(value.path)&&Array.isArray(value.origins)&&value.origins.length>0&&value.origins.length<=5,"emitted_mapping");delivered.add(value.path);
   for(const origin of value.origins){
    fields(origin,"relativePath,root");safeRelative(origin.relativePath);
    hold(Number.isSafeInteger(origin.root)&&Number(origin.root)>=0&&Number(origin.root)<v.emittedRoots.length&&++count<=100000,"emitted_origin");
    const key=value.path+"\0"+join(v.emittedRoots[Number(origin.root)] as string,origin.relativePath);hold(!origins.has(key),"duplicate_emitted_origin");origins.add(key);
   }
  }
  const emitted=v.rows.filter((r:FrameRow)=>r.role===Role.Emitted).map((r:FrameRow)=>r.path);
  hold(new Set(emitted).size===emitted.length&&emitted.length===delivered.size&&emitted.every((path:string)=>delivered.has(path)),"emitted_mapping_rows");
 }
 return v as unknown as Selection;
}
export async function producePositivePublicPayload(selectionPath:string,selectionSha:string,output:string):Promise<void>{
 const deadline=performance.now()+20*60*1000;let cancelled=false;const signal=()=>{cancelled=true;};process.on("SIGINT",signal);process.on("SIGTERM",signal);
 const tick=()=>hold(!cancelled&&performance.now()<deadline,"cancelled_or_deadline");
 type Held={fd:number;path:string;identity:string};const ancestors=new Map<string,Held>();const originals=new Map<string,{identity:string;pin:Omit<Pin,"path">}>();let outputParent:number|undefined;const critical=new Set<string>();let managedContextCheck:(()=>void)|undefined;
 const keep=(p:string)=>{for(;;){critical.add(p);const d=dirname(p);if(d===p)break;p=d;}};
 const prune=()=>{for(const [p,h] of ancestors)if(!critical.has(p)){fs.closeSync(h.fd);ancestors.delete(p);}};
 const parent=(p:string):void=>{if(ancestors.has(p))return;const d=dirname(p);if(d!==p)parent(d);const fd=fs.openSync(p,C.O_RDONLY|C.O_NOFOLLOW|C.O_DIRECTORY);try{const s=fs.fstatSync(fd,{bigint:true});hold(trustedDirectory(s)&&!fs.lstatSync(p).isSymbolicLink()&&fs.realpathSync(p)===p,"ancestor");ancestors.set(p,{fd,path:p,identity:dirStamp(s)});}catch(e){fs.closeSync(fd);throw e;}};
 const guard=()=>{tick();managedContextCheck?.();for(const h of ancestors.values()){const a=fs.fstatSync(h.fd,{bigint:true}),b=fs.lstatSync(h.path,{bigint:true});hold(trustedDirectory(a)&&trustedDirectory(b)&&!b.isSymbolicLink()&&dirStamp(a)===h.identity&&dirStamp(b)===h.identity&&fs.realpathSync(h.path)===h.path,"ancestor_changed");}};
 async function read(path:string,pin?:Omit<Pin,"path">,consume?:(bytes:Buffer)=>void):Promise<{bytes:number;sha256:string;mode:420|493;permissions:number;identity:string;gitBlob:string}>{
  parent(dirname(path));guard();const fd=fs.openSync(path,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);try{const s=fs.fstatSync(fd,{bigint:true});hold(s.isFile()&&s.nlink===1n&&s.size<=BigInt(pin?MAX:LEAF)&&(s.mode&0o022n)===0n,"input_regular");const identity=stamp(s);hold(stamp(fs.lstatSync(path,{bigint:true}))===identity,"named_input");const previous=originals.get(path);if(previous)hold(previous.identity===identity,"input_substituted");const hash=createHash("sha256"),blob=createHash("sha1");blob.update(Buffer.from(`blob ${s.size}\0`));const b=Buffer.alloc(1024*1024);let offset=0;
   for(;;){guard();const n=fs.readSync(fd,b,0,b.length,offset);if(!n)break;offset+=n;hold(offset<=Number(s.size),"input_growth");const chunk=b.subarray(0,n);hash.update(chunk);blob.update(chunk);consume?.(chunk);await yieldNow();guard();}
   const result={bytes:offset,sha256:hash.digest("hex"),mode:Number(s.mode&0o777n) as 420|493,permissions:Number(s.mode&0o7777n),identity,gitBlob:blob.digest("hex")};hold(offset===Number(s.size)&&stamp(fs.fstatSync(fd,{bigint:true}))===identity&&stamp(fs.lstatSync(path,{bigint:true}))===identity,"input_final");if(pin)hold(offset===pin.bytes&&result.sha256===pin.sha256,"input_pin");if(previous)hold(result.sha256===previous.pin.sha256&&offset===previous.pin.bytes,"input_changed");originals.set(path,{identity,pin:{bytes:offset,sha256:result.sha256}});guard();return result;
  }finally{fs.closeSync(fd);prune();tick();}}
 async function command(args:string[],cwd:string,outputFd?:number):Promise<Buffer>{guard();const child=spawn("/usr/bin/git",["-c","core.hooksPath=/dev/null",...args],{cwd,env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"},stdio:["ignore","pipe","pipe"],timeout:Math.min(60000,deadline-performance.now())});let length=0;const parts:Buffer[]=[];let errorBytes=0,streamFailure=false;const abort=()=>child.kill("SIGTERM");process.on("SIGINT",abort);process.on("SIGTERM",abort);try{child.stdout.on("data",(b:Buffer)=>{length+=b.length;if(length>(outputFd===undefined?32*1024**2:LEAF))child.kill("SIGTERM");else if(outputFd===undefined)parts.push(b);else try{writeAll(outputFd,b);}catch{streamFailure=true;child.kill("SIGTERM");}});child.stderr.on("data",(b:Buffer)=>{errorBytes+=b.length;if(errorBytes>1024**2)child.kill("SIGTERM");});await new Promise<void>((ok,bad)=>{child.once("error",bad);child.once("close",(code,sig)=>code===0&&!sig?ok():bad(Error("PUBLIC_PRODUCER_HOLD:git_failed")));});hold(!streamFailure&&length<=(outputFd===undefined?32*1024**2:LEAF)&&errorBytes<=1024**2,"git_output");guard();return Buffer.concat(parts);}finally{process.off("SIGINT",abort);process.off("SIGTERM",abort);}}
 const writes=new Map<string,{fd:number;identity:string;bytes:number;sha256:string}>();
 const exclusive=(path:string)=>{const fd=fs.openSync(path,C.O_CREAT|C.O_EXCL|C.O_RDWR|C.O_NOFOLLOW,0o600);try{const s=fs.fstatSync(fd,{bigint:true});hold(s.isFile()&&s.nlink===1n&&s.uid===BigInt(process.getuid!())&&(s.mode&0o777n)===0o600n,"private_output_leaf");return fd;}catch(e){fs.closeSync(fd);throw e;}};
 const writeAll=(fd:number,b:Buffer)=>{let p=0;while(p<b.length){tick();const n=fs.writeSync(fd,b,p,b.length-p);hold(n>0,"short_write");p+=n;}};
 async function publish(name:string,bytes:Buffer){guard();const path=join(output,name),fd=exclusive(path);try{writeAll(fd,bytes);fs.fsyncSync(fd);tick();writes.set(path,{fd,identity:stamp(fs.fstatSync(fd,{bigint:true})),bytes:bytes.length,sha256:digest(bytes)});}finally{if(!writes.has(path))fs.closeSync(fd);tick();}fs.fsyncSync(outputParent!);tick();await read(path,{bytes:bytes.length,sha256:digest(bytes)});}
 async function outputs(){for(const [p,r] of writes){guard();hold(stamp(fs.fstatSync(r.fd,{bigint:true}))===r.identity&&stamp(fs.lstatSync(p,{bigint:true}))===r.identity,"output_substitution");await read(p,r);}}
 const sourceLinks=new Map<string,{identity:string;link:Manifest["links"][number]}>();
 function observeLink(path:string,link:Manifest["links"][number]){
  keep(dirname(path));parent(dirname(path));guard();const before=fs.lstatSync(path,{bigint:true}),identity=stamp(before);
  hold(before.isSymbolicLink()&&before.nlink===1n,"source_link_shape");
  // readlink is metadata only: neither this observation nor census traverses it.
  const target=fs.readlinkSync(path);hold(target===link.target&&stamp(fs.lstatSync(path,{bigint:true}))===identity,"source_link_changed");
  const previous=sourceLinks.get(path);if(previous)hold(previous.identity===identity&&previous.link.target===target,"source_link_changed");
  sourceLinks.set(path,{identity,link});guard();
 }
 const rejoinLinks=()=>{for(const [path,observed] of sourceLinks)observeLink(path,observed.link);};
 async function census(root:string,expected:Map<string,FrameRow>,expectedLinks=new Map<string,Manifest["links"][number]>()){
  parent(root);const seen=new Set<string>(),seenLinks=new Set<string>();let count=0;
  async function walk(dir:string,prefix:string){guard();for(const name of fs.readdirSync(dir).sort()){
   safeRelative(name);hold(!name.includes("/"),"basename");const rel=prefix?prefix+"/"+name:name,path=join(dir,name),s=fs.lstatSync(path);hold(++count<=100000,"decoded_census");
   if(s.isSymbolicLink()){const link=expectedLinks.get(rel);hold(link,"decoded_census");observeLink(path,link);seenLinks.add(rel);}
   else{hold(!expectedLinks.has(rel),"source_link_shape");if(s.isDirectory()){parent(path);await walk(path,rel);}else{hold(s.isFile()&&expected.has(rel),"unknown_decoded_leaf");seen.add(rel);const r=expected.get(rel)!;const actual=await read(path,r);hold(actual.mode===r.mode,"decoded_mode");}}
   await yieldNow();guard();
  }}
  await walk(root,"");hold(seen.size===expected.size,"decoded_missing_leaf");hold(seenLinks.size===expectedLinks.size,"source_link_missing");
 }
 try{
  hold(resolve(selectionPath)===selectionPath&&resolve(output)===output&&output!=="/"&&!output.startsWith("/opt/")&&!output.startsWith("/run/"),"local_output");parent(dirname(selectionPath));hold(fs.lstatSync(selectionPath).size<=32*1024**2,"selection_bound");const selectionChunks:Buffer[]=[];const selectionFact=await read(selectionPath,undefined,b=>selectionChunks.push(Buffer.from(b)));hold(selectionFact.bytes<=32*1024**2&&selectionFact.sha256===selectionSha,"selection_pin");const selectionBytes=Buffer.concat(selectionChunks);const s=parseSelection(selectionBytes,selectionSha);await read(selectionPath,selectionFact);
  const managed=s.schemaVersion!==1&&s.outputMode===PublicProducerOutputMode.ManagedTestWorkspace;
  let managedWorkspace:string|undefined,managedJob:string|undefined,managedRoot:string|undefined;
  const outputContext=()=>{
   if(!managed){hold(!output.startsWith("/srv/"),"local_output");return;}
   const job=process.env.SUBSCRIPTION_RUNTIME_JOB_ID,root=process.env.SUBSCRIPTION_RUNTIME_JOB_ROOT;
   hold(process.platform==="linux"&&process.env.SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH==="1"&&typeof job==="string"&&/^TEST-[A-Za-z0-9][A-Za-z0-9_.-]{0,122}$/.test(job)&&root==="/srv/workers/jobs/"+job,"managed_output_context");
   const workspace=root+"/workspace";hold(process.cwd()===workspace&&fs.realpathSync(workspace)===workspace&&output===workspace+"/public-positive-payload","managed_output_workspace");
   if(managedWorkspace)hold(workspace===managedWorkspace&&job===managedJob&&root===managedRoot,"managed_output_context_changed");
   else{managedWorkspace=workspace;managedJob=job;managedRoot=root;keep(workspace);parent(workspace);}
  };outputContext();managedContextCheck=outputContext;
  const emittedRoots=s.schemaVersion!==1?s.emittedRoots:[];
  for(const pin of [selectionPath,...[s.compilerReceipt,s.artifactReceipt,s.nodeArchive,s.publicPackageImportAudit].map(p=>p.path)])hold(pin!==output&&!pin.startsWith(output+"/"),"output_input_overlap");
  for(const root of [s.sourceRoot,s.dependencyRoot,s.toolchainRoot,...emittedRoots])hold(output!==root&&!output.startsWith(root+"/")&&!root.startsWith(output+"/"),"output_input_overlap");
  for(const pin of [s.compilerReceipt,s.artifactReceipt,s.nodeArchive,s.publicPackageImportAudit])await read(pin.path,pin);
  for(const p of [dirname(selectionPath),s.sourceRoot,s.dependencyRoot,s.toolchainRoot,...emittedRoots]){keep(p);parent(p);}
  const gitIdentity=async()=>{hold((await command(["rev-parse","HEAD"],s.sourceRoot)).toString().trim()===s.sourceSha&&(await command(["rev-parse","HEAD^{tree}"],s.sourceRoot)).toString().trim()===s.sourceTree&&(await command(["status","--porcelain=v1","--untracked-files=all"],s.sourceRoot)).length===0,"original_clean_git");};await gitIdentity();
  const listed=(await command(["ls-tree","-r","-z","--full-tree",s.sourceSha],s.sourceRoot)).toString("utf8").split("\0");hold(listed.pop()==="","git_listing_eof");const tracked:Manifest["tracked"]=[];
  for(const line of listed){const m=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);hold(m,"tracked_regular");const path=m[3]!;safeRelative(path);const r=await read(join(s.sourceRoot,path));hold(r.mode===(m[1]==="100755"?493:420)&&r.gitBlob===m[2],"tracked_blob");tracked.push({path,bytes:r.bytes,mode:r.mode,sha256:r.sha256,gitBlob:r.gitBlob});}tracked.sort((a,b)=>a.path<b.path?-1:1);
  const sourceMap=new Map(tracked.map(r=>[r.path,r]));const manifest:Manifest={schemaVersion:1,kind:"FULL_POSITIVE_PUBLIC_PREPARATION_DATA_V1",sourceSha:s.sourceSha,sourceTree:s.sourceTree,bundle:{bytes:0,sha256:"0".repeat(64)},payload:{bytes:MAGIC.length+s.rows.reduce((n,r)=>n+8+r.bytes,0),sha256:"0".repeat(64)},producer:{inputReceiptSha256:selectionSha,packageSha256:sourceMap.get("package.json")?.sha256??"",lockSha256:sourceMap.get("package-lock.json")?.sha256??"",compilerReceiptSha256:s.compilerReceipt.sha256,nodeArchiveSha256:s.nodeArchive.sha256,publicPackageImportAuditSha256:s.publicPackageImportAudit.sha256},tracked,rows:s.rows,links:s.links,toolchainDirectories:s.toolchainDirectories};const validatedManifest=parseManifest(encode(manifest),digest(encode(manifest)));
  const depRows=new Map(s.rows.filter(r=>r.role===Role.Dependency).map(r=>[r.path.slice("node_modules/".length),r]));
  // V3 reads workspace package frames from canonical source/package files;
  // the installed alias is observed as a link and has no raw census descendants.
  const dependencyLinks=new Map(s.schemaVersion===3?validatedManifest.links.filter(l=>l.path.startsWith("source/node_modules/")).map(l=>[l.path.slice("source/node_modules/".length),l] as const):[]);
  if(s.schemaVersion!==3)for(const r of s.rows.filter(r=>r.role===Role.WorkspacePackage)){const rel=r.path.slice("node_modules/".length),path=join(s.dependencyRoot,rel);if(fs.existsSync(path))depRows.set(rel,r);}
  await census(s.dependencyRoot,depRows,dependencyLinks);await census(s.toolchainRoot,new Map(s.rows.filter(r=>r.role===Role.Toolchain).map(r=>[r.path,r])));
  const selectedEmits=new Map<string,string>(),observedEmits:{path:string;origins:{root:number;relativePath:string;bytes:number;sha256:string;mode:420|493}[]}[]=[];
  if(s.schemaVersion!==1)for(const mapping of s.emittedMappings){
   const row=s.rows.find(r=>r.role===Role.Emitted&&r.path===mapping.path);hold(row,"emitted_mapping_rows");
   const paths:string[]=[],facts:typeof observedEmits[number]["origins"]=[];
   for(const origin of mapping.origins){const path=join(s.emittedRoots[origin.root]!,origin.relativePath),actual=await read(path,row);hold(actual.mode===row.mode&&actual.permissions===row.mode,"emitted_mode");paths.push(path);facts.push({...origin,bytes:actual.bytes,sha256:actual.sha256,mode:actual.mode});}
   // Every origin has positively joined the SAME exact size/hash/mode pin.
   // Array/directory enumeration order never selects conflicting bytes.
   paths.sort();selectedEmits.set(mapping.path,paths[0]!);observedEmits.push({path:mapping.path,origins:facts});
  }
  const sourcePath=(r:FrameRow)=>r.role===Role.Toolchain?join(s.toolchainRoot,r.path):r.role===Role.Dependency?join(s.dependencyRoot,r.path.slice("node_modules/".length)):r.role===Role.WorkspacePackage?join(s.sourceRoot,"packages/agent-account-observability",r.path.slice("node_modules/@vioxen/agent-account-observability/".length)):s.schemaVersion!==1?selectedEmits.get(r.path)!:join(s.sourceRoot,r.path);
  for(const r of s.rows){const path=sourcePath(r);hold(typeof path==="string","emitted_mapping_rows");const actual=await read(path,r);hold(actual.mode===r.mode,"row_mode");}
  outputContext();
  parent(dirname(output));guard();const privateParent=fs.fstatSync(ancestors.get(dirname(output))!.fd,{bigint:true});hold(privateParent.uid===BigInt(process.getuid!())&&(privateParent.mode&0o777n)===0o700n,"private_output_parent");fs.mkdirSync(output,{mode:0o700});keep(output);parent(output);outputParent=fs.openSync(output,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);fs.fsyncSync(outputParent);tick();
  await yieldNow();guard();const bundlePath=join(output,"source.bundle"),bfd=exclusive(bundlePath);try{await command(["bundle","create","-","HEAD"],s.sourceRoot,bfd);fs.fsyncSync(bfd);tick();const bundle=await read(bundlePath);hold(bundle.identity===stamp(fs.fstatSync(bfd,{bigint:true})),"bundle_held_identity");hold(bundle.bytes<=LEAF,"bundle_bound");await command(["bundle","verify",bundlePath],s.sourceRoot);manifest.bundle={bytes:bundle.bytes,sha256:bundle.sha256};writes.set(bundlePath,{fd:bfd,identity:stamp(fs.fstatSync(bfd,{bigint:true})),bytes:bundle.bytes,sha256:bundle.sha256});}finally{if(!writes.has(bundlePath))fs.closeSync(bfd);tick();}
  const payloadPath=join(output,"public-files.payload"),fd=exclusive(payloadPath),hash=createHash("sha256");let bytes=0;const frame=(b:Buffer)=>{writeAll(fd,b);hash.update(b);bytes+=b.length;hold(bytes<=MAX,"payload_bound");};
  try{frame(MAGIC);for(const r of s.rows){const length=Buffer.alloc(8);length.writeBigUInt64BE(BigInt(r.bytes));frame(length);await read(sourcePath(r),r,frame);for(const [path,w] of writes)hold(stamp(fs.lstatSync(path,{bigint:true}))===w.identity,"published_output_changed");}fs.fsyncSync(fd);tick();manifest.payload={bytes,sha256:hash.digest("hex")};writes.set(payloadPath,{fd,identity:stamp(fs.fstatSync(fd,{bigint:true})),...manifest.payload});}finally{if(!writes.has(payloadPath))fs.closeSync(fd);tick();}fs.fsyncSync(outputParent);tick();
  parseManifest(encode(manifest),digest(encode(manifest)));await outputs();await census(s.dependencyRoot,depRows,dependencyLinks);await census(s.toolchainRoot,new Map(s.rows.filter(r=>r.role===Role.Toolchain).map(r=>[r.path,r])));await gitIdentity();for(const [path,record] of originals)if(!writes.has(path))await read(path,record.pin);await outputs();
  rejoinLinks();await publish("preparation-input.json",encode(manifest));rejoinLinks();await publish("producer-receipt.json",encode({schemaVersion:1,status:"PUBLIC_PAYLOAD_UNADMITTED_DATA",sourceSha:s.sourceSha,sourceTree:s.sourceTree,inputSelectionSha256:selectionSha,manifestSha256:digest(encode(manifest)),bundle:manifest.bundle,payload:manifest.payload,rows:manifest.rows.length,links:manifest.links,observedSourceFiles:originals.size,...(s.schemaVersion!==1?{selectionVersion:s.schemaVersion,outputMode:s.outputMode,emittedOrigins:observedEmits}:{}),nativeQualified:"UNPROVEN"}));await outputs();await gitIdentity();hold(JSON.stringify(fs.readdirSync(output).sort())===JSON.stringify(["preparation-input.json","producer-receipt.json","public-files.payload","source.bundle"]),"output_census");rejoinLinks();guard();
 }finally{let failure:unknown;for(const w of writes.values())try{fs.closeSync(w.fd);}catch(e){failure??=e;}if(outputParent!==undefined)try{fs.closeSync(outputParent);}catch(e){failure=e;}for(const h of [...ancestors.values()].reverse())try{fs.closeSync(h.fd);}catch(e){failure??=e;}try{tick();}finally{process.off("SIGINT",signal);process.off("SIGTERM",signal);}if(failure)throw failure;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){hold(process.argv.length===5,"argv");await producePositivePublicPayload(resolve(process.argv[2]!),process.argv[3]!,resolve(process.argv[4]!));}
