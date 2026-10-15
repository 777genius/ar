import test from "node:test";
// Emit the pinned DATA-only cohort leaf without executing its endpoint main.
import type {} from "../host-jobs/endpoint.mjs";
import assert from "node:assert/strict";
import {mkdtemp,rm,access,readFile,mkdir,copyFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {fileURLToPath,pathToFileURL} from "node:url";
import {tmpdir} from "node:os";
import {join,dirname,resolve} from "node:path";
import {managedLauncherInvocation,ManagedLauncherProfile,fullPositiveTestJob,fullPositiveTestEntry,legacyFullTestJob,buildSystemdInvocation} from "./launch.mjs";
import {HostJobs} from "../host-jobs/manager.mjs";
const request={operation:"job",unit:"subscription-job-"+"a".repeat(64)+".service",payload:["/usr/bin/true"],jobId:fullPositiveTestJob,fingerprint:"a".repeat(64),limits:{runtimeSeconds:90,stopSeconds:30,memoryMiB:256,tasksMax:64,cpuPercent:100}};
test("reserved TEST jobs cannot fall through Standard or provider admission",async()=>{
 for(const jobId of [fullPositiveTestJob,legacyFullTestJob])assert.throws(()=>managedLauncherInvocation({...request,jobId}));
 assert.throws(()=>managedLauncherInvocation({...request,operation:"provider",payload:["/usr/bin/node","/opt/runtime/hosted-app-server-launcher.js"],unit:"subscription-runtime-hosted-"+"a".repeat(36)+".service"},ManagedLauncherProfile.FixedFullPositiveTest));
 assert.throws(()=>managedLauncherInvocation({...request,jobId:"ordinary-test"},ManagedLauncherProfile.FixedFullPositiveTest));
 await assert.rejects(buildSystemdInvocation({...request,jobId:legacyFullTestJob}));
 const actual=managedLauncherInvocation(request,ManagedLauncherProfile.FixedFullPositiveTest);
 assert.deepEqual(actual.args,[fullPositiveTestEntry,"job",JSON.stringify(request)]);
});
test("wrong fixed profile refuses before machine reads, ledger creation or submit",async()=>{
 const state=join(await mkdtemp(join(tmpdir(),"TEST-cohort-")),"new-ledger");let reads=0,effects=0;
 try{const manager=new HostJobs({stateDir:state,launcherProfile:ManagedLauncherProfile.FixedFullPositiveTest,machineId:async()=>{reads++;return "a".repeat(32);},run:async()=>{effects++;return "";}});
 await assert.rejects(manager.start({operation:"start",jobId:"wrong-test",machineId:"a".repeat(32),argv:["/usr/bin/true"],runtimeSeconds:90,stopSeconds:30,memoryMiB:256,tasksMax:64,cpuPercent:100}));
 assert.equal(reads,0);assert.equal(effects,0);await assert.rejects(access(state));
 }finally{await rm(join(state,".."),{recursive:true,force:true});}
});

test("actual installed FULL cohort resolves native module and retains custody refusal",async()=>{
 const root=await mkdtemp(join(tmpdir(),"TEST-installed-full-cohort-"));
 try{
  // Consume the original emitted installer's private copy table, rather than
  // inventing a second cohort or adding the source-only native .js alias.
  const sourceRoot=fileURLToPath(new URL("../../",import.meta.url));
  const native=await readFile(new URL("./dependency-full-native-TEST.js",import.meta.url),"utf8");
  const table=/const fullPositiveTestCohort = Object.freeze\(\[([\s\S]*?)\]\);/.exec(native);
  assert(table);const pair=/\["([^"\n]+)", "([^"\n]+)"\]/g;
  const rows=[...table[1]!.matchAll(pair)];
  assert.equal(table[1]!.replace(pair,"").replace(/\/\/[^\n]*/g,"").replace(/[\s,]/g,""),"");
  assert(rows.length>0 && rows.length<=64);
  const targets=new Set<string>();
  for(const row of rows){
   const source=row[1]!,target=row[2]!;
   assert(/^(?:host-integration|dist)\/[A-Za-z0-9_./-]+\.(?:js|mjs)$/.test(source));
   assert(/^(?:host-jobs|managed-launcher)\/[A-Za-z0-9_.-]+\.(?:js|mjs)$/.test(target));
   assert(!source.split("/").includes("..") && !targets.has(target));targets.add(target);
   const destination=join(root,target);await mkdir(dirname(destination),{recursive:true});
   await copyFile(resolve(sourceRoot,source),destination);
  }
  await assert.rejects(access(join(root,"managed-launcher/dependency-full-native-TEST.js")));
  await access(join(root,"managed-launcher/dependency-full-native-TEST.mjs"));
  const launcher=pathToFileURL(join(root,"managed-launcher/launch.mjs")).href;
  // This child selects the fixed branch only. It cannot satisfy the original
  // physical entry/source/ROOT/ledger checks and receives no custody grant.
  const code=`import assert from "node:assert/strict";
import {buildSystemdInvocation,fullPositiveTestEntry} from ${JSON.stringify(launcher)};
process.argv[1]=fullPositiveTestEntry;
await assert.rejects(buildSystemdInvocation(${JSON.stringify(request)}),error=>{
 assert(error instanceof Error);
 assert.equal(error.message,"TEST full managed ingress Held");
 assert(error.stack?.includes("dependency-full-native-TEST.mjs"));
 return true;
});`;
  const child=spawnSync(process.execPath,["--input-type=module","--eval",code],{
   cwd:root,env:{PATH:"/usr/bin:/bin",LANG:"C"},encoding:"utf8",timeout:10000,maxBuffer:65536,
  });
  assert.ifError(child.error);assert.equal(child.signal,null);
  assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,"");
 }finally{await rm(root,{recursive:true,force:true});}
});
