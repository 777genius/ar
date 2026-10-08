import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, readdir, symlink, rm, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildOriginalAllocation, encodeAllocationAck } from "./root-origin-operator.mjs";
import { readMeasuredLeaf } from "./install-root-producer.mjs";
import { validateProbeAllocation } from "../../src/worker-core/hosted-custody/domain/native-probe.js";
import { retainedResourceCanonicalJson, retainedResourceDigest } from "../../src/core/scoped-retained-resource-contract.js";
const second=1_000_000_000n, anchor=100n*second;
const context={anchor,work:anchor+90n*second,cleanup:anchor+150n*second,cold:anchor+8n*second,operationDigest:"1".repeat(64),permit:{version:1 as const,kind:"NativeOriginalA0" as const,jobId:"native-newtest",machineId:"a".repeat(32),installationDigest:"2".repeat(64),profileDigest:"3".repeat(64),manifestDigest:"4".repeat(64),notBeforeNs:anchor.toString(),workEndNs:(anchor+90n*second).toString(),cleanupEndNs:(anchor+150n*second).toString(),coldEndNs:(anchor+8n*second).toString()}};
function snapshot():Buffer {
  const b=Buffer.alloc(384);b.write("NPSNAP01");for(const [offset,n] of [[8,7n],[16,anchor],[24,context.work],[32,context.cleanup-5n*second],[40,context.cold],[48,context.cleanup]] as const)b.writeBigUInt64BE(n,offset);
  for(const [offset,value] of [[56,context.operationDigest],[120,context.permit.machineId],[152,context.permit.jobId],[184,context.permit.installationDigest],[248,context.permit.profileDigest],[312,context.permit.manifestDigest]] as const)b.write(value,offset,"ascii");return b;
}
// Red if effective intersections break unchanged nominal v1 validation, or
// the original full digest excludes declarations/capacities. DATA only.
test("post-anchor snapshot preserves full canonical allocation and shortened rows",()=>{
  const s=snapshot(),allocation=buildOriginalAllocation(s,context);validateProbeAllocation(allocation);
  assert.equal(allocation.issuanceAnchorNs,anchor.toString());assert.equal(allocation.preparationEndNs,(anchor+120n*second).toString());assert.equal(allocation.absoluteCleanupEndNs,(anchor+180n*second).toString());
  assert.equal(allocation.declarations[2]!.workEndNs,context.work.toString());assert.equal(allocation.declarations[2]!.cleanupEndNs,(context.cleanup-5n*second).toString());
  const ack=encodeAllocationAck(s,allocation);assert.equal(ack.readBigUInt64BE(16),7n);assert.deepEqual(ack.subarray(24,408),s);
  assert.equal(ack.subarray(408,472).toString(),retainedResourceDigest(allocation));assert.equal(ack.subarray(472).toString(),retainedResourceCanonicalJson(allocation)+"\n");
  assert.notEqual(retainedResourceDigest(allocation),context.operationDigest);
  for(const mutation of [{...allocation,limits:{...allocation.limits,messages:512}},{...allocation,declarations:allocation.declarations.map(row=>({...row,workEndNs:(context.work-1n).toString()}))}])assert.notEqual(retainedResourceDigest(mutation),retainedResourceDigest(allocation));
});
// Red if identity/clock bytes are normalized, extended, omitted or substituted.
test("snapshot byte substitutions refuse before allocation acknowledgement",()=>{
  for(const offset of [0,16,24,32,40,48,56,120,152,184,248,312,376]){const bytes=snapshot();bytes[offset]=bytes[offset]!^0xff;assert.throws(()=>buildOriginalAllocation(bytes,context));}
  const zero=snapshot();zero.writeBigUInt64BE(0n,8);assert.throws(()=>buildOriginalAllocation(zero,context));
  assert.throws(()=>buildOriginalAllocation(snapshot().subarray(0,383),context));
  const raw=snapshot();raw[56]=raw[56]!|0x80;assert.throws(()=>buildOriginalAllocation(raw,context),/ASCII/);
});
async function command(path:string,args:readonly string[],stdioInput:Buffer|undefined=undefined,cwd:string|undefined=undefined):Promise<{code:number|null;signal:NodeJS.Signals|null;stdout:Buffer;stderr:Buffer}> {
  const child=spawn(path,[...args],{cwd,stdio:["pipe","pipe","pipe"],env:{PATH:"/usr/bin:/bin"}});const out:Buffer[]=[],err:Buffer[]=[];
  child.stdout.on("data",(b:Buffer)=>out.push(b));child.stderr.on("data",(b:Buffer)=>err.push(b));child.stdin.on("error",()=>{});child.stdin.end(stdioInput);
  const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((accept,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>accept({code,signal}));});return {...result,stdout:Buffer.concat(out),stderr:Buffer.concat(err)};
}
// Red if a public invocation can acquire a private native origin/dispatch.
// The genuine constructor receives no protected administrative objects here.
test("actual entry rejects public argv/JSON with independently unchanged disposable directory",async()=>{
  const path=process.env.NP_ROOT_PRODUCER_ENTRY;assert.ok(path);
  const directory=await mkdtemp(join(tmpdir(),"producer-refusal-"));
  try {const before=await readdir(directory);for(const args of [[],["genuine=true"]]){const result=await command(path,args,Buffer.from('{"uid":0,"origin":true}'),directory);assert.equal(result.code,77);assert.equal(result.signal,null);assert.deepEqual(JSON.parse(result.stdout.toString()),{status:"UNKNOWN_HELD"});assert.deepEqual(await readdir(directory),before);} }finally{await rm(directory,{recursive:true});}
});
// Red if supported libc fork/robust list loses death detection or renews wait.
test("actual shared native gate retains original wait/EOF and irreversible owner death",async()=>{
  const executable=process.env.NP_ROOT_ORIGIN_GATE;assert.ok(executable);
  const directory=await mkdtemp(join(tmpdir(),"producer-prefix-"));
  try {const result=await command(executable,[],undefined,directory);assert.equal(result.code,0);assert.equal(result.signal,null);assert.match(result.stdout.toString(),/wait\/EOF\/death\/unrecoverable PASS/);
    assert.deepEqual(await readdir(directory),["prefix-0000.json"]);
    const leaf=await lstat(join(directory,"prefix-0000.json"));assert.equal(leaf.mode&0o777,0o600);assert.equal(leaf.nlink,1);
    const raw=JSON.parse(await readFile(join(directory,"prefix-0000.json"),"utf8")) as {event:string;generation:string;index:number;monotonicNs:string;prefix:string};
    assert.equal(raw.event,"test-prefix");assert.equal(raw.generation,"7");assert.equal(raw.index,0);assert.match(raw.monotonicNs,/^[1-9][0-9]*$/);assert.equal(raw.prefix,'cookie=9 unknown=1 quoted="held"');
  }finally{await rm(directory,{recursive:true});}
});
// Red if hash/metadata admission follows symlinks or accepts changed bytes.
test("measured filesystem leaf rejects changed content and symlink",async t=>{
  if(process.getuid?.()!==0){t.skip("protected ROOT filesystem primitive requires disposable UID0 fixture");return;}
  const directory=await mkdtemp("/run/native-producer-source-");const original=await lstat(directory,{bigint:true});
  try {const path=join(directory,"leaf"),bytes=Buffer.from("reviewed fixed input\n");await writeFile(path,bytes,{mode:0o644});const file={path,bytes:bytes.length,mode:0o644,sha256:createHash("sha256").update(bytes).digest("hex")};assert.deepEqual(readMeasuredLeaf(path,file),bytes);await writeFile(path,Buffer.from("changed fixed input!\n"));assert.throws(()=>readMeasuredLeaf(path,file));await symlink(path,join(directory,"alias"));assert.throws(()=>readMeasuredLeaf(join(directory,"alias"),file));}
  finally{const current=await lstat(directory,{bigint:true});assert.equal(current.dev,original.dev);assert.equal(current.ino,original.ino);await rm(directory,{recursive:true});}
});
// Separate physical gate: flag selects an explicitly prepared NEWTEST fixture,
// never creates membership or a fake positive Origin from CI's wrapper UID.
test("genuine installed original producer closes under independent foreground observation",{skip:process.env.SR_ORIGINAL_PRODUCER_PHYSICAL!=="NEWTEST"},async()=>{
  assert.equal(process.getuid?.(),0);
  const result=await command("/opt/subscription-runtime/runtime/node",["/opt/subscription-runtime/native-probe/admin/host-integration/native-probe/root-origin-operator.mjs"]);
  assert.equal(result.code,0);assert.equal(result.signal,null);
  const data:unknown=JSON.parse(result.stdout.toString());assert.ok(data&&typeof data==="object"&&"status" in data&&data.status==="ORIGINAL_PRODUCER_L0_RAW");
  const retained:unknown=JSON.parse(await readFile("/run/subscription-runtime/native-probe/original/l0.json","utf8"));assert.deepEqual(data,retained);
});
