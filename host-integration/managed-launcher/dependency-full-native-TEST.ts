import { OriginalFullPeerPreloadSelectionKind, originalFullProjectControlPreloadData, originalFullProjectControlSourcePaths, originalFullProjectControlPeerMetadataPaths } from "./hosted-project-control-source-catalog.js";
import { originalFullGuestNativeSourcePaths } from "./hosted-full-guest-source-inventory.js";
import { H1ElfRole, validateH1ElfRole } from "./dependency-full-h1-elf-role-TEST.js";
import {H1ConstructorHeld,h1HeldError,h1ReadonlyCache,retainH1ConstructorLoadFacts,checkH1PythonRouteData,checkH1ActorStatusData,h1OriginalDeadlineData,H1ApiKind,H1PidView,checkH1OwnedCgroupData,checkH1ApiObjectData,checkH1HostReleaseData} from "./dependency-full-h1-constructor-closure-TEST.js";
import type { FullPositiveCopyRow } from "./dependency-full-positive-copy-TEST.js";
import { originalProviderSetupSlot, providerSetupQueryClosureData, type OriginalSetupTask, type OriginalSetupFact, type OriginalSetupContext } from "./dependency-full-provider-setup-TEST.js";
import { managedSystemdRunExecutable, fullPositiveTestRoot, fullPositiveTestJob, fullPositiveTestEntry, parseNativeUnitProperties } from "./launch.mjs";
import {H1CatalogKind,H1MountOrigin,H1StagedSlotState,H1StagedActorRole,h1StagedObserverBootstrap,h1StagedSubjectData,retainH1StagedCatalogData,requireQualifiedH1StagedConstructor,type H1StagedSubject,type H1StagedObserverPrepared} from "./dependency-full-h1-staged-tools-TEST.js";
const fullPositiveTestCohort = Object.freeze([
  ["host-integration/host-jobs/manager.mjs", "host-jobs/manager.mjs"],
  ["host-integration/host-jobs/contract.mjs", "host-jobs/contract.mjs"],
  // Existing installedModules pins this DATA leaf; the TEST manager never executes it.
  ["host-integration/host-jobs/endpoint.mjs", "host-jobs/endpoint.mjs"],
  ["host-integration/host-jobs/storage-policy.mjs", "host-jobs/storage-policy.mjs"],
  ["host-integration/managed-launcher/launch.mjs", "managed-launcher/launch.mjs"],
  ["host-integration/managed-launcher/profiles.mjs", "managed-launcher/profiles.mjs"],
  ["host-integration/managed-launcher/storage-pressure-guard.mjs", "managed-launcher/storage-pressure-guard.mjs"],
  ["host-integration/managed-launcher/payload-guard.mjs", "managed-launcher/payload-guard.mjs"],
  ["host-integration/managed-launcher/hosted-host-policy.mjs", "managed-launcher/hosted-host-policy.mjs"],
  ["host-integration/managed-launcher/full-positive-test-profile.mjs", "managed-launcher/full-positive-test-profile.mjs"],
  ["host-integration/managed-launcher/launch-full-positive-TEST.mjs", "managed-launcher/launch-full-positive-TEST.mjs"],
  ["host-integration/host-jobs/full-positive-manager-TEST.mjs", "host-jobs/full-positive-manager-TEST.mjs"],
  ["host-integration/managed-launcher/dependency-full-native-TEST.js", "managed-launcher/dependency-full-native-TEST.mjs"],
  ["host-integration/managed-launcher/dependency-full-h1-staged-tools-TEST.js", "managed-launcher/dependency-full-h1-staged-tools-TEST.js"],
  ["host-integration/managed-launcher/dependency-full-h1-constructor-closure-TEST.js", "managed-launcher/dependency-full-h1-constructor-closure-TEST.js"],
  ["host-integration/managed-launcher/dependency-full-h1-rooted-reader-TEST.js", "managed-launcher/dependency-full-h1-rooted-reader-TEST.js"],
  ["host-integration/managed-launcher/dependency-full-h1-elf-role-TEST.js", "managed-launcher/dependency-full-h1-elf-role-TEST.js"],
  ["host-integration/managed-launcher/dependency-full-python-envelope-TEST.js", "managed-launcher/dependency-full-python-envelope-TEST.js"],
  ["host-integration/managed-launcher/dependency-full-positive-copy-TEST.js", "managed-launcher/dependency-full-positive-copy-TEST.js"],
  ["host-integration/managed-launcher/dependency-full-provider-setup-TEST.js", "managed-launcher/dependency-full-provider-setup-TEST.js"],
  ["dist/provider-codex/app-server/adapters/hosted-fd-unit-lifecycle.js", "managed-launcher/hosted-fd-unit-lifecycle.js"],
  ["dist/provider-codex/app-server/adapters/hosted-fd-unit-policy.js", "managed-launcher/hosted-fd-unit-policy.js"],
  ["dist/provider-codex/app-server/adapters/hosted-project-control-source-catalog.js", "managed-launcher/hosted-project-control-source-catalog.js"],
  ["dist/provider-codex/app-server/adapters/hosted-signed-tool-elf.js", "managed-launcher/hosted-signed-tool-elf.js"],
  ["dist/provider-codex/app-server/adapters/hosted-full-guest-source-inventory.js", "managed-launcher/hosted-full-guest-source-inventory.js"],
] as const);
/** One exceptional ROOT TEST profile. No ordinary profile or caller may select
 * capabilities, roots or commands. Protected reviews are independently issued. */
import { createHash } from "node:crypto";
import { spawn,spawnSync,type ChildProcess } from "node:child_process";
import { constants, closeSync, fsyncSync, mkdirSync, writeFileSync, fstatSync, statSync, lstatSync, openSync, readSync, writeSync, readFileSync, readdirSync, readlinkSync, realpathSync, statfsSync, type Stats } from "node:fs";
import { basename, dirname } from "node:path";
import { types } from "node:util";
import {performance} from "node:perf_hooks";
import {PassThrough} from "node:stream";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
export const fullNativeJob=fullPositiveTestJob;
export const fullNativeInputBase="/srv/workers/jobs/"+fullNativeJob+"/input";
export const fullNativeTmpDir="/srv/workers/jobs/"+fullNativeJob+"/tmp";
export const fullNativePublicDownloadBase="/srv/workers/jobs/"+fullNativeJob+"/public-codex-download";
export const fullNativePublicCapsule="/srv/workers/jobs/"+fullNativeJob+"/public-codex-input/@openai";
export const fullNativeBirthRoot="/srv/workers/jobs/"+fullNativeJob+"/full-launch-birth";
export const fullNativeLiveRoot="/srv/workers/jobs/"+fullNativeJob+"/full-parent-live";
export const fullNativeGuestLiveRoot="/var/lib/subscription-runtime-full-parent-live";
const fullNativeOutputBase="/var/lib/subscription-runtime-full-TEST-output";
export const fullNativeOsBase="/srv/workers/jobs/TEST-dependency-full-positive-scoped-20261010-r1/os-TEST";
/** DATA path contract only; physical root custody is checked separately. */
export function fullNativeGuestRoot(id:unknown,root:unknown):boolean {
  return typeof id==="string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) && root===fullNativeOsBase+"/"+id+"/root";
}
const bootstrapNode="/opt/nodejs/node-v24.21.0-linux-x64/bin/node";
const integration=fullPositiveTestRoot, reviewRoot="/srv/worker-state/protected-storage-test/dependency-full-positive-scoped-activation";
const reviewPath=reviewRoot+"/review.json", sourceBase="28511fec3a4796db3b86ac57f376d64c4b9b8d29";
const hash=(value: string|Buffer)=>createHash("sha256").update(value).digest("hex");
export const fullNativeUnit="subscription-job-"+hash(fullNativeJob)+".service";
const fullNativeControlGroup="/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/"+fullNativeUnit;
const ledger="/root/.local/state/subscription-runtime/host-jobs/"+fullNativeUnit+".json";
export const fullNativeLimits=Object.freeze({runtimeSeconds:1800,stopSeconds:180,memoryMiB:2048,tasksMax:128,cpuPercent:100});
export enum FullParentPhase {Starting="starting",Started="started"}
enum FullKernelState {Active="active",Activating="activating",Running="running",Loaded="loaded"}
enum FullOperation {Start="start",Job="job"}
function refuse():never{throw new Error("TEST full managed ingress Held");}
function check(value:unknown):asserts value {if(!value)refuse();}
const digest=(v:unknown):v is string=>typeof v==="string" && /^[a-f0-9]{64}$/.test(v);
function requireDigest(value:unknown):string{check(digest(value));return value;}
const readFd=(fd:number)=>readFileSync(`/proc/self/fd/${fd}`);
const sha=(v:unknown):v is string=>typeof v==="string" && /^[a-f0-9]{40}$/.test(v);
/** DATA parser only. Original authority always adds physical and kernel joins. */
export function fullData(value:unknown,keys:readonly string[]):Record<string,unknown> {
  check(value!==null && typeof value==="object" && !types.isProxy(value) && Object.getPrototypeOf(value)===Object.prototype);
  const descriptors=Object.getOwnPropertyDescriptors(value),own=Reflect.ownKeys(descriptors);
  check(own.length===keys.length && own.every(k=>typeof k==="string" && keys.includes(k)));
  const result:Record<string,unknown>={};
  for(const key of keys){const d=descriptors[key];check(d && Object.hasOwn(d,"value") && d.enumerable);result[key]=d.value;}
  return result;
}
/** Select malformed fixed-job candidates for REFUSAL, never legacy fallback. */
export function fullNativeIntended(value:unknown):boolean {
  if(value===null || typeof value!=="object")return false;
  check(!types.isProxy(value));
  const descriptors=Object.getOwnPropertyDescriptors(value);check(Object.values(descriptors).every(d=>Object.hasOwn(d,"value")));
  const d=Object.getOwnPropertyDescriptor(value,"jobId");return !!d && Object.hasOwn(d,"value") && d.value===fullNativeJob;
}
export enum FullRemovalCase { Positive="positive", ParentCrashH1="parent_crash_h1" }
/** Fixed command selection; no environment value can enroll H1. */
export function fullNativeRemovalCase(value:unknown):FullRemovalCase {
  if(value===undefined)return FullRemovalCase.Positive;
  check(value===FullRemovalCase.Positive || value===FullRemovalCase.ParentCrashH1);return value;
}
export function fullNativeParentArgv(node:string,parent:string,removalCase:FullRemovalCase):readonly string[] {
  check(typeof node==="string" && typeof parent==="string");
  check(removalCase===FullRemovalCase.Positive || removalCase===FullRemovalCase.ParentCrashH1);
  return Object.freeze([node,parent,...(removalCase===FullRemovalCase.ParentCrashH1?["--parent-crash-h1"]:[])]);
}
export enum FullNativeUnsupportedReason { H1PythonSourceClosure="h1_python_stdlib_source_unsupported" }
/** Temporary containment: the current H1 schema authenticates ELF only.
 * No review field or expected ELF digest can enable unverified Python imports.
 * Replace this refusal only with the reviewed finite source-closure validator. */
function requireSupportedH1SourceClosure():void {
  throw new Error("TEST full managed ingress Held: "+FullNativeUnsupportedReason.H1PythonSourceClosure);
}
export enum FullRestoreConsumer { Ordinary="ordinary", Readonly="readonly" }
/** Finite TEST case selection only. It carries no identity or launch authority. */
export function fullNativeRestoreConsumer(value:unknown):FullRestoreConsumer {
  if(value===undefined)return FullRestoreConsumer.Ordinary;
  check(value===FullRestoreConsumer.Ordinary || value===FullRestoreConsumer.Readonly);return value;
}
export enum FullPositiveAccount {R="account-r",W="account-w"}
function fullPositiveAccountData(value:unknown):FullPositiveAccount {
  check(value===FullPositiveAccount.R || value===FullPositiveAccount.W);return value;
}
/** DATA join only. Original acquire supplies independently protected inputs. */
export function fullPositiveOuterReviewData(value:unknown,accountName:FullPositiveAccount,sourceSha:string,nodeSha256:string) {
  fullPositiveAccountData(accountName);check(sha(sourceSha) && digest(nodeSha256));
  const input=fullData(value,["accountName","nodeSha256","reviewReference","schemaVersion","sourceSha"]);
  check(input.schemaVersion===1 && input.accountName===accountName && input.sourceSha===sourceSha && input.nodeSha256===nodeSha256);return input;
}
const fullReviewKeys=["schemaVersion","sourceBaseSha","sourceSha","sourceTree","machineId","bootId","nodeSha256","launcherSha256","moduleSha256","parentSha256","catalogSha256","outerReviewSha256","publicReviewSha256","accountName","reviewReference","hostTools","systemdVersion","installedModules"];
export function fullReviewData(value:unknown) {
  check(value!==null && typeof value==="object" && !types.isProxy(value) && Object.getPrototypeOf(value)===Object.prototype);
  const version=Object.getOwnPropertyDescriptor(value,"schemaVersion");check(version && Object.hasOwn(version,"value"));
  if(version.value===2){
    const review=fullData(value,[...fullReviewKeys,"removalCase","restoreConsumer"]);
    fullPositiveAccountData(review.accountName);check(review.removalCase===FullRemovalCase.Positive && review.restoreConsumer===FullRestoreConsumer.Ordinary);
    if(hasPositiveHostDso(review.hostTools))fullHostToolsData(review);
    return review;
  }
  check(version.value===1);
  const selected=Object.hasOwn(value,"restoreConsumer"),removalSelected=Object.hasOwn(value,"removalCase"),stagedInline=Object.hasOwn(value,"h1StagedSubject"),stagedReference=Object.hasOwn(value,"h1StagedSubjectSha256"),stagedSelected=stagedInline || stagedReference;
  check(!(stagedInline && stagedReference));
  const review=fullData(value,[...fullReviewKeys,...(selected?["restoreConsumer"]:[]),...(removalSelected?["removalCase"]:[]),...(stagedInline?["h1StagedSubject"]:[]),...(stagedReference?["h1StagedSubjectSha256"]:[])]);
  if(stagedReference)check(digest(review.h1StagedSubjectSha256));
  if(removalSelected)fullNativeRemovalCase(review.removalCase);
  if(stagedSelected)check(review.removalCase===FullRemovalCase.ParentCrashH1 && (review.restoreConsumer===undefined || review.restoreConsumer===FullRestoreConsumer.Ordinary));
  if(selected)check(review.restoreConsumer===FullRestoreConsumer.Ordinary || review.restoreConsumer===FullRestoreConsumer.Readonly);
  if(stagedSelected)fullHostToolsData(review);else check(!hasPositiveHostDso(review.hostTools));
  return review;
}
enum RootContext {Launcher="Launcher",Parent="Parent",Installer="Installer"}
const positiveInstallationStage="/srv/workers/public-intake/"+fullNativeJob+"/full-positive-installation";
const positiveInstallationReview=positiveInstallationStage+"/review.json";
function initialRoot(context:RootContext){
  const limits=readFileSync("/proc/self/limits","utf8");check(Buffer.byteLength(limits)<=16384);
  const rows=[...limits.matchAll(/^Max open files\s+([0-9]+)\s+([0-9]+)\s+files$/gm)];
  check(rows.length===1 && BigInt(rows[0]![1]!)>=65536n && BigInt(rows[0]![2]!)>=65536n);
  check(process.platform==="linux" && process.arch==="x64" && process.getuid?.()===0 && process.geteuid?.()===0);
  check(readFileSync("/proc/self/uid_map","utf8").trim().split(/\s+/).join(" ")==="0 0 4294967295");
  for(const ns of ["user","pid","mnt","cgroup","net","uts","ipc"]){if(ns==="mnt" && context===RootContext.Parent)continue;check(readlinkSync(`/proc/self/ns/${ns}`)===readlinkSync(`/proc/1/ns/${ns}`));}
  check(readlinkSync("/proc/self/ns/user")==="user:[4026531837]" && readlinkSync("/proc/self/ns/pid")==="pid:[4026531836]");
  check(/^NSpid:\s+1$/m.test(readFileSync("/proc/1/status","utf8")));
}
const identity=(s:Stats)=>[s.dev,s.ino,s.uid,s.gid,s.mode,...(s.isDirectory()?[]:[s.nlink,s.size,s.mtimeMs,s.ctimeMs])].map(String).join(":");
const sharedAncestor="/srv/worker-state";
function ancestorMountId(fd:number):string {
  const raw=readFileSync(`/proc/self/fdinfo/${fd}`,"utf8");check(Buffer.byteLength(raw)<=4096);
  const rows=[...raw.matchAll(/^mnt_id:\s+([1-9][0-9]{0,19})$/gm)],id=rows[0]?.[1];check(rows.length===1 && id);return id;
}
/** One measured existing directory, never an alternate owner policy for roots/leaves. */
function assertSharedAncestor(fd:number,parent:number) {
  const held=fstatSync(fd),named=lstatSync(sharedAncestor),srv=fstatSync(parent);
  check(held.isDirectory() && held.uid===0 && held.gid===987 && (held.mode&0o7777)===0o751
    && !(held.mode&0o022) && held.dev===2306 && held.ino===13631491 && held.dev===srv.dev
    && !named.isSymbolicLink() && identity(named)===identity(held) && realpathSync(`/proc/self/fd/${fd}`)===sharedAncestor);
  const fresh=openSync(sharedAncestor,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|constants.O_DIRECTORY);
  try{check(identity(fstatSync(fresh))===identity(held) && ancestorMountId(fresh)===ancestorMountId(fd)
    && ancestorMountId(fd)===ancestorMountId(parent));}finally{closeSync(fresh);}
}
// Standalone installed launcher cannot import the public runtime's src tree.
// Query only a retained FD's Linux magiclink, with native object brackets.
function retainedFilesystemType(fd:number):bigint {
  check(Number.isSafeInteger(fd) && fd>=0);const before=fstatSync(fd,{bigint:true}),path=`/proc/self/fd/${fd}`;
  const matches=(stat:typeof before)=>stat.dev===before.dev && stat.ino===before.ino && stat.mode===before.mode
    && stat.uid===before.uid && stat.gid===before.gid && stat.rdev===before.rdev;
  check(matches(statSync(path,{bigint:true})));const type=statfsSync(path,{bigint:true}).type;
  check(matches(fstatSync(fd,{bigint:true})) && matches(statSync(path,{bigint:true})));return type;
}
class Pins {
  private readonly held=new Map<string,{fd:number;identity:string;sha256:string|null}>();private closed=false;private readonly namespaces:number[]=[];
  mountNamespace(){const fd=openSync("/proc/self/ns/mnt",constants.O_RDONLY);this.namespaces.push(fd);return fd;}
  /** The fixed systemd writable root must exist before namespace setup.
   * Only the original installer calls this create-only operation. */
  prepareOutputRoot():void {
    const parent=this.hold(dirname(fullNativeOutputBase),true);this.validate();
    this.assertOutputAncestors();
    let exists=true;
    try{lstatSync(fullNativeOutputBase);}catch(error){check(error instanceof Error && "code" in error && error.code==="ENOENT");exists=false;}
    if(!exists){
      mkdirSync(`/proc/self/fd/${parent}/${basename(fullNativeOutputBase)}`,{mode:0o700});
      fsyncSync(parent);
    }
    const fd=this.hold(fullNativeOutputBase,true,0o700);
    this.validate();fsyncSync(fd);this.validate();
  }
  private assertOutputAncestors():void {
    const root=this.held.get("/");check(root);
    const device=fstatSync(root.fd).dev,mount=ancestorMountId(root.fd);
    for(const path of ["/","/var","/var/lib",...(this.held.has(fullNativeOutputBase)?[fullNativeOutputBase]:[])]){
      const entry=this.held.get(path);check(entry);const stat=fstatSync(entry.fd),named=lstatSync(path);
      check(stat.isDirectory() && stat.uid===0 && stat.gid===0 && !(stat.mode&0o022)
        && stat.dev===device && ancestorMountId(entry.fd)===mount
        && !named.isSymbolicLink() && identity(named)===entry.identity && identity(stat)===entry.identity
        && realpathSync(`/proc/self/fd/${entry.fd}`)===path);
      if(path===fullNativeOutputBase)check((stat.mode&0o7777)===0o700);
    }
  }
  hold(path:string,directory=false,mode?:number):number{
    check(!this.closed);const found=this.held.get(path);if(found){
      if(path===sharedAncestor){check(directory);const parent=this.held.get("/srv");check(parent);assertSharedAncestor(found.fd,parent.fd);}
      if(mode!==undefined)check((fstatSync(found.fd).mode&0o7777)===mode);return found.fd;}
    const parent=path==="/"?null:this.hold(dirname(path),true);
    const fd=openSync(parent===null?"/":`/proc/self/fd/${parent}/${basename(path)}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(directory?constants.O_DIRECTORY:0));
    try{const s=fstatSync(fd),shared=directory && path===sharedAncestor;
      if(shared){check(parent!==null);assertSharedAncestor(fd,parent);}
      check(s.uid===0 && (s.gid===0 || shared) && !(s.mode&0o022) && (directory?s.isDirectory():s.isFile() && s.nlink===1));
      if(mode!==undefined)check((s.mode&0o7777)===mode);
      check(directory || s.size<=128*1024*1024);
      this.held.set(path,{fd,identity:identity(s),sha256:directory?null:hash(readFd(fd))});return fd;
    }catch{closeSync(fd);refuse();}
  }
  publicFile(path:string,expected:string){check(digest(expected));const fd=this.hold(path);check(this.held.get(path)?.sha256===expected);return fd;}
  json(path:string,maximum:number){const fd=this.hold(path,false,0o600);check(fstatSync(fd).size<=maximum);const bytes=readFd(fd),v:unknown=JSON.parse(bytes.toString("utf8"));check(bytes.equals(Buffer.from(JSON.stringify(v)+"\n")));return v;}
  validate(){check(!this.closed);for(const [path,e] of this.held){const named=lstatSync(path),held=fstatSync(e.fd);check(!named.isSymbolicLink() && identity(named)===e.identity && identity(held)===e.identity);
    if(path===sharedAncestor){const parent=this.held.get("/srv");check(parent);assertSharedAncestor(e.fd,parent.fd);}
    const fresh=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(held.isDirectory()?constants.O_DIRECTORY:0));
    try{check(identity(fstatSync(fresh))===e.identity && ancestorMountId(fresh)===ancestorMountId(e.fd));}finally{closeSync(fresh);}
    if(e.sha256)check(hash(readFd(e.fd))===e.sha256);}if(this.held.has(fullNativeOutputBase))this.assertOutputAncestors();}
  descriptors(){check(!this.closed);return [...this.held.values()].map(entry=>entry.fd).concat(this.namespaces);}
  sourceSnapshot(){this.validate();return hash(JSON.stringify([...this.held.entries()].filter(([,entry])=>entry.sha256!==null).map(([path,entry])=>({path,identity:entry.identity,sha256:entry.sha256})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)));}
  close(){if(this.closed)return;this.closed=true;for(const e of [...this.held.values()].reverse())closeSync(e.fd);this.held.clear();for(const fd of this.namespaces)closeSync(fd);this.namespaces.length=0;}
}
const h1LibcPath="/usr/lib/x86_64-linux-gnu/libc.so.6";
const h1LibcKeys=["dev","ino","uid","gid","mode","nlink","size","mtimeNs","ctimeNs"] as const;
/** DATA only: expected metadata comes from the existing protected review,
 * independently authenticated against the actual host candidate. No defaults. */
export function fullH1LibcMetadataData(value:unknown):Readonly<Record<typeof h1LibcKeys[number],string>> {
  const row=fullData(value,h1LibcKeys);const result:Record<typeof h1LibcKeys[number],string>={dev:"",ino:"",uid:"",gid:"",mode:"",nlink:"",size:"",mtimeNs:"",ctimeNs:""};
  for(const key of h1LibcKeys){const field=row[key];check(typeof field==="string" && /^(0|[1-9][0-9]{0,29})$/.test(field));result[key]=field;}
  check(result.uid==="0" && result.gid==="0" && result.nlink==="2" && BigInt(result.ino)>0n && BigInt(result.size)>0n && BigInt(result.size)<=128n*1024n*1024n && (BigInt(result.mode)&0o170000n)===0o100000n && !(BigInt(result.mode)&0o022n));
  return Object.freeze(result);
}
export function fullH1LibcAliasesData(value:unknown):readonly [string,string] {
  const paths=fullDataArray(value);check(paths[0]<paths[1] && paths.includes(h1LibcPath) && paths.every(path=>/^\/usr\/lib\/x86_64-linux-gnu\/[A-Za-z0-9_.+-]+$/.test(path)));return Object.freeze(paths);
}
export function fullH1LibcMetadataMatches(actual:unknown,expected:unknown):void {const a=fullH1LibcMetadataData(actual),e=fullH1LibcMetadataData(expected);for(const key of h1LibcKeys)check(a[key]===e[key]);}
const positiveHostLibcSha="3a15d66867d83762c7f2f1e37359cb8f6c5743edb369c65285cb0b1c4f7498bf";
const positiveHostLibcAlias="/nonexistent/.debug/usr/lib/x86_64-linux-gnu/libc.so.6/a4a7992a8e66555c8141ab2a08a8465ff6e0ea65/elf";
function hasPositiveHostLibc(value:unknown):boolean {
  if(value===null || typeof value!=="object")return false;
  check(!types.isProxy(value));return Object.hasOwn(value,"positiveHostLibc");
}
const positiveHostSystemdSharedPath="/usr/lib/x86_64-linux-gnu/systemd/libsystemd-shared-255.so";
const positiveHostSystemdSharedSha="356f170e9e3a9dfb8026448b81d999863794e30f9c7136b4dfdd0b7abbf73116";
const positiveHostSystemdSharedAlias="/nonexistent/.debug/usr/lib/x86_64-linux-gnu/systemd/libsystemd-shared-255.so/7f29ab33e6b88429c49398ab9a4d288d329bf2bd/elf";
function hasPositiveHostSystemdShared(value:unknown):boolean {
  if(value===null || typeof value!=="object")return false;
  check(!types.isProxy(value));return Object.hasOwn(value,"positiveHostSystemdShared");
}
function hasPositiveHostDso(value:unknown):boolean{return hasPositiveHostLibc(value)||hasPositiveHostSystemdShared(value);}
/** Closed second role only; the complete expected tuple comes from protected review. */
export function fullPositiveHostSystemdSharedData(value:unknown) {
  const row=fullData(value,["path","sha256","tuple","aliases"]);
  check(row.path===positiveHostSystemdSharedPath && row.sha256===positiveHostSystemdSharedSha);
  const tuple=fullH1LibcMetadataData(row.tuple),aliases=fullDataArray(row.aliases);
  check(tuple.mode===String(0o100644) && aliases[0]===positiveHostSystemdSharedAlias && aliases[1]===positiveHostSystemdSharedPath);
  return Object.freeze({path:positiveHostSystemdSharedPath,sha256:positiveHostSystemdSharedSha,tuple,aliases:Object.freeze(aliases)});
}
/** Closed finite DATA, never an original source grant. */
export function fullPositiveHostLibcData(value:unknown) {
  const row=fullData(value,["path","sha256","libcTuple","libcAliases"]);
  check(row.path===h1LibcPath && row.sha256===positiveHostLibcSha);
  const libcTuple=fullH1LibcMetadataData(row.libcTuple),libcAliases=fullDataArray(row.libcAliases);
  check(libcTuple.mode===String(0o100755) && libcAliases[0]===positiveHostLibcAlias && libcAliases[1]===h1LibcPath);
  return Object.freeze({path:h1LibcPath,sha256:positiveHostLibcSha,libcTuple,libcAliases:Object.freeze(libcAliases)});
}
/** Original acquire uses this same closed selection/consumption parser. */
export function fullHostToolsData(review:Record<string,unknown>) {
  const libcSelected=hasPositiveHostLibc(review.hostTools),sharedSelected=hasPositiveHostSystemdShared(review.hostTools),exceptional=libcSelected||sharedSelected;
  const stagedInline=Object.hasOwn(review,"h1StagedSubject"),stagedReference=Object.hasOwn(review,"h1StagedSubjectSha256");check(!(stagedInline && stagedReference));
  const stagedH1=review.schemaVersion===1 && review.removalCase===FullRemovalCase.ParentCrashH1 && (stagedInline || stagedReference);
  if(stagedH1){check(review.restoreConsumer===undefined || review.restoreConsumer===FullRestoreConsumer.Ordinary);
    if(stagedReference)check(digest(review.h1StagedSubjectSha256));
    else {const subject=h1StagedSubjectData(review.h1StagedSubject);check(subject.sourceSha===review.sourceSha && subject.machineId===review.machineId && subject.bootId===review.bootId);}}
  if(exceptional && !stagedH1){check(review.schemaVersion===2 && review.removalCase===FullRemovalCase.Positive && review.restoreConsumer===FullRestoreConsumer.Ordinary);fullPositiveAccountData(review.accountName);}
  if(stagedH1)check(libcSelected && sharedSelected);
  const tools=fullData(review.hostTools,["git","systemctl","systemdRun","lsns","systemdPid1","bootstrapNode","systemdNspawn","systemdNspawnClosure",...(Object.hasOwn(review.hostTools as object,"namespaceSetupQueryClosure")?["namespaceSetupQueryClosure"]:[]),...(review.removalCase===FullRemovalCase.ParentCrashH1 && !stagedH1?["h1PythonClosure","h1NsenterClosure"]:[]),...(libcSelected?["positiveHostLibc"]:[]),...(sharedSelected?["positiveHostSystemdShared"]:[])]);
  const positive=libcSelected?fullPositiveHostLibcData(tools.positiveHostLibc):undefined,shared=sharedSelected?fullPositiveHostSystemdSharedData(tools.positiveHostSystemdShared):undefined;
  if(positive||shared){
    const input=tools.systemdNspawnClosure;check(Array.isArray(input) && !types.isProxy(input) && Object.getPrototypeOf(input)===Array.prototype);
    const descriptors:Record<string,PropertyDescriptor>=Object.getOwnPropertyDescriptors(input),length=descriptors.length;
    check(length && Object.hasOwn(length,"value") && Number.isInteger(length.value) && length.value>0 && length.value<=32 && Reflect.ownKeys(descriptors).length===length.value+1);
    const rows:{path:string;sha256:string}[]=[];let previous="",consumed=0,sharedConsumed=0;
    for(let i=0;i<length.value;i++){
      const cell=descriptors[String(i)];check(cell && Object.hasOwn(cell,"value") && cell.enumerable);
      const row=fullData(cell.value,["path","sha256"]);check(typeof row.path==="string" && /^\/usr\/lib\/[A-Za-z0-9_.+/-]+$/.test(row.path) && !row.path.split("/").some(part=>part==="." || part==="..") && row.path>previous);
      previous=row.path;const sha256=requireDigest(row.sha256);
      if(positive && row.path===h1LibcPath){check(sha256===positive.sha256);consumed++;}
      if(shared && row.path===positiveHostSystemdSharedPath){check(sha256===shared.sha256);sharedConsumed++;}
      rows.push(Object.freeze({path:row.path,sha256}));
    }
    check(consumed===(positive?1:0) && sharedConsumed===(shared?1:0));tools.systemdNspawnClosure=Object.freeze(rows);
    if(positive)tools.positiveHostLibc=positive;if(shared)tools.positiveHostSystemdShared=shared;
  }
  return tools;
}
enum LibcPurpose {H1="h1",PositiveHost="positive_host",PositiveHostSystemdShared="positive_host_systemd_shared"}
/** Stable snapshot DATA only. Namespace-local mount IDs stay in original
 * custody validation; they are not cross-namespace object identities. */
/** The selected source contracts have one exact reviewed package each. */
export function fullNativeSourcePackageHash(schemaVersion:unknown):string {
  if(schemaVersion===1)return "68a91f14118d7b4dc06b02dad1835bc1db19760e5329faff1f4805cbd1508b29";
  if(schemaVersion===2)return "b30781b69ddf73bf53eb3bb02b073aeba00f4404bd796d485365dbc7dbe872ab";
  return refuse();
}
export function fullPositiveHostStableAncestors(ancestors:readonly Readonly<{path:string;identity:string;mount:string}>[]):readonly Readonly<{path:string;identity:string}>[] {
  return ancestors.map(({path,identity})=>({path,identity}));
}
type HeldHostDso={purpose:LibcPurpose;ancestors:readonly {path:string;fd:number;identity:string;mount:string}[];fd:number;parent:number;expected:ReturnType<typeof fullH1LibcMetadataData>;sha256:string;mount:string;aliases:readonly {path:string;parent:number}[]};
/** One original custodian, with two finite Positive HOST object slots. Ordinary Pins remains nlink===1. */
class H1LibcPins {
  private held:HeldHostDso|undefined;private sharedHeld:HeldHostDso|undefined;
  private metadata(fd:number){const stat=fstatSync(fd,{bigint:true});check(stat.isFile());return {dev:String(stat.dev),ino:String(stat.ino),uid:String(stat.uid),gid:String(stat.gid),mode:String(stat.mode),nlink:String(stat.nlink),size:String(stat.size),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)};}
  hold(pins:Pins,path:string,expectedInput:unknown,expectedSha:string,aliasesInput:unknown):number {
    check(path===h1LibcPath && digest(expectedSha));return this.acquire(pins,LibcPurpose.H1,h1LibcPath,fullH1LibcMetadataData(expectedInput),expectedSha,fullH1LibcAliasesData(aliasesInput));
  }
  holdPositive(pins:Pins,input:unknown):number {
    const row=fullPositiveHostLibcData(input);return this.acquire(pins,LibcPurpose.PositiveHost,h1LibcPath,row.libcTuple,row.sha256,row.libcAliases);
  }
  holdPositiveSystemdShared(pins:Pins,input:unknown):number {
    const row=fullPositiveHostSystemdSharedData(input);return this.acquire(pins,LibcPurpose.PositiveHostSystemdShared,positiveHostSystemdSharedPath,row.tuple,row.sha256,row.aliases);
  }
  private acquire(pins:Pins,purpose:LibcPurpose,path:string,expected:ReturnType<typeof fullH1LibcMetadataData>,expectedSha:string,aliasPaths:readonly [string,string]):number {
    const shared=purpose===LibcPurpose.PositiveHostSystemdShared;check(path===(shared?positiveHostSystemdSharedPath:h1LibcPath));
    check(purpose!==LibcPurpose.H1 || !this.sharedHeld);check(!shared || this.held?.purpose!==LibcPurpose.H1);
    const aliases=aliasPaths.map(path=>({path,parent:pins.hold(dirname(path),true)})),held=shared?this.sharedHeld:this.held;
    if(held){check(purpose===held.purpose && JSON.stringify(expected)===JSON.stringify(held.expected) && expectedSha===held.sha256 && JSON.stringify(aliasPaths)===JSON.stringify(held.aliases.map(entry=>entry.path)));this.validate();return held.fd;}
    const ancestors:{path:string;fd:number;identity:string;mount:string}[]=[];
    if(purpose!==LibcPurpose.H1){
      const paths=new Set<string>();for(const alias of aliasPaths){let path=dirname(alias);for(;;){paths.add(path);if(path==="/")break;path=dirname(path);}}
      const root=pins.hold("/",true),rootDev=fstatSync(root).dev,rootMount=ancestorMountId(root);
      for(const path of [...paths].sort()){const fd=pins.hold(path,true),stat=fstatSync(fd),mount=ancestorMountId(fd);check(stat.dev===rootDev && mount===rootMount);ancestors.push({path,fd,identity:identity(stat),mount});}
    }
    const parent=pins.hold(dirname(path),true),fd=openSync(`/proc/self/fd/${parent}/${basename(path)}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{fullH1LibcMetadataMatches(this.metadata(fd),expected);check(hash(readFd(fd))===expectedSha);const entry={purpose,ancestors,fd,parent,expected,sha256:expectedSha,mount:ancestorMountId(fd),aliases};if(shared)this.sharedHeld=entry;else this.held=entry;this.validate();return fd;}catch(error){if(shared)this.sharedHeld=undefined;else this.held=undefined;closeSync(fd);throw error;}
  }
  validate(){for(const entry of [this.held,this.sharedHeld])if(entry)this.validateEntry(entry);}
  private validateEntry(entry:HeldHostDso){
    for(const ancestor of entry.ancestors){check(identity(fstatSync(ancestor.fd))===ancestor.identity && ancestorMountId(ancestor.fd)===ancestor.mount && entry.mount===ancestor.mount && fstatSync(ancestor.fd).dev===fstatSync(entry.fd).dev);}
    fullH1LibcMetadataMatches(this.metadata(entry.fd),entry.expected);check(hash(readFd(entry.fd))===entry.sha256 && ancestorMountId(entry.fd)===entry.mount);
    for(const alias of entry.aliases){const fresh=openSync(`/proc/self/fd/${alias.parent}/${basename(alias.path)}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{fullH1LibcMetadataMatches(this.metadata(fresh),entry.expected);check(ancestorMountId(fresh)===entry.mount && hash(readFd(fresh))===entry.sha256);fullH1LibcMetadataMatches(this.metadata(entry.fd),entry.expected);}finally{closeSync(fresh);}}
  }
  descriptors(){return [this.held,this.sharedHeld].flatMap(entry=>entry?[entry.fd]:[]);}
  snapshot(){this.validate();const entry=this.held;if(!entry)return null;
    const record={path:h1LibcPath,expected:entry.expected,sha256:entry.sha256,aliases:entry.aliases.map(entry=>entry.path)};
    return entry.purpose===LibcPurpose.H1?record:{...record,role:LibcPurpose.PositiveHost,ancestors:fullPositiveHostStableAncestors(entry.ancestors)};
  }
  sharedSnapshot(){const entry=this.sharedHeld;if(!entry)return null;this.validate();return {path:positiveHostSystemdSharedPath,expected:entry.expected,sha256:entry.sha256,aliases:entry.aliases.map(alias=>alias.path),role:LibcPurpose.PositiveHostSystemdShared,ancestors:fullPositiveHostStableAncestors(entry.ancestors)};}
  close(){if(this.sharedHeld){closeSync(this.sharedHeld.fd);this.sharedHeld=undefined;}if(this.held){closeSync(this.held.fd);this.held=undefined;}}
}
/** A catalog is independently reviewed PUBLIC installation data, not path input.
 * It excludes protected control/auth/credentials before any leaf read. */
export function fullPublicRelative(value:unknown):value is string {
  return typeof value==="string" && value.length<=240 && (value==="src/worker-codex/hosted-full-backing-proc.js" || /^(?:dist|node_modules|packages|scripts|host-integration)\/[A-Za-z0-9_@+./-]+$/.test(value))
    && !value.split("/").some(p=>p==="." || p===".." || /^(?:auth\.json(?:[.-].*)?|credentials?\.json(?:[.-].*)?|.*\.pem|\.env.*)$/i.test(p))
    && /\.(?:js|mjs|cjs|json|node)$/.test(value);
}
function acquire(context:RootContext=RootContext.Launcher){
  initialRoot(context);const installing=context===RootContext.Installer;
  const selectedReview=installing?positiveInstallationReview:reviewPath,selectedReviewRoot=dirname(selectedReview);
  const pins=new Pins(),h1LibcPins=new H1LibcPins();
  let h1Catalog:ReturnType<typeof retainH1StagedCatalogData>|undefined,h1Subject:H1StagedSubject|undefined;
  try{
    pins.hold(sharedAncestor,true);pins.hold(selectedReviewRoot,true,0o700);
    const r=fullReviewData(pins.json(selectedReview,32768));
    if(installing)check(r.schemaVersion===2);
    check((r.schemaVersion===1 || r.schemaVersion===2) && r.sourceBaseSha===sourceBase && sha(r.sourceSha) && sha(r.sourceTree));
    check(typeof r.machineId==="string" && /^[a-f0-9]{32}$/.test(r.machineId) && typeof r.bootId==="string" && /^[a-f0-9-]{36}$/.test(r.bootId));
    check(r.accountName===(r.schemaVersion===2?fullPositiveAccountData(r.accountName):"account-u") && typeof r.reviewReference==="string" && /^[A-Za-z0-9][A-Za-z0-9_.:/#-]{0,255}$/.test(r.reviewReference));
    for(const key of ["nodeSha256","launcherSha256","moduleSha256","parentSha256","catalogSha256","outerReviewSha256","publicReviewSha256"])check(digest(r[key]));
    check(typeof r.systemdVersion==="string" && /^systemd 255 \(255\.4[A-Za-z0-9.+~-]{0,64}\)$/.test(r.systemdVersion));
    const restoreConsumer=fullNativeRestoreConsumer(r.restoreConsumer),removalCase=fullNativeRemovalCase(r.removalCase);
    check(removalCase!==FullRemovalCase.ParentCrashH1 || restoreConsumer===FullRestoreConsumer.Ordinary);
    if(removalCase===FullRemovalCase.ParentCrashH1){
      // The independent subject selects one retained physical catalog, never
      // a namespace or process grant. Constructor authority stays original-only.
      if(Object.hasOwn(r,"h1StagedSubject") || Object.hasOwn(r,"h1StagedSubjectSha256")){
        // The measured complete physical catalog exceeds the inline review
        // cap. One fixed separately pinned DATA file preserves all rows;
        // neither this reference nor its contents grants effect qualification.
        let subjectData:unknown=r.h1StagedSubject;
        if(Object.hasOwn(r,"h1StagedSubjectSha256")){
          const subjectPath=selectedReviewRoot+"/h1-staged-subject.json";
          pins.publicFile(subjectPath,requireDigest(r.h1StagedSubjectSha256));
          subjectData=pins.json(subjectPath,512*1024);
        }
        const staged=h1StagedSubjectData(subjectData);
        check(staged.sourceSha===r.sourceSha && staged.machineId===r.machineId && staged.bootId===r.bootId);
        // One physical .js delivery, shared by installed .mjs and source .js;
        // no unverified alias or second private-authority module instance.
        pins.publicFile(integration+"/managed-launcher/dependency-full-h1-staged-tools-TEST.js",staged.validatorSha256);
        pins.publicFile(fullNativeInputBase+"/"+staged.sourceSha+"/source/host-integration/managed-launcher/dependency-full-h1-staged-tools-TEST.js",staged.validatorSha256);
        h1Subject=staged;
        h1Catalog=retainH1StagedCatalogData(fullNativeInputBase+"/"+staged.sourceSha+"/h1-tool-root-r1",staged,performance.now()+fullNativeLimits.runtimeSeconds*1000);
        pins.validate();h1Catalog.revalidate();
      }
      if(!h1Subject)requireSupportedH1SourceClosure();
    }
    const sourceSha=r.sourceSha,root=(installing?positiveInstallationStage+"/input":fullNativeInputBase)+"/"+sourceSha,source=root+"/source",node=root+"/toolchain/bin/node";
    pins.hold("/srv/workers/jobs/"+fullNativeJob,true,0o700);
    pins.hold(fullNativeTmpDir,true,0o700);
    pins.hold(installing?positiveInstallationStage+"/input":fullNativeInputBase,true,0o700);
    pins.hold(root,true,0o700);
    const modules=fullData(r.installedModules,["manager","contract","endpoint","storagePolicy","profiles","payloadGuard","hostedHostPolicy"]);
    for(const [path,key] of [["host-jobs/manager.mjs","manager"],["host-jobs/contract.mjs","contract"],["host-jobs/endpoint.mjs","endpoint"],["host-jobs/storage-policy.mjs","storagePolicy"],["managed-launcher/profiles.mjs","profiles"],["managed-launcher/payload-guard.mjs","payloadGuard"],["managed-launcher/hosted-host-policy.mjs","hostedHostPolicy"]] as const)pins.publicFile((installing?source+"/host-integration":integration)+"/"+path,requireDigest(modules[key]));
    const tools=fullHostToolsData(r);
    for(const [path,key] of [["/usr/bin/git","git"],["/usr/bin/systemctl","systemctl"],[managedSystemdRunExecutable,"systemdRun"],["/usr/bin/lsns","lsns"],["/usr/lib/systemd/systemd","systemdPid1"],[bootstrapNode,"bootstrapNode"]] as const)pins.publicFile(path,requireDigest(tools[key]));
    // HOST execution uses the HOST loader/DSOs. Guest signed package hashes
    // cannot prove this separately selected original installation closure.
    const monitorSources:{path:string;sha256:string;fd:number}[]=[];
    monitorSources.push({path:"/usr/bin/systemd-nspawn",sha256:requireDigest(tools.systemdNspawn),
      fd:pins.publicFile("/usr/bin/systemd-nspawn",requireDigest(tools.systemdNspawn))});
    check(Array.isArray(tools.systemdNspawnClosure) && tools.systemdNspawnClosure.length>0 && tools.systemdNspawnClosure.length<=32);
    let previousMonitorSource="";
    for(const entry of tools.systemdNspawnClosure){
      const row=fullData(entry,["path","sha256"]);
      check(typeof row.path==="string" && /^\/usr\/lib\/[A-Za-z0-9_.+/-]+$/.test(row.path) &&
        !row.path.split("/").some(part=>part==="." || part==="..") && row.path>previousMonitorSource);
      previousMonitorSource=row.path;const expected=requireDigest(row.sha256);
      monitorSources.push({path:row.path,sha256:expected,fd:row.path===h1LibcPath && tools.positiveHostLibc!==undefined?h1LibcPins.holdPositive(pins,tools.positiveHostLibc):row.path===positiveHostSystemdSharedPath && tools.positiveHostSystemdShared!==undefined?h1LibcPins.holdPositiveSystemdShared(pins,tools.positiveHostSystemdShared):pins.publicFile(row.path,expected)});
    }
    const h1Tools=new Map<string,FullH1Tool>();
    if(removalCase===FullRemovalCase.ParentCrashH1 && !h1Subject){
      for(const [executable,key] of [["/usr/bin/python3.12","h1PythonClosure"],["/usr/bin/nsenter","h1NsenterClosure"]] as const){
        const expected=tools[key];check(Array.isArray(expected) && expected.length>1 && expected.length<=64);
        const closure:{path:string;fd:number}[]=[];let prior="";let executableFd:number|undefined;
        for(const entry of expected){check(entry && typeof entry==="object" && !types.isProxy(entry));const exceptional=Object.hasOwn(entry,"libcTuple");const row=fullData(entry,["path","sha256",...(exceptional?["libcTuple","libcAliases"]:[])]);
          check(typeof row.path==="string" && (row.path===executable || /^\/usr\/lib\/[A-Za-z0-9_.+/-]+$/.test(row.path)) && !row.path.split("/").some(part=>part==="." || part==="..") && row.path>prior);
          prior=row.path;const fd=exceptional?h1LibcPins.hold(pins,row.path,row.libcTuple,requireDigest(row.sha256),row.libcAliases):pins.publicFile(row.path,requireDigest(row.sha256));
          const bytes=readFd(fd);check(bytes.length>=64 && bytes.subarray(0,4).equals(Buffer.from([127,69,76,70])) && bytes[4]===2 && bytes[5]===1 && bytes.readUInt16LE(18)===62);
          if(row.path===executable){check((fstatSync(fd).mode&0o111)!==0);executableFd=fd;}else closure.push(Object.freeze({path:row.path,fd}));
        }
        check(executableFd!==undefined && closure.length>0);h1Tools.set(executable,Object.freeze({executable,executableFd,closure:Object.freeze(closure)}));
      }
    }
    check(tools.bootstrapNode==="7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c" && tools.lsns==="c9fe8adcfe480c47a052adcde50002c78e8fadd4d124bc337893a0f9a9e8cf3b" && tools.systemdPid1==="b472aadf808bef87c0eb203056a77cb64bd268b71b756306013a53de68a94173");
    const systemdVersion=spawnSync("/usr/bin/systemctl",["--version"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:4096});
    check(!systemdVersion.error && systemdVersion.status===0 && systemdVersion.signal===null && systemdVersion.stdout.split("\n")[0]===r.systemdVersion);
    pins.publicFile(node,requireDigest(r.nodeSha256));pins.hold(node,false,0o755);pins.publicFile((installing?source+"/host-integration":integration)+"/managed-launcher/launch.mjs",requireDigest(r.launcherSha256));
    if(!installing)pins.publicFile(integration+"/managed-launcher/dependency-full-native-TEST.mjs",requireDigest(r.moduleSha256));
    pins.publicFile(source+"/host-integration/managed-launcher/dependency-full-native-TEST.js",requireDigest(r.moduleSha256));
    const parent=source+"/host-integration/managed-launcher/dependency-full-native-parent-TEST.js";pins.publicFile(parent,requireDigest(r.parentSha256));
    // The staged H1 route consumes this exact current source package. The
    // legacy HOST schema1 contract retains its earlier package commitment.
    pins.publicFile(source+"/package.json",fullNativeSourcePackageHash(h1Subject?2:r.schemaVersion));
    const head=pins.hold(source+"/.git/HEAD");check(readFd(head).equals(Buffer.from(sourceSha+"\n")));
    const catalogPath=selectedReviewRoot+"/public-installation.json";pins.publicFile(catalogPath,requireDigest(r.catalogSha256));
    const catalog=fullData(pins.json(catalogPath,2*1024*1024),["schemaVersion","sourceSha","sourceTree","files"]);
    check(catalog.schemaVersion===1 && catalog.sourceSha===sourceSha && catalog.sourceTree===r.sourceTree && Array.isArray(catalog.files) && catalog.files.length>0 && catalog.files.length<=8192);
    // Complete public runtime closure: unknown regular runtime leaves and all
    // links are refused by metadata before any catalogue body is opened.
    const expected=new Set<string>();let directories=0,leaves=0;
    function census(path:string,relative:string){
      check(++directories<=16384);const fd=pins.hold(path,true);
      const names=readdirSync(`/proc/self/fd/${fd}`);check(names.length<=8192);
      for(const name of names){check(/^[A-Za-z0-9_@+.-]+$/.test(name));const child=path+"/"+name,rel=relative+"/"+name,stat=lstatSync(child);check(!stat.isSymbolicLink());
        if(stat.isDirectory())census(child,rel);else{check(stat.isFile() && ++leaves<=65536);if(/\.(?:js|mjs|cjs|json|node)$/.test(name)){check(fullPublicRelative(rel));expected.add(rel);check(expected.size<=8192);}}
      }
    }
    for(const top of ["dist","node_modules","packages","scripts","host-integration"])census(source+"/"+top,top);
    // One emitted external import, not a blanket src tree permission.
    const procModule="src/worker-codex/hosted-full-backing-proc.js";
    const procModuleStat=lstatSync(source+"/"+procModule);
    check(procModuleStat.isFile() && !procModuleStat.isSymbolicLink());expected.add(procModule);
    check(catalog.files.length===expected.size);
    let previous="",total=0;const paths=new Set<string>();
    for(const entry of catalog.files){const row=fullData(entry,["path","sha256"]);check(fullPublicRelative(row.path) && digest(row.sha256) && row.path>previous && expected.has(row.path));previous=row.path;
      const fd=pins.publicFile(source+"/"+row.path,row.sha256);total+=fstatSync(fd).size;check(total<=512*1024*1024);paths.add(row.path);}
    // ALL fixed copied and imported leaves derive from the authenticated catalog.
    for(const [candidate,target] of fullPositiveTestCohort){
      const relative=candidate;check(paths.has(relative));
      const row=fullData(catalog.files.find((entry:unknown)=>fullData(entry,["path","sha256"]).path===relative),["path","sha256"]);
      pins.publicFile(source+"/"+relative,requireDigest(row.sha256));
      if(!installing)pins.publicFile(integration+"/"+target,requireDigest(row.sha256));
    }
    if(r.schemaVersion===2)for(const relative of ["host-integration/managed-launcher/dependency-full-h1-staged-tools-TEST.js","host-integration/managed-launcher/dependency-full-positive-copy-TEST.js"]){check(paths.has(relative));const row=fullData(catalog.files.find((entry:unknown)=>{const data=fullData(entry,["path","sha256"]);return data.path===relative;}),["path","sha256"]);if(!installing)pins.publicFile(integration+"/managed-launcher/"+basename(relative),requireDigest(row.sha256));}
    for(const path of ["scripts/dependency-retention-os-test/current-full-outer.js","scripts/dependency-retention-os-test/current-full-guest.js","dist/worker-codex/codex-goal-cli.js"])check(paths.has(path));
    for(const [installedPath,key] of [["/run/TEST-full-outer-review/input.json","outerReviewSha256"],["/run/TEST-real-codex-public-review/input.json","publicReviewSha256"]] as const){const path=installing?positiveInstallationStage+(key==="outerReviewSha256"?"/outer-review/input.json":"/public-review/input.json"):installedPath;pins.hold(dirname(path),true,0o700);pins.publicFile(path,requireDigest(r[key]));pins.hold(path,false,0o600);
      if(r.schemaVersion===2 && key==="outerReviewSha256")fullPositiveOuterReviewData(pins.json(path,4096),fullPositiveAccountData(r.accountName),sourceSha,requireDigest(r.nodeSha256));}

    pins.hold("/srv/worker-state/account-pools/live-codex-auth/"+r.accountName,true);
    pins.hold("/srv/workers/jobs/"+fullNativeJob,true,0o700);pins.hold("/srv/workers/jobs/"+fullNativeJob+"/tmp",true,0o700);pins.hold(fullNativeOsBase,true,0o700);
    const git=spawnSync("/usr/bin/git",["-C",source,"rev-parse","--verify","HEAD^{tree}"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"},encoding:"utf8",timeout:5000,maxBuffer:4096});
    check(!git.error && git.status===0 && git.signal===null && git.stdout.trim()===r.sourceTree);
    const tuple=Object.freeze({sourceSha,source,root,node,parent,machineId:r.machineId,bootId:r.bootId,accountName:r.accountName,restoreConsumer,removalCase,review:r});
    const namespace=readlinkSync("/proc/self/ns/mnt"),namespaceFd=pins.mountNamespace();
    if(context===RootContext.Parent)check(namespace!==readlinkSync("/proc/1/ns/mnt"));
    const validate=()=>{initialRoot(context);check(readlinkSync("/proc/self/ns/mnt")===namespace && readlinkSync(`/proc/self/fd/${namespaceFd}`)===namespace);pins.validate();h1LibcPins.validate();h1Catalog?.revalidate();check(readFileSync("/etc/machine-id","utf8").trim()===tuple.machineId && readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()===tuple.bootId);};
    validate();return {pins,tuple,validate,monitorSources,h1Tools,h1LibcPins,h1Catalog,h1Subject};
  }catch{h1Catalog?.close();h1LibcPins.close();pins.close();refuse();}
}
/** One no-argument ROOT TEST composition operation. Never submits a job.
 * Inputs are fixed root-owned public staging; current unknown prefixes refuse.
 * Source/native/host proof completes before the first materialization effect. */
export async function installFullPositiveTestAndComposeRequest(){
  check(process.argv.length===2 && process.argv[0]===bootstrapNode && process.execPath===bootstrapNode && readlinkSync("/proc/self/exe")===bootstrapNode && process.argv[1]===positiveInstallationStage+"/input/"+process.env.TEST_SOURCE_SHA+"/source/host-integration/managed-launcher/dependency-full-positive-install-TEST.js");
  check(Object.keys(process.env).every(key=>["PATH","LANG","LC_ALL","TEST_SOURCE_SHA"].includes(key)) && process.env.PATH==="/usr/bin:/bin" && process.env.LANG==="C" && process.env.LC_ALL==="C");
  const c=acquire(RootContext.Installer);const retained:number[]=[];
  try{
    check(c.tuple.sourceSha===process.env.TEST_SOURCE_SHA && import.meta.url===pathToFileURL(c.tuple.source+"/host-integration/managed-launcher/dependency-full-native-TEST.js").href && readFileSync("/proc/self/cmdline").equals(Buffer.from([...process.argv,""].join("\u0000"))));
    const originalExe=openSync("/proc/self/exe",constants.O_RDONLY);retained.push(originalExe);const actualExe=fstatSync(originalExe),selectedExe=fstatSync(c.pins.hold(bootstrapNode));check(actualExe.dev===selectedExe.dev && actualExe.ino===selectedExe.ino);
    recordAbsent();
    const unit=spawnSync("/usr/bin/systemctl",["show",fullNativeUnit,"--property=LoadState","--value"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:256});
    check(!unit.error && (unit.status===0 || unit.status===4) && unit.signal===null && unit.stdout.trim()==="not-found");
    const destination=fullNativeInputBase+"/"+c.tuple.sourceSha;
    const absent=(path:string)=>{try{lstatSync(path);refuse();}catch(error){check(error instanceof Error && "code" in error && error.code==="ENOENT");}};
    for(const path of [destination,reviewRoot,fullNativeBirthRoot,fullNativeLiveRoot,fullNativePublicDownloadBase,dirname(fullNativePublicCapsule),"/run/TEST-full-outer-review","/run/TEST-real-codex-public-review",integration+"/managed-launcher/dependency-full-native-TEST.mjs",integration+"/managed-launcher/dependency-full-h1-staged-tools-TEST.js",integration+"/managed-launcher/dependency-full-positive-copy-TEST.js",integration])absent(path);
    const targetParents=[fullNativeInputBase,dirname(reviewRoot),"/run","/opt"].map(path=>c.pins.hold(path,true));
    const deadline=performance.now()+120000;let count=0,total=0;
    type Copy=FullPositiveCopyRow;
    function snapshot(path:string,name:string):Copy {
      check(performance.now()<deadline && ++count<=100000);const stat=lstatSync(path);check(!stat.isSymbolicLink() && stat.uid===0 && stat.gid===0 && !(stat.mode&0o022));
      const directory=stat.isDirectory();check(directory || (stat.isFile() && stat.nlink===1 && stat.size<=128*1024*1024));
      const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(directory?constants.O_DIRECTORY:0));retained.push(fd);check(identity(fstatSync(fd))===identity(stat));
      if(!directory){total+=stat.size;check(total<=1024*1024*1024);}
      const children=directory?readdirSync(`/proc/self/fd/${fd}`).sort().map(child=>{check(/^[A-Za-z0-9_@+.-]+$/.test(child) && child!=="." && child!==".." && !/^(?:auth\.json(?:[.-].*)?|credentials?\.json(?:[.-].*)?|.*\.pem|\.env.*)$/i.test(child));return snapshot(path+"/"+child,child);}):null;
      return {sourceFd:fd,sourceIdentity:identity(stat),name,mode:stat.mode&0o777,children};
    }
    const tree=snapshot(c.tuple.root,c.tuple.sourceSha);
    function cohortDirectory(path:string,name:string,children:readonly Copy[]):Copy {
      check(performance.now()<deadline && ++count<=100000);const stat=lstatSync(path);
      check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid===0 && stat.gid===0 && !(stat.mode&0o022));
      const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);retained.push(fd);check(identity(fstatSync(fd))===identity(stat));
      return {sourceFd:fd,sourceIdentity:identity(stat),name,mode:0o755,children};
    }
    const directories=["host-jobs","managed-launcher"].map(name=>cohortDirectory(c.tuple.source+"/host-integration/"+name,name,
      fullPositiveTestCohort.filter(([,target])=>target.startsWith(name+"/")).map(([candidate,target])=>snapshot(c.tuple.source+"/"+candidate,basename(target)))));
    const cohort=cohortDirectory(c.tuple.source+"/host-integration",basename(integration),directories);
    const catalog=snapshot(positiveInstallationStage+"/public-installation.json","public-installation.json");
    const outer=snapshot(positiveInstallationStage+"/outer-review","TEST-full-outer-review"),publicReview=snapshot(positiveInstallationStage+"/public-review","TEST-real-codex-public-review");
    c.validate();recordAbsent();for(const row of [tree,cohort,catalog,outer,publicReview])check(identity(fstatSync(row.sourceFd))===row.sourceIdentity);
    // Only this explicit installer operation loads the copier, from the exact
    // staged source already retained and catalog-joined by acquire(). Schema1
    // launcher/parent admission keeps its original runtime import closure.
    const copyModule=await import(pathToFileURL(c.tuple.source+"/host-integration/managed-launcher/dependency-full-positive-copy-TEST.js").href);
    check(typeof copyModule.copyFullPositiveInstallationRow==="function");c.validate();
    const copy=(row:Copy,parent:number)=>copyModule.copyFullPositiveInstallationRow(row,parent,deadline);
    c.pins.prepareOutputRoot();
    copy(tree,targetParents[0]!);copy(cohort,targetParents[3]!);copy(outer,targetParents[2]!);copy(publicReview,targetParents[2]!);
    mkdirSync(`/proc/self/fd/${targetParents[1]}/dependency-full-positive-scoped-activation`,{mode:0o700});fsyncSync(targetParents[1]!);
    const reviewDir=openSync(reviewRoot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);retained.push(reviewDir);copy(catalog,reviewDir);
    // Publish the same strict protected FULL review only after complete
    // original source/tool/native proof; historical ancestry guards stay exact.
    c.validate();const bytes=Buffer.from(JSON.stringify(c.tuple.review)+"\n");
    const fd=openSync(`/proc/self/fd/${reviewDir}/review.json`,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}fsyncSync(reviewDir);
    // Import the delivered original module; request DATA is produced only by
    // its complete normal acquire path, never assembled here by the installer.
    const installed=await import(pathToFileURL(integration+"/managed-launcher/dependency-full-native-TEST.mjs").href);
    check(typeof installed.fullManagedStartRequest==="function");const request:unknown=installed.fullManagedStartRequest();
    c.validate();return request;
  }finally{for(const fd of retained.reverse())closeSync(fd);c.h1Catalog?.close();c.h1LibcPins.close();c.pins.close();}
}
function fullSourceSnapshot(c:ReturnType<typeof acquire>):string{const ordinary=c.pins.sourceSnapshot(),libc=c.h1LibcPins.snapshot(),shared=c.h1LibcPins.sharedSnapshot();
  if(shared){check(libc===null || "role" in libc);return hash(JSON.stringify(libc?{ordinary,positiveHostLibc:libc,positiveHostSystemdShared:shared}:{ordinary,positiveHostSystemdShared:shared}));}
  return libc===null?ordinary:hash(JSON.stringify("role" in libc?{ordinary,positiveHostLibc:libc}:{ordinary,h1Libc:libc}));}
function fingerprint(machine:string,argv:readonly string[]){return hash(JSON.stringify([fullNativeJob,machine,argv,1800,180,2048,128,100]));}
function argvFor(c:ReturnType<typeof acquire>){return fullNativeParentArgv(c.tuple.node,c.tuple.parent,c.tuple.removalCase);}
function record(c:ReturnType<typeof acquire>,live:boolean){
  // Acknowledgement legitimately replaces this leaf. Each read retains fresh FD
  // and joins protected ancestry; never pin stale Starting inode as live proof.
  const fresh=new Pins();
  try{fresh.hold(dirname(ledger),true,0o700);const fd=fresh.hold(ledger,false,0o600);check(fstatSync(fd).size<=4096);
    const value:unknown=JSON.parse(readFd(fd).toString("utf8"));const r=fullData(value,["jobId","unit","manager","machineId","fingerprint","phase","createdAt"]);
    check(r.jobId===fullNativeJob && r.unit===fullNativeUnit && r.manager==="system" && r.machineId===c.tuple.machineId && r.fingerprint===fingerprint(c.tuple.machineId,argvFor(c)));
    check(r.phase===FullParentPhase.Starting || (live && r.phase===FullParentPhase.Started));check(typeof r.createdAt==="number" && Number.isSafeInteger(r.createdAt) && r.createdAt>0);fresh.validate();return r;
  }finally{fresh.close();}
}
/** ParentStartedHeld DATA: independently repeats original live unit/birth/source joins. */
export function readFullPositiveStartedHeld(){const c=acquire(),birthPins=new Pins();let anchor:number|undefined;
  try{
    const current=record(c,true);check(current.phase===FullParentPhase.Started);
    const before=birthPins.hold(fullNativeBirthRoot+"/before.json",false,0o600),after=birthPins.hold(fullNativeBirthRoot+"/after.json",false,0o600);
    const b=fullData(JSON.parse(readFd(before).toString("utf8")),["schemaVersion","sourceSha","fingerprint","producerPid","producerStartTicks","machineId","bootId","sourceSnapshotSha256"]);
    const a=fullData(JSON.parse(readFd(after).toString("utf8")),["schemaVersion","beforeSha256","unit","invocationId","pid","startTicks","sourceSnapshotSha256"]);
    check(b.schemaVersion===1 && b.sourceSha===c.tuple.sourceSha && b.fingerprint===current.fingerprint && b.machineId===c.tuple.machineId && b.bootId===c.tuple.bootId && b.sourceSnapshotSha256===fullSourceSnapshot(c));
    check(a.schemaVersion===1 && a.beforeSha256===hash(readFd(before)) && a.unit===fullNativeUnit && a.sourceSnapshotSha256===fullSourceSnapshot(c));
    const fields=["InvocationID","MainPID","ControlGroup","Description","ActiveState"];
    const unit=()=>{const r=spawnSync("/usr/bin/systemctl",["show",fullNativeUnit,"--property="+fields.join(",")],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:4096});check(!r.error && r.status===0 && r.signal===null);return parseNativeUnitProperties(r.stdout,fields);};
    const u=unit();check(u.InvocationID===a.invocationId && u.MainPID===String(a.pid) && u.ControlGroup===fullNativeControlGroup && u.Description==="subscription-job:"+current.fingerprint && ["active","activating"].includes(u.ActiveState??""));
    const path="/proc/"+u.MainPID;anchor=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);check(retainedFilesystemType(anchor)===0x9fa0n);const id=identity(fstatSync(anchor)),mnt=ancestorMountId(anchor),held=`/proc/self/fd/${anchor}`;
    const selectedMount=readlinkSync(held+"/ns/mnt");check(/^mnt:\[[1-9][0-9]*\]$/.test(selectedMount) && selectedMount!==readlinkSync("/proc/1/ns/mnt"));
    const executable=fstatSync(c.pins.hold(c.tuple.node));
    const processJoin=()=>{
      const stat=readFileSync(held+"/stat","utf8"),end=stat.lastIndexOf(") "),parts=stat.slice(end+2).trim().split(/\s+/);
      check(end>0 && stat.startsWith(u.MainPID+" (") && parts[19]===a.startTicks && !["Z","X","x"].includes(parts[0]??""));
      check(readlinkSync(held+"/exe")===c.tuple.node && readFileSync(held+"/cmdline").equals(Buffer.from([...argvFor(c),""].join("\0"))));checkH1OwnedCgroupData(readFileSync(held+"/cgroup","utf8"),fullNativeControlGroup);
      check(readlinkSync(held+"/ns/user")==="user:[4026531837]" && readlinkSync(held+"/ns/pid")==="pid:[4026531836]" && readlinkSync(held+"/ns/mnt")===selectedMount);
      const fd=openSync(held+"/exe",constants.O_RDONLY);try{const actual=fstatSync(fd);check(actual.dev===executable.dev && actual.ino===executable.ino);}finally{closeSync(fd);}
    };
    processJoin();c.validate();birthPins.validate();check(JSON.stringify(unit())===JSON.stringify(u));
    const fresh=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{check(identity(fstatSync(fresh))===id && ancestorMountId(fresh)===mnt && identity(fstatSync(anchor))===id && readlinkSync(`/proc/self/fd/${fresh}/ns/mnt`)===selectedMount);}finally{closeSync(fresh);}processJoin();
    return Object.freeze({status:"STARTED_HELD",completion:"UNPROVEN",jobId:fullNativeJob,unit:fullNativeUnit,invocationId:a.invocationId,pid:a.pid,startTicks:a.startTicks,sourceSha:c.tuple.sourceSha,beforeSha256:hash(readFd(before)),afterSha256:hash(readFd(after))});
  }finally{if(anchor!==undefined)closeSync(anchor);birthPins.close();c.h1Catalog?.close();c.h1LibcPins.close();c.pins.close();}
}
export function fullManagedStartRequest(){const c=acquire();try{recordAbsent();return Object.freeze({operation:FullOperation.Start,jobId:fullNativeJob,machineId:c.tuple.machineId,argv:argvFor(c),...fullNativeLimits});}finally{c.h1Catalog?.close();c.h1LibcPins.close();c.pins.close();}}
function recordAbsent(){try{lstatSync(ledger);refuse();}catch(e){if(!(e instanceof Error && "code" in e && e.code==="ENOENT"))refuse();}}
/** Public DATA snapshot, never original admission or launch permission. */
export function captureFullNativeRequest(value:unknown){
  const r=fullData(value,["operation","unit","payload","jobId","fingerprint","limits"]);
  const limits=fullData(r.limits,Object.keys(fullNativeLimits)),payload=fullNativePayload(r.payload);
  check(r.operation===FullOperation.Job && r.jobId===fullNativeJob && r.unit===fullNativeUnit && digest(r.fingerprint));
  for(const key of Object.keys(fullNativeLimits) as (keyof typeof fullNativeLimits)[])check(limits[key]===fullNativeLimits[key]);
  return Object.freeze({fingerprint:r.fingerprint,payload});
}
export function retainFullNativeLaunch(request:unknown){
  const data=captureFullNativeRequest(request),c=acquire();let closed=false,prepared=false,published=false,beforeBytes:Buffer|undefined;
  try{
    check(process.argv.length===4 && process.argv[0]===bootstrapNode && process.argv[1]===fullPositiveTestEntry && process.argv[2]==="job");
    check(readlinkSync("/proc/self/exe")===bootstrapNode && readFileSync("/proc/self/cmdline").equals(Buffer.from([...process.argv,""].join("\u0000"))));
    check(JSON.stringify(JSON.parse(process.argv[3]!))===JSON.stringify(request));
    check(data.fingerprint===fingerprint(c.tuple.machineId,argvFor(c)) && JSON.stringify(data.payload)===JSON.stringify(argvFor(c)));
    const revalidate=()=>{try{check(!closed);c.validate();record(c,false);preflightCapacity(c.pins.hold(fullNativeOsBase,true,0o700));c.validate();}catch{refuse();}};revalidate();
    function writeBirth(name:"before.json"|"after.json",value:unknown){
      const directory=c.pins.hold(fullNativeBirthRoot,true,0o700),bytes=Buffer.from(JSON.stringify(value)+"\n");
      const fd=openSync(`/proc/self/fd/${directory}/${name}`,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}fsyncSync(directory);return bytes;
    }
    return Object.freeze({node:c.tuple.node,parent:c.tuple.parent,source:c.tuple.source,sourceSha:c.tuple.sourceSha,accountName:c.tuple.accountName,restoreConsumer:c.tuple.restoreConsumer,removalCase:c.tuple.removalCase,fingerprint:data.fingerprint,revalidate,
      beforeSubmit(){
        revalidate();check(!prepared);const shown=spawnSync("/usr/bin/systemctl",["show",fullNativeUnit,"--property=LoadState","--value"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:256});
        check(!shown.error && (shown.status===0 || shown.status===4) && shown.signal===null && shown.stdout.trim()==="not-found");
        const job=c.pins.hold("/srv/workers/jobs/"+fullNativeJob,true,0o700);
        mkdirSync(`/proc/self/fd/${job}/full-launch-birth`,{mode:0o700});fsyncSync(job);
        const raw=readFileSync("/proc/self/stat","utf8"),end=raw.lastIndexOf(") "),ticks=raw.slice(end+2).trim().split(/\s+/)[19];check(end>0 && /^[1-9][0-9]*$/.test(ticks??""));
        beforeBytes=writeBirth("before.json",{schemaVersion:1,sourceSha:c.tuple.sourceSha,fingerprint:data.fingerprint,producerPid:process.pid,producerStartTicks:ticks,machineId:c.tuple.machineId,bootId:c.tuple.bootId,sourceSnapshotSha256:fullSourceSnapshot(c)});
        prepared=true;revalidate();
      },
      afterSubmit(){
        revalidate();check(prepared && !published && beforeBytes);
        const fields="InvocationID,MainPID,ControlGroup,Description,LoadState,ActiveState";
        function unit(){
          const result=spawnSync("/usr/bin/systemctl",["show",fullNativeUnit,"--property="+fields],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:4096});
          check(!result.error && result.status===0 && result.signal===null);const values:Record<string,string>={};
          for(const line of result.stdout.trimEnd().split("\n")){const at=line.indexOf("=");check(at>0 && !Object.hasOwn(values,line.slice(0,at)));values[line.slice(0,at)]=line.slice(at+1);}
          check(Object.keys(values).sort().join(",")==="ActiveState,ControlGroup,Description,InvocationID,LoadState,MainPID");
          check(values.LoadState==="loaded" && ["active","activating"].includes(values.ActiveState??"") && /^[a-f0-9]{32}$/.test(values.InvocationID??"") && /^[1-9][0-9]*$/.test(values.MainPID??""));
          check(values.Description==="subscription-job:"+data.fingerprint && values.ControlGroup===fullNativeControlGroup);return values;
        }
        const values=unit(),prefix="/proc/"+values.MainPID,anchor=openSync(prefix,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW),anchorIdentity=identity(fstatSync(anchor));
        try{
          check(retainedFilesystemType(anchor)===0x9fa0n);
          const held=`/proc/self/fd/${anchor}`;
          const raw=readFileSync(held+"/stat","utf8"),end=raw.lastIndexOf(") "),parts=raw.slice(end+2).trim().split(/\s+/),ticks=parts[19];
          check(end>0 && raw.startsWith(values.MainPID+" (") && !["Z","X","x"].includes(parts[0]??"") && /^[1-9][0-9]*$/.test(ticks??""));
          check(readlinkSync(held+"/exe")===c.tuple.node && readFileSync(held+"/cmdline").equals(Buffer.from([...argvFor(c),""].join("\u0000"))));
          checkH1OwnedCgroupData(readFileSync(held+"/cgroup","utf8"),fullNativeControlGroup);
          check(readlinkSync(held+"/ns/user")==="user:[4026531837]" && readlinkSync(held+"/ns/pid")==="pid:[4026531836]");
          const mount=readlinkSync(held+"/ns/mnt");check(/^mnt:\[[1-9][0-9]*\]$/.test(mount) && mount!==readlinkSync("/proc/1/ns/mnt"));
          const executable=fstatSync(c.pins.hold(c.tuple.node)),exeFd=openSync(held+"/exe",constants.O_RDONLY);
          try{const actual=fstatSync(exeFd);check(actual.dev===executable.dev && actual.ino===executable.ino);}finally{closeSync(exeFd);}
          const fresh=openSync(prefix,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
          try{
            check(identity(fstatSync(fresh))===anchorIdentity && identity(fstatSync(anchor))===anchorIdentity && ancestorMountId(fresh)===ancestorMountId(anchor));
            const now=readFileSync(`/proc/self/fd/${fresh}/stat`,"utf8"),at=now.lastIndexOf(") "),fields=now.slice(at+2).trim().split(/\s+/);
            check(now.startsWith(values.MainPID+" (") && fields[19]===ticks && !["Z","X","x"].includes(fields[0]??""));
            check(readlinkSync(`/proc/self/fd/${fresh}/ns/mnt`)===mount);
          }finally{closeSync(fresh);}
          revalidate();check(hash(readFileSync(fullNativeBirthRoot+"/before.json"))===hash(beforeBytes));
          check(JSON.stringify(unit())===JSON.stringify(values));
          const after=readFileSync(held+"/stat","utf8"),at=after.lastIndexOf(") "),finalFields=after.slice(at+2).trim().split(/\s+/);check(finalFields[19]===ticks && !["Z","X","x"].includes(finalFields[0]??""));
          // Publication is last, after every source/kernel/unit join passed.
          writeBirth("after.json",{schemaVersion:1,beforeSha256:hash(beforeBytes),unit:fullNativeUnit,invocationId:values.InvocationID,pid:Number(values.MainPID),startTicks:ticks,sourceSnapshotSha256:fullSourceSnapshot(c)});
          published=true;
        }finally{closeSync(anchor);}
      },close(){if(closed)return;closed=true;c.h1Catalog?.close();c.h1LibcPins.close();c.pins.close();}});
  }catch{c.h1Catalog?.close();c.h1LibcPins.close();c.pins.close();refuse();}
}
/** Only the one fixed H1 flag may extend the ordinary two-cell payload. */
function fullNativePayload(value:unknown):readonly string[] {
  if(Array.isArray(value) && !types.isProxy(value) && value.length===2)return Object.freeze(fullDataArray(value));
  check(value!==null && typeof value==="object" && !types.isProxy(value) && Array.isArray(value) && Object.getPrototypeOf(value)===Array.prototype);
  const object:object=value;const d=Object.getOwnPropertyDescriptors(object);check(Reflect.ownKeys(d).sort().join(",")==="0,1,2,length");
  for(const key of ["0","1","2","length"])check(d[key] && Object.hasOwn(d[key],"value"));
  check(d.length?.value===3 && typeof d["0"]?.value==="string" && typeof d["1"]?.value==="string" && d["2"]?.value==="--parent-crash-h1");
  return Object.freeze([d["0"].value,d["1"].value,"--parent-crash-h1"]);
}
/** Two primitive command cells, copied from own descriptors with no getters. */
export function fullDataArray(value:unknown):readonly [string,string]{
  check(value!==null && typeof value==="object" && !types.isProxy(value) && Array.isArray(value) && Object.getPrototypeOf(value)===Array.prototype);
  const object:object=value;const d=Object.getOwnPropertyDescriptors(object);check(Reflect.ownKeys(d).sort().join(",")==="0,1,length");
  for(const key of ["0","1","length"]){const v=d[key];check(v && Object.hasOwn(v,"value"));}
  check(d.length?.value===2 && typeof d["0"]?.value==="string" && typeof d["1"]?.value==="string");return [d["0"].value,d["1"].value];
}
const erasedEnvironment=["NODE_OPTIONS","NODE_PATH","LD_PRELOAD","LD_LIBRARY_PATH","LD_AUDIT","LD_PROFILE","OPENAI_API_KEY","ANTHROPIC_API_KEY","CODEX_HOME"].join(" ");
const parentCapabilities="CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_FSETID CAP_KILL CAP_SETGID CAP_SETUID CAP_SETPCAP CAP_SYS_CHROOT CAP_SYS_PTRACE CAP_SYS_ADMIN CAP_MKNOD CAP_AUDIT_WRITE CAP_SETFCAP";
const fullMonitorCapabilities=parentCapabilities;
export function fullNativeArguments(request:unknown){
  const custody=retainFullNativeLaunch(request);try{
    const toolchain=fullNativeInputBase+"/"+custody.sourceSha+"/toolchain",
      selector=custody.restoreConsumer===FullRestoreConsumer.Readonly ? ["--setenv=TEST_FULL_RESTORE_CONSUMER="+custody.restoreConsumer] : [];
    const properties=["Slice=subscription-runtime-hosted.slice","KillMode=control-group","SendSIGKILL=yes","Delegate=no","Restart=no","RemainAfterExit=no","ProtectSystem=strict","NoNewPrivileges=yes","MemorySwapMax=0","LimitCORE=0","LimitNOFILE=65536","AmbientCapabilities=","PassEnvironment=","UnsetEnvironment="+erasedEnvironment,"CapabilityBoundingSet="+parentCapabilities,
      "CPUQuota=100%","CPUQuotaPeriodSec=100ms","MemoryMax=2G","TasksMax=128","RuntimeMaxSec=1800","TimeoutStopSec=180","StandardOutput=null","StandardError=null",
      "ReadWritePaths="+fullNativeOsBase+" "+fullNativeOutputBase+" /run/systemd/system /srv/workers/jobs/"+fullNativeJob,
      "BindReadOnlyPaths="+custody.source+":"+custody.source+":norbind",
      "BindReadOnlyPaths="+toolchain+":"+toolchain+":norbind","BindReadOnlyPaths=/run/TEST-full-outer-review:/run/TEST-full-outer-review:norbind","BindReadOnlyPaths=/run/TEST-real-codex-public-review:/run/TEST-real-codex-public-review:norbind","BindReadOnlyPaths="+reviewRoot+":"+reviewRoot+":norbind","BindReadOnlyPaths=/srv/worker-state/account-pools/live-codex-auth/"+custody.accountName+":/srv/worker-state/account-pools/live-codex-auth/"+custody.accountName+":norbind"];
    const args=Object.freeze(["--description=subscription-job:"+custody.fingerprint,"--unit="+fullNativeUnit,"--working-directory="+custody.source,"--service-type=exec","--expand-environment=no","--setenv=SUBSCRIPTION_RUNTIME_HOST_JOB_ID="+fullNativeJob,"--setenv=TEST_SOURCE_SHA="+custody.sourceSha,...selector,"--setenv=HOME=/srv/workers/jobs/"+fullNativeJob,"--setenv=TMPDIR=/srv/workers/jobs/"+fullNativeJob+"/tmp","--setenv=PATH=/usr/bin:/bin","--setenv=LANG=C.UTF-8",...properties.map(p=>"--property="+p),"--",...fullNativeParentArgv(custody.node,custody.parent,custody.removalCase)]);
    custody.revalidate();return {args,custody};
  }catch{custody.close();refuse();}
}
export type FullH1Tool=Readonly<{executable:"/usr/bin/python3.12"|"/usr/bin/nsenter";executableFd:number;closure:readonly Readonly<{path:string;fd:number}>[]}>;
const h1ToolReaders=new WeakMap<object,<T>(executable:FullH1Tool["executable"],callback:(tool:FullH1Tool)=>T)=>T>();
/** Private original verified closure, synchronous lifetime only; no path enrollment. */
export function withOriginalH1PythonTool<T>(parent:object,callback:(tool:FullH1Tool & {executable:"/usr/bin/python3.12"})=>T):T {
  requireSupportedH1SourceClosure();
  check(fullParents.has(parent));const reader=h1ToolReaders.get(parent);check(reader);
  return reader("/usr/bin/python3.12",tool=>{check(tool.executable==="/usr/bin/python3.12");return callback({...tool,executable:"/usr/bin/python3.12"});});
}
export function withOriginalH1NamespaceTool<T>(parent:object,callback:(tool:FullH1Tool & {executable:"/usr/bin/nsenter"})=>T):T {
  requireSupportedH1SourceClosure();
  check(fullParents.has(parent));const reader=h1ToolReaders.get(parent);check(reader);
  return reader("/usr/bin/nsenter",tool=>{check(tool.executable==="/usr/bin/nsenter");return callback({...tool,executable:"/usr/bin/nsenter"});});
}
const fullParents=new WeakMap<object,()=>void>();
export interface FullH1StagedObserver {
  readonly child:ChildProcess;
  readonly stdout:PassThrough;
  readonly stderr:PassThrough;
  readonly closed:Promise<void>;
}
/** Consumer-owned source port only. Structural types confer no original custody. */
export interface FullH1StagedObserverSource {
  prepareOriginalH1StagedObserver(parent:FullParentSession):H1StagedObserverPrepared;
}
const fullH1StagedConstructors=new WeakMap<object,()=>Promise<FullH1StagedObserver>>();
const fullH1StagedClosers=new WeakMap<object,()=>Promise<void>>();
/** Only the retained original parent selects its source-pinned finite factory.
 * There is deliberately no caller path, argv, PID, FD or callback parameter. */
export function constructOriginalH1StagedObserver(parent:object):Promise<FullH1StagedObserver>{
  assertRetainedCurrentFullParent(parent);const construct=fullH1StagedConstructors.get(parent);check(construct);return construct();
}
export async function closeOriginalH1StagedObserver(parent:object):Promise<void>{
  assertRetainedCurrentFullParent(parent);const close=fullH1StagedClosers.get(parent);check(close);await close();assertRetainedCurrentFullParent(parent);
}
export enum FullH1PrearmPhase { Constructing="constructing", ActorCaptured="actor_captured", Constructed="constructed", QueryReleased="query_released", QueryComplete="query_complete", QualificationGuard="qualification_guard", Held="held", CloseStarted="close_started", Closed="closed", CloseHeld="close_held" }
export enum FullH1ObservationState { Unobserved="unobserved", Complete="complete", Incomplete="incomplete" }
export enum FullH1PhysicalClass { File="file", Directory="directory", Pipe="pipe", Socket="socket", Character="character", Block="block", Fanotify="fanotify", Pidfd="pidfd", Unknown="unknown" }
export enum FullH1SourceJoin { Monitor="monitor", Staged="staged", Guest="guest", Unknown="unknown" }
export enum FullH1DescriptorJoin { Stdio="stdio", Source="source", Retained="retained", QueryPipe="query_pipe", WorkerPipe="worker_pipe", Kernel="kernel", Unknown="unknown" }
type FullH1ObjectFact=Readonly<{dev:string;ino:string;mode:string;uid:string}>;
type FullH1TableFact<T>=Readonly<{state:FullH1ObservationState;rows:readonly T[]}>;
type FullH1PrearmActorFact=Readonly<{role:H1StagedActorRole;pid:number;birth:string;proc:FullH1ObjectFact;exe:FullH1ObjectFact;root:FullH1ObjectFact;mount:FullH1ObjectFact;exeSource:FullH1SourceJoin;
  namespaces:Readonly<{mnt:string|null;pid:string|null;user:string|null;cgroup:string|null}>;joined:boolean;sourceObjects:readonly Readonly<{dev:string;ino:string;source:FullH1SourceJoin}>[];
  mounts:FullH1TableFact<Readonly<{id:string;parent:string;device:string;rowSha256:string;rootSha256:string;targetSha256:string}>>;
  maps:FullH1TableFact<Readonly<{start:string;end:string;permissions:string;offset:string;dev:string;ino:string;source:FullH1SourceJoin;unknownVeto:boolean}>>;
  descriptors:FullH1TableFact<Readonly<{fd:number;object:FullH1ObjectFact;physicalClass:FullH1PhysicalClass;source:FullH1SourceJoin;join:FullH1DescriptorJoin;unknownVeto:boolean}>>;
  tasks:FullH1TableFact<Readonly<{tid:number;tgid:number;birth:string}>>}>;
export type FullH1PrearmSnapshot=Readonly<{schemaVersion:1;purpose:"TEST_actual_H1_prearm_facts_only";qualified:false;sourceComplete:false;state:H1StagedSlotState;
  phases:readonly FullH1PrearmPhase[];actors:readonly FullH1PrearmActorFact[];observationIncomplete:boolean;
  query:Readonly<{sourceSeen:boolean;systemctlSourceSeen:boolean;complete:boolean;held:boolean;effectAccepted:boolean}>;
  close:Readonly<{started:boolean;state:FullH1ObservationState;absence:readonly Readonly<{role:H1StagedActorRole;pid:number;birth:string;absent:boolean}>[];descendants:readonly Readonly<{pid:number;birth:string;absent:boolean}>[];descriptorsClosed:boolean}>}>;
const fullH1PrearmReaders=new WeakMap<object,()=>FullH1PrearmSnapshot>();
/** Retained original-parent brand only. Frozen DATA survives owned close;
 * this reader accepts no paths/callbacks and cannot construct or open a gate. */
export function readOriginalH1PrearmSnapshot(parent:object):FullH1PrearmSnapshot{
  const read=fullH1PrearmReaders.get(parent);check(read);return read();
}
type H1ActualActor=Readonly<{role:H1StagedActorRole;pid:number;birth:string;anchor:number;identity:string;exe:number;mount:number;root:number;command:Buffer;stdio:readonly Readonly<{dev:bigint;ino:bigint;mode:bigint;uid:bigint}>[]}>;
export type FullH1StagedTaskFact=Readonly<{role:H1StagedActorRole;pid:number;birth:string;mountNamespace:string;
  descriptors:readonly Readonly<{fd:number;dev:string;ino:string}>[];sources:readonly Readonly<{dev:string;ino:string}>[]}>;
const fullH1StagedReaders=new WeakMap<object,(task:FullMonitorTaskAnchor)=>FullH1StagedTaskFact|undefined>();
export function readOriginalH1StagedTask(parent:object,task:FullMonitorTaskAnchor):FullH1StagedTaskFact|undefined{
  assertRetainedCurrentFullParent(parent);const read=fullH1StagedReaders.get(parent);check(read);return read(task);
}

/** The original parent's private once-only slot. Expected manifest mount IDs
 * and synthetic boot ID remain DATA; only fresh proc objects enter this slot. */
function originalH1StagedSlot(c:ReturnType<typeof acquire>,parent:FullParentSession,selectedGuest:()=>string|undefined,originalDeadline:()=>bigint){
  let state=H1StagedSlotState.Unconstructed,prepared:H1StagedObserverPrepared|undefined,child:ChildProcess|undefined;
  let done:Promise<void>|undefined,worker:H1ActualActor|undefined,query:H1ActualActor|undefined;
  let querySourceSeen=false,systemctlSourceSeen=false,queryComplete=false,effectAccepted=false,queryFailure:unknown;
  let requestPid:number|undefined,guestSupervisorPid:string|undefined;
  let guestSources:readonly Readonly<{dev:bigint;ino:bigint}>[]=[];
  let parentDead=false;const queryPipes:Readonly<{dev:bigint;ino:bigint;mode:bigint}>[]=[];
  let closePromise:Promise<void>|undefined,closing=false;
  let lifetimeDeadline:number|undefined,absoluteDeadline:bigint|undefined,loadFacts:ReturnType<typeof retainH1ConstructorLoadFacts>|undefined;
  let expectedWorkerCommand:Buffer|undefined;let bootstrapRoutes=false,fixtureRoutes=false;let notifyObject:Readonly<{dev:bigint;ino:bigint}>|undefined;const setupBirths=new Map<number,H1ActualActor>();const actualMountTables=new Map<string,string>();
  const parentStatus=readFileSync("/proc/self/status","utf8");const parentCaps=["Inh","Prm","Eff","Bnd","Amb"].map(key=>{const value=new RegExp("^Cap"+key+":\\s+([0-9a-f]{16})$","m").exec(parentStatus)?.[1];check(value);return value;});
  function remaining(){check(absoluteDeadline!==undefined);if(process.hrtime.bigint()>=absoluteDeadline-180000000000n)h1HeldError(H1ConstructorHeld.Deadline);}
  function rejoinDeadline(){remaining();check(originalDeadline()===absoluteDeadline);remaining();}
  const validatePrepared=()=>{if(parentDead)prepared?.revalidateSources();else prepared?.revalidate();};
  const actors:H1ActualActor[]=[],owned:number[]=[],stdout=new PassThrough(),stderr=new PassThrough();
  const phases:FullH1PrearmPhase[]=[],actorFacts:FullH1PrearmActorFact[]=[];
  let observationIncomplete=false,closeState=FullH1ObservationState.Unobserved,descriptorsClosed=false;
  const absence:{role:H1StagedActorRole;pid:number;birth:string;absent:boolean}[]=[],descendantAbsence:{pid:number;birth:string;absent:boolean}[]=[];
  const phase=(value:FullH1PrearmPhase)=>{if(phases.length<16)phases.push(value);else observationIncomplete=true;};
  const objectFact=(stat:Readonly<{dev:bigint;ino:bigint;mode:bigint;uid:bigint}>):FullH1ObjectFact=>Object.freeze({dev:String(stat.dev),ino:String(stat.ino),mode:String(stat.mode),uid:String(stat.uid)});
  // Independent factual reads never supply admission or extend the original
  // deadline. Raw cmdline, filenames, mount paths and auth are not exported.
  function observeActor(actor:H1ActualActor){
    if(actorFacts.length>=8){observationIncomplete=true;return;}
    const base=`/proc/self/fd/${actor.anchor}`;
    const tick=()=>check(lifetimeDeadline!==undefined && performance.now()<lifetimeDeadline && !closing);
    const bytes=(suffix:string,limit:number)=>{tick();const fd=openSync(base+suffix,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{const buffer=Buffer.alloc(limit+1);let size=0,count=0;while((count=readSync(fd,buffer,size,buffer.length-size,null))>0){size+=count;check(size<=limit);tick();}return buffer.subarray(0,size).toString("utf8");}finally{closeSync(fd);}};
    const table=<T>(read:()=>T[]):FullH1TableFact<T>=>{try{return Object.freeze({state:FullH1ObservationState.Complete,rows:Object.freeze(read())});}catch{observationIncomplete=true;return Object.freeze({state:FullH1ObservationState.Incomplete,rows:Object.freeze([] as T[])});}};
    try{
      tick();const proc=objectFact(fstatSync(actor.anchor,{bigint:true})),exe=objectFact(fstatSync(actor.exe,{bigint:true})),root=objectFact(fstatSync(actor.root,{bigint:true})),mount=objectFact(fstatSync(actor.mount,{bigint:true}));
      const monitor=c.monitorSources.map(row=>fstatSync(row.fd,{bigint:true})),staged=(c.h1Catalog?.descriptors()??[]).map(fd=>fstatSync(fd,{bigint:true}));
      const same=(a:Readonly<{dev:bigint;ino:bigint}>,b:Readonly<{dev:bigint;ino:bigint}>)=>a.dev===b.dev && a.ino===b.ino;
      const sourceObjects:Readonly<{dev:string;ino:string;source:FullH1SourceJoin}>[]=[];
      const source=(dev:bigint,ino:bigint):FullH1SourceJoin=>{const actual={dev,ino};const join=(actor.role===H1StagedActorRole.Monitor || actor.role===H1StagedActorRole.Setup) && monitor.some(row=>same(actual,row))?FullH1SourceJoin.Monitor:actor.role!==H1StagedActorRole.Monitor && actor.role!==H1StagedActorRole.Setup && actor.role!==H1StagedActorRole.Systemctl && staged.some(row=>row.isFile() && same(actual,row))?FullH1SourceJoin.Staged:actor.role===H1StagedActorRole.Systemctl && guestSources.some(row=>same(actual,row))?FullH1SourceJoin.Guest:FullH1SourceJoin.Unknown;if(join!==FullH1SourceJoin.Unknown && !sourceObjects.some(row=>row.dev===String(dev) && row.ino===String(ino))){if(sourceObjects.length<64)sourceObjects.push(Object.freeze({dev:String(dev),ino:String(ino),source:join}));else observationIncomplete=true;}return join;};
      const namespace=(name:string)=>{try{tick();const value=readlinkSync(base+"/ns/"+name);check(new RegExp("^"+name+":\\[[1-9][0-9]*\\]$").test(value));return value;}catch{observationIncomplete=true;return null;}};
      const namespaces=Object.freeze({mnt:namespace("mnt"),pid:namespace("pid"),user:namespace("user"),cgroup:namespace("cgroup")});
      const mounts=table(()=>{const raw=bytes("/mountinfo",256*1024),lines=raw.trimEnd().split("\n");check(raw.endsWith("\n") && lines.length<=128);
        const rows=lines.map(line=>{check(Buffer.byteLength(line)<=fullMountLineBytes);const cells=line.split(" "),at=cells.indexOf("-");check(at>=6 && cells.length===at+4 && /^[1-9][0-9]*$/.test(cells[0]??"") && /^[1-9][0-9]*$/.test(cells[1]??"") && /^[0-9]+:[0-9]+$/.test(cells[2]??""));
          return Object.freeze({id:cells[0]!,parent:cells[1]!,device:cells[2]!,rowSha256:hash(line),rootSha256:hash(cells[3]!),targetSha256:hash(cells[4]!)});});check(bytes("/mountinfo",256*1024)===raw);return rows;});
      const maps=table(()=>{const raw=bytes("/maps",1024*1024),lines=raw.trimEnd().split("\n");check(lines.length<=256);
        const rows=lines.map(line=>{const cells=/^([0-9a-f]+)-([0-9a-f]+)\s+([rwxps-]{4})\s+([0-9a-f]+)\s+([0-9a-f]+):([0-9a-f]+)\s+([0-9]+)(?:\s+.*)?$/.exec(line);check(cells);
          const major=BigInt("0x"+cells[5]),minor=BigInt("0x"+cells[6]),dev=(minor&255n)|(major<<8n)|((minor&~255n)<<12n),join=source(dev,BigInt(cells[7]!));
          return Object.freeze({start:cells[1]!,end:cells[2]!,permissions:cells[3]!,offset:cells[4]!,dev:String(dev),ino:cells[7]!,source:join,unknownVeto:cells[7]!=="0" && join===FullH1SourceJoin.Unknown});});check(bytes("/maps",1024*1024)===raw);return rows;});
      const descriptors=table(()=>{tick();const names=readdirSync(base+"/fd").sort((a,b)=>Number(a)-Number(b));check(names.length<=64 && names.every(name=>/^(0|[1-9][0-9]*)$/.test(name)));
        const retained=[...owned,...(prepared?.descriptors()??[])].map(fd=>fstatSync(fd,{bigint:true}));
        const rows=names.map(name=>{tick();const path=base+"/fd/"+name,stat=statSync(path,{bigint:true}),link=readlinkSync(path),fd=Number(name),sourceJoin=source(stat.dev,stat.ino);
          const physicalClass=link==="anon_inode:[fanotify]"?FullH1PhysicalClass.Fanotify:link==="anon_inode:[pidfd]"?FullH1PhysicalClass.Pidfd:stat.isFile()?FullH1PhysicalClass.File:stat.isDirectory()?FullH1PhysicalClass.Directory:stat.isFIFO()?FullH1PhysicalClass.Pipe:stat.isSocket()?FullH1PhysicalClass.Socket:stat.isCharacterDevice()?FullH1PhysicalClass.Character:stat.isBlockDevice()?FullH1PhysicalClass.Block:FullH1PhysicalClass.Unknown;
          const stdio=fd<3 && !!actor.stdio[fd] && same(actor.stdio[fd]!,stat) && actor.stdio[fd]!.mode===stat.mode && actor.stdio[fd]!.uid===stat.uid;
          const join=stdio?FullH1DescriptorJoin.Stdio:sourceJoin!==FullH1SourceJoin.Unknown?FullH1DescriptorJoin.Source:retained.some(row=>same(row,stat))?FullH1DescriptorJoin.Retained:!effectAccepted && queryPipes.some(row=>same(row,stat) && row.mode===stat.mode)?FullH1DescriptorJoin.QueryPipe:actor.role===H1StagedActorRole.Monitor && worker?.stdio.some(row=>same(row,stat) && row.mode===stat.mode && row.uid===stat.uid)?FullH1DescriptorJoin.WorkerPipe:actor.role===H1StagedActorRole.Worker && (physicalClass===FullH1PhysicalClass.Fanotify || physicalClass===FullH1PhysicalClass.Pidfd)?FullH1DescriptorJoin.Kernel:FullH1DescriptorJoin.Unknown;
          check(same(stat,statSync(path,{bigint:true})) && readlinkSync(path)===link);
          return Object.freeze({fd,object:objectFact(stat),physicalClass,source:sourceJoin,join,unknownVeto:join===FullH1DescriptorJoin.Unknown});});check(JSON.stringify(readdirSync(base+"/fd").sort((a,b)=>Number(a)-Number(b)))===JSON.stringify(names));return rows;});
      const tasks=table(()=>{tick();const names=readdirSync(base+"/task").sort();check(names.length<=32 && names.every(name=>/^[1-9][0-9]*$/.test(name)));
        const rows=names.map(name=>{const status=bytes("/task/"+name+"/status",16384),tid=Number(/^Pid:\s+([1-9][0-9]*)$/m.exec(status)?.[1]),tgid=Number(/^Tgid:\s+([1-9][0-9]*)$/m.exec(status)?.[1]);check(tid===Number(name) && tgid===actor.pid);const birth=actualBirth(base+"/task/"+name,tid).birth;return Object.freeze({tid,tgid,birth});});check(JSON.stringify(readdirSync(base+"/task").sort())===JSON.stringify(names));return rows;});
      let joined=false;try{tick();joined=identity(fstatSync(actor.anchor))===actor.identity && identity(statSync("/proc/"+actor.pid))===actor.identity && actualBirth(base,actor.pid).birth===actor.birth && identity(statSync(base+"/exe"))===identity(fstatSync(actor.exe)) && identity(statSync(base+"/root"))===identity(fstatSync(actor.root)) && identity(statSync(base+"/ns/mnt"))===identity(fstatSync(actor.mount));}catch{observationIncomplete=true;}
      const fact=Object.freeze({role:actor.role,pid:actor.pid,birth:actor.birth,proc,exe,root,mount,exeSource:source(BigInt(exe.dev),BigInt(exe.ino)),namespaces,joined,mounts,maps,descriptors,tasks,sourceObjects:Object.freeze(sourceObjects)});
      if(Buffer.byteLength(JSON.stringify(actorFacts.concat(fact)))<=96*1024)actorFacts.push(fact);else observationIncomplete=true;
    }catch{observationIncomplete=true;}
  }
  const snapshot=():FullH1PrearmSnapshot=>Object.freeze({schemaVersion:1,purpose:"TEST_actual_H1_prearm_facts_only",qualified:false,sourceComplete:false,state,phases:Object.freeze([...phases]),actors:Object.freeze([...actorFacts]),observationIncomplete,
    query:Object.freeze({sourceSeen:querySourceSeen,systemctlSourceSeen,complete:queryComplete,held:queryFailure!==undefined,effectAccepted}),
    close:Object.freeze({started:closing,state:closeState,absence:Object.freeze(absence.map(row=>Object.freeze({...row}))),descendants:Object.freeze(descendantAbsence.map(row=>Object.freeze({...row}))),descriptorsClosed})});
  const actualBirth=(path:string,pid:number)=>{const raw=readFileSync(path+"/stat","utf8"),end=raw.lastIndexOf(") "),cells=raw.slice(end+2).trim().split(/\s+/);
    check(raw.startsWith(pid+" (") && end>0 && !["Z","X","x"].includes(cells[0]??"") && /^[1-9][0-9]*$/.test(cells[19]??""));return {birth:cells[19]!,ppid:Number(cells[1])};};
  const hold=(path:string,directory=false)=>{const fd=openSync(path,constants.O_RDONLY|(directory?constants.O_DIRECTORY:0));owned.push(fd);return fd;};
  function capture(role:H1StagedActorRole,pid:number):H1ActualActor{
    const anchor=hold("/proc/"+pid,true);check(retainedFilesystemType(anchor)===0x9fa0n);
    const base=`/proc/self/fd/${anchor}`,first=actualBirth(base,pid),exe=hold(base+"/exe"),mount=hold(base+"/ns/mnt"),root=hold(base+"/root",true);
    const actor=Object.freeze({role,pid,birth:first.birth,anchor,identity:identity(fstatSync(anchor)),exe,mount,root,command:readFileSync(base+"/cmdline"),stdio:Object.freeze([0,1,2].map(fd=>statSync(base+"/fd/"+fd,{bigint:true})))});
    check(actualBirth(base,pid).birth===first.birth);actors.push(actor);phase(FullH1PrearmPhase.ActorCaptured);return actor;
  }
  function rejoin(actor:H1ActualActor){
    remaining();c.validate();validatePrepared();const base=`/proc/self/fd/${actor.anchor}`;
    check(identity(fstatSync(actor.anchor))===actor.identity && identity(statSync("/proc/"+actor.pid))===actor.identity && actualBirth(base,actor.pid).birth===actor.birth);
    check(readFileSync(base+"/cmdline").equals(actor.command) && identity(statSync(base+"/exe"))===identity(fstatSync(actor.exe)));
    check(identity(statSync(base+"/root"))===identity(fstatSync(actor.root)) && identity(statSync(base+"/ns/mnt"))===identity(fstatSync(actor.mount)));
  }
  function physicalWorker(actor:H1ActualActor){
    check(c.h1Subject && c.h1Catalog && child?.pid);rejoin(actor);const base=`/proc/self/fd/${actor.anchor}`;
    checkH1ActorStatusData(readFileSync(base+"/status","utf8"),actor.pid,parentCaps);
    const parentGroup=readFileSync("/proc/self/cgroup","utf8"),originalMount=readlinkSync("/proc/self/ns/mnt");
    checkH1OwnedCgroupData(parentGroup,fullNativeControlGroup);
    const group=readFileSync(base+"/cgroup","utf8");checkH1OwnedCgroupData(group,fullNativeControlGroup,fullNativeControlGroup+"/payload");check(readlinkSync(base+"/ns/mnt")!==originalMount);
    const monitorGroup=readFileSync("/proc/"+child.pid+"/cgroup","utf8");checkH1OwnedCgroupData(monitorGroup,fullNativeControlGroup,fullNativeControlGroup+"/supervisor");
    for(const name of ["pid","user","cgroup"])check(readlinkSync(base+"/ns/"+name)===readlinkSync("/proc/self/ns/"+name));
    const environment=readFileSync(base+"/environ");checkH1HostReleaseData(environment,c.h1Subject.hostRelease.cells);
    if(environment.toString("utf8").split("\0").includes("NOTIFY_SOCKET=/run/host/notify")){
      const socket=statSync(base+"/root/run/host/notify",{bigint:true});check(socket.isSocket() && socket.uid===0n && socket.gid===0n);
      const monitor=actors.find(row=>row.role===H1StagedActorRole.Monitor);check(monitor);rejoin(monitor);
      const network=readFileSync(`/proc/self/fd/${monitor.anchor}/net/unix`,"utf8");check(Buffer.byteLength(network)<=65536);
      const records=network.trimEnd().split("\n").slice(1).map(line=>line.trim().split(/\s+/)).filter(row=>row.length===8 && row[7]==="/run/host/notify");check(records.length===1 && /^[1-9][0-9]*$/.test(records[0]![6]??""));
      const expected="socket:["+records[0]![6]+"]",names=readdirSync(`/proc/self/fd/${monitor.anchor}/fd`);check(names.length<=64);
      const matches=names.filter(name=>readlinkSync(`/proc/self/fd/${monitor.anchor}/fd/${name}`)===expected);check(matches.length===1);const descriptor=statSync(`/proc/self/fd/${monitor.anchor}/fd/${matches[0]}`,{bigint:true});check(descriptor.isSocket() && descriptor.uid===0n);if(notifyObject)check(notifyObject.dev===descriptor.dev && notifyObject.ino===descriptor.ino);else notifyObject={dev:descriptor.dev,ino:descriptor.ino};
      check(readFileSync(`/proc/self/fd/${monitor.anchor}/net/unix`,"utf8")===network && statSync(base+"/root/run/host/notify",{bigint:true}).ino===socket.ino);rejoin(monitor);
    }
    const rootStat=fstatSync(actor.root,{bigint:true});check(String(rootStat.dev)===c.h1Subject.rootIdentity.dev && String(rootStat.ino)===c.h1Subject.rootIdentity.ino);
    const source=c.h1Subject.catalog.find(row=>row.path==="usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2");check(source?.kind===H1CatalogKind.File);
    const exe=fstatSync(actor.exe,{bigint:true});check(String(exe.dev)===source.identity.dev && String(exe.ino)===source.identity.ino);
    const synthetic=readFileSync(base+"/root/proc/sys/kernel/random/boot_id","utf8").trim();
    check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(synthetic) && synthetic!==c.tuple.bootId);
    // Actual complete mount rows, never equality with another namespace's IDs.
    const mounts=readFileSync(base+"/mountinfo","utf8");check(Buffer.byteLength(mounts)<=fullMountTableBytes);
    const allowed=new Set(["/","/proc","/proc/sys","/proc/sysrq-trigger","/proc/sys/kernel/random/boot_id","/proc/kmsg","/sys","/sys/fs/cgroup","/dev","/dev/pts","/dev/ptmx","/dev/shm","/dev/console","/run","/tmp","/run/host","/run/host/incoming"]);
    const rows=mounts.trimEnd().split("\n");check(rows.length<=fullMountTableRows && mounts.endsWith("\n"));let roots=0;const seen=new Set<string>(),actualIds=new Set<string>();
    for(const row of rows){check(Buffer.byteLength(row)<=fullMountLineBytes);const cells=row.split(" "),at=cells.indexOf("-");check(at>=6 && cells[4] && cells[5]);
      check(/^[1-9][0-9]*$/.test(cells[0]??"") && /^[1-9][0-9]*$/.test(cells[1]??"") && !actualIds.has(cells[0]!));actualIds.add(cells[0]!);
      const path=fullMountPath(cells[4]);check(allowed.has(path) && !seen.has(path));seen.add(path);
      const expected=c.h1Subject.mounts.find(mount=>mount.path===path);check(expected && cells[2] && cells[3] && cells[at+1] && cells[at+2]);
      const object=statSync(base+"/root"+path,{bigint:true}),kind=object.isDirectory()?H1ApiKind.Directory:object.isFile()?H1ApiKind.Regular:object.isCharacterDevice()?H1ApiKind.Character:object.isFIFO()?H1ApiKind.Pipe:object.isSocket()?H1ApiKind.Socket:H1ApiKind.Unknown;
      checkH1ApiObjectData(path,kind,object.uid,object.gid,object.mode);
      const flags=cells[5].split(","),expectedFlags=expected.flags.split(",");check(flags.length===expectedFlags.length && flags.every(flag=>expectedFlags.includes(flag)));
      const sourceToken=cells[at+2];check(sourceToken!==undefined && !/\\(?!040|011|012|134)/.test(sourceToken));
      const sourceLabel=sourceToken.replace(/\\(040|011|012|134)/g,(_,digits:string)=>String.fromCharCode(parseInt(digits,8)));
      check(fullMountPath(cells[3])===expected.mountRoot && cells[at+1]===expected.filesystem && sourceLabel===expected.source);
      const propagation=cells.slice(6,at);check(!propagation.some(value=>value.startsWith("shared:") || value.startsWith("master:")));check((propagation.length===0?"private":propagation.join(" "))===expected.propagation);
      // Persisted IDs never enroll future namespaces. Stable backing devices
      // remain exact; generated/kernel devices are observed and retained in
      // this constructor's fresh namespace instead of borrowing old IDs.
      if(expected.origin===H1MountOrigin.Staged || expected.origin===H1MountOrigin.HostData)check(cells[2]===expected.device);
      else check(/^[0-9]+:[0-9]+$/.test(cells[2]));
      if(path==="/"){check(flags.includes("ro"));roots++;}}
    check(roots===1 && seen.size===c.h1Subject.mounts.length && readFileSync(base+"/mountinfo","utf8")===mounts);
    // IDs/device values come only from this retained actor's actual kernel table.
    // Protected recipe IDs never enroll or identify the newly constructed namespace.
    const namespace=readlinkSync(base+"/ns/mnt"),commitment=hash(mounts),priorTable=actualMountTables.get(namespace);
    check(priorTable===undefined || priorTable===commitment);actualMountTables.set(namespace,commitment);
    // nspawn's short-lived setup is admitted only through the actual monitor's
    // causal chain; an announcement PID is never enrollment authority.
    let cursor=actor.pid;const chain=new Set<number>();
    while(cursor!==child.pid){check(chain.size<4 && !chain.has(cursor));chain.add(cursor);const actual=actualBirth("/proc/"+cursor,cursor);cursor=actual.ppid;check(cursor>1);}
    check(actualBirth("/proc/"+child.pid,child.pid).ppid===process.pid);rejoin(actor);
  }
  // Original-only live table read before a causal phase is released. This
  // supplies no admission: the unconditional qualification guard stays below.
  function checkActualActorTables(actor:H1ActualActor){
    check(!closing && lifetimeDeadline!==undefined && performance.now()<lifetimeDeadline);
    rejoin(actor);const base=`/proc/self/fd/${actor.anchor}`;
    const names=readdirSync(base+"/task").sort();
    check(names.length>0 && names.length<=32 && names.every(name=>/^[1-9][0-9]*$/.test(name)));
    for(const name of names){
      const path=base+"/task/"+name,tid=Number(name),birth=actualBirth(path,tid).birth;
      const task=Object.freeze({path,processPid:actor.pid,processBirth:actor.birth,birth,revalidate(){
        check(!closing && lifetimeDeadline!==undefined && performance.now()<lifetimeDeadline);
        rejoin(actor);check(actualBirth(path,tid).birth===birth);
      }});
      check(read(task)!==undefined);
    }
    check(JSON.stringify(readdirSync(base+"/task").sort())===JSON.stringify(names));rejoin(actor);
  }
  function close():Promise<void>{
    if(closePromise)return closePromise;if(state===H1StagedSlotState.Closed)return Promise.resolve();
    closing=true;phase(FullH1PrearmPhase.CloseStarted);closeState=FullH1ObservationState.Incomplete;
    closePromise=(async()=>{
    const descendants=new Map<number,string>();
    function census(pid:number,depth=0){
      check(depth<=4 && descendants.size<=16);const path="/proc/"+pid;let raw:string;
      try{raw=readFileSync(path+"/task/"+pid+"/children","utf8");}catch(error){check(error instanceof Error && "code" in error && (error.code==="ENOENT" || error.code==="ESRCH"));return;}
      check(Buffer.byteLength(raw)<=4096);for(const value of raw.trim().split(/\s+/).filter(Boolean)){check(/^[1-9][0-9]*$/.test(value));const childPid=Number(value),birth=actualBirth("/proc/"+childPid,childPid).birth;check(!descendants.has(childPid));descendants.set(childPid,birth);census(childPid,depth+1);}
    }
    if(child?.pid)census(child.pid);
    child?.stdin?.destroy();if(child && child.exitCode===null && child.signalCode===null){
      const monitor=actors.find(actor=>actor.role===H1StagedActorRole.Monitor);check(monitor && actualBirth(`/proc/self/fd/${monitor.anchor}`,monitor.pid).birth===monitor.birth);child.kill("SIGTERM");}
    if(done){
      const deadline=Math.min(lifetimeDeadline??performance.now()+2000,performance.now()+2000);check(deadline>performance.now());
      await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("TEST H1 staged owned drain timeout Held")),Math.max(1,deadline-performance.now()));done!.then(()=>{clearTimeout(timer);resolve();},error=>{clearTimeout(timer);reject(error);});});
    }
    // Drain is kernel-observed on retained objects, never merely ChildProcess
    // event state. Unknown living descendants prevent closure.
    for(const actor of actors){try{readFileSync(`/proc/self/fd/${actor.anchor}/stat`);refuse();}
      catch(error){check(error instanceof Error && "code" in error && (error.code==="ENOENT" || error.code==="ESRCH"));absence.push({role:actor.role,pid:actor.pid,birth:actor.birth,absent:true});}}
    for(const [pid,birth] of descendants){try{check(actualBirth("/proc/"+pid,pid).birth!==birth);descendantAbsence.push({pid,birth,absent:true});}
      catch(error){check(error instanceof Error && "code" in error && (error.code==="ENOENT" || error.code==="ESRCH"));descendantAbsence.push({pid,birth,absent:true});}}
    loadFacts?.close();prepared?.close();for(const fd of owned.reverse())closeSync(fd);owned.length=0;descriptorsClosed=true;state=H1StagedSlotState.Closed;c.validate();if(absoluteDeadline!==undefined)check(originalDeadline()===absoluteDeadline && process.hrtime.bigint()<absoluteDeadline);closeState=FullH1ObservationState.Complete;phase(FullH1PrearmPhase.Closed);
    })().catch(error=>{phase(FullH1PrearmPhase.CloseHeld);throw error;});return closePromise;
  }
  async function construct():Promise<FullH1StagedObserver>{
    assertRetainedCurrentFullParent(parent);check(!closing && state===H1StagedSlotState.Unconstructed && c.h1Subject && c.h1Catalog && c.tuple.removalCase===FullRemovalCase.ParentCrashH1);
    state=H1StagedSlotState.Constructing;phase(FullH1PrearmPhase.Constructing);
    try{absoluteDeadline=originalDeadline();remaining();lifetimeDeadline=performance.now()+Math.min(32000,Number(absoluteDeadline-process.hrtime.bigint()-180000000000n)/1e6);
      const guest=selectedGuest();check(guest);c.validate();rejoinDeadline();
      const getpath=c.h1Subject.definitions.pythonGetpath;if(typeof getpath!=="string" || !digest(getpath))return h1HeldError(H1ConstructorHeld.Getpath);
      // Same independently issued Source/build commitment; no live Python probes can issue it.
      try{c.pins.publicFile(c.tuple.source+"/scripts/dependency-retention-os-test/current-h1-python-getpath-source.py",getpath);}catch{h1HeldError(H1ConstructorHeld.Getpath);}
      const rootFd=c.h1Catalog.descriptors()[0];check(rootFd!==undefined);const rootStat=fstatSync(rootFd,{bigint:true});check(String(rootStat.dev)===c.h1Subject.rootIdentity.dev && String(rootStat.ino)===c.h1Subject.rootIdentity.ino);
      loadFacts=retainH1ConstructorLoadFacts(c.h1Subject,rootFd,lifetimeDeadline);
      c.pins.publicFile(c.h1Subject.hostRelease.source,c.h1Subject.hostRelease.sha256);
      for(const [definition,pin] of Object.entries(c.h1Subject.definitions)){
        if(definition==="pythonGetpath")continue;
        // Fixed reviewed constructor routines are delivered as exact source inputs.
        try{c.pins.publicFile(c.tuple.source+"/scripts/dependency-retention-os-test/h1-constructor-source-"+definition+".c",pin);}catch{h1HeldError(H1ConstructorHeld.Definition);}
      }


      const module:FullH1StagedObserverSource=await import(pathToFileURL(c.tuple.source+"/scripts/dependency-retention-os-test/current-removal-h1-fixture.js").href);
      prepared=module.prepareOriginalH1StagedObserver(parent);prepared.revalidate();
      check(prepared.anchors.length===9 && prepared.queryAnchors.length===3 && Buffer.byteLength(prepared.program)<=32768 && Buffer.byteLength(prepared.config)<=16384);
      const rawConfig:unknown=JSON.parse(prepared.config),config=fullData(rawConfig,["purpose","request","operations","policy","key","evictionId","ownerPath","parentPid","parentTicks","supervisorPid","supervisorTicks","group","parentArgv","supervisorArgv","pidNamespace","supervisorInvocation","requestPath","requestDigest","backingPath","backingDigest"]);
      const request=fullData(config.request,["schemaVersion","purpose","sourceSha","jobId","revision","parentBirth","bootId","supervisorId","workspace","absent"]),absent=fullData(request.absent,["path","identity","sha256"]);
      check(config.supervisorInvocation===null && typeof request.bootId==="string" && request.sourceSha===c.tuple.sourceSha && typeof absent.path==="string" && typeof request.jobId==="string" && /^TEST-os-[a-f0-9-]{36}$/.test(request.jobId));
      check(absent.path.startsWith("/var/lib/subscription-runtime-host-policy/dependency-transactions/") && !absent.path.split("/").some(part=>part==="." || part===".."));
      const root=fullNativeOsBase+"/"+guest+"/root",pid=Number(config.parentPid),supervisor=Number(config.supervisorPid);
      check(Number.isSafeInteger(pid) && pid>1 && Number.isSafeInteger(supervisor) && supervisor>1);
      requestPid=pid;check(typeof request.supervisorId==="string" && /^[1-9][0-9]*:[1-9][0-9]*$/.test(request.supervisorId));guestSupervisorPid=request.supervisorId.split(":")[0];
      const guestElf=fullData(c.pins.json(root+"/opt/subscription-runtime-dependency-os-TEST/os-signed-elf-pins.json",256*1024),["schemaVersion","pins"]);
      check(guestElf.schemaVersion===1 && Array.isArray(guestElf.pins));
      guestSources=guestElf.pins.map((entry:unknown)=>{const row=fullData(entry,["path","sha256"]);check(typeof row.path==="string" && /^\/usr\/(?:lib|bin)\/[A-Za-z0-9_.+/-]+$/.test(row.path) && !row.path.split("/").includes("..") && digest(row.sha256));
        return fstatSync(c.pins.publicFile(root+row.path,row.sha256),{bigint:true});});
      const paths=[root+"/var/lib/subscription-runtime-host-policy/dependency-transactions",root+"/var/lib/subscription-runtime-host-policy/dependency-owners",root+"/var/lib/subscription-runtime-host-policy",root+"/run/TEST-full-flow-outbox",root+absent.path,"/proc/"+pid,"/proc/"+supervisor,root+"/run/TEST-full-flow-outbox/removal-h1-request.json",fullNativeLiveRoot+"/current-full-backing.json"];
      for(let i=0;i<9;i++){const fd=prepared.anchors[i];check(Number.isSafeInteger(fd) && fd!==undefined && identity(fstatSync(fd))===identity(statSync(paths[i]!)));}
      check(identity(fstatSync(prepared.queryAnchors[2]))===identity(statSync(root)));
      check(readFileSync(`/proc/self/fd/${prepared.queryAnchors[2]}/proc/sys/kernel/random/boot_id`,"utf8").trim()===request.bootId);
      for(const fd of prepared.queryAnchors.slice(0,2))check(retainedFilesystemType(fd)===0x6e736673n);
      const object=(fd:number)=>{const s=fstatSync(fd,{bigint:true});return [String(s.dev),String(s.ino),String(s.mode)];};
      const payload=JSON.stringify({parentPid:process.pid,parentTicks:actualBirth("/proc/self",process.pid).birth,anchors:prepared.anchors,anchorObjects:prepared.anchors.map(object),queryAnchors:prepared.queryAnchors,queryObjects:prepared.queryAnchors.map(object),program:prepared.program,config:prepared.config,bootId:c.tuple.bootId,guestBootId:request.bootId});
      check(Buffer.byteLength(payload)<=65536);
      expectedWorkerCommand=Buffer.from(["/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2","--inhibit-cache","--library-path","/usr/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu/systemd","/usr/bin/python3.12","-I","-S","-B","-X","pycache_prefix="+h1ReadonlyCache,"-c",h1StagedObserverBootstrap,payload,""] .join("\0"));
      prepared.revalidate();c.validate();
      const directory=fullNativeInputBase+"/"+c.tuple.sourceSha+"/h1-tool-root-r1";
      child=spawn("/usr/bin/systemd-nspawn",["--quiet","--directory="+directory,"--read-only","--private-users=no","--settings=no","--register=no","--keep-unit","--share-system","--link-journal=no","--console=pipe","--resolv-conf=off","--timezone=off","--","/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2","--inhibit-cache","--library-path","/usr/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu/systemd","/usr/bin/python3.12","-I","-S","-B","-X","pycache_prefix=/nonexistent/TEST-h1-readonly-pycache","-c",h1StagedObserverBootstrap,payload],{stdio:["pipe","pipe","pipe"],env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",SYSTEMD_NSPAWN_USE_CGNS:"0"}});
      check(child.pid && child.stdin && child.stdout && child.stderr);await new Promise<void>((resolve,reject)=>{child!.once("spawn",resolve);child!.once("error",reject);});const originalMonitor=capture(H1StagedActorRole.Monitor,child.pid);observeActor(originalMonitor);
      check(originalMonitor.command.equals(Buffer.from([...child.spawnargs,""] .join("\0"))));
      const pollSetup=()=>{try{if(closing || worker)return;remaining();rejoin(originalMonitor);
        const values=readFileSync(`/proc/self/fd/${originalMonitor.anchor}/task/${originalMonitor.pid}/children`,"utf8").trim().split(/\s+/).filter(Boolean);check(values.length<=2);
        for(const value of values){check(/^[1-9][0-9]*$/.test(value));const pid=Number(value),birth=actualBirth("/proc/"+pid,pid);check(birth.ppid===originalMonitor.pid);const prior=setupBirths.get(pid);if(prior){
          check(prior.birth===birth.birth && identity(statSync("/proc/"+pid))===prior.identity);
          // A retained setup may exec the independently pinned worker with the
          // same proc/birth. The constructor announcement must capture and join
          // that transition; changed/foreign commands never qualify a setup.
          const current=readFileSync(`/proc/self/fd/${prior.anchor}/cmdline`);
          if(!current.equals(prior.command)){check(expectedWorkerCommand && current.equals(expectedWorkerCommand));continue;}
          rejoin(prior);
        }else{
          const setup=capture(H1StagedActorRole.Setup,pid),exe=fstatSync(setup.exe,{bigint:true});check(c.monitorSources.some(row=>{const source=fstatSync(row.fd,{bigint:true});return source.dev===exe.dev && source.ino===exe.ino;}));
          checkH1OwnedCgroupData(readFileSync(`/proc/self/fd/${setup.anchor}/cgroup`,"utf8"),fullNativeControlGroup);setupBirths.set(pid,setup);observeActor(setup);
        }}
        setImmediate(pollSetup);
      }catch(error){queryFailure=error;child?.stdin?.destroy();child?.kill("SIGTERM");}};setImmediate(pollSetup);
      done=new Promise<void>((resolve,reject)=>{child!.once("close",()=>resolve());child!.once("error",reject);});void done.catch(()=>{});
      child.stdin.on("error",()=>{stderr.write("TEST_H1_staged_gate_HOLD\n");child?.kill("SIGTERM");});
      child.stderr.on("data",(chunk:Buffer)=>stderr.write(chunk));child.stderr.on("end",()=>stderr.end());
      await new Promise<void>((resolve,reject)=>{let pending="";const timer=setTimeout(()=>reject(new Error("TEST H1 staged constructor timeout Held")),2000);
        const receive=(chunk:Buffer)=>{try{pending+=chunk.toString("utf8");check(Buffer.byteLength(pending)<=32768);const newline=pending.indexOf("\n");if(newline<0)return;
          const line=pending.slice(0,newline);if(line.startsWith("python_bootstrap:")){check(!bootstrapRoutes && c.h1Subject);checkH1PythonRouteData(JSON.parse(line.slice(17)),c.h1Subject.catalog);bootstrapRoutes=true;pending=pending.slice(newline+1);if(pending.length)receive(Buffer.alloc(0));return;}check(bootstrapRoutes && queryFailure===undefined && line.startsWith("constructor:"));const announced=fullData(JSON.parse(line.slice(12)),["pid","birth","ppid"]);
          check(Number.isSafeInteger(announced.pid) && Number(announced.pid)>1);worker=capture(H1StagedActorRole.Worker,Number(announced.pid));check(worker.birth===announced.birth && expectedWorkerCommand && worker.command.equals(expectedWorkerCommand));physicalWorker(worker);observeActor(worker);
          clearTimeout(timer);child!.stdout!.off("data",receive);child!.stdout!.on("data",protocol);child!.stdout!.on("end",()=>stdout.end());
          check(pending.slice(newline+1)==="");rejoinDeadline();checkActualActorTables(worker);state=H1StagedSlotState.Constructed;phase(FullH1PrearmPhase.Constructed);child!.stdin!.write("1");resolve();
        }catch(error){clearTimeout(timer);reject(error);}};child!.stdout!.on("data",receive);child!.once("error",reject);child!.once("close",()=>reject(new Error("TEST H1 staged constructor died Held")));});
      return Object.freeze({child,stdout,stderr,closed:done});
    }catch(error){phase(FullH1PrearmPhase.Held);await close();throw error;}
  }
  // Prepared private gate. The unconditional external guard below remains active.
  // No public DTO, review boolean or callback can reach this original slot.
  function requireOriginalH1EffectGate(){
    check(!closing && state===H1StagedSlotState.Constructed && worker && query && queryComplete && queryFailure===undefined);
    rejoinDeadline();assertRetainedCurrentFullParent(parent);check(bootstrapRoutes && fixtureRoutes && querySourceSeen && systemctlSourceSeen);
    if(setupBirths.size===0)h1HeldError(H1ConstructorHeld.Actor);
    for(const actor of setupBirths.values()){
      if(actor.pid===worker.pid){
        check(actor.birth===worker.birth && actor.identity===worker.identity && identity(fstatSync(actor.anchor))===identity(fstatSync(worker.anchor)));rejoin(worker);
      }else try{const live=actualBirth(`/proc/self/fd/${actor.anchor}`,actor.pid);check(live.birth===actor.birth);rejoin(actor);}
      catch(error){check(error instanceof Error && "code" in error && (error.code==="ENOENT" || error.code==="ESRCH"));}
    }
    loadFacts?.revalidate();check(loadFacts);physicalWorker(worker);checkActualActorTables(worker);prepared?.revalidate();c.validate();rejoinDeadline();
  }
  let protocolBuffer="";
  function protocol(chunk:Buffer){
    try{protocolBuffer+=chunk.toString("utf8");check(Buffer.byteLength(protocolBuffer)<=32768);
      for(;;){const at=protocolBuffer.indexOf("\n");if(at<0)return;const line=protocolBuffer.slice(0,at);protocolBuffer=protocolBuffer.slice(at+1);
        if(line.startsWith("python_fixture:")){check(bootstrapRoutes && !fixtureRoutes && worker && c.h1Subject);checkH1PythonRouteData(JSON.parse(line.slice(15)),c.h1Subject.catalog);physicalWorker(worker);checkActualActorTables(worker);fixtureRoutes=true;
        }else if(line.startsWith("query:")){
          check(fixtureRoutes && !query && worker && prepared && child?.stdin && /^[1-9][0-9]*$/.test(line.slice(6)));
          const pid=Number(line.slice(6)),fact=actualBirth("/proc/"+pid,pid);check(fact.ppid===worker.pid);rejoin(worker);
          query=capture(H1StagedActorRole.Query,pid);physicalWorker(query);
          const pipeGroups=new Map<string,{stat:Stats;worker:boolean;query:boolean}>();
          for(const [actor,label] of [[worker,"worker"],[query,"query"]] as const){for(const name of readdirSync(`/proc/self/fd/${actor.anchor}/fd`)){if(Number(name)<3)continue;const path=`/proc/self/fd/${actor.anchor}/fd/${name}`,stat=statSync(path);if(!stat.isFIFO())continue;
            const key=stat.dev+":"+stat.ino,known=pipeGroups.get(key)??{stat,worker:false,query:false};known[label]=true;pipeGroups.set(key,known);}}
          check(pipeGroups.size===3);for(const group of pipeGroups.values()){check(group.worker && group.query);queryPipes.push({dev:BigInt(group.stat.dev),ino:BigInt(group.stat.ino),mode:BigInt(group.stat.mode)});}
          // This byte only releases the original fork into the fixed staged
          // nsenter command. It never releases fanotify/effect admission.
          observeActor(query);checkActualActorTables(query);rejoinDeadline();child.stdin.write("2");phase(FullH1PrearmPhase.QueryReleased);observeQueryTransitions();
        }else if(line.startsWith("query_complete:")){
          check(query && !queryComplete && prepared && child?.stdin && queryFailure===undefined);
          const values=fullData(JSON.parse(line.slice(15)),["ActiveState","ControlGroup","Id","InvocationID","Job","MainPID"]);
          check(values.ActiveState==="active" && values.ControlGroup==="/system.slice/TEST-retention-supervisor.service" && values.Id==="TEST-retention-supervisor.service" && values.Job==="" && values.MainPID===guestSupervisorPid && typeof values.InvocationID==="string" && /^[a-f0-9]{32}$/.test(values.InvocationID));
          check(querySourceSeen && systemctlSourceSeen);queryComplete=true;phase(FullH1PrearmPhase.QueryComplete);c.validate();prepared.revalidate();check(worker);physicalWorker(worker);
          // Complete original-source and actual fork/setns/exec joins, then
          // one private byte+EOF. No reported PID or DTO opens this gate.
          const effectGate=child.stdin;
          checkActualActorTables(worker);const monitor=actors.find(actor=>actor.role===H1StagedActorRole.Monitor);check(monitor);checkActualActorTables(monitor);
          requireOriginalH1EffectGate();phase(FullH1PrearmPhase.QualificationGuard);requireQualifiedH1StagedConstructor();
          state=H1StagedSlotState.Qualified;effectAccepted=true;effectGate.end("3");
        }else{check(effectAccepted && (line==="armed" || line==="original_parent_dead"));
          if(line==="original_parent_dead"){check(prepared && !parentDead);let dead=false;try{readFileSync(`/proc/self/fd/${prepared.anchors[5]}/stat`);}catch(error){check(error instanceof Error && "code" in error && (error.code==="ENOENT" || error.code==="ESRCH"));dead=true;}check(dead);parentDead=true;validatePrepared();}
          stdout.write(line+"\n");}
      }
    }catch(error){queryFailure=error;phase(FullH1PrearmPhase.Held);stderr.write("TEST_H1_staged_protocol_HOLD\n");void close().catch(()=>stderr.write("TEST_H1_staged_drain_HOLD\n"));}
  }
  function observeQueryTransitions(){
    check(query && prepared && worker);const original=query,started=performance.now();
    const poll=()=>{try{
      if(queryComplete || state===H1StagedSlotState.Closed)return;remaining();check(performance.now()-started<2000 && queryFailure===undefined);
      const base=`/proc/self/fd/${original.anchor}`;check(actualBirth(base,original.pid).birth===original.birth);
      const mapped=readFileSync(base+"/maps","utf8"),nsenter=c.h1Subject!.catalog.find(row=>row.path==="usr/bin/nsenter");check(nsenter?.kind===H1CatalogKind.File);
      const appears=(raw:string,dev:bigint,ino:bigint)=>raw.trimEnd().split("\n").some(line=>{const cells=/\s([0-9a-f]+):([0-9a-f]+)\s+([0-9]+)(?:\s+.*)?$/.exec(line);if(!cells)return false;const major=BigInt("0x"+cells[1]),minor=BigInt("0x"+cells[2]);return ((minor&255n)|(major<<8n)|((minor&~255n)<<12n))===dev && cells[3]===String(ino);});
      if(!querySourceSeen && appears(mapped,BigInt(nsenter.identity.dev),BigInt(nsenter.identity.ino))){const actor=capture(H1StagedActorRole.Query,original.pid);
        check(actor.command.equals(Buffer.from(["/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2","--inhibit-cache","--library-path","/usr/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu/systemd","/usr/bin/nsenter","--mount=/proc/self/fd/13","--pid=/proc/self/fd/14","--root=/proc/self/fd/15","--wdns=/","--","/usr/bin/systemctl","--system","show","--property=Id,MainPID,InvocationID,ControlGroup,ActiveState,Job","--","TEST-retention-supervisor.service",""] .join("\0"))));checkActualActorTables(actor);querySourceSeen=true;observeActor(actor);}
      const children=readFileSync(base+"/task/"+original.pid+"/children","utf8").trim().split(/\s+/).filter(Boolean);check(children.length<=1);
      const candidates=[original.pid,...children.map(value=>{check(/^[1-9][0-9]*$/.test(value));return Number(value);})];
      for(const pid of candidates){
        const path="/proc/"+pid,exe=statSync(path+"/exe",{bigint:true}),selected=statSync(`/proc/self/fd/${prepared!.queryAnchors[2]}/usr/bin/systemctl`,{bigint:true});
        if(exe.dev!==selected.dev || exe.ino!==selected.ino)continue;
        check(querySourceSeen && (pid===original.pid || actualBirth(path,pid).ppid===original.pid));
        check(identity(statSync(path+"/root"))===identity(fstatSync(prepared!.queryAnchors[2])));
        check(identity(statSync(path+"/ns/mnt"))===identity(fstatSync(prepared!.queryAnchors[0])));
        check(identity(statSync(path+"/ns/pid"))===identity(fstatSync(prepared!.queryAnchors[1])));
        const actor=capture(H1StagedActorRole.Systemctl,pid);check(actor.command.equals(Buffer.from(["/usr/bin/systemctl","--system","show","--property=Id,MainPID,InvocationID,ControlGroup,ActiveState,Job","--","TEST-retention-supervisor.service",""] .join("\0"))));const raw=readFileSync(path+"/maps","utf8");
        for(const line of raw.trimEnd().split("\n")){const cells=/\s([0-9a-f]+):([0-9a-f]+)\s+([0-9]+)(?:\s+.*)?$/.exec(line);check(cells);if(cells[3]==="0")continue;
          const major=BigInt("0x"+cells[1]),minor=BigInt("0x"+cells[2]),dev=(minor&255n)|(major<<8n)|((minor&~255n)<<12n);check(guestSources.some(source=>source.dev===dev && String(source.ino)===cells[3]));}
        rejoin(actor);const status=readFileSync(path+"/status","utf8");checkH1ActorStatusData(status,pid,parentCaps,H1PidView.Guest);checkActualActorTables(actor);systemctlSourceSeen=true;observeActor(actor);
      }
      if(!systemctlSourceSeen)setImmediate(poll);
    }catch(error){queryFailure=error;phase(FullH1PrearmPhase.Held);child?.stdin?.destroy();child?.kill("SIGTERM");}};setImmediate(poll);
  }
  const read=(task:FullMonitorTaskAnchor):FullH1StagedTaskFact|undefined=>{
    const actor=[...actors].reverse().find(row=>row.pid===task.processPid && row.birth===task.processBirth);if(!actor || state===H1StagedSlotState.Closed)return;
    rejoin(actor);task.revalidate();
    const taskDirectory=openSync(task.path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{check(retainedFilesystemType(taskDirectory)===0x9fa0n && identity(fstatSync(taskDirectory))===identity(statSync(task.path)));}
    finally{closeSync(taskDirectory);}
    const status=readFileSync(task.path+"/status","utf8");check(Buffer.byteLength(status)<=16384);
    const taskPid=/^Pid:\s+([1-9][0-9]*)$/m.exec(status)?.[1],tgid=/^Tgid:\s+([1-9][0-9]*)$/m.exec(status)?.[1];
    check(taskPid && tgid===String(actor.pid) && actualBirth(task.path,Number(taskPid)).birth===task.birth);
    const sources=actor.role===H1StagedActorRole.Systemctl?guestSources:(actor.role===H1StagedActorRole.Monitor || actor.role===H1StagedActorRole.Setup)?c.monitorSources.map(row=>fstatSync(row.fd,{bigint:true})):
      c.h1Subject!.catalog.filter(row=>row.kind===H1CatalogKind.File).map(row=>({dev:BigInt(row.identity.dev),ino:BigInt(row.identity.ino)}));
    const matches=(a:Readonly<{dev:bigint;ino:bigint}>,b:Readonly<{dev:bigint;ino:bigint}>)=>a.dev===b.dev && a.ino===b.ino;
    const base=task.path,names=readdirSync(base+"/fd").sort((a,b)=>Number(a)-Number(b));check(names.length<=64 && names.every(value=>/^(0|[1-9][0-9]*)$/.test(value)));
    const original=prepared?[...prepared.anchors,...prepared.queryAnchors].map(fd=>fstatSync(fd,{bigint:true})):[];
    const constructorObjects=owned.concat(loadFacts?.descriptors()??[]).map(fd=>fstatSync(fd,{bigint:true}));let fanotify=0,pidfd=0;
    const descriptors=names.map(name=>{const fd=Number(name),path=base+"/fd/"+name,stat=statSync(path,{bigint:true}),link=readlinkSync(path);
      if(fd<3){const known=actor.stdio[fd];check(known && matches(stat,known) && stat.mode===known.mode && stat.uid===known.uid);}
      else if((actor.role===H1StagedActorRole.Worker || actor.role===H1StagedActorRole.Query) && ((fd>=3 && fd<=11) || (fd>=13 && fd<=15))){
        const selected=fd<=11?prepared?.anchors[fd-3]:prepared?.queryAnchors[fd-13];check(selected!==undefined && matches(stat,fstatSync(selected,{bigint:true})));
      }else if(sources.some(source=>matches(stat,source)) || original.some(source=>matches(stat,source)) || constructorObjects.some(source=>matches(stat,source))){
        check(stat.isFile() || stat.isDirectory());
      }else if(actor.role===H1StagedActorRole.Monitor && notifyObject && matches(stat,notifyObject)){check(stat.isSocket());}
      else if(actor.role===H1StagedActorRole.Worker && link==="anon_inode:[fanotify]"){check(++fanotify===1);}
      else if(actor.role===H1StagedActorRole.Worker && link==="anon_inode:[pidfd]"){check(++pidfd===1 && requestPid!==undefined);const info=readFileSync(base+"/fdinfo/"+name,"utf8"),expected=effectAccepted?requestPid:query?.pid;check(expected!==undefined && Buffer.byteLength(info)<=4096 && new RegExp("^Pid:\\s+(?:"+expected+((effectAccepted?parentDead:queryComplete)?"|-1":"")+")$","m").test(info));}
      else if(!effectAccepted && queryPipes.some(source=>matches(stat,source) && stat.mode===source.mode)){check(stat.isFIFO());}
      else if(actor.role===H1StagedActorRole.Monitor && worker?.stdio.some(source=>matches(stat,source) && stat.mode===source.mode && stat.uid===source.uid)){check(stat.isFIFO() || stat.isSocket());}
      else throw new Error("TEST H1 staged unknown descriptor Held");
      check(matches(stat,statSync(path,{bigint:true})) && readlinkSync(path)===link);return Object.freeze({fd,dev:String(stat.dev),ino:String(stat.ino)});
    });
    const maps=readFileSync(base+"/maps","utf8");check(Buffer.byteLength(maps)<=1024*1024);
    for(const line of maps.trimEnd().split("\n")){const cells=/^[0-9a-f]+-[0-9a-f]+\s+[rwxps-]{4}\s+[0-9a-f]+\s+([0-9a-f]+):([0-9a-f]+)\s+([0-9]+)(?:\s+.*)?$/.exec(line);check(cells);
      if(cells[3]==="0")continue;const major=BigInt("0x"+cells[1]),minor=BigInt("0x"+cells[2]),dev=(minor&255n)|(major<<8n)|((minor&~255n)<<12n);
      check(sources.some(source=>source.dev===dev && String(source.ino)===cells[3]));}
    check(readFileSync(base+"/maps","utf8")===maps && JSON.stringify(readdirSync(base+"/fd").sort((a,b)=>Number(a)-Number(b)))===JSON.stringify(names));
    rejoin(actor);task.revalidate();return Object.freeze({role:actor.role,pid:actor.pid,birth:actor.birth,mountNamespace:readlinkSync(base+"/ns/mnt"),descriptors:Object.freeze(descriptors),sources:Object.freeze(sources.map(source=>Object.freeze({dev:String(source.dev),ino:String(source.ino)})))});
  };
  return Object.freeze({construct,close,read,snapshot,descriptors:()=>Object.freeze(state===H1StagedSlotState.Closed?[]:owned.concat(prepared?.descriptors()??[],loadFacts?.descriptors()??[]))});
}
const fullParentDescriptors=new WeakMap<object,()=>readonly number[]>();
export type FullMonitorTaskAnchor=Readonly<{path:string;processPid:number;processBirth:string;birth:string;revalidate():void}>;
export type FullMonitorTaskFact=Readonly<{pid:number;birth:string;taskBirth:string;invocationId:string;
  sourceBeforeSubmitSha256:string;mountNamespace:string;namespaceDevice:string;namespaceInode:string}>;
const fullMonitorReaders=new WeakMap<object,(task:FullMonitorTaskAnchor)=>FullMonitorTaskFact|undefined>();
const fullProviderSetupReaders=new WeakMap<object,(task:OriginalSetupTask)=>OriginalSetupFact|undefined>();
/** Only the original parent's constructor-owned slot can designate setup. */
export function readOriginalFullProviderSetupTask(parent:object,task:OriginalSetupTask):OriginalSetupFact|undefined {
  check(fullParents.has(parent));return fullProviderSetupReaders.get(parent)?.(task);
}
/** Facts of ONE causally submitted original monitor, never PID/unit enrollment. */
export function readOriginalFullMonitorTask(parent:object,task:FullMonitorTaskAnchor):FullMonitorTaskFact|undefined {
  check(fullParents.has(parent));const read=fullMonitorReaders.get(parent);check(read);return read(task);
}

/** Exact retained SOURCE/proc custody fact of the genuine original session.
 * No caller can enroll a descriptor or fabricate this private session join. */
export function retainedCurrentFullParentDescriptors(value:object):readonly number[] {
  assertRetainedCurrentFullParent(value);const read=fullParentDescriptors.get(value);check(read);return Object.freeze([...read()]);
}
export function assertRetainedCurrentFullParent(value:unknown):void {check(value!==null && typeof value==="object");const rejoin=fullParents.get(value);check(rejoin);rejoin();}
export interface FullParentSession {
  readonly removalCase:FullRemovalCase;
  readonly unit:string;revalidate():void;liveBindings():readonly string[];
  registerGuest(id:string,root:string,fragmentSha256:string):void;
  submitGuest(id:string):void;
  observeGuestInvocation(id:string,guestInvocationId:string):void;
  observeProviderSetupRequests():void;
  close(terminal:unknown):Promise<void>;
}
let retainedFullParent:FullParentSession|undefined;
/** SAME original protected manager + actual service reader, no admission DTO. */
export function retainCurrentFullParent():FullParentSession {
  if(retainedFullParent){assertRetainedCurrentFullParent(retainedFullParent);return retainedFullParent;}
  const c=acquire(RootContext.Parent);let closed=false,invocation:string|undefined,guestId:string|undefined,guestHash:string|undefined;
  let h1StagedSlot:ReturnType<typeof originalH1StagedSlot>|undefined;
  let providerSetupSlot:ReturnType<typeof originalProviderSetupSlot>|undefined;
  const guestSourceFiles=new Map<string,number>();
  let registeredGuestRoot:string|undefined;
  let rejoinGuestPeerPreload:(()=>void)|undefined;
  // The HOST query tool is independently selected DATA, physically retained
  // by this original constructor BEFORE guest submission. Current tool hashes
  // and a payload's request cannot substitute for a missing original closure.
  const namespaceQueryFiles:number[]=[];let namespaceQueryTool:ReturnType<typeof providerSetupQueryClosureData>|undefined;
  const namespaceTools=fullHostToolsData(fullReviewData(c.pins.json(reviewPath,32768)));
  if(namespaceTools.namespaceSetupQueryClosure!==undefined){const rows=namespaceTools.namespaceSetupQueryClosure;check(Array.isArray(rows) && rows.length>1 && rows.length<=64);let previous="",executables=0;const facts:{path:string;soname:string;needed:readonly string[];interpreter:string|null}[]=[];
    for(const value of rows){const row=fullData(value,["path","sha256","soname"]);check(typeof row.soname==="string" && typeof row.path==="string" && (row.path==="/usr/bin/nsenter" || /^\/usr\/lib\/[A-Za-z0-9_.+/-]+$/.test(row.path)) && !row.path.split("/").some(part=>part==="." || part==="..") && row.path>previous);previous=row.path;
      const expected=requireDigest(row.sha256),fd=row.path===h1LibcPath && namespaceTools.positiveHostLibc!==undefined?c.h1LibcPins.holdPositive(c.pins,namespaceTools.positiveHostLibc):row.path===positiveHostSystemdSharedPath && namespaceTools.positiveHostSystemdShared!==undefined?c.h1LibcPins.holdPositiveSystemdShared(c.pins,namespaceTools.positiveHostSystemdShared):c.pins.publicFile(row.path,expected),bytes=readFd(fd);check(hash(bytes)===expected);check(bytes.length>=64 && bytes.subarray(0,4).equals(Buffer.from([127,69,76,70])) && bytes[4]===2 && bytes[5]===1 && bytes.readUInt16LE(18)===62);const role=row.path==="/usr/bin/nsenter"?H1ElfRole.Program:row.path==="/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"?H1ElfRole.Loader:row.path===h1LibcPath?H1ElfRole.Libc:H1ElfRole.SharedObject,elf=validateH1ElfRole(bytes,role,role===H1ElfRole.Libc||role===H1ElfRole.SharedObject?row.soname:undefined,role===H1ElfRole.Libc?h1LibcPath:undefined);check((elf.soname??"")===row.soname);facts.push({path:row.path,soname:row.soname,needed:elf.needed,interpreter:elf.interpreter});namespaceQueryFiles.push(fd);if(row.path==="/usr/bin/nsenter"){check((fstatSync(fd).mode&0o111)!==0);executables++;}}
    check(executables===1);namespaceQueryTool=providerSetupQueryClosureData(facts);c.validate();}
  // Negative loader configuration fact, captured before guest submission and
  // repeated before every query. A current executable hash is never admission.
  const preloadPath="/etc/ld.so.preload";
  const emptyPreload=()=>{let file:Stats|undefined;try{file=lstatSync(preloadPath);}catch(error){check((error as NodeJS.ErrnoException).code==="ENOENT");}
    if(file){check(file.isFile() && !file.isSymbolicLink() && file.uid===0 && file.gid===0 && file.nlink===1 && !(file.mode&0o022) && file.size<=4096);check(readFileSync(preloadPath).toString("utf8").trim()==="");return {dev:file.dev,ino:file.ino,mode:file.mode,ctime:file.ctimeMs,mtime:file.mtimeMs};}return null;};
  const preloadFact=emptyPreload();
  function checkQueryPreload(){check(JSON.stringify(emptyPreload())===JSON.stringify(preloadFact));}
  function guestRecipeSources(paths:readonly string[]){revalidate();check(registeredGuestRoot && paths.length>0 && paths.length<=4);const root=registeredGuestRoot,seen=new Set<string>();
    const canonical=(path:string)=>{const physical=realpathSync(root+path);check(physical.startsWith(root+"/"));const name=physical.slice(root.length);const fd=guestSourceFiles.get(name);check(fd!==undefined);const actual=statSync(physical),held=fstatSync(fd);check(actual.dev===held.dev && actual.ino===held.ino);return {name,fd};};
    const dependency=(name:string)=>{check(/^[A-Za-z0-9_.+-]+$/.test(name));const targets=new Map<string,string>();for(const directory of ["/usr/lib/x86_64-linux-gnu","/usr/lib/x86_64-linux-gnu/systemd","/usr/lib64"]){let physical:string;try{physical=realpathSync(root+directory+"/"+name);}catch(error){check((error as NodeJS.ErrnoException).code==="ENOENT");continue;}check(physical.startsWith(root+"/"));const st=statSync(physical);targets.set(st.dev+":"+st.ino,physical.slice(root.length));}check(targets.size===1);return [...targets.values()][0]!;};
    function visit(path:string,soname?:string){const selected=canonical(path);if(seen.has(selected.name))return;check(seen.size<64);seen.add(selected.name);const bytes=readFd(selected.fd),role=selected.name==="/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"?H1ElfRole.Loader:soname==="libc.so.6"?H1ElfRole.Libc:soname?H1ElfRole.SharedObject:H1ElfRole.Program;
      const elf=validateH1ElfRole(bytes,role,role===H1ElfRole.Libc||role===H1ElfRole.SharedObject?soname:undefined,role===H1ElfRole.Libc?h1LibcPath:undefined);if(elf.interpreter)visit(elf.interpreter);for(const name of elf.needed)visit(dependency(name),name);}
    for(const path of paths)visit(path);const guestPreload=root+preloadPath;try{const file=lstatSync(guestPreload);check(file.isFile() && !file.isSymbolicLink() && file.uid===0 && file.gid===0 && !(file.mode&0o022) && file.size<=4096 && readFileSync(guestPreload).toString("utf8").trim()==="");}catch(error){check((error as NodeJS.ErrnoException).code==="ENOENT");}c.validate();revalidate();}
  let guestSubmitted=false,monitorSourceBeforeSubmit:string|undefined;
  let monitorCaptureStarted=false;
  let monitor:Readonly<{pid:number;start:string;anchor:number;exe:number;mnt:number;user:number;pidNamespace:number;
    procIdentity:string;exeIdentity:string;mountNamespace:string;invocation:string;command:Buffer}>|undefined;
  const procRoot="/proc/"+process.pid,procFds:number[]=[];
  const procIdentity=(fd:number)=>{const s=fstatSync(fd,{bigint:true});check(s.isFile() && retainedFilesystemType(fd)===0x9fa0n);return {dev:String(s.dev),ino:String(s.ino)};};
  function birth(raw:string){const end=raw.lastIndexOf(") "),fields=raw.slice(end+2).trim().split(/\s+/);check(end>0 && raw.startsWith(process.pid+" (") && fields[0] && !["Z","X","x"].includes(fields[0]) && /^[1-9][0-9]*$/.test(fields[19]??""));return fields[19]!;}
  const sourceSnapshot=fullSourceSnapshot(c);
  let liveRootCreated=false;
  let birthWitness:Readonly<{before:Buffer;after:Buffer}>|undefined;
  function sourceBirth(){
    if(!birthWitness){
      c.pins.hold(fullNativeBirthRoot,true,0o700);
      const deadline=process.hrtime.bigint()+5000000000n;
      while(true){try{lstatSync(fullNativeBirthRoot+"/after.json");break;}catch(error){check((error as NodeJS.ErrnoException).code==="ENOENT" && process.hrtime.bigint()<deadline);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
      const before=c.pins.json(fullNativeBirthRoot+"/before.json",4096),after=c.pins.json(fullNativeBirthRoot+"/after.json",4096);
      const b=fullData(before,["schemaVersion","sourceSha","fingerprint","producerPid","producerStartTicks","machineId","bootId","sourceSnapshotSha256"]),a=fullData(after,["schemaVersion","beforeSha256","unit","invocationId","pid","startTicks","sourceSnapshotSha256"]);
      const beforeBytes=Buffer.from(JSON.stringify(before)+"\n"),afterBytes=Buffer.from(JSON.stringify(after)+"\n");
      check(b.schemaVersion===1 && b.sourceSha===c.tuple.sourceSha && b.fingerprint===fingerprint(c.tuple.machineId,argvFor(c)) && b.machineId===c.tuple.machineId && b.bootId===c.tuple.bootId && b.sourceSnapshotSha256===sourceSnapshot);
      check(a.schemaVersion===1 && a.beforeSha256===hash(beforeBytes) && a.unit===fullNativeUnit && a.pid===process.pid && a.startTicks===parentStartTicks && a.invocationId===invocation && a.sourceSnapshotSha256===sourceSnapshot);
      check(Number.isSafeInteger(b.producerPid) && Number(b.producerPid)>0 && /^[1-9][0-9]*$/.test(String(b.producerStartTicks)));
      birthWitness=Object.freeze({before:beforeBytes,after:afterBytes});
    }
    check(readFileSync(fullNativeBirthRoot+"/before.json").equals(birthWitness.before) && readFileSync(fullNativeBirthRoot+"/after.json").equals(birthWitness.after));
  }
  const procAnchor=openSync(procRoot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  procFds.push(procAnchor);
  const procFiles=["stat","status"].map(name=>{const fd=openSync(`/proc/self/fd/${procAnchor}/${name}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);procFds.push(fd);return {name,fd,identity:procIdentity(fd)};});
  const parentStartTicks=birth(readFileSync(procRoot+"/stat","utf8"));
  const caps=(raw:string)=>["Inh","Prm","Eff","Bnd","Amb"].map(set=>{const row=new RegExp("^Cap"+set+":\\s+([0-9a-f]{16})$","m").exec(raw)?.[1];check(row);return row;});
  const parentCapabilities=caps(readFileSync(procRoot+"/status","utf8"));
  function liveProc(){
    const anchor=fstatSync(procAnchor),named=lstatSync(procRoot);check(anchor.dev===named.dev && anchor.ino===named.ino && !named.isSymbolicLink());
    for(const entry of procFiles){const fresh=openSync(procRoot+"/"+entry.name,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{check(JSON.stringify(procIdentity(fresh))===JSON.stringify(entry.identity) && JSON.stringify(procIdentity(entry.fd))===JSON.stringify(entry.identity));
        check(ancestorMountId(fresh)===ancestorMountId(entry.fd));
        const raw=readFileSync(fresh,"utf8");check(Buffer.byteLength(raw)<=(entry.name==="stat"?4096:16384));
        if(entry.name==="stat")check(birth(raw)===parentStartTicks);else check(JSON.stringify(caps(raw))===JSON.stringify(parentCapabilities) && /^Uid:\s+0\s+0\s+0\s+0$/m.test(raw) && /^NoNewPrivs:\s+1$/m.test(raw));
      }finally{closeSync(fresh);}}
    check(birth(readFileSync(procRoot+"/stat","utf8"))===parentStartTicks);
  }
  const revalidate=()=>{check(!closed);liveProc();c.validate();rejoinGuestPeerPreload?.();
    const ackDeadline=process.hrtime.bigint()+5000000000n;
    while(record(c,true).phase!==FullParentPhase.Started){check(process.hrtime.bigint()<ackDeadline);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
    const envKeys=Object.keys(process.env);check(envKeys.length<=32 && envKeys.every(key=>["PATH","LANG","LC_ALL","HOME","TMPDIR","USER","LOGNAME","SHELL","INVOCATION_ID","SYSTEMD_EXEC_PID","JOURNAL_STREAM","SUBSCRIPTION_RUNTIME_HOST_JOB_ID","TEST_SOURCE_SHA","TEST_FULL_RESTORE_CONSUMER"].includes(key)));
    check(fullNativeRestoreConsumer(process.env.TEST_FULL_RESTORE_CONSUMER)===c.tuple.restoreConsumer);
    check(process.env.SUBSCRIPTION_RUNTIME_HOST_JOB_ID===fullNativeJob && process.env.TEST_SOURCE_SHA===c.tuple.sourceSha && JSON.stringify(process.argv)===JSON.stringify(argvFor(c)));
    check(readlinkSync("/proc/self/exe")===c.tuple.node);check(readFileSync("/proc/self/cmdline").equals(Buffer.from([...argvFor(c),""].join("\u0000"))));
    const observed=spawnSync("/usr/bin/systemctl",["show",fullNativeUnit,"--property=LoadState,ActiveState,SubState,InvocationID,MainPID,Description,ControlGroup,ProtectSystem"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:4096});
    check(!observed.error && observed.status===0 && observed.signal===null);const values:Record<string,string>={};
    for(const line of observed.stdout.trimEnd().split("\n")){const n=line.indexOf("=");check(n>0 && !Object.hasOwn(values,line.slice(0,n)));values[line.slice(0,n)]=line.slice(n+1);}
    check(Object.keys(values).sort().join(",")==="ActiveState,ControlGroup,Description,InvocationID,LoadState,MainPID,ProtectSystem,SubState");
    check(values.ProtectSystem==="strict");assertReadonlyMounts(c.pins,[c.tuple.source,c.tuple.root+"/toolchain",reviewRoot,"/run/TEST-full-outer-review","/run/TEST-real-codex-public-review","/srv/worker-state/account-pools/live-codex-auth/"+c.tuple.accountName]);
    check(values.LoadState===FullKernelState.Loaded && (values.ActiveState===FullKernelState.Active || values.ActiveState===FullKernelState.Activating) && values.SubState===FullKernelState.Running && values.MainPID===String(process.pid));
    check(typeof values.ControlGroup==="string");
    check(values.Description==="subscription-job:"+fingerprint(c.tuple.machineId,argvFor(c)) && values.ControlGroup===fullNativeControlGroup);
    check(typeof values.InvocationID==="string" && /^[a-f0-9]{32}$/.test(values.InvocationID));check(process.env.INVOCATION_ID===values.InvocationID && process.env.PATH==="/usr/bin:/bin" && process.env.LANG==="C.UTF-8" && process.env.HOME==="/srv/workers/jobs/"+fullNativeJob && process.env.TMPDIR==="/srv/workers/jobs/"+fullNativeJob+"/tmp");if(invocation)check(invocation===values.InvocationID);else invocation=values.InvocationID;
    checkH1OwnedCgroupData(readFileSync("/proc/self/cgroup","utf8"),values.ControlGroup);assertParentKernelPolicy(values.ControlGroup);sourceBirth();liveProc();c.validate();record(c,true);
  };
  let h1CapturedDeadline:bigint|undefined;
  function originalH1Deadline(){
    revalidate();const result=spawnSync("/usr/bin/systemctl",["show",fullNativeUnit,"--property=MainPID,InvocationID,ExecMainStartTimestampMonotonic,RuntimeMaxUSec"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:4096});
    check(!result.error && result.status===0 && result.signal===null);const values:Record<string,string>={};
    for(const line of result.stdout.trimEnd().split("\n")){const at=line.indexOf("=");check(at>0 && !Object.hasOwn(values,line.slice(0,at)));values[line.slice(0,at)]=line.slice(at+1);}
    check(Object.keys(values).sort().join(",")==="ExecMainStartTimestampMonotonic,InvocationID,MainPID,RuntimeMaxUSec" && invocation);
    const deadline=h1OriginalDeadlineData(values,process.pid,invocation);if(h1CapturedDeadline!==undefined)check(deadline===h1CapturedDeadline);else h1CapturedDeadline=deadline;
    revalidate();check(process.hrtime.bigint()<deadline);return deadline;
  }
  function monitorState():Readonly<Record<string,string>> {
    check(guestId && guestSubmitted);
    const unit="TEST-retention-os-"+guestId+".service";
    const keys=["Id","LoadState","ActiveState","SubState","MainPID","InvocationID","ControlGroup","FragmentPath","DropInPaths", "Type","KillMode","Restart","NoNewPrivileges","CapabilityBoundingSet","AmbientCapabilities","RootDirectory","WorkingDirectory","Environment","UnsetEnvironment","StandardInput","StandardOutput","StandardError"];
    const result=spawnSync("/usr/bin/systemctl",["show",unit,"--property="+keys.join(",")],
      {env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:8192});
    check(!result.error && result.status===0 && result.signal===null);const values:Record<string,string>={};
    for(const line of result.stdout.trimEnd().split("\n")){
      const at=line.indexOf("=");check(at>0 && !Object.hasOwn(values,line.slice(0,at)));values[line.slice(0,at)]=line.slice(at+1);
    }
    check(Object.keys(values).sort().join(",")===keys.sort().join(","));
    check(values.Id===unit && values.LoadState==="loaded" && values.ActiveState==="active" && values.SubState==="running" &&
      values.ControlGroup==="/system.slice/"+unit && values.FragmentPath==="/run/systemd/system/"+unit && values.DropInPaths==="" &&
      values.Type==="exec" && values.KillMode==="control-group" && values.Restart==="no" && values.NoNewPrivileges==="yes" && values.AmbientCapabilities==="" &&
      values.RootDirectory==="" && (values.WorkingDirectory==="" || values.WorkingDirectory==="/") &&
      values.Environment==="SYSTEMD_NSPAWN_USE_CGNS=1" && values.StandardInput==="null" && values.StandardOutput==="null" && values.StandardError==="null");
    check(values.UnsetEnvironment?.split(" ").sort().join(" ") === ["NODE_OPTIONS","NODE_PATH","LD_PRELOAD","LD_LIBRARY_PATH","LD_AUDIT","LD_PROFILE"].sort().join(" "));
    check(values.CapabilityBoundingSet?.split(" ").map(value=>value.toUpperCase()).sort().join(" ")===fullMonitorCapabilities.split(" ").sort().join(" "));
    check(/^[1-9][0-9]*$/.test(values.MainPID??"") && /^[a-f0-9]{32}$/.test(values.InvocationID??""));
    return Object.freeze(values);
  }
  function monitorBirth(path:string,pid:number):string {
    const raw=readFileSync(path+"/stat","utf8"),end=raw.lastIndexOf(") "),fields=raw.slice(end+2).trim().split(/\s+/);
    check(end>0 && raw.startsWith(pid+" (") && !["Z","X","x"].includes(fields[0]??"") && /^[1-9][0-9]*$/.test(fields[19]??""));return fields[19]!;
  }
  function retainMonitorDescriptor(path:string,flags:number):number {
    const fd=openSync(path,flags);procFds.push(fd);return fd;
  }
  function monitorMappings(path:string):void {
    const raw=readFileSync(path+"/maps","utf8");check(Buffer.byteLength(raw)<=1024*1024);
    const selected=c.monitorSources.map(source=>{const stat=fstatSync(source.fd,{bigint:true});
      const major=((stat.dev>>8n)&0xfffn)|((stat.dev>>32n)&0xfffff000n),minor=(stat.dev&0xffn)|((stat.dev>>12n)&0xffffff00n);
      return {inode:String(stat.ino),device:major+":"+minor};});
    let executableMaps=0;
    for(const row of raw.trimEnd().split("\n")){
      const match=/^[0-9a-f]+-[0-9a-f]+ ([rwxps-]{4}) [0-9a-f]+ ([0-9a-f]+):([0-9a-f]+) ([0-9]+)(?: +(.+))?$/.exec(row);check(match);
      if(!match[1]!.includes("x"))continue;check(!match[1]!.includes("w"));
      if(match[4]==="0"){check(match[5]==="[vdso]" || match[5]==="[vsyscall]");continue;}
      executableMaps++;check(selected.some(source=>source.inode===match[4] && source.device===BigInt("0x"+match[2]!)+":"+BigInt("0x"+match[3]!)));
    }
    check(executableMaps>0);
  }
  function rejoinMonitor():void {
    revalidate();check(monitor && monitorSourceBeforeSubmit && guestId);
    const before=monitorState();check(before.MainPID===String(monitor.pid) && before.InvocationID===monitor.invocation);
    const numeric="/proc/"+monitor.pid,held=`/proc/self/fd/${monitor.anchor}`,fresh=openSync(numeric,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{
      check(identity(fstatSync(fresh))===monitor.procIdentity && identity(fstatSync(monitor.anchor))===monitor.procIdentity &&
        ancestorMountId(fresh)===ancestorMountId(monitor.anchor) && retainedFilesystemType(monitor.anchor)===0x9fa0n);
      check(monitorBirth(held,monitor.pid)===monitor.start && monitorBirth(`/proc/self/fd/${fresh}`,monitor.pid)===monitor.start);
      const status=readFileSync(held+"/status","utf8");check(/^Uid:\s+0\s+0\s+0\s+0$/m.test(status) && /^Gid:\s+0\s+0\s+0\s+0$/m.test(status) && /^NoNewPrivs:\s+1$/m.test(status));
      const sets=caps(status),bound=0xa82c01fbn;check(sets[0]==="0000000000000000" && sets[4]==="0000000000000000" && BigInt("0x"+sets[3]!)===bound);
      check(sets.every(value=>(BigInt("0x"+value)&~bound)===0n));
      check(identity(statSync(held+"/root"))===identity(fstatSync(c.pins.hold("/",true))));
      check(readFileSync(held+"/cgroup","utf8")==="0::/system.slice/TEST-retention-os-"+guestId+".service\n" && readFileSync(held+"/cmdline").equals(monitor.command));
      const exe=openSync(held+"/exe",constants.O_RDONLY);try{check(identity(fstatSync(exe))===monitor.exeIdentity && identity(fstatSync(monitor.exe))===monitor.exeIdentity);}finally{closeSync(exe);}
      check(readlinkSync(held+"/ns/user")==="user:[4026531837]" && readlinkSync(held+"/ns/pid")==="pid:[4026531836]" && readlinkSync(held+"/ns/mnt")===monitor.mountNamespace);
      for(const [name,fd] of [["user",monitor.user],["pid",monitor.pidNamespace],["mnt",monitor.mnt]] as const){
        const current=openSync(held+"/ns/"+name,constants.O_RDONLY);try{check(identity(fstatSync(current))===identity(fstatSync(fd)) && retainedFilesystemType(fd)===0x6e736673n);}finally{closeSync(current);}
      }
      monitorMappings(held);c.validate();check(fullSourceSnapshot(c)===monitorSourceBeforeSubmit);
      check(JSON.stringify(monitorState())===JSON.stringify(before));check(monitorBirth(held,monitor.pid)===monitor.start);
    }finally{closeSync(fresh);}
  }
  function captureMonitor(expectedInvocation:string):void {
    check(!monitorCaptureStarted && guestId && monitorSourceBeforeSubmit);monitorCaptureStarted=true;
    const state=monitorState();check(state.InvocationID===expectedInvocation);const pid=Number(state.MainPID);
    const anchor=retainMonitorDescriptor("/proc/"+pid,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW),path=`/proc/self/fd/${anchor}`;
    const fragment=readFd(c.pins.hold("/run/systemd/system/TEST-retention-os-"+guestId+".service")).toString("utf8");
    check(Buffer.byteLength(fragment)<=16384);
    const commands=[...fragment.matchAll(/^ExecStart=(.+)$/gm)];check(commands.length===1);
    const argv=commands[0]![1]!.split(" ");check(argv[0]==="/usr/bin/systemd-nspawn" && argv.includes("--settings=no") && argv.includes("--link-journal=no"));
    const command=Buffer.from([...argv,""].join("\0"));check(command.length<=32768 && readFileSync(path+"/cmdline").equals(command));
    const exe=retainMonitorDescriptor(path+"/exe",constants.O_RDONLY),selected=fstatSync(c.monitorSources[0]!.fd);
    check(identity(fstatSync(exe))===identity(selected));
    const user=retainMonitorDescriptor(path+"/ns/user",constants.O_RDONLY),pidNamespace=retainMonitorDescriptor(path+"/ns/pid",constants.O_RDONLY),mnt=retainMonitorDescriptor(path+"/ns/mnt",constants.O_RDONLY);
    monitor=Object.freeze({pid,start:monitorBirth(path,pid),anchor,exe,mnt,user,pidNamespace,procIdentity:identity(fstatSync(anchor)),exeIdentity:identity(fstatSync(exe)),mountNamespace:readlinkSync(path+"/ns/mnt"),invocation:expectedInvocation,command});
    rejoinMonitor();
  }
  function seal(name:"current-full-pair.json"|"current-full-pair-invocation.json",data:unknown){
    revalidate();check(liveRootCreated);const parent=c.pins.hold(fullNativeLiveRoot,true,0o700);
    const fd=openSync(`/proc/self/fd/${parent}/${name}`,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{writeFileSync(fd,JSON.stringify(data)+"\n");fsyncSync(fd);}finally{closeSync(fd);}fsyncSync(parent);revalidate();
  }
  try{revalidate();const session=Object.freeze({removalCase:c.tuple.removalCase,unit:fullNativeUnit,revalidate,
    liveBindings(){
      revalidate();check(!liveRootCreated);const job=c.pins.hold("/srv/workers/jobs/"+fullNativeJob,true,0o700);
      mkdirSync(`/proc/self/fd/${job}/full-parent-live`,{mode:0o700});fsyncSync(job);
      c.pins.hold(fullNativeLiveRoot,true,0o700);liveRootCreated=true;revalidate();
      return Object.freeze([`--bind-ro=${fullNativeLiveRoot}:${fullNativeGuestLiveRoot}/seals`,
        `--bind-ro=${procRoot}/stat:${fullNativeGuestLiveRoot}/stat`,`--bind-ro=${procRoot}/status:${fullNativeGuestLiveRoot}/status`]);
    },
    registerGuest(id:string,root:string,fragmentSha256:string){
      revalidate();check(!guestId && fullNativeGuestRoot(id,root) && digest(fragmentSha256));
      c.pins.hold(dirname(root),true,0o700);const rootFd=c.pins.hold(root,true,0o755),rootStat=fstatSync(rootFd),unit="TEST-retention-os-"+id+".service";
      registeredGuestRoot=root;
      c.pins.publicFile("/run/systemd/system/"+unit,fragmentSha256);
      // Original source is retained BEFORE this exclusive guest submission.
      // Current hashes after birth are never substituted for this causal hold.
      const guestRuntime=root+"/opt/subscription-runtime-dependency-os-TEST";
      const publicCatalog=fullData(c.pins.json(reviewRoot+"/public-installation.json",2*1024*1024),["schemaVersion","sourceSha","sourceTree","files"]);
      check(Array.isArray(publicCatalog.files));
      for(const entry of publicCatalog.files){const row=fullData(entry,["path","sha256"]);check(fullPublicRelative(row.path) && digest(row.sha256));
        if(!row.path.startsWith("host-integration/") || originalFullGuestNativeSourcePaths.includes(row.path))guestSourceFiles.set("/opt/subscription-runtime-dependency-os-TEST/"+row.path,c.pins.publicFile(guestRuntime+"/"+row.path,row.sha256));
        if(["host-integration/managed-launcher/launch.mjs","host-integration/managed-launcher/hosted-host-policy.mjs","host-integration/managed-launcher/payload-guard.mjs","host-integration/managed-launcher/profiles.mjs","host-integration/host-jobs/storage-policy.mjs"].includes(row.path))c.pins.publicFile(root+"/opt/subscription-runtime/"+row.path.slice("host-integration/".length),row.sha256);
      }
      for(const relative of originalFullGuestNativeSourcePaths){
        check(publicCatalog.files.filter(entry=>fullData(entry,["path","sha256"]).path===relative).length===1 &&
          guestSourceFiles.has("/opt/subscription-runtime-dependency-os-TEST/"+relative));
      }
      guestSourceFiles.set("/opt/subscription-runtime-dependency-os-TEST/toolchain/bin/node",c.pins.publicFile(guestRuntime+"/toolchain/bin/node",requireDigest(fullReviewData(c.pins.json(reviewPath,32768)).nodeSha256)));
      const elfFd=c.pins.hold(guestRuntime+"/os-signed-elf-pins.json"),elfBytes=readFd(elfFd);check(elfBytes.length<=256*1024);
      const os=fullData(JSON.parse(elfBytes.toString("utf8")),["schemaVersion","pins"]);check(os.schemaVersion===1 && Array.isArray(os.pins));
      const guestSources:{path:string;sha256:string}[]=[{path:"/opt/subscription-runtime-dependency-os-TEST/toolchain/bin/node",sha256:hash(readFd(c.pins.hold(guestRuntime+"/toolchain/bin/node")))}];
      for(const entry of os.pins){const row=fullData(entry,["path","sha256"]);check(typeof row.path==="string" && /^\/usr\/(?:lib|bin)\/[A-Za-z0-9_.+/-]+$/.test(row.path) && !row.path.split("/").includes("..") && digest(row.sha256));guestSourceFiles.set(row.path,c.pins.publicFile(root+row.path,row.sha256));
        if(["/usr/lib/systemd/systemd","/usr/bin/dbus-daemon"].includes(row.path))guestSources.push({path:row.path,sha256:row.sha256});}
      for(const entry of publicCatalog.files){const row=fullData(entry,["path","sha256"]);if(typeof row.path==="string" && /^(?:scripts\/dependency-retention-os-test\/current-full-(?:supervisor|guest)\.js|dist\/worker-codex\/hosted-readonly-(?:host-launch-cli|runtime-bootstrap)\.js)$/.test(row.path)){check(digest(row.sha256));guestSources.push({path:"/opt/subscription-runtime-dependency-os-TEST/"+row.path,sha256:row.sha256});}}
      const supervisor="/etc/systemd/test-units/TEST-retention-supervisor.service",supervisorFd=c.pins.hold(root+supervisor,false,0o644);
      guestSources.push({path:supervisor,sha256:hash(readFd(supervisorFd))});
      const guestMachineFd=c.pins.hold(root+"/etc/machine-id",false,0o444),guestMachineId=readFd(guestMachineFd).toString("utf8").trim();check(/^[a-f0-9]{32}$/.test(guestMachineId));
      if(c.tuple.removalCase===FullRemovalCase.ParentCrashH1){
        for(const relative of ["scripts/dependency-retention-os-test/current-removal-h1-fixture.js","scripts/dependency-retention-os-test/current-full-h1-supervision.js"]){
          const entry=publicCatalog.files.find(value=>fullData(value,["path","sha256"]).path===relative);check(entry);const row=fullData(entry,["path","sha256"]);
          guestSources.push({path:"/opt/subscription-runtime-dependency-os-TEST/"+relative,sha256:requireDigest(row.sha256)});
        }
      }
      // These finite SDK entry/helper bytes join the same original pre-submit
      // FD catalog. Planned/missing/duplicate modules cannot qualify a guest.
      for(const relative of originalFullProjectControlSourcePaths){
        const rows=publicCatalog.files.filter(value=>fullData(value,["path","sha256"]).path===relative);check(rows.length===1);
        const row=fullData(rows[0],["path","sha256"]),path="/opt/subscription-runtime-dependency-os-TEST/"+relative;
        check(guestSourceFiles.has(path));guestSources.push({path,sha256:requireDigest(row.sha256)});
      }
      // Original signed extraction metadata is held and sealed by this actual
      // pre-submit constructor; no late guest hash or caller DTO enrolls it.
      const peerMetadata=new Map<string,Buffer>();
      for(const relative of originalFullProjectControlPeerMetadataPaths){const path="/opt/subscription-runtime-dependency-os-TEST/"+relative,fd=c.pins.hold(root+path),bytes=readFd(fd);
        check(bytes.length>0 && bytes.length<=256*1024);const value:unknown=JSON.parse(bytes.toString("utf8"));check(bytes.equals(Buffer.from(JSON.stringify(value)+"\n")));
        peerMetadata.set(relative,bytes);guestSourceFiles.set(path,fd);guestSources.push({path,sha256:hash(bytes)});}
      const packages=fullData(JSON.parse(peerMetadata.get("os-packages.json")!.toString("utf8")),["schemaVersion","release","releases","packages","usrLayout","pinnedNode"]),aliases=fullData(JSON.parse(peerMetadata.get("os-signed-tool-aliases.json")!.toString("utf8")),["schemaVersion","packages","aliases"]);
      check(packages.schemaVersion===1 && packages.release==="ubuntu-noble" && Array.isArray(packages.packages) && packages.packages.length>0 && packages.packages.length<=256 && aliases.schemaVersion===1 && JSON.stringify(packages.packages)===JSON.stringify(aliases.packages) && Array.isArray(aliases.aliases) && aliases.aliases.length<=1024);
      const preload=originalFullProjectControlPreloadData(JSON.parse(peerMetadata.get("os-signed-peer-preload.json")!.toString("utf8"))),parentFd=c.pins.hold(root+"/etc",true),parent=fstatSync(parentFd,{bigint:true});
      check(String(parent.dev)===preload.parent.dev && String(parent.ino)===preload.parent.ino);
      const emptyFd=preload.kind===OriginalFullPeerPreloadSelectionKind.Empty?c.pins.hold(root+"/etc/ld.so.preload"):undefined;
      rejoinGuestPeerPreload=()=>{const held=fstatSync(parentFd,{bigint:true}),named=lstatSync(root+"/etc",{bigint:true});check(held.isDirectory() && !named.isSymbolicLink() && held.dev===parent.dev && held.ino===parent.ino && named.dev===parent.dev && named.ino===parent.ino);
        const child="/proc/self/fd/"+parentFd+"/ld.so.preload";
        if(preload.kind===OriginalFullPeerPreloadSelectionKind.Absent){let absent=false;try{lstatSync(child);}catch(error){check(error instanceof Error && "code" in error && error.code==="ENOENT");absent=true;}check(absent);}
        else{check(emptyFd!==undefined && preload.file);const file=fstatSync(emptyFd,{bigint:true}),current=lstatSync(child,{bigint:true});check(file.isFile() && !current.isSymbolicLink() && file.uid===0n && file.gid===0n && file.nlink===1n && !(file.mode&0o022n) && file.size===0n && String(file.dev)===preload.file.dev && String(file.ino)===preload.file.ino && current.dev===file.dev && current.ino===file.ino && current.size===0n && readFd(emptyFd).length===0);}};
      rejoinGuestPeerPreload();
      check(guestSources.length===(c.tuple.removalCase===FullRemovalCase.ParentCrashH1?10:8)+originalFullProjectControlSourcePaths.length+originalFullProjectControlPeerMetadataPaths.length);c.validate();
      const data={schemaVersion:2,...(c.tuple.removalCase===FullRemovalCase.ParentCrashH1?{removalCase:c.tuple.removalCase,restoreConsumer:c.tuple.restoreConsumer}:{}),jobId:fullNativeJob,parentUnit:fullNativeUnit,parentInvocationId:invocation,guestMachineId,parentProc:{pid:process.pid,startTicks:parentStartTicks,stat:procFiles[0]!.identity,status:procFiles[1]!.identity,capabilities:parentCapabilities},guestSources,unit,fragmentSha256,root,rootDev:String(rootStat.dev),rootIno:String(rootStat.ino),machineId:c.tuple.machineId,bootId:c.tuple.bootId,sourceSha:c.tuple.sourceSha};
      guestHash=hash(JSON.stringify(data)+"\n");seal("current-full-pair.json",data);guestId=id;
    },
    submitGuest(id:string){
      // This private original session owns the existing one submission. A
      // transport failure consumes it and retains custody; no blind retry.
      revalidate();check(id===guestId && guestHash && !guestSubmitted);
      const unit="TEST-retention-os-"+id+".service";
      const observation=spawnSync("/usr/bin/systemctl",["show",unit,"--property=MainPID,Job,ActiveState,FragmentPath,DropInPaths"],
        {env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:4096});
      check(!observation.error && observation.status===0 && observation.signal===null);
      const fields:Record<string,string>={};
      for(const line of observation.stdout.trimEnd().split("\n")){
        const split=line.indexOf("=");check(split>0 && !Object.hasOwn(fields,line.slice(0,split)));
        fields[line.slice(0,split)]=line.slice(split+1);
      }
      check(Object.keys(fields).sort().join(",")==="ActiveState,DropInPaths,FragmentPath,Job,MainPID" &&
        fields.MainPID==="0" && fields.Job==="" && fields.ActiveState==="inactive" &&
        fields.FragmentPath==="/run/systemd/system/"+unit && fields.DropInPaths==="");
      revalidate();monitorSourceBeforeSubmit=fullSourceSnapshot(c);guestSubmitted=true;
      const submitted=spawnSync("/usr/bin/systemctl",["start","--no-block",unit],
        {env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:4096});
      check(!submitted.error && submitted.status===0 && submitted.signal===null);revalidate();
    },
    observeGuestInvocation(id:string,guestInvocationId:string){
      revalidate();check(id===guestId && guestHash && guestSubmitted && monitorSourceBeforeSubmit && /^[a-f0-9]{32}$/.test(guestInvocationId));const unit="TEST-retention-os-"+id+".service";
      const result=spawnSync("/usr/bin/systemctl",["show",unit,"--property=InvocationID","--value"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:256});
      check(!result.error && result.status===0 && result.signal===null && result.stdout.trim()===guestInvocationId);revalidate();
      captureMonitor(guestInvocationId);
      const invocationData={schemaVersion:1,pairSha256:guestHash,parentInvocationId:invocation,unit,guestInvocationId};
      seal("current-full-pair-invocation.json",invocationData);
      const require=createRequire(import.meta.url);
      const fdModule=require(c.tuple.source+"/dist/provider-codex/app-server/adapters/hosted-fd-table.js") as Readonly<{hostedFdTable:OriginalSetupContext["fdTable"]}>;
      const peerModule=require(c.tuple.source+"/dist/core/host-infrastructure/fd-collector-profile.js") as Readonly<{parseFdCollectorRows:OriginalSetupContext["parsePeers"];knownFdCollectorPeer:OriginalSetupContext["peer"]}>;
      const parentRecipeModule=require(c.tuple.source+"/dist/provider-codex/app-server/adapters/hosted-dependency-parent-recipe.js") as Readonly<{assertHostedDependencyParentRecipe:OriginalSetupContext["parentRecipe"]}>;
      const namespaceModule=require(c.tuple.source+"/dist/provider-codex/app-server/adapters/hosted-fd-namespace-stages.js") as Readonly<{hostedFdNamespacePrefix:OriginalSetupContext["namespacePrefix"]}>;
      check(typeof fdModule.hostedFdTable==="function" && typeof peerModule.parseFdCollectorRows==="function" && typeof peerModule.knownFdCollectorPeer==="function");c.validate();
      check(registeredGuestRoot);providerSetupSlot=originalProviderSetupSlot({root:registeredGuestRoot,group:"/system.slice/"+unit,pairSha256:guestHash,invocationSealSha256:hash(JSON.stringify(invocationData)+"\n"),outbox:dirname(registeredGuestRoot)+"/policy-request-outbox",revalidate,
        systemdRunExecutable:managedSystemdRunExecutable,recipeSources:guestRecipeSources,source(path){revalidate();const fd=guestSourceFiles.get(path);check(fd!==undefined);return fd;},queryTool(){revalidate();checkQueryPreload();check(namespaceQueryFiles.length>1 && namespaceQueryTool);c.validate();return namespaceQueryTool;},
        seal(name,data){revalidate();check(/^current-full-provider-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.(?:intent|birth)\.json$/.test(name));
          const rootFd=c.pins.hold(fullNativeLiveRoot,true,0o700),fd=openSync(`/proc/self/fd/${rootFd}/${name}`,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,JSON.stringify(data)+"\n");fsyncSync(fd);}finally{closeSync(fd);}fsyncSync(rootFd);revalidate();},
        fdTable:fdModule.hostedFdTable,parsePeers:peerModule.parseFdCollectorRows,peer:peerModule.knownFdCollectorPeer,namespacePrefix:namespaceModule.hostedFdNamespacePrefix,parentRecipe:parentRecipeModule.assertHostedDependencyParentRecipe});
      fullProviderSetupReaders.set(session,providerSetupSlot.read);
    },observeProviderSetupRequests(){revalidate();check(providerSetupSlot);providerSetupSlot.observe();revalidate();},async close(terminal:unknown){
      check(!closed);revalidate();
      const module=await import(pathToFileURL(c.tuple.source+"/scripts/dependency-retention-os-test/current-full-backing-collector.js").href);
      module.assertFullBackingTerminal(session,terminal);revalidate();
      if(h1StagedSlot)await h1StagedSlot.close();
      providerSetupSlot?.close();
      if(monitor){
        // A recursive terminal brand does not turn a live proc anchor into dead
        // custody. Reopen the original object: kernel death must be observable.
        let dead=false;
        try{readFileSync(`/proc/self/fd/${monitor.anchor}/stat`);}
        catch(error){check((error as NodeJS.ErrnoException).code==="ESRCH" || (error as NodeJS.ErrnoException).code==="ENOENT");dead=true;}
        check(dead);
        const final=spawnSync("/usr/bin/systemctl",["show","TEST-retention-os-"+guestId+".service","--property=InvocationID,MainPID,Job,ActiveState"],
          {env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:5000,maxBuffer:4096});
        check(!final.error && final.status===0 && final.signal===null);const fields:Record<string,string>={};
        for(const line of final.stdout.trimEnd().split("\n")){const at=line.indexOf("=");check(at>0 && !Object.hasOwn(fields,line.slice(0,at)));fields[line.slice(0,at)]=line.slice(at+1);}
        check(Object.keys(fields).sort().join(",")==="ActiveState,InvocationID,Job,MainPID" && fields.InvocationID===monitor.invocation &&
          fields.MainPID==="0" && fields.Job==="" && ["inactive","failed"].includes(fields.ActiveState??""));
      }
      revalidate();closed=true;for(const fd of procFds.reverse())closeSync(fd);c.h1Catalog?.close();c.h1LibcPins.close();c.pins.close();
    }});fullParents.set(session,revalidate);
    if(c.h1Subject){h1StagedSlot=originalH1StagedSlot(c,session,()=>guestId,originalH1Deadline);fullH1StagedConstructors.set(session,h1StagedSlot.construct);fullH1StagedClosers.set(session,h1StagedSlot.close);fullH1StagedReaders.set(session,h1StagedSlot.read);fullH1PrearmReaders.set(session,h1StagedSlot.snapshot);}
    h1ToolReaders.set(session,(executable,callback)=>{
      revalidate();check(c.tuple.removalCase===FullRemovalCase.ParentCrashH1 && c.tuple.restoreConsumer===FullRestoreConsumer.Ordinary);
      const tool=c.h1Tools.get(executable);check(tool);try{const result=callback(tool);check(!types.isPromise(result));return result;}finally{revalidate();}
    });fullMonitorReaders.set(session,(task)=>{
      if(!monitor || task.processPid!==monitor.pid || task.processBirth!==monitor.start)return undefined;
      revalidate();rejoinMonitor();task.revalidate();
      const taskDirectory=openSync(task.path,constants.O_RDONLY|constants.O_DIRECTORY);
      try{check(retainedFilesystemType(taskDirectory)===0x9fa0n && identity(fstatSync(taskDirectory))===identity(statSync(task.path)));}
      finally{closeSync(taskDirectory);}
      const rawTask=readFileSync(task.path+"/stat","utf8"),taskPid=Number(rawTask.slice(0,rawTask.indexOf(" ")));
      check(Number.isSafeInteger(taskPid) && taskPid>0 && monitorBirth(task.path,taskPid)===task.birth);
      const held=`/proc/self/fd/${monitor.anchor}`;
      check(readFileSync(task.path+"/cgroup").equals(readFileSync(held+"/cgroup")) &&
        readFileSync(task.path+"/cmdline").equals(monitor.command) && identity(statSync(task.path+"/exe"))===monitor.exeIdentity);
      const status=readFileSync(task.path+"/status","utf8");check(new RegExp("^Tgid:\\s+"+monitor.pid+"$","m").test(status) && new RegExp("^Pid:\\s+"+taskPid+"$","m").test(status));check(/^Uid:\s+0\s+0\s+0\s+0$/m.test(status) && /^Gid:\s+0\s+0\s+0\s+0$/m.test(status) && /^NoNewPrivs:\s+1$/m.test(status));
      check(JSON.stringify(caps(status))===JSON.stringify(caps(readFileSync(held+"/status","utf8"))));
      for(const [name,fd] of [["user",monitor.user],["pid",monitor.pidNamespace],["mnt",monitor.mnt]] as const){
        const actual=openSync(task.path+"/ns/"+name,constants.O_RDONLY);
        try{check(identity(fstatSync(actual))===identity(fstatSync(fd)) && retainedFilesystemType(actual)===0x6e736673n);}finally{closeSync(actual);}
      }
      check(identity(statSync(task.path+"/root"))===identity(statSync(held+"/root")));
      const namespace=fstatSync(monitor.mnt);rejoinMonitor();task.revalidate();
      return Object.freeze({pid:monitor.pid,birth:monitor.start,taskBirth:task.birth,invocationId:monitor.invocation,
        sourceBeforeSubmitSha256:monitorSourceBeforeSubmit!,mountNamespace:monitor.mountNamespace,namespaceDevice:String(namespace.dev),namespaceInode:String(namespace.ino)});
    });fullParentDescriptors.set(session,()=>{check(!closed);return c.pins.descriptors().concat(c.h1LibcPins.descriptors(),c.h1Catalog?.descriptors()??[],h1StagedSlot?.descriptors()??[],providerSetupSlot?.descriptors()??[],procFds);});retainedFullParent=session;return session;}catch{for(const fd of procFds.reverse())closeSync(fd);c.h1Catalog?.close();c.h1LibcPins.close();c.pins.close();refuse();}
}

// Complete mount-table bounds, independent of cumulative collector admission caps.
export const fullMountTableBytes=8*1024*1024;
export const fullMountTableRows=32768;
export const fullMountLineBytes=65536;
export enum MountRootKind { Path="path", Namespace="namespace" }
export type MountRoot=Readonly<{kind:MountRootKind.Path;path:string}> |
  Readonly<{kind:MountRootKind.Namespace;name:string;inode:string}>;
export function fullMountPath(value:unknown):string {
  check(typeof value==="string" && value.startsWith("/") && !/\\(?!040|011|012|134)/.test(value));
  return value.replace(/\\(040|011|012|134)/g,(_,digits:string)=>String.fromCharCode(parseInt(digits,8)));
}
/** Linux v6.8 fs/nsfs.c ns_dname uses ns->ops->name and inode->i_ino.
 * fs/proc/namespaces.c lists the finite operations; pid/time child aliases
 * resolve to the original pid/time object's ops, not the proc alias name. */
export function fullMountRoot(value:unknown,filesystem:string):MountRoot {
  check(typeof value==="string");
  if(value.startsWith("/"))return {kind:MountRootKind.Path,path:fullMountPath(value)};
  const ns=/^(cgroup|ipc|mnt|net|pid|time|user|uts):\[([1-9][0-9]{0,19})\]$/.exec(value);
  check(filesystem==="nsfs" && ns && BigInt(ns[2]!)<=18446744073709551615n);
  return {kind:MountRootKind.Namespace,name:ns[1]!,inode:ns[2]!};
}
export function fullMountLines(raw:string):readonly string[] {
  check(Buffer.byteLength(raw)<=fullMountTableBytes && raw.endsWith("\n") && raw.length>1);
  const lines=raw.slice(0,-1).split("\n");
  check(lines.length<=fullMountTableRows && lines.every(line=>line.length>0 && Buffer.byteLength(line)<=fullMountLineBytes));
  return lines;
}
/** Bound allocations and require observed EOF even at the exact table limit. */
export function readFullMountTableBytes(path:string,budget:()=>void=()=>{}):Buffer {
  budget();const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const bytes=Buffer.alloc(fullMountTableBytes+1);let size=0,count=0;
    while((count=readSync(fd,bytes,size,bytes.length-size,null))>0){size+=count;check(size<=fullMountTableBytes);budget();}
    const result=bytes.subarray(0,size);fullMountLines(result.toString("utf8"));return result;
  }finally{closeSync(fd);}
}

export function readFullMountTable(path:string,budget:()=>void=()=>{}):string {
  return readFullMountTableBytes(path,budget).toString("utf8");
}

/** DATA predicate only; it grants no physical protection or launch permission. */
export function fullReadonlyMountData(raw:string,path:string,mountId:string,device:string){
  const ids=new Set<string>();
  const mounts=fullMountLines(raw).map(line=>{
    const fields=line.split(" "),split=fields.indexOf("-");
    check(fields.length>=10 && split>=6 && fields.length===split+4);
    const id=fields[0],parent=fields[1],dev=fields[2],root=fields[3],point=fields[4],options=fields[5];
    check(id && /^[1-9][0-9]{0,19}$/.test(id) && parent && /^[1-9][0-9]{0,19}$/.test(parent) && !ids.has(id));ids.add(id);
    check(dev && /^(?:0|[1-9][0-9]{0,9}):(?:0|[1-9][0-9]{0,9})$/.test(dev));
    const decodedRoot=fullMountRoot(root,fields[split+1]!),decodedPoint=fullMountPath(point);
    check(options && /^(?:[A-Za-z0-9_.=+-]+)(?:,[A-Za-z0-9_.=+-]+)*$/.test(options));
    const flags=options.split(",");check(new Set(flags).size===flags.length && flags.filter(v=>v==="ro" || v==="rw").length===1);
    check(fields.slice(split+1).every(v=>typeof v==="string" && v.length>0));
    return {id,device:dev,root:decodedRoot,point:decodedPoint,readonly:flags.includes("ro")};
  });
  check(mounts.length<=fullMountTableRows);
  const selected=mounts.filter(m=>m.id===mountId);check(selected.length===1);const own=selected[0];check(own && own.device===device);
  const covers=(point:string)=>path===point || path.startsWith(point==="/"?"/":point+"/");
  check(covers(own.point) && own.readonly);
  const covering=mounts.filter(m=>covers(m.point)),longest=Math.max(...covering.map(m=>m.point.length));
  const top=covering.filter(m=>m.point.length===longest);check(top.length===1 && top[0]?.id===mountId);
  check(!mounts.some(m=>m.point.startsWith(path+"/") && !m.readonly));
}
/** Actual retained descriptor mount IDs, device/inode and unchanged complete
 * kernel view are joined before interpreting any readonly observation. */
function assertReadonlyMounts(pins:Pins,paths:readonly string[]){
  const raw=readFullMountTable("/proc/self/mountinfo");
  for(const path of paths){
    const fd=pins.hold(path,true),before=fstatSync(fd,{bigint:true}),info=readFileSync(`/proc/self/fdinfo/${fd}`,"utf8");
    check(Buffer.byteLength(info)<=4096);const ids=[...info.matchAll(/^mnt_id:\s+([1-9][0-9]{0,19})$/gm)],inos=[...info.matchAll(/^ino:\s+([1-9][0-9]{0,19})$/gm)];
    const id=ids[0]?.[1],ino=inos[0]?.[1];check(ids.length===1 && inos.length===1 && id && ino && BigInt(ino)===before.ino);
    const d=before.dev,major=((d&0x00000000000fff00n)>>8n)|((d&0xfffff00000000000n)>>32n),minor=(d&0x00000000000000ffn)|((d&0x00000ffffff00000n)>>12n);
    fullReadonlyMountData(raw,path,id,String(major)+":"+String(minor));
    const after=fstatSync(fd,{bigint:true}),named=lstatSync(path,{bigint:true});check(after.dev===before.dev && after.ino===before.ino && named.dev===before.dev && named.ino===before.ino && !named.isSymbolicLink());
    check(readFileSync(`/proc/self/fdinfo/${fd}`,"utf8")===info);
  }
  check(readFullMountTable("/proc/self/mountinfo")===raw);pins.validate();
}

/** One fixed demand: 8GiB summed caps plus 1GiB host reserve, 14GiB real OS
 * fixture backing. This measures availability, not a reservation or permit. */
function preflightCapacity(baseFd:number){
  const text=readFileSync("/proc/meminfo","utf8");check(Buffer.byteLength(text)<=65536);
  const available=[...text.matchAll(/^MemAvailable:\s+(\d+) kB$/gm)],swap=[...text.matchAll(/^SwapFree:\s+(\d+) kB$/gm)];
  check(available.length===1 && swap.length===1 && available[0]?.[1] && swap[0]?.[1]);
  check(BigInt(available[0][1])*1024n>=9n*1024n*1024n*1024n);check(BigInt(swap[0][1])>=0n);
  const s=fstatSync(baseFd);check(s.isDirectory() && s.uid===0 && s.gid===0 && (s.mode&0o7777)===0o700);
  const fs=statfsSync(`/proc/self/fd/${baseFd}`,{bigint:true});check(fs.bavail*fs.bsize>=14n*1024n*1024n*1024n && fs.ffree>=100000n);
}

/** Actual kernel caps/cgroup values, not a systemd-owned label. Linux UAPI
 * capability positions are fixed here for the reviewed fourteen-cap tuple. */
function assertParentKernelPolicy(group:string){
  const status=readFileSync("/proc/self/status","utf8");check(Buffer.byteLength(status)<=65536);
  for(const [name,expected] of [["CapBnd",0xa82c01fbn],["CapEff",0xa82c01fbn],["CapPrm",0xa82c01fbn],["CapAmb",0n]] as const){const rows=[...status.matchAll(new RegExp("^"+name+":\\s+([a-f0-9]{16})$","gm"))];check(rows.length===1 && rows[0]?.[1]);check(BigInt("0x"+rows[0][1])===expected);}
  check(/^NoNewPrivs:\s+1$/m.test(status));
  for(const [leaf,expected] of [["memory.max","2147483648"],["memory.swap.max","0"],["pids.max","128"],["cpu.max","100000 100000"]] as const)check(readFileSync("/sys/fs/cgroup"+group+"/"+leaf,"utf8").trim()===expected);
}
