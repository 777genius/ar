import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { retainedResourceDigest } from "../../src/core/scoped-retained-resource-contract.js";
import { assembleNewtest, digest, durable, measured, nativeInstallation, verifyTree } from "./assemble-newtest.mjs";
import { boundedCommand, NewtestCommandFailure, type CommandResult, type CommandCustody } from "./newtest-bootstrap.mjs";
import { originalA0Inventory, originalA0Profile } from "./root-origin-operator.mjs";
import { isNewtestGuestCgroup } from "./newtest-cgroup.mjs";
const artifact="/opt/native-newtest/artifact",node="/opt/subscription-runtime/runtime/node",state="/var/lib/native-newtest";
interface GuestConfig {readonly version:1;readonly kind:"NativeOriginalNewtestGuest";readonly name:string;readonly machineId:string;readonly sourceCommit:string;readonly artifactDigest:string;readonly timeNamespace:string;readonly preparationEndNs:string;readonly cleanupEndNs:string}
const minimum=(a:bigint,b:bigint):bigint=>a<b?a:b;
export function finitePermit(jobId:string,machineId:string,installationDigest:string,anchor:bigint,enclosingWork:bigint,enclosingCleanup:bigint):unknown{
  const work=minimum(anchor+120_000_000_000n,enclosingWork),cleanup=minimum(anchor+180_000_000_000n,enclosingCleanup);
  if(!/^[a-z][a-z0-9-]{0,31}$/.test(jobId)||!/^[a-f0-9]{32}$/.test(machineId)||!/^[a-f0-9]{64}$/.test(installationDigest)||anchor<=0n||work<=anchor||cleanup<=work+5_000_000_000n)throw new Error("insufficient original Native allowance");
  return {version:1,kind:"NativeOriginalA0",jobId,machineId,installationDigest,profileDigest:retainedResourceDigest(originalA0Profile),manifestDigest:retainedResourceDigest(originalA0Inventory),notBeforeNs:anchor.toString(),workEndNs:work.toString(),cleanupEndNs:cleanup.toString(),coldEndNs:minimum(anchor+10_000_000_000n,work).toString()};
}
// Stock systemctl --all emits Job= for no queue. Require every requested
// property exactly once; an omitted/duplicated field cannot become readiness.
export function managerFacts(bytes:Buffer,withJob:boolean):Readonly<Record<string,string>>{
  const text=bytes.toString("utf8");if(!Buffer.from(text).equals(bytes)||!text.endsWith("\n"))throw new Error("invalid manager facts bytes");
  const keys=["ActiveState","SubState","MainPID","InvocationID",...(withJob?["Job"]:[])],fields:Record<string,string>={};
  for(const line of text.slice(0,-1).split("\n")){
    const i=line.indexOf("="),key=line.slice(0,i);
    if(i<1||!keys.includes(key)||Object.hasOwn(fields,key))throw new Error("foreign or duplicate manager fact");fields[key]=line.slice(i+1);
  }
  if(Object.keys(fields).length!==keys.length||fields.ActiveState!=="active"||fields.SubState!=="running"||!/^[1-9][0-9]*$/.test(fields.MainPID??"")||!Number.isSafeInteger(Number(fields.MainPID))||!/^[a-f0-9]{32}$/.test(fields.InvocationID??"")||(withJob&&fields.Job!==""))throw new Error("stock managers not ready");
  return Object.freeze(fields);
}
// Fixed installed HostJobs DATA envelope only. This decoder cannot choose a
// manager, profile, helper or request; Root admission stays outside this seam.
export function unwrapManagedJob(command:string,args:readonly string[],expected:unknown):unknown{
  if(command!==node||args.length!==3||args[0]!=="/opt/subscription-runtime/managed-launcher/launch.mjs"||args[1]!=="job"||args[2]!==JSON.stringify(expected))throw new Error("foreign installed managed invocation");
  const request:unknown=JSON.parse(args[2]);
  if(JSON.stringify(request)!==args[2]||retainedResourceDigest(request)!==retainedResourceDigest(expected))throw new Error("changed original managed request");
  return request;
}
// Public negative fixture only. It cannot reach any Root/permit code below.
export async function ordinaryRefusal():Promise<void>{
  if(process.argv.length!==3||process.getuid?.()!==65532||process.getgid?.()!==65532)throw new Error("actual managed ordinary identity required");
  const own=readFileSync("/proc/self/status","utf8");
  if(!/^NoNewPrivs:\s+1$/m.test(own)||["CapInh","CapPrm","CapEff","CapBnd","CapAmb"].some(key=>!new RegExp(`^${key}:\\s+0+$`,"m").test(own)))throw new Error("ordinary payload profile changed");
  const r=await boundedCommand(join(artifact,"physical/original-owner"),[],process.hrtime.bigint()+2_000_000_000n,undefined,{},process.hrtime.bigint()+4_000_000_000n);
  if(r.code!==77||r.signal!==null||r.stderr.length)throw new Error("ordinary original entry admitted");
  const data:unknown=JSON.parse(r.stdout.toString());
  if(!data||typeof data!=="object"||!("stage" in data)||data.stage!=="refused"||!("error" in data)||data.error!==1||!("effects" in data)||data.effects!==0)throw new Error("ordinary refusal missing");
  if(readFileSync(`/proc/self/task/${process.pid}/children`,"utf8").trim())throw new Error("ordinary helper survivor");
  for(const path of [nativeInstallation+"/root-installation.json","/run/subscription-runtime/native-probe/control.sock","/run/subscription-runtime/native-probe/original/bootstrap.bin"]){
    try{lstatSync(path);throw new Error("ordinary refusal changed producer state");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
  process.stdout.write(JSON.stringify({refused:true,uid:65532,gid:65532,cap0:true,nnp:true,children:0,entryExit:r.code})+"\n");
}
function readGuestConfig():GuestConfig{
  const c=JSON.parse(measured("/etc/native-newtest.json",16384).toString()) as GuestConfig;
  if(c.version!==1||c.kind!=="NativeOriginalNewtestGuest"||!/^sr-native-newtest-[a-f0-9]{16}$/.test(c.name)||!/^[a-f0-9]{32}$/.test(c.machineId)||!/^[a-f0-9]{40}$/.test(c.sourceCommit)||!/^[a-f0-9]{64}$/.test(c.artifactDigest)||!/^time:\[[0-9]+\]$/.test(c.timeNamespace)||![c.preparationEndNs,c.cleanupEndNs].every(n=>/^[1-9][0-9]{0,18}$/.test(n)))throw new Error("wrong original guest config");
  if(process.argv.length!==2||process.getuid?.()!==0||process.getgid?.()!==0||readFileSync("/etc/machine-id","utf8").trim()!==c.machineId||readFileSync("/etc/hostname","utf8").trim()!==c.name||readFileSync("/proc/1/comm","utf8").trim()!=="systemd"||readFileSync("/run/systemd/container","utf8").trim()!=="systemd-nspawn"||readlinkSync("/proc/self/ns/time")!==c.timeNamespace||readlinkSync("/proc/self/ns/time_for_children")!==c.timeNamespace||!isNewtestGuestCgroup(readFileSync("/proc/self/cgroup","utf8")))throw new Error("not original private NEWTEST guest");
  // No caller path can bind a real host project/control socket into the guest.
  const mounts=readFileSync("/proc/self/mountinfo","utf8");
  if(mounts.split("\n").some(line=>{const fields=line.split(" ");return ["/opt","/run/dbus","/run/user","/var/lib/subscription-runtime-host-policy"].includes(fields[4]??"");}))throw new Error("foreign guest bind");
  return c;
}
async function runGuest():Promise<void>{
  const c=readGuestConfig(),end=BigInt(c.cleanupEndNs),work=BigInt(c.preparationEndNs),anchor=process.hrtime.bigint();
  if(anchor>=work||end<=anchor)throw new Error("original guest budget expired");
  verifyTree(artifact,c.artifactDigest);mkdirSync(state,{mode:0o700});
  durable(join(state,"started.json"),{config:c,anchorNs:anchor.toString(),bootId:readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(),pid:process.pid,status:readFileSync("/proc/self/status","utf8"),uidMap:readFileSync("/proc/self/uid_map","utf8"),gidMap:readFileSync("/proc/self/gid_map","utf8"),pidNamespace:readlinkSync("/proc/self/ns/pid"),userNamespace:readlinkSync("/proc/self/ns/user"),cgroupNamespace:readlinkSync("/proc/self/ns/cgroup"),mountinfo:readFileSync("/proc/self/mountinfo","utf8")});
  let passed=false,failure:unknown;const checks:Array<{name:string;code:number|null;signal:NodeJS.Signals|null;stdoutSha256:string;stderrSha256:string;custody:CommandCustody}>=[];
  const run=async(name:string,command:string,args:readonly string[],cutoff=work,extra:Readonly<Record<string,string>>={}):Promise<CommandResult>=>{
    let r:CommandResult;try{r=await boundedCommand(command,args,minimum(cutoff,end-2_000_000_000n),undefined,extra,end);}catch(error){if(error instanceof NewtestCommandFailure){durable(join(state,name+".stdout"),error.stdout);durable(join(state,name+".stderr"),error.stderr);durable(join(state,name+"-unknown.json"),{naturalClose:false,error:error.message,exit:error.exit??null,custody:error.custody});}throw error;}durable(join(state,name+".stdout"),r.stdout);durable(join(state,name+".stderr"),r.stderr);checks.push({name,code:r.code,signal:r.signal,stdoutSha256:digest(r.stdout),stderrSha256:digest(r.stderr),custody:r.custody});
    if(r.code!==0||r.signal!==null)throw new Error(`guest ${name} refused`);return r;
  };
  try{
    const v=await run("systemd-version","/usr/bin/systemctl",["--version"]);if(!/^systemd 255\b/.test(v.stdout.toString()))throw new Error("guest v255 required");
    const daemonFacts=await run("daemon-original","/usr/bin/systemctl",["show","--all","dbus.service","--property=ActiveState,SubState,Job,MainPID,InvocationID"]);
    const userFacts=await run("root-user-original","/usr/bin/systemctl",["show","--all","user@0.service","--property=ActiveState,SubState,MainPID,InvocationID"]);
    const originalDaemon=managerFacts(daemonFacts.stdout,true),originalUser=managerFacts(userFacts.stdout,false);
    durable(join(state,"manager-original-facts.json"),{daemon:originalDaemon,user:originalUser});
    const daemon=JSON.parse((await run("daemon-identity",node,["-e","const fs=require('node:fs');const s=fs.statSync('/proc/'+process.argv[1]);console.log(JSON.stringify({uid:s.uid,gid:s.gid}))",originalDaemon.MainPID!])).stdout.toString()) as {uid:number;gid:number};
    // Guest-only different-device storage. Existing managed policy validates
    // actual capacity/inodes again at launch, including UID65532 boundary.
    const jobs="/var/lib/sr-native-newtest/jobs";mkdirSync(jobs,{recursive:true,mode:0o755});
    await run("guest-storage","/usr/bin/mount",["-t","tmpfs","-o","size=6G,nosuid,nodev,mode=0755","sr-native-newtest",jobs]);
    const source=join(artifact,"runtime-source"),publicPath=join(state,"transport.pub");
    const raw=generateKeyPairSync("ed25519").publicKey.export({type:"spki",format:"der"}).subarray(-32),type=Buffer.from("ssh-ed25519"),frame=Buffer.alloc(4+type.length+4+32);frame.writeUInt32BE(type.length);type.copy(frame,4);frame.writeUInt32BE(32,4+type.length);raw.copy(frame,8+type.length);
    durable(publicPath,Buffer.from("ssh-ed25519 "+frame.toString("base64")+"\n"));
    await run("hostjobs-install","/usr/bin/sh",[join(source,"host-integration/host-jobs/install"),"--ssh-public-key",publicPath]);
    await run("hostjobs-storage","/usr/bin/sh",[join(source,"host-integration/managed-launcher/install-policy"),jobs],work,{PATH:"/opt/subscription-runtime/runtime:/usr/sbin:/usr/bin:/sbin:/bin"});
    const module:unknown=await import(pathToFileURL("/opt/subscription-runtime/host-jobs/manager.mjs").href);
    if(!module||typeof module!=="object"||!("HostJobs" in module)||typeof module.HostJobs!=="function")throw new Error("missing installed managed API");
    interface Managed {start(request:unknown):Promise<unknown>;status(id:string,machine:string):Promise<unknown>}
    type ManagedRun=(command:string,args:readonly string[])=>Promise<string>;
    const Constructor=module.HostJobs as new(options:{stateDir:string;run:ManagedRun})=>Managed;
    const installedContract:unknown=await import(pathToFileURL("/opt/subscription-runtime/host-jobs/contract.mjs").href);
    if(!installedContract||typeof installedContract!=="object"||!("fingerprint" in installedContract)||typeof installedContract.fingerprint!=="function"||!("unitFor" in installedContract)||typeof installedContract.unitFor!=="function")throw new Error("missing installed managed contract");
    const fingerprint=installedContract.fingerprint as (request:unknown)=>string,unitFor=installedContract.unitFor as (jobId:string)=>string;
    const jobId=c.name+"-ordinary-refusal",payload=Object.freeze([node,join(artifact,"admin/host-integration/native-probe/newtest-guest.mjs"),"--ordinary-refusal"]),limits=Object.freeze({runtimeSeconds:60,stopSeconds:10,memoryMiB:512,tasksMax:64,cpuPercent:100,startupSeconds:300});
    const startRequest=Object.freeze({operation:"start",jobId,machineId:c.machineId,argv:payload,...limits});
    const unit=unitFor(jobId),requestFingerprint=fingerprint(startRequest);
    if(unit!=="subscription-job-"+digest(Buffer.from(jobId))+".service"||!/^[a-f0-9]{64}$/.test(requestFingerprint))throw new Error("wrong installed managed contract");
    const expectedLauncher=Object.freeze({operation:"job",unit,payload,jobId,fingerprint:requestFingerprint,limits});
    let managedLost=false,managedIndex=0;
    const managedRun:ManagedRun=async(command,args)=>{
      if(managedLost)throw new Error("original managed command UNKNOWN_HELD");
      const launch=command===node&&args[0]==="/opt/subscription-runtime/managed-launcher/launch.mjs";
      if(!launch&&command!=="/usr/bin/systemctl")throw new Error("foreign installed managed command");
      const name=`managed-command-${managedIndex++}`;
      try{
        const beforeLaunch=process.hrtime.bigint();
        if(launch&&(beforeLaunch+360_000_000_000n>=work||beforeLaunch+370_000_000_000n>=end))throw new Error("original managed preparation reservation expired");
        let actualArgs=args;
        if(launch){
          unwrapManagedJob(command,args,expectedLauncher);
          actualArgs=[...args,"--original-ends-v1",JSON.stringify({version:1,kind:"ManagedOriginalEnds",timeNamespace:c.timeNamespace,workEndNs:work.toString(),cleanupEndNs:end.toString()})];
        }
        const now=process.hrtime.bigint(),cutoff=launch?work:minimum(work,now+2_000_000_000n);
        // Direct custody is the installed Node launcher and its inherited raw
        // channels. It owns real default admission and the final effect veto.
        const r=await boundedCommand(command,actualArgs,cutoff,undefined,{XDG_RUNTIME_DIR:"/run/user/0"},end,launch?{workNs:360_000_000_000n,cleanupNs:370_000_000_000n}:undefined);
        durable(join(state,name+".stdout"),r.stdout);durable(join(state,name+".stderr"),r.stderr);durable(join(state,name+".json"),{command,args,actualCommand:command,actualArgs,code:r.code,signal:r.signal,custody:r.custody,naturalClose:r.naturalClose});
        const stdout=r.stdout.toString();
        if(r.signal!==null||(r.code!==0&&!(command==="/usr/bin/systemctl"&&args.includes("show")&&r.code===4&&stdout.includes("LoadState=not-found"))))throw Object.assign(new Error("installed managed command refused"),{code:r.code,stdout,stderr:r.stderr.toString()});
        return stdout;
      }catch(error){
        managedLost=true;
        if(error instanceof NewtestCommandFailure){durable(join(state,name+".stdout"),error.stdout);durable(join(state,name+".stderr"),error.stderr);durable(join(state,name+"-unknown.json"),{error:error.message,exit:error.exit??null,custody:error.custody});}
        throw error;
      }
    };
    const manager=new Constructor({stateDir:join(state,"host-jobs"),run:managedRun});
    const reserve=process.hrtime.bigint();
    if(reserve+360_000_000_000n>=work||reserve+370_000_000_000n>=end)throw new Error("insufficient original ordinary lifetime reservation");
    durable(join(state,"ordinary-request.json"),{jobId,machineId:c.machineId,argv:[node,join(artifact,"admin/host-integration/native-probe/newtest-guest.mjs"),"--ordinary-refusal"],reservedAtNs:reserve.toString(),workEndNs:work.toString(),cleanupEndNs:end.toString(),startupSeconds:300,runtimeSeconds:60,stopSeconds:10});
    const started=await manager.start(startRequest);
    if(managedLost)throw new Error("original managed launch UNKNOWN_HELD");durable(join(state,"ordinary-start.json"),started);
    for(;;){
      const now=process.hrtime.bigint();if(now>=work)throw new Error("original managed observation expired");
      const result=await boundedCommand("/usr/bin/systemctl",["show",unit,"--property=ActiveState,SubState,ExecMainCode,ExecMainStatus,InvocationID"],minimum(work,now+2_000_000_000n),undefined,{},end);
      const fields=Object.fromEntries(result.stdout.toString().trim().split("\n").map(line=>line.split("=",2)));
      if(result.code!==0||result.signal!==null)throw new Error("managed observation unknown");
      if(fields.ActiveState==="inactive"||fields.ActiveState==="failed"){
        if(fields.ExecMainCode!=="1"||fields.ExecMainStatus!=="0"||!fields.InvocationID)throw new Error("ordinary managed process did not pass");durable(join(state,"ordinary-unit.json"),fields);break;
      }
      await new Promise<void>(accept=>setTimeout(accept,10));
    }
    durable(join(state,"ordinary-status.json"),await manager.status(jobId,c.machineId));
    const stdout=measured(join(jobs,"jobs",jobId,"payload-logs",unit+".stdout.log"),1048576);
    const ordinary=JSON.parse(stdout.toString()) as {refused?:boolean;children?:number;uid?:number};if(!ordinary.refused||ordinary.children!==0||ordinary.uid!==65532)throw new Error("missing raw ordinary refusal");
    durable(join(state,"ordinary.stdout"),stdout);durable(join(state,"ordinary.stderr"),measured(join(jobs,"jobs",jobId,"payload-logs",unit+".stderr.log"),1048576));
    // Existing v1 fixture is build-bound to these exact installed TEST paths.
    const physical=join(artifact,"physical"),attempts=join(state,"original-owner-attempts");mkdirSync(attempts,{mode:0o700});
    await run("owner-seal",node,["--test","--test-name-pattern=original held birth commits once and survives actual environment disposal",join(physical,"host-integration/native-probe/original-owner-contracts.test.mjs")],end,{NP_ORIGINAL_OWNER:join(physical,"original-owner"),NP_ORIGINAL_OWNER_ADDON:join(physical,"original-owner.node"),NP_ORIGINAL_OWNER_REFUSAL_FIXTURE:join(physical,"original-owner-refusal-fixture"),NP_ORIGINAL_OWNER_ATTEMPTS:attempts,NP_ORIGINAL_OWNER_PRIVILEGED:"65532-seal-admitted"});
    // These fixed fixture variables select reviewed v1 TEST bytes only;
    // privilege, clocks and membership come from the actual native entry.
    const results=readdirSync(attempts).filter(name=>name.endsWith("-result.json"));
    if(results.length!==1)throw new Error("missing original owner result");const owner=JSON.parse(measured(join(attempts,results[0]!),1048576).toString()) as {joined?:boolean;code?:number;signal?:string|null};if(!owner.joined||owner.code!==0||owner.signal!==null)throw new Error("original owner join unknown");
    mkdirSync(join(nativeInstallation,"root-candidate"),{recursive:true,mode:0o755});const installation=assembleNewtest(join(nativeInstallation,"root-candidate"),artifact,c.artifactDigest,daemon.uid,daemon.gid);durable(join(state,"assembled.json"),installation);
    await run("root-install",node,[join(nativeInstallation,"root-candidate/admin/host-integration/native-probe/install-root-producer.mjs")]);
    const manifest=JSON.parse(measured(join(nativeInstallation,"root-installation.json"),65536).toString());
    mkdirSync("/run/subscription-runtime/native-probe/original",{recursive:true,mode:0o700});
    const t=process.hrtime.bigint();durable("/run/subscription-runtime/native-probe/admin-permit.json",finitePermit("native-"+c.name.slice(-16),c.machineId,retainedResourceDigest(manifest),t,work,end));
    await run("root-l0",node,[join(nativeInstallation,"admin/host-integration/native-probe/root-origin-operator.mjs")],minimum(end,t+185_000_000_000n));
    const l0=JSON.parse(measured("/run/subscription-runtime/native-probe/original/l0.json",65536).toString()) as {status?:string;principalExit?:{code?:number;signal?:string|null};stdoutEof?:boolean;stderrEof?:boolean};
    if(l0.status!=="ORIGINAL_PRODUCER_L0_RAW"||l0.principalExit?.code!==0||l0.principalExit.signal!==null||!l0.stdoutEof||!l0.stderrEof)throw new Error("independent original L0 pending");
    durable(join(state,"l0.json"),l0);passed=true;
  }catch(error){failure=error;}
  // Retain create-only partial prefixes as well as successful closure before
  // any guest shutdown. Missing final streams stay explicitly UNKNOWN_HELD.
  try{
    const original="/run/subscription-runtime/native-probe/original",retained=join(state,"original");
    let names:string[]=[];try{names=readdirSync(original);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(names.length){mkdirSync(retained,{mode:0o700});for(const name of names){if(!/^(?:bootstrap\.bin|principal\.(?:stdout|stderr)|native-prefixes\.json|l0\.json|prefix-[0-9]{4}\.json)$/.test(name))throw new Error("foreign original evidence");durable(join(retained,name),measured(join(original,name),1048576));}}
    try{durable(join(state,"admin-permit.json"),measured("/run/subscription-runtime/native-probe/admin-permit.json",8192));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }catch(error){failure=error;passed=false;}
  durable(join(state,"result.json"),{passed,scope:"three original Native NEWTEST raw gates only",machineId:c.machineId,sourceCommit:c.sourceCommit,checks,error:failure instanceof Error?failure.message:failure?String(failure):null,physicalQualified:false});
  if(!passed){process.exitCode=77;return;} // Failure retains booted guest for original bounded containment.
  const r=await boundedCommand("/usr/bin/systemctl",["--no-block","poweroff"],minimum(end,process.hrtime.bigint()+2_000_000_000n));if(r.code!==0||r.signal!==null)throw new Error("guest shutdown uncertain");
}
if(resolve(process.argv[1]??"")===fileURLToPath(import.meta.url)){
  const action=process.argv[2]==="--ordinary-refusal"?ordinaryRefusal:runGuest;
  action().catch(error=>{process.stderr.write(String(error)+"\n");process.exitCode=77;});
}
