import { managedSystemdRunExecutable } from "./launch.mjs";
/** One exceptional ROOT TEST profile. No ordinary profile or caller may select
 * capabilities, roots or commands. Protected reviews are independently issued. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants, closeSync, fsyncSync, mkdirSync, writeFileSync, fstatSync, statSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, statfsSync, type Stats } from "node:fs";
import { basename, dirname } from "node:path";
import { types } from "node:util";
import { pathToFileURL } from "node:url";
export const fullNativeJob="TEST-dependency-full-native-20261007-r1";
export const fullNativeInputBase="/srv/workers/jobs/"+fullNativeJob+"/input";
export const fullNativeTmpDir="/srv/workers/jobs/"+fullNativeJob+"/tmp";
export const fullNativePublicDownloadBase="/srv/workers/jobs/"+fullNativeJob+"/public-codex-download";
export const fullNativePublicCapsule="/srv/workers/jobs/"+fullNativeJob+"/public-codex-input/@openai";
export const fullNativeBirthRoot="/srv/workers/jobs/"+fullNativeJob+"/full-launch-birth";
export const fullNativeLiveRoot="/srv/workers/jobs/"+fullNativeJob+"/full-parent-live";
export const fullNativeGuestLiveRoot="/var/lib/subscription-runtime-full-parent-live";
export const fullNativeOsBase="/srv/workers/jobs/TEST-dependency-full-native-20261007-r1/os-TEST";
/** DATA path contract only; physical root custody is checked separately. */
export function fullNativeGuestRoot(id:unknown,root:unknown):boolean {
  return typeof id==="string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) && root===fullNativeOsBase+"/"+id+"/root";
}
const bootstrapNode="/opt/nodejs/node-v24.21.0-linux-x64/bin/node";
const integration="/opt/subscription-runtime", reviewRoot="/srv/worker-state/protected-storage-test/dependency-full-native-activation";
const reviewPath=reviewRoot+"/review.json", sourceBase="28511fec3a4796db3b86ac57f376d64c4b9b8d29";
const hash=(value: string|Buffer)=>createHash("sha256").update(value).digest("hex");
export const fullNativeUnit="subscription-job-"+hash(fullNativeJob)+".service";
const fullNativeControlGroup="/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/"+fullNativeUnit;
const ledger="/root/.local/state/subscription-runtime/host-jobs/"+fullNativeUnit+".json";
export const fullNativeLimits=Object.freeze({runtimeSeconds:1800,stopSeconds:180,memoryMiB:2048,tasksMax:128,cpuPercent:100});
export enum FullParentPhase {Starting="starting",Started="started"}
enum FullKernelState {Active="active",Activating="activating",Running="running",Loaded="loaded"}
enum FullOperation {Start="start",Job="job"}
function refuse():never{throw new Error("TEST full managed ingress Held");}
function check(value:unknown):asserts value {if(!value)refuse();}
const digest=(v:unknown):v is string=>typeof v==="string" && /^[a-f0-9]{64}$/.test(v);
function requireDigest(value:unknown):string{check(digest(value));return value;}
const readFd=(fd:number)=>readFileSync(`/proc/self/fd/${fd}`);
const sha=(v:unknown):v is string=>typeof v==="string" && /^[a-f0-9]{40}$/.test(v);
/** DATA parser only. Original authority always adds physical and kernel joins. */
export function fullData(value:unknown,keys:readonly string[]):Record<string,unknown> {
  check(value!==null && typeof value==="object" && !types.isProxy(value) && Object.getPrototypeOf(value)===Object.prototype);
  const descriptors=Object.getOwnPropertyDescriptors(value),own=Reflect.ownKeys(descriptors);
  check(own.length===keys.length && own.every(k=>typeof k==="string" && keys.includes(k)));
  const result:Record<string,unknown>={};
  for(const key of keys){const d=descriptors[key];check(d && Object.hasOwn(d,"value") && d.enumerable);result[key]=d.value;}
  return result;
}
/** Select malformed fixed-job candidates for REFUSAL, never legacy fallback. */
export function fullNativeIntended(value:unknown):boolean {
  if(value===null || typeof value!=="object")return false;
  check(!types.isProxy(value));
  const descriptors=Object.getOwnPropertyDescriptors(value);check(Object.values(descriptors).every(d=>Object.hasOwn(d,"value")));
  const d=Object.getOwnPropertyDescriptor(value,"jobId");return !!d && Object.hasOwn(d,"value") && d.value===fullNativeJob;
}
enum RootContext {Launcher="Launcher",Parent="Parent"}
function initialRoot(context:RootContext){
  const limits=readFileSync("/proc/self/limits","utf8");check(Buffer.byteLength(limits)<=16384);
  const rows=[...limits.matchAll(/^Max open files\s+([0-9]+)\s+([0-9]+)\s+files$/gm)];
  check(rows.length===1 && BigInt(rows[0]![1]!)>=65536n && BigInt(rows[0]![2]!)>=65536n);
  check(process.platform==="linux" && process.arch==="x64" && process.getuid?.()===0 && process.geteuid?.()===0);
  check(readFileSync("/proc/self/uid_map","utf8").trim().split(/\s+/).join(" ")==="0 0 4294967295");
  for(const ns of ["user","pid","mnt","cgroup","net","uts","ipc"]){if(ns==="mnt" && context===RootContext.Parent)continue;check(readlinkSync(`/proc/self/ns/${ns}`)===readlinkSync(`/proc/1/ns/${ns}`));}
  check(readlinkSync("/proc/self/ns/user")==="user:[4026531837]" && readlinkSync("/proc/self/ns/pid")==="pid:[4026531836]");
  check(/^NSpid:\s+1$/m.test(readFileSync("/proc/1/status","utf8")));
}
const identity=(s:Stats)=>[s.dev,s.ino,s.uid,s.gid,s.mode,...(s.isDirectory()?[]:[s.nlink,s.size,s.mtimeMs,s.ctimeMs])].map(String).join(":");
const sharedAncestor="/srv/worker-state";
function ancestorMountId(fd:number):string {
  const raw=readFileSync(`/proc/self/fdinfo/${fd}`,"utf8");check(Buffer.byteLength(raw)<=4096);
  const rows=[...raw.matchAll(/^mnt_id:\s+([1-9][0-9]{0,19})$/gm)],id=rows[0]?.[1];check(rows.length===1 && id);return id;
}
/** One measured existing directory, never an alternate owner policy for roots/leaves. */
function assertSharedAncestor(fd:number,parent:number) {
  const held=fstatSync(fd),named=lstatSync(sharedAncestor),srv=fstatSync(parent);
  check(held.isDirectory() && held.uid===0 && held.gid===987 && (held.mode&0o7777)===0o751
    && !(held.mode&0o022) && held.dev===2306 && held.ino===13631491 && held.dev===srv.dev
    && !named.isSymbolicLink() && identity(named)===identity(held) && realpathSync(`/proc/self/fd/${fd}`)===sharedAncestor);
  const fresh=openSync(sharedAncestor,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|constants.O_DIRECTORY);
  try{check(identity(fstatSync(fresh))===identity(held) && ancestorMountId(fresh)===ancestorMountId(fd)
    && ancestorMountId(fd)===ancestorMountId(parent));}finally{closeSync(fresh);}
}
// Standalone installed launcher cannot import the public runtime's src tree.
// Query only a retained FD's Linux magiclink, with native object brackets.
function retainedFilesystemType(fd:number):bigint {
  check(Number.isSafeInteger(fd) && fd>=0);const before=fstatSync(fd,{bigint:true}),path=`/proc/self/fd/${fd}`;
  const matches=(stat:typeof before)=>stat.dev===before.dev && stat.ino===before.ino && stat.mode===before.mode
    && stat.uid===before.uid && stat.gid===before.gid && stat.rdev===before.rdev;
  check(matches(statSync(path,{bigint:true})));const type=statfsSync(path,{bigint:true}).type;
  check(matches(fstatSync(fd,{bigint:true})) && matches(statSync(path,{bigint:true})));return type;
}
class Pins {
  private readonly held=new Map<string,{fd:number;identity:string;sha256:string|null}>();private closed=false;private readonly namespaces:number[]=[];
  mountNamespace(){const fd=openSync("/proc/self/ns/mnt",constants.O_RDONLY);this.namespaces.push(fd);return fd;}
  hold(path:string,directory=false,mode?:number):number{
    check(!this.closed);const found=this.held.get(path);if(found){
      if(path===sharedAncestor){check(directory);const parent=this.held.get("/srv");check(parent);assertSharedAncestor(found.fd,parent.fd);}
      if(mode!==undefined)check((fstatSync(found.fd).mode&0o7777)===mode);return found.fd;}
    const parent=path==="/"?null:this.hold(dirname(path),true);
    const fd=openSync(parent===null?"/":`/proc/self/fd/${parent}/${basename(path)}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(directory?constants.O_DIRECTORY:0));
    try{const s=fstatSync(fd),shared=directory && path===sharedAncestor;
      if(shared){check(parent!==null);assertSharedAncestor(fd,parent);}
      check(s.uid===0 && (s.gid===0 || shared) && !(s.mode&0o022) && (directory?s.isDirectory():s.isFile() && s.nlink===1));
      if(mode!==undefined)check((s.mode&0o7777)===mode);
      check(directory || s.size<=128*1024*1024);
      this.held.set(path,{fd,identity:identity(s),sha256:directory?null:hash(readFd(fd))});return fd;
    }catch{closeSync(fd);refuse();}
  }
  publicFile(path:string,expected:string){check(digest(expected));const fd=this.hold(path);check(this.held.get(path)?.sha256===expected);return fd;}
  json(path:string,maximum:number){const fd=this.hold(path,false,0o600);check(fstatSync(fd).size<=maximum);const bytes=readFd(fd),v:unknown=JSON.parse(bytes.toString("utf8"));check(bytes.equals(Buffer.from(JSON.stringify(v)+"\n")));return v;}
  validate(){check(!this.closed);for(const [path,e] of this.held){const named=lstatSync(path),held=fstatSync(e.fd);check(!named.isSymbolicLink() && identity(named)===e.identity && identity(held)===e.identity);
    if(path===sharedAncestor){const parent=this.held.get("/srv");check(parent);assertSharedAncestor(e.fd,parent.fd);}
    const fresh=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(held.isDirectory()?constants.O_DIRECTORY:0));
    try{check(identity(fstatSync(fresh))===e.identity && ancestorMountId(fresh)===ancestorMountId(e.fd));}finally{closeSync(fresh);}
    if(e.sha256)check(hash(readFd(e.fd))===e.sha256);}}
  descriptors(){check(!this.closed);return [...this.held.values()].map(entry=>entry.fd).concat(this.namespaces);}
  sourceSnapshot(){this.validate();return hash(JSON.stringify([...this.held.entries()].filter(([,entry])=>entry.sha256!==null).map(([path,entry])=>({path,identity:entry.identity,sha256:entry.sha256})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)));}
  close(){if(this.closed)return;this.closed=true;for(const e of [...this.held.values()].reverse())closeSync(e.fd);this.held.clear();for(const fd of this.namespaces)closeSync(fd);this.namespaces.length=0;}
}
/** A catalog is independently reviewed PUBLIC installation data, not path input.
 * It excludes protected control/auth/credentials before any leaf read. */
export function fullPublicRelative(value:unknown):value is string {
  return typeof value==="string" && value.length<=240 && (value==="src/worker-codex/hosted-full-backing-proc.js" || /^(?:dist|node_modules|packages|scripts|host-integration)\/[A-Za-z0-9_@+./-]+$/.test(value))
    && !value.split("/").some(p=>p==="." || p===".." || /^(?:auth\.json(?:[.-].*)?|credentials?\.json(?:[.-].*)?|.*\.pem|\.env.*)$/i.test(p))
    && /\.(?:js|mjs|cjs|json|node)$/.test(value);
}
function acquire(context:RootContext=RootContext.Launcher){
  initialRoot(context);const pins=new Pins();
  try{
    pins.hold(reviewRoot,true,0o700);
    const r=fullData(pins.json(reviewPath,32768),["schemaVersion","sourceBaseSha","sourceSha","sourceTree","machineId","bootId","nodeSha256","launcherSha256","moduleSha256","parentSha256","catalogSha256","outerReviewSha256","publicReviewSha256","accountName","reviewReference","hostTools","systemdVersion","installedModules"]);
    check(r.schemaVersion===1 && r.sourceBaseSha===sourceBase && sha(r.sourceSha) && sha(r.sourceTree));
    check(typeof r.machineId==="string" && /^[a-f0-9]{32}$/.test(r.machineId) && typeof r.bootId==="string" && /^[a-f0-9-]{36}$/.test(r.bootId));
    check(r.accountName==="account-u" && typeof r.reviewReference==="string" && /^[A-Za-z0-9][A-Za-z0-9_.:/#-]{0,255}$/.test(r.reviewReference));
    for(const key of ["nodeSha256","launcherSha256","moduleSha256","parentSha256","catalogSha256","outerReviewSha256","publicReviewSha256"])check(digest(r[key]));
    check(typeof r.systemdVersion==="string" && /^systemd 255 \(255\.4[A-Za-z0-9.+~-]{0,64}\)$/.test(r.systemdVersion));
    const sourceSha=r.sourceSha,root=fullNativeInputBase+"/"+sourceSha,source=root+"/source",node=root+"/toolchain/bin/node";
    pins.hold("/srv/workers/jobs/"+fullNativeJob,true,0o700);
    pins.hold(fullNativeTmpDir,true,0o700);
    pins.hold(fullNativeInputBase,true,0o700);
    pins.hold(root,true,0o700);
    const modules=fullData(r.installedModules,["manager","contract","endpoint","storagePolicy","profiles","payloadGuard"]);
    for(const [path,key] of [["host-jobs/manager.mjs","manager"],["host-jobs/contract.mjs","contract"],["host-jobs/endpoint.mjs","endpoint"],["host-jobs/storage-policy.mjs","storagePolicy"],["managed-launcher/profiles.mjs","profiles"],["managed-launcher/payload-guard.mjs","payloadGuard"]] as const)pins.publicFile(integration+"/"+path,requireDigest(modules[key]));
    const tools=fullData(r.hostTools,["git","systemctl","systemdRun","lsns","systemdPid1","bootstrapNode","systemdNspawn","systemdNspawnClosure"]);
    for(const [path,key] of [["/usr/bin/git","git"],["/usr/bin/systemctl","systemctl"],[managedSystemdRunExecutable,"systemdRun"],["/usr/bin/lsns","lsns"],["/usr/lib/systemd/systemd","systemdPid1"],[bootstrapNode,"bootstrapNode"]] as const)pins.publicFile(path,requireDigest(tools[key]));
    // HOST execution uses the HOST loader/DSOs. Guest signed package hashes
    // cannot prove this separately selected original installation closure.
    const monitorSources:{path:string;sha256:string;fd:number}[]=[];
    monitorSources.push({path:"/usr/bin/systemd-nspawn",sha256:requireDigest(tools.systemdNspawn),
      fd:pins.publicFile("/usr/bin/systemd-nspawn",requireDigest(tools.systemdNspawn))});
    check(Array.isArray(tools.systemdNspawnClosure) && tools.systemdNspawnClosure.length>0 && tools.systemdNspawnClosure.length<=32);
    let previousMonitorSource="";
    for(const entry of tools.systemdNspawnClosure){
      const row=fullData(entry,["path","sha256"]);
      check(typeof row.path==="string" && /^\/usr\/lib\/[A-Za-z0-9_.+/-]+$/.test(row.path) &&
        !row.path.split("/").some(part=>part==="." || part==="..") && row.path>previousMonitorSource);
      previousMonitorSource=row.path;const expected=requireDigest(row.sha256);
      monitorSources.push({path:row.path,sha256:expected,fd:pins.publicFile(row.path,expected)});
    }
    check(tools.bootstrapNode==="7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c" && tools.lsns==="c9fe8adcfe480c47a052adcde50002c78e8fadd4d124bc337893a0f9a9e8cf3b" && tools.systemdPid1==="b472aadf808bef87c0eb203056a77cb64bd268b71b756306013a53de68a94173");
    const systemdVersion=spawnSync("/usr/bin/systemctl",["--version"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:4096});
    check(!systemdVersion.error && systemdVersion.status===0 && systemdVersion.signal===null && systemdVersion.stdout.split("\n")[0]===r.systemdVersion);
    pins.publicFile(node,requireDigest(r.nodeSha256));pins.hold(node,false,0o755);pins.publicFile(integration+"/managed-launcher/launch.mjs",requireDigest(r.launcherSha256));
    pins.publicFile(integration+"/managed-launcher/dependency-full-native-TEST.mjs",requireDigest(r.moduleSha256));
    pins.publicFile(source+"/host-integration/managed-launcher/dependency-full-native-TEST.js",requireDigest(r.moduleSha256));
    const parent=source+"/host-integration/managed-launcher/dependency-full-native-parent-TEST.js";pins.publicFile(parent,requireDigest(r.parentSha256));
    pins.publicFile(source+"/package.json","68a91f14118d7b4dc06b02dad1835bc1db19760e5329faff1f4805cbd1508b29");
    const head=pins.hold(source+"/.git/HEAD");check(readFd(head).equals(Buffer.from(sourceSha+"\n")));
    const catalogPath=reviewRoot+"/public-installation.json";pins.publicFile(catalogPath,requireDigest(r.catalogSha256));
    const catalog=fullData(pins.json(catalogPath,2*1024*1024),["schemaVersion","sourceSha","sourceTree","files"]);
    check(catalog.schemaVersion===1 && catalog.sourceSha===sourceSha && catalog.sourceTree===r.sourceTree && Array.isArray(catalog.files) && catalog.files.length>0 && catalog.files.length<=8192);
    // Complete public runtime closure: unknown regular runtime leaves and all
    // links are refused by metadata before any catalogue body is opened.
    const expected=new Set<string>();let directories=0,leaves=0;
    function census(path:string,relative:string){
      check(++directories<=16384);const fd=pins.hold(path,true);
      const names=readdirSync(`/proc/self/fd/${fd}`);check(names.length<=8192);
      for(const name of names){check(/^[A-Za-z0-9_@+.-]+$/.test(name));const child=path+"/"+name,rel=relative+"/"+name,stat=lstatSync(child);check(!stat.isSymbolicLink());
        if(stat.isDirectory())census(child,rel);else{check(stat.isFile() && ++leaves<=65536);if(/\.(?:js|mjs|cjs|json|node)$/.test(name)){check(fullPublicRelative(rel));expected.add(rel);check(expected.size<=8192);}}
      }
    }
    for(const top of ["dist","node_modules","packages","scripts","host-integration"])census(source+"/"+top,top);
    // One emitted external import, not a blanket src tree permission.
    const procModule="src/worker-codex/hosted-full-backing-proc.js";
    const procModuleStat=lstatSync(source+"/"+procModule);
    check(procModuleStat.isFile() && !procModuleStat.isSymbolicLink());expected.add(procModule);
    check(catalog.files.length===expected.size);
    let previous="",total=0;const paths=new Set<string>();
    for(const entry of catalog.files){const row=fullData(entry,["path","sha256"]);check(fullPublicRelative(row.path) && digest(row.sha256) && row.path>previous && expected.has(row.path));previous=row.path;
      const fd=pins.publicFile(source+"/"+row.path,row.sha256);total+=fstatSync(fd).size;check(total<=512*1024*1024);paths.add(row.path);}
    for(const path of ["scripts/dependency-retention-os-test/current-full-outer.js","scripts/dependency-retention-os-test/current-full-guest.js","dist/worker-codex/codex-goal-cli.js"])check(paths.has(path));
    for(const [path,key] of [["/run/TEST-full-outer-review/input.json","outerReviewSha256"],["/run/TEST-real-codex-public-review/input.json","publicReviewSha256"]] as const){pins.hold(dirname(path),true,0o700);pins.publicFile(path,requireDigest(r[key]));pins.hold(path,false,0o600);}
    pins.hold("/srv/worker-state/account-pools/live-codex-auth/account-u",true);
    pins.hold("/srv/workers/jobs/"+fullNativeJob,true,0o700);pins.hold("/srv/workers/jobs/"+fullNativeJob+"/tmp",true,0o700);pins.hold(fullNativeOsBase,true,0o700);
    const git=spawnSync("/usr/bin/git",["-C",source,"rev-parse","--verify","HEAD^{tree}"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"},encoding:"utf8",timeout:5000,maxBuffer:4096});
    check(!git.error && git.status===0 && git.signal===null && git.stdout.trim()===r.sourceTree);
    const tuple=Object.freeze({sourceSha,source,root,node,parent,machineId:r.machineId,bootId:r.bootId,accountName:r.accountName});
    const namespace=readlinkSync("/proc/self/ns/mnt"),namespaceFd=pins.mountNamespace();
    if(context===RootContext.Parent)check(namespace!==readlinkSync("/proc/1/ns/mnt"));
    const validate=()=>{initialRoot(context);check(readlinkSync("/proc/self/ns/mnt")===namespace && readlinkSync(`/proc/self/fd/${namespaceFd}`)===namespace);pins.validate();check(readFileSync("/etc/machine-id","utf8").trim()===tuple.machineId && readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()===tuple.bootId);};
    validate();return {pins,tuple,validate,monitorSources};
  }catch{pins.close();refuse();}
}
function fingerprint(machine:string,argv:readonly string[]){return hash(JSON.stringify([fullNativeJob,machine,argv,1800,180,2048,128,100]));}
function argvFor(c:ReturnType<typeof acquire>){return Object.freeze([c.tuple.node,c.tuple.parent]);}
function record(c:ReturnType<typeof acquire>,live:boolean){
  // Acknowledgement legitimately replaces this leaf. Each read retains fresh FD
  // and joins protected ancestry; never pin stale Starting inode as live proof.
  const fresh=new Pins();
  try{fresh.hold(dirname(ledger),true,0o700);const fd=fresh.hold(ledger,false,0o600);check(fstatSync(fd).size<=4096);
    const value:unknown=JSON.parse(readFd(fd).toString("utf8"));const r=fullData(value,["jobId","unit","manager","machineId","fingerprint","phase","createdAt"]);
    check(r.jobId===fullNativeJob && r.unit===fullNativeUnit && r.manager==="system" && r.machineId===c.tuple.machineId && r.fingerprint===fingerprint(c.tuple.machineId,argvFor(c)));
    check(r.phase===FullParentPhase.Starting || (live && r.phase===FullParentPhase.Started));check(typeof r.createdAt==="number" && Number.isSafeInteger(r.createdAt) && r.createdAt>0);fresh.validate();return r;
  }finally{fresh.close();}
}
export function fullManagedStartRequest(){const c=acquire();try{recordAbsent();return Object.freeze({operation:FullOperation.Start,jobId:fullNativeJob,machineId:c.tuple.machineId,argv:argvFor(c),...fullNativeLimits});}finally{c.pins.close();}}
function recordAbsent(){try{lstatSync(ledger);refuse();}catch(e){if(!(e instanceof Error && "code" in e && e.code==="ENOENT"))refuse();}}
/** Public DATA snapshot, never original admission or launch permission. */
export function captureFullNativeRequest(value:unknown){
  const r=fullData(value,["operation","unit","payload","jobId","fingerprint","limits"]);
  const limits=fullData(r.limits,Object.keys(fullNativeLimits)),payload=Object.freeze(fullDataArray(r.payload));
  check(r.operation===FullOperation.Job && r.jobId===fullNativeJob && r.unit===fullNativeUnit && digest(r.fingerprint));
  for(const key of Object.keys(fullNativeLimits) as (keyof typeof fullNativeLimits)[])check(limits[key]===fullNativeLimits[key]);
  return Object.freeze({fingerprint:r.fingerprint,payload});
}
export function retainFullNativeLaunch(request:unknown){
  const data=captureFullNativeRequest(request),c=acquire();let closed=false,prepared=false,published=false,beforeBytes:Buffer|undefined;
  try{
    check(process.argv.length===4 && process.argv[0]===bootstrapNode && process.argv[1]===integration+"/managed-launcher/launch.mjs" && process.argv[2]==="job");
    check(readlinkSync("/proc/self/exe")===bootstrapNode && readFileSync("/proc/self/cmdline").equals(Buffer.from([...process.argv,""].join("\u0000"))));
    check(JSON.stringify(JSON.parse(process.argv[3]!))===JSON.stringify(request));
    check(data.fingerprint===fingerprint(c.tuple.machineId,argvFor(c)) && data.payload[0]===c.tuple.node && data.payload[1]===c.tuple.parent);
    const revalidate=()=>{try{check(!closed);c.validate();record(c,false);preflightCapacity(c.pins.hold(fullNativeOsBase,true,0o700));c.validate();}catch{refuse();}};revalidate();
    function writeBirth(name:"before.json"|"after.json",value:unknown){
      const directory=c.pins.hold(fullNativeBirthRoot,true,0o700),bytes=Buffer.from(JSON.stringify(value)+"\n");
      const fd=openSync(`/proc/self/fd/${directory}/${name}`,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}fsyncSync(directory);return bytes;
    }
    return Object.freeze({node:c.tuple.node,parent:c.tuple.parent,source:c.tuple.source,sourceSha:c.tuple.sourceSha,fingerprint:data.fingerprint,revalidate,
      beforeSubmit(){
        revalidate();check(!prepared);const shown=spawnSync("/usr/bin/systemctl",["show",fullNativeUnit,"--property=LoadState","--value"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:256});
        check(!shown.error && (shown.status===0 || shown.status===4) && shown.signal===null && shown.stdout.trim()==="not-found");
        const job=c.pins.hold("/srv/workers/jobs/"+fullNativeJob,true,0o700);
        mkdirSync(`/proc/self/fd/${job}/full-launch-birth`,{mode:0o700});fsyncSync(job);
        const raw=readFileSync("/proc/self/stat","utf8"),end=raw.lastIndexOf(") "),ticks=raw.slice(end+2).trim().split(/\s+/)[19];check(end>0 && /^[1-9][0-9]*$/.test(ticks??""));
        beforeBytes=writeBirth("before.json",{schemaVersion:1,sourceSha:c.tuple.sourceSha,fingerprint:data.fingerprint,producerPid:process.pid,producerStartTicks:ticks,machineId:c.tuple.machineId,bootId:c.tuple.bootId,sourceSnapshotSha256:c.pins.sourceSnapshot()});
        prepared=true;revalidate();
      },
      afterSubmit(){
        revalidate();check(prepared && !published && beforeBytes);
        const fields="InvocationID,MainPID,ControlGroup,Description,LoadState,ActiveState";
        function unit(){
          const result=spawnSync("/usr/bin/systemctl",["show",fullNativeUnit,"--property="+fields],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:4096});
          check(!result.error && result.status===0 && result.signal===null);const values:Record<string,string>={};
          for(const line of result.stdout.trimEnd().split("\n")){const at=line.indexOf("=");check(at>0 && !Object.hasOwn(values,line.slice(0,at)));values[line.slice(0,at)]=line.slice(at+1);}
          check(Object.keys(values).sort().join(",")==="ActiveState,ControlGroup,Description,InvocationID,LoadState,MainPID");
          check(values.LoadState==="loaded" && ["active","activating"].includes(values.ActiveState??"") && /^[a-f0-9]{32}$/.test(values.InvocationID??"") && /^[1-9][0-9]*$/.test(values.MainPID??""));
          check(values.Description==="subscription-job:"+data.fingerprint && values.ControlGroup===fullNativeControlGroup);return values;
        }
        const values=unit(),prefix="/proc/"+values.MainPID,anchor=openSync(prefix,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW),anchorIdentity=identity(fstatSync(anchor));
        try{
          check(retainedFilesystemType(anchor)===0x9fa0n);
          const held=`/proc/self/fd/${anchor}`;
          const raw=readFileSync(held+"/stat","utf8"),end=raw.lastIndexOf(") "),parts=raw.slice(end+2).trim().split(/\s+/),ticks=parts[19];
          check(end>0 && raw.startsWith(values.MainPID+" (") && !["Z","X","x"].includes(parts[0]??"") && /^[1-9][0-9]*$/.test(ticks??""));
          check(readlinkSync(held+"/exe")===c.tuple.node && readFileSync(held+"/cmdline").equals(Buffer.from([c.tuple.node,c.tuple.parent,""].join("\u0000"))));
          check(readFileSync(held+"/cgroup","utf8").trim()==="0::"+fullNativeControlGroup);
          check(readlinkSync(held+"/ns/user")==="user:[4026531837]" && readlinkSync(held+"/ns/pid")==="pid:[4026531836]");
          const mount=readlinkSync(held+"/ns/mnt");check(/^mnt:\[[1-9][0-9]*\]$/.test(mount) && mount!==readlinkSync("/proc/1/ns/mnt"));
          const executable=fstatSync(c.pins.hold(c.tuple.node)),exeFd=openSync(held+"/exe",constants.O_RDONLY);
          try{const actual=fstatSync(exeFd);check(actual.dev===executable.dev && actual.ino===executable.ino);}finally{closeSync(exeFd);}
          const fresh=openSync(prefix,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
          try{
            check(identity(fstatSync(fresh))===anchorIdentity && identity(fstatSync(anchor))===anchorIdentity && ancestorMountId(fresh)===ancestorMountId(anchor));
            const now=readFileSync(`/proc/self/fd/${fresh}/stat`,"utf8"),at=now.lastIndexOf(") "),fields=now.slice(at+2).trim().split(/\s+/);
            check(now.startsWith(values.MainPID+" (") && fields[19]===ticks && !["Z","X","x"].includes(fields[0]??""));
            check(readlinkSync(`/proc/self/fd/${fresh}/ns/mnt`)===mount);
          }finally{closeSync(fresh);}
          revalidate();check(hash(readFileSync(fullNativeBirthRoot+"/before.json"))===hash(beforeBytes));
          check(JSON.stringify(unit())===JSON.stringify(values));
          const after=readFileSync(held+"/stat","utf8"),at=after.lastIndexOf(") "),finalFields=after.slice(at+2).trim().split(/\s+/);check(finalFields[19]===ticks && !["Z","X","x"].includes(finalFields[0]??""));
          // Publication is last, after every source/kernel/unit join passed.
          writeBirth("after.json",{schemaVersion:1,beforeSha256:hash(beforeBytes),unit:fullNativeUnit,invocationId:values.InvocationID,pid:Number(values.MainPID),startTicks:ticks,sourceSnapshotSha256:c.pins.sourceSnapshot()});
          published=true;
        }finally{closeSync(anchor);}
      },close(){if(closed)return;closed=true;c.pins.close();}});
  }catch{c.pins.close();refuse();}
}
/** Two primitive command cells, copied from own descriptors with no getters. */
export function fullDataArray(value:unknown):readonly [string,string]{
  check(value!==null && typeof value==="object" && !types.isProxy(value) && Array.isArray(value) && Object.getPrototypeOf(value)===Array.prototype);
  const object:object=value;const d=Object.getOwnPropertyDescriptors(object);check(Reflect.ownKeys(d).sort().join(",")==="0,1,length");
  for(const key of ["0","1","length"]){const v=d[key];check(v && Object.hasOwn(v,"value"));}
  check(d.length?.value===2 && typeof d["0"]?.value==="string" && typeof d["1"]?.value==="string");return [d["0"].value,d["1"].value];
}
const erasedEnvironment=["NODE_OPTIONS","NODE_PATH","LD_PRELOAD","LD_LIBRARY_PATH","LD_AUDIT","LD_PROFILE","OPENAI_API_KEY","ANTHROPIC_API_KEY","CODEX_HOME"].join(" ");
const parentCapabilities="CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_FSETID CAP_KILL CAP_SETGID CAP_SETUID CAP_SETPCAP CAP_SYS_CHROOT CAP_SYS_PTRACE CAP_SYS_ADMIN CAP_MKNOD CAP_AUDIT_WRITE CAP_SETFCAP";
const fullMonitorCapabilities=parentCapabilities;
export function fullNativeArguments(request:unknown){
  const custody=retainFullNativeLaunch(request);try{
    const toolchain=fullNativeInputBase+"/"+custody.sourceSha+"/toolchain";
    const properties=["Slice=subscription-runtime-hosted.slice","KillMode=control-group","SendSIGKILL=yes","Delegate=no","Restart=no","RemainAfterExit=no","ProtectSystem=strict","NoNewPrivileges=yes","MemorySwapMax=0","LimitCORE=0","LimitNOFILE=65536","AmbientCapabilities=","PassEnvironment=","UnsetEnvironment="+erasedEnvironment,"CapabilityBoundingSet="+parentCapabilities,
      "CPUQuota=100%","CPUQuotaPeriodSec=100ms","MemoryMax=2G","TasksMax=128","RuntimeMaxSec=1800","TimeoutStopSec=180","StandardOutput=null","StandardError=null",
      "ReadWritePaths="+fullNativeOsBase+" /var/lib/subscription-runtime-full-TEST-output /run/systemd/system /srv/workers/jobs/"+fullNativeJob,
      "BindReadOnlyPaths="+custody.source+":"+custody.source+":norbind",
      "BindReadOnlyPaths="+toolchain+":"+toolchain+":norbind","BindReadOnlyPaths=/run/TEST-full-outer-review:/run/TEST-full-outer-review:norbind","BindReadOnlyPaths=/run/TEST-real-codex-public-review:/run/TEST-real-codex-public-review:norbind","BindReadOnlyPaths="+reviewRoot+":"+reviewRoot+":norbind","BindReadOnlyPaths=/srv/worker-state/account-pools/live-codex-auth/account-u:/srv/worker-state/account-pools/live-codex-auth/account-u:norbind"];
    const args=Object.freeze(["--description=subscription-job:"+custody.fingerprint,"--unit="+fullNativeUnit,"--working-directory="+custody.source,"--service-type=exec","--expand-environment=no","--setenv=SUBSCRIPTION_RUNTIME_HOST_JOB_ID="+fullNativeJob,"--setenv=TEST_SOURCE_SHA="+custody.sourceSha,"--setenv=HOME=/srv/workers/jobs/"+fullNativeJob,"--setenv=TMPDIR=/srv/workers/jobs/"+fullNativeJob+"/tmp","--setenv=PATH=/usr/bin:/bin","--setenv=LANG=C.UTF-8",...properties.map(p=>"--property="+p),"--",custody.node,custody.parent]);
    custody.revalidate();return {args,custody};
  }catch{custody.close();refuse();}
}
const fullParents=new WeakMap<object,()=>void>();
const fullParentDescriptors=new WeakMap<object,()=>readonly number[]>();
export type FullMonitorTaskAnchor=Readonly<{path:string;processPid:number;processBirth:string;birth:string;revalidate():void}>;
export type FullMonitorTaskFact=Readonly<{pid:number;birth:string;taskBirth:string;invocationId:string;
  sourceBeforeSubmitSha256:string;mountNamespace:string;namespaceDevice:string;namespaceInode:string}>;
const fullMonitorReaders=new WeakMap<object,(task:FullMonitorTaskAnchor)=>FullMonitorTaskFact|undefined>();
/** Facts of ONE causally submitted original monitor, never PID/unit enrollment. */
export function readOriginalFullMonitorTask(parent:object,task:FullMonitorTaskAnchor):FullMonitorTaskFact|undefined {
  check(fullParents.has(parent));const read=fullMonitorReaders.get(parent);check(read);return read(task);
}

/** Exact retained SOURCE/proc custody fact of the genuine original session.
 * No caller can enroll a descriptor or fabricate this private session join. */
export function retainedCurrentFullParentDescriptors(value:object):readonly number[] {
  assertRetainedCurrentFullParent(value);const read=fullParentDescriptors.get(value);check(read);return Object.freeze([...read()]);
}
export function assertRetainedCurrentFullParent(value:unknown):void {check(value!==null && typeof value==="object");const rejoin=fullParents.get(value);check(rejoin);rejoin();}
export interface FullParentSession {
  readonly unit:string;revalidate():void;liveBindings():readonly string[];
  registerGuest(id:string,root:string,fragmentSha256:string):void;
  submitGuest(id:string):void;
  observeGuestInvocation(id:string,guestInvocationId:string):void;
  close(terminal:unknown):Promise<void>;
}
let retainedFullParent:FullParentSession|undefined;
/** SAME original protected manager + actual service reader, no admission DTO. */
export function retainCurrentFullParent():FullParentSession {
  if(retainedFullParent){assertRetainedCurrentFullParent(retainedFullParent);return retainedFullParent;}
  const c=acquire(RootContext.Parent);let closed=false,invocation:string|undefined,guestId:string|undefined,guestHash:string|undefined;
  let guestSubmitted=false,monitorSourceBeforeSubmit:string|undefined;
  let monitorCaptureStarted=false;
  let monitor:Readonly<{pid:number;start:string;anchor:number;exe:number;mnt:number;user:number;pidNamespace:number;
    procIdentity:string;exeIdentity:string;mountNamespace:string;invocation:string;command:Buffer}>|undefined;
  const procRoot="/proc/"+process.pid,procFds:number[]=[];
  const procIdentity=(fd:number)=>{const s=fstatSync(fd,{bigint:true});check(s.isFile() && retainedFilesystemType(fd)===0x9fa0n);return {dev:String(s.dev),ino:String(s.ino)};};
  function birth(raw:string){const end=raw.lastIndexOf(") "),fields=raw.slice(end+2).trim().split(/\s+/);check(end>0 && raw.startsWith(process.pid+" (") && fields[0] && !["Z","X","x"].includes(fields[0]) && /^[1-9][0-9]*$/.test(fields[19]??""));return fields[19]!;}
  const sourceSnapshot=c.pins.sourceSnapshot();
  let liveRootCreated=false;
  let birthWitness:Readonly<{before:Buffer;after:Buffer}>|undefined;
  function sourceBirth(){
    if(!birthWitness){
      c.pins.hold(fullNativeBirthRoot,true,0o700);
      const deadline=process.hrtime.bigint()+5000000000n;
      while(true){try{lstatSync(fullNativeBirthRoot+"/after.json");break;}catch(error){check((error as NodeJS.ErrnoException).code==="ENOENT" && process.hrtime.bigint()<deadline);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
      const before=c.pins.json(fullNativeBirthRoot+"/before.json",4096),after=c.pins.json(fullNativeBirthRoot+"/after.json",4096);
      const b=fullData(before,["schemaVersion","sourceSha","fingerprint","producerPid","producerStartTicks","machineId","bootId","sourceSnapshotSha256"]),a=fullData(after,["schemaVersion","beforeSha256","unit","invocationId","pid","startTicks","sourceSnapshotSha256"]);
      const beforeBytes=Buffer.from(JSON.stringify(before)+"\n"),afterBytes=Buffer.from(JSON.stringify(after)+"\n");
      check(b.schemaVersion===1 && b.sourceSha===c.tuple.sourceSha && b.fingerprint===fingerprint(c.tuple.machineId,argvFor(c)) && b.machineId===c.tuple.machineId && b.bootId===c.tuple.bootId && b.sourceSnapshotSha256===sourceSnapshot);
      check(a.schemaVersion===1 && a.beforeSha256===hash(beforeBytes) && a.unit===fullNativeUnit && a.pid===process.pid && a.startTicks===parentStartTicks && a.invocationId===invocation && a.sourceSnapshotSha256===sourceSnapshot);
      check(Number.isSafeInteger(b.producerPid) && Number(b.producerPid)>0 && /^[1-9][0-9]*$/.test(String(b.producerStartTicks)));
      birthWitness=Object.freeze({before:beforeBytes,after:afterBytes});
    }
    check(readFileSync(fullNativeBirthRoot+"/before.json").equals(birthWitness.before) && readFileSync(fullNativeBirthRoot+"/after.json").equals(birthWitness.after));
  }
  const procAnchor=openSync(procRoot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  procFds.push(procAnchor);
  const procFiles=["stat","status"].map(name=>{const fd=openSync(`/proc/self/fd/${procAnchor}/${name}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);procFds.push(fd);return {name,fd,identity:procIdentity(fd)};});
  const parentStartTicks=birth(readFileSync(procRoot+"/stat","utf8"));
  const caps=(raw:string)=>["Inh","Prm","Eff","Bnd","Amb"].map(set=>{const row=new RegExp("^Cap"+set+":\\s+([0-9a-f]{16})$","m").exec(raw)?.[1];check(row);return row;});
  const parentCapabilities=caps(readFileSync(procRoot+"/status","utf8"));
  function liveProc(){
    const anchor=fstatSync(procAnchor),named=lstatSync(procRoot);check(anchor.dev===named.dev && anchor.ino===named.ino && !named.isSymbolicLink());
    for(const entry of procFiles){const fresh=openSync(procRoot+"/"+entry.name,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{check(JSON.stringify(procIdentity(fresh))===JSON.stringify(entry.identity) && JSON.stringify(procIdentity(entry.fd))===JSON.stringify(entry.identity));
        check(ancestorMountId(fresh)===ancestorMountId(entry.fd));
        const raw=readFileSync(fresh,"utf8");check(Buffer.byteLength(raw)<=(entry.name==="stat"?4096:16384));
        if(entry.name==="stat")check(birth(raw)===parentStartTicks);else check(JSON.stringify(caps(raw))===JSON.stringify(parentCapabilities) && /^Uid:\s+0\s+0\s+0\s+0$/m.test(raw) && /^NoNewPrivs:\s+1$/m.test(raw));
      }finally{closeSync(fresh);}}
    check(birth(readFileSync(procRoot+"/stat","utf8"))===parentStartTicks);
  }
  const revalidate=()=>{check(!closed);liveProc();c.validate();
    const ackDeadline=process.hrtime.bigint()+5000000000n;
    while(record(c,true).phase!==FullParentPhase.Started){check(process.hrtime.bigint()<ackDeadline);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
    const envKeys=Object.keys(process.env);check(envKeys.length<=32 && envKeys.every(key=>["PATH","LANG","LC_ALL","HOME","TMPDIR","USER","LOGNAME","SHELL","INVOCATION_ID","SYSTEMD_EXEC_PID","JOURNAL_STREAM","SUBSCRIPTION_RUNTIME_HOST_JOB_ID","TEST_SOURCE_SHA"].includes(key)));
    check(process.env.SUBSCRIPTION_RUNTIME_HOST_JOB_ID===fullNativeJob && process.env.TEST_SOURCE_SHA===c.tuple.sourceSha && process.argv.length===2);
    check(readlinkSync("/proc/self/exe")===c.tuple.node);check(readFileSync("/proc/self/cmdline").equals(Buffer.from([c.tuple.node,c.tuple.parent,""].join("\u0000"))));
    const observed=spawnSync("/usr/bin/systemctl",["show",fullNativeUnit,"--property=LoadState,ActiveState,SubState,InvocationID,MainPID,Description,ControlGroup,ProtectSystem"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:4096});
    check(!observed.error && observed.status===0 && observed.signal===null);const values:Record<string,string>={};
    for(const line of observed.stdout.trimEnd().split("\n")){const n=line.indexOf("=");check(n>0 && !Object.hasOwn(values,line.slice(0,n)));values[line.slice(0,n)]=line.slice(n+1);}
    check(Object.keys(values).sort().join(",")==="ActiveState,ControlGroup,Description,InvocationID,LoadState,MainPID,ProtectSystem,SubState");
    check(values.ProtectSystem==="strict");assertReadonlyMounts(c.pins,[c.tuple.source,c.tuple.root+"/toolchain",reviewRoot,"/run/TEST-full-outer-review","/run/TEST-real-codex-public-review","/srv/worker-state/account-pools/live-codex-auth/account-u"]);
    check(values.LoadState===FullKernelState.Loaded && (values.ActiveState===FullKernelState.Active || values.ActiveState===FullKernelState.Activating) && values.SubState===FullKernelState.Running && values.MainPID===String(process.pid));
    check(typeof values.ControlGroup==="string");
    check(values.Description==="subscription-job:"+fingerprint(c.tuple.machineId,argvFor(c)) && values.ControlGroup===fullNativeControlGroup);
    check(typeof values.InvocationID==="string" && /^[a-f0-9]{32}$/.test(values.InvocationID));check(process.env.INVOCATION_ID===values.InvocationID && process.env.PATH==="/usr/bin:/bin" && process.env.LANG==="C.UTF-8" && process.env.HOME==="/srv/workers/jobs/"+fullNativeJob && process.env.TMPDIR==="/srv/workers/jobs/"+fullNativeJob+"/tmp");if(invocation)check(invocation===values.InvocationID);else invocation=values.InvocationID;
    check(readFileSync("/proc/self/cgroup","utf8").trim()==="0::"+values.ControlGroup);assertParentKernelPolicy(values.ControlGroup);sourceBirth();liveProc();c.validate();record(c,true);
  };
  function monitorState():Readonly<Record<string,string>> {
    check(guestId && guestSubmitted);
    const unit="TEST-retention-os-"+guestId+".service";
    const keys=["Id","LoadState","ActiveState","SubState","MainPID","InvocationID","ControlGroup","FragmentPath","DropInPaths", "Type","KillMode","Restart","NoNewPrivileges","CapabilityBoundingSet","AmbientCapabilities","RootDirectory","WorkingDirectory","Environment","UnsetEnvironment","StandardInput","StandardOutput","StandardError"];
    const result=spawnSync("/usr/bin/systemctl",["show",unit,"--property="+keys.join(",")],
      {env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:8192});
    check(!result.error && result.status===0 && result.signal===null);const values:Record<string,string>={};
    for(const line of result.stdout.trimEnd().split("\n")){
      const at=line.indexOf("=");check(at>0 && !Object.hasOwn(values,line.slice(0,at)));values[line.slice(0,at)]=line.slice(at+1);
    }
    check(Object.keys(values).sort().join(",")===keys.sort().join(","));
    check(values.Id===unit && values.LoadState==="loaded" && values.ActiveState==="active" && values.SubState==="running" &&
      values.ControlGroup==="/system.slice/"+unit && values.FragmentPath==="/run/systemd/system/"+unit && values.DropInPaths==="" &&
      values.Type==="exec" && values.KillMode==="control-group" && values.Restart==="no" && values.NoNewPrivileges==="yes" && values.AmbientCapabilities==="" &&
      values.RootDirectory==="" && (values.WorkingDirectory==="" || values.WorkingDirectory==="/") &&
      values.Environment==="SYSTEMD_NSPAWN_USE_CGNS=1" && values.StandardInput==="null" && values.StandardOutput==="null" && values.StandardError==="null");
    check(values.UnsetEnvironment?.split(" ").sort().join(" ") === ["NODE_OPTIONS","NODE_PATH","LD_PRELOAD","LD_LIBRARY_PATH","LD_AUDIT","LD_PROFILE"].sort().join(" "));
    check(values.CapabilityBoundingSet?.split(" ").map(value=>value.toUpperCase()).sort().join(" ")===fullMonitorCapabilities.split(" ").sort().join(" "));
    check(/^[1-9][0-9]*$/.test(values.MainPID??"") && /^[a-f0-9]{32}$/.test(values.InvocationID??""));
    return Object.freeze(values);
  }
  function monitorBirth(path:string,pid:number):string {
    const raw=readFileSync(path+"/stat","utf8"),end=raw.lastIndexOf(") "),fields=raw.slice(end+2).trim().split(/\s+/);
    check(end>0 && raw.startsWith(pid+" (") && !["Z","X","x"].includes(fields[0]??"") && /^[1-9][0-9]*$/.test(fields[19]??""));return fields[19]!;
  }
  function retainMonitorDescriptor(path:string,flags:number):number {
    const fd=openSync(path,flags);procFds.push(fd);return fd;
  }
  function monitorMappings(path:string):void {
    const raw=readFileSync(path+"/maps","utf8");check(Buffer.byteLength(raw)<=1024*1024);
    const selected=c.monitorSources.map(source=>{const stat=fstatSync(source.fd,{bigint:true});
      const major=((stat.dev>>8n)&0xfffn)|((stat.dev>>32n)&0xfffff000n),minor=(stat.dev&0xffn)|((stat.dev>>12n)&0xffffff00n);
      return {inode:String(stat.ino),device:major+":"+minor};});
    let executableMaps=0;
    for(const row of raw.trimEnd().split("\n")){
      const match=/^[0-9a-f]+-[0-9a-f]+ ([rwxps-]{4}) [0-9a-f]+ ([0-9a-f]+):([0-9a-f]+) ([0-9]+)(?: +(.+))?$/.exec(row);check(match);
      if(!match[1]!.includes("x"))continue;check(!match[1]!.includes("w"));
      if(match[4]==="0"){check(match[5]==="[vdso]" || match[5]==="[vsyscall]");continue;}
      executableMaps++;check(selected.some(source=>source.inode===match[4] && source.device===BigInt("0x"+match[2]!)+":"+BigInt("0x"+match[3]!)));
    }
    check(executableMaps>0);
  }
  function rejoinMonitor():void {
    revalidate();check(monitor && monitorSourceBeforeSubmit && guestId);
    const before=monitorState();check(before.MainPID===String(monitor.pid) && before.InvocationID===monitor.invocation);
    const numeric="/proc/"+monitor.pid,held=`/proc/self/fd/${monitor.anchor}`,fresh=openSync(numeric,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{
      check(identity(fstatSync(fresh))===monitor.procIdentity && identity(fstatSync(monitor.anchor))===monitor.procIdentity &&
        ancestorMountId(fresh)===ancestorMountId(monitor.anchor) && retainedFilesystemType(monitor.anchor)===0x9fa0n);
      check(monitorBirth(held,monitor.pid)===monitor.start && monitorBirth(`/proc/self/fd/${fresh}`,monitor.pid)===monitor.start);
      const status=readFileSync(held+"/status","utf8");check(/^Uid:\s+0\s+0\s+0\s+0$/m.test(status) && /^Gid:\s+0\s+0\s+0\s+0$/m.test(status) && /^NoNewPrivs:\s+1$/m.test(status));
      const sets=caps(status),bound=0xa82c01fbn;check(sets[0]==="0000000000000000" && sets[4]==="0000000000000000" && BigInt("0x"+sets[3]!)===bound);
      check(sets.every(value=>(BigInt("0x"+value)&~bound)===0n));
      check(identity(statSync(held+"/root"))===identity(fstatSync(c.pins.hold("/",true))));
      check(readFileSync(held+"/cgroup","utf8")==="0::/system.slice/TEST-retention-os-"+guestId+".service\n" && readFileSync(held+"/cmdline").equals(monitor.command));
      const exe=openSync(held+"/exe",constants.O_RDONLY);try{check(identity(fstatSync(exe))===monitor.exeIdentity && identity(fstatSync(monitor.exe))===monitor.exeIdentity);}finally{closeSync(exe);}
      check(readlinkSync(held+"/ns/user")==="user:[4026531837]" && readlinkSync(held+"/ns/pid")==="pid:[4026531836]" && readlinkSync(held+"/ns/mnt")===monitor.mountNamespace);
      for(const [name,fd] of [["user",monitor.user],["pid",monitor.pidNamespace],["mnt",monitor.mnt]] as const){
        const current=openSync(held+"/ns/"+name,constants.O_RDONLY);try{check(identity(fstatSync(current))===identity(fstatSync(fd)) && retainedFilesystemType(fd)===0x6e736673n);}finally{closeSync(current);}
      }
      monitorMappings(held);c.validate();check(c.pins.sourceSnapshot()===monitorSourceBeforeSubmit);
      check(JSON.stringify(monitorState())===JSON.stringify(before));check(monitorBirth(held,monitor.pid)===monitor.start);
    }finally{closeSync(fresh);}
  }
  function captureMonitor(expectedInvocation:string):void {
    check(!monitorCaptureStarted && guestId && monitorSourceBeforeSubmit);monitorCaptureStarted=true;
    const state=monitorState();check(state.InvocationID===expectedInvocation);const pid=Number(state.MainPID);
    const anchor=retainMonitorDescriptor("/proc/"+pid,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW),path=`/proc/self/fd/${anchor}`;
    const fragment=readFd(c.pins.hold("/run/systemd/system/TEST-retention-os-"+guestId+".service")).toString("utf8");
    check(Buffer.byteLength(fragment)<=16384);
    const commands=[...fragment.matchAll(/^ExecStart=(.+)$/gm)];check(commands.length===1);
    const argv=commands[0]![1]!.split(" ");check(argv[0]==="/usr/bin/systemd-nspawn" && argv.includes("--settings=no") && argv.includes("--link-journal=no"));
    const command=Buffer.from([...argv,""].join("\0"));check(command.length<=32768 && readFileSync(path+"/cmdline").equals(command));
    const exe=retainMonitorDescriptor(path+"/exe",constants.O_RDONLY),selected=fstatSync(c.monitorSources[0]!.fd);
    check(identity(fstatSync(exe))===identity(selected));
    const user=retainMonitorDescriptor(path+"/ns/user",constants.O_RDONLY),pidNamespace=retainMonitorDescriptor(path+"/ns/pid",constants.O_RDONLY),mnt=retainMonitorDescriptor(path+"/ns/mnt",constants.O_RDONLY);
    monitor=Object.freeze({pid,start:monitorBirth(path,pid),anchor,exe,mnt,user,pidNamespace,procIdentity:identity(fstatSync(anchor)),exeIdentity:identity(fstatSync(exe)),mountNamespace:readlinkSync(path+"/ns/mnt"),invocation:expectedInvocation,command});
    rejoinMonitor();
  }
  function seal(name:"current-full-pair.json"|"current-full-pair-invocation.json",data:unknown){
    revalidate();check(liveRootCreated);const parent=c.pins.hold(fullNativeLiveRoot,true,0o700);
    const fd=openSync(`/proc/self/fd/${parent}/${name}`,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{writeFileSync(fd,JSON.stringify(data)+"\n");fsyncSync(fd);}finally{closeSync(fd);}fsyncSync(parent);revalidate();
  }
  try{revalidate();const session=Object.freeze({unit:fullNativeUnit,revalidate,
    liveBindings(){
      revalidate();check(!liveRootCreated);const job=c.pins.hold("/srv/workers/jobs/"+fullNativeJob,true,0o700);
      mkdirSync(`/proc/self/fd/${job}/full-parent-live`,{mode:0o700});fsyncSync(job);
      c.pins.hold(fullNativeLiveRoot,true,0o700);liveRootCreated=true;revalidate();
      return Object.freeze([`--bind-ro=${fullNativeLiveRoot}:${fullNativeGuestLiveRoot}/seals`,
        `--bind-ro=${procRoot}/stat:${fullNativeGuestLiveRoot}/stat`,`--bind-ro=${procRoot}/status:${fullNativeGuestLiveRoot}/status`]);
    },
    registerGuest(id:string,root:string,fragmentSha256:string){
      revalidate();check(!guestId && fullNativeGuestRoot(id,root) && digest(fragmentSha256));
      c.pins.hold(dirname(root),true,0o700);const rootFd=c.pins.hold(root,true,0o755),rootStat=fstatSync(rootFd),unit="TEST-retention-os-"+id+".service";
      c.pins.publicFile("/run/systemd/system/"+unit,fragmentSha256);
      // Original source is retained BEFORE this exclusive guest submission.
      // Current hashes after birth are never substituted for this causal hold.
      const guestRuntime=root+"/opt/subscription-runtime-dependency-os-TEST";
      const publicCatalog=fullData(c.pins.json(reviewRoot+"/public-installation.json",2*1024*1024),["schemaVersion","sourceSha","sourceTree","files"]);
      check(Array.isArray(publicCatalog.files));
      for(const entry of publicCatalog.files){const row=fullData(entry,["path","sha256"]);check(fullPublicRelative(row.path) && digest(row.sha256));
        if(!row.path.startsWith("host-integration/") || ["host-integration/managed-launcher/dependency-full-native-TEST.js","host-integration/managed-launcher/launch.mjs","host-integration/managed-launcher/profiles.mjs","host-integration/managed-launcher/payload-guard.mjs","host-integration/host-jobs/storage-policy.mjs"].includes(row.path))c.pins.publicFile(guestRuntime+"/"+row.path,row.sha256);
        if(["host-integration/managed-launcher/launch.mjs","host-integration/managed-launcher/payload-guard.mjs","host-integration/managed-launcher/profiles.mjs","host-integration/host-jobs/storage-policy.mjs"].includes(row.path))c.pins.publicFile(root+"/opt/subscription-runtime/"+row.path.slice("host-integration/".length),row.sha256);
      }
      c.pins.publicFile(guestRuntime+"/toolchain/bin/node",requireDigest(fullData(c.pins.json(reviewPath,32768),["schemaVersion","sourceBaseSha","sourceSha","sourceTree","machineId","bootId","nodeSha256","launcherSha256","moduleSha256","parentSha256","catalogSha256","outerReviewSha256","publicReviewSha256","accountName","reviewReference","hostTools","systemdVersion","installedModules"]).nodeSha256));
      const elfFd=c.pins.hold(guestRuntime+"/os-signed-elf-pins.json"),elfBytes=readFd(elfFd);check(elfBytes.length<=256*1024);
      const os=fullData(JSON.parse(elfBytes.toString("utf8")),["schemaVersion","pins"]);check(os.schemaVersion===1 && Array.isArray(os.pins));
      const guestSources:{path:string;sha256:string}[]=[{path:"/opt/subscription-runtime-dependency-os-TEST/toolchain/bin/node",sha256:hash(readFd(c.pins.hold(guestRuntime+"/toolchain/bin/node")))}];
      for(const entry of os.pins){const row=fullData(entry,["path","sha256"]);check(typeof row.path==="string" && /^\/usr\/(?:lib|bin)\/[A-Za-z0-9_.+/-]+$/.test(row.path) && !row.path.split("/").includes("..") && digest(row.sha256));c.pins.publicFile(root+row.path,row.sha256);
        if(["/usr/lib/systemd/systemd","/usr/bin/dbus-daemon"].includes(row.path))guestSources.push({path:row.path,sha256:row.sha256});}
      for(const entry of publicCatalog.files){const row=fullData(entry,["path","sha256"]);if(typeof row.path==="string" && /^(?:scripts\/dependency-retention-os-test\/current-full-(?:supervisor|guest)\.js|dist\/worker-codex\/hosted-readonly-(?:host-launch-cli|runtime-bootstrap)\.js)$/.test(row.path)){check(digest(row.sha256));guestSources.push({path:"/opt/subscription-runtime-dependency-os-TEST/"+row.path,sha256:row.sha256});}}
      const supervisor="/etc/systemd/test-units/TEST-retention-supervisor.service",supervisorFd=c.pins.hold(root+supervisor,false,0o644);
      guestSources.push({path:supervisor,sha256:hash(readFd(supervisorFd))});
      const guestMachineFd=c.pins.hold(root+"/etc/machine-id",false,0o444),guestMachineId=readFd(guestMachineFd).toString("utf8").trim();check(/^[a-f0-9]{32}$/.test(guestMachineId));
      check(guestSources.length===8);c.validate();
      const data={schemaVersion:2,jobId:fullNativeJob,parentUnit:fullNativeUnit,parentInvocationId:invocation,guestMachineId,parentProc:{pid:process.pid,startTicks:parentStartTicks,stat:procFiles[0]!.identity,status:procFiles[1]!.identity,capabilities:parentCapabilities},guestSources,unit,fragmentSha256,root,rootDev:String(rootStat.dev),rootIno:String(rootStat.ino),machineId:c.tuple.machineId,bootId:c.tuple.bootId,sourceSha:c.tuple.sourceSha};
      guestHash=hash(JSON.stringify(data)+"\n");seal("current-full-pair.json",data);guestId=id;
    },
    submitGuest(id:string){
      // This private original session owns the existing one submission. A
      // transport failure consumes it and retains custody; no blind retry.
      revalidate();check(id===guestId && guestHash && !guestSubmitted);
      const unit="TEST-retention-os-"+id+".service";
      const observation=spawnSync("/usr/bin/systemctl",["show",unit,"--property=MainPID,Job,ActiveState,FragmentPath,DropInPaths"],
        {env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:4096});
      check(!observation.error && observation.status===0 && observation.signal===null);
      const fields:Record<string,string>={};
      for(const line of observation.stdout.trimEnd().split("\n")){
        const split=line.indexOf("=");check(split>0 && !Object.hasOwn(fields,line.slice(0,split)));
        fields[line.slice(0,split)]=line.slice(split+1);
      }
      check(Object.keys(fields).sort().join(",")==="ActiveState,DropInPaths,FragmentPath,Job,MainPID" &&
        fields.MainPID==="0" && fields.Job==="" && fields.ActiveState==="inactive" &&
        fields.FragmentPath==="/run/systemd/system/"+unit && fields.DropInPaths==="");
      revalidate();monitorSourceBeforeSubmit=c.pins.sourceSnapshot();guestSubmitted=true;
      const submitted=spawnSync("/usr/bin/systemctl",["start","--no-block",unit],
        {env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:4096});
      check(!submitted.error && submitted.status===0 && submitted.signal===null);revalidate();
    },
    observeGuestInvocation(id:string,guestInvocationId:string){
      revalidate();check(id===guestId && guestHash && guestSubmitted && monitorSourceBeforeSubmit && /^[a-f0-9]{32}$/.test(guestInvocationId));const unit="TEST-retention-os-"+id+".service";
      const result=spawnSync("/usr/bin/systemctl",["show",unit,"--property=InvocationID","--value"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:256});
      check(!result.error && result.status===0 && result.signal===null && result.stdout.trim()===guestInvocationId);revalidate();
      captureMonitor(guestInvocationId);
      seal("current-full-pair-invocation.json",{schemaVersion:1,pairSha256:guestHash,parentInvocationId:invocation,unit,guestInvocationId});
    },async close(terminal:unknown){
      check(!closed);revalidate();
      const module=await import(pathToFileURL(c.tuple.source+"/scripts/dependency-retention-os-test/current-full-backing-collector.js").href);
      module.assertFullBackingTerminal(session,terminal);revalidate();
      if(monitor){
        // A recursive terminal brand does not turn a live proc anchor into dead
        // custody. Reopen the original object: kernel death must be observable.
        let dead=false;
        try{readFileSync(`/proc/self/fd/${monitor.anchor}/stat`);}
        catch(error){check((error as NodeJS.ErrnoException).code==="ESRCH" || (error as NodeJS.ErrnoException).code==="ENOENT");dead=true;}
        check(dead);
        const final=spawnSync("/usr/bin/systemctl",["show","TEST-retention-os-"+guestId+".service","--property=InvocationID,MainPID,Job,ActiveState"],
          {env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:4096});
        check(!final.error && final.status===0 && final.signal===null);const fields:Record<string,string>={};
        for(const line of final.stdout.trimEnd().split("\n")){const at=line.indexOf("=");check(at>0 && !Object.hasOwn(fields,line.slice(0,at)));fields[line.slice(0,at)]=line.slice(at+1);}
        check(Object.keys(fields).sort().join(",")==="ActiveState,InvocationID,Job,MainPID" && fields.InvocationID===monitor.invocation &&
          fields.MainPID==="0" && fields.Job==="" && ["inactive","failed"].includes(fields.ActiveState??""));
      }
      revalidate();closed=true;for(const fd of procFds.reverse())closeSync(fd);c.pins.close();
    }});fullParents.set(session,revalidate);fullMonitorReaders.set(session,(task)=>{
      if(!monitor || task.processPid!==monitor.pid || task.processBirth!==monitor.start)return undefined;
      revalidate();rejoinMonitor();task.revalidate();
      const taskDirectory=openSync(task.path,constants.O_RDONLY|constants.O_DIRECTORY);
      try{check(retainedFilesystemType(taskDirectory)===0x9fa0n && identity(fstatSync(taskDirectory))===identity(statSync(task.path)));}
      finally{closeSync(taskDirectory);}
      const rawTask=readFileSync(task.path+"/stat","utf8"),taskPid=Number(rawTask.slice(0,rawTask.indexOf(" ")));
      check(Number.isSafeInteger(taskPid) && taskPid>0 && monitorBirth(task.path,taskPid)===task.birth);
      const held=`/proc/self/fd/${monitor.anchor}`;
      check(readFileSync(task.path+"/cgroup").equals(readFileSync(held+"/cgroup")) &&
        readFileSync(task.path+"/cmdline").equals(monitor.command) && identity(statSync(task.path+"/exe"))===monitor.exeIdentity);
      const status=readFileSync(task.path+"/status","utf8");check(new RegExp("^Tgid:\\s+"+monitor.pid+"$","m").test(status) && new RegExp("^Pid:\\s+"+taskPid+"$","m").test(status));check(/^Uid:\s+0\s+0\s+0\s+0$/m.test(status) && /^Gid:\s+0\s+0\s+0\s+0$/m.test(status) && /^NoNewPrivs:\s+1$/m.test(status));
      check(JSON.stringify(caps(status))===JSON.stringify(caps(readFileSync(held+"/status","utf8"))));
      for(const [name,fd] of [["user",monitor.user],["pid",monitor.pidNamespace],["mnt",monitor.mnt]] as const){
        const actual=openSync(task.path+"/ns/"+name,constants.O_RDONLY);
        try{check(identity(fstatSync(actual))===identity(fstatSync(fd)) && retainedFilesystemType(actual)===0x6e736673n);}finally{closeSync(actual);}
      }
      check(identity(statSync(task.path+"/root"))===identity(statSync(held+"/root")));
      const namespace=fstatSync(monitor.mnt);rejoinMonitor();task.revalidate();
      return Object.freeze({pid:monitor.pid,birth:monitor.start,taskBirth:task.birth,invocationId:monitor.invocation,
        sourceBeforeSubmitSha256:monitorSourceBeforeSubmit!,mountNamespace:monitor.mountNamespace,namespaceDevice:String(namespace.dev),namespaceInode:String(namespace.ino)});
    });fullParentDescriptors.set(session,()=>{check(!closed);return c.pins.descriptors().concat(procFds);});retainedFullParent=session;return session;}catch{for(const fd of procFds.reverse())closeSync(fd);c.pins.close();refuse();}
}

/** DATA predicate only; it grants no physical protection or launch permission. */
export function fullReadonlyMountData(raw:string,path:string,mountId:string,device:string){
  check(Buffer.byteLength(raw)<=1024*1024 && raw.endsWith("\n") && raw.length>1);
  const ids=new Set<string>();
  const mounts=raw.slice(0,-1).split("\n").map(line=>{
    const fields=line.split(" "),split=fields.indexOf("-");
    check(fields.length>=10 && split>=6 && fields.length===split+4);
    const id=fields[0],parent=fields[1],dev=fields[2],root=fields[3],point=fields[4],options=fields[5];
    check(id && /^[1-9][0-9]{0,19}$/.test(id) && parent && /^[1-9][0-9]{0,19}$/.test(parent) && !ids.has(id));ids.add(id);
    check(dev && /^(?:0|[1-9][0-9]{0,9}):(?:0|[1-9][0-9]{0,9})$/.test(dev));
    function decoded(value:unknown):string{
      check(typeof value==="string" && value.startsWith("/") && !/\\(?!040|011|012|134)/.test(value));
      return value.replace(/\\(040|011|012|134)/g,(_,digits:string)=>String.fromCharCode(parseInt(digits,8)));
    }
    const decodedRoot=decoded(root),decodedPoint=decoded(point);
    check(options && /^(?:[A-Za-z0-9_.=+-]+)(?:,[A-Za-z0-9_.=+-]+)*$/.test(options));
    const flags=options.split(",");check(new Set(flags).size===flags.length && flags.filter(v=>v==="ro" || v==="rw").length===1);
    check(fields.slice(split+1).every(v=>typeof v==="string" && v.length>0));
    return {id,device:dev,root:decodedRoot,point:decodedPoint,readonly:flags.includes("ro")};
  });
  check(mounts.length<=8192);
  const selected=mounts.filter(m=>m.id===mountId);check(selected.length===1);const own=selected[0];check(own && own.device===device);
  const covers=(point:string)=>path===point || path.startsWith(point==="/"?"/":point+"/");
  check(covers(own.point) && own.readonly);
  const covering=mounts.filter(m=>covers(m.point)),longest=Math.max(...covering.map(m=>m.point.length));
  const top=covering.filter(m=>m.point.length===longest);check(top.length===1 && top[0]?.id===mountId);
  check(!mounts.some(m=>m.point.startsWith(path+"/") && !m.readonly));
}
/** Actual retained descriptor mount IDs, device/inode and unchanged complete
 * kernel view are joined before interpreting any readonly observation. */
function assertReadonlyMounts(pins:Pins,paths:readonly string[]){
  const raw=readFileSync("/proc/self/mountinfo","utf8");check(Buffer.byteLength(raw)<=1024*1024);
  for(const path of paths){
    const fd=pins.hold(path,true),before=fstatSync(fd,{bigint:true}),info=readFileSync(`/proc/self/fdinfo/${fd}`,"utf8");
    check(Buffer.byteLength(info)<=4096);const ids=[...info.matchAll(/^mnt_id:\s+([1-9][0-9]{0,19})$/gm)],inos=[...info.matchAll(/^ino:\s+([1-9][0-9]{0,19})$/gm)];
    const id=ids[0]?.[1],ino=inos[0]?.[1];check(ids.length===1 && inos.length===1 && id && ino && BigInt(ino)===before.ino);
    const d=before.dev,major=((d&0x00000000000fff00n)>>8n)|((d&0xfffff00000000000n)>>32n),minor=(d&0x00000000000000ffn)|((d&0x00000ffffff00000n)>>12n);
    fullReadonlyMountData(raw,path,id,String(major)+":"+String(minor));
    const after=fstatSync(fd,{bigint:true}),named=lstatSync(path,{bigint:true});check(after.dev===before.dev && after.ino===before.ino && named.dev===before.dev && named.ino===before.ino && !named.isSymbolicLink());
    check(readFileSync(`/proc/self/fdinfo/${fd}`,"utf8")===info);
  }
  check(readFileSync("/proc/self/mountinfo","utf8")===raw);pins.validate();
}

/** One fixed demand: 8GiB summed caps plus 1GiB host reserve, 14GiB real OS
 * fixture backing. This measures availability, not a reservation or permit. */
function preflightCapacity(baseFd:number){
  const text=readFileSync("/proc/meminfo","utf8");check(Buffer.byteLength(text)<=65536);
  const available=[...text.matchAll(/^MemAvailable:\s+(\d+) kB$/gm)],swap=[...text.matchAll(/^SwapFree:\s+(\d+) kB$/gm)];
  check(available.length===1 && swap.length===1 && available[0]?.[1] && swap[0]?.[1]);
  check(BigInt(available[0][1])*1024n>=9n*1024n*1024n*1024n);check(BigInt(swap[0][1])>=0n);
  const s=fstatSync(baseFd);check(s.isDirectory() && s.uid===0 && s.gid===0 && (s.mode&0o7777)===0o700);
  const fs=statfsSync(`/proc/self/fd/${baseFd}`,{bigint:true});check(fs.bavail*fs.bsize>=14n*1024n*1024n*1024n && fs.ffree>=100000n);
}

/** Actual kernel caps/cgroup values, not a systemd-owned label. Linux UAPI
 * capability positions are fixed here for the reviewed fourteen-cap tuple. */
function assertParentKernelPolicy(group:string){
  const status=readFileSync("/proc/self/status","utf8");check(Buffer.byteLength(status)<=65536);
  for(const [name,expected] of [["CapBnd",0xa82c01fbn],["CapEff",0xa82c01fbn],["CapPrm",0xa82c01fbn],["CapAmb",0n]] as const){const rows=[...status.matchAll(new RegExp("^"+name+":\\s+([a-f0-9]{16})$","gm"))];check(rows.length===1 && rows[0]?.[1]);check(BigInt("0x"+rows[0][1])===expected);}
  check(/^NoNewPrivs:\s+1$/m.test(status));
  for(const [leaf,expected] of [["memory.max","2147483648"],["memory.swap.max","0"],["pids.max","128"],["cpu.max","100000 100000"]] as const)check(readFileSync("/sys/fs/cgroup"+group+"/"+leaf,"utf8").trim()===expected);
}
