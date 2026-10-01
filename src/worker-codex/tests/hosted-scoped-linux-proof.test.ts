import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostedReadonlyHostKernel } from "../hosted-readonly-host-kernel";
import { collectScopedRecursiveEmpty, fenceScopedSubmitter } from "../hosted-readonly-linux-collector";
import { ScopedSignal, ScopedTerminationKind, type ScopedTerminationMember } from "../../worker-core/hosted-custody/domain/scoped-termination";
const graph = vi.hoisted(() => ({ root: "", files: new Map<string, string>(), invocation: "a".repeat(32), creatorBirth: "456",
  queue: "", cancelWorks: true, effects: [] as string[][], collectorError: false, signalHook: null as (() => void) | null, proxyExit: false }));
const policy = "/var/lib/subscription-runtime-host-policy";
const local = (path: string) => ["/var", "/var/lib"].includes(path) ? graph.root : path === policy || path.startsWith(policy + "/") ? graph.root + "/policy" + path.slice(policy.length) :
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
    readlinkSync: () => "TEST-namespace",
  };
});
vi.mock("node:child_process", () => ({ spawnSync: (command: string, args: string[]) => {
  if (command === "/usr/bin/python3") return { status: graph.proxyExit ? 0 : 1, stdout: graph.proxyExit ?
    JSON.stringify({ pidBirth: args[4], controlGroup: args[5], exitObserved: true }) : "" };
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
const member: ScopedTerminationMember = { schemaVersion: 1, kind: ScopedTerminationKind.Runtime,
  identity: { scopeDigest: "a".repeat(64), installationId: "TEST-installation", hostId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", bootId: "11111111-1111-4111-8111-111111111111",
    supervisorId: "123:456", supervisorUnit: "TEST-supervisor.service", supervisorControlGroup: "/TEST/supervisor", accountId: "TEST-product", grantDigest: "b".repeat(64), inventoryDigest: "c".repeat(64), sourceSha: "d".repeat(40),
    artifactSha: "e".repeat(40), deadlineEpochMs: 100, authorityDigest: "f".repeat(64), slotId: "TEST-slot", parentStartId: id, dispatchIntentGeneration: 4 },
  startId: id, startDigest: "1".repeat(64), parentStartDigest: "1".repeat(64), reservationGeneration: 2, unit, controlGroup: group,
  creatorPidBirth: "123:456", creatorControlGroup: "/TEST/supervisor", invocationId: "a".repeat(32), submitterDigest: "2".repeat(64) };
const cgroup = (suffix = "") => join(graph.root, "cgroups") + group + suffix;
function population(suffix: string, populated: boolean): void {
  writeFileSync(cgroup(suffix) + "/cgroup.events", `populated ${populated ? 1 : 0}\nfrozen 0\n`);
  writeFileSync(cgroup(suffix) + "/cgroup.procs", populated ? "777\n" : "");
}
beforeEach(() => {
  graph.root = mkdtempSync(join(tmpdir(), "TEST-scoped-linux-")); graph.files.clear(); graph.invocation = "a".repeat(32); graph.queue = "";
  graph.cancelWorks = true; graph.effects = []; graph.collectorError = false; graph.signalHook = null; graph.proxyExit = false;
  mkdirSync(join(graph.root, "policy"), { mode: 0o700 }); mkdirSync(cgroup("/nested/leaf"), { recursive: true });
  population("", false); population("/nested", false); population("/nested/leaf", false);
  graph.files.set("/proc/self/uid_map", "0 0 4294967295\n"); graph.files.set("/proc/self/cgroup", "0::/TEST/supervisor\n");
  graph.files.set("/etc/machine-id", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); graph.files.set("/proc/sys/kernel/random/boot_id", member.identity.bootId);
  graph.files.set("/proc/123/stat", "123 (TEST supervisor) " + [...Array(19).fill("0"), "456"].join(" "));
  graph.files.set("/proc/123/cgroup", "0::/TEST/supervisor\n");
  writeFileSync(join(graph.root, "policy/readonly-inventory.json"), JSON.stringify({ schemaVersion: 1, hostId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", supervisorUnit: "TEST-supervisor.service",
    units: [{ name: "TEST-supervisor.service", controlGroup: "/TEST/supervisor", fragmentSha256: "f".repeat(64) }],
    runtimeLaunch: { command: "/TEST/node", args: ["/TEST/runtime"], cwd: "/TEST/workspace" } }), { mode: 0o600 });
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
  expect(kernel.collectScoped(member, 1000, true).recursiveEmpty).toBe(false);
  population("/nested/leaf", false);
  expect(kernel.collectScoped(member, 1000, false)).toMatchObject({ recursiveEmpty: true, creatorFenced: false });
  expect(kernel.collectScoped(member, 1000, true)).toMatchObject({ recursiveEmpty: true, queueEmpty: true, creatorFenced: true });
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
  const collect = () => new HostedReadonlyHostKernel().collectScoped(member, 1000, true);
  if (kind === "nonempty-procs") expect(collect().recursiveEmpty).toBe(false); else expect(collect).toThrow();
});
it("pidfd fencing refuses missing/partial completion, independently observed proxy exit is necessary", () => {
  expect(() => fenceScopedSubmitter("333:444", "/TEST/proxy", 1000)).toThrow();
  graph.proxyExit = true; expect(() => fenceScopedSubmitter("333:444", "/TEST/proxy", 1000)).not.toThrow();
  expect(collectScopedRecursiveEmpty(group, 1000).empty).toBe(true);
});
