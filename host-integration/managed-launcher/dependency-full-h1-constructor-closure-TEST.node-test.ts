/** Pure negative contract cases. DATA validation never creates a parent or native qualification. */
import test from "node:test";
import assert from "node:assert/strict";
import {constants,openSync,closeSync,fstatSync,readSync} from "node:fs";
import {createHash} from "node:crypto";
import {H1ElfRole,h1LibcCanonicalPath,validateH1ElfRole} from "./dependency-full-h1-elf-role-TEST.js";
import {H1CatalogKind,type H1CatalogEntry} from "./dependency-full-h1-staged-tools-TEST.js";
import {H1ConstructorHeld,h1HeldError,readH1ConstructorHeld,H1ApiKind,H1PidView,h1CanonicalCatalogPath,checkH1ActorStatusData,checkH1OwnedCgroupData,checkH1PythonRouteData,checkH1HostReleaseData,checkH1ApiObjectData,h1OriginalDeadlineData,h1ReadonlyCache} from "./dependency-full-h1-constructor-closure-TEST.js";
const identity={dev:"1",ino:"2",uid:"0",gid:"0",mode:"16877",nlink:"1",size:"0",mtimeNs:"1",ctimeNs:"1"};
function entry(path:string,kind=H1CatalogKind.Directory,target=""):H1CatalogEntry{return {path,kind,target,identity,sha256:kind===H1CatalogKind.File?"a".repeat(64):""};}
const catalog=[entry("usr"),entry("usr/lib"),entry("usr/lib/python3.12"),entry("usr/lib/python3.12/os.py",H1CatalogKind.File),entry("lib",H1CatalogKind.Alias,"usr/lib")];
test("load routes retain canonical aliases and the fixed genuine libc role while refusing foreign ELF shapes",()=>{
 assert.equal(h1CanonicalCatalogPath(catalog,"/lib/python3.12/os.py"),"/usr/lib/python3.12/os.py");
 for(const [rows,path] of [[catalog,"/lib/python3.12/missing.py"],[catalog,"/lib/python3.12/os.py/child"],[[entry("lib",H1CatalogKind.Alias,"other"),entry("other",H1CatalogKind.Alias,"lib")],"/lib"],[[entry("lib",H1CatalogKind.Alias,"/usr/lib")],"/lib"],[[entry("lib",H1CatalogKind.Alias,"../outside")],"/lib"],[catalog,"/lib/../root"]] as const)assert.throws(()=>h1CanonicalCatalogPath(rows,path),/unqualified_load_route/);
 // Genuine pinned public bytes are read, never loaded or executed. Mutated
 // copies below exercise role DATA only and cannot pass the physical Source hash.
 const path="/srv/workers/pr286-h1-toolroot-materialization-20261011-r1/scratch/h1-selected-toolroot-TEST"+h1LibcCanonicalPath,fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 let libc:Buffer;try{const before=fstatSync(fd,{bigint:true});assert.ok(before.isFile()&&before.uid===0n&&before.gid===0n&&before.nlink===1n&&before.dev===66305n&&before.ino===119932389n&&before.size===2129424n&&(before.mode&0o022n)===0n);libc=Buffer.alloc(2129424);let offset=0;while(offset<libc.length){const count=readSync(fd,libc,offset,libc.length-offset,offset);assert.ok(count>0);offset+=count;}assert.equal(readSync(fd,Buffer.alloc(1),0,1,offset),0);const after=fstatSync(fd,{bigint:true});assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);assert.equal(after.size,before.size);assert.equal(after.mtimeNs,before.mtimeNs);assert.equal(after.ctimeNs,before.ctimeNs);}finally{closeSync(fd);}
 assert.equal(libc.length,2129424);assert.equal(createHash("sha256").update(libc).digest("hex"),"3a15d66867d83762c7f2f1e37359cb8f6c5743edb369c65285cb0b1c4f7498bf");
 const facts=validateH1ElfRole(libc,H1ElfRole.Libc,"libc.so.6",h1LibcCanonicalPath);assert.equal(facts.elfType,3);assert.equal(facts.entry,172944n);assert.equal(facts.soname,"libc.so.6");assert.equal(facts.interpreter,"/lib64/ld-linux-x86-64.so.2");
 assert.throws(()=>validateH1ElfRole(libc,H1ElfRole.Extension));assert.throws(()=>validateH1ElfRole(libc,H1ElfRole.SharedObject,"libc.so.6"));
 for(const canonical of [undefined,"/lib/x86_64-linux-gnu/libc.so.6","/usr/lib/x86_64-linux-gnu/foreign.so"])assert.throws(()=>validateH1ElfRole(libc,H1ElfRole.Libc,"libc.so.6",canonical));
 assert.throws(()=>validateH1ElfRole(libc,H1ElfRole.Libc,"foreign.so",h1LibcCanonicalPath));
 const ph=Number(libc.readBigUInt64LE(32)),width=libc.readUInt16LE(54),count=libc.readUInt16LE(56),headers=Array.from({length:count},(_,i)=>ph+i*width),interp=headers.find(at=>libc.readUInt32LE(at)===3),dynamic=headers.find(at=>libc.readUInt32LE(at)===2);assert.ok(interp!==undefined&&dynamic!==undefined);
 const changed=(mutate:(bytes:Buffer)=>void)=>{const bytes=Buffer.from(libc);mutate(bytes);assert.throws(()=>validateH1ElfRole(bytes,H1ElfRole.Libc,"libc.so.6",h1LibcCanonicalPath));};
 changed(bytes=>bytes.writeUInt16LE(2,16));changed(bytes=>bytes.writeBigUInt64LE(0n,24));changed(bytes=>bytes.writeBigUInt64LE(0xfffffffffffffff0n,24));changed(bytes=>{bytes[Number(bytes.readBigUInt64LE(interp+8))]=120;});
 const start=Number(libc.readBigUInt64LE(dynamic+8)),size=Number(libc.readBigUInt64LE(dynamic+32));let sonameTag:number|undefined;for(let at=start;at<start+size;at+=16){const tag=libc.readBigInt64LE(at);if(tag===0n)break;if(tag===14n){sonameTag=at;break;}}assert.ok(sonameTag!==undefined);const sonameOffset=sonameTag;changed(bytes=>bytes.writeBigUInt64LE(0n,sonameOffset+8));

});
const caps=Array<string>(5).fill("0000000000200000");
const status="Uid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nTgid:\t101\nNSpid:\t101\nNoNewPrivs:\t1\n"+["Inh","Prm","Eff","Bnd","Amb"].map(key=>"Cap"+key+":\t"+caps[0]+"\n").join("");
test("live status rejects foreign Tgid, PID view, privilege changes and unknown capability masks",()=>{
 assert.doesNotThrow(()=>checkH1ActorStatusData(status,101,caps));
 for(const changed of [status.replace("Tgid:\t101","Tgid:\t102"),status.replace("NSpid:\t101","NSpid:\t999"),status.replace("NoNewPrivs:\t1","NoNewPrivs:\t0"),status.replace("Uid:\t0\t0\t0\t0","Uid:\t1\t1\t1\t1"),status.replace("CapEff:\t"+caps[0],"CapEff:\t0000000000000000"),status.replace("NSpid:\t101","NSpid:\t101\t2"),status+"Tgid:\t999\n"])assert.throws(()=>checkH1ActorStatusData(changed,101,caps),/foreign_actor_status/);
 assert.doesNotThrow(()=>checkH1ActorStatusData(status.replace("NSpid:\t101","NSpid:\t101\t2"),101,caps,H1PidView.Guest));
 assert.throws(()=>checkH1ActorStatusData(status,101,[".*",...caps.slice(1)]),/foreign_actor_status/);
});
function routes(){return {executable:"/usr/bin/python3.12",prefix:"/usr",execPrefix:"/usr",path:["/usr/lib/python312.zip","/usr/lib/python3.12","/usr/lib/python3.12/lib-dynload"],isolated:1,noSite:1,dontWriteBytecode:true,cache:h1ReadonlyCache,origArgv:["/usr/bin/python3.12","-I","-S","-B","-X","pycache_prefix="+h1ReadonlyCache,"-c"],modules:[["os","/usr/lib/python3.12/os.py"],["sys","built-in"]]};}
test("Python report cannot add HOST routes, bytecode, unknown import sources or weaken fixed flags",()=>{
 assert.doesNotThrow(()=>checkH1PythonRouteData(routes(),catalog));
 for(const changed of [{prefix:"/usr/local"},{executable:"/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"},{path:["/usr/local/lib/python3.12"]},{noSite:0},{isolated:0},{cache:"/tmp"},{modules:[["os","/usr/lib/python3.12/os.pyc"]]},{modules:[["foreign","/usr/lib/python3.12/missing.py"]]},{origArgv:["/usr/bin/python3.12","-c"]},{approved:true}])assert.throws(()=>checkH1PythonRouteData({...routes(),...changed},catalog));
});
test("Python contract inspection does not invoke object or array getters or Proxy traps",()=>{
 let calls=0;const getter={...routes()};Object.defineProperty(getter,"prefix",{enumerable:true,get(){calls++;return "/usr";}});
 assert.throws(()=>checkH1PythonRouteData(getter,catalog));assert.equal(calls,0);
 const array=["/usr/lib/python312.zip","/usr/lib/python3.12","/usr/lib/python3.12/lib-dynload"];Object.defineProperty(array,"0",{get(){calls++;return "HOST";}});
 assert.throws(()=>checkH1PythonRouteData({...routes(),path:array},catalog));assert.equal(calls,0);
 const proxy=new Proxy(routes(),{ownKeys(){calls++;return [];}});assert.throws(()=>checkH1PythonRouteData(proxy,catalog));assert.equal(calls,0);
 const arrayProxy=new Proxy(routes().path,{ownKeys(){calls++;return [];}});assert.throws(()=>checkH1PythonRouteData({...routes(),path:arrayProxy},catalog));assert.equal(calls,0);
 const sparse=routes().path;delete sparse[0];assert.throws(()=>checkH1PythonRouteData({...routes(),path:sparse},catalog));
 const extra=routes().path;Object.defineProperty(extra,"extra",{enumerable:true,value:"HOST"});assert.throws(()=>checkH1PythonRouteData({...routes(),path:extra},catalog));
});
test("generated host-release cells reject changed source transformation, extra routes and notify borrowing",()=>{
 const expected={container_host_id:"ubuntu"};assert.doesNotThrow(()=>checkH1HostReleaseData(Buffer.from("container_host_id=ubuntu\0PATH=/usr/bin:/bin\0"),expected));
 assert.doesNotThrow(()=>checkH1HostReleaseData(Buffer.from("container_host_id=ubuntu\0NOTIFY_SOCKET=/run/host/notify\0"),expected));
 for(const raw of ["container_host_id=foreign\0","container_host_id=ubuntu\0container_host_extra=value\0","container_host_id=ubuntu\0NOTIFY_SOCKET=/run/systemd/nspawn/notify\0","container_host_id=ubuntu\0NOTIFY_SOCKET=/run/host/foreign\0","container_host_id=ubuntu\0PYTHONPATH=/host\0","container_host_id=ubuntu\0container_host_id=ubuntu\0"])assert.throws(()=>checkH1HostReleaseData(Buffer.from(raw),expected));
});
test("kernel API physical class and ownership cannot be borrowed from a regular pathname",()=>{
 assert.doesNotThrow(()=>checkH1ApiObjectData("/proc",H1ApiKind.Directory,0n,0n,0o40555n));assert.throws(()=>checkH1ApiObjectData("/proc",H1ApiKind.Directory,0n,0n,0o46555n),/unknown_api_object/);
 for(const [path,kind,uid,gid] of [["/proc",H1ApiKind.Regular,0n,0n],["/dev/ptmx",H1ApiKind.Socket,0n,0n],["/host",H1ApiKind.Directory,0n,0n],["/proc",H1ApiKind.Directory,1n,0n],["/proc",H1ApiKind.Directory,0n,1n]] as const)assert.throws(()=>checkH1ApiObjectData(path,kind,uid,gid,0o40555n),/unknown_api_object/);
});
test("deadline depends on actual original start and same invocation, never validation call time",()=>{
 let calls=0;const unknown=new Proxy(new Error("private payload"),{getPrototypeOf(){calls++;throw Error("hook");}});assert.equal(readH1ConstructorHeld(unknown),undefined);assert.equal(calls,0);assert.equal(readH1ConstructorHeld(new Error("TEST H1 constructor Held: distro_verifier_tcb_missing")),undefined);try{h1HeldError(H1ConstructorHeld.Verifier);}catch(error){assert.equal(readH1ConstructorHeld(error),H1ConstructorHeld.Verifier);}
 const invocation="1".repeat(32),values={MainPID:"101",InvocationID:invocation,ExecMainStartTimestampMonotonic:"123456",RuntimeMaxUSec:"30min"};
 assert.equal(h1OriginalDeadlineData(values,101,invocation),1800123456000n);
 for(const changed of [{MainPID:"102"},{InvocationID:"2".repeat(32)},{ExecMainStartTimestampMonotonic:"0"},{ExecMainStartTimestampMonotonic:"-1"},{RuntimeMaxUSec:"60min"}])assert.throws(()=>h1OriginalDeadlineData({...values,...changed},101,invocation),/original_deadline_missing/);
});

// These malformed/foreign rows must not gain admission from a valid v2 row.
test("original host cgroup requires one owned v2 row and only the observed optional legacy root",()=>{
 const owned="/subscription.slice/owned.service",v2="0::"+owned+"\n",legacy="1:name=systemd:/\n";
 for(const raw of [v2,legacy+v2,v2+legacy])assert.doesNotThrow(()=>checkH1OwnedCgroupData(raw,owned));
 assert.doesNotThrow(()=>checkH1OwnedCgroupData(legacy+"0::"+owned+"/payload\n",owned,owned+"/payload"));
 for(const raw of ["",legacy,v2+v2,v2+legacy+legacy,v2+"0::/foreign\n",v2+"2:cpu:/\n",v2+"1:name=systemd:/foreign\n",v2+"\n",v2.slice(0,-1),v2.replace("\n","\r\n"),v2.replace(owned,owned+"/../foreign"),v2.replace(owned,"/subscription.slice//owned.service"),"0::"+owned+"/supervisor\n"])assert.throws(()=>checkH1OwnedCgroupData(raw,owned),/foreign_cgroup_rows/);
 assert.throws(()=>checkH1OwnedCgroupData(v2,owned+"/../foreign"),/foreign_cgroup_rows/);
 assert.throws(()=>checkH1OwnedCgroupData(v2,owned,owned),/foreign_cgroup_rows/);
});
