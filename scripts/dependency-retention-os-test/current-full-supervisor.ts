/** Owned PID1 supervisor keeps the genuine parent service alive after guest. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { closeSync, constants, fstatSync, openSync, readlinkSync, statSync, existsSync, readFileSync } from "node:fs";
import { json, node, runtime } from "./common.ts";
import { assertOriginalH1RecoveryReady, assertOriginalH1RecoveryComplete, publishOriginalH1SupervisorAccepted, readOriginalH1Request, publishH1ReadinessRecord, H1ReadinessRecord, readOriginalH1ProgramSource } from "./current-removal-h1-fixture.js";
import { FullRemovalCase } from "../../host-integration/managed-launcher/dependency-full-native-TEST.js";
import { originalH1Continuation } from "./current-full-h1-supervision.js";
import { currentFullEnvironment } from "./current-full-env.js";
assert.equal(process.platform,"linux");assert.equal(process.getuid?.(),0);assert(process.argv.length===3 || (process.argv.length===4 && process.argv[3]==="--parent-crash-h1"));assert.equal(process.argv[2],"supervisor");
assert.equal(process.argv[1],runtime+"/scripts/dependency-retention-os-test/current-full-supervisor.js");
assert.match(process.env.TEST_SOURCE_SHA??"",/^[a-f0-9]{40}$/);
const h1=process.argv[3]==="--parent-crash-h1";
const restoreConsumer=process.env.TEST_FULL_RESTORE_CONSUMER;
assert(!h1 || restoreConsumer===undefined || restoreConsumer==="ordinary");
assert(restoreConsumer===undefined || restoreConsumer==="ordinary" || restoreConsumer==="readonly");
json(runtime+"/guest-started.json",{schemaVersion:1,purpose:"TEST_bootstrap_observation_only",sourceSha:process.env.TEST_SOURCE_SHA,
  machineId:readFileSync("/etc/machine-id","utf8").trim(),pid:process.pid});
const child=spawn(node,[runtime+"/scripts/dependency-retention-os-test/current-full-guest.js","qualify",...(h1?["--parent-crash-h1"]:[])],
  {env:{...currentFullEnvironment(),TEST_SOURCE_SHA:process.env.TEST_SOURCE_SHA,...(restoreConsumer===undefined?{}:{TEST_FULL_RESTORE_CONSUMER:restoreConsumer})},stdio:["pipe","pipe","pipe"]});
// Real pipes satisfy the unchanged descriptor boundary. Never persist output.
child.stdin.on("error",()=>{});child.stdin.end();child.stdout.resume();child.stderr.resume();
let activeChild:ReturnType<typeof spawn>=child;
const timeout=setTimeout(()=>{activeChild.kill("SIGTERM");process.exitCode=70;},27*60*1000);
const failed=(reason:"spawn_failed"|"child_exited_without_evidence",code:number|null,signal:NodeJS.Signals|null)=>{
  clearTimeout(timeout);
  if(!existsSync(runtime+"/guest-evidence.json") && !existsSync(runtime+"/guest-child-exit.json"))
    json(runtime+"/guest-child-exit.json",{schemaVersion:1,purpose:"TEST_child_failure_observation_only",sourceSha:process.env.TEST_SOURCE_SHA,reason,code,signal});
};
child.once("error",()=>failed("spawn_failed",null,null));const continueH1=originalH1Continuation(h1?FullRemovalCase.ParentCrashH1:FullRemovalCase.Positive,{
  ready:assertOriginalH1RecoveryReady,
  recover:()=>new Promise((resolve,reject)=>{
    const recovery=spawn(node,[runtime+"/scripts/dependency-retention-os-test/current-removal-h1-fixture.js","recover_h1"],
      {env:{...currentFullEnvironment(),TEST_SOURCE_SHA:process.env.TEST_SOURCE_SHA},stdio:["pipe","pipe","pipe","pipe"]});
    activeChild=recovery;assert(recovery.stdin && recovery.stdout && recovery.stderr);recovery.stdin.on("error",()=>{});recovery.stdin.end();recovery.stdout.resume();recovery.stderr.resume();
    recovery.once("spawn",()=>{
      let requestFd:number|undefined,anchor:number|undefined;
      try{
        assert(recovery.pid!==undefined && recovery.pid>0);
        const request=readOriginalH1Request(),outbox="/run/TEST-full-flow-outbox",requestPath=outbox+"/"+H1ReadinessRecord.Request;
        requestFd=openSync(requestPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        const rs=fstatSync(requestFd,{bigint:true});assert(rs.isFile() && rs.uid===0n && rs.gid===0n && rs.nlink===1n && (rs.mode&0o7777n)===0o600n && rs.size<=16384n);
        const requestBytes=readFileSync(requestFd);assert(requestBytes.equals(Buffer.from(JSON.stringify(request)+"\n")));
        function ticks(path:string):string {const raw=readFileSync(path+"/stat","utf8");assert(Buffer.byteLength(raw)<=4096);const fields=raw.slice(raw.lastIndexOf(") ")+2).trim().split(/\s+/);assert(!["Z","X","x"].includes(fields[0]??"") && /^[1-9][0-9]*$/.test(fields[19]??""));return fields[19]!;}
        const supervisorBirth=process.pid+":"+ticks("/proc/self");assert.equal(supervisorBirth,request.supervisorId);
        anchor=openSync("/proc/"+recovery.pid,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        const prefix="/proc/self/fd/"+anchor,recoveryBirth=recovery.pid+":"+ticks(prefix),argv=Buffer.from([node,runtime+"/scripts/dependency-retention-os-test/current-removal-h1-fixture.js","recover_h1",""].join("\0"));
        const programSource=readOriginalH1ProgramSource(),sourceBytes=programSource.bytes;
        const group=readFileSync("/proc/self/cgroup");assert(group.equals(readFileSync(prefix+"/cgroup")) && argv.equals(readFileSync(prefix+"/cmdline")) && readlinkSync(prefix+"/exe")===node);
        assert.equal(readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(),request.bootId);
        const gate=recovery.stdio[3];assert(gate instanceof Writable);
        publishH1ReadinessRecord(outbox,H1ReadinessRecord.Recovery,Buffer.from(JSON.stringify({schemaVersion:1,purpose:"TEST_original_supervisor_recovery_child_birth_only",sourceSha:request.sourceSha,bootId:request.bootId,supervisorBirth,originalParentBirth:request.parentBirth,recoveryBirth,requestRef:{identity:{dev:String(rs.dev),ino:String(rs.ino)},sha256:createHash("sha256").update(requestBytes).digest("hex")},programSha256:createHash("sha256").update(sourceBytes).digest("hex")})+"\n"));
        assert.equal(process.pid+":"+ticks("/proc/self"),supervisorBirth);assert.equal(recovery.pid+":"+ticks(prefix),recoveryBirth);
        assert(group.equals(readFileSync(prefix+"/cgroup")) && argv.equals(readFileSync(prefix+"/cmdline")) && rs.dev===fstatSync(requestFd,{bigint:true}).dev && rs.ino===fstatSync(requestFd,{bigint:true}).ino && requestBytes.equals(readFileSync(requestPath)));
        const namedRequest=statSync(requestPath,{bigint:true});assert(namedRequest.dev===rs.dev && namedRequest.ino===rs.ino && namedRequest.mode===rs.mode && namedRequest.uid===rs.uid && namedRequest.gid===rs.gid && namedRequest.nlink===rs.nlink && namedRequest.size===rs.size && namedRequest.ctimeNs===rs.ctimeNs && namedRequest.mtimeNs===rs.mtimeNs);
        const sourceAgain=readOriginalH1ProgramSource();
        assert(sourceBytes.equals(sourceAgain.bytes) && JSON.stringify(programSource.reference)===JSON.stringify(sourceAgain.reference));
        gate.end("1");
      }catch(error){recovery.kill("SIGTERM");reject(error);}
      finally{if(anchor!==undefined)closeSync(anchor);if(requestFd!==undefined)closeSync(requestFd);}
    });
    recovery.once("error",reject);recovery.once("close",(code,signal)=>{if(recovery.pid===undefined)reject(new Error("H1 recovery missing birth"));else resolve({pid:recovery.pid,code,signal});});
  }),complete:assertOriginalH1RecoveryComplete,publish:publishOriginalH1SupervisorAccepted,
});
child.once("close",async(code,signal)=>{
  if(!h1){failed("child_exited_without_evidence",code,signal);return;}
  try{assert(child.pid!==undefined);await continueH1({pid:child.pid,code,signal});clearTimeout(timeout);}
  catch{clearTimeout(timeout);process.exitCode=70;}
});
// Actual supervisor unit lifetime, not the guest process, supplies operator birth.
setInterval(()=>{},60000);
