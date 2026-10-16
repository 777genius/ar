// Fixed TEST PUBLIC DATA staging only. No installation, activation or managed launch.
import * as fs from "node:fs";
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {setImmediate as yieldNow} from "node:timers/promises";
import {createRequire} from "node:module";
import {types as utilTypes} from "node:util";
import {pathToFileURL} from "node:url";

export const INTAKE="/srv/workers/public-intake/TEST-dependency-full-positive-scoped-20261014-r1/full-positive-installation-ptrace-v1";
export const MAGIC=Buffer.from("SR_PUBLIC_FILES_V1\n");
const C=fs.constants,MAX_BYTES=1024**3,MAX_LEAF=128*1024**2,MAX_DEPENDENCY_LEAF=512*1024**2,MAX_OBJECTS=100000;
const BOOTSTRAP="/opt/nodejs/node-v24.21.0-linux-x64/bin/node";
const BOOTSTRAP_SHA="7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c";
type Pin={bytes:number;sha256:string};
export type Row=Pin&{path:string;mode:420|493};
type Tracked=Row&{gitBlob:string};
export const Role={Emitted:"emitted",Dependency:"dependency",WorkspacePackage:"workspace_package",Toolchain:"toolchain"} as const;
export type Role=typeof Role[keyof typeof Role];
export type FrameRow=Row&{role:Role};
type Link={path:string;target:string;projection:"omit"|"workspace_package"};
export type Manifest={schemaVersion:1;kind:"FULL_POSITIVE_PUBLIC_PREPARATION_DATA_V1";sourceSha:string;sourceTree:string;
 bundle:Pin;payload:Pin;producer:{inputReceiptSha256:string;lockSha256:string;packageSha256:string;compilerReceiptSha256:string;nodeArchiveSha256:string;publicPackageImportAuditSha256:string};
 tracked:Tracked[];rows:FrameRow[];links:Link[];toolchainDirectories:string[]};
const knownLinks:Link[]=[
 ...Object.entries({tsserver:"../typescript/bin/tsserver",nanoid:"../nanoid/bin/nanoid.cjs",rolldown:"../rolldown/bin/cli.mjs",vitest:"../vitest/vitest.mjs","node-which":"../which/bin/node-which",tsc:"../typescript/bin/tsc",vite:"../vite/bin/vite.js","why-is-node-running":"../why-is-node-running/cli.js","anthropic-ai-sdk":"../@anthropic-ai/sdk/bin/cli"}).map(([name,target])=>({path:`source/node_modules/.bin/${name}`,target,projection:"omit" as const})),
 {path:"source/node_modules/@vioxen/agent-account-observability",target:"../../packages/agent-account-observability",projection:"workspace_package"},
 {path:"toolchain/bin/corepack",target:"../lib/node_modules/corepack/dist/corepack.js",projection:"omit"},
 {path:"toolchain/bin/npm",target:"../lib/node_modules/npm/bin/npm-cli.js",projection:"omit"},
 {path:"toolchain/bin/npx",target:"../lib/node_modules/npm/bin/npx-cli.js",projection:"omit"},
];
function hold(ok:unknown,why:string):asserts ok {if(!ok)throw new Error(`PUBLIC_STAGE_HOLD:${why}`);}
const sha=(v:Uint8Array)=>createHash("sha256").update(v).digest("hex");
const digest=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
function fields(v:unknown,names:string):asserts v is Record<string,unknown>{hold(v!==null&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join(",")===names,"fields");}
export function safeRelative(v:unknown):asserts v is string {hold(typeof v==="string"&&v.length>0&&v.length<=240&&/^[A-Za-z0-9_@+./-]+$/.test(v)&&v.split("/").length<=32&&!v.split("/").some(p=>!p||p==="."||p===".."||/^(?:auth\.json(?:[.-].*)?|credentials?\.json(?:[.-].*)?|.*\.pem|\.env.*)$/i.test(p)),"relative_path");}
function pin(v:unknown):asserts v is Pin {fields(v,"bytes,sha256");hold(Number.isSafeInteger(v.bytes)&&Number(v.bytes)>=0&&Number(v.bytes)<=MAX_BYTES&&digest(v.sha256),"pin");}
function row(v:unknown,extra:string):asserts v is Row&Record<string,unknown>{
 fields(v,("bytes,"+extra+"mode,path,sha256").split(",").sort().join(","));safeRelative(v.path);let maximum=MAX_LEAF;
 if(extra==="role,"){
  hold(Object.values(Role).includes(v.role as Role),"role");
  // Only validated third-party dependency leaves use the measured larger
  // bound. Tracked/emitted/workspace/toolchain and non-frame limits stay 128MiB.
  if(v.role===Role.Dependency){hold(v.path.startsWith("node_modules/")&&!v.path.startsWith("node_modules/.bin/")&&!v.path.startsWith("node_modules/@vioxen/agent-account-observability/"),"dependency_path");maximum=MAX_DEPENDENCY_LEAF;}
 }
 hold(Number.isSafeInteger(v.bytes)&&Number(v.bytes)>=0&&Number(v.bytes)<=maximum&&(v.mode===0o644||v.mode===0o755)&&digest(v.sha256),"row");
}
function orderedUnique(values:string[]):void {hold(values.every((v,i)=>i===0||values[i-1]!<v),"sorted_unique");}
export function parseManifest(bytes:Buffer,expectedSha:string):Manifest {
 hold(digest(expectedSha)&&bytes.length<=32*1024**2&&sha(bytes)===expectedSha,"manifest_digest");
 const v:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
 fields(v,"bundle,kind,links,payload,producer,rows,schemaVersion,sourceSha,sourceTree,toolchainDirectories,tracked");
 hold(v.schemaVersion===1&&v.kind==="FULL_POSITIVE_PUBLIC_PREPARATION_DATA_V1"&&typeof v.sourceSha==="string"&&/^[a-f0-9]{40}$/.test(v.sourceSha)&&typeof v.sourceTree==="string"&&/^[a-f0-9]{40}$/.test(v.sourceTree),"manifest_identity");
 pin(v.bundle);pin(v.payload);hold(v.bundle.bytes<=MAX_LEAF,"bundle_leaf");
 fields(v.producer,"compilerReceiptSha256,inputReceiptSha256,lockSha256,nodeArchiveSha256,packageSha256,publicPackageImportAuditSha256");hold(Object.values(v.producer).every(digest),"producer_pins");
 hold(Array.isArray(v.tracked)&&Array.isArray(v.rows)&&Array.isArray(v.links)&&Array.isArray(v.toolchainDirectories)&&v.tracked.length>0&&v.rows.length>0&&v.tracked.length+v.rows.length+v.toolchainDirectories.length<=MAX_OBJECTS,"manifest_counts");
 for(const r of v.tracked){row(r,"gitBlob,");hold(typeof r.gitBlob==="string"&&/^[a-f0-9]{40}$/.test(r.gitBlob)&&r.path!==".git"&&!r.path.startsWith(".git/")&&!r.path.startsWith("node_modules/"),"tracked");}
 for(const r of v.rows){row(r,"role,");}
 return finishManifest(v as unknown as Manifest);
}
function finishManifest(m:Manifest):Manifest {
 // Frame rows have an additional discriminator; validation above is intentionally
 // performed by the dedicated exact row check below, never archive metadata.
 for(const r of m.rows){row(r,"role,");
  if(r.role===Role.Emitted)hold(/^(?:dist|packages|scripts|host-integration|src)\//.test(r.path)&&/\.(?:js|mjs|cjs|json|map|ts)$/.test(r.path),"emitted_path");
  if(r.role===Role.WorkspacePackage)hold(/^node_modules\/@vioxen\/agent-account-observability\/(?:package\.json|README\.md|dist\/.+)$/.test(r.path),"workspace_package_path");
 }
 orderedUnique(m.tracked.map(r=>r.path));orderedUnique(m.rows.map(r=>`${r.role===Role.Toolchain?"toolchain":"source"}/${r.path}`));
 for(const d of m.toolchainDirectories)safeRelative(d);orderedUnique(m.toolchainDirectories);
 for(const l of m.links){fields(l,"path,projection,target");hold(typeof l.path==="string"&&typeof l.target==="string","link");}
 hold(new Set(m.links.map(l=>l.path)).size===m.links.length&&m.links.every(l=>knownLinks.some(k=>k.path===l.path&&k.target===l.target&&k.projection===l.projection))&&knownLinks.filter(l=>l.path.startsWith("toolchain/")).every(l=>m.links.some(k=>k.path===l.path)),"exact_known_links");
 const tracked=new Map(m.tracked.map(r=>[r.path,r]));let total=m.tracked.reduce((n,r)=>n+r.bytes,0);
 for(const r of m.rows){const t=r.role!==Role.Toolchain?tracked.get(r.path):undefined;if(t)hold(r.role===Role.Emitted&&t.bytes===r.bytes&&t.mode===r.mode&&t.sha256===r.sha256,"tracked_overlay_equal");else total+=r.bytes;}
 const files=new Set(m.tracked.map(r=>`source/${r.path}`));for(const r of m.rows)files.add(`${r.role===Role.Toolchain?"toolchain":"source"}/${r.path}`);
 const directories=new Set(m.toolchainDirectories.map(d=>`toolchain/${d}`));for(const f of files){const parts=f.split("/");parts.pop();while(parts.length){const d=parts.join("/");hold(!files.has(d),"file_directory_collision");directories.add(d);parts.pop();}}hold([...directories].every(d=>!files.has(d))&&files.size+directories.size+8<=MAX_OBJECTS,"projected_object_bound");
 hold(total<=MAX_BYTES&&m.payload.bytes===MAGIC.length+m.rows.reduce((n,r)=>n+8+r.bytes,0),"whole_bounds");
 hold(tracked.get("package.json")?.sha256===m.producer.packageSha256&&tracked.get("package-lock.json")?.sha256===m.producer.lockSha256,"source_dependency_binding");
 for(const l of m.links.filter(l=>l.projection==="omit")){const [scope,...parts]=l.path.split("/"),resolved=new URL(l.target,`file:///${parts.slice(0,-1).join("/")}/`).pathname.slice(1);hold(m.rows.some(r=>(r.role===Role.Toolchain?"toolchain":"source")===scope&&r.path===resolved),"omitted_same_tree_target");hold(!m.rows.some(r=>`${r.role===Role.Toolchain?"toolchain":"source"}/${r.path}`===l.path),"omitted_leaf_present");}
 for(const r of m.rows.filter(r=>r.role===Role.WorkspacePackage)){const original=`packages/agent-account-observability/${r.path.slice("node_modules/@vioxen/agent-account-observability/".length)}`,t=tracked.get(original)??m.rows.find(t=>t.role===Role.Emitted&&t.path===original);hold(t&&t.sha256===r.sha256&&t.bytes===r.bytes&&t.mode===r.mode,"workspace_source_row_join");}
 const packagePrefix="packages/agent-account-observability/",publicPrefix="node_modules/@vioxen/agent-account-observability/";
 const packageFiles=[...m.tracked,...m.rows.filter(r=>r.role===Role.Emitted)].filter(r=>r.path.startsWith(packagePrefix)&&/^(?:package\.json|README\.md|dist\/.+)$/.test(r.path.slice(packagePrefix.length))).map(r=>r.path.slice(packagePrefix.length));
 hold(JSON.stringify([...new Set(packageFiles)].sort())===JSON.stringify(m.rows.filter(r=>r.role===Role.WorkspacePackage).map(r=>r.path.slice(publicPrefix.length)).sort())&&["package.json","README.md","dist/index.js"].every(p=>packageFiles.includes(p)),"complete_workspace_public_package");
 hold(m.rows.some(r=>r.role===Role.Toolchain&&r.path==="bin/node")&&m.rows.some(r=>r.role===Role.Toolchain&&r.path==="lib/node_modules/npm/package.json"),"full_node_npm");
 return m;
}
type Guard=()=>void;
/** Strict positional regular-file framing. No names, extraction or path resolution. */
export async function* readRegularFrames(fd:number,rows:readonly FrameRow[],guard:Guard):AsyncGenerator<{row:FrameRow;bytes:Buffer;last:boolean}> {
 const before=fs.fstatSync(fd,{bigint:true});hold(before.isFile()&&before.nlink===1n,"payload_regular");let offset=0;
 const read=(length:number)=>{guard();const b=Buffer.alloc(length);let n=0;while(n<length){const k=fs.readSync(fd,b,n,length-n,offset+n);hold(k>0,"short_payload");n+=k;}offset+=length;guard();return b;};
 hold(read(MAGIC.length).equals(MAGIC),"payload_magic");
 for(const row of rows){hold(read(8).readBigUInt64BE()===BigInt(row.bytes),"frame_size");const hash=createHash("sha256");let left=row.bytes;
  if(left===0)yield {row,bytes:Buffer.alloc(0),last:true};
  while(left){const b=read(Math.min(left,1024**2));left-=b.length;hash.update(b);yield {row,bytes:b,last:left===0};guard();await yieldNow();guard();}
  hold(hash.digest("hex")===row.sha256,"frame_hash");
 }
 const eof=Buffer.alloc(1);hold(fs.readSync(fd,eof,0,1,offset)===0&&BigInt(offset)===before.size,"payload_eof");
 const after=fs.fstatSync(fd,{bigint:true});hold(before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.ctimeNs===after.ctimeNs&&before.mtimeNs===after.mtimeNs,"payload_changed");guard();
}
/** Pure retained-FD/name join; does not attest host/root or grant authority. */
export function assertRegularName(fd:number,name:string):void {
 const held=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(name,{bigint:true});hold(held.isFile()&&held.nlink===1n&&named.isFile()&&!named.isSymbolicLink()&&named.nlink===1n&&named.dev===held.dev&&named.ino===held.ino&&named.mode===held.mode&&named.uid===held.uid&&named.gid===held.gid,"regular_name_substitution");
 const reopened=fs.openSync(name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);try{const current=fs.fstatSync(reopened,{bigint:true});hold(current.dev===held.dev&&current.ino===held.ino&&current.nlink===1n,"regular_name_reopen");}finally{fs.closeSync(reopened);}
}
export const STAGE_BUDGET_MS=900000;
/** Bounded observational DATA only; no clock, deadline, guard or custody decision. */
export const CStageProgressPhase=Object.freeze({initial_pins:"initial_pins",source_roots:"source_roots",git_clone:"git_clone",tracked_modes:"tracked_modes",git_metadata_before:"git_metadata_before",git_check_before:"git_check_before",tracked_census:"tracked_census",toolchain_directories:"toolchain_directories",payload_frames:"payload_frames",source_census:"source_census",toolchain_census:"toolchain_census",git_check_after:"git_check_after",git_metadata_after:"git_metadata_after",public_metadata:"public_metadata",catalog:"catalog",source_readback:"source_readback",staging_receipt:"staging_receipt",complete:"complete"} as const);
export type CStageProgressPhase=typeof CStageProgressPhase[keyof typeof CStageProgressPhase];
export type CStageProgressCounters={objects:number;processedObjects:number;processedBytes:number;guardCalls:number};
export function createCStageProgressEncoder(){
 const periodicLimit=64-Object.keys(CStageProgressPhase).length-1,cadenceMs=Math.ceil(STAGE_BUDGET_MS/periodicLimit),seenPhases=new Set<CStageProgressPhase>();
 let sequence=0,cadence=0,lastElapsed=-1,lastPhase:CStageProgressPhase|undefined,finalEmitted=false;
 return (phase:CStageProgressPhase,elapsedMs:number,counters:CStageProgressCounters,force=false):Buffer|null=>{
  if(sequence>=64||!Object.values(CStageProgressPhase).includes(phase)||!Number.isSafeInteger(elapsedMs)||elapsedMs<0||elapsedMs>STAGE_BUDGET_MS||elapsedMs<lastElapsed||counters===null||typeof counters!=='object'||utilTypes.isProxy(counters)||Object.getPrototypeOf(counters)!==Object.prototype)return null;
  const own=Object.getOwnPropertyDescriptors(counters) as Record<string,PropertyDescriptor>,keys=['objects','processedObjects','processedBytes','guardCalls'] as const;
  if(Reflect.ownKeys(own).length!==keys.length||keys.some(k=>!own[k]||!Object.hasOwn(own[k]!,'value')||!own[k]!.enumerable||!Number.isSafeInteger(own[k]!.value)||own[k]!.value<0||Object.is(own[k]!.value,-0)))return null;
  if(own.objects!.value>100000||own.processedObjects!.value>1600000||own.processedBytes!.value>16*1024**3||own.guardCalls!.value>12800000)return null;
  const changed=phase!==lastPhase;if(changed&&seenPhases.has(phase)||force&&finalEmitted)return null;if(!changed&&!force&&(elapsedMs-lastElapsed<cadenceMs||cadence>=periodicLimit))return null;
  const bytes=Buffer.from(JSON.stringify({kind:'C_STAGE_PROGRESS',version:1,sequence:sequence+1,phase,elapsedMs,objects:own.objects!.value,processedObjects:own.processedObjects!.value,processedBytes:own.processedBytes!.value,guardCalls:own.guardCalls!.value})+'\n');
  if(bytes.length>256)return null;sequence++;if(changed)seenPhases.add(phase);if(force)finalEmitted=true;if(!changed&&!force)cadence++;lastElapsed=elapsedMs;lastPhase=phase;return bytes;
 };
}
/** Operation-local successful EXACT-text parse memo only. Every guard still
 * freshly reads and bounds the full kernel text and rejoins boot/ns/FD state. */
export function createCExactMountBoundaryValidator():(lines:string)=>void {
 let successful:string|undefined;
 return (lines:string)=>{
  hold(Buffer.byteLength(lines)<=8*1024**2,"mountinfo_bound");
  if(lines===successful)return;
  for(const l of lines.trim().split("\n")){const p=l.split(" ")[4];hold(p,"mountinfo");hold(!(p!=="/srv/workers"&&p!=="/"&&INTAKE.startsWith(p+"/"))&&!p.startsWith(INTAKE+"/")&&p!==INTAKE,"intake_mount_boundary");}
  successful=lines;
 };
}
type Held={fd:number;name:string;real:string;directory:boolean;dev:bigint;ino:bigint;mode:bigint;mnt:string;size:bigint;ctime:bigint;mtime:bigint;parentHeld:Held|undefined;live:boolean};
const fdPath=(h:Held)=>`/proc/self/fd/${h.fd}`;
function mount(fd:number):string {const m=/^mnt_id:\s+(\d+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`,"utf8"));hold(m,"fd_mount");return m[1]!;}
function absent(path:string):void {try{fs.lstatSync(path);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return;throw e;}throw new Error("PUBLIC_STAGE_HOLD:already_exists");}
export function writeRegularBytes(fd:number,b:Buffer,guard:Guard):void {for(let off=0;off<b.length;){guard();const n=fs.writeSync(fd,b,off,b.length-off);hold(n>0,"short_write");off+=n;guard();}}
/** Held regular-file finalization; caller owns the create-only destination FD. */
export function sealRegularFile(fd:number,row:Row,guard:Guard):void {
 guard();const before=fs.fstatSync(fd,{bigint:true});hold(before.isFile()&&before.nlink===1n&&before.size===BigInt(row.bytes),"output_regular_size");
 fs.fchmodSync(fd,row.mode);guard();fs.fsyncSync(fd);guard();const hash=createHash("sha256"),buffer=Buffer.alloc(1024**2);let offset=0;
 while(offset<row.bytes){guard();const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,row.bytes-offset),offset);hold(n>0,"output_short");hash.update(buffer.subarray(0,n));offset+=n;guard();}
 hold(hash.digest("hex")===row.sha256&&fs.readSync(fd,buffer,0,1,offset)===0,"output_hash_eof");const after=fs.fstatSync(fd,{bigint:true});hold(after.dev===before.dev&&after.ino===before.ino&&after.size===before.size&&(after.mode&0o7777n)===BigInt(row.mode)&&after.nlink===1n,"output_seal_changed");guard();
}
export async function stageCurrentPositivePublic(manifestSha:string):Promise<void> {
 hold(process.platform==="linux"&&process.arch==="x64"&&process.getuid?.()===0&&process.getgid?.()===0&&process.execPath===BOOTSTRAP,"fixed_linux_root_bootstrap");
 const originalUmask=process.umask(0o077);const deadline=performance.now()+STAGE_BUDGET_MS,handles:Held[]=[],sources:Held[]=[],anchors:Held[]=[];let cancelled=false,objects=0;let processedObjects=0,processedBytes=0,guardCalls=0,progressPhase:CStageProgressPhase=CStageProgressPhase.initial_pins;const encodeProgress=createCStageProgressEncoder();const progress=(force=false)=>{const b=encodeProgress(progressPhase,Math.max(0,Math.floor(performance.now()-(deadline-STAGE_BUDGET_MS))),{objects,processedObjects,processedBytes,guardCalls},force);if(b)try{fs.writeSync(2,b);}catch{/* Diagnostics never replace the original operation result. */}};const setProgress=(phase:CStageProgressPhase)=>{progressPhase=phase;progress();};progress();const signal=()=>{cancelled=true;};
 process.on("SIGTERM",signal);process.on("SIGINT",signal);const boot=fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8"),namespace=fs.readlinkSync("/proc/self/ns/mnt");let workers:Held|undefined,activeTarget:Held|undefined;
 const check=(h:Held)=>{hold(h.live,"closed_held");const s=fs.fstatSync(h.fd,{bigint:true}),n=fs.lstatSync(h.name,{bigint:true});hold(s.dev===h.dev&&s.ino===h.ino&&s.mode===h.mode&&s.uid===0n&&s.gid===0n&&!n.isSymbolicLink()&&n.dev===s.dev&&n.ino===s.ino&&n.mode===s.mode&&(h.directory||n.isFile()&&n.nlink===1n&&n.uid===s.uid&&n.gid===s.gid)&&mount(h.fd)===h.mnt&&fs.realpathSync.native(fdPath(h))===h.real&&(h.directory?s.isDirectory():s.isFile()&&s.nlink===1n&&s.size===h.size&&s.ctimeNs===h.ctime&&s.mtimeNs===h.mtime),"held_named_changed");const fd=fs.openSync(h.name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK|(h.directory?C.O_DIRECTORY:0));try{const current=fs.fstatSync(fd,{bigint:true});hold((h.directory||current.dev===s.dev&&current.ino===s.ino&&current.nlink===1n)&&mount(fd)===h.mnt&&current.ino===h.ino,"reopened_mount");}finally{fs.closeSync(fd);}};
 const validateMountInfo=createCExactMountBoundaryValidator();
 const baseGuard=()=>{hold(!cancelled&&performance.now()<deadline,"cancelled_or_deadline");hold(boot===fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8")&&namespace===fs.readlinkSync("/proc/self/ns/mnt"),"boot_namespace_changed");validateMountInfo(fs.readFileSync("/proc/self/mountinfo","utf8"));};
 const guard=()=>{guardCalls++;hold(!cancelled&&performance.now()<deadline,"cancelled_or_deadline");hold(boot===fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8")&&namespace===fs.readlinkSync("/proc/self/ns/mnt"),"boot_namespace_changed");for(const h of new Set([...anchors,...sources,...(activeTarget?[activeTarget]:[])]))check(h);validateMountInfo(fs.readFileSync("/proc/self/mountinfo","utf8"));progress();};
 const scopedGuard=(...selected:Held[])=>{guardCalls++;baseGuard();const checked=new Set<Held>();for(const target of selected){const chain:Held[]=[],seen=new Set<Held>();let h:Held|undefined=target;while(h){hold(h.live&&!seen.has(h)&&chain.length<128,"scope_parent_closed_or_cycle");seen.add(h);chain.push(h);h=h.parentHeld;}hold(chain.at(-1)?.name==="/","scope_root");for(const member of chain.reverse())if(!checked.has(member)){check(member);checked.add(member);}}progress();};
 const open=(name:string,directory:boolean):Held=>{const fd=fs.openSync(name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK|(directory?C.O_DIRECTORY:0));try{const parentMatch=/^\/proc\/self\/fd\/(\d+)\/([^/]+)$/.exec(name);const parentHeld=parentMatch?handles.find(h=>h.fd===Number(parentMatch[1])&&h.directory&&h.live):undefined;hold(name==="/"||!!parentHeld,"scope_open_parent");const s=fs.fstatSync(fd,{bigint:true});hold((s.mode&0o022n)===0n,"writable_input");const h:Held={fd,name,real:fs.realpathSync.native(`/proc/self/fd/${fd}`),directory,dev:s.dev,ino:s.ino,mode:s.mode,mnt:mount(fd),size:s.size,ctime:s.ctimeNs,mtime:s.mtimeNs,parentHeld,live:true};handles.push(h);scopedGuard(h);if(workers&&h.real.startsWith("/srv/workers/"))hold(h.dev===workers.dev&&h.mnt===workers.mnt,"nested_mount");return h;}catch(e){if(!handles.some(h=>h.fd===fd))fs.closeSync(fd);throw e;}};
 const release=(h:Held)=>{check(h);hold(!handles.some(child=>child.live&&child.parentHeld===h),"release_live_child");handles.splice(handles.indexOf(h),1);h.live=false;fs.closeSync(h.fd);};
 const prune=()=>{if(activeTarget)return;for(const h of [...handles].reverse())if(h.directory&&!anchors.includes(h))release(h);};
 const hashFile=async(h:Held,expected:Pin,blob?:string)=>{scopedGuard(h);hold(h.size===BigInt(expected.bytes),"leaf_size");const hash=createHash("sha256"),git=blob?createHash("sha1").update(`blob ${expected.bytes}\0`):undefined,b=Buffer.alloc(1024**2);let off=0;while(off<expected.bytes){scopedGuard(h);const n=fs.readSync(h.fd,b,0,Math.min(b.length,expected.bytes-off),off);hold(n>0,"leaf_short");processedBytes+=n;hash.update(b.subarray(0,n));git?.update(b.subarray(0,n));off+=n;await yieldNow();scopedGuard(h);}hold(fs.readSync(h.fd,b,0,1,off)===0&&hash.digest("hex")===expected.sha256&&(!git||git.digest("hex")===blob),"leaf_hash_eof");scopedGuard(h);processedObjects++;};
 const child=async(args:string[],bundle:Held,source:Held):Promise<string>=>{guard();const result=await new Promise<string>((resolve,reject)=>{const proc=spawn("/usr/bin/git",["-c","core.hooksPath=/dev/null","-c","gc.auto=0","-c","maintenance.auto=false",...args],{shell:false,env:{PATH:"/usr/bin:/bin",HOME:"/",TMPDIR:INTAKE,LANG:"C",LC_ALL:"C",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_TERMINAL_PROMPT:"0"},stdio:["ignore","pipe","pipe",bundle.fd,source.fd],timeout:Math.max(1,Math.floor(deadline-performance.now())),killSignal:"SIGKILL"});const chunks:Buffer[]=[];let bytes=0;const data=(b:Buffer)=>{bytes+=b.length;if(bytes>16*1024**2){proc.kill("SIGKILL");return;}chunks.push(b);};proc.stdout!.on("data",data);proc.stderr!.on("data",b=>{bytes+=b.length;if(bytes>16*1024**2)proc.kill("SIGKILL");});const abort=()=>proc.kill("SIGKILL");process.on("SIGTERM",abort);process.on("SIGINT",abort);proc.on("error",reject);proc.on("close",(code,sig)=>{process.off("SIGTERM",abort);process.off("SIGINT",abort);if(code!==0||sig||bytes>16*1024**2)reject(new Error("PUBLIC_STAGE_HOLD:git_failure_uncertain"));else resolve(Buffer.concat(chunks).toString("utf8"));});});guard();return result;};
 const fresh=(parent:Held,name:string):Held=>{scopedGuard(parent);check(parent);hold(++objects<=MAX_OBJECTS,"object_bound");safeRelative(name);hold(!name.includes("/"),"fresh_basename");const path=`${fdPath(parent)}/${name}`;absent(path);fs.mkdirSync(path,{mode:0o700});const h=open(path,true);fs.fchmodSync(h.fd,0o700);fs.fsyncSync(h.fd);fs.fsyncSync(parent.fd);scopedGuard(parent);return h;};
 const parents=(root:Held,path:string):{parent:Held;leaf:string}=>{safeRelative(path);const pieces=path.split("/"),leaf=pieces.pop()!;let parent=root;for(const part of pieces){const name=`${fdPath(parent)}/${part}`;let h=handles.find(h=>h.name===name&&h.directory);if(!h){try{h=open(name,true);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;h=fresh(parent,part);}}check(h);parent=h;}check(parent);return {parent,leaf};};
 const verify=async(root:Held,r:Row,blob?:string)=>{const {parent,leaf}=parents(root,r.path),h=open(`${fdPath(parent)}/${leaf}`,false);try{hold((h.mode&0o7777n)===BigInt(r.mode),"leaf_mode");await hashFile(h,r,blob);}finally{release(h);prune();}};
 const writeRecord=async(parent:Held,name:string,value:unknown)=>{guard();const bytes=encode(value);hold(bytes.length<=MAX_LEAF,"record_bound");hold(++objects<=MAX_OBJECTS,"object_bound");const path=`${fdPath(parent)}/${name}`,fd=fs.openSync(path,C.O_RDWR|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o400);try{writeRegularBytes(fd,bytes,guard);fs.fchmodSync(fd,0o400);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.fsyncSync(parent.fd);const h=open(path,false);try{await hashFile(h,{bytes:bytes.length,sha256:sha(bytes)});}finally{release(h);}return sha(bytes);};
 try {
  setProgress(CStageProgressPhase.initial_pins);let dir=open("/",true);anchors.push(dir);for(const part of ["srv","workers","public-intake","TEST-dependency-full-positive-scoped-20261014-r1","full-positive-installation-ptrace-v1"]){dir=open(`${fdPath(dir)}/${part}`,true);anchors.push(dir);if(part==="workers")workers=dir;}guard();const intake=dir;
  let executableParent=handles[0]!;const bootstrapParts=BOOTSTRAP.split("/").slice(1),bootstrapLeaf=bootstrapParts.pop()!;for(const part of bootstrapParts){executableParent=open(`${fdPath(executableParent)}/${part}`,true);anchors.push(executableParent);}const executable=open(`${fdPath(executableParent)}/${bootstrapLeaf}`,false);sources.push(executable);await hashFile(executable,{bytes:Number(executable.size),sha256:BOOTSTRAP_SHA});
  const manifestFile=open(`${fdPath(intake)}/preparation-input.json`,false);sources.push(manifestFile);hold(manifestFile.size<=32n*1024n**2n,"manifest_size");const manifestBytes=fs.readFileSync(manifestFile.fd),manifest=parseManifest(manifestBytes,manifestSha);check(manifestFile);
  const bundle=open(`${fdPath(intake)}/source.bundle`,false),payload=open(`${fdPath(intake)}/public-files.payload`,false);sources.push(bundle,payload);await hashFile(bundle,manifest.bundle);await hashFile(payload,manifest.payload);
  const space=fs.statfsSync(fdPath(workers!),{bigint:true});hold(space.bavail*space.bsize>=BigInt(MAX_BYTES)&&space.ffree>=BigInt(MAX_OBJECTS),"scratch_fit");guard();
  setProgress(CStageProgressPhase.source_roots);const input=fresh(intake,"input"),version=fresh(input,manifest.sourceSha),source=fresh(version,"source"),toolchain=fresh(version,"toolchain");anchors.push(input,version,source,toolchain);
  const git=(args:string[])=>child(args,bundle,source);
  setProgress(CStageProgressPhase.git_clone);await git(["clone","--template=","--no-checkout","--no-hardlinks","--","/proc/self/fd/3","/proc/self/fd/4"]);await git(["-C","/proc/self/fd/4","bundle","verify","/proc/self/fd/3"]);  const gitListing=await git(["-C","/proc/self/fd/4","ls-tree","-r","-z",manifest.sourceSha]),expectedListing=manifest.tracked.map(r=>`${r.mode===0o755?"100755":"100644"} blob ${r.gitBlob}\t${r.path}\0`).join("");hold(gitListing===expectedListing,"exact_tracked_git_rows");
  await git(["-C","/proc/self/fd/4","checkout","--detach",manifest.sourceSha]);
  // Git honors the restrictive caller umask. Restore only reviewed tracked modes
  // through held fresh-clone FDs before the first authenticated byte census.
  setProgress(CStageProgressPhase.tracked_modes);for(const r of manifest.tracked){const {parent,leaf}=parents(source,r.path),h=open(`${fdPath(parent)}/${leaf}`,false);fs.fchmodSync(h.fd,r.mode);fs.fsyncSync(h.fd);const stat=fs.fstatSync(h.fd,{bigint:true});h.mode=stat.mode;h.ctime=stat.ctimeNs;h.mtime=stat.mtimeNs;release(h);prune();processedObjects++;progress();}


  const gitCheck=async()=>{await git(["-C","/proc/self/fd/4","fsck","--full","--strict"]);hold((await git(["-C","/proc/self/fd/4","rev-parse","HEAD"])).trim()===manifest.sourceSha&&(await git(["-C","/proc/self/fd/4","rev-parse","HEAD^{tree}"])).trim()===manifest.sourceTree&&(await git(["-C","/proc/self/fd/4","status","--porcelain","--untracked-files=no"]))==="","git_identity_clean");hold(fs.readFileSync(`${fdPath(source)}/.git/HEAD`,"utf8")===manifest.sourceSha+"\n","detached");for(const rel of [".git/objects/info/alternates",".git/objects/info/http-alternates",".git/shallow",".git/info/grafts"])absent(`${fdPath(source)}/${rel}`);hold((await git(["-C","/proc/self/fd/4","for-each-ref","refs/replace"]))==="","replace_refs");for(const r of manifest.tracked)await verify(source,r,r.gitBlob);};
  const census=async(root:Held,rows:Row[],skipGit:boolean,empty:string[]=[])=>{const expected=new Map(rows.map(r=>[r.path,r])),seen=new Set<string>(),dirs=new Set(empty);for(const r of rows){let p=r.path.split("/");p.pop();while(p.length){dirs.add(p.join("/"));p.pop();}}let leaves=0,directories=0;const walk=async(h:Held,prefix:string)=>{scopedGuard(h);for(const name of fs.readdirSync(fdPath(h))){safeRelative(name);const rel=prefix?`${prefix}/${name}`:name;if(skipGit&&rel===".git")continue;const path=`${fdPath(h)}/${name}`,s=fs.lstatSync(path);hold(!s.isSymbolicLink(),"census_link");if(s.isDirectory()){hold(dirs.has(rel),"census_directory");hold(++directories<=16384,"directory_bound");const sub=handles.find(x=>x.name===path&&x.directory)||open(path,true);await walk(sub,rel);fs.fsyncSync(sub.fd);if(!anchors.includes(sub))release(sub);}else{hold(s.isFile()&&expected.has(rel)&&!seen.has(rel)&&++leaves<=65536,"census_leaf");seen.add(rel);}await yieldNow();scopedGuard(h);}};await walk(root,"");hold(seen.size===expected.size,"census_complete");for(const r of rows)await verify(root,r);fs.fsyncSync(root.fd);return {leaves,directories,bytes:rows.reduce((n,r)=>n+r.bytes,0)};};
  const gitMetadata=async()=>{let count=0,total=0;const walk=async(h:Held)=>{scopedGuard(h);for(const name of fs.readdirSync(fdPath(h))){safeRelative(name);hold(!name.includes("/"),"git_basename");const path=`${fdPath(h)}/${name}`,stat=fs.lstatSync(path,{bigint:true});hold(++count<=MAX_OBJECTS&&!stat.isSymbolicLink(),"git_metadata_bound");processedObjects++;if(stat.isDirectory()){const sub=open(path,true);await walk(sub);fs.fsyncSync(sub.fd);release(sub);}else{hold(stat.isFile()&&stat.nlink===1n&&stat.size<=BigInt(MAX_LEAF),"git_metadata_regular");const leaf=open(path,false);total+=Number(leaf.size);hold(total<=MAX_BYTES,"git_metadata_bytes");fs.fsyncSync(leaf.fd);release(leaf);}await yieldNow();scopedGuard(h);}};const root=open(`${fdPath(source)}/.git`,true);try{await walk(root);fs.fsyncSync(root.fd);}finally{release(root);}return {objects:count,bytes:total};};
  setProgress(CStageProgressPhase.git_metadata_before);const metadataBefore=await gitMetadata();hold(metadataBefore.bytes+manifest.tracked.reduce((n,r)=>n+r.bytes,0)+manifest.rows.filter(r=>r.role===Role.Toolchain||!manifest.tracked.some(t=>t.path===r.path)).reduce((n,r)=>n+r.bytes,0)<=MAX_BYTES,"whole_git_source_toolchain_bytes");
  setProgress(CStageProgressPhase.git_check_before);await gitCheck();setProgress(CStageProgressPhase.tracked_census);await census(source,manifest.tracked,true);
  setProgress(CStageProgressPhase.toolchain_directories);for(const d of manifest.toolchainDirectories){const {parent,leaf}=parents(toolchain,d),path=`${fdPath(parent)}/${leaf}`;try{open(path,true);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;fresh(parent,leaf);}prune();}
  const tracked=new Map(manifest.tracked.map(r=>[r.path,r]));let outputPath:string|undefined;let output:number|undefined,outputParent:Held|undefined,current:FrameRow|undefined;
  setProgress(CStageProgressPhase.payload_frames);guard();try{for await(const frame of readRegularFrames(payload.fd,manifest.rows,()=>scopedGuard(payload,...(outputParent?[outputParent]:[])))){const {row:r,bytes,last}=frame;processedBytes+=bytes.length;const root=r.role===Role.Toolchain?toolchain:source;const overlap=r.role!==Role.Toolchain&&tracked.has(r.path);if(current!==r){hold(output===undefined,"frame_order");current=r;if(!overlap){const {parent,leaf}=parents(root,r.path);outputParent=parent;outputPath=`${fdPath(parent)}/${leaf}`;activeTarget=parent;scopedGuard(payload,parent);hold(++objects<=MAX_OBJECTS,"object_bound");output=fs.openSync(`${fdPath(parent)}/${leaf}`,C.O_RDWR|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);}}if(output!==undefined)writeRegularBytes(output,bytes,()=>{scopedGuard(payload,outputParent!);assertRegularName(output!,outputPath!);});if(last){if(output!==undefined){sealRegularFile(output,r,()=>{scopedGuard(payload,outputParent!);assertRegularName(output!,outputPath!);});fs.closeSync(output);output=undefined;fs.fsyncSync(outputParent!.fd);}await verify(root,r);current=undefined;activeTarget=undefined;outputParent=undefined;outputPath=undefined;prune();}scopedGuard(payload,...(outputParent?[outputParent]:[]));}}finally{if(output!==undefined)fs.closeSync(output);}
  guard();const combined=new Map<string,Row>(manifest.tracked.map(r=>[r.path,r]));for(const r of manifest.rows.filter(r=>r.role!==Role.Toolchain))combined.set(r.path,r);const sourceRows=[...combined.values()].sort((a,b)=>a.path<b.path?-1:1),nodeRows=manifest.rows.filter(r=>r.role===Role.Toolchain);
  setProgress(CStageProgressPhase.source_census);const sourceCensus=await census(source,sourceRows,true);setProgress(CStageProgressPhase.toolchain_census);const nodeCensus=await census(toolchain,nodeRows,false,manifest.toolchainDirectories);setProgress(CStageProgressPhase.git_check_after);await gitCheck();setProgress(CStageProgressPhase.git_metadata_after);const metadataAfter=await gitMetadata();hold(metadataAfter.bytes===metadataBefore.bytes&&metadataAfter.objects===metadataBefore.objects,"git_metadata_census_changed");hold(sourceCensus.leaves+sourceCensus.directories+nodeCensus.leaves+nodeCensus.directories+metadataAfter.objects+8<=MAX_OBJECTS,"whole_object_bound");
  setProgress(CStageProgressPhase.public_metadata);const packagePath=`${fdPath(source)}/node_modules/@vioxen/agent-account-observability/package.json`,pkg=JSON.parse(fs.readFileSync(packagePath,"utf8"));hold(pkg.name==="@vioxen/agent-account-observability"&&pkg.main==="./dist/index.js"&&JSON.stringify(pkg.files)===JSON.stringify(["dist","README.md"])&&pkg.dependencies&&Object.keys(pkg.dependencies).length===0,"workspace_metadata");const resolve=createRequire(`${source.real}/package.json`).resolve("@vioxen/agent-account-observability");hold(resolve===`${source.real}/node_modules/@vioxen/agent-account-observability/dist/index.js`,"workspace_public_resolution");hold(JSON.parse(fs.readFileSync(`${fdPath(toolchain)}/lib/node_modules/npm/package.json`,"utf8")).version==="10.9.9","npm_version");
  const publicRows=sourceRows.filter(r=>r.path==="src/worker-codex/hosted-full-backing-proc.js"||/^(?:dist|node_modules|packages|scripts|host-integration)\/.+\.(?:js|mjs|cjs|json|node)$/.test(r.path));hold(publicRows.length<=8192&&publicRows.reduce((n,r)=>n+r.bytes,0)<=512*1024**2,"public_catalog_bound");
  for(const required of ["scripts/dependency-retention-os-test/current-full-outer.js","scripts/dependency-retention-os-test/current-full-guest.js","dist/worker-codex/codex-goal-cli.js","host-integration/managed-launcher/dependency-full-positive-install-TEST.js","host-integration/managed-launcher/dependency-full-positive-copy-TEST.js","host-integration/managed-launcher/dependency-full-h1-staged-tools-TEST.js"]){hold(publicRows.some(r=>r.path===required),"required_runtime_entry");}
  setProgress(CStageProgressPhase.catalog);const catalog={schemaVersion:1,sourceSha:manifest.sourceSha,sourceTree:manifest.sourceTree,files:publicRows.map(r=>({path:r.path,sha256:r.sha256}))};hold(encode(catalog).length<=2*1024**2,"catalog_json_bound");const catalogSha=await writeRecord(version,"public-installation.json",catalog);
  setProgress(CStageProgressPhase.source_readback);for(const h of sources){if(h===bundle)await hashFile(h,manifest.bundle);else if(h===payload)await hashFile(h,manifest.payload);else if(h===manifestFile)await hashFile(h,{bytes:manifestBytes.length,sha256:manifestSha});else await hashFile(h,{bytes:Number(h.size),sha256:BOOTSTRAP_SHA});}for(const h of handles.filter(h=>h.directory)){check(h);fs.fsyncSync(h.fd);}guard();
  setProgress(CStageProgressPhase.staging_receipt);await writeRecord(version,"public-staging-receipt.json",{schemaVersion:1,status:"PUBLIC_STAGED_UNADMITTED_DATA",sourceSha:manifest.sourceSha,sourceTree:manifest.sourceTree,manifestSha256:manifestSha,catalogSha256:catalogSha,sourceCensus,nodeCensus,gitMetadata:metadataAfter,links:manifest.links,producer:manifest.producer,bootId:boot.trim(),mountNamespace:namespace,inputCustody:sources.map(h=>({path:h.real,dev:String(h.dev),ino:String(h.ino),mntId:h.mnt})),elapsedMs:STAGE_BUDGET_MS-(deadline-performance.now()),nativeQualified:"UNPROVEN"});guard();setProgress(CStageProgressPhase.complete);
 } finally {progress(true);let closeError:unknown;for(const h of handles.reverse()){try{fs.closeSync(h.fd);}catch(e){closeError??=e;}}process.off("SIGTERM",signal);process.off("SIGINT",signal);process.umask(originalUmask);if(closeError)throw closeError;hold(!cancelled&&performance.now()<deadline,"close_cancelled_or_deadline");}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){hold(process.argv.length===3,"single_manifest_digest_argument");await stageCurrentPositivePublic(process.argv[2]!);}
