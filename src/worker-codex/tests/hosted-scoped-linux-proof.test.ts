import { ScopedTerminationRecords, scopedFenceIdentity } from "../hosted-controller/scoped-termination-records";
import { withHostedActivationFence, retainHostedScopedActorChain, retainHostedScopedSubmitter } from "@vioxen/subscription-runtime/provider-codex";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostedReadonlyHostKernel } from "../hosted-readonly-host-kernel";
import { collectScopedRecursiveEmpty, fenceScopedSubmitter } from "../hosted-readonly-linux-collector";
import { parseScopedActorChain, parseScopedActorDischarge, ScopedActorDischargeMethod, scopedDigest, ScopedEnqueueActorRole, ScopedSignal, ScopedTerminationKind, ScopedTerminationOutcome, type ScopedActorChain, type ScopedTerminationMember } from "../../worker-core/hosted-custody/domain/scoped-termination";
const graph = vi.hoisted(() => ({ root: "", files: new Map<string, string>(), invocation: "a".repeat(32), creatorBirth: "456",
  queue: "", cancelWorks: true, effects: [] as string[][], pidfdCalls: [] as string[], collectorError: false, signalHook: null as (() => void) | null, proxyExit: false, actorExits: new Set<string>(), realPids: new Set<string>(), taskReads: new Map<string, number>(), taskMutation: null as ((path: string, count: number) => string[] | undefined) | null, fsyncHook: null as ((path:string)=>void) | null }));
const policy = "/var/lib/subscription-runtime-host-policy";
const local = (path: string) => ["/var", "/var/lib"].includes(path) ? graph.root : path === policy || path.startsWith(policy + "/") ? graph.root + "/policy" + path.slice(policy.length) :
  path.startsWith("/run/systemd/units") ? graph.root + "/units" + path.slice("/run/systemd/units".length) :
  path.startsWith("/sys/fs/cgroup") ? graph.root + "/cgroups" + path.slice("/sys/fs/cgroup".length) : path;
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const taskNames = (path: string) => {
    const count = (graph.taskReads.get(path) ?? 0) + 1; graph.taskReads.set(path, count);
    const mutated = graph.taskMutation?.(path, count); if (mutated) return mutated;
    const pid = /^\/proc\/(\d+)\/task$/.exec(path)?.[1];
    return [...graph.files.keys()].flatMap(key => {
      const task = new RegExp(`^/proc/${pid}/task/(\\d+)/stat$`).exec(key); return task ? [task[1]!] : [];
    });
  };
  return { ...fs,
    fsyncSync: (fd:number) => { fs.fsyncSync(fd); graph.fsyncHook?.(fs.readlinkSync(`/proc/self/fd/${fd}`)); },
    opendirSync: (path: string) => {
      const pid = /^\/proc\/(\d+)\/task$/.exec(path)?.[1];
      if (!pid || graph.realPids.has(pid)) return fs.opendirSync(path);
      const ids = taskNames(path); let offset = 0;
      return { readSync: () => offset < ids.length ? {name:ids[offset++]} : null, closeSync: () => {} };
    },
    readFileSync: (path: string | number, options: unknown) => {
      if (typeof path === "string" && graph.files.has(path)) return graph.files.get(path)!;
      if (typeof path === "string" && path.startsWith("/proc/") && !path.startsWith("/proc/self/fd/") && !graph.realPids.has(path.split("/")[2]!)) throw Object.assign(new Error("TEST absent task"), { code: "ENOENT" });
      return fs.readFileSync(typeof path === "string" ? local(path) : path, options as never);
    },
    lstatSync: (path: string) => { const s = fs.lstatSync(local(path)); return Object.assign(s, { uid: 0,
      mode: graph.root.startsWith(path === "/" ? path : path + "/") || path === "/var" || path === "/var/lib" ? s.mode & ~0o022 : s.mode }); },
    statSync: (path: string) => Object.assign(fs.statSync(local(path)), { uid: 0 }),
    fstatSync: (fd: number) => Object.assign(fs.fstatSync(fd), { uid: 0 }),
    openSync: (path: string, flags: number, mode: number) => fs.openSync(local(path), flags, mode),
    mkdirSync: (path: string, options: Parameters<typeof fs.mkdirSync>[1]) => fs.mkdirSync(local(path), options),
    renameSync: (from:string,to:string) => fs.renameSync(local(from),local(to)),
    rmdirSync: (path: string) => fs.rmdirSync(local(path)),
    readlinkSync: (path: string) => path.includes("/invocation:") ? graph.invocation : "TEST-namespace",
  };
});
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawnSync: (command: string, args: string[]) => {
  if (command === "/usr/bin/python3") { graph.pidfdCalls.push(args[4]!); const exited = graph.proxyExit || graph.actorExits.has(args[4]!); return { status: exited ? 0 : 1, stdout: exited ?
    JSON.stringify({ pidBirth: args[4], controlGroup: args[5], exitObserved: true }) : "" }; }
  if (command !== "/usr/bin/systemctl") throw new Error("TEST foreign command");
  if (graph.collectorError) return { status: 1, stdout: "" };
  const name = args.at(-1)!;
  if (args[0] === "list-jobs") return { status: 0, stdout: graph.queue };
  if (args.includes("--property=Id,InvocationID,ControlGroup")) return {status:0,stdout:`Id=${name}\nInvocationID=${graph.invocation}\nControlGroup=${group}\n`};
  if (args.includes("--property=Id,InvocationID")) return { status: 0, stdout: `Id=${name}\nInvocationID=${graph.invocation}\n` };
  if (args[0] === "show") return { status: 0, stdout: `Id=${name}\nFragmentPath=/TEST/unit\nDropInPaths=\nControlGroup=${name === "TEST-supervisor.service" ? "/TEST/supervisor" : group}\nMainPID=${name === "TEST-supervisor.service" ? "123" : "0"}\n` };
  graph.effects.push([...args]);
  if (args[0] === "cancel" && graph.cancelWorks) graph.queue = graph.queue.split("\n").filter(row => !row.startsWith(args[1] + " ")).join("\n");
  if (args[0] === "kill") graph.signalHook?.();
  return { status: 0, stdout: "" }; // Effects do not implicitly kill descendants or proxy.
} }));
const id = "22222222-2222-4222-8222-222222222222", unit = `subscription-runtime-ordinary-${id}.service`;
const group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`;
let member: ScopedTerminationMember = { schemaVersion: 1, kind: ScopedTerminationKind.Runtime,
  identity: { scopeDigest: "a".repeat(64), installationId: "TEST-installation", hostId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", bootId: "11111111-1111-4111-8111-111111111111",
    supervisorId: "123:456", supervisorUnit: "TEST-supervisor.service", supervisorControlGroup: "/TEST/supervisor", accountId: "TEST-product", grantDigest: "b".repeat(64), inventoryDigest: "c".repeat(64), sourceSha: "d".repeat(40),
    artifactSha: "e".repeat(40), deadlineEpochMs: 100, authorityDigest: "f".repeat(64), slotId: "TEST-slot", parentStartId: id, dispatchIntentGeneration: 4 },
  startId: id, startDigest: "1".repeat(64), parentStartDigest: "1".repeat(64), reservationGeneration: 2, unit, controlGroup: group,
  creatorPidBirth: "124:457", creatorControlGroup: "/TEST/supervisor", invocationId: "a".repeat(32), submitterDigest: "2".repeat(64) };
function put(name: string, value: unknown): void { writeFileSync(join(graph.root, "policy", name), JSON.stringify(value) + "\n", { mode: 0o600 }); }
function retainTestDischarge(): void {
  const records = new ScopedTerminationRecords(() => {}), chain = records.actorChain(member);
  const discharge = new HostedReadonlyHostKernel().fenceScopedSubmitter(member, chain, 1000);
  withHostedActivationFence(f => records.retainDischarge(f, member, discharge));
}
const cgroup = (suffix = "") => join(graph.root, "cgroups") + group + suffix;
function population(suffix: string, populated: boolean): void {
  writeFileSync(cgroup(suffix) + "/cgroup.events", `populated ${populated ? 1 : 0}\nfrozen 0\n`);
  writeFileSync(cgroup(suffix) + "/cgroup.procs", populated ? "777\n" : "");
}
beforeEach(() => {
  graph.root = mkdtempSync(join(tmpdir(), "TEST-scoped-linux-")); graph.files.clear(); graph.invocation = "a".repeat(32); graph.queue = "";
  graph.cancelWorks = true; graph.effects = []; graph.pidfdCalls = []; graph.collectorError = false; graph.signalHook = null; graph.proxyExit = false; graph.actorExits.clear(); graph.realPids.clear(); graph.taskReads.clear(); graph.taskMutation = null; graph.fsyncHook = null;
  mkdirSync(join(graph.root, "policy"), { mode: 0o700 }); mkdirSync(cgroup("/nested/leaf"), { recursive: true });
  mkdirSync(join(graph.root, "units")); symlinkSync(graph.invocation, join(graph.root, "units", "invocation:" + unit));
  population("", false); population("/nested", false); population("/nested/leaf", false);
  graph.files.set("/proc/self/uid_map", "0 0 4294967295\n"); graph.files.set("/proc/self/cgroup", "0::/TEST/supervisor\n");
  graph.files.set("/etc/machine-id", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); graph.files.set("/proc/sys/kernel/random/boot_id", member.identity.bootId);
  graph.files.set("/proc/123/stat", "123 (TEST supervisor) " + [...Array(19).fill("0"), "456"].join(" "));
  graph.files.set("/proc/123/cgroup", "0::/TEST/supervisor\n");
  writeFileSync(join(graph.root, "policy/readonly-inventory.json"), JSON.stringify({ schemaVersion: 1, hostId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", supervisorUnit: "TEST-supervisor.service",
    units: [{ name: "TEST-supervisor.service", controlGroup: "/TEST/supervisor", fragmentSha256: "f".repeat(64) }],
    runtimeLaunch: { command: "/TEST/node", args: ["/TEST/runtime"], cwd: "/TEST/workspace" } }), { mode: 0o600 });
  graph.files.set("/proc/124/stat", "124 (TEST dispatcher) " + [...Array(19).fill("0"), "457"].join(" "));
  graph.files.set("/proc/124/cgroup", "0::/TEST/supervisor\n");
  for (const namespace of ["ordinary-submitters", "ordinary-invocations", "ordinary-actor-chains", "ordinary-submitter-exits", "scoped-terminating", "scoped-operations", "scoped-observations", "scoped-receipts"]) mkdirSync(join(graph.root, "policy", namespace), { mode: 0o700 });
  const { invocationId: _i, submitterDigest: _s, ...correlation } = member;
  const submitter = { schemaVersion: 1, correlationDigest: scopedDigest(correlation), pidBirth: "333:444", controlGroup: "/TEST/proxy" };
  put(`ordinary-submitters/${id}.json`, submitter);
  member = { ...member, submitterDigest: createHash("sha256").update(JSON.stringify(submitter) + "\n").digest("hex") };
  const chain = { schemaVersion: 1, correlationDigest: scopedDigest(correlation), submitterDigest: member.submitterDigest, actors: [
    { role: ScopedEnqueueActorRole.Creator, pidBirth: member.creatorPidBirth, controlGroup: member.creatorControlGroup, parentPidBirth: null },
    { role: ScopedEnqueueActorRole.Wrapper, pidBirth: "333:444", controlGroup: "/TEST/proxy", parentPidBirth: member.creatorPidBirth },
    { role: ScopedEnqueueActorRole.ManagerSubmitter, pidBirth: "334:445", controlGroup: "/TEST/proxy", parentPidBirth: "333:444" },
  ] };
  put(`ordinary-actor-chains/${id}.json`, chain);
  put(`scoped-terminating/${id}.json`, { schemaVersion: 1, identity: scopedFenceIdentity(member.identity), operationGeneration: 2, reservationIds: [id] });
  vi.spyOn(process, "getuid").mockReturnValue(0);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(graph.root, { recursive: true, force: true }); });
it("cancels only exact queued jobs; an acknowledgment with a still live queue is refused", () => {
  const kernel = new HostedReadonlyHostKernel(); graph.queue = `11 ${unit} start waiting\n12 TEST-other.service start waiting\n`;
  graph.cancelWorks = false; expect(() => kernel.drainScopedQueue(member, 1000)).toThrow();
  expect(graph.effects).toEqual([["cancel", "11"]]);
  graph.cancelWorks = true; kernel.drainScopedQueue(member, 1000);
  expect(graph.queue).toContain("12 TEST-other.service"); expect(graph.effects.every(args => args[1] === "11")).toBe(true);
});
it("stop and TERM acknowledgments cannot discharge a populated recursive descendant", () => {
  const kernel = new HostedReadonlyHostKernel(); population("/nested/leaf", true);
  kernel.signalScoped(member, ScopedSignal.Term, 1000);
  graph.proxyExit = true; retainTestDischarge();
  expect(kernel.collectScoped(member, 1000).recursiveEmpty).toBe(false);
  population("/nested/leaf", false);
  expect(kernel.collectScoped(member, 1000)).toMatchObject({ recursiveEmpty: true, queueEmpty: true, creatorFenced: true });
});
it.each(["birth", "invocation", "boot", "creator-group"])("changed %s prevents every destructive manager signal", kind => {
  if (kind === "birth") graph.files.set("/proc/123/stat", "123 (TEST replacement) " + [...Array(19).fill("0"), "999"].join(" "));
  if (kind === "invocation") graph.invocation = "b".repeat(32);
  if (kind === "boot") graph.files.set("/proc/sys/kernel/random/boot_id", "99999999-9999-4999-8999-999999999999");
  if (kind === "creator-group") graph.files.set("/proc/123/cgroup", "0::/TEST/foreign\n");
  expect(() => new HostedReadonlyHostKernel().signalScoped(member, ScopedSignal.Kill, 1000)).toThrow(); expect(graph.effects).toEqual([]);
});
it("replacement between TERM and stop receives no later effect", () => {
  graph.signalHook = () => { graph.invocation = "b".repeat(32); };
  expect(() => new HostedReadonlyHostKernel().signalScoped(member, ScopedSignal.Term, 1000)).toThrow();
  expect(graph.effects).toEqual([["kill", "--signal=SIGTERM", "--kill-whom=all", "--", unit]]);
});
it.each(["missing", "duplicate", "nonempty-procs", "manager-error", "malformed-queue"])("%s cannot become empty proof", kind => {
  if (kind === "missing") rmSync(cgroup("/nested/leaf") + "/cgroup.events");
  if (kind === "duplicate") writeFileSync(cgroup("/nested/leaf") + "/cgroup.events", "populated 0\npopulated 0\n");
  if (kind === "nonempty-procs") writeFileSync(cgroup("/nested/leaf") + "/cgroup.procs", "777\n");
  if (kind === "manager-error") graph.collectorError = true;
  if (kind === "malformed-queue") graph.queue = `11 ${unit} start waiting extra\n`;
  graph.proxyExit = true;
  if (kind !== "manager-error" && kind !== "malformed-queue") retainTestDischarge();
  const collect = () => new HostedReadonlyHostKernel().collectScoped(member, 1000);
  if (kind === "nonempty-procs") expect(collect().recursiveEmpty).toBe(false); else expect(collect).toThrow();
});
it("pidfd fencing refuses missing/partial completion, independently observed proxy exit is necessary", () => {
  expect(() => fenceScopedSubmitter("333:444", "/TEST/proxy", 1000)).toThrow();
  graph.proxyExit = true; expect(() => fenceScopedSubmitter("333:444", "/TEST/proxy", 1000)).not.toThrow();
  expect(collectScopedRecursiveEmpty(group, 1000).empty).toBe(true);
});

it("R2 wrapper exit cannot discharge a live manager submitter or missing chain", () => {
  const kernel = new HostedReadonlyHostKernel(), records = new ScopedTerminationRecords(() => {});
  graph.actorExits.add("333:444");
  expect(() => kernel.fenceScopedSubmitter(member, records.actorChain(member), 1000)).toThrow();
  expect(() => (kernel.collectScoped as (...args: unknown[]) => unknown)(member, 1000, true)).toThrow();
  rmSync(join(graph.root, `policy/ordinary-actor-chains/${id}.json`));
  expect(() => kernel.collectScoped(member, 1000)).toThrow();
});
it("R2 permits bounded positive collection after distinct dispatcher death with durable discharge", () => {
  graph.proxyExit = true; retainTestDischarge();
  graph.files.delete("/proc/124/stat"); graph.files.delete("/proc/124/cgroup");
  expect(new HostedReadonlyHostKernel().collectScoped(member, 1000)).toMatchObject({ creatorFenced: true, recursiveEmpty: true });
  rmSync(join(graph.root, `policy/ordinary-submitter-exits/${id}.json`));
  expect(() => new HostedReadonlyHostKernel().collectScoped(member, 1000)).toThrow();
});
it("R7 real drain accepts unrelated device and escaped swap jobs", () => {
  graph.queue = `11 ${unit} start waiting\n12 dev-loop0.device start running\n13 dev-disk-by\\x2duuid.swap stop waiting\n`;
  new HostedReadonlyHostKernel().drainScopedQueue(member, 1000);
  expect(graph.effects).toEqual([["cancel", "11"]]);
  expect(graph.queue).toContain("dev-loop0.device");
});

it("R8 short identity validation makes no manager calls and rejects a changed invocation anchor", () => {
  graph.proxyExit = true; retainTestDischarge();
  const kernel = new HostedReadonlyHostKernel(), observation = kernel.collectScoped(member, 1000);
  graph.collectorError = true; // Any blocking manager call would fail this assertion.
  withHostedActivationFence(() => expect(() => kernel.validateScopedPublication(member, observation.evidence)).not.toThrow());
  graph.invocation = "b".repeat(32);
  withHostedActivationFence(() => expect(() => kernel.validateScopedPublication(member, observation.evidence)).toThrow());
});

it("R2 authenticated producer refuses an omitted live enqueue descendant", () => {
  const records = new ScopedTerminationRecords(() => {}), chain = records.actorChain(member);
  const { invocationId: _i, submitterDigest: _s, ...correlation } = member;
  rmSync(join(graph.root, `policy/scoped-terminating/${id}.json`));
  for (const [pid, birth, parent, children] of [[124,457,123,"333 "], [333,444,124,"334 335 "], [334,445,333,""], [335,446,333,""]]) {
    graph.files.set(`/proc/${pid}/stat`, `${pid} (TEST actor) ` + ["S", String(parent), ...Array(17).fill("0"), String(birth)].join(" "));
    graph.files.set(`/proc/${pid}/cgroup`, pid === 124 ? "0::/TEST/supervisor\n" : "0::/TEST/proxy\n");
    graph.files.set(`/proc/${pid}/task/${pid}/children`, String(children));
    graph.files.set(`/proc/${pid}/task/${pid}/stat`, graph.files.get(`/proc/${pid}/stat`)!);
    graph.files.set(`/proc/${pid}/task/${pid}/status`, `Tgid:\t${pid}\nPid:\t${pid}\n`);
    graph.files.set(`/proc/${pid}/task/${pid}/cgroup`, graph.files.get(`/proc/${pid}/cgroup`)!);
  }
  withHostedActivationFence(f => expect(() => retainHostedScopedActorChain(f, correlation, chain)).toThrow("actor_chain_incomplete"));
  const complete: ScopedActorChain = { ...chain, actors: [...chain.actors, { role: ScopedEnqueueActorRole.ManagerSubmitter,
    pidBirth: "335:446", controlGroup: "/TEST/proxy", parentPidBirth: "333:444" }] };
  rmSync(join(graph.root, `policy/ordinary-actor-chains/${id}.json`));
  withHostedActivationFence(f => retainHostedScopedActorChain(f, correlation, complete));
  expect(records.actorChain(member)).toEqual(complete);
});


// Red on d420: the concrete producer accepts the chain with only the leader's
// child. The owned worker thread's child is independently visible in real procfs.
it("R2-A real procfs rejects an omitted worker-thread child and retains the complete graph", async () => {
  const wrapper = spawn(process.execPath, ["-e", `
    const {spawn} = require('node:child_process');
    const {Worker} = require('node:worker_threads');
    const main = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000); console.log("ready")']);
    const mainReady = new Promise(resolve => main.stdout.once('data', resolve));
    const worker = new Worker(\`
      const {parentPort} = require('node:worker_threads');
      const {spawn} = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000); console.log("ready")']);
      child.stdout.once('data', () => parentPort.postMessage(child.pid));
      parentPort.on('message', () => { child.once('exit', () => parentPort.postMessage('joined')); child.kill(); });
    \`, {eval:true});
    worker.on('message', message => {
      if (message === 'joined') worker.terminate().then(() => process.exit(0));
      else { mainReady.then(() => console.log(JSON.stringify({main:main.pid, threaded:message}))); }
    });
    process.stdin.once('data', () => { main.once('exit', () => worker.postMessage('join')); main.kill(); });
  `], { stdio: ["pipe", "pipe", "inherit"] });
  const exit = once(wrapper, "exit");
  try {
    const message = await new Promise<{main:number; threaded:number}>((resolve, reject) => {
      let buffer = ""; wrapper.stdout.on("data", data => { buffer += data; if (buffer.includes("\n")) resolve(JSON.parse(buffer.trim())); });
      wrapper.once("error", reject);
    });
    const pids = [process.pid, wrapper.pid!, message.main, message.threaded];
    pids.forEach(pid => graph.realPids.add(String(pid)));
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const birth = (pid:number) => `${pid}:${actualFs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(/\s+/)[19]}`;
    const observedGroup = actualFs.readFileSync(`/proc/${wrapper.pid}/cgroup`, "utf8");
    pids.forEach(pid => expect(actualFs.readFileSync(`/proc/${pid}/cgroup`, "utf8")).toBe(observedGroup));
    const controlGroup = observedGroup.trim().replace(/^0::/, "");
    const creator = { role: ScopedEnqueueActorRole.Creator, pidBirth: birth(process.pid), controlGroup, parentPidBirth: null };
    const proxy = { role: ScopedEnqueueActorRole.Wrapper, pidBirth: birth(wrapper.pid!), controlGroup, parentPidBirth: creator.pidBirth };
    const main = { role: ScopedEnqueueActorRole.ManagerSubmitter, pidBirth: birth(message.main), controlGroup, parentPidBirth: proxy.pidBirth };
    const threaded = { ...main, pidBirth: birth(message.threaded) };
    const { invocationId:_i, submitterDigest:_s, ...c } = member;
    const correlation = { ...c, creatorPidBirth: creator.pidBirth, creatorControlGroup: creator.controlGroup };
    const submitter = { schemaVersion:1, correlationDigest:scopedDigest(correlation), pidBirth:proxy.pidBirth, controlGroup:proxy.controlGroup };
    put(`ordinary-submitters/${id}.json`, submitter);
    const chain: ScopedActorChain = { schemaVersion:1, correlationDigest:scopedDigest(correlation), submitterDigest:createHash("sha256").update(JSON.stringify(submitter)+"\n").digest("hex"), actors:[creator,proxy,main] };
    rmSync(join(graph.root, `policy/scoped-terminating/${id}.json`)); rmSync(join(graph.root, `policy/ordinary-actor-chains/${id}.json`));
    expect(actualFs.readFileSync(`/proc/${wrapper.pid}/task/${wrapper.pid}/children`, "utf8").trim().split(/\s+/)).toContain(String(message.main));
    expect(actualFs.readFileSync(`/proc/${wrapper.pid}/task/${wrapper.pid}/children`, "utf8").trim().split(/\s+/)).not.toContain(String(message.threaded));
    expect(actualFs.readdirSync(`/proc/${wrapper.pid}/task`).some(tid => actualFs.readFileSync(`/proc/${wrapper.pid}/task/${tid}/children`, "utf8").trim().split(/\s+/).includes(String(message.threaded)))).toBe(true);
    withHostedActivationFence(f => expect(() => retainHostedScopedActorChain(f, correlation, chain)).toThrow("scoped_actor_chain_incomplete"));
    const complete = { ...chain, actors:[...chain.actors, threaded] };
    for (const pid of pids.slice(1)) for (const tid of actualFs.readdirSync(`/proc/${pid}/task`)) {
      const status = actualFs.readFileSync(`/proc/${pid}/task/${tid}/status`, "utf8");
      expect(status.match(/^Tgid:\s+([0-9]+)$/m)?.[1]).toBe(String(pid));
      expect(status.match(/^Pid:\s+([0-9]+)$/m)?.[1]).toBe(tid);
      expect(readFileSync(`/proc/${pid}/task/${tid}/cgroup`, "utf8"), `task cgroup ${pid}/${tid}`).toBe(observedGroup);
    }
    withHostedActivationFence(f => retainHostedScopedActorChain(f, correlation, complete));
    expect(JSON.parse(readFileSync(join(graph.root, `policy/ordinary-actor-chains/${id}.json`), "utf8"))).toEqual(complete);
  } finally {
    wrapper.stdin.end("join\n"); await exit;
  }
});

// Red on d420: ordinaryRuntimeInvocation returns a direct systemd-run manager,
// but the exact two-actor graph is rejected. No command is actually launched.
it("R2-B actual ordinary invocation and submitter producer retain a direct manager graph", () => {
  const invocation = new HostedReadonlyHostKernel().ordinaryRuntimeInvocation({ startId:id, unit, creatorId:"TEST-creator", generation:2, state:"reserved" } as never, "/TEST/workspace");
  expect(invocation.command).toBe("/usr/bin/systemd-run");
  const records = new ScopedTerminationRecords(() => {}), old = records.actorChain(member);
  const { invocationId:_i, submitterDigest:_s, ...correlation } = member;
  rmSync(join(graph.root, `policy/ordinary-submitters/${id}.json`)); rmSync(join(graph.root, `policy/ordinary-actor-chains/${id}.json`)); rmSync(join(graph.root, `policy/scoped-terminating/${id}.json`));
  for (const [pid, ticks, parent] of [[124,457,123], [333,444,124]]) {
    const stat = `${pid} (TEST actor) `+["S",String(parent),...Array(17).fill("0"),String(ticks)].join(" ");
    graph.files.set(`/proc/${pid}/stat`,stat); graph.files.set(`/proc/${pid}/task/${pid}/stat`,stat);
    graph.files.set(`/proc/${pid}/task/${pid}/status`, `Tgid:\t${pid}\nPid:\t${pid}\n`);
    graph.files.set(`/proc/${pid}/task/${pid}/children`, ""); graph.files.set(`/proc/${pid}/cgroup`, "0::/TEST/supervisor\n");
    graph.files.set(`/proc/${pid}/task/${pid}/cgroup`, "0::/TEST/supervisor\n");
  }
  withHostedActivationFence(f => retainHostedScopedSubmitter(f, correlation, {pid:333,on:()=>{}} as never));
  const bytes = readFileSync(join(graph.root, `policy/ordinary-submitters/${id}.json`));
  const direct: ScopedActorChain = {...old, submitterDigest:createHash("sha256").update(bytes).digest("hex"), actors:[old.actors[0]!, {...old.actors[1]!,role:ScopedEnqueueActorRole.ManagerSubmitter,controlGroup:"/TEST/supervisor"}]};
  withHostedActivationFence(f => retainHostedScopedActorChain(f,correlation,direct));
  member = {...member,submitterDigest:direct.submitterDigest};
  expect(records.actorChain(member)).toEqual(direct);
  put(`scoped-terminating/${id}.json`, {schemaVersion:1,identity:scopedFenceIdentity(member.identity),operationGeneration:2,reservationIds:[id]});
  expect(() => new HostedReadonlyHostKernel().fenceScopedSubmitter(member,direct,1000)).toThrow();
  graph.actorExits.add("333:444");
  const discharge = new HostedReadonlyHostKernel().fenceScopedSubmitter(member,direct,1000);
  withHostedActivationFence(f => records.retainDischarge(f,member,discharge));
  expect(records.discharge(member)).toEqual(discharge);
  expect(() => parseScopedActorDischarge({...discharge,actors:[discharge.actors[0]]},direct)).toThrow();
  expect(discharge.actors[1]!.method).toBe(ScopedActorDischargeMethod.PidfdExit);
  const kernel = new HostedReadonlyHostKernel(), premature = kernel.collectScoped(member,1000);
  expect(() => kernel.validateScopedPublication(member,premature.evidence)).toThrow();
  // The independent graph supplies actual exit facts, never the effect callback.
  graph.files.delete("/proc/333/stat"); graph.files.delete("/proc/333/cgroup");
  const observation = kernel.collectScoped(member,1000);
  kernel.validateScopedPublication(member,observation.evidence);
  const operation = {schemaVersion:1 as const,identity:member.identity,operationGeneration:2,members:[member]};
  const receipt = {schemaVersion:1 as const,outcome:ScopedTerminationOutcome.ReceiptBacked as const,operation,publicationGeneration:3,observations:[observation]};
  withHostedActivationFence(f => {records.retainOperation(f,operation); records.retainObservations(f,receipt); records.retainReceipt(f,receipt);});
  expect(records.receipt(id)).toEqual(receipt); records.validateObservations(receipt);
  put(`ordinary-actor-chains/${id}.next.json`,direct);
  expect(() => records.validateObservations(receipt)).toThrow("publication_pending");
});


function prepareHeldGraph(): { chain: ScopedActorChain; correlation: Omit<ScopedTerminationMember,"invocationId"|"submitterDigest"> } {
  const chain = new ScopedTerminationRecords(() => {}).actorChain(member);
  const {invocationId:_i,submitterDigest:_s,...correlation} = member;
  rmSync(join(graph.root, `policy/scoped-terminating/${id}.json`)); rmSync(join(graph.root, `policy/ordinary-actor-chains/${id}.json`));
  for (const [pid,ticks,parent,children,controlGroup] of [[124,457,123,"333 ","/TEST/supervisor"], [333,444,124,"334 ","/TEST/proxy"], [334,445,333,"","/TEST/proxy"]] as const) {
    const stat = `${pid} (TEST actor) `+["S",String(parent),...Array(17).fill("0"),String(ticks)].join(" ");
    graph.files.set(`/proc/${pid}/stat`,stat); graph.files.set(`/proc/${pid}/cgroup`, `0::${controlGroup}\n`);
    graph.files.set(`/proc/${pid}/task/${pid}/stat`,stat); graph.files.set(`/proc/${pid}/task/${pid}/status`, `Tgid:\t${pid}\nPid:\t${pid}\n`);
    graph.files.set(`/proc/${pid}/task/${pid}/cgroup`, `0::${controlGroup}\n`); graph.files.set(`/proc/${pid}/task/${pid}/children`,children);
  }
  return {chain,correlation};
}
it.each(["task-set", "duplicate-task", "excess-tasks", "wrong-tgid", "task-birth", "task-cgroup", "child-membership", "parent-edge"])("R2-A holds publication on %s ambiguity or change", attack => {
  const {chain,correlation} = prepareHeldGraph();
  if (attack === "task-set") graph.taskMutation = (path,count) => path === "/proc/333/task" && count > 1 ? ["333","336"] : undefined;
  if (attack === "duplicate-task") graph.taskMutation = path => path === "/proc/333/task" ? ["333","333"] : undefined;
  if (attack === "excess-tasks") graph.taskMutation = path => path === "/proc/333/task" ? Array.from({length:257},(_,i)=>String(333+i)) : undefined;
  if (attack === "wrong-tgid") graph.files.set("/proc/333/task/333/status", "Tgid:\t999\nPid:\t333\n");
  if (attack === "task-cgroup") graph.files.set("/proc/333/task/333/cgroup", "0::/TEST/foreign\n");
  graph.taskMutation ??= (path,count) => {
    if (path === "/proc/333/task" && count === 2) {
      if (attack === "task-birth") graph.files.set("/proc/333/task/333/stat", "333 (TEST replacement) "+["S","124",...Array(17).fill("0"),"999"].join(" "));
      if (attack === "child-membership") graph.files.set("/proc/333/task/333/children", "334 335 ");
      if (attack === "parent-edge") graph.files.set("/proc/334/stat", "334 (TEST changed parent) "+["S","999",...Array(17).fill("0"),"445"].join(" "));
    } return undefined;
  };
  withHostedActivationFence(f => expect(() => retainHostedScopedActorChain(f,correlation,chain)).toThrow());
  expect(() => readFileSync(join(graph.root, `policy/ordinary-actor-chains/${id}.json`))).toThrow();
  expect(graph.effects).toEqual([]);
});
it("R2-A kernel refuses a nonleader-thread child before any pidfd discharge", () => {
  const {chain} = prepareHeldGraph();
  put(`ordinary-actor-chains/${id}.json`,chain); put(`scoped-terminating/${id}.json`,{schemaVersion:1,identity:scopedFenceIdentity(member.identity),operationGeneration:2,reservationIds:[id]});
  graph.files.set("/proc/333/task/336/stat", "336 (TEST thread) "+["S","124",...Array(17).fill("0"),"999"].join(" "));
  graph.files.set("/proc/333/task/336/status", "Tgid:\t333\nPid:\t336\n"); graph.files.set("/proc/333/task/336/cgroup", "0::/TEST/proxy\n");
  graph.files.set("/proc/333/task/336/children", "335 "); graph.proxyExit = true;
  expect(() => new HostedReadonlyHostKernel().fenceScopedSubmitter(member,chain,1000)).toThrow();
  expect(new ScopedTerminationRecords(()=>{}).discharge(member)).toBeNull();
  expect(graph.pidfdCalls).toEqual([]);
});
it("R2-B wrapper-backed submitter still requires separate positive exits for every actual actor", () => {
  const {chain,correlation} = prepareHeldGraph();
  withHostedActivationFence(f => retainHostedScopedActorChain(f,correlation,chain));
  put(`scoped-terminating/${id}.json`,{schemaVersion:1,identity:scopedFenceIdentity(member.identity),operationGeneration:2,reservationIds:[id]});
  graph.actorExits.add("333:444");
  const kernel = new HostedReadonlyHostKernel(); expect(() => kernel.fenceScopedSubmitter(member,chain,1000)).toThrow();
  graph.actorExits.add("334:445"); const discharge = kernel.fenceScopedSubmitter(member,chain,1000);
  expect(discharge.actors.map(a=>a.method)).toEqual([ScopedActorDischargeMethod.ScopedAdmissionFence,ScopedActorDischargeMethod.PidfdExit,ScopedActorDischargeMethod.PidfdExit]);
  expect(() => parseScopedActorDischarge({...discharge,actors:discharge.actors.slice(0,2)},chain)).toThrow();
});

it("R2-A last pending-record ancestry fsync mutation leaves an unreadable durable obligation", () => {
  const {chain,correlation} = prepareHeldGraph();
  graph.fsyncHook = path => { if (path === "/") graph.files.set("/proc/333/task/333/children", "334 335 "); };
  withHostedActivationFence(f => expect(() => retainHostedScopedActorChain(f,correlation,chain)).toThrow());
  expect(() => readFileSync(join(graph.root, `policy/ordinary-actor-chains/${id}.json`))).toThrow();
  expect(JSON.parse(readFileSync(join(graph.root, `policy/ordinary-actor-chains/${id}.next.json`),"utf8"))).toEqual(chain);
  const records = new ScopedTerminationRecords(()=>{});
  expect(() => records.actorChain(member)).toThrow("publication_pending");
  graph.files.set("/proc/333/task/333/children", "334 "); graph.fsyncHook = null;
  withHostedActivationFence(f => expect(() => retainHostedScopedActorChain(f,correlation,chain)).toThrow("publication_pending"));
});
it.each(["duplicate-pid", "invented-wrapper", "manager-parent", "submitter-role"])("R2-B rejects %s instead of inventing topology", attack => {
  const chain = new ScopedTerminationRecords(()=>{}).actorChain(member);
  const actors = chain.actors.map(a=>({...a}));
  if (attack === "duplicate-pid") actors[2]!.pidBirth = "333:999";
  if (attack === "invented-wrapper") actors.pop();
  if (attack === "manager-parent") actors[2]!.parentPidBirth = member.creatorPidBirth;
  if (attack === "submitter-role") actors[1]!.role = ScopedEnqueueActorRole.Creator;
  expect(()=>parseScopedActorChain({...chain,actors})).toThrow();
});

it("R2-A observes the actual surviving manager after original creator and wrapper exit", () => {
  const {chain} = prepareHeldGraph();
  put(`ordinary-actor-chains/${id}.json`,chain); put(`scoped-terminating/${id}.json`,{schemaVersion:1,identity:scopedFenceIdentity(member.identity),operationGeneration:2,reservationIds:[id]});
  for (const pid of [124,333]) { graph.files.delete(`/proc/${pid}/stat`); graph.files.delete(`/proc/${pid}/cgroup`); }
  const survivor = "334 (TEST reparented manager) "+["S","1",...Array(17).fill("0"),"445"].join(" ");
  graph.files.set("/proc/334/stat",survivor); graph.files.set("/proc/334/task/334/stat",survivor);
  graph.proxyExit = true;
  const records = new ScopedTerminationRecords(()=>{}), kernel = new HostedReadonlyHostKernel();
  const discharge = kernel.fenceScopedSubmitter(member,chain,1000);
  expect(graph.taskReads.get("/proc/334/task")).toBeGreaterThan(0);
  expect(graph.taskReads.has("/proc/333/task")).toBe(false);
  withHostedActivationFence(f => records.retainDischarge(f,member,discharge));
  expect(kernel.collectScoped(member,1000).creatorFenced).toBe(true);
});

it("R2-A scopes enumeration and pidfd effects to the admitted subtree, excluding creator siblings", () => {
  const {chain,correlation} = prepareHeldGraph();
  graph.files.set("/proc/124/task/124/children", "333 999 ");
  graph.files.set("/proc/999/stat", "999 (TEST foreign) "+["S","124",...Array(17).fill("0"),"999"].join(" "));
  withHostedActivationFence(f => retainHostedScopedActorChain(f,correlation,chain));
  expect(graph.taskReads.has("/proc/124/task")).toBe(false); expect(graph.taskReads.has("/proc/999/task")).toBe(false);
  put(`scoped-terminating/${id}.json`,{schemaVersion:1,identity:scopedFenceIdentity(member.identity),operationGeneration:2,reservationIds:[id]});
  graph.proxyExit = true; new HostedReadonlyHostKernel().fenceScopedSubmitter(member,chain,1000);
  expect(graph.pidfdCalls).toEqual(["334:445","333:444"]); expect(graph.files.has("/proc/999/stat")).toBe(true);
});
