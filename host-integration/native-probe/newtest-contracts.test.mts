import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { retainedResourceDigest } from "../../src/core/scoped-retained-resource-contract.js";
import { elfInputs, tree, verifyTree } from "./assemble-newtest.mjs";
import { boundedCommand, NewtestCommandFailure, claimOnce, decodeConfig, type NewtestConfig } from "./newtest-bootstrap.mjs";
import { finitePermit, managerFacts, unwrapManagedJob } from "./newtest-guest.mjs";
const fixture=(directory:string):NewtestConfig=>decodeConfig({version:1,kind:"NativeOriginalNewtest",runId:"a".repeat(16),machineId:"b".repeat(32),sourceCommit:"c".repeat(40),storageRoot:directory,artifactDirectory:directory,artifactDigest:"d".repeat(64),baseArchive:directory+"/base",node:process.execPath,nodeSha256:"e".repeat(64),preparationEndNs:"900000000000",cleanupEndNs:"1200000000000"});
if(process.argv[2]==="claim-child"){
  try{const directory=process.argv[3]!;claimOnce(directory,fixture(directory),1n,"f".repeat(32));process.exitCode=0;}catch{process.exitCode=77;}
}else{
  // Red: modified bytes or links into an unreviewed tree pass artifact admission.
  test("actual protected artifact content and symlink drift refuse",t=>{
    if(process.getuid?.()!==0){t.skip("Root filesystem fixture unavailable");return;}
    const dir=mkdtempSync("/run/native-newtest-artifact-");
    try{const file=join(dir,"leaf");writeFileSync(file,"reviewed\n",{mode:0o600});const expected=retainedResourceDigest(tree(dir));assert.equal(verifyTree(dir,expected).length,1);writeFileSync(file,"changed\n");assert.throws(()=>verifyTree(dir,expected));symlinkSync(file,join(dir,"alias"));assert.throws(()=>tree(dir));}finally{rmSync(dir,{recursive:true});}
  });
  // Red: a second real contender replaces/reuses an original bootstrap claim.
  // This proves O_EXCL TEST ownership only, never a fake NativeRoot origin.
  test("real competing processes retain exactly one original bootstrap claim",async t=>{
    if(process.getuid?.()!==0){t.skip("Root filesystem fixture unavailable");return;}
    const dir=mkdtempSync("/run/native-newtest-claim-");
    try{const end=process.hrtime.bigint()+5_000_000_000n;const results=await Promise.all([1,2].map(()=>boundedCommand(process.execPath,[fileURLToPath(import.meta.url),"claim-child",dir],end)));assert.deepEqual(results.map(r=>r.code).sort((a,b)=>Number(a)-Number(b)),[0,77]);assert.ok(results.every(r=>r.signal===null&&r.naturalClose));assert.deepEqual(readdirSync(dir),["ownership.json"]);const first=readFileSync(join(dir,"ownership.json"));assert.throws(()=>claimOnce(dir,fixture(dir),2n,"f".repeat(32)));assert.deepEqual(readFileSync(join(dir,"ownership.json")),first);}finally{rmSync(dir,{recursive:true});}
  });
  // Red: successful process exit text substitutes for original wait/pipe EOF,
  // or a caller gets a renewed allowance after the original command end.
  test("actual finite child wait consumes original command cutoff",async()=>{
    const now=process.hrtime.bigint();await assert.rejects(boundedCommand(process.execPath,["-e","setTimeout(()=>{},10000)"],now+100_000_000n,undefined,{},now+2_000_000_000n),/UNKNOWN_HELD/);await assert.rejects(boundedCommand(process.execPath,["-e","process.exit(0)"],now),/expired/);
    const r=await boundedCommand(process.execPath,["-e","process.stdout.write('original\\n')"],process.hrtime.bigint()+2_000_000_000n);assert.equal(r.code,0);assert.equal(r.signal,null);assert.equal(r.naturalClose,true);assert.equal(r.stdout.toString(),"original\n");
  });
  // Red: a launcher consumes work despite the original startup/runtime/stop
  // reservation being unavailable. The child would leave an independent file.
  test("actual child effect refuses an exhausted original lifetime reservation",async t=>{
    if(process.getuid?.()!==0){t.skip("Root filesystem fixture unavailable");return;}
    const dir=mkdtempSync("/run/native-newtest-no-effect-");
    try{
      const marker=join(dir,"effect"),args=["-e","require('node:fs').writeFileSync(process.argv[1],'effect')",marker],now=process.hrtime.bigint();
      await assert.rejects(boundedCommand(process.execPath,args,now+2_000_000_000n,undefined,{},now+4_000_000_000n,{workNs:3_000_000_000n,cleanupNs:0n}),/before spawn\/reservation/);
      assert.equal(existsSync(marker),false);
      await assert.rejects(boundedCommand(process.execPath,args,now),/expired/);assert.equal(existsSync(marker),false);
      // A real independent preparer consumes the original funded margin.
      // The final effect receives the SAME ends after that asynchronous wait.
      const original=process.hrtime.bigint(),work=original+3_000_000_000n,cleanup=original+5_000_000_000n;
      const prepared=await boundedCommand(process.execPath,["-e","setTimeout(()=>process.stdout.write('prepared'),500)"],work,undefined,{},cleanup);
      assert.equal(prepared.code,0);assert.equal(prepared.naturalClose,true);assert.equal(prepared.stdout.toString(),"prepared");
      await assert.rejects(boundedCommand(process.execPath,args,work,undefined,{},cleanup,{workNs:2_700_000_000n,cleanupNs:0n}),/before spawn\/reservation/);
      assert.equal(existsSync(marker),false);
    }finally{rmSync(dir,{recursive:true});}
  });
  // Red: the Root adapter unwraps a caller-selected helper or modified
  // manager-produced request. This is a DATA/refusal boundary, not Root credit.
  test("fixed installed manager envelope rejects changed helper and request",()=>{
    const command="/opt/subscription-runtime/runtime/node",helper="/opt/subscription-runtime/managed-launcher/launch.mjs";
    const expected={operation:"job",unit:"subscription-job-"+"a".repeat(64)+".service",payload:[command,"/opt/native-newtest/artifact/admin/host-integration/native-probe/newtest-guest.mjs","--ordinary-refusal"],jobId:"sr-native-newtest-test-ordinary-refusal",fingerprint:"b".repeat(64),limits:{runtimeSeconds:60,stopSeconds:10,memoryMiB:512,tasksMax:64,cpuPercent:100}};
    const raw=JSON.stringify(expected);assert.deepEqual(unwrapManagedJob(command,[helper,"job",raw],expected),expected);
    for(const [executable,args] of [["/usr/bin/node",[helper,"job",raw]],[command,[helper,"provider",raw]],[command,[helper+".other","job",raw]],[command,[helper,"job",raw,"extra"]],[command,[helper,"job",raw+" "]],[command,[helper,"job",JSON.stringify({...expected,payload:[command,"/foreign"]})]],[command,[helper,"job",JSON.stringify({...expected,limits:{...expected.limits,runtimeSeconds:61}})]],[command,[helper,"job",raw.replace('"operation":"job"','"operation":"provider","operation":"job"')]]] as const)assert.throws(()=>unwrapManagedJob(executable,args,expected));
  });
  // Red: work timeout drops the original wait and inherited pipe tail while
  // cleanup remains funded. A finite descendant holds both actual channels;
  // it is not a substitute principal or a simulated NativeRoot positive.
  test("work failure retains original exit and both raw EOFs through cleanup",async()=>{
    const tail="setTimeout(()=>{process.stdout.write('late-out\\n');process.stderr.write('late-err\\n')},2000)";
    const parent="require('node:child_process').spawn(process.execPath,['-e',process.argv[1]],{stdio:['ignore',1,2]});process.stdout.write('original\\n');setTimeout(()=>{},10000)";
    const now=process.hrtime.bigint();
    try{await boundedCommand(process.execPath,["-e",parent,tail],now+1_000_000_000n,undefined,{},now+5_000_000_000n);assert.fail("timeout cannot pass");}
    catch(error){
      assert.ok(error instanceof NewtestCommandFailure);assert.match(error.message,/UNKNOWN_HELD/);
      assert.equal(error.exit?.signal,"SIGKILL");assert.equal(error.exit?.code,null);
      assert.equal(error.custody.stdoutEof,true);assert.equal(error.custody.stderrEof,true);assert.equal(error.custody.forcedClose,false);
      assert.ok((error.custody.pid??0)>0);assert.match(error.custody.startTicks??"",/^[0-9]+$/);assert.equal(error.custody.ownerPid,process.pid);
      assert.match(error.stdout.toString(),/original\nlate-out\n/);assert.equal(error.stderr.toString(),"late-err\n");
      assert.equal(error.custody.signals.length,1);assert.equal(error.custody.signals[0]?.sent,true);
      assert.ok(BigInt(error.custody.signals[0]!.atNs)<now+5_000_000_000n);
    }
  });
  // Red: cleanup expiration destroys pipes but labels their closure as EOF.
  test("forced original channel closure records exact unresolved custody",async()=>{
    const tail="setTimeout(()=>{},2000)",parent="require('node:child_process').spawn(process.execPath,['-e',process.argv[1]],{stdio:['ignore',1,2]});process.stdout.write('held\\n');setTimeout(()=>{},10000)",now=process.hrtime.bigint();
    try{await boundedCommand(process.execPath,["-e",parent,tail],now+300_000_000n,undefined,{},now+700_000_000n);assert.fail("held channels cannot pass");}
    catch(error){assert.ok(error instanceof NewtestCommandFailure);assert.equal(error.custody.forcedClose,true);assert.equal(error.custody.stdoutEof,false);assert.equal(error.custody.stderrEof,false);assert.equal(error.exit?.signal,"SIGKILL");assert.match(error.stdout.toString(),/held\n/);assert.ok(BigInt(error.custody.highWaterNs)>=now+700_000_000n);}
  });
  // Red: stock v255's explicit empty Job refuses, or missing/foreign/duplicate
  // properties silently replace independently observed manager readiness.
  test("stock manager facts require exact explicit empty no-job property",()=>{
    const stock="MainPID=123\nActiveState=active\nSubState=running\nInvocationID="+"a".repeat(32)+"\nJob=\n";
    assert.equal(managerFacts(Buffer.from(stock),true).Job,"");
    for(const invalid of [stock.replace("Job=\n",""),stock+"Job=\n",stock.replace("Job=\n","Job=0\n"),stock.replace("Job=\n","Job=42\n"),stock+"Unknown=x\n",stock.replace("MainPID=123","MainPID=0"),stock.replace("SubState=running","SubState=dead")])assert.throws(()=>managerFacts(Buffer.from(invalid),true));
    assert.equal(managerFacts(Buffer.from(stock.replace("Job=\n","")),false).MainPID,"123");
  });
  // Red: foreign ELF search policy or truncated offsets escape measured closure.
  test("actual Linux Node ELF inputs reject byte and offset substitutions",t=>{
    if(process.platform!=="linux"||process.arch!=="x64"){t.skip("supported Linux ELF ABI required");return;}
    const original=readFileSync(process.execPath),actual=elfInputs(original);assert.match(actual.interpreter??"",/^\/.*ld.*\.so\.[0-9]+$/);assert.ok(actual.needed.includes("libc.so.6"));const corrupt=Buffer.from(original);corrupt[0]=0;assert.throws(()=>elfInputs(corrupt));const offset=Buffer.from(original);offset.writeBigUInt64LE(BigInt(original.length)+1n,32);assert.throws(()=>elfInputs(offset));assert.throws(()=>elfInputs(original.subarray(0,40)));
  });
  // Red: permit writer extends inherited guest ends or accepts an exhausted
  // cleanup margin. DATA hashes never count as admission in this pure codec.
  test("fresh permit intersects enclosing original ends without renewal",()=>{
    const anchor=1_000_000_000n,p=finitePermit("native-test","a".repeat(32),"b".repeat(64),anchor,anchor+90_000_000_000n,anchor+150_000_000_000n) as {workEndNs:string;cleanupEndNs:string;coldEndNs:string;notBeforeNs:string};assert.equal(p.workEndNs,(anchor+90_000_000_000n).toString());assert.equal(p.cleanupEndNs,(anchor+150_000_000_000n).toString());assert.equal(p.coldEndNs,(anchor+10_000_000_000n).toString());assert.equal(p.notBeforeNs,anchor.toString());assert.throws(()=>finitePermit("native-test","a".repeat(32),"b".repeat(64),anchor,anchor,anchor+150_000_000_000n));assert.throws(()=>finitePermit("native-test","a".repeat(32),"b".repeat(64),anchor,anchor+90_000_000_000n,anchor+95_000_000_000n));
  });
}
