import { ScopedTerminationRecords, scopedFenceIdentity } from "../hosted-controller/scoped-termination-records";
import { withHostedActivationFence, retainHostedScopedActorChain } from "@vioxen/subscription-runtime/provider-codex";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostedReadonlyHostKernel } from "../hosted-readonly-host-kernel";
import { collectScopedRecursiveEmpty, fenceScopedSubmitter } from "../hosted-readonly-linux-collector";
import { scopedDigest, ScopedEnqueueActorRole, ScopedSignal, ScopedTerminationKind, type ScopedActorChain, type ScopedTerminationMember } from "../../worker-core/hosted-custody/domain/scoped-termination";
const graph = vi.hoisted(() => ({ root: "", files: new Map<string, string>(), invocation: "a".repeat(32), creatorBirth: "456",
  queue: "", cancelWorks: true, effects: [] as string[][], collectorError: false, signalHook: null as (() => void) | null, proxyExit: false, actorExits: new Set<string>() }));
const policy = "/var/lib/subscription-runtime-host-policy";
const local = (path: string) => ["/var", "/var/lib"].includes(path) ? graph.root : path === policy || path.startsWith(policy + "/") ? graph.root + "/policy" + path.slice(policy.length) :
  path.startsWith("/run/systemd/units") ? graph.root + "/units" + path.slice("/run/systemd/units".length) :
  path.startsWith("/sys/fs/cgroup") ? graph.root + "/cgroups" + path.slice("/sys/fs/cgroup".length) : path;
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    readFileSync: (path: string | number, options: unknown) => {
      if (typeof path === "string" && graph.files.has(path)) return graph.files.get(path)!;
      if (typeof path === "string" && path.startsWith("/proc/") && !path.startsWith("/proc/self/fd/")) throw Object.assign(new Error("TEST absent task"), { code: "ENOENT" });
      return fs.readFileSync(typeof path === "string" ? local(path) : path, options as never);
    },
    lstatSync: (path: string) => { const s = fs.lstatSync(local(path)); return Object.assign(s, { uid: 0,
      mode: graph.root.startsWith(path === "/" ? path : path + "/") || path === "/var" || path === "/var/lib" ? s.mode & ~0o022 : s.mode }); },
    statSync: (path: string) => Object.assign(fs.statSync(local(path)), { uid: 0 }),
    fstatSync: (fd: number) => Object.assign(fs.fstatSync(fd), { uid: 0 }),
    openSync: (path: string, flags: number, mode: number) => fs.openSync(local(path), flags, mode),
    mkdirSync: (path: string, options: Parameters<typeof fs.mkdirSync>[1]) => fs.mkdirSync(local(path), options),
    rmdirSync: (path: string) => fs.rmdirSync(local(path)),
    readlinkSync: (path: string) => path.includes("/invocation:") ? graph.invocation : "TEST-namespace",
  };
});
vi.mock("node:child_process", () => ({ spawnSync: (command: string, args: string[]) => {
  if (command === "/usr/bin/python3") { const exited = graph.proxyExit || graph.actorExits.has(args[4]!); return { status: exited ? 0 : 1, stdout: exited ?
    JSON.stringify({ pidBirth: args[4], controlGroup: args[5], exitObserved: true }) : "" }; }
  if (command !== "/usr/bin/systemctl") throw new Error("TEST foreign command");
  if (graph.collectorError) return { status: 1, stdout: "" };
  const name = args.at(-1)!;
  if (args[0] === "list-jobs") return { status: 0, stdout: graph.queue };
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
  graph.cancelWorks = true; graph.effects = []; graph.collectorError = false; graph.signalHook = null; graph.proxyExit = false; graph.actorExits.clear();
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
  for (const namespace of ["ordinary-submitters", "ordinary-actor-chains", "ordinary-submitter-exits", "scoped-terminating"]) mkdirSync(join(graph.root, "policy", namespace), { mode: 0o700 });
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
  }
  withHostedActivationFence(f => expect(() => retainHostedScopedActorChain(f, correlation, chain)).toThrow("actor_chain_incomplete"));
  const complete: ScopedActorChain = { ...chain, actors: [...chain.actors, { role: ScopedEnqueueActorRole.ManagerSubmitter,
    pidBirth: "335:446", controlGroup: "/TEST/proxy", parentPidBirth: "333:444" }] };
  rmSync(join(graph.root, `policy/ordinary-actor-chains/${id}.json`));
  withHostedActivationFence(f => retainHostedScopedActorChain(f, correlation, complete));
  expect(records.actorChain(member)).toEqual(complete);
});
