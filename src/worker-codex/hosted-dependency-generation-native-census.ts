import { readOriginalHostedDependencyPriorRSourceClosure, readOriginalHostedDependencyConsumerPriorRSourceClosure } from "./hosted-dependency-generation-r-source-closure";
import { readOriginalHostedDependencyPriorCSourceClosure, readOriginalHostedDependencyOperatorPriorCSourceClosure } from "./hosted-dependency-generation-prior-closure";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { verifyPinnedFdCollectorProfile } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { verifySystemBusInfrastructure } from "../provider-codex/app-server/adapters/system-bus-infrastructure";
import { readHostedReadonlyHostInventory, HostedReadonlyHostKernel } from "./hosted-readonly-host-kernel";
import { readOriginalHostedDependencyGenerationNativeScope } from "./hosted-dependency-generation-native-scope";
import { assertOriginalHostedDependencyPhysicalRecordAccess, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { collectCgroupProcesses, collectFutureCreatorShow, collectJobs, collectUnitShow } from "./hosted-readonly-linux-collector";
import { assertExactUnitGroup, observedJobUnits } from "./hosted-readonly-observations";

/** A current census is one required factual part of the interval, not a seal,
 * registration or scope permit. The only additional live units come from the
 * SAME original map's actual parent/FDA child associations. No caller unit,
 * role, process, cgroup, exclusion list or callback enters this fixed reader. */
export function readOriginalHostedDependencyGenerationNativeCensus(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol):boolean {
  return census(context,fence,access);
}
export function readOriginalHostedDependencyOperatorNativeCensus(fence:HostedActivationFence,access:symbol):boolean {
  return census(undefined,fence,access);
}
function scope(context:CurrentHostedDependencyOrigin|undefined,fence:HostedActivationFence,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  if(context)return readOriginalHostedDependencyGenerationNativeScope(context,fence,access);
  assertHostedActivationOperator();assertHostedProcessDescriptors();
  const units:readonly string[]=[];
  return {units,operator:new HostedReadonlyHostKernel().operatorSession()};
}
function census(context:CurrentHostedDependencyOrigin|undefined,fence:HostedActivationFence,access:symbol):boolean {
  const before=scope(context,fence,access),inventory=readHostedReadonlyHostInventory();
  if(!inventory.collectorProfile || !inventory.systemBusInfrastructure || inventory.schemaVersion!==4)invalid();
  verifyPinnedFdCollectorProfile(inventory.collectorProfile);verifySystemBusInfrastructure(inventory.systemBusInfrastructure);
  for(const name of inventory.disabledCreators) {
    const rows=lines(collectFutureCreatorShow(name)),values=new Map(rows.map(line=>{const at=line.indexOf("=");if(at<1)invalid();return [line.slice(0,at),line.slice(at+1)];}));
    if(values.size!==5 || rows.length!==5 || values.get("Id")!==name || values.get("LoadState")!=="masked" ||
        values.get("ActiveState")!=="inactive" || values.get("UnitFileState")!=="masked" || values.get("Job")!=="")invalid();
  }
  for(const line of lines(systemctl(["list-unit-files","--type=service,socket,timer","--state=enabled,enabled-runtime,linked,linked-runtime,alias","--no-legend","--no-pager"]))) {
    const fields=line.trim().split(/\s+/);if(fields.length<2 || fields.length>3 ||
        !inventory.units.some(row=>row.name===fields[0]) && fields[0]!=="dbus.socket")invalid();
  }
  for(const line of lines(systemctl(["list-units","--all","--type=socket,timer","--state=active,activating,reloading,deactivating","--no-legend","--plain","--no-pager"]))) {
    if(line.trim().split(/\s+/)[0]!=="dbus.socket")invalid();
  }
  const observed=lines(systemctl(["list-units","--all","--type=service,scope","--state=active,activating,reloading,deactivating,failed","--no-legend","--plain","--no-pager"]));
  let eligible=true;const discharged=new Set<string>();
  for(const line of observed) {
    const name=line.trim().split(/\s+/)[0];if(name==="init.scope")continue;
    if(!unit(name))invalid();
    if(!inventory.units.some(row=>row.name===name) && !before.units.includes(name) && !discharged.has(name)) {
      const c=context ? readOriginalHostedDependencyPriorCSourceClosure(context,fence,name,access) :
        readOriginalHostedDependencyOperatorPriorCSourceClosure(fence,name,access);
      const prior=c ?? (context ? readOriginalHostedDependencyConsumerPriorRSourceClosure(context,fence,name,access) :
        readOriginalHostedDependencyPriorRSourceClosure(fence,name,access));
      if(prior)for(const selected of prior)discharged.add(selected);else eligible=false;
    }
  }
  for(const name of before.units) {
    const current=collectUnitShow(name);
    if(current.Id!==name || current.DropInPaths!=="" || current.ControlGroup && current.ControlGroup!==group(name))invalid();
  }
  for(const row of inventory.units) {
    const current=collectUnitShow(row.name);assertExactUnitGroup(row.name,current,row.controlGroup);
    if(!path(current.FragmentPath) || current.DropInPaths!=="" ||
        createHash("sha256").update(fragment(current.FragmentPath)).digest("hex")!==row.fragmentSha256)invalid();
  }
  let count=0;
  const walk=(relative:string):void=>{
    if(++count>4096)invalid();const pids=lines(collectCgroupProcesses(relative));
    if(pids.some(pid=>!/^[1-9]\d*$/.test(pid)))invalid();
    if(pids.length && !inventory.units.some(row=>row.controlGroup===relative) &&
        !before.units.some(name=>relative===group(name)) &&
        !(relative==="/init.scope" && pids.length===1 && pids[0]==="1"))eligible=false;
    for(const child of readdirSync("/sys/fs/cgroup"+relative,{withFileTypes:true}))if(child.isDirectory())walk(relative+"/"+child.name);
  };
  walk("");
  for(const name of observedJobUnits(collectJobs())) {
    if(inventory.disabledCreators.includes(name))invalid();
    // A historical closed chain cannot discharge a newly observed manager job.
    // Its earlier drain is not evidence about this later queue snapshot.
    if(!inventory.units.some(row=>row.name===name) && !before.units.includes(name))eligible=false;
  }
  // No unit/FD allowance survives a changed original context or physical FDA
  // association. All fragment/collector descriptors have closed before this.
  const after=scope(context,fence,access);assertHostedActivationFence(fence);
  if(JSON.stringify(before)!==JSON.stringify(after))invalid();return eligible;
}
function systemctl(args:readonly string[]):string {
  const result=spawnSync("/usr/bin/systemctl",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:5000,maxBuffer:256*1024,
    env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",SYSTEMD_COLORS:"0"}});
  if(result.error || result.status!==0)invalid();return result.stdout;
}
/** Same independently pinned fragment check as the retained host inventory.
 * Temporary FDs never become original descriptor allowances. */
function fragment(input:string):Buffer {
  const file=realpathSync(input);if(!path(file))invalid();
  for(let parent=dirname(file);;parent=dirname(parent)) {const stat=lstatSync(parent);
    if(!stat.isDirectory() || stat.uid!==0 || stat.mode&0o022)invalid();if(parent==="/")break;}
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {const before=fstatSync(fd);if(!before.isFile() || before.uid!==0 || before.nlink!==1 || before.mode&0o022 || before.size>65536)invalid();
    const bytes=Buffer.alloc(65537),length=readSync(fd,bytes,0,bytes.length,0),after=fstatSync(fd);
    if(length!==before.size || length>65536 || before.ctimeMs!==after.ctimeMs || before.size!==after.size)invalid();return bytes.subarray(0,length);
  }finally{closeSync(fd);}
}
function group(name:string):string {if(!/^subscription-runtime-(?:ordinary|outer|hosted|installer)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.service$/.test(name))invalid();return `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${name}`;}
function unit(v:unknown):v is string{return typeof v==="string" && v.length<=200 && /^[A-Za-z0-9_@.-]+\.(service|scope)$/.test(v);}
function path(v:unknown):v is string{return typeof v==="string" && v.length<=4096 && /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(v) && !v.split("/").some(p=>p==="." || p==="..");}
function lines(v:string):string[]{return v.split("\n").filter(line=>line.trim());}
function invalid():never{throw new Error("hosted_dependency_generation_native_census_unresolved");}
