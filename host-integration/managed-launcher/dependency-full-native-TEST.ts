/** One exceptional ROOT TEST profile. No ordinary profile or caller may select
 * capabilities, roots or commands. Protected reviews are independently issued. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants, closeSync, fsyncSync, writeFileSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, statfsSync, type Stats } from "node:fs";
import { basename, dirname } from "node:path";
import { types } from "node:util";
export const fullNativeJob="TEST-dependency-full-native-20261007-r1";
const integration="/opt/subscription-runtime", reviewRoot="/srv/worker-state/protected-storage-test/dependency-full-native-activation";
const reviewPath=reviewRoot+"/review.json", sourceBase="28511fec3a4796db3b86ac57f376d64c4b9b8d29";
const hash=(value: string|Buffer)=>createHash("sha256").update(value).digest("hex");
export const fullNativeUnit="subscription-job-"+hash(fullNativeJob)+".service";
const ledger="/root/.local/state/subscription-runtime/host-jobs/"+fullNativeUnit+".json";
export const fullNativeLimits=Object.freeze({runtimeSeconds:1800,stopSeconds:180,memoryMiB:2048,tasksMax:128,cpuPercent:100});
export enum FullParentPhase {Starting="starting",Started="started"}
enum FullKernelState {Active="active",Activating="activating",Running="running",Loaded="loaded"}
enum FullOperation {Start="start",Job="job"}
const refuse=():never=>{throw new Error("TEST full managed ingress Held");};
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
  check(process.platform==="linux" && process.arch==="x64" && process.getuid?.()===0 && process.geteuid?.()===0);
  check(readFileSync("/proc/self/uid_map","utf8").trim().split(/\s+/).join(" ")==="0 0 4294967295");
  for(const ns of ["user","pid","mnt","cgroup","net","uts","ipc"]){if(ns==="mnt" && context===RootContext.Parent)continue;check(readlinkSync(`/proc/self/ns/${ns}`)===readlinkSync(`/proc/1/ns/${ns}`));}
  check(readlinkSync("/proc/self/ns/user")==="user:[4026531837]" && readlinkSync("/proc/self/ns/pid")==="pid:[4026531836]");
  check(/^NSpid:\s+1$/m.test(readFileSync("/proc/1/status","utf8")));
}
const identity=(s:Stats)=>[s.dev,s.ino,s.uid,s.gid,s.mode,...(s.isDirectory()?[]:[s.nlink,s.size,s.mtimeMs,s.ctimeMs])].map(String).join(":");
class Pins {
  private readonly held=new Map<string,{fd:number;identity:string;sha256:string|null}>();private closed=false;private readonly namespaces:number[]=[];
  mountNamespace(){const fd=openSync("/proc/self/ns/mnt",constants.O_RDONLY);this.namespaces.push(fd);return fd;}
  hold(path:string,directory=false,mode?:number):number{
    check(!this.closed);const found=this.held.get(path);if(found){if(mode!==undefined)check((fstatSync(found.fd).mode&0o7777)===mode);return found.fd;}
    const parent=path==="/"?null:this.hold(dirname(path),true);
    const fd=openSync(parent===null?"/":`/proc/self/fd/${parent}/${basename(path)}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(directory?constants.O_DIRECTORY:0));
    try{const s=fstatSync(fd);check(s.uid===0 && s.gid===0 && !(s.mode&0o022) && (directory?s.isDirectory():s.isFile() && s.nlink===1));
      if(mode!==undefined)check((s.mode&0o7777)===mode);
      check(directory || s.size<=128*1024*1024);
      this.held.set(path,{fd,identity:identity(s),sha256:directory?null:hash(readFd(fd))});return fd;
    }catch{closeSync(fd);refuse();}
  }
  publicFile(path:string,expected:string){check(digest(expected));const fd=this.hold(path);check(this.held.get(path)?.sha256===expected);return fd;}
  json(path:string,maximum:number){const fd=this.hold(path,false,0o600);check(fstatSync(fd).size<=maximum);const bytes=readFd(fd),v:unknown=JSON.parse(bytes.toString("utf8"));check(bytes.equals(Buffer.from(JSON.stringify(v)+"\n")));return v;}
  validate(){check(!this.closed);for(const [path,e] of this.held){const named=lstatSync(path),held=fstatSync(e.fd);check(!named.isSymbolicLink() && identity(named)===e.identity && identity(held)===e.identity);if(e.sha256)check(hash(readFd(e.fd))===e.sha256);}}
  close(){if(this.closed)return;this.closed=true;for(const e of [...this.held.values()].reverse())closeSync(e.fd);this.held.clear();for(const fd of this.namespaces)closeSync(fd);this.namespaces.length=0;}
}
/** A catalog is independently reviewed PUBLIC installation data, not path input.
 * It excludes protected control/auth/credentials before any leaf read. */
export function fullPublicRelative(value:unknown):value is string {
  return typeof value==="string" && value.length<=240 && /^(?:dist|node_modules|packages|scripts|host-integration)\/[A-Za-z0-9_@+./-]+$/.test(value)
    && !value.split("/").some(p=>p==="." || p===".." || /^(?:auth\.json(?:[.-].*)?|credentials?\.json(?:[.-].*)?|.*\.pem|\.env.*)$/i.test(p))
    && /\.(?:js|mjs|cjs|json|node)$/.test(value);
}
function acquire(context:RootContext=RootContext.Launcher){
  initialRoot(context);const pins=new Pins();
  try{
    pins.hold(reviewRoot,true,0o700);
    const r=fullData(pins.json(reviewPath,4096),["schemaVersion","sourceBaseSha","sourceSha","sourceTree","machineId","bootId","nodeSha256","launcherSha256","moduleSha256","parentSha256","catalogSha256","outerReviewSha256","publicReviewSha256","accountName","reviewReference","hostTools","systemdVersion","installedModules"]);
    check(r.schemaVersion===1 && r.sourceBaseSha===sourceBase && sha(r.sourceSha) && sha(r.sourceTree));
    check(typeof r.machineId==="string" && /^[a-f0-9]{32}$/.test(r.machineId) && typeof r.bootId==="string" && /^[a-f0-9-]{36}$/.test(r.bootId));
    check(r.accountName==="account-u" && typeof r.reviewReference==="string" && /^[A-Za-z0-9][A-Za-z0-9_.:/#-]{0,255}$/.test(r.reviewReference));
    for(const key of ["nodeSha256","launcherSha256","moduleSha256","parentSha256","catalogSha256","outerReviewSha256","publicReviewSha256"])check(digest(r[key]));
    check(typeof r.systemdVersion==="string" && /^systemd 255 \(255\.4[A-Za-z0-9.+~-]{0,64}\)$/.test(r.systemdVersion));
    const sourceSha=r.sourceSha,root="/var/lib/subscription-runtime-full-TEST-input/"+sourceSha,source=root+"/source",node=root+"/toolchain/bin/node";
    const modules=fullData(r.installedModules,["manager","contract","endpoint","storagePolicy","profiles","payloadGuard"]);
    for(const [path,key] of [["host-jobs/manager.mjs","manager"],["host-jobs/contract.mjs","contract"],["host-jobs/endpoint.mjs","endpoint"],["host-jobs/storage-policy.mjs","storagePolicy"],["managed-launcher/profiles.mjs","profiles"],["managed-launcher/payload-guard.mjs","payloadGuard"]] as const)pins.publicFile(integration+"/"+path,requireDigest(modules[key]));
    const tools=fullData(r.hostTools,["git","systemctl","systemdRun"]);
    for(const [path,key] of [["/usr/bin/git","git"],["/usr/bin/systemctl","systemctl"],["/usr/bin/systemd-run","systemdRun"]] as const)pins.publicFile(path,requireDigest(tools[key]));
    const systemdVersion=spawnSync("/usr/bin/systemctl",["--version"],{env:{PATH:"/usr/bin:/bin",LANG:"C"},encoding:"utf8",timeout:5000,maxBuffer:4096});
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
    check(catalog.files.length===expected.size);
    let previous="",total=0;const paths=new Set<string>();
    for(const entry of catalog.files){const row=fullData(entry,["path","sha256"]);check(fullPublicRelative(row.path) && digest(row.sha256) && row.path>previous && expected.has(row.path));previous=row.path;
      const fd=pins.publicFile(source+"/"+row.path,row.sha256);total+=fstatSync(fd).size;check(total<=512*1024*1024);paths.add(row.path);}
    for(const path of ["scripts/dependency-retention-os-test/current-full-outer.js","scripts/dependency-retention-os-test/current-full-guest.js","dist/worker-codex/codex-goal-cli.js"])check(paths.has(path));
    for(const [path,key] of [["/run/TEST-full-outer-review/input.json","outerReviewSha256"],["/run/TEST-real-codex-public-review/input.json","publicReviewSha256"]] as const){pins.hold(dirname(path),true,0o700);pins.publicFile(path,requireDigest(r[key]));pins.hold(path,false,0o600);}
    pins.hold("/srv/worker-state/account-pools/live-codex-auth/account-u",true);
    pins.hold("/srv/workers/jobs/"+fullNativeJob,true,0o700);pins.hold("/srv/workers/jobs/"+fullNativeJob+"/tmp",true,0o700);
    const git=spawnSync("/usr/bin/git",["-C",source,"rev-parse","--verify","HEAD^{tree}"],{env:{PATH:"/usr/bin:/bin",LANG:"C",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"},encoding:"utf8",timeout:5000,maxBuffer:4096});
    check(!git.error && git.status===0 && git.signal===null && git.stdout.trim()===r.sourceTree);
    const tuple=Object.freeze({sourceSha,source,root,node,parent,machineId:r.machineId,bootId:r.bootId,accountName:r.accountName});
    const namespace=readlinkSync("/proc/self/ns/mnt"),namespaceFd=pins.mountNamespace();
    if(context===RootContext.Parent)check(namespace!==readlinkSync("/proc/1/ns/mnt"));
    const validate=()=>{initialRoot(context);check(readlinkSync("/proc/self/ns/mnt")===namespace && readlinkSync(`/proc/self/fd/${namespaceFd}`)===namespace);pins.validate();check(readFileSync("/etc/machine-id","utf8").trim()===tuple.machineId && readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()===tuple.bootId);};
    validate();return {pins,tuple,validate};
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
  const data=captureFullNativeRequest(request),c=acquire();let closed=false;
  try{check(data.fingerprint===fingerprint(c.tuple.machineId,argvFor(c)) && data.payload[0]===c.tuple.node && data.payload[1]===c.tuple.parent);
    const revalidate=()=>{try{check(!closed);c.validate();record(c,false);preflightCapacity();}catch{refuse();}};revalidate();
    return Object.freeze({node:c.tuple.node,parent:c.tuple.parent,source:c.tuple.source,sourceSha:c.tuple.sourceSha,fingerprint:data.fingerprint,revalidate,close(){if(closed)return;closed=true;c.pins.close();}});
  }catch{c.pins.close();refuse();}
}
/** Two primitive command cells, copied from own descriptors with no getters. */
export function fullDataArray(value:unknown):readonly [string,string]{
  check(value!==null && typeof value==="object" && !types.isProxy(value) && Array.isArray(value) && Object.getPrototypeOf(value)===Array.prototype);
  const d=Object.getOwnPropertyDescriptors(value);check(Reflect.ownKeys(d).sort().join(",")==="0,1,length");
  for(const key of ["0","1","length"]){const v=d[key];check(v && Object.hasOwn(v,"value"));}
  check(d.length?.value===2 && typeof d["0"]?.value==="string" && typeof d["1"]?.value==="string");return [d["0"].value,d["1"].value];
}
const parentCapabilities="CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_FSETID CAP_KILL CAP_SETGID CAP_SETUID CAP_SETPCAP CAP_SYS_CHROOT CAP_SYS_PTRACE CAP_SYS_ADMIN CAP_MKNOD CAP_AUDIT_WRITE CAP_SETFCAP";
export function fullNativeInvocation(request:unknown){
  const custody=retainFullNativeLaunch(request);try{
    const properties=["Slice=subscription-runtime-hosted.slice","KillMode=control-group","SendSIGKILL=yes","Delegate=no","Restart=no","RemainAfterExit=no","ProtectSystem=strict","NoNewPrivileges=yes","MemorySwapMax=0","LimitCORE=0","AmbientCapabilities=","PassEnvironment=","UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_PROFILE OPENAI_API_KEY ANTHROPIC_API_KEY CODEX_HOME","CapabilityBoundingSet="+parentCapabilities,
      "CPUQuota=100%","CPUQuotaPeriodSec=100ms","MemoryMax=2G","TasksMax=128","RuntimeMaxSec=1800","TimeoutStopSec=180","StandardOutput=null","StandardError=null",
      "ReadWritePaths=/var/lib/subscription-runtime-os-TEST /var/lib/subscription-runtime-full-TEST-output /run/TEST-real-codex-public-download /run/TEST-real-codex-public-input /run/systemd/system /srv/workers/jobs/"+fullNativeJob,
      "BindReadOnlyPaths="+custody.source+":"+custody.source+":norbind","BindReadOnlyPaths=/run/TEST-full-outer-review:/run/TEST-full-outer-review:norbind","BindReadOnlyPaths=/run/TEST-real-codex-public-review:/run/TEST-real-codex-public-review:norbind","BindReadOnlyPaths="+reviewRoot+":"+reviewRoot+":norbind","BindReadOnlyPaths=/srv/worker-state/account-pools/live-codex-auth/account-u:/srv/worker-state/account-pools/live-codex-auth/account-u:norbind"];
    const invocation=Object.freeze({command:"/usr/bin/systemd-run",args:Object.freeze(["--description=subscription-job:"+custody.fingerprint,"--unit="+fullNativeUnit,"--working-directory="+custody.source,"--service-type=exec","--expand-environment=no","--setenv=SUBSCRIPTION_RUNTIME_HOST_JOB_ID="+fullNativeJob,"--setenv=TEST_SOURCE_SHA="+custody.sourceSha,"--setenv=HOME=/srv/workers/jobs/"+fullNativeJob,"--setenv=TMPDIR=/srv/workers/jobs/"+fullNativeJob+"/tmp","--setenv=PATH=/usr/bin:/bin","--setenv=LANG=C.UTF-8",...properties.map(p=>"--property="+p),"--",custody.node,custody.parent])});
    custody.revalidate();return {invocation,custody};
  }catch{custody.close();refuse();}
}
/** SAME original protected manager + actual service reader, no admission DTO. */
export function retainCurrentFullParent(){
  const c=acquire(RootContext.Parent);let closed=false,invocation:string|undefined,guestId:string|undefined,guestHash:string|undefined;
  const revalidate=()=>{check(!closed);c.validate();record(c,true);
    const envKeys=Object.keys(process.env);check(envKeys.length<=32 && envKeys.every(key=>["PATH","LANG","LC_ALL","HOME","TMPDIR","USER","LOGNAME","SHELL","INVOCATION_ID","SYSTEMD_EXEC_PID","JOURNAL_STREAM","SUBSCRIPTION_RUNTIME_HOST_JOB_ID","TEST_SOURCE_SHA"].includes(key)));
    check(process.env.SUBSCRIPTION_RUNTIME_HOST_JOB_ID===fullNativeJob && process.env.TEST_SOURCE_SHA===c.tuple.sourceSha && process.argv.length===2);
    check(readlinkSync("/proc/self/exe")===c.tuple.node);check(readFileSync("/proc/self/cmdline").equals(Buffer.from([c.tuple.node,c.tuple.parent,""].join("\u0000"))));
    const observed=spawnSync("/usr/bin/systemctl",["show",fullNativeUnit,"--property=LoadState,ActiveState,SubState,InvocationID,MainPID,Description,ControlGroup,ProtectSystem"],{env:{PATH:"/usr/bin:/bin",LANG:"C"},encoding:"utf8",timeout:5000,maxBuffer:4096});
    check(!observed.error && observed.status===0 && observed.signal===null);const values:Record<string,string>={};
    for(const line of observed.stdout.trimEnd().split("\n")){const n=line.indexOf("=");check(n>0 && !Object.hasOwn(values,line.slice(0,n)));values[line.slice(0,n)]=line.slice(n+1);}
    check(Object.keys(values).sort().join(",")==="ActiveState,ControlGroup,Description,InvocationID,LoadState,MainPID,ProtectSystem,SubState");
    check(values.ProtectSystem==="strict");assertReadonlyMounts(c.pins,[c.tuple.source,c.tuple.root+"/toolchain",reviewRoot,"/run/TEST-full-outer-review","/run/TEST-real-codex-public-review","/srv/worker-state/account-pools/live-codex-auth/account-u"]);
    check(values.LoadState===FullKernelState.Loaded && (values.ActiveState===FullKernelState.Active || values.ActiveState===FullKernelState.Activating) && values.SubState===FullKernelState.Running && values.MainPID===String(process.pid));
    check(typeof values.ControlGroup==="string");
    check(values.Description==="subscription-job:"+fingerprint(c.tuple.machineId,argvFor(c)) && /^[-a-zA-Z0-9_/.]+$/.test(values.ControlGroup??"") && values.ControlGroup?.endsWith("/"+fullNativeUnit));
    check(typeof values.InvocationID==="string" && /^[a-f0-9]{32}$/.test(values.InvocationID));check(process.env.INVOCATION_ID===values.InvocationID && process.env.PATH==="/usr/bin:/bin" && process.env.LANG==="C.UTF-8" && process.env.HOME==="/srv/workers/jobs/"+fullNativeJob && process.env.TMPDIR==="/srv/workers/jobs/"+fullNativeJob+"/tmp");if(invocation)check(invocation===values.InvocationID);else invocation=values.InvocationID;
    check(readFileSync("/proc/self/cgroup","utf8").trim()==="0::"+values.ControlGroup);assertParentKernelPolicy(values.ControlGroup);c.validate();record(c,true);
  };
  function seal(name:"current-full-pair.json"|"current-full-pair-invocation.json",data:unknown){
    revalidate();const parent=c.pins.hold("/srv/workers/jobs/"+fullNativeJob,true,0o700);
    const fd=openSync(`/proc/self/fd/${parent}/${name}`,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{writeFileSync(fd,JSON.stringify(data)+"\n");fsyncSync(fd);}finally{closeSync(fd);}fsyncSync(parent);revalidate();
  }
  try{revalidate();return Object.freeze({unit:fullNativeUnit,revalidate,
    registerGuest(id:string,root:string,fragmentSha256:string){
      revalidate();check(!guestId && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) && digest(fragmentSha256));
      check(root==="/var/lib/subscription-runtime-os-TEST/"+id+"/root");c.pins.hold(dirname(root),true,0o700);const rootFd=c.pins.hold(root,true,0o755),rootStat=fstatSync(rootFd),unit="TEST-retention-os-"+id+".service";
      c.pins.publicFile("/run/systemd/system/"+unit,fragmentSha256);
      const data={schemaVersion:1,jobId:fullNativeJob,parentUnit:fullNativeUnit,parentInvocationId:invocation,unit,fragmentSha256,root,rootDev:String(rootStat.dev),rootIno:String(rootStat.ino),machineId:c.tuple.machineId,bootId:c.tuple.bootId,sourceSha:c.tuple.sourceSha};
      guestHash=hash(JSON.stringify(data)+"\n");seal("current-full-pair.json",data);guestId=id;
    },
    observeGuestInvocation(id:string,guestInvocationId:string){
      revalidate();check(id===guestId && guestHash && /^[a-f0-9]{32}$/.test(guestInvocationId));const unit="TEST-retention-os-"+id+".service";
      const result=spawnSync("/usr/bin/systemctl",["show",unit,"--property=InvocationID","--value"],{env:{PATH:"/usr/bin:/bin",LANG:"C"},encoding:"utf8",timeout:5000,maxBuffer:256});
      check(!result.error && result.status===0 && result.signal===null && result.stdout.trim()===guestInvocationId);revalidate();
      seal("current-full-pair-invocation.json",{schemaVersion:1,pairSha256:guestHash,parentInvocationId:invocation,unit,guestInvocationId});
    },close(){if(closed)return;closed=true;c.pins.close();}});}catch{c.pins.close();refuse();}
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
function preflightCapacity(){
  const text=readFileSync("/proc/meminfo","utf8");check(Buffer.byteLength(text)<=65536);
  const available=[...text.matchAll(/^MemAvailable:\s+(\d+) kB$/gm)],swap=[...text.matchAll(/^SwapFree:\s+(\d+) kB$/gm)];
  check(available.length===1 && swap.length===1 && available[0]?.[1] && swap[0]?.[1]);
  check(BigInt(available[0][1])*1024n>=9n*1024n*1024n*1024n);check(BigInt(swap[0][1])>=0n);
  const path="/var/lib/subscription-runtime-os-TEST",s=lstatSync(path);check(s.isDirectory() && !s.isSymbolicLink() && s.uid===0 && s.gid===0 && (s.mode&0o7777)===0o700);
  const fs=statfsSync(path,{bigint:true});check(fs.bavail*fs.bsize>=14n*1024n*1024n*1024n && fs.ffree>=100000n);
}

/** Actual kernel caps/cgroup values, not a systemd-owned label. Linux UAPI
 * capability positions are fixed here for the reviewed fourteen-cap tuple. */
function assertParentKernelPolicy(group:string){
  const status=readFileSync("/proc/self/status","utf8");check(Buffer.byteLength(status)<=65536);
  for(const [name,expected] of [["CapBnd",0xa82c01fbn],["CapEff",0xa82c01fbn],["CapPrm",0xa82c01fbn],["CapAmb",0n]] as const){const rows=[...status.matchAll(new RegExp("^"+name+":\\s+([a-f0-9]{16})$","gm"))];check(rows.length===1 && rows[0]?.[1]);check(BigInt("0x"+rows[0][1])===expected);}
  check(/^NoNewPrivs:\s+1$/m.test(status));
  for(const [leaf,expected] of [["memory.max","2147483648"],["memory.swap.max","0"],["pids.max","128"],["cpu.max","100000 100000"]] as const)check(readFileSync("/sys/fs/cgroup"+group+"/"+leaf,"utf8").trim()===expected);
}
