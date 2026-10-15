import { DependencyOwnerPhase } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertCurrentHostedDependencyAttempt, findOriginalHostedDependencyGenerationEntry, CurrentHostedDependencyOriginKind, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { assertOriginalHostedDependencyGenerationBarrier } from "./hosted-dependency-generation-controller";
import { HostedDependencyWarmLeafPhase } from "./hosted-dependency-generation-state";
import { sameHostedDependencyKeyInputs } from "./hosted-dependency-materialization-context";
import { selectHostedDependencyWarmLeaf } from "./hosted-dependency-warm-leaf-request";
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, readSync, writeSync, type BigIntStats } from "node:fs";
import type { HostedDependencyLocalKeyInputs } from "./hosted-dependency-materialization-context";
const directory=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
const at=(fd:number,name:string)=>`/proc/self/fd/${fd}/${name}`;
function held():never {throw new Error("hosted_dependency_warm_leaf_physical_held");}
function same(a:BigIntStats,b:BigIntStats):boolean {return a.dev===b.dev && a.ino===b.ino && a.mode===b.mode && a.uid===b.uid && a.gid===b.gid && a.nlink===b.nlink;}
function mount(fd:number):string {
  const value=readFileSync(`/proc/self/fdinfo/${fd}`,"utf8"),rows=[...value.matchAll(/^mnt_id:\s*([1-9][0-9]{0,19})$/gm)];
  if(value.length>65536 || rows.length!==1)held();return rows[0]![1]!;
}
/** Fixed synchronous anchored effect. Only the lexical original-module caller
 * chooses it after current admission. All temporary handles close before any
 * original-context census; this helper never skips or supplies FD coverage. */
export function writeHostedDependencyWarmLeaf(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol,inputs:HostedDependencyLocalKeyInputs,path:string,bytes:Uint8Array):void {
  const original=findOriginalHostedDependencyGenerationEntry(context,access);assertHostedActivationFence(fence);
  const actual=assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
  if(original.rootPurpose || original.cold || actual.facts.kind===CurrentHostedDependencyOriginKind.Ordinary && !original.ordinaryAdmitted ||
      original.generation?.warmLeaf?.phase!==HostedDependencyWarmLeafPhase.Preparing || !original.generation.inputs ||
      !sameHostedDependencyKeyInputs(original.generation.inputs,inputs))held();
  assertOriginalHostedDependencyGenerationBarrier(context,fence,access);selectHostedDependencyWarmLeaf(inputs,path);
  const opened:{fd:number;info:BigIntStats;mountId:string;parent?:number;name?:string}[]=[];
  const descriptors:number[]=[];
  const openDirectory=(path:string)=>{const fd=openSync(path,directory);descriptors.push(fd);return fd;};
  let leaf:number|undefined;
  try {
    let parent=openDirectory("/"),absolute="";
    opened.push({fd:parent,info:fstatSync(parent,{bigint:true}),mountId:mount(parent)});
    for(const name of inputs.capture.workspace.canonicalPath.split("/").filter(Boolean)) {
      const fd=openDirectory(at(parent,name)),info=fstatSync(fd,{bigint:true});
      opened.push({fd,info,mountId:mount(fd),parent,name});parent=fd;absolute+="/"+name;
      const pin=inputs.capture.ancestorPins.find(value=>value.path===absolute);
      if(pin && (String(info.dev)!==pin.dev || String(info.ino)!==pin.ino || String(info.mode)!==pin.mode || mount(fd)!==pin.mountId))held();
    }
    const workspace=opened.at(-1)!;
    if(String(workspace.info.dev)!==inputs.capture.workspace.dev || String(workspace.info.ino)!==inputs.capture.workspace.ino)held();
    const parts=path.split("/");let relative="";
    for(const name of parts.slice(0,-1)) {
      const fd=openDirectory(at(parent,name)),info=fstatSync(fd,{bigint:true}),mountId=mount(fd);
      opened.push({fd,info,mountId,parent,name});parent=fd;relative+=(relative?"/":"")+name;
      const pin=inputs.capture.pins.find(value=>value.path===relative);
      if(!info.isDirectory() || mountId!==workspace.mountId || info.dev!==workspace.info.dev || pin &&
          (String(info.dev)!==pin.dev || String(info.ino)!==pin.ino || String(info.mode)!==pin.mode || mountId!==pin.mountId))held();
    }
    const name=parts.at(-1)!,named=at(parent,name),before=lstatSync(named,{bigint:true});
    if(!before.isFile() || before.nlink!==1n || before.dev!==workspace.info.dev || (before.mode&0o7000n)!==0n || before.size>1024n*1024n)held();
    leaf=openSync(named,constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const actual=fstatSync(leaf,{bigint:true});
    if(!same(actual,before) || actual.size!==before.size || actual.ctimeNs!==before.ctimeNs || actual.mtimeNs!==before.mtimeNs || mount(leaf)!==workspace.mountId)held();
    const checkAnchors=()=>{for(const item of opened) {
      if(!same(fstatSync(item.fd,{bigint:true}),item.info) || mount(item.fd)!==item.mountId)held();
      if(item.parent!==undefined && item.name!==undefined) {
        const fd=openSync(at(item.parent,item.name),directory);
        try{if(!same(fstatSync(fd,{bigint:true}),item.info) || mount(fd)!==item.mountId)held();}finally{closeSync(fd);}
      }
    }};
    checkAnchors();const last=fstatSync(leaf,{bigint:true});
    if(!same(lstatSync(named,{bigint:true}),actual) || !same(last,actual) || last.size!==actual.size ||
        last.ctimeNs!==actual.ctimeNs || last.mtimeNs!==actual.mtimeNs)held();
    let offset=0;
    while(offset<bytes.byteLength) {const written=writeSync(leaf,bytes,offset,bytes.byteLength-offset,offset);if(written<=0)held();offset+=written;}
    ftruncateSync(leaf,bytes.byteLength);fsyncSync(leaf);
    const after=fstatSync(leaf,{bigint:true});
    if(!same(actual,after) || after.size!==BigInt(bytes.byteLength) || !same(lstatSync(named,{bigint:true}),after) || mount(leaf)!==workspace.mountId)held();
    const copied=new Uint8Array(bytes.byteLength);let read=0;
    while(read<copied.byteLength){const count=readSync(leaf,copied,read,copied.byteLength-read,read);if(count<=0)held();read+=count;}
    const stable=fstatSync(leaf,{bigint:true});
    if(!same(stable,after) || stable.size!==after.size || stable.ctimeNs!==after.ctimeNs || stable.mtimeNs!==after.mtimeNs ||
        !copied.every((value,index)=>value===bytes[index]))held();
    checkAnchors();
  }finally {
    // Every close is attempted even if one fails; uncertainty propagates Held.
    let failed:unknown;
    if(leaf!==undefined)try{closeSync(leaf);}catch(error){failed=error;}
    for(const fd of descriptors.reverse())try{closeSync(fd);}catch(error){failed??=error;}
    if(failed!==undefined)throw failed;
  }
}
