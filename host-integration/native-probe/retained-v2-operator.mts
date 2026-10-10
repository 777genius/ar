import { RetainedV2ProfileKind } from "./retained-v2-profile.mjs";
import { spawn } from "node:child_process";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, readSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { retainedResourceCanonicalJson, retainedResourceDigest, retainedResourceLocator, retainedResourceNames, parseScopedRetainedRecord, RetainedRecordKind } from "../../src/core/scoped-retained-resource-contract.js";
export const retainedV2A1Profile = Object.freeze({version:1,kind:RetainedV2ProfileKind.A1,effects:Object.freeze(["original-principal","original-parent-delegation","finite-target-obligation-reservation","stock-slice-target-retention","immutable-body-publication","observed-event-sidecar","native-commit-tail"]),source:false,work:false});
export const retainedV2A1Inventory = Object.freeze({roles:Object.freeze(["principal","fixture-helper-reservation","retained-resource"]),tasks:1,threads:1,messages:1024,journalEntries:1024,declarations:4,targets:1,bodies:4,eventSidecars:4,managerRequests:16});
export const retainedV2B1aProfile = Object.freeze({version:1,kind:RetainedV2ProfileKind.B1a,effects:Object.freeze([...retainedV2A1Profile.effects,"two-original-clone-pidfds","finite-private-role-protocol","exclusive-pidfd-scope","sealed-all-task-kernel-hold","original-bounded-raw-custody-join"]),source:false,work:false,actorAdmission:false,enqueue:false});
export const retainedV2B1aInventory = Object.freeze({...retainedV2A1Inventory,roles:Object.freeze(["principal","fixture-helper-reservation","retained-resource","borrowed-reference-daemon","creator","manager-submitter"]),tasks:3,threads:3,actorContainers:1,births:2,pidfds:2,rawWaits:2,rawStreams:4,roleChannels:2,roleFrames:4,managerRequests:120,referenceSlots:3,referenceChannelCalls:96,referenceMessages:160,referenceJobSlots:32,referenceApiConnections:1,referenceDirectConnections:1,referenceSenderSlots:1,borrowedDaemonPins:1,originalEffectSlots:11,birthInterlocks:1,birthCloseRequests:1,actorManagerMessages:64,heldCensuses:8,descriptorObservations:56,enqueueClaims:0,payloadGates:0});
interface FixedProfile { readonly kind: RetainedV2ProfileKind; readonly installation: string; readonly directory: string; readonly permitPath: string; readonly manifestPath: string; readonly roles: readonly string[]; readonly frame: string; readonly bootstrap: string; readonly snapshot: string; readonly funding: string; readonly profile: object; readonly inventory: object }
// Exactly two compiled Source profiles. No caller-selected path/command/recipe.
function fixedProfile(actors: boolean): FixedProfile {
  const installation=actors?"/opt/subscription-runtime/native-retained-v2-b1a":"/opt/subscription-runtime/native-retained-v2";
  const administrative=actors?"/run/subscription-runtime/native-retained-v2-b1a":"/run/subscription-runtime/native-retained-v2";
  return Object.freeze({kind:actors?RetainedV2ProfileKind.B1a:RetainedV2ProfileKind.A1,installation,directory:join(administrative,"original"),permitPath:join(administrative,"admin-permit.json"),manifestPath:join(installation,"root-installation.json"),roles:Object.freeze([join(installation,actors?"retained-v2-actor-entry":"retained-v2-entry"),join(installation,"test-root/opt/native/node"),join(installation,"test-root/opt/native/original-owner-helper.mjs"),join(installation,"test-root/opt/native/original-owner-associated.node"),"/usr/bin/dbus-daemon",join(installation,"admin/host-integration/native-probe",actors?"retained-v2-actor-operator.mjs":"retained-v2-operator.mjs"),join(installation,"expected-helper-policy.json")]),frame:actors?"NPB1":"NPV2",bootstrap:actors?"NPADB101":"NPADV201",snapshot:actors?"NPB1SN01":"NPV2SN01",funding:actors?"NPB1FD01":"NPV2FD01",profile:actors?retainedV2B1aProfile:retainedV2A1Profile,inventory:actors?retainedV2B1aInventory:retainedV2A1Inventory});
}
const second = 1_000_000_000n, max = (1n << 63n) - 1n;
export interface InstallationFile { readonly path: string; readonly bytes: number; readonly mode: number; readonly sha256: string }
interface InstallationManifest { readonly version: 1; readonly profile: RetainedV2ProfileKind; readonly daemonUid: number; readonly daemonGid: number; readonly files: readonly InstallationFile[] }
interface Permit { readonly version: 1; readonly kind: RetainedV2ProfileKind; readonly jobId: string; readonly machineId: string; readonly installationDigest: string; readonly profileDigest: string; readonly manifestDigest: string; readonly notBeforeNs: string; readonly workEndNs: string; readonly cleanupEndNs: string; readonly coldEndNs: string }
interface Context { readonly fixed: FixedProfile; readonly permit: Permit; readonly operationDigest: string; readonly anchor: bigint; readonly work: bigint; readonly cleanup: bigint; readonly cold: bigint }
function exactKeys(value: object, keys: readonly string[]): void { if (Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error("unknown administrative field"); }
function time(value: string): bigint { if (!/^[1-9][0-9]{0,18}$/.test(value)) throw new Error("invalid original time"); const n = BigInt(value); if (n > max) throw new Error("time overflow"); return n; }
function checked(fd: number, path: string, privateLeaf = false): void {
  const held = fstatSync(fd,{bigint:true}), named = lstatSync(path,{bigint:true});
  if (!held.isFile() || held.uid !== 0n || held.gid !== 0n || held.nlink !== 1n || held.dev !== named.dev || held.ino !== named.ino || held.mode !== named.mode || held.size !== named.size || held.mtimeNs !== named.mtimeNs || held.ctimeNs !== named.ctimeNs || (held.mode & 0o022n) || (privateLeaf && (held.mode & 0o777n) !== 0o600n)) throw new Error("changed administrative leaf");
}
function ancestors(path: string): void {
  if (!path.startsWith("/") || resolve(path) !== path || path.includes("//")) throw new Error("noncanonical installed path");
  for (let p = dirname(path); ; p = dirname(p)) { const s = lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) throw new Error("unprotected ancestor"); if (p === "/") break; }
}
function heldFile(path: string, privateLeaf = false): number { ancestors(path); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); checked(fd, path, privateLeaf); return fd; }
function boundedJson(fd: number, maximum: number): unknown { if (fstatSync(fd).size > maximum) throw new Error("administrative capacity"); return JSON.parse(readFileSync(fd, "utf8")) as unknown; }
function manifest(value: unknown, fixed: FixedProfile): InstallationManifest {
  const {installation,roles}=fixed;
  if (!value || typeof value !== "object") throw new Error("missing installation");
  exactKeys(value, ["version", "profile", "daemonUid", "daemonGid", "files"]);
  const m = value as InstallationManifest;
  if (m.version !== 1 || m.profile !== fixed.kind || !Number.isSafeInteger(m.daemonUid) || !Number.isSafeInteger(m.daemonGid) || m.daemonUid < 0 || m.daemonGid < 0 || m.daemonUid > 0xffffffff || m.daemonGid > 0xffffffff || !Array.isArray(m.files) || m.files.length < roles.length || m.files.length > 128) throw new Error("unsupported installation");
  const paths = new Set<string>();
  for (const [i, f] of m.files.entries()) {
    exactKeys(f, ["path", "bytes", "mode", "sha256"]);
    if (typeof f.path !== "string" || paths.has(f.path) || Buffer.byteLength(f.path) > 255 || (!f.path.startsWith(installation + "/") && f.path !== roles[4] && !f.path.startsWith("/usr/lib/") && f.path !== "/usr/bin/node" && f.path !== "/opt/subscription-runtime/runtime/node") || (i < roles.length && f.path !== roles[i]) || !Number.isSafeInteger(f.bytes) || f.bytes <= 0 || !Number.isSafeInteger(f.mode) || (f.mode & 0o022) || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new Error("invalid installed census");
    if(f.path.startsWith(installation+"/test-root/")){
      const relative=f.path.slice((installation+"/test-root").length);
      if(!roles.slice(1,4).includes(f.path)&&!/^\/(?:usr\/)?lib(?:64)?\/.+\.so(?:\.[0-9]+)*$/.test(relative))throw new Error("foreign private TEST image input");
    }
    paths.add(f.path);
  }
  // Admit every private image/admin leaf, including loaders and imported JS.
  for (const root of [join(installation, "test-root"), join(installation, "admin")]) {
    const walk = (p: string): void => { for (const name of readdirSync(p)) { const path = join(p, name), s = lstatSync(path); if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) throw new Error("foreign image entry"); if (s.isDirectory()) walk(path); else if (!s.isFile() || !paths.has(path)) throw new Error("omitted image closure"); } };
    walk(root);
  }
  return m;
}
function permit(value: unknown, fixed: FixedProfile): Permit {
  if (!value || typeof value !== "object") throw new Error("missing finite operation");
  exactKeys(value, ["version", "kind", "jobId", "machineId", "installationDigest", "profileDigest", "manifestDigest", "notBeforeNs", "workEndNs", "cleanupEndNs", "coldEndNs"]);
  const p = value as Permit;
  if (p.version !== 1 || p.kind !== fixed.kind || !/^[a-z][a-z0-9-]{0,31}$/.test(p.jobId) || !/^[a-f0-9]{32}$/.test(p.machineId) || [p.installationDigest,p.profileDigest,p.manifestDigest].some(x => !/^[a-f0-9]{64}$/.test(x))) throw new Error("invalid finite operation");
  for (const x of [p.notBeforeNs,p.workEndNs,p.cleanupEndNs,p.coldEndNs]) time(x);
  return p;
}
export const retainedV2ExpectedPolicy = Object.freeze({kind:"NativeRetainedV2ExpectedLeafV1",postExec:"np_helper_filter_v1",preExec:"np_helper_preexec_filter_v1",source:false,work:false});
interface FundedIntent { readonly bytes: Buffer; readonly generation: bigint }
interface Delegation { readonly root: number; readonly mount: number; readonly cgroup: number; readonly namespaceDigest: string; readonly managerDigest: string }
// DATA assembly only. This function does not construct any native capability.
function buildFunding(snapshot: Buffer, context: Context, delegation: Delegation): FundedIntent {
  if(snapshot.length!==400||snapshot.subarray(0,8).toString("ascii")!==context.fixed.snapshot||snapshot.subarray(392).some(x=>x))throw new Error("invalid retained native snapshot");
  const text=(offset:number,size:number):string=>snapshot.subarray(offset,offset+size).toString("ascii").replace(/\0+$/,"");
  const generation=snapshot.readBigUInt64BE(8),anchor=snapshot.readBigUInt64BE(16),work=snapshot.readBigUInt64BE(24),cleanup=snapshot.readBigUInt64BE(32),cold=snapshot.readBigUInt64BE(40),outer=snapshot.readBigUInt64BE(48),epoch=snapshot.readBigUInt64BE(376),observed=snapshot.readBigUInt64BE(384);
  if(!generation||anchor<context.anchor||anchor>max-180n*second||observed<anchor||observed>=cold||work!==(context.work<anchor+120n*second?context.work:anchor+120n*second)||cleanup!==(context.cleanup-5n*second<anchor+180n*second?context.cleanup-5n*second:anchor+180n*second)||cold!==(context.cold<anchor+10n*second?context.cold:anchor+10n*second)||outer!==context.cleanup||text(56,64)!==context.operationDigest||text(120,32)!==context.permit.machineId||text(152,32)!==context.permit.jobId||text(184,64)!==context.permit.installationDigest||text(248,64)!==context.permit.profileDigest||text(312,64)!==context.permit.manifestDigest||epoch<=0n||epoch>BigInt(Number.MAX_SAFE_INTEGER)-180000n)throw new Error("foreign retained native snapshot");
  const end=(n:bigint):number=>Number(epoch+(n-observed)/1000000n);
  const startId=randomUUID(),attemptId=randomUUID(),reservationId=randomUUID();
  const installed={installationId:context.permit.installationDigest,bootId:readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(),hostId:context.permit.machineId,namespaceDigest:delegation.namespaceDigest,managerDigest:delegation.managerDigest,producerId:context.operationDigest};
  const association=retainedResourceDigest(installed),policyDigest=retainedResourceDigest(retainedV2ExpectedPolicy);
  const authority={attemptId,deadlineEpochMs:end(cleanup),totalAllowanceMs:Number((cleanup-work)/1000000n),N:1,joinDigest:retainedResourceDigest({operation:context.operationDigest,cleanupNs:cleanup.toString()})};
  const target={scopeDigest:context.operationDigest,kind:"ordinary_allocation",topology:"single_owned_service",installation:installed,qualificationLocator:context.permit.installationDigest,workEndEpochMs:end(work),originalCleanupAuthority:authority,keyed:null,ordinaryAllocationId:context.operationDigest,allocations:[{allocationId:context.operationDigest,startId,allocationDigest:context.operationDigest,permissionDigest:context.permit.profileDigest,installationAssociationDigest:association,role:"fixture_helper",purpose:context.fixed.kind===RetainedV2ProfileKind.B1a?"retained-v2-actors-fixture-b1a":"retained-v2-fixture-a1",grantDigest:null,installedGrantDigest:null,unit:`subscription-runtime-fixture-${startId}.service`,qualificationLocator:context.permit.installationDigest,qualificationId:null,leafProfileDigest:policyDigest,effectiveFilterPolicyDigest:policyDigest,requiredFilterDigests:[policyDigest]}]};
  const targetDigest=retainedResourceDigest(target),resource=retainedResourceLocator(target as Parameters<typeof retainedResourceLocator>[0]),names=retainedResourceNames(resource),gate=retainedResourceDigest({operation:context.operationDigest,startId,profile:context.permit.profileDigest});
  const obligation={resourceDigest:resource,...{sliceUnit:names.sliceUnit,targetUnit:names.targetUnit},creationGateDigest:gate,lifecycle:"declared",originalAuthorityDigest:retainedResourceDigest(authority),installationAssociationDigest:association,manifest:{nonExecuting:true,requiresSlice:true,afterSlice:true,cpuWeight:100,denyReuseRestartRecreation:true}};
  const obligationDataDigest=retainedResourceDigest(obligation);
  const reservation={reservationId,reservationGeneration:1,startId,startDigest:retainedResourceDigest({operation:context.operationDigest,startId}),allocationDigest:context.operationDigest,obligationDigest:obligationDataDigest,originalGateDigest:gate,parentRuntime:null};
  // Validate exact closed DATA shapes without forecasting publication events.
  const data=[target,obligation,reservation],kinds=[RetainedRecordKind.Target,RetainedRecordKind.ResourceObligation,RetainedRecordKind.Reservation];
  data.forEach((value,index)=>parseScopedRetainedRecord({schemaVersion:2,kind:kinds[index],targetDigest,publication:{producerId:context.operationDigest,generation:index+1,admitted:{sequence:index+1,atEpochMs:Number(epoch)}},data:value}));
  const intents=data.map(value=>Buffer.from(retainedResourceCanonicalJson(value)+"\n"));
  const header=Buffer.alloc(276);header.write(context.fixed.funding);intents.forEach((bytes,index)=>header.writeUInt32BE(bytes.length,8+4*index));
  [targetDigest,resource,association,obligationDataDigest].forEach((value,index)=>header.write(value,20+64*index,"ascii"));
  const bytes=Buffer.concat([header,...intents]);if(bytes.length>16384-464)throw new Error("retained finite funding capacity");
  return {bytes,generation};
}
function fundingDigest(allocation: FundedIntent): string {return createHash("sha256").update(allocation.bytes).digest("hex");}
function encodeFundingAck(snapshot: Buffer, allocation: FundedIntent, fixed: FixedProfile): Buffer {
  const payload=Buffer.concat([snapshot,Buffer.from(fundingDigest(allocation),"ascii"),allocation.bytes]);
  const header=Buffer.alloc(24);header.write(fixed.frame);header[4]=2;header[5]=1;header.writeBigUInt64BE(BigInt(payload.length),8);header.writeBigUInt64BE(allocation.generation,16);
  return Buffer.concat([header,payload]);
}
async function phase(stream: Duplex, context: Context, end: bigint, delegation: Delegation): Promise<FundedIntent> {
  let originalGeneration=0n;
  let bytes: Buffer = Buffer.alloc(0); let stage = 1, allocation: FundedIntent | undefined;
  let highWater=context.anchor;
  const now = (): void => { const sample=process.hrtime.bigint(); if (sample<highWater || sample>=end) throw new Error("original allocation phase expired"); highWater=sample; };
  return await new Promise((accept,reject) => {
    const timer = setTimeout(() => reject(new Error("original allocation phase expired")), Math.max(1, Number((end-process.hrtime.bigint())/1_000_000n)));
    const fail = (error: Error): void => { clearTimeout(timer); stream.removeAllListeners("data"); reject(error); };
    stream.once("error",fail); stream.once("end",() => { if(stage!==4) fail(new Error("incomplete original phase")); });
    stream.on("data",(chunk: Buffer) => {
      try {
        now(); bytes=Buffer.concat([bytes,chunk]); if(bytes.length>16408)throw new Error("phase capacity");
        if(bytes.length<24)return;
        const length=bytes.readBigUInt64BE(8); if(length>16384n || !bytes.subarray(0,4).equals(Buffer.from(context.fixed.frame)) || bytes[4]!==stage || bytes[5]!==1 || bytes[6]!==0 || bytes[7]!==0)throw new Error("invalid phase frame");
        if(bytes.length<24+Number(length))return;
        if(bytes.length!==24+Number(length))throw new Error("extra phase frame");
        const payload=bytes.subarray(24), generation=bytes.readBigUInt64BE(16);bytes=Buffer.alloc(0);
        if(stage===1){if(payload.length!==400 || generation!==payload.readBigUInt64BE(8))throw new Error("snapshot generation");originalGeneration=generation;allocation=buildFunding(payload,context,delegation);now();stream.write(encodeFundingAck(payload,allocation,context.fixed));stage=3;}
        else {if(!allocation || generation!==originalGeneration || !payload.equals(Buffer.from(fundingDigest(allocation),"ascii")))throw new Error("freeze digest mismatch");now();stage=4;clearTimeout(timer);stream.removeAllListeners("data");accept(allocation);}
      } catch(error){fail(error instanceof Error?error:new Error(String(error)));}
    });
  });
}
function durable(path: string, bytes: Buffer): number { const fd = openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600); if(writeSync(fd,bytes)!==bytes.length)throw new Error("short original journal write");fsyncSync(fd);return fd; }
export async function runRetainedV2RootOperation(): Promise<void> {
  return runOperation(fixedProfile(false));
}
export async function runRetainedV2ActorRootOperation(): Promise<void> {
  return runOperation(fixedProfile(true));
}
let consumed=false;
async function runOperation(fixed: FixedProfile): Promise<void> {
  if(consumed)throw new Error("original administrative operation already consumed");consumed=true;
  const {directory,permitPath,manifestPath,roles}=fixed;
  if (process.argv.length!==2 || process.getuid?.()!==0 || process.getgid?.()!==0) throw new Error("fixed Root administrative invocation required");
  const anchor=process.hrtime.bigint(); const held: number[]=[];
  const permitFd=heldFile(permitPath,true), manifestFd=heldFile(manifestPath);held.push(permitFd,manifestFd);
  const p=permit(boundedJson(permitFd,8192),fixed), m=manifest(boundedJson(manifestFd,65536),fixed);
  if(p.profileDigest!==retainedResourceDigest(fixed.profile)||p.manifestDigest!==retainedResourceDigest(fixed.inventory))throw new Error("wrong fixed effect list/inventory");
  if(p.machineId!==readFileSync("/etc/machine-id","utf8").trim() || retainedResourceDigest(m)!==p.installationDigest)throw new Error("wrong installation/host");
  const minimum=(a: bigint,b: bigint): bigint => a<b?a:b;
  const work=minimum(time(p.workEndNs),anchor+120n*second), cleanup=minimum(time(p.cleanupEndNs),anchor+180n*second), cold=minimum(time(p.coldEndNs),minimum(anchor+10n*second,work));
  if(anchor<time(p.notBeforeNs)||cleanup<=work+5n*second||cold<=anchor)throw new Error("invalid enclosing original limits");
  const context: Context={fixed,permit:p,anchor,work,cleanup,cold,operationDigest:retainedResourceDigest({permit:p,anchorNs:anchor.toString(),workNs:work.toString(),cleanupNs:cleanup.toString(),coldNs:cold.toString()})};
  const mapped=readFileSync("/proc/self/maps","utf8").split("\n").flatMap(line=>{const match=/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line);return match?[match[1]!]:[];});
  const measuredPaths=new Set(m.files.map(file=>file.path));
  if(mapped.some(path=>!measuredPaths.has(path)))throw new Error("omitted original observer loader/library closure");
  const files: number[]=[];
  for(const row of m.files){const fd=heldFile(row.path);files.push(fd);held.push(fd);const before=fstatSync(fd,{bigint:true});const stat=fstatSync(fd);if(stat.size!==row.bytes||(stat.mode&0o7777)!==row.mode)throw new Error("installation metadata");const digest=createHash("sha256"), chunk=Buffer.alloc(65536);let offset=0;for(;;){const n=readSync(fd,chunk,0,chunk.length,offset);if(!n)break;digest.update(chunk.subarray(0,n));offset+=n;}checked(fd,row.path);const after=fstatSync(fd,{bigint:true});if(before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||before.size!==after.size||before.mode!==after.mode)throw new Error("installed bytes changed while measured");if(digest.digest("hex")!==row.sha256)throw new Error("installation digest");}
  // The permitted original Root parent acquires and retains this fixed
  // delegation before its child exists. Child constructor validates the same
  // inherited inode and namespace descriptors; no public FD/PID DTO importer.
  ancestors("/sys/fs/cgroup/cgroup.controllers");
  const root=openSync("/sys/fs/cgroup",constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW),mount=openSync("/proc/self/ns/mnt",constants.O_RDONLY),cgroup=openSync("/proc/self/ns/cgroup",constants.O_RDONLY);held.push(root,mount,cgroup);
  const rootStat=fstatSync(root,{bigint:true}),rootNamed=lstatSync("/sys/fs/cgroup",{bigint:true});
  if(!rootStat.isDirectory()||rootStat.uid!==0n||rootStat.gid!==0n||(rootStat.mode&0o022n)||rootStat.dev!==rootNamed.dev||rootStat.ino!==rootNamed.ino)throw new Error("original delegation changed");
  const mountStat=fstatSync(mount,{bigint:true}),groupStat=fstatSync(cgroup,{bigint:true});
  const managerStat=readFileSync("/proc/1/stat","utf8"),managerFields=managerStat.slice(managerStat.lastIndexOf(") ")+2).trim().split(/\s+/),managerBirth=managerFields[19];
  if(!managerStat.startsWith("1 (")||!managerBirth||!/^([1-9][0-9]*)$/.test(managerBirth))throw new Error("unobserved original manager birth");
  const managerMount=openSync("/proc/1/ns/mnt",constants.O_RDONLY),managerGroup=openSync("/proc/1/ns/cgroup",constants.O_RDONLY);held.push(managerMount,managerGroup);
  const mm=fstatSync(managerMount,{bigint:true}),mg=fstatSync(managerGroup,{bigint:true});
  if(mm.dev!==mountStat.dev||mm.ino!==mountStat.ino||mg.dev!==groupStat.dev||mg.ino!==groupStat.ino)throw new Error("foreign manager resource namespace");
  const delegation:Delegation={root,mount,cgroup,namespaceDigest:retainedResourceDigest({mount:{device:mountStat.dev.toString(),inode:mountStat.ino.toString()},cgroup:{device:groupStat.dev.toString(),inode:groupStat.ino.toString()}}),managerDigest:retainedResourceDigest({boot:readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(),pidBirth:`1:${managerBirth}`,machine:p.machineId})};
  const policyFd=files[6]!;if(!readFileSync(policyFd).equals(Buffer.from(retainedResourceCanonicalJson(retainedV2ExpectedPolicy)+"\n")))throw new Error("wrong expected installed helper policy");
  const record=Buffer.alloc(512+296*files.length);record.write(fixed.bootstrap);
  [rootStat.dev,rootStat.ino,mountStat.dev,mountStat.ino,groupStat.dev,groupStat.ino].forEach((value,index)=>record.writeBigUInt64BE(value,432+8*index));for(const [offset,n] of [[8,anchor],[16,work],[24,cleanup],[32,cold],[40,BigInt(process.pid)],[408,BigInt(m.daemonUid)],[416,BigInt(m.daemonGid)],[424,BigInt(files.length)]] as const)record.writeBigUInt64BE(n,offset);
  const boot=readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim();
  for(const [offset,value] of [[48,p.jobId],[80,p.machineId],[112,boot],[148,context.operationDigest],[212,p.installationDigest],[276,p.profileDigest],[340,p.manifestDigest]] as const)record.write(value,offset,"ascii");
  for(const [i,fd] of files.entries()){const stat=fstatSync(fd,{bigint:true}),offset=512+296*i;record.write(m.files[i]!.path,offset,"utf8");record.writeBigUInt64BE(stat.dev,offset+256);record.writeBigUInt64BE(stat.ino,offset+264);record.writeBigUInt64BE(stat.size,offset+272);record.writeBigUInt64BE(stat.mode&0o7777n,offset+280);}
  ancestors(join(directory,"bootstrap.bin"));const leaf=lstatSync(directory);if(!leaf.isDirectory()||leaf.uid!==0||leaf.gid!==0||(leaf.mode&0o777)!==0o700)throw new Error("private operation directory");
  const writeFd=durable(join(directory,"bootstrap.bin"),record);closeSync(writeFd);const recordFd=heldFile(join(directory,"bootstrap.bin"),true),directoryFd=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);held.push(recordFd,directoryFd);
  for(let path=directory;;path=dirname(path)){const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);fsyncSync(fd);closeSync(fd);if(path==="/")break;}
  if(process.hrtime.bigint()>=cold)throw new Error("original bootstrap expired");
  const phaseEnd=minimum(process.hrtime.bigint()+2n*second,cold);
  // Every native inherited descriptor is already admitted and held; no env selector.
  const child=spawn(roles[0]!,[],{env:{PATH:"/usr/bin:/bin"},stdio:["pipe","pipe","pipe","pipe",recordFd,manifestFd,directoryFd,...files,root,mount,cgroup]});
  const channel=child.stdio[3];if(!(channel instanceof Duplex))throw new Error("missing original observer channel");
  let exit: {code: number|null;signal: NodeJS.Signals|null}|undefined, stdoutEof=false,stderrEof=false,raw:Buffer=Buffer.alloc(0),stderr:Buffer=Buffer.alloc(0),ready=false;
  let failure: unknown, issued: FundedIntent|undefined;
  child.stdout!.on("data",(chunk:Buffer)=>{if(raw.length+chunk.length>65536){failure=new Error("original stdout capacity");child.kill("SIGTERM");return;}raw=Buffer.concat([raw,chunk]);if(!ready&&raw.toString("utf8").split("\n").includes('{"stage":"retained-v2-resource-bound"}')){ready=true;}});
  child.stderr!.on("data",(chunk:Buffer)=>{if(stderr.length+chunk.length>65536){failure=new Error("original stderr capacity");child.kill("SIGTERM");return;}stderr=Buffer.concat([stderr,chunk]);});
  child.stdout!.once("end",()=>{stdoutEof=true;});child.stderr!.once("end",()=>{stderrEof=true;});
  child.once("exit",(code,signal)=>{exit={code,signal};});
  const closed=new Promise<void>((accept,reject)=>{child.once("close",()=>accept());child.once("error",reject);});
  const killTimer=setTimeout(()=>child.kill("SIGKILL"),Math.max(1,Number((cleanup-process.hrtime.bigint())/1_000_000n)));
  try {
    const allocation=await phase(channel,context,phaseEnd,delegation);issued=allocation;
    // A1 deliberately has no Start/Stop/enqueue request. The original child
    // retains its finite resource prefix and exits UNKNOWN_HELD at its boundary.
  } catch(error){failure=error;child.stdin!.end();child.kill("SIGTERM");}
  await closed;clearTimeout(killTimer);
  closeSync(durable(join(directory,"principal.stdout"),raw));closeSync(durable(join(directory,"principal.stderr"),stderr));
  const lines=raw.toString("utf8").trim().split("\n");let native:unknown;try{native=JSON.parse(lines.at(-1)??"");}catch{native=null;}
  const prefixRows:Array<{path:string;bytes:number;sha256:string}>=[];
  try {
    const names=readdirSync(directory).filter(name=>/^prefix-[0-9]{4}\.json$/.test(name)).sort();
    if(names.length>1024)throw new Error("native prefix capacity");
    for(const [index,name] of names.entries()){
      if(name!==`prefix-${index.toString().padStart(4,"0")}.json`)throw new Error("native prefix gap");
      const path=join(directory,name),fd=heldFile(path,true);
      try {const stat=fstatSync(fd);if(stat.size>4608)throw new Error("native prefix byte capacity");
        const bytes=readFileSync(fd),value=JSON.parse(bytes.toString("utf8")) as {index:number;generation:string};checked(fd,path,true);
        if(value.index!==index||!bytes.equals(Buffer.from(retainedResourceCanonicalJson(value)+"\n"))||(issued&&value.generation!==issued.generation.toString()))throw new Error("changed native prefix identity");
        prefixRows.push({path:name,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")});
      }finally{closeSync(fd);}
    }
    closeSync(durable(join(directory,"native-prefixes.json"),Buffer.from(retainedResourceCanonicalJson(prefixRows)+"\n")));
  }catch(error){failure=error;}
  const actorsHeldObserved=fixed.kind===RetainedV2ProfileKind.B1a && lines.includes('{"stage":"native-b1a-actors-held","actorAdmission":false,"enqueue":false,"terminal":false}');
  const result={status:"SOURCE_ONLY_UNKNOWN_HELD",nativePrefixCount:prefixRows.length,nativePrefixDigest:retainedResourceDigest(prefixRows),principalExit:exit??null,stdoutEof,stderrEof,native,resourceBoundObserved:ready,...(fixed.kind===RetainedV2ProfileKind.B1a?{actorsHeldObserved,actorAdmission:false,enqueue:false}:{}),terminal:false,qualification:false,error:failure instanceof Error?failure.message:failure?String(failure):null};
  const resultFd=durable(join(directory,fixed.kind===RetainedV2ProfileKind.B1a?"b1a-observation.json":"l0.json"),Buffer.from(retainedResourceCanonicalJson(result)+"\n"));closeSync(resultFd);fsyncSync(directoryFd);
  for(const fd of held)closeSync(fd);process.stdout.write(retainedResourceCanonicalJson(result)+"\n");process.exitCode=77;
}
if(resolve(process.argv[1]??"")===fileURLToPath(import.meta.url))runRetainedV2RootOperation().catch(error=>{process.stderr.write(String(error)+"\n");process.exitCode=77;});
