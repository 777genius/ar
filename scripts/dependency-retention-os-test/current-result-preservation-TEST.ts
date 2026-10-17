/** DATA assertions at the EXISTING original H1 parent-crash/recovery seam only.
 * No fault producer, terminal publisher, auth exception or execution authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { assertHostedForegroundResult, readHostedForegroundLaunchObservation, type HostedForegroundResult } from "../../dist/provider-codex/app-server/adapters/hosted-fd-launch.js";
import { hostedDependencyJobRoot } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { readHostedForegroundResultRecord } from "../../dist/worker-codex/hosted-foreground-result.js";
import { readCodexGoalResultSummary } from "../../dist/worker-codex/codex-goal-status-files.js";
import { pinReferenceFile } from "../../dist/worker-codex/hosted-dependency-legacy-reference-records.js";
import { assertRootScope, type CurrentColdHotRoots } from "./current-cold-hot-root.js";
type Ref=ReturnType<typeof pinReferenceFile>["reference"];
export type CompletedRuntimePreservationData=Readonly<{version:1;purpose:"TEST_completed_runtime_removal_crash_DATA_only";jobId:string;unit:string;startId:string;exitCode:0;status:"done";summarySha256:string;result:Ref;stdout:Ref;stderr:Ref}>;
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
function selected(jobId:string){assert(/^TEST-os-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(jobId));return hostedDependencyJobRoot(jobId)+"/state/TEST-result.json";}
function logPath(unit:string,kind:"stdout"|"stderr"){assert(/^subscription-runtime-ordinary-[a-f0-9-]{36}\.service$/.test(unit));return "/var/lib/subscription-runtime-host-policy/foreground-output/"+unit+"."+kind;}
// Existing reference-record reader rejects empty records; FDA stdout/stderr may
// legitimately be empty. This DATA pin permits empty bounded regular files.
function pinTerminalData(path:string,max:number):Readonly<{reference:Ref}>{
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const before=fstatSync(fd,{bigint:true}),named=lstatSync(path,{bigint:true});
  const same=(s:typeof before)=>{assert(s.isFile()&&!s.isSymbolicLink()&&s.uid===0n&&s.nlink===1n&&(s.mode&0o077n)===0n);for(const key of ["dev","ino","size","mode","uid","gid","nlink","mtimeNs","ctimeNs"] as const)assert.equal(s[key],before[key]);};
  assert(before.size>=0n&&before.size<=BigInt(max));same(before);same(named);const bytes=Buffer.alloc(Number(before.size));let offset=0;
  while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);assert(count>0);offset+=count;}assert.equal(readSync(fd,Buffer.alloc(1),0,1,offset),0);same(fstatSync(fd,{bigint:true}));same(lstatSync(path,{bigint:true}));
  return Object.freeze({reference:Object.freeze({path,identity:Object.freeze({dev:String(before.dev),ino:String(before.ino)}),sha256:createHash("sha256").update(bytes).digest("hex")})});
 }finally{closeSync(fd);}
}
function frozenRef(ref:Ref):Ref{return Object.freeze({...ref,identity:Object.freeze({...ref.identity})});}
/** Caller supplies the genuine completed FDA result from the original C entry.
 * Snapshot is stored by the existing H1 checkpoint writer, never a new grant. */
export async function captureCompletedRuntimePreservation(roots:CurrentColdHotRoots,result:HostedForegroundResult):Promise<CompletedRuntimePreservationData>{
 assertRootScope(roots);assertHostedForegroundResult(result);const native=readHostedForegroundLaunchObservation(result);assert.equal(native.closeStatus,0);assert.equal(result.exitCode,0);
 const path=selected(roots.candidateJobId),first=pinTerminalData(path,1024*1024),record=readHostedForegroundResultRecord(path);
 assert.equal(record.value.status,"done");assert.equal(record.output.unit,native.unit);assert.equal(record.output.exitCode,0);
 const stdout=pinTerminalData(logPath(native.unit,"stdout"),16*1024*1024),stderr=pinTerminalData(logPath(native.unit,"stderr"),16*1024*1024);
 assert.equal(stdout.reference.sha256,hash(record.output.stdout));assert.equal(stderr.reference.sha256,hash(record.output.stderr));
 const summary=await readCodexGoalResultSummary(path);assert.equal(summary.status,"done");assert.deepEqual(summary.foregroundOutput,record.output);
 assert.deepEqual(pinTerminalData(path,1024*1024).reference,first.reference);
 return Object.freeze({version:1,purpose:"TEST_completed_runtime_removal_crash_DATA_only",jobId:roots.candidateJobId,unit:native.unit,startId:native.startId,exitCode:0,status:"done",summarySha256:hash(JSON.stringify(summary)),result:frozenRef(first.reference),stdout:frozenRef(stdout.reference),stderr:frozenRef(stderr.reference)});
}
/** Pre-recovery DATA comparison must not acquire/recover the crashed activation
 * mutex. Fixed paths come from the original H1 job association, not snapshot IO
 * authority. Authentic dead-owner/intent/lock proofs stay with original H1. */
export function assertCompletedRuntimeBytesPreserved(jobId:string,snapshot:CompletedRuntimePreservationData):void{
 assert.equal(snapshot.version,1);assert.equal(snapshot.purpose,"TEST_completed_runtime_removal_crash_DATA_only");assert.equal(snapshot.jobId,jobId);assert.equal(snapshot.status,"done");assert.equal(snapshot.exitCode,0);
 assert.equal(snapshot.unit,"subscription-runtime-ordinary-"+snapshot.startId+".service");
 for(const [path,reference,max] of [[selected(jobId),snapshot.result,1024*1024],[logPath(snapshot.unit,"stdout"),snapshot.stdout,16*1024*1024],[logPath(snapshot.unit,"stderr"),snapshot.stderr,16*1024*1024]] as const){assert.equal(reference.path,path);assert.deepEqual(pinTerminalData(path,max).reference,reference);}
}
/** Run only AFTER original same-attempt recovery/closed readback. Public status
 * must still reauthenticate the same protected result, exit, unit and log bytes. */
export async function assertCompletedRuntimePreservedAfterRecovery(jobId:string,snapshot:CompletedRuntimePreservationData):Promise<void>{
 assertCompletedRuntimeBytesPreserved(jobId,snapshot);const path=selected(jobId),record=readHostedForegroundResultRecord(path),summary=await readCodexGoalResultSummary(path);
 assert.equal(record.value.status,snapshot.status);assert.equal(record.output.unit,snapshot.unit);assert.equal(record.output.exitCode,snapshot.exitCode);
 assert.deepEqual(summary.foregroundOutput,record.output);assert.equal(hash(JSON.stringify(summary)),snapshot.summarySha256);
 assertCompletedRuntimeBytesPreserved(jobId,snapshot);
}
