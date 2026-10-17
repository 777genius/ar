import assert from "node:assert/strict";
import test from "node:test";
import {readHostedFdProcessBirth,HostedFdLaunchKind} from "../../src/provider-codex/app-server/adapters/hosted-fd-child.ts";
import {createRequire} from "node:module";
import {providerSetupBirthData,providerSetupUnitData,providerSetupDescriptorsData,providerSetupFileMappingsData,providerSetupQueryClosureData,providerSetupQueryBeforeIntent,originalProviderSetupSlot,type OriginalSetupContext} from "./dependency-full-provider-setup-TEST.ts";
import type {HostedFdFact} from "../../src/provider-codex/app-server/adapters/hosted-fd-table.ts";
const require=createRequire(import.meta.url);
// The actual native module is emitted from this source by the bounded harness.
const native=require(process.env.TEST_NATIVE_MODULE!) as typeof import("./dependency-full-native-TEST.js");
const socket=(fd:number):HostedFdFact=>({fd,target:`socket:[${fd+100}]`,flags:2,dev:"9",ino:String(fd+100),rdev:"0",socket:true,pipe:false,character:false,file:false,directory:false});
const descriptors=[0,1,2].map(socket);
const lifecycleRows={Type:"exec",ExitType:"main",RemainAfterExit:"no",KillMode:"control-group",SendSIGKILL:"yes",Restart:"no",Delegate:"no",ProtectControlGroups:"yes",TimeoutStopUSec:"30s",KillSignal:"15",FinalKillSignal:"9"};
const observed={...lifecycleRows,Id:"subscription-runtime-hosted-abc.service",InvocationID:"a".repeat(32),MainPID:"23",ControlGroup:"/system.slice/subscription-runtime-hosted-abc.service",RootDirectory:"/original/provider-root"};
const unit={lifecycle:{...lifecycleRows,TimeoutStopUSec:"30000000"},unit:observed.Id,invocation:observed.InvocationID,mainPid:23,group:observed.ControlGroup,root:observed.RootDirectory};
test("actual native reader rejects JSON, prototype and proxy parent forgery before kernel access",()=>{
 const task={path:"/unreadable/foreign-proc",processPid:23,processBirth:"123",birth:"123",revalidate(){throw Error("must not run");}};
 for(const forged of [{},{...unit,read(){return unit;}},Object.create(native),new Proxy({},{})])assert.throws(()=>native.readOriginalFullProviderSetupTask(forged,task));
});
test("external factual slot cannot create native original-parent membership",()=>{
 const unused=()=>{throw Error("must not touch filesystem or invoke query");};
 const slot=originalProviderSetupSlot({root:"/foreign",group:"/foreign",pairSha256:"a".repeat(64),invocationSealSha256:"b".repeat(64),outbox:"/foreign",systemdRunExecutable:"/unused",recipeSources:unused,source:unused,revalidate:unused,queryTool:unused,seal:unused,fdTable:unused,parsePeers:unused,peer:unused,namespacePrefix:[],parentRecipe:unused} satisfies OriginalSetupContext);
 const task={path:"/foreign",processPid:23,processBirth:"123",birth:"123",revalidate:unused};
 assert.equal(slot.read(task),undefined);assert.throws(()=>native.readOriginalFullProviderSetupTask(slot,task));
});
test("production birth parser rejects another PID, missing birth and malformed ticks",()=>{
 assert.equal(providerSetupBirthData(23,"23:123"),"123");
 for(const [pid,birth] of [[23,"24:123"],[23,"23:0"],[23,"23:123:4"],[23,"123"],[23,"23:001"],[0,"0:123"],[23,123]])assert.throws(()=>providerSetupBirthData(pid,birth));
});
test("production unit join rejects foreign unit, invocation, MainPID, cgroup and root",()=>{
 assert.deepEqual(providerSetupUnitData(unit,observed),unit);
 for(const [key,value] of Object.entries({unit:"foreign.service",invocation:"b".repeat(32),mainPid:24,group:"/foreign",root:"/foreign"}))assert.throws(()=>providerSetupUnitData({...unit,[key]:value},observed));
 assert.throws(()=>providerSetupUnitData({...unit,grant:true},observed));
});
test("production FD join rejects foreign sockets, extra descriptor and missing birth endpoint",()=>{
 providerSetupDescriptorsData(descriptors,descriptors,descriptors);
 for(const expected of [[...descriptors,socket(3)],descriptors.slice(0,2),descriptors.map(fd=>fd.fd===1?{...fd,target:"socket:[999]"}:fd),descriptors.map(fd=>fd.fd===1?{...fd,socket:false}:fd)])assert.throws(()=>providerSetupDescriptorsData(expected,descriptors,descriptors));
 assert.throws(()=>providerSetupDescriptorsData(descriptors,descriptors.slice(1),descriptors));
 assert.throws(()=>providerSetupDescriptorsData(descriptors,descriptors,descriptors.map(fd=>({...fd,ino:"foreign"}))));
});

test("production source-map parser distinguishes private anonymous VMAs from file closure",()=>{
 const file="1000-2000 r-xp 0000 08:01 123 /usr/bin/unshare",anon="2000-3000 rw-p 0000 00:00 0 [heap]";
 assert.deepEqual(providerSetupFileMappingsData(file+"\n"+anon+"\n"),[{path:"/usr/bin/unshare",major:"08",minor:"01",inode:"123"}]);
 for(const row of [file.replace("r-xp","rw-s"),file+" (deleted)",anon.replace("[heap]","[unknown]"),file.replace("123","0")])assert.throws(()=>providerSetupFileMappingsData(row));
});

test("actual FDA child birth WeakMap rejects structural and foreign child proof",()=>{
 for(const child of [{pid:23,exitCode:null,signalCode:null},new Proxy({pid:23},{})])assert.throws(()=>readHostedFdProcessBirth(child as never,"original.service",HostedFdLaunchKind.Provider,"/usr/bin/systemd-run",[]));
});

test("production HOST query closure rejects missing interpreter, transitive dependency and extra rows",()=>{
 const loader={path:"/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",soname:"ld-linux-x86-64.so.2",needed:[],interpreter:null};
 const program={path:"/usr/bin/nsenter",soname:"",needed:["libmount.so.1"],interpreter:"/lib64/ld-linux-x86-64.so.2"};
 const mount={path:"/usr/lib/x86_64-linux-gnu/libmount.so.1.1.0",soname:"libmount.so.1",needed:["libc.so.6"],interpreter:null};
 const libc={path:"/usr/lib/x86_64-linux-gnu/libc.so.6",soname:"libc.so.6",needed:["ld-linux-x86-64.so.2"],interpreter:"/lib64/ld-linux-x86-64.so.2"};
 const rows=[program,loader,mount,libc];assert.equal(providerSetupQueryClosureData(rows).command,loader.path);
 for(const bad of [rows.filter(row=>row!==loader),rows.filter(row=>row!==libc),[...rows,{...mount,path:"/foreign",soname:"foreign.so"}],rows.map(row=>row===program?{...row,interpreter:"/foreign"}:row)])assert.throws(()=>providerSetupQueryClosureData(bad));
});

test("actual pre-intent query gate requires complete HOST and both guest query recipes",()=>{
 const calls:string[]=[];
 const host=()=>{calls.push("HOST");return {command:"/original/loader",prefix:[]};};
 providerSetupQueryBeforeIntent({queryTool:host,recipeSources(paths){calls.push(...paths);}});
 assert.deepEqual(calls,["HOST","/usr/bin/systemctl","/usr/bin/ss"]);
 for(const missing of ["HOST","/usr/bin/systemctl","/usr/bin/ss"]){
  const actions:string[]=[];
  assert.throws(()=>{
   providerSetupQueryBeforeIntent({queryTool(){actions.push("HOST");if(missing==="HOST")throw Error("Held");return {command:"/original/loader",prefix:[]};},recipeSources(paths){for(const path of paths){actions.push(path);if(path===missing)throw Error("Held");}}});
   actions.push("intent acknowledgement");
  },/Held/);
  assert(!actions.includes("intent acknowledgement"));
 }
});


test("HOST unit join independently rejects each changed lifecycle fact",()=>{
 for(const key of Object.keys(lifecycleRows))assert.throws(()=>providerSetupUnitData({...unit,lifecycle:{...unit.lifecycle,[key]:"foreign"}},observed));
 for(const [key,value] of Object.entries({ProtectControlGroups:"no",TimeoutStopUSec:"29s"}))assert.throws(()=>providerSetupUnitData(unit,{...observed,[key]:value}));
 assert.throws(()=>providerSetupUnitData({...unit,lifecycle:{...unit.lifecycle,grant:true}},observed));
});
