import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { retainedResourceDigest } from "../../src/core/scoped-retained-resource-contract.js";
import { elfInputs, tree, verifyTree } from "./assemble-newtest.mjs";
import { boundedCommand, NewtestCommandFailure, claimOnce, decodeConfig, assertBootstrapCgroup, type NewtestConfig } from "./newtest-bootstrap.mjs";
import { finitePermit, managerFacts, unwrapManagedJob } from "./newtest-guest.mjs";
import { isNewtestGuestCgroup } from "./newtest-cgroup.mjs";
const fixture=(directory:string):NewtestConfig=>decodeConfig({version:1,kind:"NativeOriginalNewtest",runId:"a".repeat(16),machineId:"b".repeat(32),sourceCommit:"c".repeat(40),storageRoot:directory,artifactDirectory:directory,artifactDigest:"d".repeat(64),baseArchive:directory+"/base",node:process.execPath,nodeSha256:"e".repeat(64),preparationEndNs:"900000000000",cleanupEndNs:"1200000000000"});
if(process.argv[2]==="claim-child"){
  try{const directory=process.argv[3]!;claimOnce(directory,fixture(directory),1n,"f".repeat(32));process.exitCode=0;}catch{process.exitCode=77;}
}else{
  // Red: the fixed guest rejects valid supplementary nspawn membership or
  // accepts a foreign/ambiguous v2 row. This is DATA, not physical qualification.
  test("fixed guest membership admits supplementary v1 but requires exact unique v2",()=>{
    const group="/system.slice/native-newtest.service",unified=`0::${group}\n`;
    for(const text of [`1:name=systemd:/\n${unified}`,`${unified}1:name=systemd:${group}/init.scope\n2:cpu,cpuacct:/\n`,unified,unified.slice(0,-1)])assert.equal(isNewtestGuestCgroup(text),true);
    const invalid=[
      ["host init", "1:name=systemd:/\n0::/init.scope\n"],
      ["named guest but foreign v2", `1:name=systemd:${group}\n0::/system.slice/foreign.service\n`],
      ["bootstrap unit", "0::/system.slice/subscription-runtime-native-newtest-284e13e813e17671.service\n"],
      ["descendant", `0::${group}/payload\n`],
      ["similar unit", `0::${group}.other\n`],
      ["noncanonical path", `0::/system.slice/..${group}\n`],
      ["duplicate identical", unified+unified],
      ["duplicate conflicting", unified+"0::/\n"],
      ["duplicate reversed", "0::/\n"+unified],
      ["missing v2", `1:name=systemd:${group}\n`],
      ["v2 controllers", `0:name=systemd:${group}\n`],
      ["missing path", "0::\n"],
      ["relative path", "0::system.slice/native-newtest.service\n"],
      ["malformed supplementary", "1:name=systemd\n"+unified],
      ["empty v1 controllers", "1::/\n"+unified],
      ["malformed controllers", "1:cpu,,cpuacct:/\n"+unified],
      ["blank row", unified+"\n"],
      ["leading whitespace", " "+unified],
      ["trailing whitespace", `0::${group} \n`],
      ["CR", `0::${group}\r\n`],
      ["NUL", `0::${group}\0\n`],
      ["empty text", ""],
    ] as const;
    for(const [fault,text] of invalid)assert.equal(isNewtestGuestCgroup(text),false,fault);
  });
  // Red: valid host supplementary membership refuses, or an ambiguous/foreign
  // unified row grants the fixed bootstrap DATA admission. This is not Origin.
  test("bootstrap membership requires one exact v2 service alongside host v1 rows",()=>{
    const config={...fixture("/fixture"),runId:"284e13e813e17671"};
    const group="/system.slice/subscription-runtime-native-newtest-284e13e813e17671.service";
    const unified=`0::${group}\n`;
    assert.doesNotThrow(()=>assertBootstrapCgroup(`1:name=systemd:/\n${unified}`,config));
    assert.doesNotThrow(()=>assertBootstrapCgroup(`${unified}1:name=systemd:/\n2:cpu,cpuacct:/\n`,config));
    assert.doesNotThrow(()=>assertBootstrapCgroup(unified,config));
    assert.doesNotThrow(()=>assertBootstrapCgroup(unified.slice(0,-1),config));
    const invalid=[
      ["actual host PID1", "1:name=systemd:/\n0::/init.scope\n"],
      ["actual host journald", "1:name=systemd:/\n0::/system.slice/systemd-journald.service\n"],
      ["approved-looking v1 only", `1:name=systemd:${group}\n`],
      ["approved-looking v1 with foreign v2", `1:name=systemd:${group}\n0::/foreign.service\n`],
      ["descendant", `0::${group}/payload\n`],
      ["similar unit", `0::${group}.other\n`],
      ["unnormalized path", `0::/system.slice/..${group}\n`],
      ["duplicate identical", unified+unified],
      ["duplicate conflicting", unified+"0::/\n"],
      ["duplicate reversed", "0::/\n"+unified],
      ["missing path", "0::\n"],
      ["relative path", "0::system.slice/service\n"],
      ["v2 controllers", `0:name=systemd:${group}\n`],
      ["leading whitespace", " "+unified],
      ["malformed supplementary", "1:name=systemd\n"+unified],
      ["empty v1 controllers", "1::/\n"+unified],
      ["malformed controller list", "1:cpu,,cpuacct:/\n"+unified],
      ["blank row", unified+"\n"],
      ["carriage return", `0::${group}\r\n`],
      ["NUL path", `0::${group}\0\n`],
      ["empty text", ""],
    ] as const;
    for(const [fault,text] of invalid)assert.throws(()=>assertBootstrapCgroup(text,config),/fixed NEWTEST service required/,fault);
  });
  // Red: the actual candidate omits its required CJS codec, cannot require it,
  // or packages an obsolete small/lenient decoder instead of the checked body.
  test("actual candidate standalone CJS codec decodes finite inventory DATA",()=>{
    const codecPath=process.env.NP_HOST_INVENTORY_CODEC;assert.ok(codecPath,"Source candidate codec required");
    const codec=createRequire(import.meta.url)(codecPath) as typeof import("../../src/core/host-infrastructure/host-inventory.js");
    const units=Array.from({length:300},(_,i)=>({category:i===0?"supervisor":"borrowed",name:`fixture-${i}.service`,aliases:[],controlGroup:`/fixture-${i}.service`,
      fragmentPath:`/fixture/fixture-${i}.service`,fragmentSha256:"a".repeat(64),dropIns:[{path:`/fixture/fixture-${i}.service.d/ordered.conf`,sha256:"b".repeat(64)}],
      loadState:"loaded",activeState:i===0?"active":"inactive",unitFileState:"static",invocationId:i===0?"c".repeat(32):"",mainPidBirth:i===0?"100:200":null,job:"",delegate:false}));
    const launch={command:"/fixture/node",args:["/fixture/cli.js","--json"],cwd:"/fixture/jobs/TEST-codec/workspace"};
    const input={schemaVersion:5,hostId:"d".repeat(32),bootId:"11111111-1111-1111-1111-111111111111",supervisorUnit:units[0]!.name,units,
      cgroups:[{path:"",parent:null,ownerUnit:null,dev:"1",ino:"1",members:[]},...units.map((u,i)=>({path:u.controlGroup,parent:"",ownerUnit:u.name,dev:"1",ino:String(i+2),members:i===0?[{birth:"100:200",controlGroup:u.controlGroup}]:[]}))],
      activators:[],supervisor:{birth:"100:200",executable:{path:"/fixture/node",sha256:"e".repeat(64)},bootstrap:{path:"/fixture/bootstrap.js",sha256:"f".repeat(64)},operationId:"11111111-1111-1111-1111-111111111111",workEndEpochMs:1000,cleanupEndEpochMs:2000},
      ordinaryCreators:[{creatorId:"fixture-creator",jobId:"TEST-codec",jobRootDir:"/fixture/jobs/TEST-codec",workspacePath:launch.cwd,launch}],disabledCreators:[],runtimeLaunch:launch,
      collectorProfile:{path:"/var/lib/subscription-runtime-host-policy/fd-collector-profile.v1.json",sha256:"a".repeat(64)},systemBusInfrastructure:{}};
    const bytes=Buffer.from(JSON.stringify(input));assert.ok(bytes.length>64*1024);
    const decoded=codec.decodeHostedInventoryBytes(bytes) as import("../../src/core/host-infrastructure/host-inventory.js").HostedInventoryV5;
    assert.equal(decoded.units.length,300);assert.equal(decoded.units[299]!.dropIns[0]!.path,"/fixture/fixture-299.service.d/ordered.conf");
    assert.ok(Object.isFrozen(decoded.units[299]!.dropIns[0]));assert.ok(Object.isFrozen(decoded.cgroups[1]!.members[0]));
    assert.throws(()=>codec.decodeHostedInventoryBytes(Buffer.from(JSON.stringify({...input,ignoredAuthority:true}))),/hosted_inventory_invalid/);
    assert.throws(()=>codec.decodeHostedInventoryBytes(Buffer.from([0xff])),/hosted_inventory_invalid/);
    assert.throws(()=>codec.decodeHostedInventoryBytes(new Uint8Array(4*1024*1024+1)),/hosted_inventory_invalid/);
  });
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
  // Red: real Node's large file-backed dynstr refuses, or byte/offset changes,
  // missing dynamic termination and foreign names escape measured closure.
  test("actual Linux Node ELF inputs reject byte and offset substitutions",t=>{
    if(process.platform!=="linux"||process.arch!=="x64"){t.skip("supported Linux ELF ABI required");return;}
    const original=readFileSync(process.execPath),actual=elfInputs(original);
    assert.match(actual.interpreter??"",/^\/.*ld.*\.so\.[0-9]+$/);assert.ok(actual.needed.includes("libc.so.6"));
    const corrupt=Buffer.from(original);corrupt[0]=0;assert.throws(()=>elfInputs(corrupt));
    const offset=Buffer.from(original);offset.writeBigUInt64LE(BigInt(original.length)+1n,32);assert.throws(()=>elfInputs(offset));
    assert.throws(()=>elfInputs(original.subarray(0,40)));
    // Locate metadata in the actual executable, without generating a mirrored
    // ELF positive or executing the candidate bytes. Mutations must fail closed.
    const ph=Number(original.readBigUInt64LE(32)),size=original.readUInt16LE(54),count=original.readUInt16LE(56);
    const headers=Array.from({length:count},(_,i)=>ph+i*size);
    const dynamic=headers.find(p=>original.readUInt32LE(p)===2);assert.notEqual(dynamic,undefined);
    const start=Number(original.readBigUInt64LE(dynamic!+8)),bytes=Number(original.readBigUInt64LE(dynamic!+32));
    const tags=Array.from({length:bytes/16},(_,i)=>start+i*16);
    const strsz=tags.find(p=>original.readBigInt64LE(p)===10n),strtab=tags.find(p=>original.readBigInt64LE(p)===5n);
    const needed=tags.find(p=>original.readBigInt64LE(p)===1n);assert.ok(strsz!==undefined&&strtab!==undefined&&needed!==undefined);
    const oversized=Buffer.from(original);oversized.writeBigUInt64LE(BigInt(original.length)+1n,strsz!+8);assert.throws(()=>elfInputs(oversized));
    const unbacked=Buffer.from(original);unbacked.writeBigUInt64LE(BigInt(original.length),strsz!+8);assert.throws(()=>elfInputs(unbacked));
    const unmapped=Buffer.from(original);unmapped.writeBigUInt64LE((1n<<64n)-1n,strtab!+8);assert.throws(()=>elfInputs(unmapped));
    const unterminated=Buffer.from(original),nulls=tags.filter(p=>original.readBigInt64LE(p)===0n);assert.ok(nulls.length>0);
    for(const p of nulls)unterminated.writeBigInt64LE(12n,p);assert.throws(()=>elfInputs(unterminated));
    const stringAddress=original.readBigUInt64LE(strtab!+8);
    const load=headers.find(p=>original.readUInt32LE(p)===1&&stringAddress>=original.readBigUInt64LE(p+16)&&
      stringAddress+original.readBigUInt64LE(strsz!+8)<=original.readBigUInt64LE(p+16)+original.readBigUInt64LE(p+32));assert.notEqual(load,undefined);
    const table=Number(original.readBigUInt64LE(load!+8)+stringAddress-original.readBigUInt64LE(load!+16));
    const name=table+Number(original.readBigUInt64LE(needed!+8)),tableEnd=table+Number(original.readBigUInt64LE(strsz!+8));
    // Red: a second LOAD maps a proper dynstr subrange to different file bytes,
    // even while the original LOAD remains the unique complete table container.
    const spare=headers.find(p=>![1,2,3].includes(original.readUInt32LE(p)));assert.notEqual(spare,undefined);
    assert.ok(original.readBigUInt64LE(strsz!+8)>1n&&table+1!==0);
    const overlapping=Buffer.from(original);overlapping.writeUInt32LE(1,spare!);overlapping.writeUInt32LE(4,spare!+4);
    overlapping.writeBigUInt64LE(0n,spare!+8);overlapping.writeBigUInt64LE(stringAddress+1n,spare!+16);
    overlapping.writeBigUInt64LE(stringAddress+1n,spare!+24);overlapping.writeBigUInt64LE(1n,spare!+32);
    overlapping.writeBigUInt64LE(1n,spare!+40);overlapping.writeBigUInt64LE(1n,spare!+48);
    assert.throws(()=>elfInputs(overlapping));
    // Red: nominal file ranges miss page-rounded remapping and anonymous BSS.
    // Both use actual Node metadata and offset/vaddr-congruent LOAD headers.
    const page=4096n,stringEnd=stringAddress+original.readBigUInt64LE(strsz!+8),firstPage=stringAddress/page*page;
    assert.ok(stringAddress%page!==0n||stringEnd%page!==0n,"actual dynstr needs a partial page for page-only fault");
    const pageAddress=stringAddress%page!==0n?firstPage:stringEnd;
    const mappedFilePage=(BigInt(table)+pageAddress-stringAddress)/page*page;
    const conflictingOffset=(mappedFilePage===0n?page:0n)+pageAddress%page;
    assert.ok(pageAddress+1n<=stringAddress||pageAddress>=stringEnd);assert.equal(conflictingOffset%page,pageAddress%page);
    const pageOnly=Buffer.from(original);pageOnly.writeUInt32LE(1,spare!);pageOnly.writeUInt32LE(4,spare!+4);
    pageOnly.writeBigUInt64LE(conflictingOffset,spare!+8);pageOnly.writeBigUInt64LE(pageAddress,spare!+16);
    pageOnly.writeBigUInt64LE(pageAddress,spare!+24);pageOnly.writeBigUInt64LE(1n,spare!+32);
    pageOnly.writeBigUInt64LE(1n,spare!+40);pageOnly.writeBigUInt64LE(page,spare!+48);
    assert.throws(()=>elfInputs(pageOnly));
    const bss=Buffer.from(original);bss.writeUInt32LE(1,spare!);bss.writeUInt32LE(6,spare!+4);
    bss.writeBigUInt64LE(0n,spare!+8);bss.writeBigUInt64LE(firstPage,spare!+16);bss.writeBigUInt64LE(firstPage,spare!+24);
    bss.writeBigUInt64LE(0n,spare!+32);bss.writeBigUInt64LE(page,spare!+40);bss.writeBigUInt64LE(page,spare!+48);
    assert.throws(()=>elfInputs(bss));
    const foreign=Buffer.from(original);foreign[name]=47;assert.throws(()=>elfInputs(foreign));
    const noNameEnd=Buffer.from(original);noNameEnd.fill(65,name,Math.min(name+256,tableEnd));assert.throws(()=>elfInputs(noNameEnd));
  });
  // Red: permit writer extends inherited guest ends or accepts an exhausted
  // cleanup margin. DATA hashes never count as admission in this pure codec.
  test("fresh permit intersects enclosing original ends without renewal",()=>{
    const anchor=1_000_000_000n,p=finitePermit("native-test","a".repeat(32),"b".repeat(64),anchor,anchor+90_000_000_000n,anchor+150_000_000_000n) as {workEndNs:string;cleanupEndNs:string;coldEndNs:string;notBeforeNs:string};assert.equal(p.workEndNs,(anchor+90_000_000_000n).toString());assert.equal(p.cleanupEndNs,(anchor+150_000_000_000n).toString());assert.equal(p.coldEndNs,(anchor+10_000_000_000n).toString());assert.equal(p.notBeforeNs,anchor.toString());assert.throws(()=>finitePermit("native-test","a".repeat(32),"b".repeat(64),anchor,anchor,anchor+150_000_000_000n));assert.throws(()=>finitePermit("native-test","a".repeat(32),"b".repeat(64),anchor,anchor+90_000_000_000n,anchor+95_000_000_000n));
  });
}
