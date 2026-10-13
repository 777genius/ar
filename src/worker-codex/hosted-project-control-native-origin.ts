import { spawn } from "node:child_process";
import { type BigIntStats, closeSync, constants, fstatSync, openSync, readFileSync, readlinkSync, readSync, writeSync, statfsSync, statSync } from "node:fs";
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
import { retainOriginalHostedProjectControlPeerObserver } from "./hosted-project-control-peer-observer.js";
import { originalFullPeerNode, originalFullPeerRuntime } from "./hosted-project-control-peer-recipe.js";

const guestProgram = originalFullPeerRuntime + "/scripts/dependency-retention-os-test/current-full-guest.js";
const readyLine = "TEST_sdk_guest_ready\n", frameAck = "TEST_sdk_frame_consumed\n", gateAck = "TEST_sdk_gate_consumed\n", closedAck = "TEST_sdk_gate_closed\n", completeAck = "TEST_sdk_complete\n";
enum NativeOriginPhase { Unissued = "unissued", Frame = "frame", GateConsumed = "gate_consumed", Live = "native_entry_live", Complete = "sdk_complete", Held = "held" }
let supervisorIssued = false, guestPhase = NativeOriginPhase.Unissued;
let guestEntry: OriginalFullProjectControlEntry | undefined, guestClock: OriginalFullSetupClock | undefined;
let ordinaryInput: Socket | undefined;
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
  } catch(error) { if(!nativeWait)child.kill("SIGKILL");try{await bounded(terminal,1000);drained=children(process.pid)===baseline&&groupMembers(group)===groupBaseline;}catch{/* Retain exact unknown child and pins; no successor may adopt it. */}throw error; }
  finally { clearTimeout(wholeTimer);clearTimeout(handoffTimer);clearTimeout(sdkTimer);if(nativeWait&&closed.size===4&&drained){reservations.delete(child);closeSync(group);if(exe!==undefined)closeSync(exe);if(anchor!==undefined)closeSync(anchor);entry.close();} }
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
  ordinaryInput=input;check(streamSocket(input).fd===0&&streamSocket(gate).fd===3); originalSocket(stdinFact);originalSocket(gateFact);
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
/** Positive local SDK close. The longer private Supervisor child reservation
 * remains alive; fd0 retains original ordinary EOF and is not claimed closed. */
export async function completeOriginalFullProjectControlGuestSetup():Promise<void> {
  check(guestPhase===NativeOriginPhase.Live&&guestEntry&&guestClock&&guestOutput&&guestParentBirth);const deadline=process.hrtime.bigint()+BigInt(remainingOriginalSdkMilliseconds())*1_000_000n;guestEntry.revalidate();check(birth(guestEntry.callerPid)===guestEntry.callerBirth);guestPhase=NativeOriginPhase.Complete;guestClock.close();guestEntry.close();guestClock=undefined;guestEntry=undefined;check(ordinaryInput && !ordinaryInput.destroyed);socket(0);absent(3);assertHostedFdPreludeDescriptors();process.stdout.write(completeAck);await confirmRead(guestOutput,deadline,guestParentBirth);
}
