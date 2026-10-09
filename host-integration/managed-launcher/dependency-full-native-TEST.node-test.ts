/** DATA-only regressions. No ROOT, filesystem, launch or account probe. */
import assert from "node:assert/strict";
import test from "node:test";
import { withOriginalH1PythonTool, withOriginalH1NamespaceTool, fullH1LibcAliasesData, fullH1LibcMetadataData, fullH1LibcMetadataMatches, FullRemovalCase, fullNativeRemovalCase, fullNativeParentArgv, captureFullNativeRequest,fullNativeJob,fullNativeUnit,fullNativeLimits,fullData,fullDataArray,fullNativeIntended,fullPublicRelative,fullReadonlyMountData,fullNativeGuestRoot } from "./dependency-full-native-TEST.js";
test("counterfeit accessors and proxies cannot execute during request capture",()=>{
  let calls=0;const getter={get jobId(){calls++;return "TEST-dependency-full-native-20261007-r1";}};
  const proxy=new Proxy({}, {get(){calls++;throw Error("TEST-private");},getPrototypeOf(){calls++;throw Error("TEST-private");},ownKeys(){calls++;throw Error("TEST-private");},getOwnPropertyDescriptor(){calls++;throw Error("TEST-private");}});
  for(const value of [getter,proxy]){assert.throws(()=>fullData(value,["jobId"]));assert.throws(()=>fullNativeIntended(value));}
  const revoked=Proxy.revocable({},{});revoked.revoke();assert.throws(()=>fullData(revoked.proxy,[]));assert.equal(calls,0);
});
test("command cells are descriptor snapshots rather than later caller reads",()=>{
  const input=["TEST-node","TEST-entry"],snapshot=fullDataArray(input);input[1]="TEST-changed";assert.deepEqual(snapshot,["TEST-node","TEST-entry"]);
  let calls=0;const getter=["TEST-node","TEST-entry"];Object.defineProperty(getter,"1",{get(){calls++;return "TEST-private";}});
  for(const value of [getter,new Proxy(input,{get(){calls++;throw Error("TEST-private");}}),["TEST-node"],["TEST-node","TEST-entry","TEST-extra"]])assert.throws(()=>fullDataArray(value));
  assert.equal(calls,0);
});
test("public catalog paths never admit protected, escaped or executable input",()=>{
  for(const path of ["../auth.json","dist/../secret.js","scripts/auth.json","node_modules/x/.env.json","host-integration/x/key.pem","/run/review.json","dist/x\u0000.js","dist/file.ts"])
    assert.equal(fullPublicRelative(path),false);
  assert.equal(fullPublicRelative("dist/worker-codex/codex-goal-cli.js"),true);
  assert.equal(fullPublicRelative("node_modules/@openai/codex/package.json"),true);
});
test("unknown or extra review fields remain refused DATA",()=>{
  assert.throws(()=>fullData({jobId:"TEST-fixed",approval:true},["jobId"]));assert.throws(()=>fullData(Object.create(null),[]));
  assert.throws(()=>fullData({[Symbol("TEST-private")]:true},[]));assert.deepEqual(fullData({jobId:"TEST-fixed"},["jobId"]),{jobId:"TEST-fixed"});
});
test("recognized request is copied DATA and changed limits cannot enter ROOT admission",()=>{
  const payload=["TEST-node","TEST-parent"],request={operation:"job",unit:fullNativeUnit,jobId:fullNativeJob,payload,fingerprint:"1".repeat(64),limits:{...fullNativeLimits}};
  const captured=captureFullNativeRequest(request);payload[0]="TEST-changed";request.fingerprint="2".repeat(64);assert.equal(captured.payload[0],"TEST-node");assert.equal(captured.fingerprint,"1".repeat(64));
  assert.throws(()=>captureFullNativeRequest({...request,limits:{...fullNativeLimits,memoryMiB:4096}}));
  let calls=0;const getter={...request,get limits(){calls++;return fullNativeLimits;}};assert.throws(()=>captureFullNativeRequest(getter));assert.equal(calls,0);
});

test("readonly mount DATA refuses stacked/writable/foreign physical observations",()=>{
  const root="1 1 8:1 / / rw - ext4 /dev/root rw\n",own="2 1 8:1 /input /TEST-input ro - ext4 /dev/root rw\n";
  assert.doesNotThrow(()=>fullReadonlyMountData(root+own,"/TEST-input","2","8:1"));
  for(const raw of [root+own+"3 1 8:1 /input /TEST-input rw - ext4 /dev/root rw\n",root+own+"3 2 8:1 /child /TEST-input/sub rw - ext4 /dev/root rw\n",root+own+own,root+own.replace(" ro "," rw ")])assert.throws(()=>fullReadonlyMountData(raw,"/TEST-input","2","8:1"));
  assert.throws(()=>fullReadonlyMountData(root+own,"/TEST-input","1","8:1"));assert.throws(()=>fullReadonlyMountData(root+own,"/TEST-input","2","8:2"));
});

test("FULL guest roots refuse global and foreign staging prefixes",()=>{
  const id="a1234567-89ab-cdef-0123-456789abcdef",root="/srv/workers/jobs/TEST-dependency-full-native-20261007-r1/os-TEST/"+id+"/root";
  assert.equal(fullNativeGuestRoot(id,root),true);
  for(const value of ["/var/lib/subscription-runtime-os-TEST/"+id+"/root","/srv/workers/jobs/TEST-other/os-TEST/"+id+"/root",root+"/extra",root.replace("/os-TEST/","/os-TEST//"),root.replace("/os-TEST/","/os-TEST/../os-TEST/"),null])
    assert.equal(fullNativeGuestRoot(id,value),false);
  assert.equal(fullNativeGuestRoot("../"+id,root),false);
  assert.equal(fullNativeGuestRoot(id.toUpperCase(),root),false);
});

// Red if moving input under writable job scratch leaves either input writable,
// or permits a mount/descriptor observation from another input root.
test("FULL input readonly mounts override job scratch write access",()=>{
  const job="/srv/workers/jobs/TEST-dependency-full-native-20261007-r1";
  const input=job+"/input/"+"1".repeat(40);
  const source=input+"/source",toolchain=input+"/toolchain";
  const host="1 1 8:1 / / ro - ext4 /dev/root rw\n";
  const scratch="2 1 8:1 /job "+job+" rw - ext4 /dev/root rw\n";
  const sourceMount="3 2 8:1 /source "+source+" ro - ext4 /dev/root rw\n";
  const toolchainMount="4 2 8:1 /toolchain "+toolchain+" ro - ext4 /dev/root rw\n";
  const snapshot=host+scratch+sourceMount+toolchainMount;
  assert.doesNotThrow(()=>fullReadonlyMountData(snapshot,source,"3","8:1"));
  assert.doesNotThrow(()=>fullReadonlyMountData(snapshot,toolchain,"4","8:1"));
  assert.throws(()=>fullReadonlyMountData(host+scratch+sourceMount,toolchain,"2","8:1"));
  assert.throws(()=>fullReadonlyMountData(host+scratch+toolchainMount,source,"2","8:1"));
  for(const writable of [toolchain,toolchain+"/bin"]) {
    const masked=snapshot+"5 2 8:1 /masked "+writable+" rw - ext4 /dev/root rw\n";
    assert.throws(()=>fullReadonlyMountData(masked,toolchain,"4","8:1"));
  }
  for(const foreign of ["/var/lib/subscription-runtime-full-TEST-input/"+"1".repeat(40)+"/toolchain","/srv/workers/jobs/TEST-other/input/"+"1".repeat(40)+"/toolchain"]) {
    assert.throws(()=>fullReadonlyMountData(snapshot,foreign,"4","8:1"));
  }
});

// Red if the default command changes, H1 loses its fingerprint command cell,
// or arbitrary caller flags can enter the fixed exceptional request.
test("H1 is a separate finite removal case with one fixed parent argv flag",()=>{
  assert.equal(fullNativeRemovalCase(undefined),FullRemovalCase.Positive);
  assert.deepEqual(fullNativeParentArgv("TEST-node","TEST-parent",FullRemovalCase.Positive),["TEST-node","TEST-parent"]);
  assert.deepEqual(fullNativeParentArgv("TEST-node","TEST-parent",FullRemovalCase.ParentCrashH1),["TEST-node","TEST-parent","--parent-crash-h1"]);
  for(const value of [null,"readonly","h1",{},"--parent-crash-h1"])assert.throws(()=>fullNativeRemovalCase(value));
  const request={operation:"job",unit:fullNativeUnit,jobId:fullNativeJob,payload:["TEST-node","TEST-parent","--parent-crash-h1"],fingerprint:"1".repeat(64),limits:{...fullNativeLimits}};
  assert.deepEqual(captureFullNativeRequest(request).payload,request.payload);
  for(const flag of ["--h1","--readonly","--parent-crash-h1 --exec"])assert.throws(()=>captureFullNativeRequest({...request,payload:["TEST-node","TEST-parent",flag]}));
  let calls=0;const payload=["TEST-node","TEST-parent","--parent-crash-h1"];Object.defineProperty(payload,"2",{get(){calls++;return "--parent-crash-h1";}});
  assert.throws(()=>captureFullNativeRequest({...request,payload}));assert.equal(calls,0);
});

// Red if the single H1 libc exception broadens to a different inode, link3,
// mutable/root-foreign leaf, or changed metadata. This supplies no host grant.
test("H1 libc requires exact reviewed root-owned two-link metadata",()=>{
  const expected={dev:"8",ino:"101",uid:"0",gid:"0",mode:String(0o100755),nlink:"2",size:"4096",mtimeNs:"123",ctimeNs:"456"};
  assert.deepEqual(fullH1LibcMetadataData(expected),expected);assert.doesNotThrow(()=>fullH1LibcMetadataMatches({...expected},expected));
  for(const changed of [{nlink:"1"},{nlink:"3"},{uid:"1"},{gid:"1"},{mode:String(0o100777)},{ino:"102"},{size:"4097"},{mtimeNs:"124"},{ctimeNs:"457"}])assert.throws(()=>fullH1LibcMetadataMatches({...expected,...changed},expected));
  assert.throws(()=>fullH1LibcMetadataData({...expected,grant:true}));
});

test("H1 libc two-name DATA never widens to unknown hardlink routes",()=>{
  // Synthetic names test the finite parser only; no real second alias is claimed.
  const canonical="/usr/lib/x86_64-linux-gnu/libc.so.6",other="/usr/lib/x86_64-linux-gnu/TEST-libc-closed-name";
  assert.deepEqual(fullH1LibcAliasesData([other,canonical]),[other,canonical]);
  for(const names of [[canonical,canonical],[canonical,other],[other,"/usr/lib/x86_64-linux-gnu/TEST-other"],["/srv/TEST/libc.so.6",canonical],[other,canonical,"/usr/lib/x86_64-linux-gnu/TEST-third"]])assert.throws(()=>fullH1LibcAliasesData(names));
});

// Uses the actual private tool entry points. The unsupported source gate must
// refuse before any callback/descriptor access, independent of parent identity.
// This creates no parent brand, child, ROOT fixture or qualification claim.
test("unsupported H1 stdlib closure cannot reach private tool callbacks",()=>{
  let calls=0;const parent=Object.freeze({});
  assert.throws(()=>withOriginalH1PythonTool(parent,()=>{calls++;throw Error("child launch must be unreachable");}),/Held: h1_python_stdlib_source_unsupported$/);
  assert.throws(()=>withOriginalH1NamespaceTool(parent,()=>{calls++;throw Error("child launch must be unreachable");}),/Held: h1_python_stdlib_source_unsupported$/);
  assert.equal(calls,0);
});
