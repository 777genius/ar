/** Fixed semantic input selection over a complete dpkg-source extraction.
 * These commitments are DATA; absent generated build inputs stay explicit. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
export enum H1SemanticFamily {Python="python3.12",Systemd="systemd"}
export enum H1SemanticInputState {Present="present_unadmitted",Absent="absent"}
export enum H1SourceObjectKind {Directory="directory",File="file",Alias="alias"}
export interface H1SourceObject {readonly path:string;readonly kind:H1SourceObjectKind;readonly mode:number;readonly bytes:number;readonly sha256:string;readonly target:string}
export const h1PatchedSourceLimits=Object.freeze({entries:50000,fileBytes:32*1024*1024,totalBytes:512*1024*1024,recordBytes:64*1024*1024,patches:2048});
const hash=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
const pythonInputs=["Modules/getpath.py","Modules/getpath.c","Python/frozen_modules/getpath.h","Programs/_freeze_module.c","Programs/_freeze_module.py","Tools/build/freeze_modules.py","Makefile.pre.in","configure","configure.ac","pyconfig.h.in","Include/internal/pycore_pathconfig.h","Python/pathconfig.c","Python/initconfig.c"] as const;
const systemdInputs=["src/nspawn/nspawn.c","src/nspawn/nspawn-mount.c","src/nspawn/nspawn-mount.h","src/nspawn/nspawn-cgroup.c","src/shared/dev-setup.c","src/shared/dev-setup.h","src/basic/os-util.c","src/basic/os-util.h","src/shared/meson.build","src/nspawn/meson.build","meson.build","meson_options.txt"] as const;
/** Closed families; each required review file is either retained in full or
 * explicitly absent. Presence is not a reviewed helper/compile closure. */
export function selectH1SemanticInputs(family:H1SemanticFamily,inventory:readonly H1SourceObject[],read:(path:string)=>Buffer,tick:()=>void){
 assert(Object.values(H1SemanticFamily).includes(family));const byPath=new Map(inventory.map(row=>[row.path,row]));assert.equal(byPath.size,inventory.length);
 const wanted=new Set<string>(family===H1SemanticFamily.Python?pythonInputs:systemdInputs);
 for(const row of inventory)if(row.kind===H1SourceObjectKind.File&&(row.path.startsWith("debian/")||row.path==="Makefile"||row.path==="pyconfig.h"||row.path==="config.h"||row.path.startsWith("build/meson-info/")||row.path.startsWith("build/meson-private/")))wanted.add(row.path);
 let bytes=0;const inputs=[...wanted].sort().map(path=>{tick();const row=byPath.get(path);if(!row)return Object.freeze({path,state:H1SemanticInputState.Absent});
  assert.equal(row.kind,H1SourceObjectKind.File,"selected semantic input must be a regular original file");const body=read(path);assert.equal(body.length,row.bytes);assert.equal(hash(body),row.sha256);bytes+=body.length;assert(bytes<=h1PatchedSourceLimits.recordBytes);
  return Object.freeze({path,state:H1SemanticInputState.Present,sha256:row.sha256,bytes:row.bytes,bodyBase64:body.toString("base64")});});
 const generated=(family===H1SemanticFamily.Python?["Python/frozen_modules/getpath.h","pyconfig.h","Makefile"]:["config.h","build/meson-info/intro-buildoptions.json","build/meson-private/coredata.dat"]).map(path=>Object.freeze({path,state:byPath.has(path)?H1SemanticInputState.Present:H1SemanticInputState.Absent}));
 tick();return Object.freeze({family,inputs:Object.freeze(inputs),generated:Object.freeze(generated),helperClosureReviewed:false,compiledInputEquality:false,hostNspawnProvenance:false,nativeQualified:false});
}

/** Vendor-series names and order are data inputs. No patch interpretation here:
 * the original dpkg-source applies quilt, and .pc records must agree exactly. */
export function readH1UbuntuPatchSeries(read:(path:string)=>Buffer|undefined){
 const vendor=read("debian/patches/ubuntu.series"),selected=vendor??read("debian/patches/series");
 assert(selected,"complete Ubuntu quilt series required");const value=selected.toString("utf8");assert(Buffer.from(value).equals(selected)&&!value.includes("\0")&&selected.length<=1024*1024);
 const names:string[]=[];for(const raw of value.split("\n")){const line=raw.trim();if(!line||line.startsWith("#"))continue;
  // dpkg-source supports quilt options; record the full line but require the
  // documented -p1 convention, refusing unsupported profile options explicitly.
  const cells=line.split(/\s+/);assert(cells.length===1||(cells.length===2&&cells[1]==="-p1"));const name=cells[0]!;assert(name.length<=4096&&!name.startsWith("/")&&/^[A-Za-z0-9_+./-]+$/.test(name)&&name.split("/").every(p=>p!==""&&p!=="."&&p!==".."));assert(!names.includes(name)&&names.length<h1PatchedSourceLimits.patches);names.push(name);
 }
 const facts=names.map(name=>{const body=read("debian/patches/"+name);assert(body,"series patch missing");return Object.freeze({path:"debian/patches/"+name,bytes:body.length,sha256:hash(body)});});
 const applied=read(".pc/applied-patches");assert(names.length===0||applied,"quilt application record missing");const actual=applied?.toString("utf8").trimEnd().split("\n").filter(Boolean)??[];assert.deepEqual(actual,names,"actual applied quilt roster/order");
 return Object.freeze({vendor:"ubuntu",path:vendor?"debian/patches/ubuntu.series":"debian/patches/series",sha256:hash(selected),patches:Object.freeze(facts)});
}
