import { originalHostedProjectControlGitEffectFacts, assertOriginalHostedProjectControlGitPreludeCurrent, holdOriginalHostedProjectControlAllocationError } from "./hosted-project-control-native-allocation.js";
import { OriginalControlGitOperation, OriginalControlGitRole, encodeOriginalControlGitFrame, originalControlGitArguments, originalControlGitEnvironment, originalControlGitProgram, originalControlGitReady, originalControlGitMaximumMilliseconds, originalControlGitOutputMaxBytes } from "./hosted-project-control-git-recipe.js";
import { spawn } from "node:child_process";
import { type BigIntStats, closeSync, constants, fstatSync, openSync, readFileSync, readlinkSync, readSync, writeSync, statfsSync, statSync, readdirSync } from "node:fs";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { knownFdCollectorPeer, type FdCollectorPeer } from "../core/host-infrastructure/fd-collector-profile.js";
import { assertHostedFdPreludeDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors.js";
import { hostedFdTable, type HostedFdFact } from "../provider-codex/app-server/adapters/hosted-fd-table.js";
import { retainOriginalFullProjectControlGuestEntry, retainOriginalFullProjectControlSupervisorEntry,
  originalFullProjectControlEntrySourcePaths, type OriginalFullProjectControlEntry } from "../provider-codex/app-server/adapters/hosted-full-backing-stage.js";
import { OriginalFullProjectControlPreparedCase } from "../provider-codex/app-server/adapters/hosted-project-control-source-catalog.js";
import { reserveOriginalGuestSetupOnce, reserveOriginalSupervisorSetupOnce, originalSupervisorDeadlineFrame,
  remainingOriginalPeerQueryMilliseconds, remainingOriginalSdkMilliseconds, type OriginalFullSetupClock } from "./hosted-project-control-native-handoff.js";
import { retainOriginalHostedProjectControlPeerObserver, retainOriginalHostedProjectControlSdkPeerObserver, retainOriginalHostedProjectControlGitClosure } from "./hosted-project-control-peer-observer.js";
import { originalFullPeerNode, originalFullPeerRuntime } from "./hosted-project-control-peer-recipe.js";

const guestProgram = originalFullPeerRuntime + "/scripts/dependency-retention-os-test/current-full-guest.js";
const readyLine = "TEST_sdk_guest_ready\n", frameAck = "TEST_sdk_frame_consumed\n", gateAck = "TEST_sdk_gate_consumed\n", closedAck = "TEST_sdk_gate_closed\n", completeAck = "TEST_sdk_complete\n";
enum NativeOriginPhase { Unissued = "unissued", Frame = "frame", GateConsumed = "gate_consumed", Live = "native_entry_live", Complete = "sdk_complete", Held = "held" }
let supervisorIssued = false, guestPhase = NativeOriginPhase.Unissued;
let guestEntry: OriginalFullProjectControlEntry | undefined, guestClock: OriginalFullSetupClock | undefined;
let ordinaryInput: Socket | undefined;
let guestInput: ReturnType<typeof socket> | undefined, guestError: ReturnType<typeof socket> | undefined;
let guestOutput: ReturnType<typeof socket> | undefined, guestParentBirth: string | undefined;
let guestOutputHandle: object | undefined, guestOutputSetBlocking: unknown;
// Unknown ownership is never reusable as the baseline of a subsequent launch.
const reservations = new Set<object>();
function check(value: unknown): asserts value { if (!value) throw new Error("hosted_original_native_origin_held"); }
function same(a: BigIntStats,b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs; }
function birth(pid: number): string {
  const raw = readFileSync("/proc/"+pid+"/stat","utf8"); check(Buffer.byteLength(raw)<=4096 && raw.startsWith(pid+" (") && raw.endsWith("\n"));
  const fields = raw.slice(raw.lastIndexOf(") ")+2).trim().split(/\s+/);
  check(!["Z","X","x"].includes(fields[0]??"") && /^[1-9][0-9]*$/.test(fields[19]??"")); return pid+":"+fields[19];
}
function children(pid: number): string { const raw=readFileSync("/proc/"+pid+"/task/"+pid+"/children","utf8"); check(Buffer.byteLength(raw)<=4096 && /^(?:[1-9][0-9]* )*$/.test(raw)); return raw.trim().split(/\s+/).filter(Boolean).sort().join(","); }
function absent(fd: number): void { try { fstatSync(fd); check(false); } catch(error) { check(error instanceof Error && "code" in error && error.code === "EBADF"); } }
function socket(fd: number): Readonly<{fd:number;dev:string;ino:string}> { const s=fstatSync(fd,{bigint:true}); check(s.isSocket()); return Object.freeze({fd,dev:String(s.dev),ino:String(s.ino)}); }
function streamSocket(stream: Duplex): ReturnType<typeof socket> { const handle: unknown=Reflect.get(stream,"_handle"); check(handle && typeof handle==="object"); const fd:unknown=Reflect.get(handle,"fd"); check(typeof fd==="number" && Number.isSafeInteger(fd) && fd>=0); return socket(fd); }
const originalGroupPath="/sys/fs/cgroup/system.slice/TEST-retention-supervisor.service/cgroup.procs";
function groupMembers(fd:number):string {
  const before=fstatSync(fd,{bigint:true}),buffer=Buffer.alloc(16385),size=readSync(fd,buffer,0,buffer.length,0);check(size<=16384&&statfsSync("/proc/self/fd/"+fd,{bigint:true}).type===0x63677270n);const after=fstatSync(fd,{bigint:true});check(before.dev===after.dev&&before.ino===after.ino&&before.mode===after.mode);
  const raw=buffer.subarray(0,size).toString("ascii");check(/^(?:[1-9][0-9]*\n)*$/.test(raw));const rows=raw.trim().split("\n").filter(Boolean);check(rows.length<=256&&new Set(rows).size===rows.length);return rows.sort().join(",");
}
function retainGroup():number {const fd=openSync(originalGroupPath,constants.O_RDONLY|constants.O_NOFOLLOW);const id=mount(process.pid,fd),raw=readFileSync("/proc/self/mountinfo","utf8");check(Buffer.byteLength(raw)<=1024*1024);const rows=raw.trim().split("\n").filter(row=>row.split(" ")[0]===id);check(rows.length===1&&rows[0]!.split(" ")[5]!.split(",").includes("ro"));return fd;}
function originalSocket(fact: ReturnType<typeof socket>): void { const current=socket(fact.fd); check(current.dev===fact.dev && current.ino===fact.ino); }
function mount(pid:number,fd:number): string { const raw=readFileSync("/proc/"+pid+"/fdinfo/"+fd,"utf8"); check(Buffer.byteLength(raw)<=4096); const rows=[...raw.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)]; check(rows.length===1); return rows[0]![1]!; }
async function bounded<T>(work: Promise<T>,milliseconds:number): Promise<T> {
  check(Number.isSafeInteger(milliseconds) && milliseconds>0); let timer:ReturnType<typeof setTimeout>|undefined;
  try { return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("hosted_original_native_deadline_held")),milliseconds);})]); }
  finally { if(timer) clearTimeout(timer); }
}
function nonblockingDuplex(fact:ReturnType<typeof socket>):void {originalSocket(fact);const raw=readFileSync("/proc/self/fdinfo/"+fact.fd,"utf8");check(Buffer.byteLength(raw)<=4096);const flags=/^flags:\s+([0-7]{1,12})$/m.exec(raw);check(flags);const value=Number.parseInt(flags[1]!,8);check((value&3)===2&&!!(value&0o4000));}
async function confirmWrite(endpoint:ReturnType<typeof socket>,deadline:bigint,before:()=>void,after:()=>void):Promise<void>{
  for(;;){check(process.hrtime.bigint()<deadline);before();nonblockingDuplex(endpoint);try{const count=writeSync(endpoint.fd,Buffer.from([2]));check(count===0||count===1);if(count===1){check(process.hrtime.bigint()<deadline);after();return;}}catch(error){check(error instanceof Error&&"code"in error&&["EAGAIN","EWOULDBLOCK","EINTR"].includes(String(error.code)));}await new Promise<void>(resolve=>setImmediate(resolve));}
}
async function confirmRead(endpoint:ReturnType<typeof socket>,deadline:bigint,parentBirth:string):Promise<void>{
  const buffer=Buffer.alloc(2),pid=Number(parentBirth.split(":")[0]);
  for(;;){check(process.hrtime.bigint()<deadline);originalSocket(endpoint);check(guestOutputHandle && Reflect.get(guestOutputHandle,"fd")===endpoint.fd);const setBlocking=guestOutputSetBlocking;check(typeof setBlocking==="function");check(Reflect.apply(setBlocking,guestOutputHandle,[false])===0);try{const count=readSync(endpoint.fd,buffer,0,buffer.length,null);check(count===1&&buffer[0]===2);check(process.hrtime.bigint()<deadline&&birth(pid)===parentBirth);nonblockingDuplex(endpoint);try{readSync(endpoint.fd,buffer,0,buffer.length,null);check(false);}catch(error){check(error instanceof Error&&"code"in error&&["EAGAIN","EWOULDBLOCK"].includes(String(error.code)));}return;}catch(error){check(error instanceof Error&&"code"in error&&["EAGAIN","EWOULDBLOCK","EINTR"].includes(String(error.code)));}await new Promise<void>(resolve=>setImmediate(resolve));}
}
function timeJoin(entry:OriginalFullProjectControlEntry,pid:number):void {
  entry.revalidate(); for(const name of ["user","mnt","pid","net","cgroup","uts","ipc","time","time_for_children"]) check(readlinkSync("/proc/"+pid+"/ns/"+name)===readlinkSync("/proc/self/ns/"+name));
  const offsets=readFileSync("/proc/self/timens_offsets"); check(offsets.length<=256 && offsets.equals(readFileSync("/proc/"+pid+"/timens_offsets")));
  check(readFileSync("/proc/self/cgroup").equals(readFileSync("/proc/"+pid+"/cgroup")));
}
function reciprocal(rows:ReadonlyMap<string,FdCollectorPeer>,own:ReturnType<typeof socket>,other:HostedFdFact,ownPid:number,otherPid:number):void {
  originalSocket(own); check(other.socket && other.dev===own.dev && knownFdCollectorPeer(rows,own.ino)===other.ino && knownFdCollectorPeer(rows,other.ino)===own.ino);
  const owners=[...hostedFdTable(ownPid).map(row=>({pid:ownPid,row})),...hostedFdTable(otherPid).map(row=>({pid:otherPid,row}))];
  check(owners.filter(item=>item.row.dev===own.dev && item.row.ino===own.ino).length===1 && owners.filter(item=>item.row.dev===other.dev && item.row.ino===other.ino).length===1);
}
/** The Guest has two exact authentic entry-open roles at this boundary: its
 * once clock and this native owner. Auxiliary observation is positively closed
 * before acknowledgement; no serialized descriptor list can add a role. */
function guestCensus(entry:OriginalFullProjectControlEntry,pid:number):void {
  entry.revalidate(); const authentic=entry.descriptors();
  const expected:{dev:string;ino:string;mount:string;directory:boolean}[]=[];
  for(let role=0;role<2;role++) {
    for(const path of originalFullProjectControlEntrySourcePaths) { const pins=authentic.filter(row=>row.path===path); check(pins.length===1); const pin=pins[0]!; expected.push({dev:pin.dev,ino:pin.ino,mount:pin.mountId,directory:false}); }
    for(const actor of [pid,process.pid]) { const s=statSync("/proc/"+actor,{bigint:true}),exe=statSync("/proc/"+actor+"/exe",{bigint:true}); const node=authentic.filter(row=>row.path===originalFullPeerNode);check(node.length===1); expected.push({dev:String(s.dev),ino:String(s.ino),mount:mount(process.pid,authentic.find(row=>row.path==="/proc/"+process.pid)!.fd),directory:true},{dev:String(exe.dev),ino:String(exe.ino),mount:node[0]!.mountId,directory:false}); }
  }
  const table=hostedFdTable(pid); check(table.length<=256); const regular=table.filter(row=>row.file||row.directory); check(regular.length===expected.length);
  for(const row of regular) { const at=expected.findIndex(pin=>pin.dev===row.dev && pin.ino===row.ino && pin.directory===row.directory && pin.mount===mount(pid,row.fd)); check(at>=0 && (row.flags&3)===0 && !!(row.flags&0o2000000) && !(row.flags&0o10000000));expected.splice(at,1); }
  check(expected.length===0); const counts={poll:0,event:0,pipe:0,devnull:0};
  for(const row of table.filter(row=>!row.file&&!row.directory)) { if(row.fd<=3){check(row.socket);continue;} check(!!(row.flags&0o2000000)&&!(row.flags&0o10000000));
    if(row.target==="anon_inode:[eventpoll]"&&!row.socket)counts.poll++;else if(row.target==="anon_inode:[eventfd]"&&!row.socket)counts.event++;else if(row.pipe&&/^pipe:\[[1-9][0-9]*\]$/.test(row.target))counts.pipe++;else if(row.character&&row.rdev==="259"&&(row.flags&3)===0)counts.devnull++;else check(false); }
  check(counts.poll<=8&&counts.event<=8&&counts.pipe<=32&&counts.devnull<=8);
}
/** Independent exact parent census while both causal channels remain live.
 * Two sealed entry-open roles, one owned child reservation and its original
 * readonly cgroup anchor are the entire regular-descriptor recipe. */
function supervisorCensus(entry:OriginalFullProjectControlEntry,peers:ReadonlyMap<string,FdCollectorPeer>):void {
  entry.revalidate();const pid=entry.callerPid,table=hostedFdTable(pid),authentic=entry.descriptors(),expected:{dev:string;ino:string;mount:string;directory:boolean}[]=[];
  const procMount=mount(process.pid,authentic.find(row=>row.path==="/proc/"+process.pid)!.fd),node=authentic.find(row=>row.path===originalFullPeerNode),systemd=authentic.find(row=>row.path==="/usr/lib/systemd/systemd");check(node&&systemd);
  for(let role=0;role<2;role++) {
    for(const path of originalFullProjectControlEntrySourcePaths){const pins=authentic.filter(row=>row.path===path);check(pins.length===1);const pin=pins[0]!;expected.push({dev:pin.dev,ino:pin.ino,mount:pin.mountId,directory:false});}
    for(const actor of [pid,1]){const proc=statSync("/proc/"+actor,{bigint:true}),exe=statSync("/proc/"+actor+"/exe",{bigint:true}),selected=actor===1?systemd:node;check(String(exe.dev)===selected.dev&&String(exe.ino)===selected.ino);expected.push({dev:String(proc.dev),ino:String(proc.ino),mount:procMount,directory:true},{dev:String(exe.dev),ino:String(exe.ino),mount:selected.mountId,directory:false});}
  }
  const childProc=statSync("/proc/self",{bigint:true}),childExe=statSync("/proc/self/exe",{bigint:true});expected.push({dev:String(childProc.dev),ino:String(childProc.ino),mount:procMount,directory:true},{dev:String(childExe.dev),ino:String(childExe.ino),mount:node.mountId,directory:false});
  const groupRows=table.filter(row=>row.target===originalGroupPath);check(groupRows.length===1);const group=groupRows[0]!;check(group.file&&(group.flags&3)===0&&!!(group.flags&0o2000000));const gs=statSync(originalGroupPath,{bigint:true});check(String(gs.dev)===group.dev&&String(gs.ino)===group.ino);expected.push({dev:group.dev,ino:group.ino,mount:mount(pid,group.fd),directory:false});
  const regular=table.filter(row=>row.file||row.directory);check(regular.length===expected.length);for(const row of regular){const at=expected.findIndex(pin=>pin.dev===row.dev&&pin.ino===row.ino&&pin.directory===row.directory&&pin.mount===mount(pid,row.fd));check(at>=0&&(row.flags&3)===0&&!!(row.flags&0o2000000)&&!(row.flags&0o10000000));expected.splice(at,1);}check(expected.length===0);
  const endpoints=[0,1,2,3].map(fd=>socket(fd)).map(own=>{const peer=knownFdCollectorPeer(peers,own.ino);check(peer);return {dev:own.dev,ino:peer};});const counts={poll:0,event:0,pipe:0,devnull:0};
  for(const row of table.filter(row=>!row.file&&!row.directory)){
    if(row.fd<=2){check(row.character&&row.rdev==="259"&&row.target==="/dev/null"&&(row.fd===0?(row.flags&3)===0:(row.flags&3)!==0));continue;}
    if(row.socket){check(endpoints.filter(endpoint=>endpoint.dev===row.dev&&endpoint.ino===row.ino).length===1);continue;}check(!!(row.flags&0o2000000)&&!(row.flags&0o10000000));
    if(row.target==="anon_inode:[eventpoll]")counts.poll++;else if(row.target==="anon_inode:[eventfd]")counts.event++;else if(row.pipe&&/^pipe:\[[1-9][0-9]*\]$/.test(row.target))counts.pipe++;else if(row.character&&row.rdev==="259"&&(row.flags&3)===0)counts.devnull++;else check(false);
  }
  check(endpoints.every(endpoint=>table.filter(row=>row.socket&&row.dev===endpoint.dev&&row.ino===endpoint.ino).length===1)&&counts.poll<=8&&counts.event<=8&&counts.pipe<=32&&counts.devnull<=8);
}
function write(stream:Duplex,data:Buffer,finish:boolean):Promise<void> { return new Promise((resolve,reject)=>{const failed=(error:Error)=>reject(error);stream.once("error",failed); const done=()=>{stream.removeListener("error",failed);resolve();};if(finish)stream.end(data,done);else stream.write(data,done);}); }
function guestEnvironment(entry:OriginalFullProjectControlEntry):Readonly<Record<string,string>> {
  const env:Record<string,string>={PATH:"/usr/local/bin:/usr/bin:/bin",LANG:"C",LC_ALL:"C",SYSTEMD_COLORS:"0",TEST_SOURCE_SHA:entry.sourceSha};
  const marker=process.env.SUBSCRIPTION_RUNTIME_HOST_JOB_ID;if(marker!==undefined){check(/^TEST-[A-Za-z0-9_.-]{1,123}$/.test(marker));env.SUBSCRIPTION_RUNTIME_HOST_JOB_ID=marker;}
  const consumer=process.env.TEST_FULL_RESTORE_CONSUMER;if(consumer!==undefined){check(consumer==="ordinary"||consumer==="readonly");env.TEST_FULL_RESTORE_CONSUMER=consumer;}return Object.freeze(env);
}

/** Sole fixed normal qualify spawn, selected by the original sealed positive
 * entry. No caller can supply/adopt a child, argv, deadline, FD or completion. */
export async function runOriginalFullProjectControlSupervisorOnce():Promise<Readonly<{code:number;signal:string}>> {
  check(!supervisorIssued && reservations.size===0); const entry=retainOriginalFullProjectControlSupervisorEntry();
  supervisorIssued=true;check(entry.preparedCase===OriginalFullProjectControlPreparedCase.Positive);
  const clock=reserveOriginalSupervisorSetupOnce(),selectedFrame=originalSupervisorDeadlineFrame(),selectedTimes=/^TEST_sdk_deadlines_v2:([0-9]+):([0-9]+)\n$/.exec(selectedFrame);check(selectedTimes);
  const handoffDeadline=BigInt(selectedTimes[1]!),sdkDeadline=BigInt(selectedTimes[2]!),observer=retainOriginalHostedProjectControlPeerObserver();
  entry.revalidate();const baseline=children(process.pid),group=retainGroup(),groupBaseline=groupMembers(group);remainingOriginalPeerQueryMilliseconds();
  const child=spawn(originalFullPeerNode,[guestProgram,"qualify"],{cwd:"/",env:guestEnvironment(entry),stdio:["pipe","pipe","pipe","pipe"],detached:false});
  reservations.add(child); const wholeDeadline=process.hrtime.bigint()+27n*60n*1_000_000_000n;
  const native:unknown=Reflect.get(child,"_handle"),onexit:unknown=native&&typeof native==="object"?Reflect.get(native,"onexit"):undefined;
  const streams=Array.from(child.stdio);let nativeWait:Readonly<{code:number;signal:string}>|undefined,failure:Error|undefined,childBirth:string|undefined;
  const closed=new Set<number>(); let anchor:number|undefined,exe:number|undefined,handedOff=false,drained=false;
  const terminal=new Promise<void>(resolve=>{const finish=()=>{if(nativeWait&&closed.size===4)resolve();};
    if(native&&typeof native==="object"&&typeof onexit==="function")Reflect.set(native,"onexit",function(this:unknown,code:number,signal:unknown){check(this===native&&!nativeWait&&Number.isSafeInteger(code));if(code>=0&&typeof signal==="string")nativeWait=Object.freeze({code,signal});else failure??=new Error("hosted_original_native_nonwait_held");Reflect.apply(onexit,native,[code,signal]);finish();});
    streams.forEach((stream,index)=>{if(stream){stream.once("close",()=>{closed.add(index);finish();});stream.on("error",()=>{failure??=new Error("hosted_original_native_stream_held");});}});child.on("error",()=>{failure??=new Error("hosted_original_native_spawn_held");});});
  let sdkComplete=false;
  const handoffTimer=setTimeout(()=>{if(!handedOff){failure??=new Error("hosted_original_native_handoff_deadline_held");if(!nativeWait)child.kill("SIGKILL");}},Math.max(0,Number((handoffDeadline-process.hrtime.bigint())/1_000_000n)));
  const sdkTimer=setTimeout(()=>{if(!sdkComplete){failure??=new Error("hosted_original_native_sdk_deadline_held");if(!nativeWait)child.kill("SIGKILL");}},Math.max(0,Number((sdkDeadline-process.hrtime.bigint())/1_000_000n)));
  const wholeTimer=setTimeout(()=>{failure??=new Error("hosted_original_native_whole_deadline_held");if(!nativeWait)child.kill("SIGKILL");},27*60*1000);
  let output=Buffer.alloc(0),waiter:Readonly<{line:string;resolve:()=>void;reject:(error:Error)=>void}>|undefined;
  const nextLine=(line:string)=>new Promise<void>((resolve,reject)=>{check(!waiter);waiter={line,resolve,reject};consume();});
  const consume=()=>{if(!waiter)return;const n=output.indexOf(10);if(n<0)return;const current=waiter;waiter=undefined;const line=output.subarray(0,n+1).toString("ascii");output=output.subarray(n+1);if(line===current.line)current.resolve();else current.reject(new Error("hosted_original_native_protocol_held"));};
  let stdin:Socket|undefined,stdout:Socket|undefined,stderr:Socket|undefined,gate:Duplex|undefined;
  const checkChild=()=>{remainingOriginalPeerQueryMilliseconds();entry.revalidate();check(!failure&&!nativeWait&&child.pid&&childBirth&&birth(child.pid)===childBirth&&anchor!==undefined&&exe!==undefined);timeJoin(entry,child.pid);
    const node=entry.descriptors().filter(row=>row.path===originalFullPeerNode);check(node.length===1);const a=fstatSync(exe,{bigint:true}),b=fstatSync(node[0]!.fd,{bigint:true});check(a.dev===b.dev&&a.ino===b.ino&&same(a,statSync("/proc/"+child.pid+"/exe",{bigint:true}))&&readFileSync("/proc/"+child.pid+"/cmdline").equals(Buffer.from([originalFullPeerNode,guestProgram,"qualify", ""].join("\0")))&&new RegExp("^PPid:\\s+"+process.pid+"$","m").test(readFileSync("/proc/"+child.pid+"/status","utf8")));};
  let primaryFailed = false;
  try {
    check(native&&typeof native==="object"&&typeof onexit==="function"&&streams.length===4&&child.stdin instanceof Socket&&child.stdout instanceof Socket&&child.stderr instanceof Socket&&streams[3] instanceof Duplex);
    stdin=child.stdin;stdout=child.stdout;stderr=child.stderr;gate=streams[3]; const endpoints=[stdin,stdout,stderr,gate].map(streamSocket);check(new Set(endpoints.map(row=>row.dev+":"+row.ino)).size===4);
    stdout.on("data",(chunk:Buffer)=>{if(sdkComplete)return;if(output.length+chunk.length>512){failure??=new Error("hosted_original_native_output_held");waiter?.reject(failure);child.kill("SIGKILL");return;}output=Buffer.concat([output,chunk]);consume();});stderr.on("data",()=>{if(!handedOff){failure??=new Error("hosted_original_native_stderr_held");waiter?.reject(failure);child.kill("SIGKILL");}});
    await bounded(nextLine(readyLine),remainingOriginalPeerQueryMilliseconds());check(child.pid&&child.pid>1);childBirth=birth(child.pid);anchor=openSync("/proc/"+child.pid,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);exe=openSync("/proc/self/fd/"+anchor+"/exe",constants.O_RDONLY);
    checkChild();guestCensus(entry,child.pid); const peers=await observer.query();observer.close();checkChild();guestCensus(entry,child.pid);
    const join=()=>{checkChild();const facts=hostedFdTable(child.pid!);for(const [owned,childFd]of [[endpoints[0]!,0],[endpoints[1]!,1],[endpoints[3]!,3]]as const){const peer=facts.filter(row=>row.fd===childFd);check(peer.length===1);reciprocal(peers,owned,peer[0]!,process.pid,child.pid!);}};
    join();const frame=originalSupervisorDeadlineFrame(),fields=/^TEST_sdk_deadlines_v2:([0-9]+):([0-9]+)\n$/.exec(frame);check(fields&&frame===selectedFrame&&BigInt(fields[2]!)<=wholeDeadline);await bounded(write(stdin,Buffer.from(frame),false),remainingOriginalPeerQueryMilliseconds());
    await bounded(nextLine(frameAck),remainingOriginalPeerQueryMilliseconds());join();guestCensus(entry,child.pid);await bounded(write(stdin,Buffer.alloc(0),true),remainingOriginalPeerQueryMilliseconds());await bounded(new Promise<void>(resolve=>{if(closed.has(0))resolve();else stdin!.once("close",resolve);}),remainingOriginalPeerQueryMilliseconds());absent(endpoints[0]!.fd);
    checkChild();originalSocket(endpoints[3]!);await bounded(write(gate,Buffer.from([1]),false),remainingOriginalPeerQueryMilliseconds());await bounded(nextLine(gateAck),remainingOriginalPeerQueryMilliseconds());checkChild();originalSocket(endpoints[3]!);await bounded(write(gate,Buffer.alloc(0),true),remainingOriginalPeerQueryMilliseconds());
    await bounded(nextLine(closedAck),remainingOriginalPeerQueryMilliseconds());await bounded(new Promise<void>(resolve=>{if(closed.has(3))resolve();else gate!.once("close",resolve);}),remainingOriginalPeerQueryMilliseconds());absent(endpoints[3]!.fd);checkChild();check(output.length===0);handedOff=true;clearTimeout(handoffTimer);
    await bounded(nextLine(completeAck),remainingOriginalSdkMilliseconds());entry.revalidate();check(!failure&&!nativeWait&&child.pid&&birth(child.pid)===childBirth&&process.hrtime.bigint()<sdkDeadline);check(output.length===0 && hostedFdTable(child.pid).every(row=>!row.file&&!row.directory));
    const completeJoin=(requireSdkFdAbsence:boolean)=>{remainingOriginalSdkMilliseconds();entry.revalidate();check(!failure&&!nativeWait&&child.pid&&birth(child.pid)===childBirth);if(requireSdkFdAbsence)check(hostedFdTable(child.pid).every(row=>!row.file&&!row.directory));timeJoin(entry,child.pid);const currentExe=statSync("/proc/"+child.pid+"/exe",{bigint:true});check(exe!==undefined&&same(fstatSync(exe,{bigint:true}),currentExe)&&readFileSync("/proc/"+child.pid+"/cmdline").equals(Buffer.from([originalFullPeerNode,guestProgram,"qualify", ""].join("\0"))));originalSocket(endpoints[1]!);const peer=hostedFdTable(child.pid).filter(row=>row.fd===1);check(peer.length===1);reciprocal(peers,endpoints[1]!,peer[0]!,process.pid,child.pid);};
    // Before byte delivery, actual SDK FD absence is mandatory. After delivery,
    // Guest may already open ordinary inventory handles; rejoin only stable
    // original source/birth/exe/time/socket custody, not a second SDK census.
    await confirmWrite(endpoints[1]!,sdkDeadline,()=>completeJoin(true),()=>completeJoin(false));sdkComplete=true;clearTimeout(sdkTimer);clock.close();stdout.resume();stderr.resume();
    await bounded(terminal,Math.max(1,Number((wholeDeadline-process.hrtime.bigint())/1_000_000n)+1000));check(nativeWait&&!failure&&closed.size===4);
    let stillBirth:string|undefined;try{stillBirth=birth(child.pid);}catch(error){check(error instanceof Error&&"code"in error&&error.code==="ENOENT");}check(stillBirth!==childBirth&&children(process.pid)===baseline&&groupMembers(group)===groupBaseline);drained=true;entry.revalidate();return nativeWait;
  } catch(error) {
    // A thrown undefined is still a primary failure. Cancellation and close
    // diagnostics cannot replace the original refusal.
    primaryFailed = true;
    try { if(!nativeWait)child.kill("SIGKILL"); } catch { /* Preserve primary and original reservation. */ }
    try{await bounded(terminal,1000);drained=children(process.pid)===baseline&&groupMembers(group)===groupBaseline;}catch{/* Retain exact unknown child and pins; no successor may adopt it. */}
    throw error;
  } finally {
    clearTimeout(wholeTimer);clearTimeout(handoffTimer);clearTimeout(sdkTimer);
    if(nativeWait&&closed.size===4&&drained){
      const closeErrors: unknown[] = [];
      for (const fd of [group, exe, anchor]) if (fd !== undefined) {
        try { closeSync(fd); } catch (error) { closeErrors.push(error); }
      }
      // Source/proc pins are an independent close obligation after confirmed
      // child drain. A failed auxiliary FD close must not strand those pins.
      try { entry.close(); } catch (error) { closeErrors.push(error); }
      // Unknown close retains this exact child reservation; never acknowledge
      // released custody merely because native wait and stream drain passed.
      if (closeErrors.length) {
        if (!primaryFailed) throw new AggregateError(closeErrors, "hosted_original_native_close_held");
      } else reservations.delete(child);
    }
  }
}

/** Actual inherited fd0 uses Node's original standard-input object.
 * allowHalfOpen retains that SAME endpoint with EOF for the unchanged ordinary
 * census. It is not part of SDK file/proc/tool closure and is never replaced. */
export async function consumeOriginalFullProjectControlGuestOnce():Promise<void> {
  check(guestPhase===NativeOriginPhase.Unissued);guestEntry=retainOriginalFullProjectControlGuestEntry();guestPhase=NativeOriginPhase.Frame;check(guestEntry.preparedCase===OriginalFullProjectControlPreparedCase.Positive);
  guestClock=reserveOriginalGuestSetupOnce();const entry=guestEntry,clock=guestClock,stdinFact=socket(0),stdoutFact=socket(1),gateFact=socket(3);
  const input=process.stdin;check(input instanceof Socket && !input.destroyed);const readable:unknown=Reflect.get(input,"_readableState"),writable:unknown=Reflect.get(input,"_writableState");check(readable&&typeof readable==="object"&&writable&&typeof writable==="object");
  // Use Node's original stdio object, never a second uv watcher for fd0.
  input.allowHalfOpen=true;check(Reflect.set(readable,"autoDestroy",false)&&Reflect.set(writable,"autoDestroy",false)&&Reflect.get(readable,"autoDestroy")===false&&Reflect.get(writable,"autoDestroy")===false);
  const gate=new Socket({fd:3,readable:true,writable:false});
  ordinaryInput=input;guestInput=stdinFact;guestError=socket(2);check(streamSocket(input).fd===0&&streamSocket(gate).fd===3); originalSocket(stdinFact);originalSocket(gateFact);
  let frame=Buffer.alloc(0),extra=false,eof=false,gateBytes=Buffer.alloc(0);let finishFrame:()=>void=()=>{},rejectFrame:(error:Error)=>void=()=>{};
  const frameReady=new Promise<void>((resolve,reject)=>{finishFrame=resolve;rejectFrame=reject;}); const end=new Promise<void>(resolve=>input.once("end",()=>{eof=true;resolve();}));
  input.on("data",(chunk:Buffer)=>{if(frame.includes(10)){extra=true;rejectFrame(new Error("hosted_original_native_extra_frame_held"));return;}if(frame.length+chunk.length>128){extra=true;rejectFrame(new Error("hosted_original_native_frame_bound_held"));return;}frame=Buffer.concat([frame,chunk]);if(frame.includes(10)){if(frame.indexOf(10)!==frame.length-1){extra=true;rejectFrame(new Error("hosted_original_native_extra_frame_held"));}else finishFrame();}});input.on("error",rejectFrame);input.once("end",()=>{if(!frame.includes(10))rejectFrame(new Error("hosted_original_native_truncated_frame_held"));});
  try {
    process.stdout.write(readyLine);await bounded(frameReady,clock.remainingReadMilliseconds());check(!extra&&!eof);clock.readTentativeFrameData(frame.toString("ascii"));
    const observer=retainOriginalHostedProjectControlPeerObserver(),peers=await observer.query();observer.close();entry.revalidate();timeJoin(entry,entry.callerPid);check(birth(entry.callerPid)===entry.callerBirth);
    const parentFacts=hostedFdTable(entry.callerPid);for(const own of [stdinFact,stdoutFact,socket(2),gateFact]){const peerInode=knownFdCollectorPeer(peers,own.ino);check(peerInode);const peer=parentFacts.filter(row=>row.socket&&row.dev===own.dev&&row.ino===peerInode);check(peer.length===1);reciprocal(peers,own,peer[0]!,process.pid,entry.callerPid);}
    supervisorCensus(entry,peers);remainingOriginalPeerQueryMilliseconds();check(!extra&&!eof);process.stdout.write(frameAck);await bounded(end,remainingOriginalPeerQueryMilliseconds());check(eof&&!extra);originalSocket(stdinFact);input.pause();input.unref();entry.revalidate();check(birth(entry.callerPid)===entry.callerBirth);remainingOriginalPeerQueryMilliseconds();
    const consumed=new Promise<void>((resolve,reject)=>{gate.on("data",(chunk:Buffer)=>{gateBytes=Buffer.concat([gateBytes,chunk]);if(gateBytes.length!==1||gateBytes[0]!==1)reject(new Error("hosted_original_native_gate_data_held"));else{remainingOriginalPeerQueryMilliseconds();entry.revalidate();check(birth(entry.callerPid)===entry.callerBirth);guestPhase=NativeOriginPhase.GateConsumed;process.stdout.write(gateAck);}});gate.once("end",()=>{if(guestPhase===NativeOriginPhase.GateConsumed&&gateBytes.length===1&&gateBytes[0]===1)resolve();else reject(new Error("hosted_original_native_gate_truncated_held"));});gate.once("error",reject);});
    await bounded(consumed,remainingOriginalPeerQueryMilliseconds());gate.destroy();await bounded(new Promise<void>(resolve=>{if(gate.closed)resolve();else gate.once("close",resolve);}),remainingOriginalPeerQueryMilliseconds());absent(3);entry.revalidate();remainingOriginalPeerQueryMilliseconds();check(birth(entry.callerPid)===entry.callerBirth);originalSocket(stdinFact);
    const parentGate=knownFdCollectorPeer(peers,gateFact.ino);check(parentGate);let bothClosed=false;
    for(let turn=0;turn<64;turn++){remainingOriginalPeerQueryMilliseconds();entry.revalidate();check(birth(entry.callerPid)===entry.callerBirth);if(!hostedFdTable(entry.callerPid).some(row=>row.socket&&row.dev===gateFact.dev&&row.ino===parentGate)){bothClosed=true;break;}await new Promise<void>(resolve=>setImmediate(resolve));}
    check(bothClosed);guestPhase=NativeOriginPhase.Live;guestOutput=stdoutFact;guestParentBirth=entry.callerBirth;check(streamSocket(process.stdout).fd===1);const stdoutHandle:unknown=Reflect.get(process.stdout,"_handle");check(stdoutHandle&&typeof stdoutHandle==="object"&&Reflect.get(stdoutHandle,"fd")===1);guestOutputHandle=stdoutHandle;guestOutputSetBlocking=Reflect.get(stdoutHandle,"setBlocking");check(typeof guestOutputSetBlocking==="function");nonblockingDuplex(stdoutFact);process.stdout.write(closedAck);
  }catch(error){guestPhase=NativeOriginPhase.Held;throw error;}
}
/** Internal current-origin applicability, with no receiver, path, phase or
 * deadline input. Copied selectors cannot enter or restore NativeEntryLive. */
export function assertOriginalFullProjectControlSetupCurrent():void {
  check(guestPhase===NativeOriginPhase.Live&&guestEntry&&guestClock&&guestParentBirth);
  remainingOriginalSdkMilliseconds();guestEntry.revalidate();guestClock.revalidate();
  // A genuine handoff alone cannot enroll a later/current allocation module.
  // These exact constructor/publication leaves must have been selected and held
  // by the ORIGINAL pre-submit source closure, before their first effect.
  const selected=guestEntry.descriptors();
  for(const source of ["dist/worker-codex/hosted-project-control-native-allocation.js","dist/worker-codex/protected-job-birth.js"])
    check(selected.filter(row=>row.path===originalFullPeerRuntime+"/"+source).length===1);
  check(birth(guestEntry.callerPid)===guestParentBirth);timeJoin(guestEntry,guestEntry.callerPid);remainingOriginalSdkMilliseconds();
}
/** Positive local SDK close. The longer private Supervisor child reservation
 * remains alive; fd0 retains original ordinary EOF and is not claimed closed. */
export async function completeOriginalFullProjectControlGuestSetup():Promise<void> {
  check(guestPhase===NativeOriginPhase.Live&&guestEntry&&guestClock&&guestOutput&&guestParentBirth&&reservations.size===0);const deadline=process.hrtime.bigint()+BigInt(remainingOriginalSdkMilliseconds())*1_000_000n;guestEntry.revalidate();check(birth(guestEntry.callerPid)===guestEntry.callerBirth);guestPhase=NativeOriginPhase.Complete;guestClock.close();guestEntry.close();guestClock=undefined;guestEntry=undefined;check(ordinaryInput && !ordinaryInput.destroyed);socket(0);absent(3);assertHostedFdPreludeDescriptors();process.stdout.write(completeAck);await confirmRead(guestOutput,deadline,guestParentBirth);
}

function gitChildCensus(entry:OriginalFullProjectControlEntry,pid:number,proc:number):void {
  const authentic=entry.descriptors(),expected:{dev:string;ino:string;mount:string;directory:boolean}[]=[];
  for(const path of originalFullProjectControlEntrySourcePaths){const rows=authentic.filter(row=>row.path===path);check(rows.length===1);const row=rows[0]!;expected.push({dev:row.dev,ino:row.ino,mount:row.mountId,directory:false});}
  const node=authentic.find(row=>row.path===originalFullPeerNode);check(node);
  for(const actor of [pid,process.pid,entry.callerPid]){const p=statSync("/proc/"+actor,{bigint:true}),exe=statSync("/proc/"+actor+"/exe",{bigint:true});check(String(exe.dev)===node.dev&&String(exe.ino)===node.ino);expected.push({dev:String(p.dev),ino:String(p.ino),mount:mount(process.pid,proc),directory:true},{dev:String(exe.dev),ino:String(exe.ino),mount:node.mountId,directory:false});}
  const table=hostedFdTable(pid);check(table.length<=256);const regular=table.filter(row=>row.file||row.directory);check(regular.length===expected.length);
  for(const row of regular){const at=expected.findIndex(pin=>pin.dev===row.dev&&pin.ino===row.ino&&pin.directory===row.directory&&pin.mount===mount(pid,row.fd));check(at>=0&&(row.flags&3)===0&&!!(row.flags&0o2000000)&&!(row.flags&0o10000000));expected.splice(at,1);}check(expected.length===0);
  const counts={poll:0,event:0,pipe:0,devnull:0};for(const row of table.filter(row=>!row.file&&!row.directory)){
    if(row.fd<=3){check(row.socket);continue;}check(!!(row.flags&0o2000000)&&!(row.flags&0o10000000));
    if(row.target==="anon_inode:[eventpoll]"&&!row.socket)counts.poll++;else if(row.target==="anon_inode:[eventfd]"&&!row.socket)counts.event++;else if(row.pipe&&/^pipe:\[[1-9][0-9]*\]$/.test(row.target))counts.pipe++;else if(row.character&&row.rdev==="259"&&(row.flags&3)===0)counts.devnull++;else check(false);
  }check(counts.poll<=8&&counts.event<=8&&counts.pipe<=32&&counts.devnull<=8);
}
const issuedGitEffects=new Set<number>();
type GitParentPin=Readonly<{fd:number;dev:string;ino:string;mountId:string;directory:boolean}>;
function gitParentCensus(entry:OriginalFullProjectControlEntry,role:OriginalControlGitRole,operation:OriginalControlGitOperation,revision:string|null,extra:readonly GitParentPin[],endpoints:readonly ReturnType<typeof socket>[]):void {
  const allocation=originalHostedProjectControlGitEffectFacts(role,operation,revision),selected=entry.descriptors();
  const expected=[...selected,...selected].map(row=>({dev:row.dev,ino:row.ino,mountId:row.mountId,directory:fstatSync(row.fd).isDirectory()}));
  expected.push(...allocation.descriptors.map(row=>({dev:row.dev,ino:row.ino,mountId:row.mount,directory:row.directory})),...extra);
  const table=hostedFdTable(process.pid);check(table.length<=256);const regular=table.filter(row=>row.file||row.directory);check(regular.length===expected.length);
  for(const row of regular){const at=expected.findIndex(pin=>pin.dev===row.dev&&pin.ino===row.ino&&pin.mountId===mount(process.pid,row.fd)&&pin.directory===row.directory);check(at>=0&&(row.flags&3)===0&&!!(row.flags&0o2000000)&&!(row.flags&0o10000000));expected.splice(at,1);}check(expected.length===0);
  const sockets=[socket(0),socket(1),socket(2),...endpoints];check(new Set(sockets.map(row=>row.dev+":"+row.ino)).size===sockets.length);
  const counts={poll:0,event:0,pipe:0,devnull:0};for(const row of table.filter(row=>!row.file&&!row.directory)){
    if(row.socket){check(sockets.filter(pin=>pin.fd===row.fd&&pin.dev===row.dev&&pin.ino===row.ino).length===1);continue;}check(!!(row.flags&0o2000000)&&!(row.flags&0o10000000));
    if(row.target==="anon_inode:[eventpoll]")counts.poll++;else if(row.target==="anon_inode:[eventfd]")counts.event++;else if(row.pipe&&/^pipe:\[[1-9][0-9]*\]$/.test(row.target))counts.pipe++;else if(row.character&&row.rdev==="259"&&(row.flags&3)===0)counts.devnull++;else check(false);
  }check(sockets.every(pin=>table.filter(row=>row.socket&&row.fd===pin.fd&&row.dev===pin.dev&&row.ino===pin.ino).length===1)&&counts.poll<=8&&counts.event<=8&&counts.pipe<=32&&counts.devnull<=8);
}
function taskChildren():string {
  const tasks=readdirSync("/proc/self/task").sort();check(tasks.length<=64&&tasks.every(task=>/^[1-9][0-9]*$/.test(task)));
  return tasks.map(task=>{const raw=readFileSync("/proc/self/task/"+task+"/children","utf8");check(Buffer.byteLength(raw)<=4096&&/^(?:[1-9][0-9]* )*$/.test(raw));return task+":"+raw.trim().split(/\s+/).filter(Boolean).sort().join(",");}).join(";");
}
function fdSnapshot():string {return JSON.stringify(hostedFdTable(process.pid));}
/** Internal finite execution counterpart of the allocator's direct await.
 * Its private in-flight effect is mandatory, as are the actual retained Guest
 * entry/once clock. No caller frame, path, callback or native receiver enters. */
export async function runOriginalFullProjectControlGitChild(role:OriginalControlGitRole,operation:OriginalControlGitOperation,revision:string|null):Promise<Readonly<{stdout:string;code:number;signal:string}>> {
  assertOriginalFullProjectControlSetupCurrent();check(guestEntry&&guestClock&&reservations.size===0&&ordinaryInput&&!ordinaryInput.destroyed);
  check(guestInput&&guestOutput&&guestError&&ordinaryInput===process.stdin&&ordinaryInput.readableEnded&&ordinaryInput.readableLength===0&&streamSocket(ordinaryInput).fd===0);
  originalSocket(guestInput);originalSocket(guestOutput);originalSocket(guestError);
  const entry=guestEntry,clock=guestClock,originalInput=guestInput,facts=originalHostedProjectControlGitEffectFacts(role,operation,revision);
  check(!issuedGitEffects.has(facts.sequence)&&issuedGitEffects.size<256);issuedGitEffects.add(facts.sequence);
  gitParentCensus(entry,role,operation,revision,[],[]);
  const removedWorkspace=operation===OriginalControlGitOperation.RemoveLinked?facts.descriptors.filter(row=>row.directory&&readlinkSync("/proc/self/fd/"+row.fd)===facts.workspace):[];check(operation!==OriginalControlGitOperation.RemoveLinked||removedWorkspace.length===1);
  const baselineFds=fdSnapshot(),baselineTasks=taskChildren(),baselineChildren=children(process.pid);
  const closure=retainOriginalHostedProjectControlGitClosure();let group:number|undefined,anchor:number|undefined,exe:number|undefined;
  let observer:ReturnType<typeof retainOriginalHostedProjectControlSdkPeerObserver>|undefined;
  let child:ReturnType<typeof spawn>|undefined,nativeWait:Readonly<{code:number;signal:string}>|undefined,terminal:Promise<void>|undefined;
  let selectedBirth:string|undefined,failure:Error|undefined,primaryFailed=false,drained=false,released=false;
  let timer:ReturnType<typeof setTimeout>|undefined;const closed=new Set<number>();let endpoints:ReturnType<typeof socket>[]=[];
  const actualWait=():Readonly<{code:number;signal:string}>|undefined=>nativeWait;
  let baselineGroup="",stdout=Buffer.alloc(0),stderrBytes=0;
  const deadline=process.hrtime.bigint()+BigInt(Math.min(remainingOriginalSdkMilliseconds(),originalControlGitMaximumMilliseconds))*1_000_000n;
  const remaining=()=>{assertOriginalFullProjectControlSetupCurrent();clock.revalidate();originalSocket(originalInput);check(guestOutput&&guestError);originalSocket(guestOutput);originalSocket(guestError);check(ordinaryInput&&!ordinaryInput.destroyed&&ordinaryInput===process.stdin&&ordinaryInput.readableEnded&&ordinaryInput.readableLength===0&&streamSocket(ordinaryInput).fd===0&&process.hrtime.bigint()<deadline);return Math.min(remainingOriginalSdkMilliseconds(),Math.max(1,Number((deadline-process.hrtime.bigint())/1_000_000n)));};
  const effectCurrent=()=>{remaining();entry.revalidate();closure.revalidate();originalHostedProjectControlGitEffectFacts(role,operation,revision);};
  try {
    effectCurrent();group=retainGroup();baselineGroup=groupMembers(group);
    const frame=Object.freeze({id:facts.id,role,operation,revision,deadline});originalControlGitArguments(frame);
    child=spawn(originalFullPeerNode,[originalControlGitProgram,"control-git"],{cwd:"/",env:{...originalControlGitEnvironment(),TEST_SOURCE_SHA:entry.sourceSha},stdio:["pipe","pipe","pipe","pipe"],detached:false});
    reservations.add(child);const owned=child,native:unknown=Reflect.get(owned,"_handle"),onexit:unknown=native&&typeof native==="object"?Reflect.get(native,"onexit"):undefined,streams=Array.from(owned.stdio);
    terminal=new Promise<void>(resolve=>{const finish=()=>{if(nativeWait&&closed.size===4)resolve();};
      if(native&&typeof native==="object"&&typeof onexit==="function")Reflect.set(native,"onexit",function(this:unknown,code:number,signal:unknown){
        if(this===native&&!nativeWait&&Number.isSafeInteger(code)&&code>=0&&typeof signal==="string")nativeWait=Object.freeze({code,signal});else failure??=new Error("hosted_original_git_nonwait_held");
        Reflect.apply(onexit,native,[code,signal]);finish();
      });
      streams.forEach((stream,index)=>{if(stream){stream.once("close",()=>{closed.add(index);finish();});stream.on("error",()=>{failure??=new Error("hosted_original_git_stream_held");});}});
      owned.on("error",()=>{failure??=new Error("hosted_original_git_spawn_held");});
    });
    check(native&&typeof native==="object"&&typeof onexit==="function"&&streams.length===4&&owned.stdin instanceof Socket&&owned.stdout instanceof Socket&&owned.stderr instanceof Socket&&streams[3] instanceof Duplex);
    const input=owned.stdin,output=owned.stdout,errorOutput=owned.stderr,gate=streams[3];endpoints=[input,output,errorOutput,gate].map(streamSocket);check(new Set(endpoints.map(row=>row.fd)).size===4&&new Set(endpoints.map(row=>row.dev+":"+row.ino)).size===4);
    let refuseReady:(error:Error)=>void=()=>{};
    const ready=new Promise<void>((resolve,reject)=>{refuseReady=reject;
      output.on("data",(bytes:Buffer)=>{if(stdout.length+bytes.length>originalControlGitOutputMaxBytes+Buffer.byteLength(originalControlGitReady)){failure??=new Error("hosted_original_git_output_held");reject(failure);if(!nativeWait)owned.kill("SIGKILL");return;}stdout=Buffer.concat([stdout,bytes]);if(!released&&stdout.length>=Buffer.byteLength(originalControlGitReady)){if(stdout.toString("ascii")===originalControlGitReady)resolve();else{failure??=new Error("hosted_original_git_ready_held");reject(failure);}}});
      errorOutput.on("data",(bytes:Buffer)=>{stderrBytes+=bytes.length;if(!released||stderrBytes>originalControlGitOutputMaxBytes){failure??=new Error("hosted_original_git_stderr_held");reject(failure);if(!nativeWait)owned.kill("SIGKILL");}});
      owned.once("error",()=>reject(new Error("hosted_original_git_spawn_held")));owned.once("exit",()=>{if(!released)reject(new Error("hosted_original_git_early_exit_held"));});
    });void ready.catch(()=>undefined);
    timer=setTimeout(()=>{failure??=new Error("hosted_original_git_deadline_held");refuseReady(failure!);if(!nativeWait)owned.kill("SIGKILL");},Math.max(0,Number((deadline-process.hrtime.bigint())/1_000_000n)));
    await bounded(write(input,Buffer.from(encodeOriginalControlGitFrame(frame)),false),remaining());await bounded(ready,remaining());check(!failure&&!nativeWait&&owned.pid&&owned.pid>1);
    const pid=owned.pid;selectedBirth=birth(pid);anchor=openSync("/proc/"+pid,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);exe=openSync("/proc/self/fd/"+anchor+"/exe",constants.O_RDONLY);
    const proc=fstatSync(anchor,{bigint:true}),initialExe=fstatSync(exe,{bigint:true}),node=entry.descriptors().find(row=>row.path===originalFullPeerNode);check(node&&String(initialExe.dev)===node.dev&&String(initialExe.ino)===node.ino);
    const checkChild=()=>{
      effectCurrent();assertOriginalHostedProjectControlGitPreludeCurrent();check(!failure&&!nativeWait&&birth(pid)===selectedBirth&&same(proc,statSync("/proc/"+pid,{bigint:true}))&&exe!==undefined&&same(initialExe,fstatSync(exe,{bigint:true}))&&same(initialExe,statSync("/proc/"+pid+"/exe",{bigint:true})));
      check(readFileSync("/proc/"+pid+"/cmdline").equals(Buffer.from([originalFullPeerNode,originalControlGitProgram,"control-git",""].join("\0")))&&new RegExp("^PPid:\\s+"+process.pid+"$","m").test(readFileSync("/proc/"+pid+"/status","utf8"))&&children(pid)==="");
      timeJoin(entry,pid);closure.verifyMaps(pid);check(anchor!==undefined&&exe!==undefined&&group!==undefined);gitChildCensus(entry,pid,anchor);
      const extra=[...closure.descriptors(),...[anchor,exe,group].map(fd=>{const stat=fstatSync(fd,{bigint:true});return {fd,dev:String(stat.dev),ino:String(stat.ino),mountId:mount(process.pid,fd),directory:stat.isDirectory()};})];
      gitParentCensus(entry,role,operation,revision,extra,endpoints.filter((_row,index)=>!closed.has(index)));
      const root=statSync("/proc/"+pid+"/root",{bigint:true}),self=statSync("/",{bigint:true});check(root.dev===self.dev&&root.ino===self.ino);
    };
    checkChild();observer=retainOriginalHostedProjectControlSdkPeerObserver();const peers=await bounded(observer.query(),remaining());observer.close();observer=undefined;checkChild();
    const join=()=>{checkChild();const table=hostedFdTable(pid);endpoints.forEach((own,index)=>{const peer=table.filter(row=>row.fd===index);check(peer.length===1);reciprocal(peers,own,peer[0]!,process.pid,pid);});};join();
    await bounded(write(input,Buffer.alloc(0),true),remaining());await bounded(new Promise<void>(resolve=>{if(closed.has(0))resolve();else input.once("close",resolve);}),remaining());absent(endpoints[0]!.fd);
    // fd0 EOF has now been consumed by the helper; it retains that child socket
    // through execve. The Guest's own original ordinary fd0 is never touched.
    checkChild();const table=hostedFdTable(pid);for(const index of [1,2,3]){const peer=table.find(row=>row.fd===index);check(peer);reciprocal(peers,endpoints[index]!,peer,process.pid,pid);}
    released=true;await bounded(write(gate,Buffer.from([1]),true),remaining());
    await bounded(terminal,remaining());check(nativeWait&&closed.size===4&&!failure&&process.hrtime.bigint()<deadline);
    // A fast Git command may already be reaped. Its ORIGINAL pre-gate exec and
    // signed fixed helper boundary are joined above, never post-exit /proc.
    check(children(process.pid)===baselineChildren&&taskChildren()===baselineTasks&&groupMembers(group)===baselineGroup);
    const after=hostedFdTable(process.pid);check(endpoints.every(endpoint=>!after.some(row=>row.socket&&row.dev===endpoint.dev&&row.ino===endpoint.ino)));drained=true;
    effectCurrent();const waited=actualWait();check(waited&&waited.signal===""&&(waited.code===0||operation===OriginalControlGitOperation.Filters&&waited.code===1));
    return Object.freeze({stdout:stdout.subarray(Buffer.byteLength(originalControlGitReady)).toString("utf8"),code:waited.code,signal:waited.signal});
  }catch(error){
    primaryFailed=true;holdOriginalHostedProjectControlAllocationError();
    if(child){try{if(!nativeWait)child.kill("SIGKILL");}catch{}try{if(terminal)await bounded(terminal,1000);if(nativeWait&&closed.size===4&&group!==undefined)drained=children(process.pid)===baselineChildren&&taskChildren()===baselineTasks&&groupMembers(group)===baselineGroup;}catch{}}
    throw error;
  }finally{
    if(timer)clearTimeout(timer);
    if(!child||nativeWait&&closed.size===4&&drained){
      const errors:unknown[]=[];
      if(observer)try{observer.close();}catch(error){errors.push(error);}
      for(const fd of [exe,anchor,group])if(fd!==undefined)try{closeSync(fd);absent(fd);}catch(error){errors.push(error);}
      try{closure.close();}catch(error){errors.push(error);}
      // Every independent close is attempted before the actual current FD and
      // future queued callback drain. No caller completion flag supplies it.
      try{await new Promise<void>(resolve=>setImmediate(resolve));await new Promise<void>(resolve=>setImmediate(resolve));const joined=hostedFdTable(process.pid).map(row=>{
        if(operation===OriginalControlGitOperation.RemoveLinked&&row.fd===removedWorkspace[0]!.fd&&row.target!==facts.workspace){
          const pin=removedWorkspace[0]!;check(nativeWait&&closed.size===4&&drained&&row.directory&&row.dev===pin.dev&&row.ino===pin.ino&&row.target===facts.workspace+" (deleted)"&&fstatSync(pin.fd,{bigint:true}).nlink===0n);
          return {...row,target:facts.workspace};
        }return row;
      });check(JSON.stringify(joined)===baselineFds&&taskChildren()===baselineTasks);originalSocket(originalInput);if(!primaryFailed)remaining();}catch(error){errors.push(error);}
      if(errors.length){guestPhase=NativeOriginPhase.Held;holdOriginalHostedProjectControlAllocationError();if(!primaryFailed)throw new AggregateError(errors,"hosted_original_git_close_held");}
      else if(child)reservations.delete(child);
    }
  }
}
