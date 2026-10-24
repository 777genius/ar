import { SYSTEM_BUS_ARGUMENTS, SYSTEM_BUS_CONFIG, SYSTEM_BUS_SERVICE_FRAGMENT, SYSTEM_BUS_SOCKET_FRAGMENT } from "../../provider-codex/app-server/adapters/system-bus-configuration";
import {createHash} from "node:crypto";
import {closeSync,constants,fstatSync,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,readlinkSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";import {basename,dirname,join} from "node:path";import {fileURLToPath} from "node:url";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {buildOriginalUsableRecipe,originalUsablePaths as P} from "./hosted-original-usable-recipe.fixture";
import {FdCollectorRenderer,parseFdCollectorProfile,parseSystemBusInfrastructure} from "@vioxen/subscription-runtime/core";
import {HostedInstallationActivationStore} from "../hosted-installation-activation";
import {HostedManifestLimitsRevision,openHostedDependencyManifestPlacement} from "../hosted-dependency-manifest-placement";
import {withHostedActivationFence} from "@vioxen/subscription-runtime/provider-codex";
// Original Store, protected planner/Usable selector, real kernel/schema5 census,
// fence, placement and blob I/O. Only finite systemd/proc/bus/profile facts are
// projected into private TEST files. This is Source coverage, not Native proof.
const f=vi.hoisted(()=>({root:"",recipe:null as ReturnType<typeof buildOriginalUsableRecipe>|null,bytes:new Map<string,Buffer|string>(),protectedPaths:new Set<string>(),links:new Map<string,string>(),directories:new Map<string,string[]>()}));
const scratch="/mnt/TEST-original-usable-placement",volatile="/run/user/0/subscription-runtime-host-policy";
function local(path:string){
 if(f.protectedPaths.has(path))return f.root+"/source/"+createHash("sha256").update(dirname(path)).digest("hex")+"/"+basename(path);
 if([...f.protectedPaths].some(file=>dirname(file)===path))return f.root+"/source/"+createHash("sha256").update(path).digest("hex");
 if([...f.protectedPaths].some(file=>file.startsWith(path+"/")))return f.root;
 if(path===scratch||path.startsWith(scratch+"/"))return f.root+"/scratch"+path.slice(scratch.length);
 if(path==="/sys/fs/cgroup"||path.startsWith("/sys/fs/cgroup/"))return f.root+"/cgroup"+path.slice("/sys/fs/cgroup".length);
 if(path===P.policy||path.startsWith(P.policy+"/"))return f.root+"/policy"+path.slice(P.policy.length);
 if(path===volatile||path.startsWith(volatile+"/"))return f.root+"/volatile"+path.slice(volatile.length);
 if(f.recipe&&(path===f.recipe.bootstrap||f.recipe.inventory.units.some(row=>row.fragmentPath===path)))return f.root+"/source/"+createHash("sha256").update(path).digest("hex");
 if(f.recipe&&f.recipe.inventory.units.some(row=>row.fragmentPath&&row.fragmentPath.startsWith(path+"/")))return f.root;
 if(["/","/var","/var/lib","/run","/run/user","/run/user/0","/run/dbus","/mnt","/etc","/etc/subscription-runtime"].includes(path))return f.root;
 return path;
}
function mutation(path:string){const mapped=local(path);
 if(mapped===f.root||mapped.startsWith(f.root+"/"))return mapped;
 const anchored=/^\/proc\/self\/fd\/([0-9]+)(?:\/|$)/.exec(mapped);
 if(anchored){const target=readlinkSync("/proc/self/fd/"+anchored[1]);if(target===f.root||target.startsWith(f.root+"/"))return mapped;}
 throw new Error("TEST unowned filesystem mutation denied");}
vi.mock("node:url",async original=>{const actual=await original<typeof import("node:url")>();return {...actual,fileURLToPath:(url:string|URL)=>
 actual.fileURLToPath(url).replace(/\/src\/worker-codex\/application\/codex-goal-launch-input\.ts$/,"/dist/worker-codex/application/codex-goal-launch-input.js")};});
vi.mock("node:fs",async original=>{
 const real=await original<typeof import("node:fs")>();
 return {...real,
  readFileSync:(path:string|number,options?:Parameters<typeof real.readFileSync>[1])=>{if(typeof path!=="string")return real.readFileSync(path,options);
   const value=f.bytes.get(path);if(value!==undefined)return options==="utf8"?value.toString():Buffer.from(value);
   return real.readFileSync(local(path),options);},
  readdirSync:(path:string,options:Parameters<typeof real.readdirSync>[1])=>path==="/proc/self/fd"?["0","1","2"]:f.directories.get(path)??real.readdirSync(local(path),options),
  readlinkSync:(path:string)=>f.links.get(path)??f.recipe?.procLinks.get(path)??(path.includes("/ns/")?"TEST-initial-ns":real.readlinkSync(local(path))),
  statSync:(path:string,options?:Parameters<typeof real.statSync>[1])=>f.recipe?.namespaces.get(path)??real.statSync(local(path),options),
  lstatSync:(path:string,options?:Parameters<typeof real.lstatSync>[1])=>path==="/run/dbus/system_bus_socket"?{...real.lstatSync(f.root),isSocket:()=>true,isDirectory:()=>false,isFile:()=>false,mode:0o600}:real.lstatSync(local(path),options),
  fstatSync:(fd:number,options?:Parameters<typeof real.fstatSync>[1])=>fd<=2?{isFIFO:()=>true,isSocket:()=>false}:real.fstatSync(fd,options),
  openSync:(path:string,flags:number,mode?:number)=>real.openSync(flags&(real.constants.O_WRONLY|real.constants.O_RDWR|real.constants.O_CREAT)?mutation(path):local(path),flags,mode),
  rmdirSync:(path:string)=>real.rmdirSync(mutation(path)),
  renameSync:(from:string,to:string)=>real.renameSync(mutation(from),mutation(to)),
  realpathSync:(path:string)=>{const mapped=local(path),actual=real.realpathSync(mapped);return mapped===actual?path:actual;},
  mkdirSync:(path:string,options:Parameters<typeof real.mkdirSync>[1])=>real.mkdirSync(mutation(path),options),
  writeFileSync:(path:string|number,data:Parameters<typeof real.writeFileSync>[1],options?:Parameters<typeof real.writeFileSync>[2])=>real.writeFileSync(typeof path==="string"?mutation(path):path,data,options),
 };
});
vi.mock("node:fs/promises",async original=>{const real=await original<typeof import("node:fs/promises")>();return {...real,
 realpath:async(path:string)=>{const mapped=local(path),actual=await real.realpath(mapped);return mapped===actual?path:actual;},
 lstat:(path:string,options?:Parameters<typeof real.lstat>[1])=>real.lstat(local(path),options),
 open:(path:string,flags:Parameters<typeof real.open>[1],mode?:number)=>real.open(typeof flags==="number"&&flags&(constants.O_WRONLY|constants.O_RDWR|constants.O_CREAT)?mutation(path):local(path),flags,mode),
 link:(from:string,to:string)=>real.link(mutation(from),mutation(to)),unlink:(path:string)=>real.unlink(mutation(path))};});
vi.mock("node:child_process",()=>({spawnSync:(command:string,args:string[])=>{
 if(command==="/usr/bin/busctl"&&f.recipe){
  let stdout:string;if(args.includes("GetConnectionUnixProcessID"))stdout="u 1\n";
  else if(args.includes("GetUnit"))stdout='o "/org/freedesktop/systemd1/unit/dbus_2eservice"\n';
  else if(args.includes("get-property"))stdout="a(sasbttttuii) 0\n".repeat(5)+"a(sb) 0\n";
  else throw new Error("TEST unexpected bus query");return {status:0,signal:null,stdout,stderr:""};
 }
 if(command!=="/usr/bin/systemctl"||!f.recipe)throw new Error("TEST unexpected host command");let stdout="";
 if(args[0]==="show"){
  const name=args.at(-1),unit=f.recipe.inventory.units.find(row=>row.name===name)??(name==="dbus.socket"?{...f.recipe.inventory.units.find(row=>row.name==="dbus.service")!,name:"dbus.socket",fragmentPath:f.recipe.input.systemBusInfrastructure.socket.fragmentPath,controlGroup:"",mainPidBirth:null}:undefined);if(!unit)throw new Error("TEST foreign unit");
  const values:Record<string,string>={Id:unit.name,Names:[unit.name,...unit.aliases].join(" "),FragmentPath:unit.fragmentPath??"",DropInPaths:unit.dropIns.map(p=>p.path).join(" "),
   LoadState:unit.loadState,ActiveState:unit.activeState,UnitFileState:unit.unitFileState,InvocationID:unit.invocationId,Job:unit.job,Triggers:"",
   ControlGroup:unit.controlGroup,MainPID:unit.mainPidBirth?.split(":")[0]??"0",Delegate:"no"};
  if(name==="dbus.service")Object.assign(values,{SubState:"running",Restart:"no",Type:"notify",TriggeredBy:"dbus.socket",
   ExecStart:`{ path=/usr/bin/dbus-daemon ; argv[]=${["/usr/bin/dbus-daemon",...SYSTEM_BUS_ARGUMENTS].join(" ")} ; ignore_errors=no ; pid=42 ; code=(null) ; status=0/0 }`});
  if(name==="dbus.socket")Object.assign(values,{SubState:"running",Listen:"/run/dbus/system_bus_socket (Stream)",Accept:"no",Triggers:"dbus.service",SocketMode:"0600",DirectoryMode:"0755",RemoveOnStop:"yes"});
  const properties=args.find(arg=>arg.startsWith("--property="))?.slice("--property=".length).split(",")??[];
  stdout=properties.map(key=>key+"="+(values[key]??"")).join("\n")+"\n";
 }else if(args[0]==="list-units")stdout=f.recipe.inventory.units.map(row=>row.name+" loaded active running TEST\n").join("");
 else if(!["list-unit-files","list-jobs","show-environment"].includes(args[0]!))throw new Error("TEST host mutation denied");
 return {status:0,signal:null,stdout,stderr:""};
},execFile:()=>{throw new Error("TEST unexpected host execution denied");},spawn:()=>{throw new Error("TEST provider start denied");}}));
const runtime=fileURLToPath(new URL("../../../",import.meta.url)).replace(/\/$/,""),sha=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
function put(path:string,bytes:Buffer,mode=0o600){mkdirSync(dirname(local(path)),{recursive:true,mode:0o700});writeFileSync(path,bytes,{mode});}
function replace(path:string,patch:(value:Record<string,unknown>)=>void){const value=JSON.parse(readFileSync(path,"utf8")) as Record<string,unknown>;patch(value);put(path,encode(value));}
// Finite Source DATA only. Actual production parsers and protected-file
// verification run; these inert ELF bytes never execute or calibrate ss.
function profileAndBusData(r:ReturnType<typeof buildOriginalUsableRecipe>){
 const files=new Map<string,Buffer>(),elf=Buffer.alloc(64);elf.set([127,69,76,70,2,1,1]);elf.writeUInt16LE(62,18);
 const loader="/usr/lib/x86_64-linux-gnu/TEST-source-loader.so";
 function pin(path:string,bytes=elf){files.set(path,bytes);return {path,sha256:sha(bytes)};}
 function exe(path:string){const own=pin(path);return {...own,elfFiles:[own,pin(loader)]};}
 const names=["hosted-app-server-launcher.js","hosted-dependency-installer-bootstrap.js","hosted-readonly-host-launch-cli.js","hosted-readonly-runtime-bootstrap.js"];
 const profile=parseFdCollectorProfile({schemaVersion:1,renderer:FdCollectorRenderer.SsV61Signed,ss:exe("/usr/bin/ss"),node:exe(r.launch.command),
  wrappers:["/usr/bin/setpriv","/usr/bin/systemd-run","/usr/bin/tini","/usr/bin/unshare"].map(exe),
  bootstraps:[...names.map(name=>pin(runtime+"/dist/worker-codex/"+name,Buffer.from("Source TEST bootstrap "+name+"\n"))),pin(r.bootstrap,r.bootstrapBytes)],
  limits:{setupTimeoutMs:60000,collectorTimeoutMs:5000,maxOutputBytes:4194304,maxRows:65536,maxBufferedInputBytes:4194304,maxEventPoll:8,maxEventFd:8,maxPipeEndpoints:32,maxDevNullReserves:8}});
 const bus=r.input.systemBusInfrastructure;if(bus.version!==2)throw new Error("TEST expected system bus v2");const daemon=pin(bus.executable.path),busLoader=pin(bus.elfClosure[1]!.path),query=pin(bus.queryTool.path);
 const infrastructure=parseSystemBusInfrastructure({...bus,
  service:{...bus.service,fragmentSha256:pin(bus.service.fragmentPath,Buffer.from(SYSTEM_BUS_SERVICE_FRAGMENT)).sha256},
  socket:{...bus.socket,fragmentSha256:pin(bus.socket.fragmentPath,Buffer.from(SYSTEM_BUS_SOCKET_FRAGMENT)).sha256},
  config:pin(bus.config.path,Buffer.from(SYSTEM_BUS_CONFIG)),executable:daemon,elfClosure:[daemon,busLoader],queryTool:{...bus.queryTool,...query,elfClosure:[query,busLoader]}});
 return {files,profileBytes:encode(profile),nodeSha256:profile.node.sha256,infrastructure};
}
function setup(){
 f.recipe=buildOriginalUsableRecipe({runtimeDirectory:runtime});let r=f.recipe;
 const data=profileAndBusData(r);for(const path of data.files.keys())f.protectedPaths.add(path);
 for(const path of [P.policy,volatile,scratch,"/sys/fs/cgroup"])mkdirSync(local(path),{recursive:true,mode:0o700});
 mkdirSync(f.root+"/source",{mode:0o700});
 const cgroups=r.inventory.cgroups.map(row=>{mkdirSync(local("/sys/fs/cgroup"+row.path),{recursive:true,mode:0o700});const s=lstatSync("/sys/fs/cgroup"+row.path);
  return {...row,dev:String(s.dev),ino:String(s.ino)};});
 const units=r.inventory.units.map(row=>{const bytes=data.files.get(row.fragmentPath!)??Buffer.from("Source TEST pinned fragment "+row.name+"\n");put(row.fragmentPath!,bytes);return {...row,fragmentSha256:sha(bytes)};});
 const systemBusInfrastructure=data.infrastructure,profileSha256=sha(data.profileBytes),candidate={...r.candidate,profileSha256},funded={...r.funded,node:{...r.funded.node,sha256:data.nodeSha256}};
 r={...r,candidate,funded,input:{...r.input,candidate,systemBusInfrastructure},inventory:{...r.inventory,cgroups,units,systemBusInfrastructure,
  supervisor:{...r.inventory.supervisor,executable:{...r.inventory.supervisor.executable,sha256:data.nodeSha256}},collectorProfile:{...r.inventory.collectorProfile,sha256:profileSha256}}};f.recipe=r;
 const inventoryBytes=encode(r.inventory);put(P.policy+"/readonly-inventory.json",inventoryBytes);
 for(const [path,bytes]of r.privateBytes)if(path!==P.policy+"/readonly-inventory.json")put(path,bytes);
 for(const [path,bytes]of r.qualificationBytes)put(path,bytes);
 for(const [path,bytes]of data.files)put(path,bytes,path==="/usr/bin/busctl"?0o700:0o600);put(P.policy+"/fd-collector-profile.v1.json",data.profileBytes);
 put(P.qualification+"/funded-operation.json",encode(r.funded));put(P.qualification+"/usable-input.json",encode(r.input));put(P.qualification+"/usable-ready.json",encode({...r.ready,operationSha256:sha(encode(r.funded)),guestInputSha256:sha(encode(r.input))}));
 put(volatile+"/codex-readonly-stages/"+sha(runtime)+".json",encode({schemaVersion:1,runtimeDirectory:runtime,runtimeSha:r.candidate.runtimeSha,runtimeManifestSha256:r.candidate.runtimeManifestSha256}));
 f.bytes.clear();for(const [path,value]of r.procBytes)f.bytes.set(path,value);
 f.bytes.set("/proc/self/uid_map","0 0 4294967295\n");f.bytes.set("/proc/self/cgroup","0::"+r.group+"\n");
 for(const row of r.inventory.units)if(row.mainPidBirth){const [pid,birth]=row.mainPidBirth.split(":");f.bytes.set(`/proc/${pid}/stat`,pid+" (worker) "+["S","1",...Array(17).fill("0"),birth!].join(" "));
  f.bytes.set(`/proc/${pid}/cgroup`,"0::"+row.controlGroup+"\n");}
 const busPid=r.inventory.units.find(row=>row.name==="dbus.service")!.mainPidBirth!.split(":")[0]!;
 f.links.set(`/proc/${busPid}/exe`,systemBusInfrastructure.executable.path);f.links.set(`/proc/${busPid}/fd/3`,"socket:[900]");f.links.set("/proc/1/fd/3","socket:[900]");
 f.directories.set(`/proc/${busPid}/fd`,["3"]);f.directories.set("/proc/1/fd",["3"]);
 f.bytes.set(`/proc/${busPid}/cmdline`,[systemBusInfrastructure.executable.path,...SYSTEM_BUS_ARGUMENTS,""].join("\0"));
 f.bytes.set(`/proc/${busPid}/maps`,systemBusInfrastructure.elfClosure.map((pin,i)=>`${i+1}000-${i+2}000 r-xp 0000 01:01 ${i+1} ${pin.path}\n`).join(""));
 f.bytes.set("/proc/net/unix","Num RefCount Protocol Flags Type St Inode Path\n0000: 00000002 00000000 00010000 0001 01 900 /run/dbus/system_bus_socket\n");
 for(const row of r.inventory.cgroups)f.bytes.set("/sys/fs/cgroup"+row.path+"/cgroup.procs",row.members.map(m=>m.birth.split(":")[0]).join("\n"));
 for(const dir of ["ordinary-origins","ordinary-starts","ordinary-completed","codex-readonly-custody","codex-readonly-revoked"])mkdirSync(local(P.policy+"/"+dir),{mode:0o700});
 const fd=openSync(scratch,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 try{const stat=fstatSync(fd),mountId=/^mnt_id:\s+([1-9][0-9]*)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`,"utf8"))?.[1];if(!mountId)throw new Error("TEST no Linux scratch mount");
  // Project only the finite Source namespace observation. Keep the real
  // scratch descriptor's mount/device identity; no Native mount proof claim.
  const observed=readFileSync("/proc/self/mountinfo"),rows=observed.toString("utf8").trimEnd().split("\n").filter(line=>line.split(" ")[0]===mountId);
  if(rows.length!==1)throw new Error("TEST scratch mount observation ambiguous");
  const device=rows[0]!.split(" ")[2],dev=BigInt(stat.dev),major=((dev>>8n)&0xfffn)|((dev>>32n)&~0xfffn),minor=(dev&0xffn)|((dev>>12n)&~0xffn);
  if(device!==`${major}:${minor}`)throw new Error("TEST scratch descriptor device mismatch");
  console.info(JSON.stringify({SourceOnly:true,Native:false,actualMountObservation:{bytes:observed.length,sha256:sha(observed),scratchMountId:mountId,scratchDev:String(stat.dev)}}));
  f.bytes.set("/proc/self/mountinfo",`${mountId} 0 ${device} / ${scratch} rw - TEST /dev/TEST-source-scratch rw\n`);
  put(P.policy+"/dependency-manifest-storage-policy.json",encode({version:1,scratchRoot:{canonicalPath:scratch,dev:String(stat.dev),ino:String(stat.ino),mountId},bootId:r.inventory.bootId,
   limitsRevision:HostedManifestLimitsRevision.TestUnqualifiedV1}));
 }finally{closeSync(fd);}return r;
}
beforeEach(()=>{f.root=mkdtempSync(join(tmpdir(),"original-usable-placement-"));f.bytes.clear();f.protectedPaths.clear();f.links.clear();f.directories.clear();f.recipe=null;});
afterEach(()=>{rmSync(f.root,{recursive:true,force:true});f.recipe=null;vi.restoreAllMocks();});
describe.skipIf(process.platform!=="linux")("original Usable Store schema5 placement",()=>{
 it("installs CLOSED through actual Store/schema5 census, preserves raw SDK and opens the same placed blobs",async()=>{
  const r=setup(),raw=JSON.stringify(r.launch);const installed=new HostedInstallationActivationStore().install();expect(installed.phase).toBe("CLOSED");
  const host=JSON.parse(readFileSync(P.policy+"/host-installation.json","utf8")),placement=JSON.parse(readFileSync(P.policy+"/dependency-manifest-placement.json","utf8"));
  expect(placement.installation).toEqual(host);expect(host.inventorySha256).toBe(sha(readFileSync(P.policy+"/readonly-inventory.json")));
  const store=await openHostedDependencyManifestPlacement(),bytes=Buffer.from("Source original Usable placed manifest\n");
  try{const digest=await store.put(bytes);expect(await store.get(digest)).toEqual(bytes);}finally{await store.close();}
  withHostedActivationFence(fence=>store.assertCurrent(fence));expect(JSON.stringify(r.launch)).toBe(raw);
 });
 it("refuses a different published installation nonce after actual fresh placement",async()=>{
  setup();new HostedInstallationActivationStore().install();
  replace(P.policy+"/host-installation.json",value=>{value.installationId="prior-installation";});
  await expect(openHostedDependencyManifestPlacement()).rejects.toThrow();
 });
 it.each(["stage","inventory","ready","broker"] as const)("refuses changed %s before installation publication",mode=>{
  const r=setup();if(mode==="stage")replace(volatile+"/codex-readonly-stages/"+sha(runtime)+".json",v=>{v.runtimeSha="9".repeat(40);});
  if(mode==="inventory")replace(P.policy+"/readonly-inventory.json",v=>{(v.supervisor as Record<string,unknown>).bootstrap={path:r.bootstrap,sha256:"9".repeat(64)};});
  if(mode==="ready")replace(P.qualification+"/usable-ready.json",v=>{v.guestInputSha256="9".repeat(64);});
  if(mode==="broker")replace(P.registry+"/"+P.jobId+"/job.json",v=>{v.authRootDir=P.auth+"-foreign";});
  expect(()=>new HostedInstallationActivationStore().install()).toThrow();expect(()=>readFileSync(P.policy+"/host-installation.json")).toThrow();
 });
});
