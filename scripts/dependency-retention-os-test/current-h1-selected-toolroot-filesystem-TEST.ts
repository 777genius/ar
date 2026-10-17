/** Owned fixed-namespace filesystem DATA mechanics; no image/native admission. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { posix } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { types } from "node:util";
import { FixedGnuMemberKind as Kind, type FixedGnuArchiveMembers } from "./current-h1-archive-members-TEST.ts";
import type { FixedH1Origin, FixedH1ArchiveRoleData, serializeFixedH1ArchiveRole } from "./current-h1-archive-path-graph-TEST.ts";
import type { retainOriginalAcquiredArchive } from "./current-h1-tool-inputs-package.ts";
import { ciIndexOperationalBytes } from "./current-h1-tool-inputs-ci-index.ts";

export enum SelectedOutputOrigin { Archive="archive-data",Recipe="recipe-data" }
export enum SelectedTransformation { Identity="identity",SitecustomizeRelative="SitecustomizeRelativeV1",LoaderNamespace="LoaderNamespaceV1" }
export enum SelectedPhysicalDisposition { Complete="MATERIALIZED_UNADMITTED_DATA",PartialHeld="PARTIAL_HELD" }
export enum SelectedPhysicalHold { Unknown="unknown",Plan="plan",Origin="origin",Namespace="namespace",Parent="parent",Budget="budget",Deadline="deadline",Ownership="ownership",Identity="identity",Content="content",Time="time",Filesystem="filesystem",Cancelled="cancelled" }
export enum SelectedPhysicalIdentitySite { Unknown="unknown", DirectoryType="directory_type", DirectoryOriginal="directory_original_identity", DirectoryNamed="directory_handle_named_stamp", DirectoryFinalized="directory_finalized_stamp" }
export enum SelectedPhysicalPhase { Unknown="unknown",Input="input",Originals="originals",Graph="graph",Recipe="recipe",Plan="plan",Anchor="anchor",Directories="directories",Regular="regular",Aliases="aliases",Finalize="finalize",Census="census",Publication="publication",Completion="completion",Cleanup="cleanup" }
export const selectedRecipeSha256="9c13c0ed23d678ecb829486373f73bf46e3021fb31c4bfffaa0664fa0fd9ddd0";
export interface SelectedRetainedStreamData {
 readonly archive:ReturnType<typeof retainOriginalAcquiredArchive>;readonly bytes:Buffer;readonly members:FixedGnuArchiveMembers;
}
export interface SelectedOutputRow {
 readonly path:string;readonly kind:Kind;readonly origin:SelectedOutputOrigin;readonly transformation:SelectedTransformation;
 readonly origins:readonly FixedH1Origin[];readonly mode:number;readonly mtime:number;readonly outputLiteral:string;
}
export interface SelectedFilesystemInput {
 readonly sourceSha:string;readonly scratch:string;readonly evidence:string;readonly deadline:number;
 readonly originals:readonly SelectedRetainedStreamData[];readonly rows:readonly SelectedOutputRow[];
 readonly provenance:SelectedProvenance;
}
export interface SelectedProvenance {
 readonly sourceSha:string;readonly packageVectorSha256:string;readonly recipeSha256:string;
 readonly graph:Readonly<{bytes:number;sha256:string;nodes:number}>;
 readonly selection:Readonly<{bytes:number;sha256:string;selected:number}>;
 readonly memberRecords:ReturnType<typeof serializeFixedH1ArchiveRole>["memberRecords"];
 readonly archives:FixedH1ArchiveRoleData["archives"];readonly unselected:FixedH1ArchiveRoleData["unselected"];
 readonly heldObjects:FixedH1ArchiveRoleData["aliases"];readonly rootSentinels:FixedH1ArchiveRoleData["roots"];
}
export class SelectedPhysicalHeld extends Error {
 readonly disposition=SelectedPhysicalDisposition.PartialHeld;
 constructor(readonly reason:SelectedPhysicalHold,readonly rootCreated:boolean,readonly phase:SelectedPhysicalPhase=SelectedPhysicalPhase.Unknown,readonly processedObjects:number=0,readonly identitySite:SelectedPhysicalIdentitySite=SelectedPhysicalIdentitySite.Unknown){super("selected toolroot DATA HOLD: "+reason);this.name="SelectedPhysicalHeld";}
}
/** Finite diagnostic facts only; rejects exotic thrown values without hooks. */
export function readSelectedPhysicalHoldFacts(error:unknown):Readonly<{reason:SelectedPhysicalHold;rootCreated:boolean;phase:SelectedPhysicalPhase;processedObjects:number;identitySite:SelectedPhysicalIdentitySite}>|undefined {
 if(error===null||typeof error!=="object"||types.isProxy(error)||!types.isNativeError(error)||Object.getPrototypeOf(error)!==SelectedPhysicalHeld.prototype)return undefined;
 const d=Object.getOwnPropertyDescriptors(error),value=(key:string)=>{const row=d[key];return row&&"value" in row?row.value:undefined;};
 const reason:unknown=value("reason"),rootCreated:unknown=value("rootCreated"),phase:unknown=value("phase"),processedObjects:unknown=value("processedObjects"),identitySite:unknown=value("identitySite");
 if(value("disposition")!==SelectedPhysicalDisposition.PartialHeld||typeof reason!=="string"||!Object.values(SelectedPhysicalHold).includes(reason as SelectedPhysicalHold)||typeof rootCreated!=="boolean"||typeof phase!=="string"||!Object.values(SelectedPhysicalPhase).includes(phase as SelectedPhysicalPhase)||typeof processedObjects!=="number"||!Number.isSafeInteger(processedObjects)||processedObjects<0||processedObjects>1055||typeof identitySite!=="string"||!Object.values(SelectedPhysicalIdentitySite).includes(identitySite as SelectedPhysicalIdentitySite))return undefined;
 return Object.freeze({reason:reason as SelectedPhysicalHold,rootCreated,phase:phase as SelectedPhysicalPhase,processedObjects,identitySite:identitySite as SelectedPhysicalIdentitySite});
}
enum DirectoryRole { Ancestry="ancestry",Output="output" }
interface Directory { fd:number;parent:number;name:string;initial:fs.BigIntStats;readonly role:DirectoryRole }
interface PhysicalRow { path:string;kind:Kind;identity:Readonly<Record<string,string>>;sha256:string;literalBytesBase64:string;literalSha256:string }
const rootName="h1-selected-toolroot-TEST",sitePath="usr/lib/python3.12/sitecustomize.py";
const recordNames=["selected-toolroot-source-output-UNADMITTED.json","selected-toolroot-physical-UNADMITTED.json","selected-toolroot-materialization-UNADMITTED.json"] as const;
const hash=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
const objectPrototype=Object.prototype,arrayPrototype=Array.prototype,primitiveJson=JSON.stringify;
function intrinsicPrototypes():void {
 need(!types.isProxy(objectPrototype)&&!types.isProxy(arrayPrototype)&&Object.getPrototypeOf(objectPrototype)===null&&Object.getPrototypeOf(arrayPrototype)===objectPrototype&&
  !Object.getOwnPropertyDescriptor(objectPrototype,"toJSON")&&!Object.getOwnPropertyDescriptor(arrayPrototype,"toJSON"),SelectedPhysicalHold.Plan);
}
const order=(a:string,b:string)=>a<b?-1:a>b?1:0;
const identity=(s:fs.BigIntStats)=>Object.freeze(Object.fromEntries(["dev","ino","mode","uid","gid","nlink","size","mtimeNs","ctimeNs"].map(k=>[k,String(s[k as keyof fs.BigIntStats])])));
const stamp=(s:fs.BigIntStats)=>canonicalData(identity(s));
const sameObject=(a:fs.BigIntStats,b:fs.BigIntStats)=>a.dev===b.dev&&a.ino===b.ino&&a.uid===b.uid&&a.gid===b.gid&&a.mode===b.mode;
const anchored=(fd:number,name:string)=>`/proc/self/fd/${fd}/${name}`;
const component=/^[A-Za-z0-9._+%:@=~-]+$/;
const selectedPath=(p:string)=>p==="usr/lib"||p.startsWith("usr/lib/")||p==="usr/lib64"||p.startsWith("usr/lib64/")||["usr","usr/bin","usr/bin/python3.12","usr/bin/nsenter","etc","etc/python3.12","etc/python3.12/sitecustomize.py",sitePath].includes(p);
const integer=(n:number,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
function need(value:unknown,reason:SelectedPhysicalHold):asserts value {if(!value)throw new SelectedPhysicalHeld(reason,false);}
function literal(base64:string):string {
 need(typeof base64==="string"&&base64.length<=5464,SelectedPhysicalHold.Plan);
 const b=Buffer.from(base64,"base64");need(b.length<=4096&&b.toString("base64")===base64&&b.every(x=>x>=32&&x<127),SelectedPhysicalHold.Plan);return b.toString("ascii");
}
function plain(value:object):void {
 intrinsicPrototypes();need(value!==null&&!types.isProxy(value)&&Object.getPrototypeOf(value)===objectPrototype&&Reflect.ownKeys(value).every(k=>typeof k==="string"&&k!=="toJSON")&&Object.values(Object.getOwnPropertyDescriptors(value)).every(d=>"value" in d&&d.enumerable),SelectedPhysicalHold.Plan);
}
/** Descriptor-only canonical ordinary JSON. Never passes a container to JSON or
 * reads an inherited property; generated elapsed times may be finite fractions. */
function canonicalData(value:unknown):string {
 intrinsicPrototypes();let work=0,bytes=0;const visiting=new Set<object>(),chunks:string[]=[];
 const emit=(text:string)=>{bytes+=Buffer.byteLength(text);need(bytes<=ciIndexOperationalBytes,SelectedPhysicalHold.Budget);chunks.push(text);};
 const visit=(v:unknown,depth:number):void=>{
  need(++work<=2000000&&depth<=128,SelectedPhysicalHold.Budget);
  if(v===null||typeof v==="boolean"){emit(v===null?"null":v?"true":"false");return;}
  if(typeof v==="string"){need(v.length<=5464,SelectedPhysicalHold.Plan);emit(primitiveJson(v));return;}
  if(typeof v==="number"){need(Number.isFinite(v),SelectedPhysicalHold.Plan);emit(primitiveJson(v));return;}
  need(typeof v==="object"&&!types.isProxy(v)&&!visiting.has(v),SelectedPhysicalHold.Plan);visiting.add(v);
  const array=Array.isArray(v),descriptors=dataDescriptors(v);emit(array?"[":"{");
  const keys=array?Array.from({length:descriptors.length!.value as number},(_,i)=>String(i)):Object.keys(descriptors);
  keys.forEach((key,i)=>{if(i)emit(",");if(!array){need(key.length<=64,SelectedPhysicalHold.Plan);emit(primitiveJson(key));emit(":");}visit(descriptors[key]!.value,depth+1);});
  emit(array?"]":"}");visiting.delete(v);
 };visit(value,0);intrinsicPrototypes();return chunks.join("");
}
function dataDescriptors(value:object):PropertyDescriptorMap {
 need(!types.isProxy(value),SelectedPhysicalHold.Plan);
 const array=Array.isArray(value);need(Object.getPrototypeOf(value)===(array?arrayPrototype:objectPrototype),SelectedPhysicalHold.Plan);
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);
 need(keys.every(k=>typeof k==="string"&&k!=="toJSON")&&Object.entries(descriptors).every(([key,d])=>"value" in d&&(d.enumerable||array&&key==="length")),SelectedPhysicalHold.Plan);
 if(array){const length=descriptors.length?.value as unknown;need(typeof length==="number"&&integer(length,20000)&&keys.length===length+1,SelectedPhysicalHold.Plan);for(let i=0;i<length;i++)need(descriptors[String(i)]?.enumerable,SelectedPhysicalHold.Plan);}
 return descriptors;
}
interface MutationWatch { readonly value:object;readonly prototype:object;readonly descriptors:PropertyDescriptorMap }
/** Copy once, but preserve caller mutation detection at each original window.
 * A frozen ancestor never licenses a mutable child. At129 fall back completely. */
function detachPlan<T>(value:T):{snapshot:T;rejoin:()=>boolean} {
 const watch:MutationWatch[]=[],copied=new Map<object,object>(),visiting=new Set<object>();let work=0,fallback=false;
 const copy=(v:unknown,depth:number):unknown=>{
  need(++work<=2000000&&depth<=128,SelectedPhysicalHold.Budget);
  if(v===null||typeof v!=="object")return v;
  need(!types.isProxy(v)&&!visiting.has(v),SelectedPhysicalHold.Plan);if(copied.has(v))return copied.get(v);
  const descriptors=dataDescriptors(v),array=Array.isArray(v),result:object=array?[]:{};
  copied.set(v,result);visiting.add(v);
  if(!Object.isFrozen(v)){if(watch.length<128)watch.push({value:v,prototype:array?arrayPrototype:objectPrototype,descriptors});else fallback=true;}
  for(const key of Object.keys(descriptors)){if(array&&key==="length")continue;Object.defineProperty(result,key,{value:copy(descriptors[key]!.value,depth+1),enumerable:true,writable:true,configurable:true});}
  visiting.delete(v);return Object.freeze(result);
 };
 const snapshot=copy(value,0) as T;
 return {snapshot,rejoin:()=>{
  intrinsicPrototypes();if(fallback)return false;
  for(const row of watch){need(Object.getPrototypeOf(row.value)===row.prototype,SelectedPhysicalHold.Plan);const now=Object.getOwnPropertyDescriptors(row.value),keys=Reflect.ownKeys(row.value),before=Reflect.ownKeys(row.descriptors);
   need(keys.length===before.length&&keys.every((key,i)=>key===before[i]),SelectedPhysicalHold.Plan);
   for(const key of before){need(typeof key==="string",SelectedPhysicalHold.Plan);const a=row.descriptors[key]!,b=now[key];need(b&&"value" in b&&b.value===a.value&&b.enumerable===a.enumerable&&b.configurable===a.configurable&&b.writable===a.writable,SelectedPhysicalHold.Plan);}
  }return true;
 }};
}
/** Validate before every serialization, including after yielding; never invokes
 * custom JSON hooks/getters/Proxy traps. Conservative bytes bound allocation. */
function jsonData(value:unknown):void {
 intrinsicPrototypes();
 let work=0,bytes=0;const visiting=new Set<object>();
 const visit=(v:unknown,depth:number):void=>{
  need(++work<=2000000&&depth<=128,SelectedPhysicalHold.Budget);
  if(v===null||typeof v==="boolean"){bytes+=8;return;}
  if(typeof v==="string"){need(v.length<=5464&&/^[\x20-\x7e]*$/.test(v),SelectedPhysicalHold.Plan);bytes+=v.length*6+2;}
  else if(typeof v==="number"){need(integer(v),SelectedPhysicalHold.Plan);bytes+=24;}
  else {
   need(typeof v==="object"&&!types.isProxy(v)&&!visiting.has(v),SelectedPhysicalHold.Plan);visiting.add(v);
   if(Array.isArray(v)){
    need(Object.getPrototypeOf(v)===arrayPrototype&&v.length<=20000,SelectedPhysicalHold.Plan);const descriptors=Object.getOwnPropertyDescriptors(v);
    const lengthDescriptor=Object.getOwnPropertyDescriptor(v,"length");need(Reflect.ownKeys(descriptors).length===v.length+1&&lengthDescriptor&&"value" in lengthDescriptor,SelectedPhysicalHold.Plan);
    for(let i=0;i<v.length;i++){const d=descriptors[String(i)];need(d&&"value" in d&&d.enumerable,SelectedPhysicalHold.Plan);visit(d.value,depth+1);bytes+=1;}
   }else{plain(v);for(const [key,d] of Object.entries(Object.getOwnPropertyDescriptors(v))){need(key.length<=64&&/^[A-Za-z][A-Za-z0-9]*$/.test(key),SelectedPhysicalHold.Plan);bytes+=key.length*6+4;visit(d.value,depth+1);}}
   visiting.delete(v);bytes+=2;
  }
  need(bytes<=ciIndexOperationalBytes,SelectedPhysicalHold.Budget);
 };visit(value,0);
}
function validatePlan(input:SelectedFilesystemInput):Map<string,SelectedOutputRow> {
 plain(input);jsonData({rows:input.rows,provenance:input.provenance});
 need(Number.isFinite(input.deadline)&&performance.now()<input.deadline,SelectedPhysicalHold.Deadline);
 need(input.rows.length>0&&input.rows.length<=1055,SelectedPhysicalHold.Budget);
 const byPath=new Map<string,SelectedOutputRow>();let payload=0,dirs=0;
 for(const row of input.rows){
  plain(row);need(Object.keys(row).sort().join(",")==="kind,mode,mtime,origin,origins,outputLiteral,path,transformation",SelectedPhysicalHold.Plan);need(typeof row.path==="string"&&row.path.length<=4096&&row.path.split("/").length<=2047&&row.path.split("/").every(p=>component.test(p)&&p!=="."&&p!==".."),SelectedPhysicalHold.Namespace);
  need(selectedPath(row.path)||(row.path==="lib64"&&row.transformation===SelectedTransformation.LoaderNamespace),SelectedPhysicalHold.Namespace);
  need(!byPath.has(row.path)&&Object.values(Kind).includes(row.kind)&&integer(row.mtime)&&row.mtime<=8640000000000,SelectedPhysicalHold.Plan);byPath.set(row.path,row);
  need(row.origin===SelectedOutputOrigin.Archive||row.origin===SelectedOutputOrigin.Recipe,SelectedPhysicalHold.Plan);
  if(row.origin===SelectedOutputOrigin.Recipe){need(row.path==="lib64"&&row.kind===Kind.Symlink&&row.transformation===SelectedTransformation.LoaderNamespace&&row.origins.length===0&&row.outputLiteral==="usr/lib64"&&row.mode===0o777&&row.mtime===0,SelectedPhysicalHold.Plan);continue;}
  need(row.origins.length>0&&(row.kind===Kind.Directory||row.origins.length===1),SelectedPhysicalHold.Origin);
  const first=row.origins[0];need(first,SelectedPhysicalHold.Origin);
  for(const origin of row.origins){
   const source=origin.row;need(source.kind===row.kind&&source.uid===0&&source.gid===0&&source.mode===row.mode&&integer(source.size,32*1024*1024)&&source.payloadBytes===source.size,SelectedPhysicalHold.Origin);
   need(source.kind===Kind.Regular||(source.size===0&&source.payloadSha256===hash("")),SelectedPhysicalHold.Origin);need(source.kind===Kind.Symlink?literal(source.linkBytesBase64).length>0:source.linkBytesBase64==="",SelectedPhysicalHold.Origin);
   let name=literal(source.nameBytesBase64);if(name.startsWith("./"))name=name.slice(2);if(source.kind===Kind.Directory&&name.endsWith("/"))name=name.slice(0,-1);need(name===row.path,SelectedPhysicalHold.Origin);
  }
  if(row.kind===Kind.Directory){need(++dirs<=64&&row.mode===0o755&&row.mtime===0&&row.outputLiteral===""&&row.transformation===SelectedTransformation.Identity,SelectedPhysicalHold.Plan);}
  else if(row.kind===Kind.Regular){need((row.mode===0o644||row.mode===0o755)&&row.mtime===first.row.mtime&&row.outputLiteral===""&&row.transformation===SelectedTransformation.Identity,SelectedPhysicalHold.Plan);payload+=first.row.size;}
  else {
   need(row.mode===0o777&&row.mtime===first.row.mtime&&row.outputLiteral.length>0&&Buffer.byteLength(row.outputLiteral)<=4096,SelectedPhysicalHold.Plan);
   const original=literal(first.row.linkBytesBase64);
   need(row.transformation===SelectedTransformation.Identity?row.outputLiteral===original&&!original.startsWith("/"):row.transformation===SelectedTransformation.SitecustomizeRelative&&row.path===sitePath&&original==="/etc/python3.12/sitecustomize.py"&&row.outputLiteral==="../../../etc/python3.12/sitecustomize.py",SelectedPhysicalHold.Plan);
  }
  need(payload<=512*1024*1024,SelectedPhysicalHold.Budget);
 }
 need(Array.isArray(input.originals)&&!types.isProxy(input.originals)&&Object.getPrototypeOf(input.originals)===Array.prototype&&input.originals.length>0&&input.originals.length<=41,SelectedPhysicalHold.Budget);
 for(const row of byPath.values()){
  const parent=posix.dirname(row.path);need(parent==="."||byPath.get(parent)?.kind===Kind.Directory,SelectedPhysicalHold.Parent);
  if(row.kind!==Kind.Symlink)continue;
  const seen=new Set<string>();let current=row;
  while(current.kind===Kind.Symlink){
   need(!seen.has(current.path)&&seen.size<byPath.size,SelectedPhysicalHold.Plan);seen.add(current.path);
   const stack=current.path.split("/").slice(0,-1),parts=current.outputLiteral.split("/");
   need(parts.every(p=>p==="."||p===".."||component.test(p)),SelectedPhysicalHold.Namespace);
   for(const [i,part] of parts.entries()){
    if(part===".."){need(stack.length>0,SelectedPhysicalHold.Namespace);stack.pop();}else if(part!==".")stack.push(part);
    if(i<parts.length-1&&stack.length)need(byPath.get(stack.join("/"))?.kind===Kind.Directory,SelectedPhysicalHold.Parent);
   }
   const next=byPath.get(stack.join("/"));need(next,SelectedPhysicalHold.Parent);current=next;
  }
 }
 if(byPath.has("lib64")){
  const loader=byPath.get("usr/lib64/ld-linux-x86-64.so.2"),target=byPath.get("usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2");
  need(loader?.kind===Kind.Symlink&&loader.outputLiteral==="../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"&&target?.kind===Kind.Regular,SelectedPhysicalHold.Plan);
 }
 need(/^[a-f0-9]{40}$/.test(input.sourceSha),SelectedPhysicalHold.Plan);plain(input.provenance);
 need(Object.keys(input.provenance).sort().join(",")==="archives,graph,heldObjects,memberRecords,packageVectorSha256,recipeSha256,rootSentinels,selection,sourceSha,unselected"&&input.provenance.sourceSha===input.sourceSha&&input.provenance.recipeSha256===selectedRecipeSha256,SelectedPhysicalHold.Plan);
 for(const s of [input.provenance.packageVectorSha256,input.provenance.graph.sha256,input.provenance.selection.sha256])need(/^[a-f0-9]{64}$/.test(s),SelectedPhysicalHold.Plan);
 return byPath;
}

/** Shared actual filesystem boundary. Small unsigned fixtures qualify mechanics
 * only; the separate fixed41 entry is the sole fixed-image admission producer. */
export async function writeOwnedSelectedToolrootData(input:SelectedFilesystemInput):Promise<Readonly<{
 disposition:SelectedPhysicalDisposition.Complete;rootIdentity:Readonly<Record<string,string>>;
 records:readonly Readonly<{name:string;bytes:number;sha256:string}>[];
 measurement:Readonly<{objects:number;regularBytes:number;elapsedMs:number;ownedDescriptorHighWater:number}>;
 nativeQualified:false;fixedImageQualified:false;originalIssuerQualified:false;
}>> {
 let phase=SelectedPhysicalPhase.Plan,processedObjects=0;
 try {
 plain(input);
 const started=performance.now(),deadline=Math.min(input.deadline,started+30000),byPath=validatePlan(input);
 const sourceSha=input.sourceSha,scratchPath=input.scratch,evidencePath=input.evidence;
 dataDescriptors(input.originals);
 const originals=Object.freeze(input.originals.map(o=>{plain(o);plain(o.archive);jsonData(o.members);need(Object.keys(o).sort().join(",")==="archive,bytes,members"&&Object.isFrozen(o.archive)&&Object.isFrozen(o.members)&&Object.isFrozen(o.members.package)&&Object.isFrozen(o.members.stream)&&Object.isFrozen(o.members.rows)&&o.members.rows.every(r=>Object.isFrozen(r)),SelectedPhysicalHold.Origin);return Object.freeze({archive:o.archive,bytes:o.bytes,members:o.members});}));
 for(const original of originals){need(Object.keys(original.members).sort().join(",")==="nativeQualified,package,profile,rows,schemaVersion,stream",SelectedPhysicalHold.Origin);
  for(const value of [original.members.package,original.members.stream,...original.members.rows])need(Object.isFrozen(value)&&Object.values(dataDescriptors(value)).every(d=>d.value===null||["string","number","boolean"].includes(typeof d.value)),SelectedPhysicalHold.Origin);
 }
 const sourceRows=Object.freeze([...byPath.values()].sort((a,b)=>order(a.path,b.path))),originalPlan=Object.freeze({rows:sourceRows,provenance:input.provenance});
 const detached=detachPlan(originalPlan),rows=detached.snapshot.rows,provenance=detached.snapshot.provenance;
 const sourceBindings=new Map<FixedH1Origin,Readonly<{original:SelectedRetainedStreamData;row:FixedH1Origin["row"]}>>();
 for(let i=0;i<rows.length;i++)for(let j=0;j<rows[i]!.origins.length;j++){
  const origin=sourceRows[i]!.origins[j]!,row=origin.row,original=originals.find(o=>o.members.package.sha256===origin.archiveSha256);
  need(original&&original.members.stream.sha256===origin.streamSha256&&original.members.rows[row.ordinal-1]===row&&Object.isFrozen(row)&&Object.values(dataDescriptors(row)).every(d=>d.value===null||["string","number","boolean"].includes(typeof d.value)),SelectedPhysicalHold.Origin);
  sourceBindings.set(rows[i]!.origins[j]!,Object.freeze({original,row}));
 }
 const planBytes=Buffer.from(canonicalData(detached.snapshot)),planHash=hash(planBytes);
 need(performance.now()<deadline,SelectedPhysicalHold.Deadline);
 need(process.platform==="linux"&&process.getuid?.()===0&&process.geteuid?.()===0&&process.getgid?.()===0&&process.getegid?.()===0,SelectedPhysicalHold.Ownership);
 const owned=new Set<number>(),finalized=new Set<number>(),ancestry:Directory[]=[],directories=new Map<string,Directory>(),streams=new Map<string,SelectedRetainedStreamData>();
 let rootCreated=false,cancelled=false,highWater=0,regularBytes=0,completed=false,completionPhysicalHash="";
 const published=new Map<string,{initial:fs.BigIntStats;bytes:number;sha256:string}>();
 const signal=()=>{cancelled=true;};process.on("SIGTERM",signal);process.on("SIGINT",signal);
 const keep=(fd:number)=>{owned.add(fd);highWater=Math.max(highWater,owned.size);need(owned.size<=256,SelectedPhysicalHold.Budget);return fd;};
 const close=(fd:number)=>{if(owned.delete(fd))fs.closeSync(fd);};
 const tick=()=>{need(!cancelled,SelectedPhysicalHold.Cancelled);need(performance.now()<deadline,SelectedPhysicalHold.Deadline);};
 const checkDirectory=(d:Directory)=>{
  tick();const s=fs.fstatSync(d.fd,{bigint:true}),named=fs.lstatSync(anchored(d.parent,d.name),{bigint:true});
  // Shared ancestry can gain unrelated siblings between these two real samples.
  // Pin its original identity, owner and mode; owned output keeps full stamps.
  const identityNeed=(value:boolean,site:SelectedPhysicalIdentitySite)=>{if(!value)throw new SelectedPhysicalHeld(SelectedPhysicalHold.Identity,false,SelectedPhysicalPhase.Unknown,0,site);};
  identityNeed(s.isDirectory(),SelectedPhysicalIdentitySite.DirectoryType);
  identityNeed(sameObject(s,d.initial),SelectedPhysicalIdentitySite.DirectoryOriginal);
  identityNeed(named.isDirectory()&&(d.role===DirectoryRole.Ancestry?sameObject(s,named):stamp(s)===stamp(named)),SelectedPhysicalIdentitySite.DirectoryNamed);
  identityNeed(!finalized.has(d.fd)||stamp(s)===stamp(d.initial),SelectedPhysicalIdentitySite.DirectoryFinalized);
 };
 const checkPlan=()=>{intrinsicPrototypes();if(!detached.rejoin()){jsonData(originalPlan);need(hash(canonicalData(originalPlan))===planHash,SelectedPhysicalHold.Plan);}tick();};
 const joinAll=()=>{
  tick();checkPlan();
  tick();for(const d of ancestry)checkDirectory(d);for(const d of directories.values())checkDirectory(d);
  for(const original of originals){original.archive.rejoin();tick();}
  for(const binding of sourceBindings.values())need(binding.original.members.rows[binding.row.ordinal-1]===binding.row&&Object.isFrozen(binding.row),SelectedPhysicalHold.Origin);
  checkPlan();rejoinPublished();intrinsicPrototypes();tick();
 };
 const checkpoint=async()=>{await nextTurn();joinAll();};
 const anchor=(path:string)=>{
  need(path.startsWith("/")&&path.length<=4096&&posix.normalize(path)===path&&path!=="/",SelectedPhysicalHold.Namespace);
  const parts=path.slice(1).split("/");need(parts.length<=64&&parts.every(p=>component.test(p)),SelectedPhysicalHold.Namespace);
  let parent=keep(fs.openSync("/",fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW));
  for(const name of parts){
   tick();const fd=keep(fs.openSync(anchored(parent,name),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW));
   const initial=fs.fstatSync(fd,{bigint:true});need(initial.isDirectory(),SelectedPhysicalHold.Identity);
   ancestry.push({fd,parent,name,initial,role:DirectoryRole.Ancestry});parent=fd;
  }
  const d=ancestry[ancestry.length-1];need(d&&d.initial.uid===0n&&d.initial.gid===0n&&(d.initial.mode&0o7777n)===0o700n,SelectedPhysicalHold.Ownership);return d;
 };
 const streamCheck=(original:SelectedRetainedStreamData)=>{
  tick();original.archive.rejoin();need(original.archive.sha256===original.members.package.sha256&&original.archive.size===original.members.package.size&&original.bytes.length===original.members.stream.bytes&&hash(original.bytes)===original.members.stream.sha256,SelectedPhysicalHold.Origin);tick();original.archive.rejoin();
 };
 const slice=(origin:FixedH1Origin)=>{
  const binding=sourceBindings.get(origin),original=streams.get(origin.archiveSha256),row=binding?.row;need(binding&&row&&original===binding.original&&original.members.stream.sha256===origin.streamSha256,SelectedPhysicalHold.Origin);
  need(original.members.rows[row.ordinal-1]===row&&integer(row.headerOffset)&&integer(row.payloadOffset)&&row.payloadOffset===row.headerOffset+512&&row.payloadBytes===row.size&&integer(row.size,32*1024*1024)&&row.payloadOffset+row.size<=original.bytes.length,SelectedPhysicalHold.Origin);
  const header=original.bytes.subarray(row.headerOffset,row.payloadOffset),payload=original.bytes.subarray(row.payloadOffset,row.payloadOffset+row.size);
  need(header.length===512&&hash(header)===row.headerSha256&&hash(payload)===row.payloadSha256,SelectedPhysicalHold.Content);tick();return payload;
 };
 const readHash=(fd:number,size:number)=>{
  const before=fs.fstatSync(fd,{bigint:true}),h=createHash("sha256"),buffer=Buffer.alloc(65536);let offset=0;
  need(before.isFile()&&before.nlink===1n&&before.size===BigInt(size)&&size<=32*1024*1024,SelectedPhysicalHold.Content);
  for(;;){tick();const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,size+1-offset),offset);tick();if(n===0)break;offset+=n;need(offset<=size,SelectedPhysicalHold.Content);h.update(buffer.subarray(0,n));}
  need(offset===size&&stamp(fs.fstatSync(fd,{bigint:true}))===stamp(before),SelectedPhysicalHold.Content);return h.digest("hex");
 };
 let scratch:Directory|undefined,evidence:Directory|undefined;
 const rejoinPublished=()=>{
  if(!published.size)return;need(evidence,SelectedPhysicalHold.Parent);checkDirectory(evidence);
  for(const [name,row] of published){
   tick();const p=anchored(evidence.fd,name);need(stamp(fs.lstatSync(p,{bigint:true}))===stamp(row.initial),SelectedPhysicalHold.Identity);
   const fd=keep(fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK));
   try{need(stamp(fs.fstatSync(fd,{bigint:true}))===stamp(row.initial),SelectedPhysicalHold.Identity);const h=createHash("sha256"),buffer=Buffer.alloc(65536);let at=0;
    for(;;){tick();const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,row.bytes+1-at),at);tick();if(!n)break;at+=n;need(at<=row.bytes,SelectedPhysicalHold.Content);h.update(buffer.subarray(0,n));}
    need(at===row.bytes&&h.digest("hex")===row.sha256&&stamp(fs.fstatSync(fd,{bigint:true}))===stamp(row.initial)&&stamp(fs.lstatSync(p,{bigint:true}))===stamp(row.initial),SelectedPhysicalHold.Content);tick();
   }finally{close(fd);}
  }
 };
 const refreshOwnedAncestor=(d:Directory)=>{d.initial=fs.fstatSync(d.fd,{bigint:true});checkDirectory(d);};
 const createDirectory=(path:string)=>{
  const parent=path===""?scratch:directories.get(posix.dirname(path)==="."?"":posix.dirname(path));need(parent,SelectedPhysicalHold.Parent);checkDirectory(parent);
  const name=path===""?rootName:posix.basename(path),location=anchored(parent.fd,name);fs.mkdirSync(location,{mode:0o700});if(path==="")rootCreated=true;
  const fd=keep(fs.openSync(location,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW));
  const before=fs.fstatSync(fd,{bigint:true});need(before.isDirectory()&&before.uid===0n&&before.nlink>=2n,SelectedPhysicalHold.Ownership);
  fs.fchownSync(fd,0,0);fs.fchmodSync(fd,0o700);const d={fd,parent:parent.fd,name,initial:fs.fstatSync(fd,{bigint:true}),role:DirectoryRole.Output};directories.set(path,d);checkDirectory(d);refreshOwnedAncestor(parent);if(path!=="")processedObjects++;
 };
 const parentFor=(p:string)=>{const d=directories.get(posix.dirname(p)==="."?"":posix.dirname(p));need(d,SelectedPhysicalHold.Parent);checkDirectory(d);return d;};
 const finalize=(fd:number,mode:number,time:number)=>{
  fs.fchownSync(fd,0,0);fs.fchmodSync(fd,mode);fs.futimesSync(fd,time,time);fs.fsyncSync(fd);tick();
  const s=fs.fstatSync(fd,{bigint:true});need(s.uid===0n&&s.gid===0n&&(s.mode&0o7777n)===BigInt(mode)&&s.mtimeNs===BigInt(time)*1000000000n,SelectedPhysicalHold.Time);return s;
 };
 const census=():PhysicalRow[]=>{
  joinAll();const actual:string[]=[];
  for(const [path,d] of directories){checkDirectory(d);for(const bytes of fs.readdirSync(`/proc/self/fd/${d.fd}`,{encoding:"buffer"})){
   need(bytes.every(b=>b>=32&&b<127),SelectedPhysicalHold.Namespace);const name=bytes.toString("ascii");need(component.test(name)&&name!=="."&&name!=="..",SelectedPhysicalHold.Namespace);actual.push(path?path+"/"+name:name);need(actual.length<=1055,SelectedPhysicalHold.Budget);
  }}
  need(canonicalData(actual.sort(order))===canonicalData(rows.map(r=>r.path)),SelectedPhysicalHold.Content);
  const result:PhysicalRow[]=[];
  for(const row of rows){
   tick();const parent=parentFor(row.path),p=anchored(parent.fd,posix.basename(row.path)),before=fs.lstatSync(p,{bigint:true});
   need(before.uid===0n&&before.gid===0n&&(before.mode&0o7777n)===BigInt(row.mode)&&before.mtimeNs===BigInt(row.mtime)*1000000000n,SelectedPhysicalHold.Identity);
   let sha256="",literalBytesBase64="",literalSha256="";
   if(row.kind===Kind.Directory){need(before.isDirectory(),SelectedPhysicalHold.Identity);const d=directories.get(row.path);need(d,SelectedPhysicalHold.Parent);need(stamp(fs.fstatSync(d.fd,{bigint:true}))===stamp(before),SelectedPhysicalHold.Identity);}
   else if(row.kind===Kind.Symlink){need(before.isSymbolicLink()&&before.nlink===1n,SelectedPhysicalHold.Identity);const b=fs.readlinkSync(p,{encoding:"buffer"});need(b.equals(Buffer.from(row.outputLiteral))&&before.size===BigInt(b.length),SelectedPhysicalHold.Content);literalBytesBase64=b.toString("base64");literalSha256=hash(b);}
   else {need(before.isFile()&&before.nlink===1n,SelectedPhysicalHold.Identity);const o=row.origins[0];need(o,SelectedPhysicalHold.Origin);const fd=keep(fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK));try{need(stamp(fs.fstatSync(fd,{bigint:true}))===stamp(before),SelectedPhysicalHold.Identity);sha256=readHash(fd,o.row.size);need(sha256===o.row.payloadSha256,SelectedPhysicalHold.Content);}finally{close(fd);}}
   need(stamp(fs.lstatSync(p,{bigint:true}))===stamp(before),SelectedPhysicalHold.Identity);result.push({path:row.path,kind:row.kind,identity:identity(before),sha256,literalBytesBase64,literalSha256});tick();
  }
  joinAll();return result;
 };
 const serialize=(v:unknown)=>{tick();const text=canonicalData(v)+"\n";tick();need(Buffer.byteLength(text)<=ciIndexOperationalBytes,SelectedPhysicalHold.Budget);const b=Buffer.from(text);tick();return b;};
 const records:{name:string;bytes:number;sha256:string}[]=[];
 const publish=async(name:typeof recordNames[number],bytes:Buffer)=>{
  await checkpoint();need(evidence,SelectedPhysicalHold.Parent);checkDirectory(evidence);const p=anchored(evidence.fd,name),fd=keep(fs.openSync(p,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600));
  try{fs.fchownSync(fd,0,0);fs.fchmodSync(fd,0o600);let at=0;while(at<bytes.length){tick();const n=fs.writeSync(fd,bytes,at,Math.min(65536,bytes.length-at),at);need(n>0,SelectedPhysicalHold.Filesystem);at+=n;}fs.fsyncSync(fd);tick();const s=fs.fstatSync(fd,{bigint:true});need(s.uid===0n&&s.gid===0n&&s.nlink===1n&&(s.mode&0o7777n)===0o600n&&s.size===BigInt(bytes.length)&&stamp(fs.lstatSync(p,{bigint:true}))===stamp(s),SelectedPhysicalHold.Identity);
   const h=createHash("sha256"),buffer=Buffer.alloc(65536);let offset=0;for(;;){tick();const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,bytes.length+1-offset),offset);tick();if(n===0)break;need(offset+n<=bytes.length&&buffer.subarray(0,n).equals(bytes.subarray(offset,offset+n)),SelectedPhysicalHold.Content);h.update(buffer.subarray(0,n));offset+=n;}need(offset===bytes.length&&h.digest("hex")===hash(bytes)&&stamp(fs.fstatSync(fd,{bigint:true}))===stamp(s)&&stamp(fs.lstatSync(p,{bigint:true}))===stamp(s),SelectedPhysicalHold.Content);
   published.set(name,{initial:s,bytes:bytes.length,sha256:hash(bytes)});
  }finally{close(fd);}fs.fsyncSync(evidence.fd);refreshOwnedAncestor(evidence);records.push({name,bytes:bytes.length,sha256:hash(bytes)});await checkpoint();
 };
 try {
  phase=SelectedPhysicalPhase.Originals;let total=0,headers=0;for(const original of originals){plain(original);need(Buffer.isBuffer(original.bytes)&&!types.isProxy(original.bytes),SelectedPhysicalHold.Origin);jsonData(original.members);headers+=original.members.rows.length;need(headers<=20000,SelectedPhysicalHold.Budget);need(!streams.has(original.members.package.sha256),SelectedPhysicalHold.Origin);streams.set(original.members.package.sha256,original);total+=original.bytes.length;need(total<=512*1024*1024,SelectedPhysicalHold.Budget);streamCheck(original);}
  for(const row of rows)for(const origin of row.origins)slice(origin);
  phase=SelectedPhysicalPhase.Anchor;scratch=anchor(scratchPath);evidence=anchor(evidencePath);need(scratch.fd!==evidence.fd&&!(scratch.initial.dev===evidence.initial.dev&&scratch.initial.ino===evidence.initial.ino),SelectedPhysicalHold.Ownership);
  await checkpoint();for(const original of originals)streamCheck(original);for(const row of rows)for(const origin of row.origins)slice(origin);createDirectory("");await checkpoint();
  phase=SelectedPhysicalPhase.Directories;for(const row of rows.filter(r=>r.kind===Kind.Directory).sort((a,b)=>a.path.split("/").length-b.path.split("/").length||order(a.path,b.path))){createDirectory(row.path);await checkpoint();}
  phase=SelectedPhysicalPhase.Regular;for(const original of originals){
   streamCheck(original);
   for(const row of rows.filter(r=>r.kind===Kind.Regular&&r.origins[0]?.archiveSha256===original.members.package.sha256)){
    const origin=row.origins[0];need(origin,SelectedPhysicalHold.Origin);original.archive.rejoin();const payload=slice(origin),parent=parentFor(row.path),p=anchored(parent.fd,posix.basename(row.path));
    const fd=keep(fs.openSync(p,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600));
    try{let at=0;while(at<payload.length){tick();const n=fs.writeSync(fd,payload,at,Math.min(65536,payload.length-at),at);need(n>0,SelectedPhysicalHold.Filesystem);at+=n;}const s=finalize(fd,row.mode,row.mtime);need(s.isFile()&&s.nlink===1n&&stamp(fs.lstatSync(p,{bigint:true}))===stamp(s)&&readHash(fd,payload.length)===origin.row.payloadSha256,SelectedPhysicalHold.Content);slice(origin);original.archive.rejoin();regularBytes+=payload.length;}finally{close(fd);}refreshOwnedAncestor(parent);processedObjects++;await checkpoint();
   }
   streamCheck(original);
  }
  phase=SelectedPhysicalPhase.Aliases;for(const row of rows.filter(r=>r.kind===Kind.Symlink)){
   for(const origin of row.origins)slice(origin);const parent=parentFor(row.path),p=anchored(parent.fd,posix.basename(row.path));fs.symlinkSync(row.outputLiteral,p);fs.lchownSync(p,0,0);fs.lutimesSync(p,row.mtime,row.mtime);
   const s=fs.lstatSync(p,{bigint:true});need(s.isSymbolicLink()&&s.uid===0n&&s.gid===0n&&(s.mode&0o7777n)===0o777n&&s.nlink===1n&&s.mtimeNs===BigInt(row.mtime)*1000000000n&&fs.readlinkSync(p,{encoding:"buffer"}).equals(Buffer.from(row.outputLiteral))&&stamp(fs.lstatSync(p,{bigint:true}))===stamp(s),SelectedPhysicalHold.Content);for(const origin of row.origins)slice(origin);fs.fsyncSync(parent.fd);refreshOwnedAncestor(parent);processedObjects++;await checkpoint();
  }
  phase=SelectedPhysicalPhase.Finalize;for(const [path,d] of [...directories].sort(([a],[b])=>b.split("/").length-a.split("/").length||order(a,b))){d.initial=finalize(d.fd,0o755,0);finalized.add(d.fd);checkDirectory(d);await checkpoint();}
  phase=SelectedPhysicalPhase.Census;fs.fsyncSync(scratch.fd);joinAll();const physical=census(),root=directories.get("");need(root,SelectedPhysicalHold.Parent);const rootIdentity=identity(root.initial),frozenPhysical=hash(canonicalData(physical));completionPhysicalHash=frozenPhysical;
  for(const original of originals)streamCheck(original);
  const sourceOutput=serialize({schemaVersion:1,purpose:"UNADMITTED_FILESYSTEM_DATA",sourceSha:sourceSha,recipeSha256:selectedRecipeSha256,provenance:provenance,root:{path:"",origin:SelectedOutputOrigin.Recipe,origins:[],mode:0o755,mtime:0},rows:rows.map(row=>({...row,originalLiterals:row.origins.map(o=>({base64:o.row.linkBytesBase64,bytes:Buffer.from(o.row.linkBytesBase64,"base64").length,sha256:hash(Buffer.from(o.row.linkBytesBase64,"base64"))})),outputLiteralBytesBase64:Buffer.from(row.outputLiteral).toString("base64"),outputLiteralBytes:Buffer.byteLength(row.outputLiteral),outputLiteralSha256:hash(row.outputLiteral)})),nativeQualified:false,fixedImageQualified:false});
  phase=SelectedPhysicalPhase.Publication;await publish(recordNames[0],sourceOutput);need(hash(canonicalData(census()))===frozenPhysical,SelectedPhysicalHold.Identity);for(const original of originals)streamCheck(original);
  await publish(recordNames[1],serialize({schemaVersion:1,sourceOutput:records[0],rootIdentity,entries:physical,nativeQualified:false,fixedImageQualified:false}));need(hash(canonicalData(census()))===frozenPhysical,SelectedPhysicalHold.Identity);for(const original of originals)streamCheck(original);
  const measurement={objects:rows.length+1,regularBytes,elapsedMs:performance.now()-started,ownedDescriptorHighWater:highWater};
  await publish(recordNames[2],serialize({schemaVersion:1,disposition:SelectedPhysicalDisposition.Complete,sourceSha:sourceSha,recipeSha256:selectedRecipeSha256,records:[...records],rootIdentity,counts:{archiveSelected:rows.filter(r=>r.origin===SelectedOutputOrigin.Archive).length,generated:rows.filter(r=>r.origin===SelectedOutputOrigin.Recipe).length,root:1},measurement,nativeQualified:false,fixedImageQualified:false,rootReadonly:false,executableQualified:false,originalIssuerQualified:false,FULL8:"UNPROVEN"}));
  phase=SelectedPhysicalPhase.Completion;need(hash(canonicalData(census()))===frozenPhysical,SelectedPhysicalHold.Identity);for(const original of originals)streamCheck(original);joinAll();
  completed=true;return Object.freeze({disposition:SelectedPhysicalDisposition.Complete,rootIdentity,records:Object.freeze(records.map(r=>Object.freeze(r))),measurement:Object.freeze(measurement),nativeQualified:false,fixedImageQualified:false,originalIssuerQualified:false});
 }catch(error){
  throw new SelectedPhysicalHeld(readSelectedPhysicalHoldFacts(error)?.reason??SelectedPhysicalHold.Filesystem,rootCreated,phase,processedObjects,readSelectedPhysicalHoldFacts(error)?.identitySite??SelectedPhysicalIdentitySite.Unknown);
 }finally{
  phase=SelectedPhysicalPhase.Cleanup;let failed:SelectedPhysicalHold|undefined;
  for(const d of [...directories.values()].reverse())try{fs.fsyncSync(d.fd);if(completed&&!failed){tick();await checkpoint();}}catch(error){failed??=readSelectedPhysicalHoldFacts(error)?.reason??SelectedPhysicalHold.Filesystem;}
  if(completed&&!failed)try{joinAll();need(hash(canonicalData(census()))===completionPhysicalHash,SelectedPhysicalHold.Identity);for(const original of originals)streamCheck(original);rejoinPublished();tick();}catch(error){failed=readSelectedPhysicalHoldFacts(error)?.reason??SelectedPhysicalHold.Filesystem;}
  for(const fd of [...owned].reverse())try{close(fd);if(completed&&!failed)tick();}catch(error){failed??=readSelectedPhysicalHoldFacts(error)?.reason??SelectedPhysicalHold.Filesystem;}
  if(completed&&!failed)try{intrinsicPrototypes();tick();}catch(error){failed=readSelectedPhysicalHoldFacts(error)?.reason??SelectedPhysicalHold.Filesystem;}
  process.removeListener("SIGTERM",signal);process.removeListener("SIGINT",signal);
  if(failed)throw new SelectedPhysicalHeld(failed,rootCreated,phase,processedObjects);
 }
 }catch(error){
  const facts=readSelectedPhysicalHoldFacts(error);if(facts&&facts.phase!==SelectedPhysicalPhase.Unknown)throw error;
  throw new SelectedPhysicalHeld(facts?.reason??SelectedPhysicalHold.Unknown,facts?.rootCreated??false,phase,processedObjects);
 }
}
