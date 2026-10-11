import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { retainedResourceDigest } from "../../src/core/scoped-retained-resource-contract.js";
import { digest, durable, measured, officialBaseSha256, protectedPath, tree, verifyTree } from "./assemble-newtest.mjs";
import { newtestUnifiedControlGroup } from "./newtest-cgroup.mjs";
const configPath = "/etc/subscription-runtime/native-newtest.json";
export interface NewtestConfig {
  readonly version: 1; readonly kind: "NativeOriginalNewtest"; readonly runId: string;
  readonly machineId: string; readonly sourceCommit: string; readonly storageRoot: string;
  readonly artifactDirectory: string; readonly artifactDigest: string;
  readonly baseArchive: string; readonly node: string; readonly nodeSha256: string;
  readonly preparationEndNs: string; readonly cleanupEndNs: string;
}
export function decodeConfig(input: unknown): NewtestConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid NEWTEST config");
  const c = input as NewtestConfig;
  const keys = ["version","kind","runId","machineId","sourceCommit","storageRoot","artifactDirectory","artifactDigest","baseArchive","node","nodeSha256","preparationEndNs","cleanupEndNs"];
  if (Object.keys(c).sort().join() !== keys.sort().join() || c.version !== 1 || c.kind !== "NativeOriginalNewtest" || !/^[a-f0-9]{16}$/.test(c.runId) || !/^[a-f0-9]{32}$/.test(c.machineId) || !/^[a-f0-9]{40}$/.test(c.sourceCommit) || ![c.artifactDigest,c.nodeSha256].every(s => /^[a-f0-9]{64}$/.test(s))) throw new Error("wrong NEWTEST binding");
  for (const path of [c.storageRoot,c.artifactDirectory,c.baseArchive,c.node]) if (typeof path !== "string" || !/^\/[A-Za-z0-9_./-]+$/.test(path) || resolve(path) !== path || path === "/") throw new Error("invalid NEWTEST path");
  for (const time of [c.preparationEndNs,c.cleanupEndNs]) if (!/^[1-9][0-9]{0,18}$/.test(time) || BigInt(time) > (1n << 63n) - 1n) throw new Error("invalid NEWTEST end");
  if (BigInt(c.cleanupEndNs) <= BigInt(c.preparationEndNs)) throw new Error("missing NEWTEST cleanup");
  return Object.freeze(c);
}
export const guestName = (c: NewtestConfig): string => `sr-native-newtest-${c.runId}`;
export const bootstrapUnit = (c: NewtestConfig): string => `subscription-runtime-native-newtest-${c.runId}.service`;
export function claimOnce(directory: string, config: NewtestConfig, anchor: bigint, invocation: string): void {
  if (!/^[a-f0-9]{32}$/.test(invocation)) throw new Error("missing original service invocation");
  durable(join(directory,"ownership.json"),{version:1,kind:"NativeOriginalNewtest",configDigest:retainedResourceDigest(config),runId:config.runId,unit:bootstrapUnit(config),invocation,anchorNs:anchor.toString(),preparationEndNs:config.preparationEndNs,cleanupEndNs:config.cleanupEndNs,guest:guestName(config),guestRoot:join(directory,"rootfs"),sourceCommit:config.sourceCommit});
}
export interface CommandCustody {
  readonly pid: number|null; readonly startTicks: string|null; readonly bootId: string|null;
  readonly pidNamespace: string|null; readonly ownerPid: number; readonly executable: string;
  readonly workEndNs: string; readonly cleanupEndNs: string; readonly highWaterNs: string;
  readonly stdoutEof: boolean; readonly stderrEof: boolean; readonly forcedClose: boolean;
  readonly stdoutBytes: number; readonly stderrBytes: number;
  readonly signals: readonly {signal:"SIGKILL";atNs:string;sent:boolean}[];
}
export class NewtestCommandFailure extends Error {
  constructor(message:string,readonly stdout:Buffer,readonly stderr:Buffer,readonly exit:{code:number|null;signal:NodeJS.Signals|null}|undefined,readonly custody:CommandCustody){super(message);}
}
export interface CommandResult { readonly code: number|null; readonly signal: NodeJS.Signals|null; readonly stdout: Buffer; readonly stderr: Buffer; readonly naturalClose: boolean; readonly custody:CommandCustody }
export interface CommandReservation {readonly workNs:bigint;readonly cleanupNs:bigint}
// Absolute ends cover admission, original wait and both EOFs. Failure closes
// work irrevocably but retains the same child/channels through funded cleanup.
export async function boundedCommand(command: string, args: readonly string[], end: bigint, cwd?: string, extra: Readonly<Record<string,string>> = {}, cleanupEnd = end, reservation:CommandReservation={workNs:0n,cleanupNs:0n}): Promise<CommandResult> {
  const anchor = process.hrtime.bigint();
  if (anchor >= end || cleanupEnd<end || reservation.workNs<0n || reservation.cleanupNs<0n) throw new Error("original NEWTEST command end expired");
  const executable=realpathSync(command);protectedPath(executable); if (!(lstatSync(executable).mode & 0o111)) throw new Error("nonexecutable NEWTEST command");
  const options={cwd,env:{PATH:"/usr/sbin:/usr/bin:/sbin:/bin",HOME:"/root",LC_ALL:"C",...extra},stdio:["ignore","pipe","pipe"] as ["ignore","pipe","pipe"]};
  const preparedArgs=[...args],effectNow=process.hrtime.bigint();
  if(effectNow<anchor || effectNow+reservation.workNs>=end || effectNow+reservation.cleanupNs>=cleanupEnd)throw new Error("original NEWTEST command end expired before spawn/reservation");
  const child = spawn(executable,preparedArgs,options);
  let out: Buffer = Buffer.alloc(0), err: Buffer = Buffer.alloc(0), failure: Error|undefined;
  let exited: {code:number|null;signal:NodeJS.Signals|null}|undefined, eofOut=false,eofErr=false,highWater=effectNow,outBytes=0,errBytes=0;
  let startTicks:string|null=null,bootId:string|null=null,pidNamespace:string|null=null;
  // No await or event-loop yield between birth and recording the original
  // child. Identity data describes custody; it never authorizes PID adoption.
  try{
    if(!child.pid)throw new Error("NEWTEST child birth unknown");
    const stat=readFileSync(`/proc/${child.pid}/stat`,"utf8"),fields=stat.slice(stat.lastIndexOf(")")+2).split(" ");
    if(!/^[0-9]+$/.test(fields[19]??""))throw new Error("NEWTEST child birth unknown");
    startTicks=fields[19]!;bootId=readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim();pidNamespace=readlinkSync(`/proc/${child.pid}/ns/pid`);
  }catch(error){failure=error instanceof Error?error:new Error(String(error));}
  const signals:Array<{signal:"SIGKILL";atNs:string;sent:boolean}>=[];
  const custody=(forcedClose:boolean):CommandCustody=>({pid:child.pid??null,startTicks,bootId,pidNamespace,ownerPid:process.pid,executable,workEndNs:end.toString(),cleanupEndNs:cleanupEnd.toString(),highWaterNs:highWater.toString(),stdoutEof:eofOut,stderrEof:eofErr,forcedClose,stdoutBytes:outBytes,stderrBytes:errBytes,signals:[...signals]});
  return await new Promise((accept,reject)=>{
    let settled=false,timer:NodeJS.Timeout|undefined;
    const sample=():bigint=>{const now=process.hrtime.bigint();if(now<highWater)failure??=new Error("NEWTEST original clock reversed UNKNOWN_HELD");else highWater=now;return now;};
    const settle=(forcedClose:boolean):void=>{
      if(settled)return;settled=true;if(timer)clearTimeout(timer);
      const observed=custody(forcedClose);
      if(forcedClose){child.stdout.destroy();child.stderr.destroy();child.unref();}
      if(failure)reject(new NewtestCommandFailure(failure.message+" UNKNOWN_HELD",out,err,exited,observed));
      else if(exited)accept({...exited,stdout:out,stderr:err,naturalClose:true,custody:observed});
    };
    const arm=(cutoff:bigint):void=>{
      if(timer)clearTimeout(timer);const now=sample();
      timer=setTimeout(check,Math.max(1,Number((cutoff-now+999_999n)/1_000_000n)));
    };
    const closeWork=(error:Error):void=>{
      if(settled)return;const first=!failure;failure??=error;
      const now=sample();
      if((first||signals.length===0)&&!exited&&child.pid&&now>=highWater&&now<cleanupEnd){
        const attempt:{signal:"SIGKILL";atNs:string;sent:boolean}={signal:"SIGKILL",atNs:now.toString(),sent:false};signals.push(attempt);
        try{attempt.sent=child.kill("SIGKILL");}catch(error){failure??=error instanceof Error?error:new Error(String(error));}
      }
    };
    const check=():void=>{
      if(settled)return;const now=sample();
      if(now>=end)closeWork(new Error("NEWTEST child wait/EOF original end expired"));
      if(exited&&eofOut&&eofErr){settle(false);return;}
      if(now>=cleanupEnd){closeWork(new Error("NEWTEST original wait/EOF cleanup expired"));settle(true);return;}
      arm(failure?cleanupEnd:end);
    };
    const fail=(error:Error):void=>{closeWork(error);check();};
    const data=(b:Buffer,stdout:boolean):void=>{
      if(stdout){outBytes+=b.length;out=Buffer.concat([out,b.subarray(0,Math.max(0,1048576-out.length))]);}
      else{errBytes+=b.length;err=Buffer.concat([err,b.subarray(0,Math.max(0,1048576-err.length))]);}
      if((stdout?outBytes:errBytes)>1048576)fail(new Error(`NEWTEST ${stdout?"stdout":"stderr"} capacity`));else check();
    };
    child.stdout.on("data",(b:Buffer)=>data(b,true));child.stderr.on("data",(b:Buffer)=>data(b,false));
    child.stdout.once("end",()=>{eofOut=true;check();});child.stderr.once("end",()=>{eofErr=true;check();});
    child.stdout.once("error",fail);child.stderr.once("error",fail);
    child.once("error",fail);child.once("exit",(code,signal)=>{exited={code,signal};check();});
    if(failure)closeWork(failure);check();
  });
}
const minimum=(a:bigint,b:bigint):bigint=>a<b?a:b;
const observationEnd=(end:bigint):bigint=>minimum(end,process.hrtime.bigint()+2_000_000_000n);
async function must(command:string,args:readonly string[],end:bigint,cleanupEnd=end):Promise<CommandResult>{
  const r=await boundedCommand(command,args,end,undefined,{},cleanupEnd);if(r.code!==0||r.signal!==null)throw new Error(`NEWTEST command refused ${command} (${r.code}/${r.signal}): ${r.stderr.toString().slice(0,2048)}`);return r;
}
function copyTree(from:string,to:string):void{
  protectedPath(from,true);mkdirSync(to,{recursive:true,mode:0o755});protectedPath(to,true);
  for(const row of tree(from)){const target=join(to,row.path);mkdirSync(resolve(target,".."),{recursive:true,mode:0o755});durable(target,measured(join(from,row.path)),row.mode);}
}
export function assertBootstrapCgroup(text:string,c:NewtestConfig):void{
  if(newtestUnifiedControlGroup(text)!==`/system.slice/${bootstrapUnit(c)}`)throw new Error("fixed NEWTEST service required");
}
async function serviceIdentity(c:NewtestConfig,end:bigint):Promise<string>{
  assertBootstrapCgroup(readFileSync("/proc/self/cgroup","utf8"),c);
  const r=await must("/usr/bin/systemctl",["show",bootstrapUnit(c),"--property=MainPID,InvocationID,ActiveState,SubState,Restart,KillMode,RuntimeMaxUSec"],observationEnd(end),end);
  const fields=Object.fromEntries(r.stdout.toString().trim().split("\n").map(line=>{const i=line.indexOf("=");return[line.slice(0,i),line.slice(i+1)];}));
  if(fields.MainPID!==String(process.pid)||fields.ActiveState!=="active"||fields.SubState!=="running"||fields.Restart!=="no"||fields.KillMode!=="control-group"||fields.RuntimeMaxUSec!=="20min"||!fields.InvocationID)throw new Error("wrong NEWTEST supervisor profile");
  return fields.InvocationID;
}
export async function runBootstrap():Promise<void>{
  if(process.argv.length!==2||process.platform!=="linux"||process.arch!=="x64"||process.getuid?.()!==0||process.getgid?.()!==0)throw new Error("fixed Root NEWTEST entry required");
  const anchor=process.hrtime.bigint(),c=decodeConfig(JSON.parse(measured(configPath,16384).toString()));
  const prep=BigInt(c.preparationEndNs),cleanup=BigInt(c.cleanupEndNs);
  if(anchor>=prep||prep>anchor+900_000_000_000n||cleanup>anchor+1_200_000_000_000n||cleanup<prep+60_000_000_000n)throw new Error("invalid original bootstrap allowance");
  if(readFileSync("/etc/machine-id","utf8").trim()!==c.machineId)throw new Error("wrong bootstrap machine");
  protectedPath(c.storageRoot,true);const fs=statfsSync(c.storageRoot,{bigint:true});
  if(lstatSync(c.storageRoot).dev===lstatSync("/").dev||fs.bavail*fs.bsize<5n*1024n**3n||fs.ffree<50000n)throw new Error("NEWTEST scratch unavailable");
  verifyTree(c.artifactDirectory,c.artifactDigest);
  if(digest(measured(c.baseArchive,64*1024*1024))!==officialBaseSha256||digest(measured(c.node))!==c.nodeSha256)throw new Error("wrong reviewed base/Node");
  const invocation=await serviceIdentity(c,prep),directory=join(c.storageRoot,guestName(c));
  mkdirSync(directory,{mode:0o700});claimOnce(directory,c,anchor,invocation);
  const rootfs=join(directory,"rootfs");mkdirSync(rootfs,{mode:0o700});
  let failure:unknown,guestResult:unknown;
  const checks:Array<{command:string;args:readonly string[];code:number|null;signal:NodeJS.Signals|null;stdoutSha256:string;stderrSha256:string;custody:CommandCustody}>=[];
  const step=async(command:string,args:readonly string[],end:bigint):Promise<CommandResult>=>{
    const index=checks.length;let r:CommandResult;try{r=await boundedCommand(command,args,end,undefined,{},cleanup);}catch(error){if(error instanceof NewtestCommandFailure){durable(join(directory,`command-${index}.stdout`),error.stdout);durable(join(directory,`command-${index}.stderr`),error.stderr);durable(join(directory,`command-${index}-unknown.json`),{naturalClose:false,error:error.message,exit:error.exit??null,custody:error.custody});}throw error;}
    durable(join(directory,`command-${index}.stdout`),r.stdout);durable(join(directory,`command-${index}.stderr`),r.stderr);
    checks.push({command,args,code:r.code,signal:r.signal,stdoutSha256:digest(r.stdout),stderrSha256:digest(r.stderr),custody:r.custody});
    if(r.code!==0||r.signal!==null)throw new Error("NEWTEST preparation/boot refused");return r;
  };
  try{
    await step("/usr/bin/tar",["--extract","--gzip","--file",c.baseArchive,"--directory",rootfs,"--no-same-owner"],prep);chmodSync(rootfs,0o755);
    // Only this new guest has a service-start fence during package installation.
    mkdirSync(join(rootfs,"usr/sbin"),{recursive:true,mode:0o755});durable(join(rootfs,"usr/sbin/policy-rc.d"),Buffer.from("#!/bin/sh\nexit 101\n"),0o755);
    const provision=["--quiet",`--directory=${rootfs}`,"--register=no","--settings=no","--private-users=no","--link-journal=no","--setenv=DEBIAN_FRONTEND=noninteractive","--"];
    await step("/usr/bin/systemd-nspawn",[...provision,"/usr/bin/apt-get","update"],prep);
    await step("/usr/bin/systemd-nspawn",[...provision,"/usr/bin/apt-get","--yes","--no-install-recommends","install","systemd","systemd-sysv","dbus-daemon","dbus-system-bus","libsystemd0","libpam-systemd","openssh-client","sudo","tini","util-linux","libstdc++6"],prep);
    const packages=await step("/usr/bin/systemd-nspawn",[...provision,"/usr/bin/dpkg-query","--show","--showformat=${binary:Package} ${Version}\\n"],prep);
    durable(join(directory,"stock-packages.txt"),packages.stdout);
    const version=await step("/usr/bin/systemd-nspawn",[...provision,"/usr/bin/systemctl","--version"],prep);
    if(!/^systemd 255\b/.test(version.stdout.toString()))throw new Error("stock guest is not supported v255");
    const guestMachine=digest(Buffer.from(`${c.runId}:${invocation}:${anchor}`)).slice(0,32);
    const etc=join(rootfs,"etc");
    // Base may contain empty machine-id; verify it before replacing this guest-only file.
    const machine=join(etc,"machine-id");if(existsSync(machine)&&lstatSync(machine).isSymbolicLink())throw new Error("foreign guest machine-id path");
    const { writeFileSync }=await import("node:fs");writeFileSync(machine,guestMachine+"\n",{mode:0o444});chmodSync(machine,0o444);
    const dbusId=join(rootfs,"var/lib/dbus/machine-id");if(existsSync(dbusId)&&!lstatSync(dbusId).isSymbolicLink())writeFileSync(dbusId,guestMachine+"\n",{mode:0o444});
    writeFileSync(join(etc,"hostname"),guestName(c)+"\n",{mode:0o644});
    const runtime=join(rootfs,"opt/subscription-runtime/runtime");mkdirSync(runtime,{recursive:true,mode:0o755});durable(join(runtime,"node"),measured(c.node),0o755);
    const artifact=join(rootfs,"opt/native-newtest/artifact");copyTree(c.artifactDirectory,artifact);
    const guestConfig={version:1,kind:"NativeOriginalNewtestGuest",name:guestName(c),machineId:guestMachine,sourceCommit:c.sourceCommit,artifactDigest:c.artifactDigest,timeNamespace:readlinkSync("/proc/self/ns/time"),preparationEndNs:c.preparationEndNs,cleanupEndNs:c.cleanupEndNs};
    durable(join(rootfs,"etc/native-newtest.json"),guestConfig);
    const unit="[Unit]\nAfter=dbus.service user@0.service\nRequires=dbus.service user@0.service\n[Service]\nType=exec\nRestart=no\nKillMode=control-group\nRuntimeMaxSec=600\nTimeoutStopSec=60\nExecStart=/opt/subscription-runtime/runtime/node /opt/native-newtest/artifact/admin/host-integration/native-probe/newtest-guest.mjs\nStandardOutput=append:/var/log/native-newtest.stdout\nStandardError=append:/var/log/native-newtest.stderr\n[Install]\nWantedBy=multi-user.target\n";
    mkdirSync(join(rootfs,"etc/systemd/system"),{recursive:true,mode:0o755});durable(join(rootfs,"etc/systemd/system/native-newtest.service"),Buffer.from(unit),0o644);
    mkdirSync(join(rootfs,"etc/systemd/system/multi-user.target.wants"),{recursive:true,mode:0o755});
    const { symlinkSync }=await import("node:fs");symlinkSync("../native-newtest.service",join(rootfs,"etc/systemd/system/multi-user.target.wants/native-newtest.service"));
    durable(join(directory,"before-boot.json"),{configDigest:retainedResourceDigest(c),guestConfig,packagesSha256:digest(packages.stdout),artifactDigest:retainedResourceDigest(tree(artifact))});
    // No host bind, user remap, settings file or daemonized nspawn. Only the
    // newly created exact directory and machine are available to this child.
    await step("/usr/bin/systemd-nspawn",["--quiet","--boot",`--directory=${rootfs}`,`--machine=${guestName(c)}`,"--private-users=no","--private-network","--register=no","--settings=no","--link-journal=no","--capability=CAP_SYS_ADMIN,CAP_SYS_PTRACE,CAP_SETUID,CAP_SETGID,CAP_SETPCAP","--","systemd.unit=multi-user.target"],cleanup-2_000_000_000n);
    guestResult=JSON.parse(measured(join(rootfs,"var/lib/native-newtest/result.json"),1048576).toString());
    if(!guestResult||typeof guestResult!=="object"||!("passed" in guestResult)||guestResult.passed!==true)throw new Error("guest raw closure not proven");
    // A real foreground nspawn natural close is required. Also recheck the
    // original outer service association before publishing its result.
    if(await serviceIdentity(c,cleanup)!==invocation)throw new Error("changed original bootstrap service");
  }catch(error){failure=error;}
  durable(join(directory,"result.json"),{status:failure?"UNKNOWN_HELD":"NEWTEST_RAW_GATES_PASSED",sourceCommit:c.sourceCommit,invocation,checks,guestResult:guestResult??null,error:failure instanceof Error?failure.message:failure?String(failure):null,retained:true,physicalQualified:false});
  process.stdout.write(JSON.stringify({directory,status:failure?"UNKNOWN_HELD":"NEWTEST_RAW_GATES_PASSED",retained:true})+"\n");
  // Retain every guest, including success. Unit/cgroup and mount absence must
  // be independently checked by Root before exact-path disposal.
  if(failure)process.exitCode=77;
}
if(resolve(process.argv[1]??"")===fileURLToPath(import.meta.url))runBootstrap().catch(error=>{process.stderr.write(String(error)+"\n");process.exitCode=77;});
