import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readHostedPrivateBytes } from "./hosted-private-physical-inputs";
import { assertFullParentProcFiles, type FullParentProcIdentity } from "./hosted-full-backing-proc";

export enum FullBackingInstallationContract { OriginalParentProcV1 = "original_full_parent_proc_v1" }
const runtime = "/opt/subscription-runtime-dependency-os-TEST";
const live = "/var/lib/subscription-runtime-full-parent-live";
const job = "TEST-dependency-full-native-20261007-r1";
const parentUnit = "subscription-job-" + createHash("sha256").update(job).digest("hex") + ".service";
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const encoded = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
function invalid(): never { throw new Error("hosted_full_backing_interval_held"); }
function check(value: unknown): asserts value { if (!value) invalid(); }
function object(value: unknown, keys: string): Record<string, unknown> {
  check(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join(",") === keys.split(",").sort().join(","));
  return value as Record<string, unknown>;
}
export type FullBackingStage = Readonly<{ schemaVersion: 1 | 2; runtimeDirectory: string; runtimeSha: string; runtimeManifestSha256: string; backingInterval?: FullBackingInstallationContract }>;
/** Versioned physical installation fact. Schema1 keeps the existing CLOSED
 * installation contract; the inspected FULL producer always emits schema2.
 * No request flag, environment selector or missing-file fallback chooses it. */
export function readOriginalHostedDependencyBackingStage(): FullBackingStage {
  const directory = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
  const bytes = readHostedPrivateBytes("/run/user/0/subscription-runtime-host-policy/codex-readonly-stages/" + hash(Buffer.from(directory)) + ".json", 4096);
  check(bytes); const value: unknown = JSON.parse(bytes.toString("utf8"));
  check(value !== null && typeof value === "object" && "schemaVersion" in value);
  const row = object(value, value.schemaVersion === 2
    ? "schemaVersion,runtimeDirectory,runtimeSha,runtimeManifestSha256,backingInterval"
    : "schemaVersion,runtimeDirectory,runtimeSha,runtimeManifestSha256");
  check(bytes.equals(encoded(value)) && row.runtimeDirectory === directory &&
    typeof row.runtimeSha === "string" && /^[a-f0-9]{40}$/.test(row.runtimeSha) &&
    typeof row.runtimeManifestSha256 === "string" && /^[a-f0-9]{64}$/.test(row.runtimeManifestSha256));
  if(directory===runtime){
    const fragment=protectedPublic("/etc/systemd/test-units/TEST-retention-supervisor.service",16384),lines=fragment.toString("utf8").split("\n").filter(line=>line.startsWith("ExecStart="));
    check(lines.length===1);
    const full="ExecStart="+runtime+"/toolchain/bin/node --experimental-strip-types "+runtime+"/scripts/dependency-retention-os-test/current-full-supervisor.js supervisor";
    const closed="ExecStart="+runtime+"/toolchain/bin/node --experimental-strip-types "+runtime+"/scripts/dependency-retention-os-test/common.ts supervisor";
    check(lines[0]===full || lines[0]===closed);
    if(lines[0]===full){check(row.schemaVersion===2);const original=originalPair(),sources=original.pair.guestSources;check(Array.isArray(sources));
      const expected=sources.filter(entry=>entry && typeof entry==="object" && "path" in entry && entry.path==="/etc/systemd/test-units/TEST-retention-supervisor.service");
      check(expected.length===1 && object(expected[0],"path,sha256").sha256===hash(fragment));
    }else check(row.schemaVersion===1);
  }
  if (row.schemaVersion === 1) return Object.freeze({schemaVersion:1,runtimeDirectory:directory,runtimeSha:row.runtimeSha,runtimeManifestSha256:row.runtimeManifestSha256});
  check(row.schemaVersion === 2 && directory === runtime && row.backingInterval === FullBackingInstallationContract.OriginalParentProcV1);
  return Object.freeze({schemaVersion:2,runtimeDirectory:directory,runtimeSha:row.runtimeSha,runtimeManifestSha256:row.runtimeManifestSha256,backingInterval:FullBackingInstallationContract.OriginalParentProcV1});
}
function heldMount(fd:number):string {
  const raw=readFileSync(`/proc/self/fdinfo/${fd}`,"utf8"),rows=[...raw.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
  check(Buffer.byteLength(raw)<=4096 && rows.length===1 && rows[0]?.[1]);return rows[0]![1]!;
}
function protectedPublic(path:string,bound:number):Buffer {
  check(realpathSync(path)===path);
  for(let parent=path.slice(0,path.lastIndexOf("/"))||"/";;parent=parent.slice(0,parent.lastIndexOf("/"))||"/"){
    const s=lstatSync(parent);check(s.isDirectory() && !s.isSymbolicLink() && s.uid===0 && s.gid===0 && !(s.mode&0o022));if(parent==="/")break;
  }
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const before=fstatSync(fd),named=lstatSync(path);check(before.isFile() && before.uid===0 && before.gid===0 && before.nlink===1 && !(before.mode&0o022) && before.size>0 && before.size<=bound && before.dev===named.dev && before.ino===named.ino);
    const bytes=readFileSync(fd),after=lstatSync(path);check(bytes.length===before.size && after.dev===before.dev && after.ino===before.ino && after.ctimeMs===before.ctimeMs && after.mtimeMs===before.mtimeMs);
    const fresh=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const named=fstatSync(fresh);check(named.dev===before.dev && named.ino===before.ino && named.ctimeMs===before.ctimeMs && named.mtimeMs===before.mtimeMs && named.nlink===1 && heldMount(fresh)===heldMount(fd) && readFileSync(fresh).equals(bytes));}finally{closeSync(fresh);}
    return bytes;
  }finally{closeSync(fd);}
}
function protectedJson(path: string): { bytes: Buffer; value: unknown } {
  check(realpathSync(path) === path);
  const bytes = readHostedPrivateBytes(path, 16384); check(bytes);
  const value: unknown = JSON.parse(bytes.toString("utf8")); check(bytes.equals(encoded(value)));
  return { bytes, value };
}
function procIdentity(value: unknown): Readonly<{ dev: string; ino: string }> {
  const row = object(value, "dev,ino");
  check(typeof row.dev === "string" && /^[1-9][0-9]*$/.test(row.dev) && typeof row.ino === "string" && /^[1-9][0-9]*$/.test(row.ino));
  return { dev: row.dev, ino: row.ino };
}
function uniqueReadonlyBind(path: string, target: Readonly<{ dev: string; ino: string }>): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    check(!named.isSymbolicLink() && stat.dev === named.dev && stat.ino === named.ino && String(stat.dev) === target.dev && String(stat.ino) === target.ino);
    const info = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"), rows = [...info.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)], id=rows[0]?.[1];
    check(Buffer.byteLength(info) <= 4096 && rows.length === 1 && id);
    const raw = readFileSync("/proc/self/mountinfo", "utf8"); check(Buffer.byteLength(raw) <= 1024 * 1024 && raw.endsWith("\n"));
    const mounts = raw.trimEnd().split("\n").map(line => line.split(" "));
    const namedRows = mounts.filter(row => row[4] === path), row=namedRows[0];
    check(namedRows.length === 1 && row && row[0] === id && row[5]?.split(",").includes("ro"));
    const separator=row.indexOf("-");check(separator>=6 && row[separator+1] === "proc" && !mounts.some(entry => entry[4]?.startsWith(path + "/")));
    // This is a proc bind/liveness join, never MNT_LOCK_READONLY evidence.
  } finally { closeSync(fd); }
}
function originalPair() {
  const pairFile=protectedJson(live+"/seals/current-full-pair.json"), invocationFile=protectedJson(live+"/seals/current-full-pair-invocation.json");
  const pair=object(pairFile.value,"schemaVersion,jobId,parentUnit,parentInvocationId,guestMachineId,parentProc,guestSources,unit,fragmentSha256,root,rootDev,rootIno,machineId,bootId,sourceSha");
  const invocation=object(invocationFile.value,"schemaVersion,pairSha256,parentInvocationId,unit,guestInvocationId");
  check(pair.schemaVersion===2 && pair.jobId===job && pair.parentUnit===parentUnit &&
    typeof pair.parentInvocationId==="string" && /^[a-f0-9]{32}$/.test(pair.parentInvocationId) &&
    typeof pair.unit==="string" && /^TEST-retention-os-[0-9a-f-]{36}\.service$/.test(pair.unit) &&
    typeof pair.sourceSha==="string" && /^[a-f0-9]{40}$/.test(pair.sourceSha));
  check(invocation.schemaVersion===1 && invocation.pairSha256===hash(pairFile.bytes) && invocation.parentInvocationId===pair.parentInvocationId && invocation.unit===pair.unit &&
    typeof invocation.guestInvocationId==="string" && /^[a-f0-9]{32}$/.test(invocation.guestInvocationId));
  const parent=object(pair.parentProc,"pid,startTicks,stat,status,capabilities");
  check(Number.isSafeInteger(parent.pid) && Number(parent.pid)>0 && typeof parent.startTicks==="string" && /^[1-9][0-9]*$/.test(parent.startTicks));
  check(Array.isArray(parent.capabilities) && parent.capabilities.length===5 && parent.capabilities.every(cap=>typeof cap==="string" && /^[a-f0-9]{16}$/.test(cap)));
  const expected:FullParentProcIdentity={pid:Number(parent.pid),startTicks:parent.startTicks,stat:procIdentity(parent.stat),status:procIdentity(parent.status),capabilities:parent.capabilities as string[]};
  uniqueReadonlyBind(live+"/stat",expected.stat);uniqueReadonlyBind(live+"/status",expected.status);
  assertFullParentProcFiles(live+"/stat",live+"/status",expected);
  const root=lstatSync("/",{bigint:true});check(String(root.dev)===pair.rootDev && String(root.ino)===pair.rootIno);
  check(readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()===pair.bootId && readFileSync("/etc/machine-id","utf8").trim()===pair.guestMachineId);
  return {pairFile,invocationFile,pair,invocation,expected};
}
/** Finite trusted FULL installer entrypoint prerequisite. Only physical facts;
 * the caller still uses the original installation store to create its origin. */
export function assertOriginalFullBackingPreparation(): void {
  const current=originalPair();
  check(process.execPath===runtime+"/toolchain/bin/node" && process.argv.length===3 && process.argv[1]===runtime+"/scripts/dependency-retention-os-test/current-full-guest.js" && process.argv[2]==="qualify");
  check(process.env.TEST_SOURCE_SHA===current.pair.sourceSha && readlinkSync("/proc/self/exe")===process.execPath && readFileSync("/proc/self/cmdline").equals(Buffer.from([...process.argv,""].join("\u0000"))));
  const sources=current.pair.guestSources;check(Array.isArray(sources));
  for(const path of [process.execPath,process.argv[1]]) {
    const rows=sources.filter(entry=>entry && typeof entry==="object" && "path" in entry && entry.path===path);check(rows.length===1);
    const row=object(rows[0],"path,sha256");check(hash(protectedPublic(path,128*1024*1024))===row.sha256);
    if(path===process.execPath){const held=openSync("/proc/self/exe",constants.O_RDONLY);try{const kernel=fstatSync(held),named=lstatSync(path);check(kernel.dev===named.dev && kernel.ino===named.ino);}finally{closeSync(held);}}
  }
  assertFullParentProcFiles(live+"/stat",live+"/status",current.expected);
}
// Read-only physical helpers shared with the original access/fence-guarded interval.
// No outbox, issuer, private access symbol or interval effect enters this module.
export { live, hash, encoded, check, object, procIdentity, protectedJson, originalPair };
