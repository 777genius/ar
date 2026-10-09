/** Disposable ARC CI signed DATA collection. Never imports/calls a live-host
 * AcquireMeasureContext, ReviewAuthority, Python/nsenter/ldd or target image. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, lchownSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, readlinkSync, readSync, realpathSync, readdirSync, symlinkSync, writeSync, type BigIntStats } from "node:fs";
import { get } from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureFixedSignedPythonEnvelopeData, serializeFixedSignedPythonEnvelopeData, PythonDataCatalogStatus, PythonEnvelopeKind, type SignedPackage, type CapturedEnvelope, type PythonDataCatalogSerialization } from "../../host-integration/managed-launcher/dependency-full-python-envelope-TEST.ts";
import { assertExactH1PackageSeeds, exactH1PackageSeeds, retainOriginalAcquiredArchive, type AcquiredSignedPackage } from "./current-h1-tool-inputs-package.ts";
import { assertCiPublicEvidenceBasename, assertCompleteUbuntuIndex, assertUbuntuArchiveSignature, ciIndexOperationalBytes, CiUbuntuComponent, ciUbuntuSources, joinCompleteUbuntuIndex, parseUbuntuRelease, ubuntuArchive2018Fingerprint } from "./current-h1-tool-inputs-ci-index.ts";
import { inspectRetainedOriginalDebFsys, type RawArchiveSurvey } from "./current-h1-archive-format-census.ts";
import { preflightFixedH1ArchiveRole, serializeFixedH1ArchiveRole } from "./current-h1-archive-path-graph-TEST.ts";
import { materializeFixedH1SelectedToolrootData } from "./current-h1-selected-toolroot-TEST.ts";
import { SelectedPhysicalDisposition, type SelectedRetainedStreamData } from "./current-h1-selected-toolroot-filesystem-TEST.ts";
import { FixedGnuMemberKind, readFixedGnuBasicMembers, serializeFixedGnuMembers, type FixedGnuArchiveMembers } from "./current-h1-archive-members-TEST.ts";
enum CiTool { AptGet="/usr/bin/apt-get", Gpgv="/usr/bin/gpgv", DpkgDeb="/usr/bin/dpkg-deb", AptHelper="/usr/lib/apt/apt-helper", Git="/usr/bin/git" }
enum CiDataStatus { Complete="signed-data-extraction-measurement-complete", Failed="signed-data-stage-failed" }
enum CiDataPhase { Tools="tool-provenance", Key="public-key-data", Indices="authenticated-complete-indices", Seeds="exact-five-seed-solver-and-download", RawFormat="authenticated-raw-archive-format-survey", SelectedToolroot="selected-toolroot-physical-DATA", Extraction="signed-data-extraction", Measurement="complete-data-measurement" }
enum CiMeasuredKind { Directory="directory", Alias="alias-literal-not-followed", File="file" }
enum CiEnvelopeCandidate { Held="HOLD-not-native-qualified", Captured="captured-candidate-not-native-qualified" }
enum CiByteRole { OwnRecord="own-record", InstalledTool="installed-CI-tool-data", SignedPayload="signed-extracted-payload-data" }
const hash=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
const tuple=(s:BigIntStats)=>[s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":");
const measureCeilings=Object.freeze({entries:20000,bytes:512*1024*1024,fileBytes:32*1024*1024,depth:2047,elapsedMs:30000,catalogBytes:128*1024});
export enum CiEnvelopePublication { CompleteUnadmitted="envelope-complete-UNADMITTED.json", Retention="envelope-complete-UNADMITTED-retention.json", Held="envelope-candidate-HOLD.json", Candidate="envelope-candidate.json" }
export interface CiEnvelopeProvenance { readonly signedPackagesSha256:string;readonly completeIndicesSha256:string;readonly sourceAndToolsSha256:string }
/** DATA persistence only. The original candidate parser/cap and native guards stay unchanged. */
export function publishCiEnvelopeCatalogData(sourceSha:string,capture:CapturedEnvelope,serialized:PythonDataCatalogSerialization,provenance:CiEnvelopeProvenance|undefined,file:(name:CiEnvelopePublication,bytes:Buffer|string)=>void):CiEnvelopeCandidate {
 if(serialized.status===PythonDataCatalogStatus.CapacityHeld){
  assert.equal(serialized.bytes,null,"unchanged over-cap candidate absence");
  assert(serialized.measurement.serializedBytes>measureCeilings.catalogBytes,"original capacity HOLD");
  assert(serialized.measurement.serializedBytes<=ciIndexOperationalBytes,"complete unadmitted operational record ceiling");
  const bytes=Buffer.from(JSON.stringify(capture.catalog));
  assert(bytes.length<=ciIndexOperationalBytes,"complete unadmitted operational record ceiling");
  assert.equal(bytes.length,serialized.measurement.serializedBytes,"complete unadmitted byte count");
  assert.equal(hash(bytes),serialized.measurement.sha256,"complete unadmitted SHA256");
  assert.equal(capture.catalog.entries.length,serialized.measurement.entries,"complete unadmitted entries");
  assert.equal(capture.catalog.packages.length,serialized.measurement.packages,"complete unadmitted packages");
  for(const kind of Object.values(PythonEnvelopeKind))assert.equal(capture.catalog.entries.filter(row=>row.kind===kind).length,serialized.measurement.kindCounts[kind],"complete unadmitted kind counts");
  assert(provenance&&Object.values(provenance).every(value=>/^[a-f0-9]{64}$/.test(value)),"original public DATA provenance commitments");
  file(CiEnvelopePublication.CompleteUnadmitted,bytes);
  file(CiEnvelopePublication.Retention,JSON.stringify({schemaVersion:1,purpose:"COMPLETE_UNADMITTED_DATA_ONLY",sourceSha,body:CiEnvelopePublication.CompleteUnadmitted,serializedBytes:bytes.length,sha256:serialized.measurement.sha256,entries:serialized.measurement.entries,packages:serialized.measurement.packages,kindCounts:serialized.measurement.kindCounts,elfEntries:capture.elf.size,provenanceRecords:{"signed-packages.json":provenance.signedPackagesSha256,"complete-indices.json":provenance.completeIndicesSha256,"source-and-tools.json":provenance.sourceAndToolsSha256},originalStatus:serialized.status,candidatePresent:false,physicalCatalogQualified:false,nativeQualified:false,originalNamespaceQualified:false,inlineReviewQualified:false})+"\n");
  file(CiEnvelopePublication.Held,JSON.stringify({reason:"complete DATA catalog exceeds unchanged serialized byte cap",serializedBytes:serialized.measurement.serializedBytes,catalogBytes:measureCeilings.catalogBytes,nativeQualified:false})+"\n");
  return CiEnvelopeCandidate.Held;
 }
 assert.equal(serialized.status,PythonDataCatalogStatus.Captured);assert(serialized.bytes!==null);
 file(CiEnvelopePublication.Candidate,serialized.bytes);return CiEnvelopeCandidate.Captured;
}
function fullBytes(path:string,maximum:number,tick:()=>void,role:CiByteRole=CiByteRole.OwnRecord):Buffer {
 tick();const before=lstatSync(path,{bigint:true});assert(before.isFile()&&before.nlink>0n&&before.size<=BigInt(maximum));
 if(role===CiByteRole.OwnRecord)assert(before.uid===0n&&before.gid===0n&&before.nlink===1n&&!(before.mode&0o022n));
 if(role===CiByteRole.InstalledTool)assert(before.uid===0n&&!(before.mode&0o022n));
 // SignedPayload reports original extracted owner/mode/hardlink facts. It
 // grants no native census/namespace exemption and never changes those facts.
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{assert.equal(tuple(fstatSync(fd,{bigint:true})),tuple(before));const b=Buffer.alloc(Number(before.size)+1);let size=0;for(;;){tick();const n=readSync(fd,b,size,b.length-size,null);tick();if(!n)break;size+=n;assert(size<=Number(before.size));}assert.equal(size,Number(before.size));if(role!==CiByteRole.InstalledTool)fsyncSync(fd);tick();assert.equal(tuple(fstatSync(fd,{bigint:true})),tuple(before));assert.equal(tuple(lstatSync(path,{bigint:true})),tuple(before));return b.subarray(0,size);}finally{closeSync(fd);}
}
function downloadArchiveKey(remainingMs:number):Promise<Buffer> {
 return new Promise((accept,reject)=>{let count=0;const chunks:Buffer[]=[];
  const request=get("https://archive.ubuntu.com/ubuntu/project/ubuntu-archive-keyring.gpg",{headers:{"Accept-Encoding":"identity"}},response=>{
   if(response.statusCode!==200||response.headers["content-encoding"]){clearTimeout(timer);response.destroy();reject(new Error("fixed public key transport"));return;}
   response.on("data",(part:Buffer)=>{count+=part.length;if(count>1024*1024){response.destroy(new Error("public key bound"));return;}chunks.push(part);});response.on("error",error=>{clearTimeout(timer);reject(error);});response.on("end",()=>{clearTimeout(timer);accept(Buffer.concat(chunks,count));});
  });const timer=setTimeout(()=>request.destroy(new Error("public key deadline")),remainingMs);request.on("error",error=>{clearTimeout(timer);reject(error);});
 });
}
function ownCiKernelFacts():Readonly<{capEff:string|null;capBnd:string|null;mntNamespace:string|null;pidNamespace:string|null;namespaceProbe:"NOT_RUN"}> {
 let capEff:string|null=null,capBnd:string|null=null,mntNamespace:string|null=null,pidNamespace:string|null=null;
 try{const fd=openSync("/proc/self/status",constants.O_RDONLY|constants.O_NOFOLLOW);try{const buffer=Buffer.alloc(65537);let size=0;for(;;){const n=readSync(fd,buffer,size,buffer.length-size,null);if(!n)break;size+=n;assert(size<=65536);}for(const line of buffer.subarray(0,size).toString("ascii").split("\n")){const row=/^(CapEff|CapBnd):\s+([a-f0-9]{16})$/.exec(line);if(row?.[1]==="CapEff")capEff=row[2]??null;if(row?.[1]==="CapBnd")capBnd=row[2]??null;}}finally{closeSync(fd);}}catch{capEff=null;capBnd=null;}
 try{const value=readlinkSync("/proc/self/ns/mnt");if(/^mnt:\[[0-9]+\]$/.test(value))mntNamespace=value;}catch{}
 try{const value=readlinkSync("/proc/self/ns/pid");if(/^pid:\[[0-9]+\]$/.test(value))pidNamespace=value;}catch{}
 return Object.freeze({capEff,capBnd,mntNamespace,pidNamespace,namespaceProbe:"NOT_RUN"});
}
export async function mainCiSignedToolInputs():Promise<void> {
 // CI source/UID facts are ordinary job provenance, NOT original host admission.
 assert.equal(process.platform,"linux");assert.equal(process.arch,"x64");assert.equal(process.getuid?.(),0);assert.equal(process.geteuid?.(),0);assert.equal(process.argv.length,2);
 assert.equal(process.env.CI,"true");assert.equal(process.env.GITHUB_ACTIONS,"true");const sourceSha=process.env.TEST_SOURCE_SHA;assert(sourceSha&&/^[a-f0-9]{40}$/.test(sourceSha));
 assert(process.setgid);process.setgid(0);assert.equal(process.getgid?.(),0);assert.equal(process.getegid?.(),0);process.umask(0o077);
 const normalizeCreatedDirectory=(path:string,mode:number)=>{const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{const before=fstatSync(fd,{bigint:true});assert(before.isDirectory()&&before.uid===0n);fchownSync(fd,0,0);fchmodSync(fd,mode);const after=fstatSync(fd,{bigint:true});assert(after.dev===before.dev&&after.ino===before.ino&&after.uid===0n&&after.gid===0n&&(after.mode&0o7777n)===BigInt(mode));assert.equal(tuple(lstatSync(path,{bigint:true})),tuple(after));fsyncSync(fd);}finally{closeSync(fd);}};
 const workspace=realpathSync(process.env.GITHUB_WORKSPACE??""),tmp=realpathSync(process.env.RUNNER_TEMP??"");assert(lstatSync(workspace).isDirectory()&&lstatSync(tmp).isDirectory());
 assert([workspace,tmp].every(path=>path.length<=4096&&/^\/[A-Za-z0-9_@+./-]+$/.test(path)),"fixed CI path representation, no apt config interpolation");
 const evidence=join(workspace,"dependency-h1-tool-inputs-ci-evidence");mkdirSync(evidence,{mode:0o700});normalizeCreatedDirectory(evidence,0o700);
 const scratch=mkdtempSync(join(tmp,"TEST-H1-signed-data-"));normalizeCreatedDirectory(scratch,0o700);const scratchStat=lstatSync(scratch,{bigint:true});assert(scratchStat.uid===0n&&scratchStat.gid===0n&&(scratchStat.mode&0o7777n)===0o700n);
 const started=performance.now(),deadline=started+1800000,tools=new Map<CiTool,{fd:number;actual:string;stamp:string;sha256:string}>(),archives=new Map<string,ReturnType<typeof retainOriginalAcquiredArchive>>();
 const tick=()=>{assert(performance.now()<deadline,"one original CI deadline");const s=lstatSync(scratch,{bigint:true});assert(s.isDirectory()&&s.dev===scratchStat.dev&&s.ino===scratchStat.ino&&s.uid===0n&&s.gid===0n&&(s.mode&0o7777n)===0o700n);};
 const directories:string[]=[evidence,scratch];
 const file=(path:string,bytes:Buffer|string)=>{tick();const b=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{fchownSync(fd,0,0);fchmodSync(fd,0o600);let at=0;while(at<b.length){const n=writeSync(fd,b,at,b.length-at);assert(n>0);at+=n;tick();}fsyncSync(fd);const s=fstatSync(fd,{bigint:true});assert(s.uid===0n&&s.gid===0n&&s.nlink===1n&&s.size===BigInt(b.length)&&tuple(lstatSync(path,{bigint:true}))===tuple(s));}finally{closeSync(fd);}const parent=openSync(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(parent);}finally{closeSync(parent);}assert(fullBytes(path,b.length,tick).equals(b),"durable own output readback");tick();};
 const dir=(path:string,mode=0o700)=>{mkdirSync(path,{mode});normalizeCreatedDirectory(path,mode);directories.push(path);tick();};
 const state=join(scratch,"state"),extraction=join(scratch,"extraction"),etc=join(state,"etc"),keyring=join(state,"ubuntu-archive-keyring.gpg");
 let commands=0,phase=CiDataPhase.Tools,primaryFailed=false;
 try {
  for(const tool of Object.values(CiTool)){const actual=realpathSync(tool),s=lstatSync(actual,{bigint:true});assert(s.isFile()&&s.uid===0n&&s.nlink>0n&&!(s.mode&0o022n)&&(s.mode&0o111n));const fd=openSync(actual,constants.O_RDONLY|constants.O_NOFOLLOW);assert.equal(tuple(fstatSync(fd,{bigint:true})),tuple(s));const bytes=fullBytes(actual,64*1024*1024,tick,CiByteRole.InstalledTool);tools.set(tool,{fd,actual,stamp:tuple(s),sha256:hash(bytes)});}
  const command=(tool:CiTool,args:readonly string[],maximum=4*1024*1024,timeout=30000,env:NodeJS.ProcessEnv={PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",HOME:scratch,TMPDIR:scratch})=>{
   tick();const original=tools.get(tool);assert(original);assert.equal(tuple(fstatSync(original.fd,{bigint:true})),original.stamp);assert.equal(tuple(lstatSync(original.actual,{bigint:true})),original.stamp);
   const result=spawnSync("/proc/self/fd/3",[...args],{argv0:tool,shell:false,cwd:workspace,env,timeout:Math.max(1,Math.floor(Math.min(timeout,deadline-performance.now()))),maxBuffer:maximum,stdio:["ignore","pipe","pipe",original.fd]});tick();assert.equal(tuple(fstatSync(original.fd,{bigint:true})),original.stamp);assert.equal(tuple(lstatSync(original.actual,{bigint:true})),original.stamp);
   file(join(evidence,`command-${++commands}.json`),JSON.stringify({tool,args,status:result.status,signal:result.signal,stdoutSha256:hash(result.stdout??Buffer.alloc(0)),stderr:(result.stderr??Buffer.alloc(0)).toString("utf8").slice(0,16384)})+"\n");assert(!result.error&&result.status===0&&result.signal===null,"fixed CI command refused");return result.stdout;
  };
  // One closed TEST invocation after this own process established GID0. This
  // is not a runner port and cannot select another test/path/command.
  const sibling=dirname(fileURLToPath(import.meta.url));
  const physicalTestArgv=["--test","--test-reporter=tap",join(sibling,"current-h1-tool-inputs-ci-index.node-test.js"),join(sibling,"current-h1-tool-inputs-package.node-test.js"),join(sibling,"current-h1-tool-inputs-ci-publication.node-test.js"),join(sibling,"current-h1-archive-format-census.node-test.js"),join(sibling,"current-h1-archive-members.node-test.js"),join(sibling,"current-h1-archive-path-graph.node-test.js"),join(sibling,"current-h1-selected-toolroot.node-test.js")];
  const physicalTests=spawnSync(process.execPath,physicalTestArgv,{shell:false,cwd:workspace,env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",HOME:scratch,TMPDIR:scratch},timeout:Math.max(1,Math.floor(Math.min(30000,deadline-performance.now()))),maxBuffer:1024*1024,encoding:"utf8"});tick();
  file(join(evidence,"root-tests.tap"),physicalTests.stdout??"");file(join(evidence,"root-tests.stderr"),physicalTests.stderr??"");assert(!physicalTests.error&&physicalTests.status===0&&physicalTests.signal===null,"fixed root CI protocol/custody tests");
  const tap=physicalTests.stdout;assert(/^# tests 36$/m.test(tap)&&/^# pass 35$/m.test(tap)&&/^# fail 0$/m.test(tap)&&/^# skipped 1$/m.test(tap));
  for(const name of ["real acquired file hashes retained bytes and refuses post-read deadline/identity mutation","retained original archive rejects equal-byte replacement between verification and extraction"])assert(tap.split("\n").some(line=>/^ok [0-9]+ - /.test(line)&&line.endsWith(name)),"original ROOT filesystem case cannot skip");
  assert.equal(command(CiTool.Git,["-c","safe.directory="+workspace,"rev-parse","HEAD"]).toString().trim(),sourceSha);
  file(join(evidence,"source-and-tools.json"),JSON.stringify({purpose:"disposable-CI-installed-tools-DATA-provenance-not-host-TCB",sourceSha,node:process.version,nodeExecutable:realpathSync(process.execPath),uid:process.getuid?.(),gid:process.getgid?.(),egid:process.getegid?.(),platform:process.platform,arch:process.arch,ownKernel:ownCiKernelFacts(),rootTestArgv:physicalTestArgv,tools:[...tools].map(([tool,p])=>({tool,actual:p.actual,sha256:p.sha256,identity:p.stamp})),seeds:exactH1PackageSeeds,trustAnchor:ubuntuArchive2018Fingerprint})+"\n");
  dir(state);for(const name of ["etc","etc/parts","etc/auth-parts","etc/preferences-parts","etc/trusted-parts","lists","lists/partial","archives","archives/partial","log"])dir(join(state,name));
  for(const name of ["status","etc/main.conf","etc/auth.conf","etc/preferences","etc/trusted.gpg"])file(join(state,name),"");
  phase=CiDataPhase.Key;const keyBytes=await downloadArchiveKey(Math.max(1,Math.floor(Math.min(30000,deadline-performance.now()))));tick();file(keyring,keyBytes);file(join(evidence,"ubuntu-archive-keyring.gpg"),keyBytes);
  const sources=ciUbuntuSources.map(s=>`deb [signed-by=${keyring}] ${s.base} ${s.pocket} main universe`).join("\n")+"\n";file(join(etc,"sources.list"),sources);
  const conf=[`Dir::State "${state}";`,`Dir::State::lists "${state}/lists";`,`Dir::State::status "${state}/status";`,`Dir::Cache "${state}";`,`Dir::Cache::archives "${state}/archives";`,`Dir::Cache::pkgcache "";`,`Dir::Cache::srcpkgcache "";`,`Dir::Log "${state}/log";`,
   `Dir::Etc "${etc}";`,`Dir::Etc::parts "${etc}/parts";`,`Dir::Etc::main "${etc}/main.conf";`,`Dir::Etc::sourcelist "${etc}/sources.list";`,`Dir::Etc::sourceparts "${etc}/parts";`,`Dir::Etc::netrc "${etc}/auth.conf";`,`Dir::Etc::netrcparts "${etc}/auth-parts";`,`Dir::Etc::preferences "${etc}/preferences";`,`Dir::Etc::preferencesparts "${etc}/preferences-parts";`,`Dir::Etc::trusted "${etc}/trusted.gpg";`,`Dir::Etc::trustedparts "${etc}/trusted-parts";`,
   '#clear Binary;','#clear APT::Update::Pre-Invoke;','#clear APT::Update::Post-Invoke;','#clear APT::Update::Post-Invoke-Success;','#clear DPkg::Pre-Invoke;','#clear DPkg::Post-Invoke;','#clear DPkg::Pre-Install-Pkgs;',
   'APT::Architecture "amd64";','#clear APT::Architectures;','APT::Architectures:: "amd64";','APT::Sandbox::User "root";','APT::Update::Error-Mode "any";','APT::Get::AllowUnauthenticated "false";','Acquire::AllowInsecureRepositories "false";','Acquire::AllowDowngradeToInsecureRepositories "false";','Acquire::Languages "none";','Acquire::PDiffs "false";','Acquire::http::Proxy "DIRECT";','Acquire::https::Proxy "DIRECT";'].join("\n")+"\n";
  file(join(etc,"apt.conf"),conf);file(join(evidence,"apt.conf"),conf);file(join(evidence,"sources.list"),sources);
  const env={PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",HOME:scratch,TMPDIR:scratch,APT_CONFIG:join(etc,"apt.conf")};phase=CiDataPhase.Indices;
  command(CiTool.AptGet,["update"],4*1024*1024,180000,env);
  const indices:{origin:string;path:string;sha256:string;size:number;bytes:Buffer}[]=[];let totalIndexBytes=0;
  const listNames=readdirSync(join(state,"lists"));
  for(const source of ciUbuntuSources){const prefix=source.base.slice("https://".length).replaceAll("/","_")+"_dists_"+source.pocket,releasePath=join(state,"lists",prefix+"_InRelease"),inRelease=fullBytes(releasePath,1024*1024,tick),plain=join(evidence,source.pocket+".Release");
   const status=command(CiTool.Gpgv,["--status-fd","1","--output",plain,"--keyring",keyring,releasePath]).toString("utf8");assertUbuntuArchiveSignature(status);assert(fullBytes(releasePath,1024*1024,tick).equals(inRelease));assert(fullBytes(keyring,1024*1024,tick).equals(keyBytes));file(join(evidence,source.pocket+".InRelease"),inRelease);file(join(evidence,source.pocket+".gpg-status"),status);
   const rows=parseUbuntuRelease(fullBytes(plain,1024*1024,tick).toString("utf8"),source.pocket,Date.now());
   for(const component of [CiUbuntuComponent.Main,CiUbuntuComponent.Universe]){const relative=component+"/binary-amd64/Packages",row=rows.get(relative);assert(row);const filename=prefix+"_"+component+"_binary-amd64_Packages",names=listNames.filter(n=>n===filename||[".lz4",".gz",".xz",".bz2",".zst"].some(ext=>n===filename+ext));assert.equal(names.length,1,"exact original complete apt index");const compressed=join(state,"lists",names[0]!);
    const before=lstatSync(compressed,{bigint:true});assert(before.isFile()&&before.uid===0n&&before.gid===0n&&before.nlink===1n&&!(before.mode&0o022n)&&before.size<=BigInt(ciIndexOperationalBytes));
    const decoded=command(CiTool.AptHelper,["cat-file",compressed],ciIndexOperationalBytes,30000,env);assert.equal(tuple(lstatSync(compressed,{bigint:true})),tuple(before));assertCompleteUbuntuIndex(decoded,row);assert((totalIndexBytes+=decoded.length)<=512*1024*1024);const name=source.pocket+"-"+component+".Packages";file(join(evidence,name),decoded);indices.push({origin:source.base+"/dists/"+source.pocket,path:relative,sha256:row.sha256,size:row.size,bytes:decoded});
   }
  }
  file(join(evidence,"complete-indices.json"),JSON.stringify(indices.map(({bytes,...row})=>row))+"\n");
  phase=CiDataPhase.Seeds;command(CiTool.AptGet,["--yes","--download-only","--no-install-recommends","install",...exactH1PackageSeeds],4*1024*1024,300000,env);
  const debs=readdirSync(join(state,"archives")).filter(n=>n.endsWith(".deb")).sort();assert(debs.length>0&&debs.length<200);const packages:AcquiredSignedPackage[]=[],packageOrigins:{archive:string;indices:string[]}[]=[];
  for(const name of debs){assertCiPublicEvidenceBasename(name);assert(name.endsWith(".deb"));const original=retainOriginalAcquiredArchive(join(state,"archives",name),tick);archives.set(name,original);original.rejoin();const fields=command(CiTool.DpkgDeb,["--field",`/proc/${process.pid}/fd/${original.fd}`,"Package","Version","Architecture"],4*1024*1024,30000,env).toString("utf8");original.rejoin();let row:AcquiredSignedPackage|undefined;const origins:string[]=[];
   for(const index of indices){tick();const current=joinCompleteUbuntuIndex(fields,index.bytes,original);tick();if(current){if(row)assert.equal(JSON.stringify(current),JSON.stringify(row));row=current;origins.push(index.origin+"/"+index.path);}}assert(row,"original same-stanza signed archive origin absent");packages.push(row);packageOrigins.push({archive:name,indices:origins});const data=fullBytes(join(state,"archives",name),32*1024*1024,tick);assert.equal(hash(data),original.sha256);file(join(evidence,name),data);original.rejoin();
  }
  assertExactH1PackageSeeds(packages);packages.sort((a,b)=>a.package.localeCompare(b.package));file(join(evidence,"signed-packages.json"),JSON.stringify({sourceSha,packages,packageOrigins,qualifiedNative:false})+"\n");
  phase=CiDataPhase.RawFormat;
  const rawPackageVector=packages.map(({package:name,version,arch,sha256,size})=>({package:name,version,arch,sha256,size})),rawPackageVectorSha256=hash(JSON.stringify(rawPackageVector)),previousVectorSha256="d89a9c1fd845ec3123839f3d223e24d3a1a1c02ce36c3bb36637d6902a839d5b";
  file(join(evidence,"archive-format-image.json"),JSON.stringify({purpose:"ACTUAL_SIGNED_SURVEY_IMAGE_NOT_NATIVE_AUTHORITY",sourceSha,packages:rawPackageVector,sha256:rawPackageVectorSha256,previous01dfVectorSha256:previousVectorSha256,matchesPreviouslyVerified01dfImage:rawPackageVectorSha256===previousVectorSha256})+"\n");
  const formats:{archive:string;stream:string;streamBytes:number;streamSha256:string;survey:RawArchiveSurvey}[]=[],rawNames=new Map<string,{archive:string;offset:number}[]>(),memberRecords:{archive:string;record:string;bytes:number;sha256:string;rows:number}[]=[];const originalMembers:FixedGnuArchiveMembers[]=[];
  const selectedOriginals:SelectedRetainedStreamData[]=[];let rawBytes=0,rawHeaders=0;
  for(const [name,original] of archives){
   tick();const dpkg=tools.get(CiTool.DpkgDeb);assert(dpkg);const captured=await inspectRetainedOriginalDebFsys(original,dpkg,deadline,scratch);assert(captured.tool.sha256===dpkg.sha256&&captured.tool.identity===dpkg.stamp,"same existing original CI tool input");
   rawBytes+=captured.bytes.length+captured.stderr.bytes;rawHeaders+=captured.survey.headers.length;assert(rawBytes<=measureCeilings.bytes&&rawHeaders<=measureCeilings.entries,"whole original CI raw survey ceilings");
   const stream=`archive-fsys-${formats.length+1}.tar`;file(join(evidence,stream),captured.bytes);original.rejoin();
   formats.push({archive:name,stream,streamBytes:captured.bytes.length,streamSha256:captured.survey.streamSha256,survey:captured.survey});
   file(join(evidence,`archive-format-${formats.length}.json`),JSON.stringify({purpose:"RAW_ARCHIVE_OBSERVATIONS_NOT_MEMBER_AUTHORITY",sourceSha,originalArchive:captured.archive,tool:captured.tool,status:captured.status,signal:captured.signal,stderr:captured.stderr,stream,survey:captured.survey})+"\n");
   assert.equal(rawPackageVectorSha256,previousVectorSha256,"fixed GNU member image changed: DATA HOLD");
   const originalPackages=packages.filter(row=>row.sha256===original.sha256&&row.size===original.size);assert.equal(originalPackages.length,1,"single original signed package for GNU stream");const pkg=originalPackages[0];assert(pkg);original.rejoin();
   const members=readFixedGnuBasicMembers(captured.bytes,pkg,{sha256:captured.survey.streamSha256,bytes:captured.bytes.length,archiveSha256:original.sha256,archiveBytes:original.size},deadline);tick();original.rejoin();
   const serialized=serializeFixedGnuMembers(members,deadline),record=`archive-members-${formats.length}.json`;file(join(evidence,record),serialized.bytes);tick();original.rejoin();
   selectedOriginals.push(Object.freeze({archive:original,bytes:captured.bytes,members}));
   originalMembers.push(members);memberRecords.push({archive:name,record,bytes:serialized.bytes.length,sha256:serialized.sha256,rows:members.rows.length});
   for(const header of captured.survey.headers)if([0,48,49,50].includes(header.type)){const key=header.format+":"+header.prefixBase64+":"+header.nameBase64,rows=rawNames.get(key)??[];rows.push({archive:name,offset:header.offset});rawNames.set(key,rows);}
   tick();
  }
  file(join(evidence,"archive-format-census.json"),JSON.stringify({purpose:"COMPLETE_ORIGINAL_FSYS_STREAMS_RAW_HEADERS_ONLY",sourceSha,packageVectorSha256:rawPackageVectorSha256,matchesPreviouslyVerified01dfImage:rawPackageVectorSha256===previousVectorSha256,archives:formats.length,bytes:rawBytes,observedHeaders:rawHeaders,completeEffectiveMemberCensus:false,nativeQualified:false,formats:formats.map(({survey,...row})=>({...row,status:survey.status,reason:survey.reason})),rawRepeatedNonDirectoryHeaders:[...rawNames].filter(([,rows])=>rows.length>1).map(([rawNameKey,rows])=>({rawNameKey,rows}))})+"\n");
  tick();assert.equal(memberRecords.reduce((count,row)=>count+row.rows,0),rawHeaders,"complete GNU row count");file(join(evidence,"archive-members-census.json"),JSON.stringify({purpose:"SIGNED_GNU_BASIC_MEMBER_PROVENANCE_DATA_ONLY",sourceSha,packageVectorSha256:rawPackageVectorSha256,archives:memberRecords.length,rows:rawHeaders,serializedBytes:memberRecords.reduce((count,row)=>count+row.bytes,0),records:memberRecords,namespaceGraphQualified:false,nativeQualified:false})+"\n");tick();
  const graphDeadline=Math.min(deadline,performance.now()+30000),rejoinGraphOriginals=()=>{tick();assert(performance.now()<graphDeadline,"original graph phase deadline");for(const original of archives.values())original.rejoin();tick();assert(performance.now()<graphDeadline,"original graph phase deadline");};
  rejoinGraphOriginals();const graphInputs=Object.freeze(originalMembers),graphData=preflightFixedH1ArchiveRole(graphInputs,rawPackageVectorSha256,graphDeadline);rejoinGraphOriginals();
  const graphRecords=serializeFixedH1ArchiveRole(graphData,graphInputs,sourceSha,graphDeadline);rejoinGraphOriginals();
  for(const [i,commitment] of graphRecords.memberRecords.entries()){const original=memberRecords[i];assert(original&&original.sha256===commitment.sha256&&original.bytes===commitment.bytes&&original.rows===commitment.rows,"original published member record vector");}
  file(join(evidence,"archive-path-graph-UNADMITTED.json"),graphRecords.graph);rejoinGraphOriginals();file(join(evidence,"archive-role-selection-UNADMITTED.json"),graphRecords.selection);rejoinGraphOriginals();
  phase = CiDataPhase.SelectedToolroot;
  const selectedDeadline = Math.min(deadline, performance.now() + 30000);
  const rejoinSelectedOriginals = () => {
   tick();
   assert(performance.now() < selectedDeadline, "original selected DATA phase deadline");
   for (const original of archives.values()) original.rejoin();
   tick();
   assert(performance.now() < selectedDeadline, "original selected DATA phase deadline");
  };
  rejoinSelectedOriginals();
  const selectedToolroot = await materializeFixedH1SelectedToolrootData({
   sourceSha, scratch, evidence, deadline: selectedDeadline,
   originals: Object.freeze(selectedOriginals), graph: graphData,
   graphBytes: graphRecords.graph, selectionBytes: graphRecords.selection
  });
  rejoinSelectedOriginals();
  assert.equal(selectedToolroot.disposition, SelectedPhysicalDisposition.Complete);
  assert.equal(selectedToolroot.measurement.objects, 1056, "fixed selected DATA object count");
  const selectedPaths = new Set(graphData.selected);
  const selectedPayloadBytes = graphData.nodes.filter(node => selectedPaths.has(node.path) && node.kind === FixedGnuMemberKind.Regular)
   .reduce((bytes, node) => { const origin = node.origins[0]; assert(origin); return bytes + origin.row.size; }, 0);
  assert.equal(selectedToolroot.measurement.regularBytes, selectedPayloadBytes, "complete original selected payload count");
  assert.equal(selectedToolroot.nativeQualified, false);
  assert.equal(selectedToolroot.fixedImageQualified, false);
  assert.equal(selectedToolroot.originalIssuerQualified, false);
  assert.deepEqual(selectedToolroot.records.map(record => record.name), [
   "selected-toolroot-source-output-UNADMITTED.json",
   "selected-toolroot-physical-UNADMITTED.json",
   "selected-toolroot-materialization-UNADMITTED.json"
  ]);
  for (const record of selectedToolroot.records) {
   rejoinSelectedOriginals();
   const bytes = fullBytes(join(evidence, record.name), ciIndexOperationalBytes, rejoinSelectedOriginals);
   assert.equal(bytes.length, record.bytes);
   assert.equal(hash(bytes), record.sha256);
   rejoinSelectedOriginals();
  }
  phase=CiDataPhase.Extraction;dir(extraction,0o755);for(const name of ["usr","usr/bin","usr/sbin","usr/lib","usr/lib64"])dir(join(extraction,name),0o755);for(const name of ["bin","sbin","lib","lib64"]){symlinkSync("usr/"+name,join(extraction,name));lchownSync(join(extraction,name),0,0);}
  for(const original of archives.values()){original.rejoin();command(CiTool.DpkgDeb,["--extract",`/proc/${process.pid}/fd/${original.fd}`,extraction],4*1024*1024,30000,env);original.rejoin();}
  phase=CiDataPhase.Measurement;const measureStart=performance.now();let entries=0,bytes=0,largestFile=0,depth=0;const members:{path:string;kind:CiMeasuredKind;bytes:number;sha256:string;targetBase64:string;nlink:string;mode:number;uid:string;gid:string}[]=[];
  const walk=(path:string,level:number)=>{tick();assert(performance.now()-measureStart<measureCeilings.elapsedMs);assert(++entries<=measureCeilings.entries&&level<=measureCeilings.depth);depth=Math.max(depth,level);const named=extraction+path,before=lstatSync(named,{bigint:true});const common={path,nlink:String(before.nlink),mode:Number(before.mode&0o7777n),uid:String(before.uid),gid:String(before.gid)};
   if(before.isDirectory()){members.push({...common,kind:CiMeasuredKind.Directory,bytes:0,sha256:hash(""),targetBase64:""});const fd=openSync(named,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{assert.equal(tuple(fstatSync(fd,{bigint:true})),tuple(before));const directory=opendirSync(named);try{for(let entry=directory.readSync();entry;entry=directory.readSync()){assert(entry.name!=="."&&entry.name!==".."&&!entry.name.includes("/"));walk(path+"/"+entry.name,level+1);}}finally{directory.closeSync();}fsyncSync(fd);assert.equal(tuple(fstatSync(fd,{bigint:true})),tuple(before));assert.equal(tuple(lstatSync(named,{bigint:true})),tuple(before));}finally{closeSync(fd);}}
   else if(before.isSymbolicLink()){const target=readlinkSync(named,{encoding:"buffer"}),size=target.length;assert(size<=4096);bytes+=size;largestFile=Math.max(largestFile,size);members.push({...common,kind:CiMeasuredKind.Alias,bytes:size,sha256:hash(target),targetBase64:target.toString("base64")});}
   else{assert(before.isFile());const content=fullBytes(named,measureCeilings.fileBytes,tick,CiByteRole.SignedPayload);bytes+=content.length;largestFile=Math.max(largestFile,content.length);members.push({...common,kind:CiMeasuredKind.File,bytes:content.length,sha256:hash(content),targetBase64:""});}
   assert(bytes<=measureCeilings.bytes);assert.equal(tuple(lstatSync(named,{bigint:true})),tuple(before));tick();assert(performance.now()-measureStart<measureCeilings.elapsedMs);
  };walk("",0);const rawMeasurementElapsedMs=performance.now()-measureStart;members.sort((a,b)=>a.path.localeCompare(b.path));file(join(evidence,"data-members.json"),JSON.stringify(members)+"\n");
  const signed:SignedPackage[]=packages.map(({package:name,version,arch,sha256,size})=>({package:name,version,arch,sha256,size}));let envelopeCandidate=CiEnvelopeCandidate.Held;
  try{const candidate=captureFixedSignedPythonEnvelopeData(extraction,signed,measureCeilings),serialized=serializeFixedSignedPythonEnvelopeData(candidate.catalog,measureCeilings);file(join(evidence,"envelope-catalog-measurement.json"),JSON.stringify({schemaVersion:1,purpose:"fixed-signed-extraction-DATA-only",status:serialized.status,...serialized.measurement,census:candidate.measurement,elfEntries:candidate.elf.size,completeCensus:true,nativeQualified:false,originalNamespaceQualified:false,inlineReviewQualified:false})+"\n");
   const provenance=serialized.status===PythonDataCatalogStatus.CapacityHeld?{signedPackagesSha256:hash(fullBytes(join(evidence,"signed-packages.json"),ciIndexOperationalBytes,tick)),completeIndicesSha256:hash(fullBytes(join(evidence,"complete-indices.json"),ciIndexOperationalBytes,tick)),sourceAndToolsSha256:hash(fullBytes(join(evidence,"source-and-tools.json"),ciIndexOperationalBytes,tick))}:undefined;
   envelopeCandidate=publishCiEnvelopeCatalogData(sourceSha,candidate,serialized,provenance,(name,bytes)=>file(join(evidence,name),bytes));}catch(error){const reason=error instanceof Error&&/^TEST H1 Python envelope Held: [A-Za-z0-9 /+-]{1,128}$/.test(error.message)?error.message:"existing-conservative-envelope-policy-refused";file(join(evidence,"envelope-candidate-HOLD.json"),JSON.stringify({reason,nativeQualified:false})+"\n");}
  file(join(evidence,"result.json"),JSON.stringify({schemaVersion:1,status:CiDataStatus.Complete,purpose:"independently-signed-CI-data-not-live-host-admission",sourceSha,uid:0,packages,packageOrigins,indices:indices.map(({bytes,...row})=>row),trustAnchor:ubuntuArchive2018Fingerprint,keyringSha256:hash(keyBytes),measurement:{entries,bytes,largestFile,depth,elapsedMs:rawMeasurementElapsedMs},operationalCeilings:measureCeilings,selectedToolroot,envelopeCandidate,liveHostQualified:false,nativeH1:"NOT_RUN",FULL8:"NOT_PROVEN",elapsedMs:performance.now()-started})+"\n");
 }catch(error){primaryFailed=true;try{file(join(evidence,"failed-result.json"),JSON.stringify({schemaVersion:1,status:CiDataStatus.Failed,sourceSha,phase,liveHostQualified:false,nativeH1:"NOT_RUN",FULL8:"NOT_PROVEN",errorType:error instanceof Error?error.name:"unknown"})+"\n");}catch{process.stderr.write("TEST CI failure record not sealed; primary stage failure retained\n");}throw new Error("TEST CI signed data stage failed at "+phase);}
 finally{
  // Only this entry's curated PUBLIC records become job-readable. Extraction,
  // private scratch and every external ancestor retain their original modes.
  // This bounded diagnostic seal can finish after a failed acquisition deadline;
  // it never resumes downloads, grants authority or changes primary failure.
  const sealEnd=performance.now()+30000;
  try{const parent=openSync(evidence,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{const original=fstatSync(parent,{bigint:true});assert(original.uid===0n&&original.gid===0n&&(original.mode&0o7777n)===0o700n&&tuple(lstatSync(evidence,{bigint:true}))===tuple(original));
   const names=readdirSync(evidence);assert(names.length<=512);for(const name of names){assertCiPublicEvidenceBasename(name);assert(performance.now()<sealEnd);const path=join(evidence,name),initial=lstatSync(path,{bigint:true});assert(initial.isFile()&&initial.uid===0n&&initial.gid===0n&&initial.nlink===1n&&!(initial.mode&0o022n)&&initial.size<=BigInt(ciIndexOperationalBytes));
    const check=()=>{assert(performance.now()<sealEnd);const current=fstatSync(parent,{bigint:true});assert(current.dev===original.dev&&current.ino===original.ino&&current.uid===0n&&current.gid===0n&&(current.mode&0o7777n)===0o700n);assert.equal(tuple(lstatSync(evidence,{bigint:true})),tuple(current));};const bytes=fullBytes(path,ciIndexOperationalBytes,check);
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{assert.equal(tuple(fstatSync(fd,{bigint:true})),tuple(initial));fchmodSync(fd,0o444);fsyncSync(fd);const sealed=fstatSync(fd,{bigint:true});assert(sealed.dev===initial.dev&&sealed.ino===initial.ino&&sealed.uid===0n&&sealed.gid===0n&&sealed.nlink===1n&&sealed.size===initial.size&&(sealed.mode&0o7777n)===0o444n);assert.equal(tuple(lstatSync(path,{bigint:true})),tuple(sealed));}finally{closeSync(fd);}assert(fullBytes(path,ciIndexOperationalBytes,check).equals(bytes));
   }fsyncSync(parent);fchmodSync(parent,0o555);fsyncSync(parent);const sealed=fstatSync(parent,{bigint:true});assert(sealed.dev===original.dev&&sealed.ino===original.ino&&sealed.uid===0n&&sealed.gid===0n&&(sealed.mode&0o7777n)===0o555n);assert.equal(tuple(lstatSync(evidence,{bigint:true})),tuple(sealed));
  }finally{closeSync(parent);}}catch{process.stderr.write("TEST CI public evidence seal failed; artifact not qualified\n");if(!primaryFailed)throw new Error("TEST CI public evidence seal failed");}
  finally{let cleanupFailed=false;for(const archive of archives.values())try{archive.close();}catch{cleanupFailed=true;}for(const tool of tools.values())try{closeSync(tool.fd);}catch{cleanupFailed=true;}for(const path of directories.slice().reverse())try{const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}catch{cleanupFailed=true;}if(cleanupFailed){process.stderr.write("TEST CI retained DATA cleanup unproven\n");process.exitCode=70;}}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){mainCiSignedToolInputs().catch(error=>{process.stderr.write((error instanceof Error?error.message:"TEST CI signed data failed")+"\n");process.exitCode=70;});}
