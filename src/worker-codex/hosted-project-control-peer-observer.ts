import { assertOriginalHostedProjectControlGitPeerQueryCurrent } from "./hosted-project-control-native-allocation.js";
import { assertOriginalFullProjectControlSetupCurrent } from "./hosted-project-control-native-origin.js";
import { originalFullProjectControlGitEntryData, originalFullProjectControlGitExecutableData, OriginalFullGitEntryKind } from "../provider-codex/app-server/adapters/hosted-project-control-source-catalog.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { type BigIntStats, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, statSync, statfsSync } from "node:fs";
import { Duplex } from "node:stream";
import { retainOriginalFullProjectControlGuestEntry, retainOriginalFullProjectControlSupervisorEntry,
  retainOriginalFullProjectControlPeerSources, originalFullProjectControlEntrySourcePaths,
  type OriginalFullProjectControlEntry } from "../provider-codex/app-server/adapters/hosted-full-backing-stage.js";
import { hostedFdTable } from "../provider-codex/app-server/adapters/hosted-fd-table.js";
import { parseHostedSignedToolElf } from "../provider-codex/app-server/adapters/hosted-signed-tool-elf.js";
import { parseFdCollectorRows, type FdCollectorPeer } from "../core/host-infrastructure/fd-collector-profile.js";
import { decodeOriginalFullPeerSelection, resolveOriginalFullPeerSelection } from "./hosted-project-control-peer-selection.js";
import { remainingOriginalPeerQueryMilliseconds, remainingOriginalSdkPeerQueryMilliseconds } from "./hosted-project-control-native-handoff.js";
import { originalFullPeerEnvironment, originalFullPeerLoader, originalFullPeerNode,
  originalFullPeerProgram, originalFullPeerReady } from "./hosted-project-control-peer-recipe.js";

function check(value: unknown): asserts value { if (!value) throw new Error("hosted_original_peer_observer_held"); }
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
    a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function mount(fd: number, pid = process.pid): string {
  const info = readFileSync("/proc/" + pid + "/fdinfo/" + fd, "utf8"); check(Buffer.byteLength(info) <= 4096);
  const rows = [...info.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)]; check(rows.length === 1); return rows[0]![1]!;
}
function readonlyMount(fd: number): void {
  const id = mount(fd), raw = readFileSync("/proc/self/mountinfo", "utf8"); check(Buffer.byteLength(raw) <= 1024 * 1024);
  const rows = raw.trim().split("\n").filter(row => row.split(" ")[0] === id);
  check(rows.length === 1 && rows[0]!.split(" ")[5]!.split(",").includes("ro"));
}
function bytes(fd: number, maximum: number): Buffer {
  const before = fstatSync(fd, {bigint:true}); check(before.isFile() && before.size <= BigInt(maximum));
  const result = Buffer.alloc(Number(before.size)); let offset = 0;
  while (offset < result.length) { const count = readSync(fd, result, offset, result.length - offset, offset); check(count > 0); offset += count; }
  check(same(before, fstatSync(fd, {bigint:true}))); return result;
}
function birth(raw: string, pid: number, live: boolean): string {
  check(Buffer.byteLength(raw) <= 4096 && raw.endsWith("\n") && raw.startsWith(pid + " ("));
  const end = raw.lastIndexOf(") "), fields = raw.slice(end + 2).trim().split(/\s+/);
  check(end > 0 && /^[1-9][0-9]*$/.test(fields[19] ?? "") && (!live || !["Z", "X", "x"].includes(fields[0] ?? "")));
  return pid + ":" + fields[19];
}
function children(pid: number): string {
  const raw = readFileSync("/proc/" + pid + "/task/" + pid + "/children", "utf8");
  check(Buffer.byteLength(raw) <= 4096 && /^(?:[1-9][0-9]* )*$/.test(raw));
  return raw.trim().split(/\s+/).filter(Boolean).sort().join(",");
}
function closed(fd: number): boolean {
  try { fstatSync(fd, {bigint:true}); return false; }
  catch (error) { check(error instanceof Error && "code" in error && error.code === "EBADF"); return true; }
}

/** Actual immutable named/held bytes and mount custody. No path or caller pin
 * can create this owner; only the original metadata receiver selects its leaves. */
function retainClosure(entry: OriginalFullProjectControlEntry, sources: ReturnType<typeof retainOriginalFullProjectControlPeerSources>, remaining = remainingOriginalPeerQueryMilliseconds, git = false) {
  const selection = decodeOriginalFullPeerSelection(sources.elfPins, sources.packages, sources.aliases);
  const held: { fd: number; path: string; stat: BigIntStats; mount: string; sha?: string }[] = [];
  const aliases: { path: string; target: string; stat: BigIntStats }[] = [];
  let active = true, toolBytes = 0;
  const selectedBytes = new Map<string,Buffer>();
  // This local bound can only tighten the already-issued original remaining
  // budget. It never creates/reset a reserve or replaces enqueue revalidation.
  const selectionDeadline = process.hrtime.bigint() + BigInt(remaining()) * 1_000_000n;
  const retain = (path: string, directory: boolean, expectedSha?: string) => {
    check(active); const existing = held.find(row => row.path === path);
    if (existing) { check(existing.sha === expectedSha); return existing.fd; }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0));
    const stat = fstatSync(fd, {bigint:true}); held.push({ fd, path, stat, mount: mount(fd), ...(expectedSha ? {sha:expectedSha} : {}) });
    check(stat.uid === 0n && stat.gid === 0n && !(stat.mode & 0o022n) && !lstatSync(path, {bigint:true}).isSymbolicLink() &&
      (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n));
    check(same(stat, lstatSync(path, {bigint:true}))); return fd;
  };
  const ancestors = (path: string) => {
    const parts = path.split("/").filter(Boolean); retain("/", true);
    for (let i = 1; i < parts.length; i++) retain("/" + parts.slice(0, i).join("/"), true);
  };
  const leaf = (logical: string) => {
    const selected = resolveOriginalFullPeerSelection(selection, logical);
    for (const edge of selected.aliases) {
      // Resolver supplies only originally sealed edges. The current link may
      // not add a path, package, candidate or search directory to selection.
      ancestors(edge.path); const parent = held.find(row => row.path === edge.path.slice(0,edge.path.lastIndexOf("/")))!; readonlyMount(parent.fd);
      const stat = lstatSync(edge.path, {bigint:true});
      check(stat.isSymbolicLink() && stat.uid === 0n && stat.gid === 0n && readlinkSync(edge.path) === edge.target);
      if (!aliases.some(row => row.path === edge.path)) aliases.push({ ...edge, stat });
    }
    ancestors(selected.path); const prior = held.find(row => row.path === selected.path), fd = retain(selected.path, false, selected.sha256);
    readonlyMount(fd); const data = selectedBytes.get(selected.path) ?? bytes(fd, 32 * 1024 * 1024);
    if (!prior) { check(hash(data) === selected.sha256); selectedBytes.set(selected.path,data); }
    if (!prior) { toolBytes += data.length; check(toolBytes <= 256 * 1024 * 1024 && held.filter(row => row.sha).length <= 32); }
    return { path: selected.path, data };
  };
  const close = () => {
    check(active); active=false;const errors:unknown[]=[];
    for(const row of held.slice().reverse())try{closeSync(row.fd);check(closed(row.fd));}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,"hosted_original_tool_close_held");
  };
  try {
    entry.revalidate(); sources.revalidate(); check(process.version === "v22.23.3");
    const nodeRows = entry.descriptors().filter(row => row.path === originalFullPeerNode); check(nodeRows.length === 1);
    readonlyMount(nodeRows[0]!.fd); const nodeBytes = bytes(nodeRows[0]!.fd, 128 * 1024 * 1024); check(hash(nodeBytes) === selection.nodeSha256);
    const interpreter = leaf("/lib64/ld-linux-x86-64.so.2"); check(interpreter.path === originalFullPeerLoader);
    const loaderRequirements = selection.nodeRequirements.filter(row => row.soname === "ld-linux-x86-64.so.2");
    check(loaderRequirements.length === 1 && hash(interpreter.data) === loaderRequirements[0]!.sha256);
    const gitLeaves: {path:string;data:Buffer}[] = [];
    if (git) {
      const inventory = JSON.parse(sources.gitInventory.toString("utf8")) as {entries:unknown;aliases:unknown};
      const elfPins = JSON.parse(sources.elfPins.toString("utf8")) as {pins:unknown};
      const entries = originalFullProjectControlGitEntryData(inventory.entries);
      const executables = originalFullProjectControlGitExecutableData(inventory.entries, elfPins.pins);
      for (const row of entries) {
        ancestors(row.path);
        if (row.kind === OriginalFullGitEntryKind.Symlink) {
          const stat = lstatSync(row.path,{bigint:true}); check(stat.isSymbolicLink() && stat.uid === 0n && stat.gid === 0n && readlinkSync(row.path) === row.target);
          readonlyMount(held.find(pin => pin.path === row.path.slice(0,row.path.lastIndexOf("/")))!.fd);
          aliases.push({path:row.path,target:row.target!,stat});
        } else {
          const fd = retain(row.path,row.kind === OriginalFullGitEntryKind.Directory,row.sha256 ?? undefined); readonlyMount(fd);
          if (row.sha256) { const data = bytes(fd,32*1024*1024); check(data.length === row.size && hash(data) === row.sha256); selectedBytes.set(row.path,data); }
        }
      }
      for (const row of executables) gitLeaves.push({path:row.resolvedPath,data:selectedBytes.get(row.resolvedPath)!});
    }
    const queue = [{ path: originalFullPeerNode, data: nodeBytes }, leaf("/usr/bin/ss"), leaf(originalFullPeerLoader),
      ...gitLeaves, ...selection.nodeRequirements.map(row => { const selected = leaf("/usr/lib/x86_64-linux-gnu/"+row.soname); check(hash(selected.data) === row.sha256); return selected; })], visited = new Set<string>();
    while (queue.length) {
      check(process.hrtime.bigint() < selectionDeadline); const item = queue.shift()!; if (visited.has(item.path)) continue; visited.add(item.path);
      check(visited.size <= 33); const elf = parseHostedSignedToolElf(item.data);
      check(elf.rpath.length === 0 && elf.runpath.length === 0 && (item.path === originalFullPeerNode || item.path === "/usr/bin/ss" || gitLeaves.some(row => row.path === item.path)
        ? elf.interpreter === "/lib64/ld-linux-x86-64.so.2" : elf.interpreter === null));
      for (const soname of elf.needed) {
        const dependency = leaf("/usr/lib/x86_64-linux-gnu/" + soname);
        if (item.path === originalFullPeerNode) {
          const requirements = selection.nodeRequirements.filter(row => row.soname === soname);
          check(requirements.length === 1 && hash(dependency.data) === requirements[0]!.sha256);
        }
        queue.push(dependency);
      }
    }
    const revalidate = () => {
      check(active); remaining(); entry.revalidate(); sources.revalidate();
      for (const row of held) {
        check(same(row.stat, fstatSync(row.fd, {bigint:true})) && same(row.stat, lstatSync(row.path, {bigint:true})) && mount(row.fd) === row.mount);
        const fresh = openSync(row.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (row.stat.isDirectory() ? constants.O_DIRECTORY : 0));
        try { check(same(row.stat, fstatSync(fresh, {bigint:true})) && mount(fresh) === row.mount); } finally { closeSync(fresh); }
        if (row.sha) { readonlyMount(row.fd); check(hash(bytes(row.fd, 32 * 1024 * 1024)) === row.sha); }
      }
      for (const row of aliases) { readonlyMount(held.find(pin => pin.path === row.path.slice(0,row.path.lastIndexOf("/")))!.fd);
        check(same(row.stat, lstatSync(row.path, {bigint:true})) && readlinkSync(row.path) === row.target); }
      check(hash(bytes(nodeRows[0]!.fd, 128 * 1024 * 1024)) === selection.nodeSha256);
    };
    const verifyMaps = (pid: number) => {
      revalidate(); const raw = readFileSync("/proc/"+pid+"/maps", "utf8"); check(Buffer.byteLength(raw) <= 256 * 1024);
      let nodeMapped = false;
      for (const line of raw.trim().split("\n")) {
        const match = /^[0-9a-f]+-[0-9a-f]+ [rwxps-]{4} [0-9a-f]+ [0-9a-f]+:[0-9a-f]+ ([0-9]+)(?: +(.+))?$/.exec(line); check(match);
        const path = match[2]; if (!path || path.startsWith("[")) { check(match[1] === "0"); continue; }
        check(!path.endsWith(" (deleted)")); const row = path === originalFullPeerNode ? {stat:fstatSync(nodeRows[0]!.fd, {bigint:true})} : held.find(pin => pin.path === path && pin.sha);
        check(row && String(row.stat.ino) === match[1]); if (path === originalFullPeerNode) nodeMapped = true;
      }
      check(nodeMapped);
    };
    const descriptors=()=>{revalidate();return Object.freeze(held.map(row=>Object.freeze({fd:row.fd,dev:String(row.stat.dev),ino:String(row.stat.ino),mountId:row.mount,directory:row.stat.isDirectory()})));};
    revalidate(); return { revalidate, verifyMaps, close, descriptors };
  } catch (error) { try{close();}catch{} throw error; }
}

/** Finite source-owned factual observation. Raw child/native handle/streams
 * never leave this module and no caller can adopt a process or emit completion. */
export type OriginalHostedProjectControlPeerObserver = Readonly<{ query(): Promise<ReadonlyMap<string,FdCollectorPeer>>; close(): void }>;
export function retainOriginalHostedProjectControlPeerObserver(): OriginalHostedProjectControlPeerObserver {
  return retainObserver(remainingOriginalPeerQueryMilliseconds);
}
/** Origin is checked independently on every enqueue; DATA cannot select a budget. */
export function retainOriginalHostedProjectControlSdkPeerObserver(): OriginalHostedProjectControlPeerObserver {
  assertOriginalFullProjectControlSetupCurrent();
  return retainObserver(() => { assertOriginalFullProjectControlSetupCurrent(); assertOriginalHostedProjectControlGitPeerQueryCurrent(); return remainingOriginalSdkPeerQueryMilliseconds(); });
}
const observers = new WeakMap<object, Readonly<{ query(): Promise<ReadonlyMap<string,FdCollectorPeer>>; close(): void }>>();

function retainObserver(remaining: () => number): OriginalHostedProjectControlPeerObserver {
  check(pendingQueries.size === 0); remaining();
  const entry = process.argv[2] === "supervisor" ? retainOriginalFullProjectControlSupervisorEntry() : retainOriginalFullProjectControlGuestEntry();
  let sources: ReturnType<typeof retainOriginalFullProjectControlPeerSources> | undefined;
  let closure: ReturnType<typeof retainClosure> | undefined, active = true, inFlight = false;
  try {
    sources = retainOriginalFullProjectControlPeerSources(); closure = retainClosure(entry, sources, remaining);
    const revalidate = () => { check(active && sources && closure); entry.revalidate(); sources.revalidate(); closure.revalidate(); };
    const closeOwners=()=>{const errors:unknown[]=[];for(const close of [()=>closure!.close(),()=>sources!.close(),()=>entry.close()])try{close();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,"hosted_original_peer_observer_close_held");};
    const close = () => { check(active && !inFlight && sources && closure); active=false; closeOwners(); };
    const query = async () => {
      check(active && !inFlight); revalidate(); inFlight = true;
      try { const result = await ownedQuery(entry, revalidate, closure!.verifyMaps, remaining); revalidate(); return parseFdCollectorRows(result, 65_536); }
      catch (error) { active=false;if(pendingQueries.size===0)try{closeOwners();}catch{} throw error; }
      finally { inFlight = false; }
    };
    const receiver: OriginalHostedProjectControlPeerObserver = Object.freeze({
      query() { const own = observers.get(this); check(own); return own.query(); },
      close() { const own = observers.get(this); check(own); observers.delete(this); own.close(); },
    });
    observers.set(receiver, Object.freeze({query,close})); return receiver;
  } catch (error) { for(const close of [()=>closure?.close(),()=>sources?.close(),()=>entry.close()])try{close();}catch{} throw error; }
}

/** This is the sole actual query spawn. All inputs come from lexical original
 * selection; the helper gate makes its initial Node census deterministic. */
const pendingQueries = new Set<object>();
async function boundedWait(terminal: Promise<void>, milliseconds:number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([terminal,new Promise<never>((_,reject) => { timer = setTimeout(() => reject(new Error("hosted_original_peer_drain_held")),milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function cgroupMembers(fd: number): string {
  const before = fstatSync(fd, {bigint:true}), buffer = Buffer.alloc(16385), size = readSync(fd,buffer,0,buffer.length,0);
  check(size <= 16384 && same(before,fstatSync(fd, {bigint:true})) && statfsSync("/proc/self/fd/"+fd, {bigint:true}).type === 0x63677270n);
  const raw = buffer.subarray(0,size).toString("ascii"); check(/^(?:[1-9][0-9]*\n)*$/.test(raw));
  const members = raw.trim().split("\n").filter(Boolean); check(members.length <= 256 && new Set(members).size === members.length);
  return members.sort().join(",");
}
async function ownedQuery(entry: OriginalFullProjectControlEntry, revalidate: () => void, verifyMaps: (pid:number) => void, remaining: () => number): Promise<string> {
  check(pendingQueries.size === 0); revalidate(); const parentChildren = children(process.pid), timeout = remaining(),
    queryDeadline = process.hrtime.bigint() + BigInt(timeout) * 1_000_000n;
  const groupFd = openSync("/sys/fs/cgroup/system.slice/TEST-retention-supervisor.service/cgroup.procs",constants.O_RDONLY | constants.O_NOFOLLOW);
  let originalMembers: string;
  try { readonlyMount(groupFd); originalMembers = cgroupMembers(groupFd); remaining(); check(process.hrtime.bigint() < queryDeadline); }
  catch (error) { closeSync(groupFd); throw error; }
  const child = spawn(originalFullPeerNode, [originalFullPeerProgram, "query-peer"], {
    cwd: "/", env: {...originalFullPeerEnvironment(), TEST_SOURCE_SHA:entry.sourceSha}, stdio:["pipe","pipe","pipe","pipe"], detached:false,
  });
  // This assertion concerns only the actual source-created child. No public
  // factory accepts a ChildProcess-shaped receiver or exposes this emitter.
  pendingQueries.add(child);
  const native: unknown = Reflect.get(child, "_handle"), onexit: unknown = native && typeof native === "object" ? Reflect.get(native, "onexit") : undefined;
  let nativeWait: Readonly<{code:number;signal:string}> | undefined, spawned = false, heldProc: number | undefined, heldExe: number | undefined;
  let failure: Error | undefined;
  child.on("error", () => { failure ??= new Error("hosted_original_peer_spawn_held"); });
  const streams = Array.from(child.stdio);
  if (streams.length !== 4 || !streams.every(stream => stream !== null)) { child.kill("SIGKILL"); throw new Error("hosted_original_peer_stdio_held"); }
  const input = child.stdin, output = child.stdout, errorOutput = child.stderr, gate = streams[3];
  if (!input || !output || !errorOutput || !(gate instanceof Duplex)) { child.kill("SIGKILL"); throw new Error("hosted_original_peer_stream_type_held"); }
  let primaryFailed=false;const ownedEndpointsForDrain:{dev:string;ino:string}[]=[];
  let drained = false, released = false, expired = false, stdout = Buffer.alloc(0), stderrBytes = 0, selectedBirth: string | undefined;
  const streamClosed = new Set<number>();
  const terminal = new Promise<void>(resolve => {
    const finish = () => { if (nativeWait && streamClosed.size === 4) resolve(); };
    if (native && typeof native === "object" && typeof onexit === "function") Reflect.set(native, "onexit", function(this: unknown, code: number, signal: unknown) {
      check(this === native && !nativeWait && Number.isSafeInteger(code));
      // Exact Node also calls onexit(err) from onErrorNT for failed spawn.
      // Its negative code/undefined signal is not a libuv waitpid result.
      if (code >= 0 && typeof signal === "string") nativeWait = Object.freeze({code,signal});
      else failure ??= new Error("hosted_original_peer_non_native_exit_held");
      Reflect.apply(onexit, native, [code,signal]); finish();
    });
    streams.forEach((stream,index) => { check(stream); stream.once("close", () => { streamClosed.add(index); finish(); });
      stream.on("error", () => { failure ??= new Error("hosted_original_peer_stream_held"); }); });
    child.once("error", () => { failure ??= new Error("hosted_original_peer_spawn_held"); });
    // Native wait may be unavailable on failed spawn; it never becomes a
    // positive. Cancellation's bounded drain failure keeps custody retained.
    child.once("spawn", () => { spawned = true; });
  });
  let refuseReady: ((error:Error) => void) | undefined;
  const timer = setTimeout(() => { expired = true; failure ??= new Error("hosted_original_peer_query_timeout"); refuseReady?.(failure); if (!nativeWait) child.kill("SIGKILL"); }, Math.max(0,Number((queryDeadline-process.hrtime.bigint())/1_000_000n)));
  const ready = new Promise<void>((resolve,reject) => {
    refuseReady = reject;
    output.on("data", (chunk: Buffer) => {
      if ((!released && stdout.length + chunk.length > 96) || chunk.length > 4*1024*1024 + Buffer.byteLength(originalFullPeerReady) - stdout.length) { failure ??= new Error("hosted_original_peer_output_held"); reject(failure); if (!nativeWait) child.kill("SIGKILL"); return; }
      stdout = Buffer.concat([stdout,chunk]);
      if (stdout.length > 4*1024*1024 + Buffer.byteLength(originalFullPeerReady)) { failure ??= new Error("hosted_original_peer_output_held"); reject(failure); if (!nativeWait) child.kill("SIGKILL"); }
      if (stdout.length >= Buffer.byteLength(originalFullPeerReady)) {
        if (stdout.subarray(0,Buffer.byteLength(originalFullPeerReady)).toString() !== originalFullPeerReady) { failure ??= new Error("hosted_original_peer_ready_held"); reject(failure); }
        else resolve();
      }
    });
    errorOutput.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; failure ??= new Error("hosted_original_peer_stderr_held"); reject(failure); if (!nativeWait) child.kill("SIGKILL"); });
    child.once("error", reject); child.once("exit", () => { if (stdout.length < Buffer.byteLength(originalFullPeerReady)) reject(new Error("hosted_original_peer_early_exit_held")); });
  });
  try {
    check(native && typeof native === "object" && typeof onexit === "function");
    const ownedEndpoints = streams.map(stream => {
      check(stream); const handle:unknown = Reflect.get(stream,"_handle"); check(handle && typeof handle === "object");
      const fd:unknown = Reflect.get(handle,"fd"); check(typeof fd === "number" && Number.isSafeInteger(fd) && fd >= 0);
      const stat = fstatSync(fd, {bigint:true}); check(stat.isSocket()); return {fd,dev:String(stat.dev),ino:String(stat.ino)};
    });
    ownedEndpointsForDrain.push(...ownedEndpoints);
    check(new Set(ownedEndpoints.map(row => row.fd)).size === 4 && new Set(ownedEndpoints.map(row => row.dev+":"+row.ino)).size === 4);
    input.end(); await ready; check(spawned && !expired && !failure && child.pid && child.pid > 1 && stdout.toString() === originalFullPeerReady);
    const pid = child.pid; heldProc = openSync("/proc/" + pid, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    heldExe = openSync("/proc/self/fd/" + heldProc + "/exe", constants.O_RDONLY);
    selectedBirth = birth(readFileSync("/proc/self/fd/" + heldProc + "/stat", "utf8"),pid,true);
    const node = entry.descriptors().filter(row => row.path === originalFullPeerNode); check(node.length === 1);
    const procStat = fstatSync(heldProc, {bigint:true}), executable = fstatSync(heldExe, {bigint:true}), expectedNode = fstatSync(node[0]!.fd, {bigint:true});
    const childPath = "/proc/self/fd/" + heldProc;
    const checkChild = () => {
      revalidate(); check(!nativeWait && !expired && !failure && birth(readFileSync(childPath+"/stat","utf8"),pid,true) === selectedBirth &&
        same(procStat,statSync("/proc/"+pid, {bigint:true})) && same(executable,fstatSync(heldExe!, {bigint:true})) && same(executable,statSync(childPath+"/exe", {bigint:true})) &&
        executable.dev === expectedNode.dev && executable.ino === expectedNode.ino && readFileSync(childPath+"/cmdline").equals(Buffer.from([originalFullPeerNode,originalFullPeerProgram,"query-peer", ""].join("\0"))) &&
        new RegExp("^PPid:\\s+"+process.pid+"$","m").test(readFileSync(childPath+"/status","utf8")) && readFileSync(childPath+"/cgroup").equals(readFileSync("/proc/self/cgroup")) && children(pid) === "");
      for (const name of ["user","mnt","pid","net","cgroup","uts","ipc","time","time_for_children"]) check(readlinkSync(childPath+"/ns/"+name) === readlinkSync("/proc/self/ns/"+name));
      check(readFileSync(childPath+"/timens_offsets").equals(readFileSync("/proc/self/timens_offsets")));
      verifyMaps(pid); verifyQueryDescriptors(entry,pid,heldProc!);
      check(birth(readFileSync(childPath+"/stat","utf8"),pid,true) === selectedBirth && !nativeWait && !expired);
    };
    checkChild(); remaining(); check(process.hrtime.bigint() < queryDeadline);
    released = true; await boundedWait(new Promise<void>((resolve,reject) => {
      gate.once("error",reject); gate.end(Buffer.from([1]), () => { gate.removeListener("error",reject); resolve(); });
    }),Math.min(remaining(),Math.max(0,Number((queryDeadline-process.hrtime.bigint())/1_000_000n))));
    await boundedWait(terminal,Math.min(remaining(),Math.max(0,Number((queryDeadline-process.hrtime.bigint())/1_000_000n)))); check(process.hrtime.bigint() < queryDeadline); check(nativeWait && nativeWait.code === 0 && nativeWait.signal === "" && !expired && !failure && stderrBytes === 0 && selectedBirth);
    let namedBirth: string | undefined;
    try { namedBirth = birth(readFileSync("/proc/"+pid+"/stat","utf8"),pid,false); }
    catch (error) { check(error instanceof Error && "code" in error && error.code === "ENOENT"); }
    check(namedBirth !== selectedBirth && children(process.pid) === parentChildren && cgroupMembers(groupFd) === originalMembers); drained = true;
    const after = hostedFdTable(process.pid); check(ownedEndpoints.every(endpoint => !after.some(row => row.dev === endpoint.dev && row.ino === endpoint.ino))); revalidate(); check(process.hrtime.bigint() < queryDeadline);
    return stdout.subarray(Buffer.byteLength(originalFullPeerReady)).toString("utf8");
  } catch (error) {
    primaryFailed=true;
    try{if(!nativeWait)child.kill("SIGKILL");}catch{}
    try{if(!nativeWait||streamClosed.size!==4)await boundedWait(terminal,1000);drained=!!nativeWait&&streamClosed.size===4&&children(process.pid)===parentChildren&&cgroupMembers(groupFd)===originalMembers;}catch{}
    throw error;
  } finally {
    clearTimeout(timer);
    if(nativeWait&&streamClosed.size===4&&drained){
      const errors:unknown[]=[];for(const fd of [groupFd,heldExe,heldProc])if(fd!==undefined)try{closeSync(fd);check(closed(fd));}catch(error){errors.push(error);}
      try{await new Promise<void>(resolve=>setImmediate(resolve));await new Promise<void>(resolve=>setImmediate(resolve));const after=hostedFdTable(process.pid);check(ownedEndpointsForDrain.every(endpoint=>!after.some(row=>row.socket&&row.dev===endpoint.dev&&row.ino===endpoint.ino)));}catch(error){errors.push(error);}
      if(!errors.length)pendingQueries.delete(child);else if(!primaryFailed)throw new AggregateError(errors,"hosted_original_peer_close_held");
    }
  }
}

function verifyQueryDescriptors(entry: OriginalFullProjectControlEntry, pid: number, heldProc: number): void {
  const authentic = entry.descriptors();
  const expected = originalFullProjectControlEntrySourcePaths.map(path => {
    const selected = authentic.filter(row => row.path === path); check(selected.length === 1);
    const stat = lstatSync(path, {bigint:true}); check(stat.isFile() && !stat.isSymbolicLink() && String(stat.dev) === selected[0]!.dev && String(stat.ino) === selected[0]!.ino);
    return {dev:selected[0]!.dev,ino:selected[0]!.ino,mount:selected[0]!.mountId,directory:false};
  });
  const source = authentic.find(row => row.path === originalFullPeerNode); check(source);
  for (const actor of [pid,process.pid,...(process.argv[2] === "qualify" ? [entry.callerPid] : [])]) {
    const proc = statSync("/proc/"+actor, {bigint:true}), exe = statSync("/proc/"+actor+"/exe", {bigint:true});
    expected.push({dev:String(proc.dev),ino:String(proc.ino),mount:mount(heldProc),directory:true},{dev:String(exe.dev),ino:String(exe.ino),mount:source.mountId,directory:false});
  }
  const table = hostedFdTable(pid); check(table.length <= 256);
  const regular = table.filter(row => row.file || row.directory); check(regular.length === expected.length);
  for (const row of regular) { const at = expected.findIndex(item => item.dev === row.dev && item.ino === row.ino && item.directory === row.directory && item.mount === mount(row.fd,pid)); check(at >= 0 && (row.flags & 3) === 0 && row.flags & 0o2000000 && !(row.flags & 0o10000000)); expected.splice(at,1); }
  check(expected.length === 0); const counts = {poll:0,event:0,pipe:0,devnull:0};
  for (const row of table.filter(row => !row.file && !row.directory)) {
    if (row.fd <= 3) { check(row.socket); continue; }
    check(row.flags & 0o2000000 && !(row.flags & 0o10000000));
    if (row.target === "anon_inode:[eventpoll]" && !row.socket) counts.poll++;
    else if (row.target === "anon_inode:[eventfd]" && !row.socket) counts.event++;
    else if (row.pipe && /^pipe:\[[1-9][0-9]*\]$/.test(row.target)) counts.pipe++;
    else if (row.character && row.rdev === "259" && (row.flags & 3) === 0) counts.devnull++;
    else check(false);
  }
  check(counts.poll <= 8 && counts.event <= 8 && counts.pipe <= 32 && counts.devnull <= 8);
}

/** Source-owned signed Git/loader/Node dependency and complete exec-path custody. */
export function retainOriginalHostedProjectControlGitClosure(): Readonly<{revalidate():void;verifyMaps(pid:number):void;descriptors():readonly Readonly<{fd:number;dev:string;ino:string;mountId:string;directory:boolean}>[];close():void}> {
  assertOriginalFullProjectControlSetupCurrent(); const entry = retainOriginalFullProjectControlGuestEntry();
  let sources: ReturnType<typeof retainOriginalFullProjectControlPeerSources> | undefined;
  let closure: ReturnType<typeof retainClosure> | undefined;
  try {
    sources = retainOriginalFullProjectControlPeerSources();
    closure = retainClosure(entry,sources,() => { assertOriginalFullProjectControlSetupCurrent(); return remainingOriginalSdkPeerQueryMilliseconds(); },true);
    return Object.freeze({revalidate:closure.revalidate,verifyMaps:closure.verifyMaps,descriptors() {
      closure!.revalidate();return Object.freeze([...closure!.descriptors(),...sources!.descriptors(),...entry.descriptors().map(row=>Object.freeze({fd:row.fd,dev:row.dev,ino:row.ino,mountId:row.mountId,directory:fstatSync(row.fd).isDirectory()}))]);
    },close() {
      const errors:unknown[]=[]; for (const close of [() => closure!.close(),() => sources!.close(),() => entry.close()]) try {close();} catch(error) {errors.push(error);}
      if(errors.length) throw new AggregateError(errors,"hosted_original_git_closure_close_held");
    }});
  } catch(error) { for(const close of [() => closure?.close(),() => sources?.close(),() => entry.close()]) try {close();} catch {} throw error; }
}
