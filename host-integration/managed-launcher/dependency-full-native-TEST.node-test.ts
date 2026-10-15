/** DATA-only regressions. No ROOT, filesystem, launch or account probe. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import {fullPositiveInstallerCapabilitiesData,fullPositiveSnapshotLeafData,constructOriginalH1StagedObserver,closeOriginalH1StagedObserver,readOriginalH1StagedTask,fullNativeSourcePackageHash, fullPositiveHostStableAncestors,FullPositiveAccount,fullPositiveOuterReviewData,fullReviewData, withOriginalH1PythonTool, withOriginalH1NamespaceTool, fullH1LibcAliasesData, fullH1LibcMetadataData, fullH1LibcMetadataMatches, FullRemovalCase, fullNativeRemovalCase, fullNativeParentArgv, captureFullNativeRequest,fullNativeJob,fullNativeUnit,fullNativeLimits,fullData,fullDataArray,fullNativeIntended,fullPublicRelative,fullReadonlyMountData,fullNativeGuestRoot } from "./dependency-full-native-TEST.js";
// Red if unrelated capabilities or a different large leaf gain admission.
// These parsers supply no namespace proof, descriptor custody or ROOT grant.
test("installer capability DATA requires only ptrace, no inherited/ambient capabilities, and NNP",()=>{
  const rows={CapEff:"0000000000080000",CapPrm:"0000000000080000",CapBnd:"0000000000080000",CapInh:"0000000000000000",CapAmb:"0000000000000000",NoNewPrivs:"1"};
  const status=(values:Record<string,string>)=>Object.entries(values).map(([key,value])=>key+":\t"+value+"\n").join("");
  assert.doesNotThrow(()=>fullPositiveInstallerCapabilitiesData(status(rows)));
  for(const key of ["CapEff","CapPrm","CapBnd"]){
    for(const value of ["0000000000000000","0000000000280000","000001ffffffffff"])assert.throws(()=>fullPositiveInstallerCapabilitiesData(status({...rows,[key]:value})));
  }
  for(const changed of [{CapInh:"0000000000080000"},{CapAmb:"0000000000080000"},{NoNewPrivs:"0"}])assert.throws(()=>fullPositiveInstallerCapabilitiesData(status({...rows,...changed})));
  assert.throws(()=>fullPositiveInstallerCapabilitiesData(status(rows)+"CapBnd:\t0000000000080000\n"));
  assert.throws(()=>fullPositiveInstallerCapabilitiesData(status(rows).replace("CapEff:\t0000000000080000\n","")));
});
test("installer snapshot large-leaf DATA is exact measured Claude bytes only",()=>{
  const leaf="node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude";
  assert.equal(fullPositiveSnapshotLeafData(leaf,334715184,0o100755),"73975167f0108693cf6fd6614994781657ebb8456ebef5d247458734abfb3916");
  assert.equal(fullPositiveSnapshotLeafData("node_modules/other/file",128*1024**2,0o100644),null);
  for(const path of ["toolchain/bin/claude","dist/claude","node_modules/other/claude",leaf+".changed","../"+leaf,"source/"+leaf])assert.throws(()=>fullPositiveSnapshotLeafData(path,334715184,0o100755));
  for(const size of [128*1024**2,334715183,334715185,512*1024**2,512*1024**2+1])assert.throws(()=>fullPositiveSnapshotLeafData(leaf,size,0o100755));
  for(const mode of [0o100644,0o100775,0o104755,0o120755])assert.throws(()=>fullPositiveSnapshotLeafData(leaf,334715184,mode));
  assert.throws(()=>fullPositiveSnapshotLeafData("node_modules/other/file",128*1024**2+1,0o100644));
  assert.throws(()=>fullPositiveSnapshotLeafData(leaf,NaN,0o100755));
});
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
  const id="a1234567-89ab-cdef-0123-456789abcdef",root="/srv/workers/jobs/TEST-dependency-full-positive-scoped-20261014-r1/os-TEST/"+id+"/root";
  assert.equal(fullNativeGuestRoot(id,root),true);
  for(const value of ["/srv/workers/jobs/TEST-dependency-full-positive-scoped-20261010-r1/os-TEST/"+id+"/root","/srv/workers/jobs/TEST-dependency-full-native-20261007-r1/os-TEST/"+id+"/root","/var/lib/subscription-runtime-os-TEST/"+id+"/root","/srv/workers/jobs/TEST-other/os-TEST/"+id+"/root",root+"/extra",root.replace("/os-TEST/","/os-TEST//"),root.replace("/os-TEST/","/os-TEST/../os-TEST/"),null])
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

// Pure parser regressions: these records never install, issue or launch anything.
test("FULL review schema2 is exact fixed-r Positive/Ordinary and cannot downgrade",()=>{
  const common={schemaVersion:1,sourceBaseSha:"1".repeat(40),sourceSha:"2".repeat(40),sourceTree:"3".repeat(40),machineId:"4".repeat(32),bootId:"TEST-boot",nodeSha256:"5".repeat(64),launcherSha256:"5".repeat(64),moduleSha256:"5".repeat(64),parentSha256:"5".repeat(64),catalogSha256:"5".repeat(64),outerReviewSha256:"5".repeat(64),publicReviewSha256:"5".repeat(64),accountName:"account-u",reviewReference:"TEST-reviewed",hostTools:{},systemdVersion:"TEST-systemd",installedModules:{}};
  assert.equal(fullReviewData(common).schemaVersion,1);
  const next={...common,schemaVersion:2,accountName:"account-r",removalCase:"positive",restoreConsumer:"ordinary"};
  assert.equal(fullReviewData(next).schemaVersion,2);
  for(const changed of [{schemaVersion:3},{accountName:"account-u"},{removalCase:"parent_crash_h1"},{restoreConsumer:"readonly"},{extra:true},{h1StagedSubject:{}},{hostIdentity:{}}])assert.throws(()=>fullReviewData({...next,...changed}));
  for(const key of ["removalCase","restoreConsumer"]){const missing:Record<string,unknown>={...next};delete missing[key];assert.throws(()=>fullReviewData(missing));}
  let calls=0;const accessor={...next};Object.defineProperty(accessor,"schemaVersion",{get(){calls++;return 1;},enumerable:true});assert.throws(()=>fullReviewData(accessor));assert.equal(calls,0);
  assert.throws(()=>fullReviewData({...common,hostIdentity:{}}));
});

// Red on old admission: unconsumed or wrong-purpose exception DATA is accepted.
// These records do not open any host source or manufacture original authority.
function positiveLibcReview() {
  const libc={path:"/usr/lib/x86_64-linux-gnu/libc.so.6",sha256:"3a15d66867d83762c7f2f1e37359cb8f6c5743edb369c65285cb0b1c4f7498bf",libcTuple:{dev:"2306",ino:"20447787",uid:"0",gid:"0",mode:"33261",nlink:"2",size:"2129424",mtimeNs:"1788444912000000000",ctimeNs:"1791309430250956960"},libcAliases:["/nonexistent/.debug/usr/lib/x86_64-linux-gnu/libc.so.6/a4a7992a8e66555c8141ab2a08a8465ff6e0ea65/elf","/usr/lib/x86_64-linux-gnu/libc.so.6"]};
  const tools={git:"1".repeat(64),systemctl:"1".repeat(64),systemdRun:"1".repeat(64),lsns:"1".repeat(64),systemdPid1:"1".repeat(64),bootstrapNode:"1".repeat(64),systemdNspawn:"1".repeat(64),systemdNspawnClosure:[{path:libc.path,sha256:libc.sha256}],positiveHostLibc:libc};
  return {schemaVersion:2,sourceBaseSha:"1".repeat(40),sourceSha:"2".repeat(40),sourceTree:"3".repeat(40),machineId:"4".repeat(32),bootId:"TEST-boot",nodeSha256:"5".repeat(64),launcherSha256:"5".repeat(64),moduleSha256:"5".repeat(64),parentSha256:"5".repeat(64),catalogSha256:"5".repeat(64),outerReviewSha256:"5".repeat(64),publicReviewSha256:"5".repeat(64),accountName:"account-r",reviewReference:"TEST-reviewed",hostTools:tools,systemdVersion:"TEST-systemd",installedModules:{},removalCase:"positive",restoreConsumer:"ordinary"};
}
test("Positive HOST libc DATA is finite and consumed exactly once",()=>{
  const review=positiveLibcReview(),libc=review.hostTools.positiveHostLibc;
  assert.doesNotThrow(()=>fullReviewData(review));
  const {positiveHostLibc:unused,...ordinary}=review.hostTools;
  assert.doesNotThrow(()=>fullReviewData({...review,hostTools:ordinary}));
  for(const change of [{path:"/usr/lib/x86_64-linux-gnu/TEST-other"},{sha256:"1".repeat(64)},{extra:true},{libcTuple:{...libc.libcTuple,nlink:"3"}},{libcTuple:{...libc.libcTuple,mode:"33188"}},{libcTuple:{...libc.libcTuple,uid:"1"}},{libcTuple:{...libc.libcTuple,extra:true}},{libcAliases:[...libc.libcAliases].reverse()},{libcAliases:[...libc.libcAliases,libc.path]},{libcAliases:[libc.libcAliases[0]!.replace("a4a7992","b4a7992"),libc.path]}])
    assert.throws(()=>fullReviewData({...review,hostTools:{...review.hostTools,positiveHostLibc:{...libc,...change}}}));
  for(const rows of [[],[{path:libc.path,sha256:"1".repeat(64)}],[...review.hostTools.systemdNspawnClosure,...review.hostTools.systemdNspawnClosure],[{path:libc.libcAliases[0],sha256:libc.sha256}],[{path:libc.path,sha256:libc.sha256,libcTuple:libc.libcTuple}]])
    assert.throws(()=>fullReviewData({...review,hostTools:{...review.hostTools,systemdNspawnClosure:rows}}));
  assert.throws(()=>fullH1LibcAliasesData(libc.libcAliases));
});
test("Positive HOST libc DATA cannot select schema1 H1 or another role",()=>{
  const review=positiveLibcReview();
  for(const change of [{schemaVersion:1},{schemaVersion:1,accountName:"account-u"},{schemaVersion:1,removalCase:"parent_crash_h1"},{accountName:"account-u"},{removalCase:"parent_crash_h1"},{restoreConsumer:"readonly"},{removalCase:"private_g1"}])assert.throws(()=>fullReviewData({...review,...change}));
});
test("Positive HOST libc DATA never invokes input hooks",()=>{
  const review=positiveLibcReview();let calls=0;
  const proxy=new Proxy(review.hostTools.positiveHostLibc,{ownKeys(){calls++;throw Error("input hook");},get(){calls++;throw Error("input hook");},getPrototypeOf(){calls++;throw Error("input hook");}});
  const accessor={...review.hostTools.positiveHostLibc};Object.defineProperty(accessor,"sha256",{enumerable:true,get(){calls++;throw Error("input hook");}});
  const json={...review.hostTools.positiveHostLibc,toJSON(){calls++;throw Error("input hook");}};
  for(const value of [proxy,accessor,json])assert.throws(()=>fullReviewData({...review,hostTools:{...review.hostTools,positiveHostLibc:value}}));
  const aliases=[...review.hostTools.positiveHostLibc.libcAliases];Object.defineProperty(aliases,"0",{enumerable:true,get(){calls++;throw Error("input hook");}});
  assert.throws(()=>fullReviewData({...review,hostTools:{...review.hostTools,positiveHostLibc:{...review.hostTools.positiveHostLibc,libcAliases:aliases}}}));
  const rows=[...review.hostTools.systemdNspawnClosure];Object.defineProperty(rows,"0",{enumerable:true,get(){calls++;throw Error("input hook");}});
  for(const systemdNspawnClosure of [rows,new Proxy(rows,{get(){calls++;throw Error("input hook");}}),Object.assign([...review.hostTools.systemdNspawnClosure],{toJSON(){calls++;throw Error("input hook");}})])
    assert.throws(()=>fullReviewData({...review,hostTools:{...review.hostTools,systemdNspawnClosure}}));
  const hostTools={...review.hostTools};Object.defineProperty(hostTools,"positiveHostLibc",{enumerable:true,get(){calls++;throw Error("input hook");}});
  assert.throws(()=>fullReviewData({...review,hostTools}));assert.equal(calls,0);
});

// Red on the r-only adapter: independently selected account-w cannot enter.
// Both accounts still require matching protected native/outer review inputs.
test("schema2 finite account selection accepts exactly account-r or account-w",()=>{
  const review=positiveLibcReview();
  for(const accountName of [FullPositiveAccount.R,FullPositiveAccount.W]){
    assert.equal(fullReviewData({...review,accountName}).accountName,accountName);
    const {positiveHostLibc:unused,...ordinary}=review.hostTools;
    assert.equal(fullReviewData({...review,accountName,hostTools:ordinary}).accountName,accountName);
  }
  for(const accountName of ["account-u","account-a","r","w","account-W","account-w ","account-w/account-r",["account-w"],new String("account-w"),null,undefined])assert.throws(()=>fullReviewData({...review,accountName}));
  for(const changed of [{removalCase:"parent_crash_h1"},{restoreConsumer:"readonly"}])assert.throws(()=>fullReviewData({...review,accountName:FullPositiveAccount.W,...changed}));
  const {removalCase:unused,restoreConsumer:unused2,...legacy}=review;
  const {positiveHostLibc:unused3,...legacyTools}=legacy.hostTools;
  assert.equal(fullReviewData({...legacy,schemaVersion:1,accountName:"account-u",hostTools:legacyTools}).accountName,"account-u");
  let calls=0;const hooked={...review};Object.defineProperty(hooked,"accountName",{enumerable:true,get(){calls++;return "account-w";}});
  assert.throws(()=>fullReviewData(hooked));assert.equal(calls,0);
});
test("schema2 protected outer review must match the exact selected account",()=>{
  const source="2".repeat(40),node="5".repeat(64);
  for(const accountName of [FullPositiveAccount.R,FullPositiveAccount.W]){
    const input={accountName,nodeSha256:node,reviewReference:"TEST-reviewed",schemaVersion:1,sourceSha:source};
    assert.equal(fullPositiveOuterReviewData(input,accountName,source,node).accountName,accountName);
    for(const changed of [{accountName:accountName===FullPositiveAccount.R?FullPositiveAccount.W:FullPositiveAccount.R},{accountName:"account-u"},{schemaVersion:2},{sourceSha:"3".repeat(40)},{nodeSha256:"6".repeat(64)},{extra:true}])
      assert.throws(()=>fullPositiveOuterReviewData({...input,...changed},accountName,source,node));
    let calls=0;const getter={...input};Object.defineProperty(getter,"accountName",{enumerable:true,get(){calls++;return accountName;}});
    assert.throws(()=>fullPositiveOuterReviewData(getter,accountName,source,node));assert.equal(calls,0);
  }
});

// Exact public observations used as parser DATA only: no original acquisition,
// authority, source qualification or runtime outcome is manufactured here.
function positiveTwoDsoReview() {
  const review=positiveLibcReview();
  const shared={path:"/usr/lib/x86_64-linux-gnu/systemd/libsystemd-shared-255.so",sha256:"356f170e9e3a9dfb8026448b81d999863794e30f9c7136b4dfdd0b7abbf73116",tuple:{dev:"2306",ino:"20449778",uid:"0",gid:"0",mode:"33188",nlink:"2",size:"3755032",mtimeNs:"1785251085000000000",ctimeNs:"1791309430268956983"},aliases:["/nonexistent/.debug/usr/lib/x86_64-linux-gnu/systemd/libsystemd-shared-255.so/7f29ab33e6b88429c49398ab9a4d288d329bf2bd/elf","/usr/lib/x86_64-linux-gnu/systemd/libsystemd-shared-255.so"]};
  const closure=[
    {"path":"/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2","sha256":"c20a2dc8917c755f02b94049356320fe1f62ac7d9f8994731f807d9df39302da"},
    {"path":"/usr/lib/x86_64-linux-gnu/libacl.so.1.1.2302","sha256":"1f5247285409ec89990e9fe384d78dfb2ae6ec8e210a2657073babc8d6b7e54f"},
    {"path":"/usr/lib/x86_64-linux-gnu/libaudit.so.1.0.0","sha256":"8a4ca5eda7607f2e65da7cb32a780cc0dcfbf202037482ef4261a3c1ec339083"},
    {"path":"/usr/lib/x86_64-linux-gnu/libblkid.so.1.1.0","sha256":"9c3860ffab5422410ff9e073d3e82267f00bc68ff1248cbb191640ee2ff045bc"},
    {"path":"/usr/lib/x86_64-linux-gnu/libc.so.6","sha256":"3a15d66867d83762c7f2f1e37359cb8f6c5743edb369c65285cb0b1c4f7498bf"},
    {"path":"/usr/lib/x86_64-linux-gnu/libcap-ng.so.0.0.0","sha256":"25349c22956c7af94f46e728d7e4c1eba57d0e4a0517f72781fb495d541eeef3"},
    {"path":"/usr/lib/x86_64-linux-gnu/libcap.so.2.66","sha256":"6ac6abc86ac891c6e13486470e26f1d939f47fda9e6b5d5508a7f5ec881adc84"},
    {"path":"/usr/lib/x86_64-linux-gnu/libcrypt.so.1.1.0","sha256":"1502636e3be8232c9cf801dfb533694aea985d449904f3e1295db26d7b348946"},
    {"path":"/usr/lib/x86_64-linux-gnu/libcrypto.so.3","sha256":"6866ed711dab8927e1bf82bf1cd30e828bdfc34f3cc1e83b1c9eb01ce6c37d9a"},
    {"path":"/usr/lib/x86_64-linux-gnu/libgcrypt.so.20.4.3","sha256":"6ad6d7007ee1ad8319eb18ba9a512cf09dda49396a303774c68b47477020bad4"},
    {"path":"/usr/lib/x86_64-linux-gnu/libgpg-error.so.0.34.0","sha256":"6cb18a007bfcb623029f4528a36b46578fea7dc34c2b505b8e6e0d99e6348cd1"},
    {"path":"/usr/lib/x86_64-linux-gnu/libkmod.so.2.4.1","sha256":"6108903e15200313fd0bb71bb7e17d8fb8d01a01fa7f3dd1649d4f0c6187c8d3"},
    {"path":"/usr/lib/x86_64-linux-gnu/liblz4.so.1.9.4","sha256":"40bffd0a098387368b16b992abd5f7cf43c0fa2f05cabe5a6d483719554adfda"},
    {"path":"/usr/lib/x86_64-linux-gnu/liblzma.so.5.4.5","sha256":"696e868dd0700a19a6d65fc01608ec2d70d3cb91f65710e89180cd2e688f30cb"},
    {"path":"/usr/lib/x86_64-linux-gnu/libm.so.6","sha256":"fce00b6f25f459cf4ae0b7fae4257909a1a8a86f9149e7c029a5d617baf1ccd0"},
    {"path":"/usr/lib/x86_64-linux-gnu/libmount.so.1.1.0","sha256":"7472255ae5799059b37ddd544788f5665dbd3e1cb78259f52180293039efc2a5"},
    {"path":"/usr/lib/x86_64-linux-gnu/libpam.so.0.85.1","sha256":"9e1c85dcceeedd56568874afa04c52bbd051fb8bac52c3e1f5feeb1eed14238a"},
    {"path":"/usr/lib/x86_64-linux-gnu/libpcre2-8.so.0.11.2","sha256":"e00576d71d81d3ba0cfa4903c835a44a8723aac96f72f79ff75200b4cff9071b"},
    {"path":"/usr/lib/x86_64-linux-gnu/libseccomp.so.2.5.5","sha256":"b4d9140a7797ccf3ac14f5d9d579b64f157111662940cb8330c632b11a8cea8e"},
    {"path":"/usr/lib/x86_64-linux-gnu/libselinux.so.1","sha256":"0ec0843463f90e227b0e138e1f379774f50b5514bd7f5dbd4c8a87aca0aa6670"},
    {"path":"/usr/lib/x86_64-linux-gnu/libzstd.so.1.5.5","sha256":"0a2128bc10841fb29e76d08d945864dfb0b6a66da5df6df5d8299197439e54bb"},
    {"path":"/usr/lib/x86_64-linux-gnu/systemd/libsystemd-shared-255.so","sha256":"356f170e9e3a9dfb8026448b81d999863794e30f9c7136b4dfdd0b7abbf73116"},
  ];
  return {...review,hostTools:{...review.hostTools,systemdNspawnClosure:closure,positiveHostSystemdShared:shared}};
}
test("Positive HOST two fixed DSO roles consume the observed22 canonical rows",()=>{
  const review=positiveTwoDsoReview();assert.equal(review.hostTools.systemdNspawnClosure.length,22);
  for(const accountName of [FullPositiveAccount.R,FullPositiveAccount.W])assert.doesNotThrow(()=>fullReviewData({...review,accountName}));
  // Absent role fields preserve the generic nlink1 route, not a DATA grant.
  const {positiveHostSystemdShared:unused,...libcOnly}=review.hostTools;assert.doesNotThrow(()=>fullReviewData({...review,hostTools:libcOnly}));
  const {positiveHostLibc:unused2,...sharedOnly}=review.hostTools;assert.doesNotThrow(()=>fullReviewData({...review,hostTools:sharedOnly}));
  for(const changed of [{schemaVersion:1},{removalCase:"parent_crash_h1"},{restoreConsumer:"readonly"},{accountName:"account-u"}])assert.throws(()=>fullReviewData({...review,...changed}));
});
test("FULL H1 separate subject digest is exact DATA-only selection",()=>{
  const review={...positiveTwoDsoReview(),schemaVersion:1,accountName:"account-u",removalCase:"parent_crash_h1",h1StagedSubjectSha256:"5".repeat(64)};
  assert.equal(fullReviewData(review).h1StagedSubjectSha256,review.h1StagedSubjectSha256);
  for(const changed of [{h1StagedSubjectSha256:"/tmp/TEST-subject"},{h1StagedSubject:{}},{h1StagedSubjectPath:"/tmp/TEST-subject"},{schemaVersion:2,accountName:"account-r",removalCase:"positive"},{removalCase:"positive"},{restoreConsumer:"readonly"}])
    assert.throws(()=>fullReviewData({...review,...changed}));
  let calls=0;const accessor={...review};Object.defineProperty(accessor,"h1StagedSubjectSha256",{enumerable:true,get(){calls++;return review.h1StagedSubjectSha256;}});
  assert.throws(()=>fullReviewData(accessor));assert.equal(calls,0);
});
test("Positive HOST second DSO rejects broadened roles and unconsumed proofs",()=>{
  const review=positiveTwoDsoReview(),shared=review.hostTools.positiveHostSystemdShared,libc=review.hostTools.positiveHostLibc;
  for(const changed of [{path:libc.path},{path:shared.path.replace("255","256")},{sha256:libc.sha256},{extra:true},{tuple:libc.libcTuple},{tuple:{...shared.tuple,mode:"33261"}},{tuple:{...shared.tuple,nlink:"1"}},{tuple:{...shared.tuple,nlink:"3"}},{tuple:{...shared.tuple,uid:"1"}},{tuple:{...shared.tuple,gid:"1"}},{tuple:{...shared.tuple,extra:true}},{aliases:libc.libcAliases},{aliases:[...shared.aliases].reverse()},{aliases:[...shared.aliases,shared.path]},{aliases:[shared.aliases[0]!.replace("7f29ab33","8f29ab33"),shared.path]}])
    assert.throws(()=>fullReviewData({...review,hostTools:{...review.hostTools,positiveHostSystemdShared:{...shared,...changed}}}));
  for(const path of [libc.path,shared.path]){
    const rows=review.hostTools.systemdNspawnClosure;
    for(const systemdNspawnClosure of [rows.filter(row=>row.path!==path),[...rows,...rows.filter(row=>row.path===path)],rows.map(row=>row.path===path?{...row,sha256:"1".repeat(64)}:row),rows.map(row=>row.path===path?{...row,tuple:shared.tuple}:row)])
      assert.throws(()=>fullReviewData({...review,hostTools:{...review.hostTools,systemdNspawnClosure}}));
  }
  const row={path:shared.aliases[0],sha256:shared.sha256};assert.throws(()=>fullReviewData({...review,hostTools:{...review.hostTools,systemdNspawnClosure:[row,...review.hostTools.systemdNspawnClosure]}}));
  assert.throws(()=>fullH1LibcAliasesData(shared.aliases));
});
test("Positive HOST second DSO DATA never invokes hooks",()=>{
  const review=positiveTwoDsoReview(),shared=review.hostTools.positiveHostSystemdShared;let calls=0;
  const getter={...shared};Object.defineProperty(getter,"tuple",{enumerable:true,get(){calls++;throw Error("input hook");}});
  const proxy=new Proxy(shared,{get(){calls++;throw Error("input hook");},ownKeys(){calls++;throw Error("input hook");},getPrototypeOf(){calls++;throw Error("input hook");}});
  for(const value of [getter,proxy,{...shared,toJSON(){calls++;throw Error("input hook");}}])assert.throws(()=>fullReviewData({...review,hostTools:{...review.hostTools,positiveHostSystemdShared:value}}));
  const aliases=[...shared.aliases];Object.defineProperty(aliases,"0",{enumerable:true,get(){calls++;throw Error("input hook");}});
  const tuple={...shared.tuple};Object.defineProperty(tuple,"mode",{enumerable:true,get(){calls++;throw Error("input hook");}});
  for(const value of [{...shared,aliases},{...shared,tuple}])assert.throws(()=>fullReviewData({...review,hostTools:{...review.hostTools,positiveHostSystemdShared:value}}));
  const tools={...review.hostTools};Object.defineProperty(tools,"positiveHostSystemdShared",{enumerable:true,get(){calls++;throw Error("input hook");}});
  assert.throws(()=>fullReviewData({...review,hostTools:tools}));assert.equal(calls,0);
});

// Namespace-local mount IDs can change while original object identity stays
// the same. This supplies DATA only, not a namespace, FD or issuer context.
test("Positive HOST stable ancestry compares objects across namespace-local mounts",()=>{
  const launcher=[{path:"/",identity:"2306:2:0:0:16877",mount:"30"},{path:"/usr",identity:"2306:20447233:0:0:16877",mount:"30"}];
  const parent=launcher.map(row=>({...row,mount:"4096"}));
  const snapshot=(rows:typeof launcher)=>JSON.stringify(fullPositiveHostStableAncestors(rows));
  assert.equal(snapshot(launcher),snapshot(parent));
  for(const changed of [{path:"/nonexistent"},{identity:"2306:3:0:0:16877"},{identity:"2306:2:1:0:16877"},{identity:"2306:2:0:1:16877"},{identity:"2306:2:0:0:16895"},{identity:"2307:2:0:0:16877"}])
    assert.notEqual(snapshot(launcher),snapshot([{...parent[0]!,...changed},parent[1]!]));
  assert.notEqual(snapshot(launcher),snapshot(parent.slice(1)));
  assert.deepEqual(fullPositiveHostStableAncestors(launcher),[{path:"/",identity:"2306:2:0:0:16877"},{path:"/usr",identity:"2306:20447233:0:0:16877"}]);
});

test("source package contract keeps legacy and binds selected Positive package bytes",()=>{
  assert.equal(fullNativeSourcePackageHash(1),"68a91f14118d7b4dc06b02dad1835bc1db19760e5329faff1f4805cbd1508b29");
  const bytes=readFileSync(new URL("../../package.json",import.meta.url));
  const hash=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex");
  assert.equal(fullNativeSourcePackageHash(2),"7fdbde9be28aa03e3c935d1eac9bca776796be9fa1142602e21ad25989bef334");
  assert.equal(fullNativeSourcePackageHash(2),hash(bytes));
  // The public pin changes only the reviewed metadata from the private package;
  // historical bytes and altered metadata/scripts cannot select this contract.
  const contract=JSON.parse(bytes.toString("utf8")) as {license:string;repository:{type:string;url:string};scripts:Record<string,string>};
  assert.equal(contract.license,"Apache-2.0");
  assert.deepEqual(contract.repository,{type:"git",url:"git+https://github.com/777genius/ar.git"});
  const historical={...contract,license:"UNLICENSED",repository:{...contract.repository,url:"git+https://github.com/vioxen/subscription-runtime.git"}};
  assert.equal(hash(JSON.stringify(historical,null,2)+"\n"),"b30781b69ddf73bf53eb3bb02b073aeba00f4404bd796d485365dbc7dbe872ab");
  for(const changed of [historical,{...contract,license:"MIT"},{...contract,repository:{...contract.repository,url:"git+https://example.invalid/ar.git"}},
    {...contract,scripts:{...contract.scripts,"build:host-source-contracts":"true"}}])assert.notEqual(fullNativeSourcePackageHash(2),hash(JSON.stringify(changed,null,2)+"\n"));
  for(const value of [undefined,null,0,3,"2",{},true])assert.throws(()=>fullNativeSourcePackageHash(value));
});

test("staged constructor, census and close reject copied original-parent DATA before any physical work",async()=>{
  const fake=Object.freeze({removalCase:FullRemovalCase.ParentCrashH1,unit:fullNativeUnit,revalidate(){throw new Error("caller callback must not execute");}});
  assert.throws(()=>constructOriginalH1StagedObserver(fake),/Held/);
  await assert.rejects(closeOriginalH1StagedObserver(fake),/Held/);
  assert.throws(()=>readOriginalH1StagedTask(fake,{path:"/proc/1",processPid:1,processBirth:"1",birth:"1",revalidate(){throw new Error("caller callback must not execute");}}),/Held/);
});
