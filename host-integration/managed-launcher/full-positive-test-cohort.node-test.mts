import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,access} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
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
