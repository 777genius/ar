/** Fixed H1 staged-tool catalog and original constructor transport. DATA parsers never grant authority. */
import {createHash} from "node:crypto";
import {types} from "node:util";
import {performance} from "node:perf_hooks";
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,readdirSync,readlinkSync,type BigIntStats} from "node:fs";
import {posix} from "node:path";
export enum H1CatalogKind {Directory="directory",File="file",Alias="alias"}
export enum H1MountOrigin {Staged="staged",Kernel="kernel",Generated="generated",HostData="host_data"}
export enum H1StagedUnsupportedReason {ConstructorRows="selected_constructor_rows_not_qualified"}
const limits=Object.freeze({entries:20000,fileBytes:32*1024*1024,totalBytes:512*1024*1024});
function hold():never {throw new Error("TEST H1 staged DATA Held");}
function need(v:unknown):asserts v {if(!v)hold();}
function record(v:unknown,keys:readonly string[]):Record<string,unknown>{
  need(v!==null && typeof v==="object" && !types.isProxy(v) && Object.getPrototypeOf(v)===Object.prototype);
  const d=Object.getOwnPropertyDescriptors(v),own=Reflect.ownKeys(d);need(own.length===keys.length && own.every(k=>typeof k==="string" && keys.includes(k)));
  const out:Record<string,unknown>={};for(const k of keys){const p=d[k];need(p && Object.hasOwn(p,"value") && p.enumerable);out[k]=p.value;}return out;
}
function list(v:unknown):unknown[]{need(Array.isArray(v) && !types.isProxy(v) && Object.getPrototypeOf(v)===Array.prototype && v.length<=limits.entries);const d=Object.getOwnPropertyDescriptors(v);need(Reflect.ownKeys(d).length===v.length+1);for(let i=0;i<v.length;i++)need(d[String(i)] && Object.hasOwn(d[String(i)]!,"value"));return Array.from(v);}
function text(v:unknown):string{need(typeof v==="string" && v.length>0 && v.length<=4096 && !/[\x00-\x1f\x7f]/.test(v) && Buffer.from(v,"utf8").toString("utf8")===v);return v;}
function hex(v:unknown,n:number):string{const s=text(v);need(new RegExp("^[a-f0-9]{"+n+"}$").test(s));return s;}
function decimal(v:unknown):string{const s=text(v);need(/^(0|[1-9][0-9]{0,19})$/.test(s));return s;}
function physicalUtf8(bytes:Buffer):string{const value=bytes.toString("utf8");need(Buffer.from(value,"utf8").equals(bytes));return text(value);}
function path(v:unknown):string{const p=text(v);need(!p.startsWith("/") && p!=="." && p.split("/").every(s=>s!=="" && s!=="." && s!==".."));return p;}
const identityKeys=["dev","ino","mode","uid","gid","nlink","size","mtimeNs","ctimeNs"] as const;
export type H1ObjectIdentity=Readonly<Record<typeof identityKeys[number],string>>;
function identityData(v:unknown):H1ObjectIdentity{const d=record(v,identityKeys);return Object.freeze({dev:decimal(d.dev),ino:decimal(d.ino),mode:decimal(d.mode),uid:decimal(d.uid),gid:decimal(d.gid),nlink:decimal(d.nlink),size:decimal(d.size),mtimeNs:decimal(d.mtimeNs),ctimeNs:decimal(d.ctimeNs)});}
function actualIdentity(s:BigIntStats):H1ObjectIdentity{return Object.freeze({dev:String(s.dev),ino:String(s.ino),mode:String(s.mode),uid:String(s.uid),gid:String(s.gid),nlink:String(s.nlink),size:String(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs)});}
function same(a:unknown,b:unknown):void{need(JSON.stringify(a)===JSON.stringify(b));}
export type H1CatalogEntry=Readonly<{path:string;kind:H1CatalogKind;identity:H1ObjectIdentity;sha256:string;target:string}>;
function catalogEntry(v:unknown):H1CatalogEntry{
  const d=record(v,["path","kind","identity","sha256","target"]),p=path(d.path),identity=identityData(d.identity);
  need(d.kind===H1CatalogKind.Directory || d.kind===H1CatalogKind.File || d.kind===H1CatalogKind.Alias);
  need(identity.uid==="0" && identity.gid==="0" && (d.kind===H1CatalogKind.Alias || (BigInt(identity.mode)&0o022n)===0n));
  if(d.kind===H1CatalogKind.File){need(identity.nlink==="1" && BigInt(identity.size)<=BigInt(limits.fileBytes) && d.target==="");return Object.freeze({path:p,kind:d.kind,identity,sha256:hex(d.sha256,64),target:""});}
  need(d.sha256==="");if(d.kind===H1CatalogKind.Directory){need(d.target==="");return Object.freeze({path:p,kind:d.kind,identity,sha256:"",target:""});}
  need(identity.nlink==="1");const target=text(d.target);need(!target.startsWith("/") && BigInt(Buffer.byteLength(target,"utf8"))===BigInt(identity.size));const relative=posix.normalize(posix.join(posix.dirname(p),target));need(relative!==".." && !relative.startsWith("../") && relative!==".");
  return Object.freeze({path:p,kind:d.kind,identity,sha256:"",target});
}
export type H1MountRow=Readonly<{path:string;origin:H1MountOrigin;reference:string;readonly:boolean;mountId:string;parentId:string;device:string;mountRoot:string;filesystem:string;source:string;flags:string;propagation:string}>;
const apiPaths=new Set(["/","/proc","/proc/sys","/proc/sysrq-trigger","/proc/sys/kernel/random/boot_id","/proc/kmsg","/sys","/sys/fs/cgroup","/dev","/dev/pts","/dev/ptmx","/dev/shm","/dev/console","/run","/tmp","/run/host","/run/host/incoming"]);
function mountRow(v:unknown):H1MountRow{const d=record(v,["path","origin","reference","readonly","mountId","parentId","device","mountRoot","filesystem","source","flags","propagation"]);const p=text(d.path);need(apiPaths.has(p));need(d.origin===H1MountOrigin.Staged || d.origin===H1MountOrigin.Kernel || d.origin===H1MountOrigin.Generated || d.origin===H1MountOrigin.HostData);need(typeof d.readonly==="boolean");const reference=hex(d.reference,64);if(p==="/")need(d.origin===H1MountOrigin.Staged && d.readonly);const mountId=decimal(d.mountId),parentId=decimal(d.parentId),device=text(d.device),mountRoot=text(d.mountRoot),filesystem=text(d.filesystem),source=text(d.source),flags=text(d.flags),propagation=text(d.propagation);need(mountId!=="0" && /^[0-9]+:[0-9]+$/.test(device) && mountRoot.startsWith("/") && posix.normalize(mountRoot)===mountRoot);const options=flags.split(",");need(new Set(options).size===options.length && options.includes(d.readonly?"ro":"rw") && !options.includes(d.readonly?"rw":"ro"));return Object.freeze({path:p,origin:d.origin,reference,readonly:d.readonly,mountId,parentId,device,mountRoot,filesystem,source,flags,propagation});}
export type H1HostRelease=Readonly<{source:"/etc/os-release"|"/usr/lib/os-release";sha256:string;cells:Readonly<Record<string,string>>}>;
function hostRelease(v:unknown):H1HostRelease{const d=record(v,["source","sha256","cells"]);need(d.source==="/etc/os-release" || d.source==="/usr/lib/os-release");const c=d.cells;need(c!==null && typeof c==="object" && !types.isProxy(c) && Object.getPrototypeOf(c)===Object.prototype);const descriptors=Object.getOwnPropertyDescriptors(c);need(Reflect.ownKeys(descriptors).length>0 && Reflect.ownKeys(descriptors).length<=64);const cells:Record<string,string>={};for(const k of Reflect.ownKeys(descriptors)){need(typeof k==="string" && /^container_host_[a-z][a-z0-9_]{0,63}$/.test(k));const item=descriptors[k];need(item && Object.hasOwn(item,"value") && item.enumerable);cells[k]=text(item.value);}return Object.freeze({source:d.source,sha256:hex(d.sha256,64),cells:Object.freeze(cells)});}
const definitionKeys=["mountAll","mountSysfs","mountCgroups","devSetup","inaccessibleNodes","notify","hostReleaseTransform"] as const;
export enum H1DistroAssurance {SignedPublisher="ubuntu_signed_publisher_binary_and_source_attribution"}
export type H1StagedSubject=Readonly<{schemaVersion:1|2;distroFactsSha256?:string;assurance?:H1DistroAssurance;sourceSha:string;validatorSha256:string;machineId:string;bootId:string;rootIdentity:H1ObjectIdentity;catalog:readonly H1CatalogEntry[];definitions:Readonly<Record<typeof definitionKeys[number],string>&{pythonGetpath?:string}>;mounts:readonly H1MountRow[];hostRelease:H1HostRelease;syntheticBootId:string}>;
function uuid(v:unknown):string{const s=text(v);need(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s));return s;}
/** DATA only. Expected rows in an independently installed record are not run facts. */
export function h1StagedSubjectData(v:unknown):H1StagedSubject{
  need(v!==null && typeof v==="object" && !types.isProxy(v));const version=Object.getOwnPropertyDescriptor(v,"schemaVersion");need(version && Object.hasOwn(version,"value") && (version.value===1 || version.value===2));const v2=version.value===2;
  const d=record(v,["schemaVersion","sourceSha","validatorSha256","machineId","bootId","rootIdentity","catalog","definitions","mounts","hostRelease","syntheticBootId",...(v2?["assurance","distroFactsSha256"]:[])]);if(v2)need(d.assurance===H1DistroAssurance.SignedPublisher);
  need(d.definitions!==null && typeof d.definitions==="object" && !types.isProxy(d.definitions));const getpath=Object.getOwnPropertyDescriptor(d.definitions,"pythonGetpath");need(!getpath || Object.hasOwn(getpath,"value"));const definitions=record(d.definitions,[...definitionKeys,...(getpath?["pythonGetpath"]:[])]),parsedDefinitions=Object.freeze({mountAll:hex(definitions.mountAll,64),mountSysfs:hex(definitions.mountSysfs,64),mountCgroups:hex(definitions.mountCgroups,64),devSetup:hex(definitions.devSetup,64),inaccessibleNodes:hex(definitions.inaccessibleNodes,64),notify:hex(definitions.notify,64),hostReleaseTransform:hex(definitions.hostReleaseTransform,64),...(getpath?{pythonGetpath:hex(definitions.pythonGetpath,64)}:{})});
  if(v2)need(getpath);
  const catalog=list(d.catalog).map(catalogEntry),byPath=new Map(catalog.map(e=>[e.path,e]));need(catalog.length>0 && byPath.size===catalog.length);
  for(const entry of catalog){const parent=posix.dirname(entry.path);if(parent!==".")need(byPath.get(parent)?.kind===H1CatalogKind.Directory);if(entry.kind===H1CatalogKind.Alias){const visited=new Set<string>();let current=entry;while(current.kind===H1CatalogKind.Alias){need(!visited.has(current.path));visited.add(current.path);const dest=posix.resolve("/",posix.dirname(current.path),current.target).slice(1),next=byPath.get(dest);need(next);current=next;}}}
  const mounts=list(d.mounts).map(mountRow);need(mounts.length>0 && mounts.some(m=>m.path==="/") && new Set(mounts.map(m=>m.path)).size===mounts.length);
  const bootId=uuid(d.bootId),syntheticBootId=uuid(d.syntheticBootId);need(bootId!==syntheticBootId);
  const rootIdentity=identityData(d.rootIdentity);need(rootIdentity.uid==="0" && rootIdentity.gid==="0" && (BigInt(rootIdentity.mode)&0o022n)===0n);
  return Object.freeze({schemaVersion:v2?2:1,...(v2?{assurance:H1DistroAssurance.SignedPublisher,distroFactsSha256:hex(d.distroFactsSha256,64)}:{}),sourceSha:hex(d.sourceSha,40),validatorSha256:hex(d.validatorSha256,64),machineId:hex(d.machineId,32),bootId,rootIdentity,catalog:Object.freeze(catalog),definitions:parsedDefinitions,mounts:Object.freeze(mounts),hostRelease:hostRelease(d.hostRelease),syntheticBootId});
}
/** Equality of already captured DATA; never substitutes for owned namespace reads. */
export function h1StagedManifestData(expected:H1StagedSubject,actual:unknown):void{const d=record(actual,["mounts","hostRelease","syntheticBootId"]);same(list(d.mounts).map(mountRow),expected.mounts);same(hostRelease(d.hostRelease),expected.hostRelease);need(uuid(d.syntheticBootId)===expected.syntheticBootId && d.syntheticBootId!==expected.bootId);}
/** Linux retained physical DATA facts only; returns neither descriptors nor authority. */
export function retainH1StagedCatalogData(root:string,subject:H1StagedSubject,deadline:number):Readonly<{revalidate():void;descriptors():readonly number[];fileDescriptor(path:string):number;close():void}>{
  subject=h1StagedSubjectData(subject);need(process.platform==="linux" && root!=="/" && root.length<=4096 && root.startsWith("/") && posix.normalize(root)===root && Number.isFinite(deadline));
  let closed=false,total=0;const held=new Map<string,{fd:number;identity:H1ObjectIdentity;entry:H1CatalogEntry|undefined}>(),ancestry:{fd:number;parent:number|undefined;name:string;identity:H1ObjectIdentity}[]=[];
  const tick=()=>need(!closed && performance.now()<deadline);
  function finish(){if(closed)return;closed=true;for(const row of held.values())closeSync(row.fd);for(const row of ancestry.reverse())closeSync(row.fd);}
  function openChild(parent:number,name:string,directory:boolean):number{tick();return openSync(`/proc/self/fd/${parent}/${name}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(directory?constants.O_DIRECTORY:0));}
  function readHash(fd:number):string{const before=fstatSync(fd,{bigint:true});need(before.isFile() && before.nlink===1n && before.size<=BigInt(limits.fileBytes));const h=createHash("sha256"),buffer=Buffer.alloc(65536);let offset=0;while(true){tick();const n=readSync(fd,buffer,0,buffer.length,offset);tick();if(n===0)break;offset+=n;need(offset<=limits.fileBytes);h.update(buffer.subarray(0,n));}need(BigInt(offset)===before.size);same(actualIdentity(fstatSync(fd,{bigint:true})),actualIdentity(before));tick();return h.digest("hex");}
  function validate(){try{tick();for(const row of ancestry){same(actualIdentity(fstatSync(row.fd,{bigint:true})),row.identity);const fresh=row.parent===undefined?openSync("/",constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY):openChild(row.parent,row.name,true);try{same(actualIdentity(fstatSync(fresh,{bigint:true})),row.identity);}finally{closeSync(fresh);}tick();}for(const [p,row] of held){same(actualIdentity(fstatSync(row.fd,{bigint:true})),row.identity);const isRoot=p==="",parent=isRoot?ancestry[ancestry.length-1]?.fd:held.get(posix.dirname(p)==="."?"":posix.dirname(p))?.fd;need(parent!==undefined);const fresh=openChild(parent,isRoot?posix.basename(root):posix.basename(p),isRoot || row.entry?.kind===H1CatalogKind.Directory);try{same(actualIdentity(fstatSync(fresh,{bigint:true})),row.identity);if(row.entry?.kind===H1CatalogKind.File)need(readHash(fresh)===row.entry.sha256);}finally{closeSync(fresh);}tick();}
    for(const entry of subject.catalog)if(entry.kind===H1CatalogKind.Alias){const parent=held.get(posix.dirname(entry.path)==="."?"":posix.dirname(entry.path));need(parent);const p=`/proc/self/fd/${parent.fd}/${posix.basename(entry.path)}`;same(actualIdentity(lstatSync(p,{bigint:true})),entry.identity);const target=readlinkSync(p,{encoding:"buffer"});need(BigInt(target.length)===BigInt(entry.identity.size) && physicalUtf8(target)===entry.target && target.equals(Buffer.from(entry.target,"utf8")));same(actualIdentity(lstatSync(p,{bigint:true})),entry.identity);tick();}
    const actual:string[]=[];for(const [p,row] of held)if(p==="" || row.entry?.kind===H1CatalogKind.Directory){tick();for(const bytes of readdirSync(`/proc/self/fd/${row.fd}`,{encoding:"buffer"})){const name=physicalUtf8(bytes);actual.push(p?p+"/"+name:name);need(actual.length<=limits.entries);}tick();}same(actual.sort(),subject.catalog.map(e=>e.path).sort());tick();}catch(error){finish();throw error;}}
  try{let parent=openSync("/",constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);ancestry.push({fd:parent,parent:undefined,name:"/",identity:actualIdentity(fstatSync(parent,{bigint:true}))});for(const name of root.slice(1).split("/").slice(0,-1)){const next=openChild(parent,name,true);const s=fstatSync(next,{bigint:true});ancestry.push({fd:next,parent,name,identity:actualIdentity(s)});need(s.uid===0n && s.gid===0n && (s.mode&0o022n)===0n);parent=next;}
    const fd=openChild(parent,posix.basename(root),true);held.set("",{fd,identity:subject.rootIdentity,entry:undefined});same(actualIdentity(fstatSync(fd,{bigint:true})),subject.rootIdentity);
    for(const entry of [...subject.catalog].sort((a,b)=>a.path.split("/").length-b.path.split("/").length)){if(entry.kind===H1CatalogKind.Alias)continue;const directory=held.get(posix.dirname(entry.path)==="."?"":posix.dirname(entry.path));need(directory);const child=openChild(directory.fd,posix.basename(entry.path),entry.kind===H1CatalogKind.Directory);held.set(entry.path,{fd:child,identity:entry.identity,entry});const s=fstatSync(child,{bigint:true});need(entry.kind===H1CatalogKind.Directory?s.isDirectory():s.isFile());same(actualIdentity(s),entry.identity);if(entry.kind===H1CatalogKind.File){total+=Number(s.size);need(total<=limits.totalBytes && readHash(child)===entry.sha256);}}
    validate();return Object.freeze({revalidate:validate,fileDescriptor(path:string){try{tick();const row=held.get(path);need(row?.entry?.kind===H1CatalogKind.File);const parent=held.get(posix.dirname(path)==="."?"":posix.dirname(path));need(parent);same(actualIdentity(fstatSync(row.fd,{bigint:true})),row.identity);same(actualIdentity(lstatSync(`/proc/self/fd/${parent.fd}/${posix.basename(path)}`,{bigint:true})),row.identity);need(readHash(row.fd)===row.entry.sha256);tick();return row.fd;}catch(error){finish();throw error;}},descriptors(){tick();return Object.freeze([...held.values()].map(row=>row.fd).concat(ancestry.map(row=>row.fd)));},close:finish});
  }catch(error){finish();throw error;}
}
/** Actual constructor qualification remains Held; candidate facts never release effects. */
export function requireQualifiedH1StagedConstructor():never{throw new Error("TEST H1 staged Held: "+H1StagedUnsupportedReason.ConstructorRows);}

/** Produced only by the source-pinned original fixture, then independently
 * joined against the original native parent's selected guest and proc objects. */
export interface H1StagedObserverPrepared {
  readonly program:string;
  readonly config:string;
  readonly anchors:readonly number[];
  readonly queryAnchors:readonly [number,number,number];
  revalidate():void;
  revalidateSources():void;
  descriptors():readonly number[];
  close():void;
}
export enum H1StagedSlotState {Unconstructed="unconstructed",Constructing="constructing",Constructed="constructed",Qualified="qualified",Closed="closed"}
export enum H1StagedActorRole {Monitor="h1_staged_monitor",Setup="h1_staged_setup",Worker="h1_staged_worker",Query="h1_staged_query",Systemctl="h1_staged_systemctl"}
/** No HOST Python/import source, cache, caller program or environment selection.
 * The script itself is retained original SOURCE; aliases are generated solely
 * from the original native parent's nine retained descriptor objects. */
export const h1StagedObserverBootstrap=String.raw`
import os,sys,json,stat,select,time,fcntl
assert os.getuid()==0 and sys.platform=='linux'
print('python_bootstrap:'+json.dumps({'executable':sys.executable,'prefix':sys.prefix,'execPrefix':sys.exec_prefix,'path':sys.path,'isolated':sys.flags.isolated,'noSite':sys.flags.no_site,'dontWriteBytecode':sys.dont_write_bytecode,'cache':sys.pycache_prefix,'origArgv':sys.orig_argv[:7],'modules':sorted([[name,getattr(getattr(module,'__spec__',None),'origin',None)] for name,module in sys.modules.items() if name!='__main__'])},separators=(',',':')),flush=True)
p=json.loads(sys.argv[1]); assert set(p)=={'parentPid','parentTicks','anchors','anchorObjects','queryAnchors','queryObjects','program','config','bootId','guestBootId'}
assert len(p['anchors'])==len(p['anchorObjects'])==9 and len(p['queryAnchors'])==len(p['queryObjects'])==3
s=open('/proc/'+str(p['parentPid'])+'/stat').read();assert s[s.rfind(')')+2:].split()[19]==p['parentTicks']
opened=[]
for source,obj in zip(p['anchors']+p['queryAnchors'],p['anchorObjects']+p['queryObjects']):
 fd=os.open('/proc/'+str(p['parentPid'])+'/fd/'+str(source),os.O_RDONLY|os.O_CLOEXEC|os.O_NONBLOCK)
 a=os.fstat(fd);assert [str(a.st_dev),str(a.st_ino),str(a.st_mode)]==obj;opened.append(fd)
# First duplicate above all target slots. Opening successive objects directly
# into slots3..11 could destroy a still-needed original descriptor.
held=[fcntl.fcntl(fd,fcntl.F_DUPFD_CLOEXEC,16) for fd in opened]
for slot,fd in zip(list(range(3,12))+[13,14,15],held):os.dup2(fd,slot,inheritable=False)
for fd in set(opened+held):
 if fd not in list(range(3,12))+[13,14,15]:os.close(fd)
s=open('/proc/self/stat').read();parts=s[s.rfind(')')+2:].split()
print('constructor:'+json.dumps({'pid':os.getpid(),'birth':parts[19],'ppid':os.getppid()},separators=(',',':')),flush=True)
ready,_,_=select.select([0],[],[],2);assert ready
assert os.read(0,1)==b'1'
# Native checks actual proc/root/ns/catalog before releasing this one byte.
# Original guest activation boot evidence is retained in the request. The host
# boot stays in native original custody; tool synthetic /proc is separate.
c=json.loads(p['config']);assert c['request']['bootId']==p['guestBootId']
sys.argv=['/usr/bin/python3.12',p['config']]
exec(compile(p['program'],'<original-source-H1>','exec'),{'__name__':'__main__'})
`;
