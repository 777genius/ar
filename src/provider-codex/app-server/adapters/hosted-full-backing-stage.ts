import { OriginalFullProjectControlPreparedCase, OriginalFullPeerPreloadSelectionKind, originalFullProjectControlPreloadData, type OriginalFullPeerPreloadSelection, originalFullProjectControlSourcePaths, originalFullProjectControlPeerMetadataPaths, originalFullProjectControlEntrySourcePaths } from "./hosted-project-control-source-catalog.js";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readHostedHeldRegularBytes, readHostedPrivateBytes } from "./hosted-private-physical-inputs.js";
import { assertFullParentProcFiles, type FullParentProcIdentity } from "./hosted-full-backing-proc.js";

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
    check(lines[0]===full || lines[0]===full+" --parent-crash-h1" || lines[0]===closed);
    if(lines[0]!==closed){check(row.schemaVersion===2);const original=originalPair(),sources=original.pair.guestSources;check(Array.isArray(sources));
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
  check(pairFile.value !== null && typeof pairFile.value === "object" && Object.getPrototypeOf(pairFile.value) === Object.prototype);
  const stagedH1 = Object.hasOwn(pairFile.value, "removalCase");
  const pair=object(pairFile.value,"schemaVersion,jobId,parentUnit,parentInvocationId,guestMachineId,parentProc,guestSources,unit,fragmentSha256,root,rootDev,rootIno,machineId,bootId,sourceSha" + (stagedH1 ? ",removalCase,restoreConsumer" : ""));
  const removalCase = stagedH1 ? OriginalFullProjectControlPreparedCase.ParentCrashH1 : OriginalFullProjectControlPreparedCase.Positive;
  if (stagedH1) check(pair.removalCase === OriginalFullProjectControlPreparedCase.ParentCrashH1 && pair.restoreConsumer === "ordinary");
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
  const fragmentPath = "/etc/systemd/test-units/TEST-retention-supervisor.service", fragment = protectedPublic(fragmentPath, 16384);
  check(Array.isArray(pair.guestSources));
  const selected = pair.guestSources.filter(value => value && typeof value === "object" && "path" in value && value.path === fragmentPath);
  check(selected.length === 1 && object(selected[0], "path,sha256").sha256 === hash(fragment));
  const lines = fragment.toString("utf8").split("\n").filter(line => line.startsWith("ExecStart="));
  const caseArguments = removalCase === OriginalFullProjectControlPreparedCase.ParentCrashH1 ? ["--parent-crash-h1"] : [];
  check(lines.length === 1 && lines[0] === "ExecStart=" + [runtime + "/toolchain/bin/node", "--experimental-strip-types", runtime + "/scripts/dependency-retention-os-test/current-full-supervisor.js", "supervisor", ...caseArguments].join(" "));
  return {pairFile,invocationFile,pair,invocation,expected,removalCase,caseArguments};
}
/** Finite trusted FULL installer entrypoint prerequisite. Only physical facts;
 * the caller still uses the original installation store to create its origin. */
export function assertOriginalFullBackingPreparation(): void {
  const current=originalPair();
  check(process.execPath===runtime+"/toolchain/bin/node" && process.argv.length===3+current.caseArguments.length && process.argv[1]===runtime+"/scripts/dependency-retention-os-test/current-full-guest.js" && process.argv[2]==="qualify" && JSON.stringify(process.argv.slice(3))===JSON.stringify(current.caseArguments));
  check(process.env.TEST_SOURCE_SHA===current.pair.sourceSha && readlinkSync("/proc/self/exe")===process.execPath && readFileSync("/proc/self/cmdline").equals(Buffer.from([...process.argv,""].join("\u0000"))));
  const sources=current.pair.guestSources;check(Array.isArray(sources));
  for(const path of [process.execPath,process.argv[1]]) {
    const rows=sources.filter(entry=>entry && typeof entry==="object" && "path" in entry && entry.path===path);check(rows.length===1);
    const row=object(rows[0],"path,sha256");check(hash(protectedPublic(path,128*1024*1024))===row.sha256);
    if(path===process.execPath){const held=openSync("/proc/self/exe",constants.O_RDONLY);try{const kernel=fstatSync(held),named=lstatSync(path);check(kernel.dev===named.dev && kernel.ino===named.ino);}finally{closeSync(held);}}
  }
  assertFullParentProcFiles(live+"/stat",live+"/status",current.expected);
}
export enum OriginalFullProjectControlEntryRole { Guest = "original_full_guest", Supervisor = "original_full_supervisor", PeerQuery = "original_full_peer_query" }
export enum OriginalFullProjectControlDescriptorKind { Source = "source", ProcAnchor = "proc_anchor", Executable = "executable" }
export type OriginalFullProjectControlDescriptor = Readonly<{ fd: number; path: string; kind: OriginalFullProjectControlDescriptorKind; dev: string; ino: string; mountId: string }>;
export type OriginalFullProjectControlEntry = Readonly<{ role: OriginalFullProjectControlEntryRole; preparedCase: OriginalFullProjectControlPreparedCase;
  processPid: number; processBirth: string; callerPid: number; callerBirth: string; sourceSha: string; guestUnit: string; guestInvocationId: string;
  parentUnit: string; parentInvocationId: string; parentBirth: string; descriptors(): readonly OriginalFullProjectControlDescriptor[]; revalidate(): void; close(): void }>;
const projectControlEntries = new WeakMap<object, Readonly<{ descriptors(): readonly OriginalFullProjectControlDescriptor[]; revalidate(): void; close(): void }>>();
// A finite source closure, selected and held by the original HOST constructor
// before guest submission. Missing planned SDK modules keep this entry Held.
export { originalFullProjectControlSourcePaths, originalFullProjectControlPeerMetadataPaths, originalFullProjectControlEntrySourcePaths } from "./hosted-project-control-source-catalog.js";
function retainProjectControlEntry(role: OriginalFullProjectControlEntryRole): OriginalFullProjectControlEntry {
  check(process.platform === "linux" && process.getuid?.() === 0 && process.getgid?.() === 0);
  const program = runtime + "/scripts/dependency-retention-os-test/current-full-" +
    (role === OriginalFullProjectControlEntryRole.Guest ? "guest.js" : role === OriginalFullProjectControlEntryRole.Supervisor ? "supervisor.js" : "peer-query.js"),
    mode = role === OriginalFullProjectControlEntryRole.Guest ? "qualify" : role === OriginalFullProjectControlEntryRole.Supervisor ? "supervisor" : "query-peer",
    flags = role === OriginalFullProjectControlEntryRole.Supervisor ? ["--experimental-strip-types"] : [];
  // The fourth H1 argument is selected from the original sealed case and
  // exact original unit fragment, never from argv or environment preference.
  const current = originalPair(), caseArguments = role === OriginalFullProjectControlEntryRole.PeerQuery ? [] : current.caseArguments;
  const command = Buffer.from([runtime + "/toolchain/bin/node", ...flags, program, mode, ...caseArguments, ""].join("\0"));
  check(process.execPath === runtime + "/toolchain/bin/node" && process.argv.length === 3 + caseArguments.length && process.argv[1] === program &&
    process.argv[2] === mode && JSON.stringify(process.argv.slice(3)) === JSON.stringify(caseArguments) && JSON.stringify(process.execArgv) === JSON.stringify(flags));
  check(process.env.TEST_SOURCE_SHA === current.pair.sourceSha);
  const owned: number[] = [], handles: {fd: number; path: string; kind: OriginalFullProjectControlDescriptorKind}[] = [], pins: { path: string; fd: number; bytes: Buffer; dev: number; ino: number; mount: string }[] = [];
  const own = (path: string, options: number) => { const fd = openSync(path, options); owned.push(fd); handles.push({fd,path,kind:path.startsWith("/proc/") ? path.endsWith("/exe") ? OriginalFullProjectControlDescriptorKind.Executable : OriginalFullProjectControlDescriptorKind.ProcAnchor : OriginalFullProjectControlDescriptorKind.Source}); return fd; };
  let active = true;
  const close = () => { check(active); active = false; for (const fd of owned.reverse()) closeSync(fd); };
  try {
    const sources = current.pair.guestSources; check(Array.isArray(sources));
    for (const path of originalFullProjectControlEntrySourcePaths) {
      const selected = sources.filter(row => row && typeof row === "object" && "path" in row && row.path === path);
      check(selected.length === 1); const row = object(selected[0], "path,sha256"), bytes = protectedPublic(path, 128 * 1024 * 1024);
      check(hash(bytes) === row.sha256);
      const fd = own(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), stat = fstatSync(fd);
      check(readHostedHeldRegularBytes(fd, 128 * 1024 * 1024).equals(bytes)); pins.push({ path, fd, bytes, dev: stat.dev, ino: stat.ino, mount: heldMount(fd) });
    }
    const proc = own("/proc/" + process.pid, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
      exe = own("/proc/self/exe", constants.O_RDONLY), procStat = fstatSync(proc), exeStat = fstatSync(exe),
      group = readFileSync("/proc/self/cgroup"), status = readFileSync("/proc/self/status", "utf8"),
      birth = () => { const raw = readFileSync("/proc/self/fd/" + proc + "/stat", "utf8"), at = raw.lastIndexOf(") "),
        fields = raw.slice(at + 2).trim().split(/\s+/); check(raw.startsWith(process.pid + " (") && at > 0 &&
          !["Z", "X", "x"].includes(fields[0] ?? "") && /^[1-9][0-9]*$/.test(fields[19] ?? "")); return process.pid + ":" + fields[19]; },
      processBirth = birth(), parentPid = Number(/^PPid:\s+([1-9][0-9]*)$/m.exec(status)?.[1]);
    check(Number.isSafeInteger(parentPid) && parentPid > 0 && group.equals(Buffer.from("0::/system.slice/TEST-retention-supervisor.service\n")) &&
      /^Uid:\s+0\s+0\s+0\s+0$/m.test(status) && /^Gid:\s+0\s+0\s+0\s+0$/m.test(status) && /^NoNewPrivs:\s+1$/m.test(status));
    const parent = own("/proc/" + parentPid, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
      parentStat = fstatSync(parent), parentPath = "/proc/self/fd/" + parent,
      parentCommand = readFileSync(parentPath + "/cmdline"), parentStatus = readFileSync(parentPath + "/status", "utf8"),
      parentExe = own(parentPath + "/exe", constants.O_RDONLY), parentExeStat = fstatSync(parentExe), parentTicks = readFileSync(parentPath + "/stat", "utf8");
    const parentBirth = parentTicks.slice(parentTicks.lastIndexOf(") ") + 2).trim().split(/\s+/)[19]; check(parentBirth && /^[1-9][0-9]*$/.test(parentBirth));
    const supervisorCommand = Buffer.from([process.execPath, "--experimental-strip-types", runtime + "/scripts/dependency-retention-os-test/current-full-supervisor.js", "supervisor", ...current.caseArguments, ""].join("\0"));
    const guestCommand = Buffer.from([process.execPath, runtime + "/scripts/dependency-retention-os-test/current-full-guest.js", "qualify", ...current.caseArguments, ""].join("\0"));
    let rejoinGrandparent = () => {};
    if (role === OriginalFullProjectControlEntryRole.Supervisor) check(parentPid === 1 && readlinkSync(parentPath + "/exe") === "/usr/lib/systemd/systemd");
    else {
      check(readlinkSync(parentPath + "/exe") === process.execPath && readFileSync(parentPath + "/cgroup").equals(group));
      if (parentCommand.equals(supervisorCommand)) check(/^PPid:\s+1$/m.test(parentStatus));
      else {
        check(role === OriginalFullProjectControlEntryRole.PeerQuery && parentCommand.equals(guestCommand));
        const ancestorPid = Number(/^PPid:\s+([1-9][0-9]*)$/m.exec(parentStatus)?.[1]); check(Number.isSafeInteger(ancestorPid) && ancestorPid > 1);
        const ancestor = own("/proc/" + ancestorPid, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
          ancestorPath = "/proc/self/fd/" + ancestor, ancestorStat = fstatSync(ancestor), ancestorExe = own(ancestorPath + "/exe", constants.O_RDONLY), ancestorExeStat = fstatSync(ancestorExe),
          ancestorRaw = readFileSync(ancestorPath + "/stat", "utf8"), ancestorEnd = ancestorRaw.lastIndexOf(") "), ancestorFields = ancestorRaw.slice(ancestorEnd + 2).trim().split(/\s+/);
        check(ancestorRaw.startsWith(ancestorPid + " (") && ancestorEnd > 0 && /^[1-9][0-9]*$/.test(ancestorFields[19] ?? ""));
        const ancestorTicks = ancestorFields[19], selectedNode = pins.find(pin => pin.path === process.execPath)!;
        rejoinGrandparent = () => { const held = fstatSync(ancestor), named = lstatSync("/proc/" + ancestorPid), exe = fstatSync(ancestorExe), raw = readFileSync(ancestorPath + "/stat", "utf8"), end = raw.lastIndexOf(") "), fields = raw.slice(end + 2).trim().split(/\s+/);
          check(held.dev === ancestorStat.dev && held.ino === ancestorStat.ino && named.dev === held.dev && named.ino === held.ino && raw.startsWith(ancestorPid + " (") && end > 0 &&
            fields[19] === ancestorTicks && !["Z","X","x"].includes(fields[0] ?? "") && exe.dev === ancestorExeStat.dev && exe.ino === ancestorExeStat.ino && exe.dev === selectedNode.dev && exe.ino === selectedNode.ino &&
            statSync(ancestorPath + "/exe").dev === exe.dev && statSync(ancestorPath + "/exe").ino === exe.ino && readFileSync(ancestorPath + "/cmdline").equals(supervisorCommand) &&
            readFileSync(ancestorPath + "/cgroup").equals(group) && /^PPid:\s+1$/m.test(readFileSync(ancestorPath + "/status", "utf8")) &&
            Number(/^PPid:\s+([1-9][0-9]*)$/m.exec(readFileSync(parentPath + "/status", "utf8"))?.[1]) === ancestorPid &&
            statSync(ancestorPath + "/root").dev === root.dev && statSync(ancestorPath + "/root").ino === root.ino &&
            ["user","pid","net"].every(name => readlinkSync(ancestorPath + "/ns/" + name) === readlinkSync("/proc/self/ns/" + name)));
        };
      }
    }
    const namespaces = ["user", "mnt", "pid", "net", "cgroup", "uts", "ipc"] as const;
    const namespaceLinks = namespaces.map(name => readlinkSync("/proc/self/ns/" + name));
    check(namespaceLinks[0] === "user:[4026531837]" && ["user", "pid", "net"].every(name => readlinkSync(parentPath + "/ns/" + name) === readlinkSync("/proc/self/ns/" + name)));
    const root = lstatSync("/"), parentRoot = statSync(parentPath + "/root"); check(root.dev === parentRoot.dev && root.ino === parentRoot.ino);
    const statusSelection = (raw: string) => ["Uid", "Gid", "NoNewPrivs", "Seccomp", "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map(key => {
      const found = new RegExp("^" + key + ":\\s+([^\\n]+)$", "m").exec(raw); check(found); return found[1];
    }).join("\n");
    const selectedStatus = statusSelection(status), selectedParentStatus = statusSelection(parentStatus);
    const nodePin = pins.find(pin => pin.path === process.execPath)!; check(nodePin.dev === exeStat.dev && nodePin.ino === exeStat.ino);
    const parentPin = pins.find(pin => pin.path === (role === OriginalFullProjectControlEntryRole.Supervisor ? "/usr/lib/systemd/systemd" : process.execPath))!;
    check(parentPin.dev === parentExeStat.dev && parentPin.ino === parentExeStat.ino);
    const revalidate = () => {
      check(active); const fresh = originalPair(); check(fresh.pairFile.bytes.equals(current.pairFile.bytes) && fresh.invocationFile.bytes.equals(current.invocationFile.bytes) &&
        process.env.TEST_SOURCE_SHA === current.pair.sourceSha && birth() === processBirth && readFileSync("/proc/self/cmdline").equals(command) && readFileSync("/proc/self/cgroup").equals(group));
      for (const [fd, path, selected] of [[proc, "/proc/" + process.pid, procStat], [exe, "/proc/self/exe", exeStat],
        [parent, "/proc/" + parentPid, parentStat], [parentExe, parentPath + "/exe", parentExeStat]] as const) {
        const actual = fstatSync(fd), named = statSync(path);
        check(actual.dev === selected.dev && actual.ino === selected.ino && named.dev === selected.dev && named.ino === selected.ino);
      }
      check(namespaces.every((name,index) => readlinkSync("/proc/self/ns/" + name) === namespaceLinks[index]) &&
        ["user", "pid", "net"].every(name => readlinkSync(parentPath + "/ns/" + name) === readlinkSync("/proc/self/ns/" + name)) &&
        statusSelection(readFileSync("/proc/self/status", "utf8")) === selectedStatus && statusSelection(readFileSync(parentPath + "/status", "utf8")) === selectedParentStatus &&
        statSync(parentPath + "/root").dev === root.dev && statSync(parentPath + "/root").ino === root.ino);
      const parentRaw = readFileSync(parentPath + "/stat", "utf8"), parentEnd = parentRaw.lastIndexOf(") "), parentFields = parentRaw.slice(parentEnd + 2).trim().split(/\s+/);
      check(parentRaw.startsWith(parentPid + " (") && parentEnd > 0 && !["Z", "X", "x"].includes(parentFields[0] ?? "") &&
        readFileSync(parentPath + "/cmdline").equals(parentCommand) && parentFields[19] === parentBirth &&
        Number(/^PPid:\s+([1-9][0-9]*)$/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1]) === parentPid);
      rejoinGrandparent();
      for (const pin of pins) { const held = fstatSync(pin.fd), named = lstatSync(pin.path); check(held.dev === pin.dev && held.ino === pin.ino &&
        named.dev === pin.dev && named.ino === pin.ino && heldMount(pin.fd) === pin.mount && protectedPublic(pin.path, 128 * 1024 * 1024).equals(pin.bytes) && readHostedHeldRegularBytes(pin.fd, 128 * 1024 * 1024).equals(pin.bytes)); }
    };
    const descriptors = () => { revalidate(); return Object.freeze(handles.map(handle => { const stat = fstatSync(handle.fd, {bigint:true}); check(stat.isFile() || stat.isDirectory()); return Object.freeze({...handle,dev:String(stat.dev),ino:String(stat.ino),mountId:heldMount(handle.fd)}); })); };
    revalidate();
    const entry: OriginalFullProjectControlEntry = Object.freeze({ role, preparedCase: current.removalCase, processPid: process.pid, processBirth, callerPid: parentPid, callerBirth: parentPid + ":" + parentBirth,
      sourceSha: String(current.pair.sourceSha), guestUnit: String(current.pair.unit), guestInvocationId: String(current.invocation.guestInvocationId),
      parentUnit: String(current.pair.parentUnit), parentInvocationId: String(current.pair.parentInvocationId), parentBirth: current.expected.pid + ":" + current.expected.startTicks,
      descriptors() { const retained = projectControlEntries.get(this); check(retained); return retained.descriptors(); },
      revalidate() { const retained = projectControlEntries.get(this); check(retained); retained.revalidate(); },
      close() { const retained = projectControlEntries.get(this); check(retained); projectControlEntries.delete(this); retained.close(); } });
    projectControlEntries.set(entry, Object.freeze({ descriptors, revalidate, close })); return entry;
  } catch (error) { if (active) close(); throw error; }
}
/** Authentic entry selection only; child/stream custody and issuer remain with
 * their original constructors. No argument can select an actor or source. */
export function retainOriginalFullProjectControlGuestEntry(): OriginalFullProjectControlEntry { return retainProjectControlEntry(OriginalFullProjectControlEntryRole.Guest); }
export function retainOriginalFullProjectControlSupervisorEntry(): OriginalFullProjectControlEntry { return retainProjectControlEntry(OriginalFullProjectControlEntryRole.Supervisor); }
export function retainOriginalFullProjectControlPeerQueryEntry(): OriginalFullProjectControlEntry { return retainProjectControlEntry(OriginalFullProjectControlEntryRole.PeerQuery); }
// Read-only physical helpers shared with the original access/fence-guarded interval.
// No outbox, issuer, private access symbol or interval effect enters this module.
export { live, hash, encoded, check, object, procIdentity, protectedJson, originalPair };

export { OriginalFullPeerPreloadSelectionKind, originalFullProjectControlPreloadData, type OriginalFullPeerPreloadSelection } from "./hosted-project-control-source-catalog.js";
export type OriginalFullProjectControlPeerSources = Readonly<{ elfPins: Buffer; packages: Buffer; aliases: Buffer;
  preload: OriginalFullPeerPreloadSelection; revalidate(): void; close(): void }>;
const projectControlPeerSources = new WeakMap<object, Readonly<{ revalidate(): void; close(): void }>>();
/** Only the actual original guest/supervisor entry selects this source port.
 * Buffers are copies of privately held original bytes, never caller enrollment. */
export function retainOriginalFullProjectControlPeerSources(): OriginalFullProjectControlPeerSources {
  const entry = process.argv[2] === "supervisor" ? retainOriginalFullProjectControlSupervisorEntry() : retainOriginalFullProjectControlGuestEntry();
  const owned: number[] = [], files: { path: string; fd: number; bytes: Buffer; dev: bigint; ino: bigint; mount: string }[] = [];
  let active = true;
  const own = (path: string, flags: number) => { const fd = openSync(path, flags); owned.push(fd); return fd; };
  const close = () => { check(active); active = false; for (const fd of owned.reverse()) closeSync(fd); entry.close(); };
  try {
    entry.revalidate(); const original = originalPair(), sources = original.pair.guestSources; check(Array.isArray(sources));
    for (const relative of originalFullProjectControlPeerMetadataPaths) {
      const path = runtime + "/" + relative, rows = sources.filter(row => row && typeof row === "object" && "path" in row && row.path === path);
      check(rows.length === 1); const row = object(rows[0], "path,sha256"), bytes = protectedPublic(path, 256 * 1024); check(hash(bytes) === row.sha256);
      const fd = own(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), stat = fstatSync(fd, { bigint: true });
      check(readHostedHeldRegularBytes(fd, 256 * 1024).equals(bytes)); files.push({ path, fd, bytes, dev: stat.dev, ino: stat.ino, mount: heldMount(fd) });
    }
    const elfFile = files[0]!, packagesFile = files[1]!, aliasesFile = files[2]!, preloadFile = files[3]!;
    const parse = (file: typeof elfFile) => { const value: unknown = JSON.parse(file.bytes.toString("utf8")); check(file.bytes.equals(encoded(value))); return value; };
    const elf = object(parse(elfFile), "schemaVersion,pins"); check(elf.schemaVersion === 1 && Array.isArray(elf.pins) && elf.pins.length > 0 && elf.pins.length <= 4096);
    const packages = object(parse(packagesFile), "schemaVersion,release,releases,packages,usrLayout,pinnedNode");
    const aliases = object(parse(aliasesFile), "schemaVersion,packages,aliases");
    check(packages.schemaVersion === 1 && packages.release === "ubuntu-noble" && Array.isArray(packages.packages) && packages.packages.length > 0 &&
      packages.packages.length <= 256 && aliases.schemaVersion === 1 && JSON.stringify(aliases.packages) === JSON.stringify(packages.packages) &&
      Array.isArray(aliases.aliases) && aliases.aliases.length <= 1024);
    let previous = "";
    for (const value of aliases.aliases) { const row = object(value, "path,target"); check(typeof row.path === "string" && row.path > previous &&
      /^\/(?:usr\/(?:lib|bin)\/|(?:lib64|lib|bin|sbin)$)/.test(row.path) && !row.path.split("/").some(part => part === "." || part === "..") &&
      typeof row.target === "string" && row.target.length > 0 && Buffer.byteLength(row.target) <= 4096 && !/[\0-\x20\x7f]/.test(row.target)); previous = row.path; }
    const preload = originalFullProjectControlPreloadData(parse(preloadFile)), parent = own("/etc", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
      parentStat = fstatSync(parent, { bigint: true }), parentMount = heldMount(parent), child = "/proc/self/fd/" + parent + "/ld.so.preload";
    check(parentStat.uid === 0n && parentStat.gid === 0n && !(parentStat.mode & 0o022n) && String(parentStat.dev) === preload.parent.dev && String(parentStat.ino) === preload.parent.ino);
    let emptyFd: number | undefined;
    if (preload.kind === OriginalFullPeerPreloadSelectionKind.Empty) emptyFd = own(child, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const revalidate = () => {
      check(active); entry.revalidate(); const fresh = originalPair(); check(fresh.pairFile.bytes.equals(original.pairFile.bytes) && fresh.invocationFile.bytes.equals(original.invocationFile.bytes));
      for (const file of files) { const held = fstatSync(file.fd, { bigint: true }), named = lstatSync(file.path, { bigint: true }); check(held.dev === file.dev && held.ino === file.ino &&
        named.dev === file.dev && named.ino === file.ino && heldMount(file.fd) === file.mount && readHostedHeldRegularBytes(file.fd, 256 * 1024).equals(file.bytes) && protectedPublic(file.path, 256 * 1024).equals(file.bytes)); }
      const heldParent = fstatSync(parent, { bigint: true }), namedParent = lstatSync("/etc", { bigint: true });
      check(namedParent.isDirectory() && !namedParent.isSymbolicLink() && heldParent.dev === parentStat.dev && heldParent.ino === parentStat.ino &&
        namedParent.dev === parentStat.dev && namedParent.ino === parentStat.ino && heldMount(parent) === parentMount);
      if (preload.kind === OriginalFullPeerPreloadSelectionKind.Absent) { let absent = false; try { lstatSync(child); } catch (error) { check(error instanceof Error && "code" in error && error.code === "ENOENT"); absent = true; } check(absent); }
      else { check(emptyFd !== undefined && preload.file); const held = fstatSync(emptyFd, { bigint: true }), named = lstatSync(child, { bigint: true });
        check(held.isFile() && !named.isSymbolicLink() && held.uid === 0n && held.gid === 0n && held.nlink === 1n && !(held.mode & 0o022n) && held.size === 0n &&
          String(held.dev) === preload.file.dev && String(held.ino) === preload.file.ino && named.dev === held.dev && named.ino === held.ino && named.size === 0n && readHostedHeldRegularBytes(emptyFd, 0).length === 0);
        const fresh = openSync(child, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); try { check(heldMount(fresh) === heldMount(emptyFd) && fstatSync(fresh, { bigint: true }).ino === held.ino); } finally { closeSync(fresh); } }
      entry.revalidate();
    };
    revalidate(); const receiver: OriginalFullProjectControlPeerSources = Object.freeze({ get elfPins() { return Buffer.from(elfFile.bytes); }, get packages() { return Buffer.from(packagesFile.bytes); },
      get aliases() { return Buffer.from(aliasesFile.bytes); }, preload,
      revalidate() { const retained = projectControlPeerSources.get(this); check(retained); retained.revalidate(); },
      close() { const retained = projectControlPeerSources.get(this); check(retained); projectControlPeerSources.delete(this); retained.close(); } });
    projectControlPeerSources.set(receiver, Object.freeze({ revalidate, close })); return receiver;
  } catch (error) { if (active) close(); throw error; }
}
