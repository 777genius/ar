/** Fixed semantic input selection over a complete dpkg-source extraction.
 * These commitments are DATA; absent generated build inputs stay explicit. */
import assert from "node:assert/strict";
import {types} from "node:util";
import {createHash} from "node:crypto";
export enum H1SemanticFamily {Python="python3.12",Systemd="systemd"}
export enum H1SemanticInputState {Present="present_unadmitted",Absent="absent"}
export enum H1SourceObjectKind {Directory="directory",File="file",Alias="alias"}
export interface H1SourceObject {readonly path:string;readonly kind:H1SourceObjectKind;readonly mode:number;readonly bytes:number;readonly sha256:string;readonly target:string}
export const h1PatchedSourceLimits=Object.freeze({entries:50000,fileBytes:32*1024*1024,totalBytes:512*1024*1024,recordBytes:64*1024*1024,patches:2048});
const hash=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
const pythonInputs=["Modules/getpath.py","Modules/getpath.c","Python/frozen_modules/getpath.h","Programs/_freeze_module.c","Programs/_freeze_module.py","Tools/build/freeze_modules.py","Makefile.pre.in","configure","configure.ac","pyconfig.h.in","Include/internal/pycore_pathconfig.h","Python/pathconfig.c","Python/initconfig.c"] as const;
const systemdInputs=["src/nspawn/nspawn.c","src/nspawn/nspawn-mount.c","src/nspawn/nspawn-mount.h","src/nspawn/nspawn-cgroup.c","src/shared/dev-setup.c","src/shared/dev-setup.h","src/basic/os-util.c","src/basic/os-util.h","src/shared/meson.build","src/nspawn/meson.build","meson.build","meson_options.txt"] as const;
export enum H1SemanticSite {Family="family",Inventory="inventory",Selection="selection",InputTick="input_tick",InputKind="input_kind",InputRead="input_read",InputBytes="input_bytes",InputHash="input_hash",InputBudget="input_budget",FinalTick="final_tick",SeriesRead="series_read",SeriesBytes="series_bytes",SeriesEntry="series_entry",PatchRead="patch_read",AppliedRead="applied_read",AppliedOrder="applied_order"}
export enum H1SemanticCategory {Assertion="assertion",Read="original_read",Tick="original_tick"}
export interface H1SemanticFailureFacts {readonly family:H1SemanticFamily|null;readonly site:H1SemanticSite;readonly category:H1SemanticCategory;readonly selected:number;readonly processed:number;readonly expected:number;readonly observed:number;readonly expectedSha256:string|null;readonly observedSha256:string|null;readonly objectKind:H1SourceObjectKind|null}
const semanticFailures=new WeakMap<object,Readonly<H1SemanticFailureFacts>>();
/** Original in-process context only. No unknown error property, path or body. */
export function readH1SemanticFailure(error:unknown):Readonly<H1SemanticFailureFacts>|undefined{return types.isProxy(error)||!types.isNativeError(error)?undefined:semanticFailures.get(error);}
function retainFailure(error:unknown,facts:H1SemanticFailureFacts){try{if(!types.isProxy(error)&&types.isNativeError(error))semanticFailures.set(error,Object.freeze({...facts}));}catch{}}
/** Closed families; each required review file is either retained in full or
 * explicitly absent. Presence is not a reviewed helper/compile closure. */
export function selectH1SemanticInputs(family:H1SemanticFamily,inventory:readonly H1SourceObject[],read:(path:string)=>Buffer,tick:()=>void){
 const context:H1SemanticFailureFacts={family:Object.values(H1SemanticFamily).includes(family)?family:null,site:H1SemanticSite.Family,category:H1SemanticCategory.Assertion,selected:0,processed:0,expected:0,observed:0,expectedSha256:null,observedSha256:null,objectKind:null};let facts={...context};
 const at=(site:H1SemanticSite,category=H1SemanticCategory.Assertion,expected=0,observed=0)=>{facts={...facts,site,category,expected,observed,expectedSha256:null,observedSha256:null,objectKind:null};};
 try{
 assert(Object.values(H1SemanticFamily).includes(family));at(H1SemanticSite.Inventory);const byPath=new Map(inventory.map(row=>[row.path,row]));assert.equal(byPath.size,inventory.length);
 const wanted=new Set<string>(family===H1SemanticFamily.Python?pythonInputs:systemdInputs);
 for(const row of inventory)if(row.kind===H1SourceObjectKind.File&&(row.path.startsWith("debian/")||row.path==="Makefile"||row.path==="pyconfig.h"||row.path==="config.h"||row.path.startsWith("build/meson-info/")||row.path.startsWith("build/meson-private/")))wanted.add(row.path);
 facts.selected=wanted.size;let bytes=0;const inputs=[...wanted].sort().map(path=>{at(H1SemanticSite.InputTick,H1SemanticCategory.Tick);tick();const row=byPath.get(path);if(!row){facts.processed++;return Object.freeze({path,state:H1SemanticInputState.Absent});}
 at(H1SemanticSite.InputKind);facts.objectKind=row.kind;assert.equal(row.kind,H1SourceObjectKind.File,"selected semantic input must be a regular original file");at(H1SemanticSite.InputRead,H1SemanticCategory.Read,row.bytes);const body=read(path);at(H1SemanticSite.InputBytes,H1SemanticCategory.Assertion,row.bytes,body.length);assert.equal(body.length,row.bytes);at(H1SemanticSite.InputHash);assert.equal(hash(body),row.sha256);bytes+=body.length;at(H1SemanticSite.InputBudget,H1SemanticCategory.Assertion,h1PatchedSourceLimits.recordBytes,bytes);assert(bytes<=h1PatchedSourceLimits.recordBytes);facts.processed++;
 return Object.freeze({path,state:H1SemanticInputState.Present,sha256:row.sha256,bytes:row.bytes,bodyBase64:body.toString("base64")});});
 const generated=(family===H1SemanticFamily.Python?["Python/frozen_modules/getpath.h","pyconfig.h","Makefile"]:["config.h","build/meson-info/intro-buildoptions.json","build/meson-private/coredata.dat"]).map(path=>Object.freeze({path,state:byPath.has(path)?H1SemanticInputState.Present:H1SemanticInputState.Absent}));
 at(H1SemanticSite.FinalTick,H1SemanticCategory.Tick);tick();return Object.freeze({family,inputs:Object.freeze(inputs),generated:Object.freeze(generated),helperClosureReviewed:false,compiledInputEquality:false,hostNspawnProvenance:false,nativeQualified:false});
 }catch(error){retainFailure(error,facts);throw error;}
}

/** Vendor-series names and order are data inputs. No patch interpretation here:
 * the original dpkg-source applies quilt, and .pc records must agree exactly. */
export function readH1UbuntuPatchSeries(read:(path:string)=>Buffer|undefined){
 let facts:H1SemanticFailureFacts={family:null,site:H1SemanticSite.SeriesRead,category:H1SemanticCategory.Read,selected:0,processed:0,expected:0,observed:0,expectedSha256:null,observedSha256:null,objectKind:null};
 const at=(site:H1SemanticSite,category=H1SemanticCategory.Assertion,expected=0,observed=0)=>{facts={...facts,site,category,expected,observed,expectedSha256:null,observedSha256:null,objectKind:null};};
 try{
 const vendor=read("debian/patches/ubuntu.series"),selected=vendor??read("debian/patches/series");
 at(H1SemanticSite.SeriesBytes,H1SemanticCategory.Assertion,1,selected?1:0);assert(selected,"complete Ubuntu quilt series required");const value=selected.toString("utf8");assert(Buffer.from(value).equals(selected)&&!value.includes("\0")&&selected.length<=1024*1024);
 const names:string[]=[];for(const raw of value.split("\n")){const line=raw.trim();if(!line||line.startsWith("#"))continue;
 at(H1SemanticSite.SeriesEntry);const cells=line.split(/\s+/);assert(cells.length===1||(cells.length===2&&cells[1]==="-p1"));const name=cells[0]!;assert(name.length<=4096&&!name.startsWith("/")&&/^[A-Za-z0-9_+.,/-]+$/.test(name)&&name.split("/").every(p=>p!==""&&p!=="."&&p!==".."));assert(!names.includes(name)&&names.length<h1PatchedSourceLimits.patches);names.push(name);facts={...facts,selected:names.length};
 }
 const patchFacts=names.map(name=>{at(H1SemanticSite.PatchRead,H1SemanticCategory.Read,1,0);const body=read("debian/patches/"+name);facts={...facts,observed:body?1:0};assert(body,"series patch missing");facts={...facts,processed:facts.processed+1};return Object.freeze({path:"debian/patches/"+name,bytes:body.length,sha256:hash(body)});});
 at(H1SemanticSite.AppliedRead,H1SemanticCategory.Read,names.length>0?1:0,0);const applied=read(".pc/applied-patches");facts={...facts,observed:applied?1:0};assert(names.length===0||applied,"quilt application record missing");const actual=applied?.toString("utf8").trimEnd().split("\n").filter(Boolean)??[];at(H1SemanticSite.AppliedOrder,H1SemanticCategory.Assertion,names.length,actual.length);facts={...facts,expectedSha256:hash(JSON.stringify(names)),observedSha256:hash(JSON.stringify(actual))};assert.deepEqual(actual,names,"actual applied quilt roster/order");
 return Object.freeze({vendor:"ubuntu",path:vendor?"debian/patches/ubuntu.series":"debian/patches/series",sha256:hash(selected),patches:Object.freeze(patchFacts)});
 }catch(error){retainFailure(error,facts);throw error;}
}
