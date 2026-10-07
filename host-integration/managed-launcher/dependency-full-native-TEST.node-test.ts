/** DATA-only regressions. No ROOT, filesystem, launch or account probe. */
import assert from "node:assert/strict";
import test from "node:test";
import { captureFullNativeRequest,fullNativeJob,fullNativeUnit,fullNativeLimits,fullData,fullDataArray,fullNativeIntended,fullPublicRelative,fullReadonlyMountData,fullNativeGuestRoot } from "./dependency-full-native-TEST.js";
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
