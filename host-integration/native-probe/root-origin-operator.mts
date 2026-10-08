import { spawn } from "node:child_process";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, readSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { retainedResourceCanonicalJson, retainedResourceDigest } from "../../src/core/scoped-retained-resource-contract.js";
import { NativeProbeKind, NativeProbeOperation, NativeProbeProfile, validateProbeAllocation, type NativeProbeAllocation } from "../../src/worker-core/hosted-custody/domain/native-probe.js";
import { requestOriginalData } from "../../src/hosted-native-probe/original-owner-client.js";
const installation = "/opt/subscription-runtime/native-probe";
const directory = "/run/subscription-runtime/native-probe/original";
const permitPath = "/run/subscription-runtime/native-probe/admin-permit.json";
const manifestPath = join(installation, "root-installation.json");
export const originalA0Profile = Object.freeze({version:1,kind:"NativeOriginalA0",effects:Object.freeze(["principal","managed-pidfd-scope","private-root","sealed-helper","start-status-stop","original-wait-stream-manager-reference-closure"]),source:false,work:false});
export const originalA0Inventory = Object.freeze({roles:Object.freeze(["principal","root","helper"]),tasks:32,threads:8,messages:1024,journalEntries:1024,declarations:3,targets:1});
const roles = [join(installation, "root-producer-entry"), join(installation, "test-root/opt/native/node"), join(installation, "test-root/opt/native/original-owner-helper.mjs"), join(installation, "test-root/opt/native/original-owner-associated.node"), "/usr/bin/dbus-daemon", join(installation, "admin/host-integration/native-probe/root-origin-operator.mjs")] as const;
const second = 1_000_000_000n, max = (1n << 63n) - 1n;
export interface InstallationFile { readonly path: string; readonly bytes: number; readonly mode: number; readonly sha256: string }
interface InstallationManifest { readonly version: 1; readonly profile: "NativeOriginalA0"; readonly daemonUid: number; readonly daemonGid: number; readonly files: readonly InstallationFile[] }
interface Permit { readonly version: 1; readonly kind: "NativeOriginalA0"; readonly jobId: string; readonly machineId: string; readonly installationDigest: string; readonly profileDigest: string; readonly manifestDigest: string; readonly notBeforeNs: string; readonly workEndNs: string; readonly cleanupEndNs: string; readonly coldEndNs: string }
interface Context { readonly permit: Permit; readonly operationDigest: string; readonly anchor: bigint; readonly work: bigint; readonly cleanup: bigint; readonly cold: bigint }
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
function manifest(value: unknown): InstallationManifest {
  if (!value || typeof value !== "object") throw new Error("missing installation");
  exactKeys(value, ["version", "profile", "daemonUid", "daemonGid", "files"]);
  const m = value as InstallationManifest;
  if (m.version !== 1 || m.profile !== "NativeOriginalA0" || !Number.isSafeInteger(m.daemonUid) || !Number.isSafeInteger(m.daemonGid) || m.daemonUid < 0 || m.daemonGid < 0 || m.daemonUid > 0xffffffff || m.daemonGid > 0xffffffff || !Array.isArray(m.files) || m.files.length < roles.length || m.files.length > 128) throw new Error("unsupported installation");
  const paths = new Set<string>();
  for (const [i, f] of m.files.entries()) {
    exactKeys(f, ["path", "bytes", "mode", "sha256"]);
    if (typeof f.path !== "string" || paths.has(f.path) || Buffer.byteLength(f.path) > 255 || (!f.path.startsWith(installation + "/") && f.path !== roles[4] && !f.path.startsWith("/usr/lib/") && f.path !== "/usr/bin/node" && f.path !== "/opt/subscription-runtime/runtime/node") || (i < roles.length && f.path !== roles[i]) || !Number.isSafeInteger(f.bytes) || f.bytes <= 0 || !Number.isSafeInteger(f.mode) || (f.mode & 0o022) || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new Error("invalid installed census");
    if(f.path.startsWith(installation+"/test-root/")){
      const relative=f.path.slice((installation+"/test-root").length);
      if(!roles.slice(1,4).includes(f.path as typeof roles[1])&&!/^\/(?:usr\/)?lib(?:64)?\/.+\.so(?:\.[0-9]+)*$/.test(relative))throw new Error("foreign private TEST image input");
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
function permit(value: unknown): Permit {
  if (!value || typeof value !== "object") throw new Error("missing finite operation");
  exactKeys(value, ["version", "kind", "jobId", "machineId", "installationDigest", "profileDigest", "manifestDigest", "notBeforeNs", "workEndNs", "cleanupEndNs", "coldEndNs"]);
  const p = value as Permit;
  if (p.version !== 1 || p.kind !== "NativeOriginalA0" || !/^[a-z][a-z0-9-]{0,31}$/.test(p.jobId) || !/^[a-f0-9]{32}$/.test(p.machineId) || [p.installationDigest,p.profileDigest,p.manifestDigest].some(x => !/^[a-f0-9]{64}$/.test(x))) throw new Error("invalid finite operation");
  for (const x of [p.notBeforeNs,p.workEndNs,p.cleanupEndNs,p.coldEndNs]) time(x);
  return p;
}
export function buildOriginalAllocation(snapshot: Buffer, context: Context): NativeProbeAllocation {
  if (snapshot.some((byte,i)=>i>=56&&i<376&&byte>127))throw new Error("non-ASCII snapshot identity");
  if (snapshot.length !== 384 || !snapshot.subarray(0,8).equals(Buffer.from("NPSNAP01"))) throw new Error("invalid native snapshot");
  const text = (offset: number, size: number): string => snapshot.subarray(offset,offset+size).toString("ascii").replace(/\0+$/, "");
  const generation = snapshot.readBigUInt64BE(8), anchor = snapshot.readBigUInt64BE(16), work = snapshot.readBigUInt64BE(24), cleanup = snapshot.readBigUInt64BE(32), cold = snapshot.readBigUInt64BE(40), outer = snapshot.readBigUInt64BE(48);
  if (!generation || anchor < context.anchor || anchor > max - 180n*second || work !== (context.work < anchor+120n*second ? context.work : anchor+120n*second) || cleanup !== (context.cleanup-5n*second < anchor+180n*second ? context.cleanup-5n*second : anchor+180n*second) || cold !== (context.cold < anchor+10n*second ? context.cold : anchor+10n*second) || cold <= anchor || cold > work || cleanup <= work || outer !== context.cleanup || text(56,64) !== context.operationDigest || text(120,32) !== context.permit.machineId || text(152,32) !== context.permit.jobId || text(184,64) !== context.permit.installationDigest || text(248,64) !== context.permit.profileDigest || text(312,64) !== context.permit.manifestDigest || snapshot.subarray(376).some(x => x !== 0)) throw new Error("changed original snapshot");
  const lifetime = `native-${generation.toString(16)}`;
  const allocation: NativeProbeAllocation = Object.freeze({ version: 1, kind: NativeProbeKind.NativeProbe, profile: NativeProbeProfile.OriginalFoundationV1, jobId: context.permit.jobId, machineId: context.permit.machineId, installationDigest: context.permit.installationDigest, profileDigest: context.permit.profileDigest, manifestDigest: context.permit.manifestDigest, issuanceAnchorNs: anchor.toString(), preparationEndNs: (anchor+120n*second).toString(), absoluteCleanupEndNs: (anchor+180n*second).toString(), cleanupReservation: `${lifetime}-cleanup`, declarations: Object.freeze(["principal","root","helper"].map((role, ordinal) => Object.freeze({ identity: `${lifetime}-${role}`, ordinal, lifetime, parent: ordinal ? `${lifetime}-${ordinal === 1 ? "principal" : "root"}` : null, workEndNs: work.toString(), cleanupEndNs: (ordinal ? cleanup : (outer < anchor+180n*second ? outer : anchor+180n*second)).toString() }))), limits: Object.freeze({ infrastructureTasks: 32, infrastructureThreads: 8, messages: 1024, journalEntries: 1024, declarations: 3, targets: 1 }) });
  validateProbeAllocation(allocation); return allocation;
}
export function encodeAllocationAck(snapshot: Buffer, allocation: NativeProbeAllocation): Buffer {
  validateProbeAllocation(allocation);
  const canonical = Buffer.from(retainedResourceCanonicalJson(allocation) + "\n"), digest = retainedResourceDigest(allocation);
  const payload = Buffer.concat([snapshot, Buffer.from(digest,"ascii"), canonical]);
  if (payload.length > 16384) throw new Error("allocation phase capacity");
  const header = Buffer.alloc(24); header.write("NPA5"); header[4]=2; header[5]=1; header.writeBigUInt64BE(BigInt(payload.length),8); header.writeBigUInt64BE(snapshot.readBigUInt64BE(8),16);
  return Buffer.concat([header,payload]);
}
async function phase(stream: Duplex, context: Context, end: bigint): Promise<NativeProbeAllocation> {
  let originalGeneration=0n;
  let bytes: Buffer = Buffer.alloc(0); let stage = 1, allocation: NativeProbeAllocation | undefined;
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
        const length=bytes.readBigUInt64BE(8); if(length>16384n || !bytes.subarray(0,4).equals(Buffer.from("NPA5")) || bytes[4]!==stage || bytes[5]!==1 || bytes[6]!==0 || bytes[7]!==0)throw new Error("invalid phase frame");
        if(bytes.length<24+Number(length))return;
        if(bytes.length!==24+Number(length))throw new Error("extra phase frame");
        const payload=bytes.subarray(24), generation=bytes.readBigUInt64BE(16);bytes=Buffer.alloc(0);
        if(stage===1){if(payload.length!==384 || generation!==payload.readBigUInt64BE(8))throw new Error("snapshot generation");originalGeneration=generation;allocation=buildOriginalAllocation(payload,context);now();stream.write(encodeAllocationAck(payload,allocation));stage=3;}
        else {if(!allocation || generation!==originalGeneration || !payload.equals(Buffer.from(retainedResourceDigest(allocation),"ascii")))throw new Error("freeze digest mismatch");now();stage=4;clearTimeout(timer);stream.removeAllListeners("data");accept(allocation);}
      } catch(error){fail(error instanceof Error?error:new Error(String(error)));}
    });
  });
}
function durable(path: string, bytes: Buffer): number { const fd = openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600); if(writeSync(fd,bytes)!==bytes.length)throw new Error("short original journal write");fsyncSync(fd);return fd; }
export async function runOriginalRootOperation(): Promise<void> {
  if (process.argv.length!==2 || process.getuid?.()!==0 || process.getgid?.()!==0) throw new Error("fixed Root administrative invocation required");
  const anchor=process.hrtime.bigint(); const held: number[]=[];
  const permitFd=heldFile(permitPath,true), manifestFd=heldFile(manifestPath);held.push(permitFd,manifestFd);
  const p=permit(boundedJson(permitFd,8192)), m=manifest(boundedJson(manifestFd,65536));
  if(p.profileDigest!==retainedResourceDigest(originalA0Profile)||p.manifestDigest!==retainedResourceDigest(originalA0Inventory))throw new Error("wrong fixed A0 effect list/inventory");
  if(p.machineId!==readFileSync("/etc/machine-id","utf8").trim() || retainedResourceDigest(m)!==p.installationDigest)throw new Error("wrong installation/host");
  const minimum=(a: bigint,b: bigint): bigint => a<b?a:b;
  const work=minimum(time(p.workEndNs),anchor+120n*second), cleanup=minimum(time(p.cleanupEndNs),anchor+180n*second), cold=minimum(time(p.coldEndNs),minimum(anchor+10n*second,work));
  if(anchor<time(p.notBeforeNs)||cleanup<=work+5n*second||cold<=anchor)throw new Error("invalid enclosing original limits");
  const context: Context={permit:p,anchor,work,cleanup,cold,operationDigest:retainedResourceDigest({permit:p,anchorNs:anchor.toString(),workNs:work.toString(),cleanupNs:cleanup.toString(),coldNs:cold.toString()})};
  const mapped=readFileSync("/proc/self/maps","utf8").split("\n").flatMap(line=>{const match=/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line);return match?[match[1]!]:[];});
  const measuredPaths=new Set(m.files.map(file=>file.path));
  if(mapped.some(path=>!measuredPaths.has(path)))throw new Error("omitted original observer loader/library closure");
  const files: number[]=[];
  for(const row of m.files){const fd=heldFile(row.path);files.push(fd);held.push(fd);const before=fstatSync(fd,{bigint:true});const stat=fstatSync(fd);if(stat.size!==row.bytes||(stat.mode&0o7777)!==row.mode)throw new Error("installation metadata");const digest=createHash("sha256"), chunk=Buffer.alloc(65536);let offset=0;for(;;){const n=readSync(fd,chunk,0,chunk.length,offset);if(!n)break;digest.update(chunk.subarray(0,n));offset+=n;}checked(fd,row.path);const after=fstatSync(fd,{bigint:true});if(before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||before.size!==after.size||before.mode!==after.mode)throw new Error("installed bytes changed while measured");if(digest.digest("hex")!==row.sha256)throw new Error("installation digest");}
  const record=Buffer.alloc(512+296*files.length);record.write("NPADM001");for(const [offset,n] of [[8,anchor],[16,work],[24,cleanup],[32,cold],[40,BigInt(process.pid)],[408,BigInt(m.daemonUid)],[416,BigInt(m.daemonGid)],[424,BigInt(files.length)]] as const)record.writeBigUInt64BE(n,offset);
  const boot=readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim();
  for(const [offset,value] of [[48,p.jobId],[80,p.machineId],[112,boot],[148,context.operationDigest],[212,p.installationDigest],[276,p.profileDigest],[340,p.manifestDigest]] as const)record.write(value,offset,"ascii");
  for(const [i,fd] of files.entries()){const stat=fstatSync(fd,{bigint:true}),offset=512+296*i;record.write(m.files[i]!.path,offset,"utf8");record.writeBigUInt64BE(stat.dev,offset+256);record.writeBigUInt64BE(stat.ino,offset+264);record.writeBigUInt64BE(stat.size,offset+272);record.writeBigUInt64BE(stat.mode&0o7777n,offset+280);}
  ancestors(join(directory,"bootstrap.bin"));const leaf=lstatSync(directory);if(!leaf.isDirectory()||leaf.uid!==0||leaf.gid!==0||(leaf.mode&0o777)!==0o700)throw new Error("private operation directory");
  const writeFd=durable(join(directory,"bootstrap.bin"),record);closeSync(writeFd);const recordFd=heldFile(join(directory,"bootstrap.bin"),true),directoryFd=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);held.push(recordFd,directoryFd);
  for(let path=directory;;path=dirname(path)){const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);fsyncSync(fd);closeSync(fd);if(path==="/")break;}
  if(process.hrtime.bigint()>=cold)throw new Error("original bootstrap expired");
  const phaseEnd=minimum(process.hrtime.bigint()+2n*second,cold);
  // Every native inherited descriptor is already admitted and held; no env selector.
  const child=spawn(roles[0],[],{env:{PATH:"/usr/bin:/bin"},stdio:["pipe","pipe","pipe","pipe",recordFd,manifestFd,directoryFd,...files]});
  const channel=child.stdio[3];if(!(channel instanceof Duplex))throw new Error("missing original observer channel");
  let exit: {code: number|null;signal: NodeJS.Signals|null}|undefined, stdoutEof=false,stderrEof=false,raw:Buffer=Buffer.alloc(0),stderr:Buffer=Buffer.alloc(0),ready=false;
  let failure: unknown;
  let readyResolve: (()=>void)|undefined;const readyPromise=new Promise<void>(accept=>{readyResolve=accept;});
  child.stdout!.on("data",(chunk:Buffer)=>{if(raw.length+chunk.length>65536){failure=new Error("original stdout capacity");child.kill("SIGTERM");return;}raw=Buffer.concat([raw,chunk]);if(!ready&&raw.toString("utf8").split("\n").includes('{"stage":"origin-ready"}')){ready=true;readyResolve?.();}});
  child.stderr!.on("data",(chunk:Buffer)=>{if(stderr.length+chunk.length>65536){failure=new Error("original stderr capacity");child.kill("SIGTERM");return;}stderr=Buffer.concat([stderr,chunk]);});
  child.stdout!.once("end",()=>{stdoutEof=true;});child.stderr!.once("end",()=>{stderrEof=true;});
  child.once("exit",(code,signal)=>{exit={code,signal};});
  const closed=new Promise<void>((accept,reject)=>{child.once("close",()=>accept());child.once("error",reject);});
  const killTimer=setTimeout(()=>child.kill("SIGKILL"),Math.max(1,Number((cleanup-process.hrtime.bigint())/1_000_000n)));
  try {
    const allocation=await phase(channel,context,phaseEnd);
    const timer=setTimeout(()=>readyResolve?.(),Math.max(1,Number((cold-process.hrtime.bigint())/1_000_000n)));
    await readyPromise;clearTimeout(timer);if(!ready||process.hrtime.bigint()>=cold)throw new Error("original producer did not become ready");
    const request={kind:NativeProbeKind.NativeProbe,operation:NativeProbeOperation.Start,jobId:p.jobId,machineId:p.machineId,allocationDigest:retainedResourceDigest(allocation)};
    try { await requestOriginalData(request); await requestOriginalData({...request,operation:NativeProbeOperation.Status}); }
    finally { await requestOriginalData({...request,operation:NativeProbeOperation.Stop}); }
  } catch(error){failure=error;child.stdin!.end();child.kill("SIGTERM");}
  await closed;clearTimeout(killTimer);
  closeSync(durable(join(directory,"principal.stdout"),raw));closeSync(durable(join(directory,"principal.stderr"),stderr));
  const lines=raw.toString("utf8").trim().split("\n");let native:unknown;try{native=JSON.parse(lines.at(-1)??"");}catch{native=null;}
  const finalNow=process.hrtime.bigint();
  const result={status:finalNow>=anchor&&finalNow<cleanup&&!failure&&exit?.code===0&&exit.signal===null&&stdoutEof&&stderrEof&&native&&typeof native==="object"&&"status" in native&&native.status==="NATIVE_DEBTS_CLOSED_PRINCIPAL_TERMINAL_PENDING"?"ORIGINAL_PRODUCER_L0_RAW":"UNKNOWN_HELD",principalExit:exit??null,stdoutEof,stderrEof,native,error:failure instanceof Error?failure.message:failure?String(failure):null};
  const resultFd=durable(join(directory,"l0.json"),Buffer.from(retainedResourceCanonicalJson(result)+"\n"));closeSync(resultFd);fsyncSync(directoryFd);
  for(const fd of held)closeSync(fd);process.stdout.write(retainedResourceCanonicalJson(result)+"\n");if(result.status!=="ORIGINAL_PRODUCER_L0_RAW")process.exitCode=77;
}
if(resolve(process.argv[1]??"")===fileURLToPath(import.meta.url))runOriginalRootOperation().catch(error=>{process.stderr.write(String(error)+"\n");process.exitCode=77;});
