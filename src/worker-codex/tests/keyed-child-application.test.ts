import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, symlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChildContinuationMode, AgentRuntimeTool, parseImmutableChildSlot } from "@vioxen/subscription-runtime/core";
import { CodexProviderEgressProfileId, HostedControllerToolName, withHostedActivationFence, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { KeyedChildLedger, KeyedChildProfile as Profile, KeyedChildState as State, NoEffectProofKind, type ReviewedChildAuthority } from "../../worker-core/project-control/domain/keyed-child-launch";
import { KeyedChildLaunchApplication, ScopedStopResult } from "../../worker-core/project-control/application/keyed-child-launch";
import { KeyedLaunchLedgerStore } from "../hosted-controller/keyed-launch-ledger-store";
import { RetainedKeyedAuthority } from "../hosted-controller/retained-authority";
import { SlotMaterialization } from "../hosted-controller/slot-materialization";
import { KeyedChildDispatchAdapter, OrdinaryKeyedChildHost, consumeFreshKeyedSubmission, type FreshKeyedSubmission } from "../hosted-controller/child-submission";
import { HostedControllerOriginCapability } from "../hosted-controller-origin-binding";
import { assertHostedControllerKeyedToolAdapter, HostedControllerKeyedToolAdapter } from "../hosted-controller/tool-adapter";
import { HostedControllerFramedDispatcher, hostedControllerAdapterFromFramedDispatcher, hostedControllerPipe } from "../hosted-controller-framed-dispatcher";
import { PassThrough } from "node:stream";
import { FakeAppServerFactory } from "../../provider-codex/app-server/testing/fake-app-server";
import { CodexAppServerClient } from "../../provider-codex/app-server/application/app-server-client";
import { resolveCodexExecutionProfile } from "../../provider-codex/codex-execution-profile";
import { AppServerDynamicToolHandler } from "../../provider-codex/app-server/application/app-server-dynamic-tool-handler";

const facts = vi.hoisted(() => ({ root: "", fail: "", effect: null as (() => void) | null,
  gate: null as Promise<void> | null, fdPaths: new Map<number, string>(), reads: [] as string[] }));
const policy = "/var/lib/subscription-runtime-host-policy";
const local = (path: string) => ["/var", "/var/lib", policy].includes(path) ? facts.root :
  path.startsWith(policy + "/") ? join(facts.root, path.slice(policy.length + 1)) : path;
// Host metadata is synthetic; byte writes, nofollow, inodes, modes, fsync and
// renameat2 remain real on fresh TEST files. No production filesystem hook.
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    lstatSync: (path: string) => {
      const stat = fs.lstatSync(local(path));
      const ancestor = facts.root.startsWith(path === "/" ? path : path + "/");
      return Object.assign(stat, { uid: 0, mode: ancestor ? stat.mode & ~0o022 : stat.mode });
    },
    fstatSync: (fd: number) => Object.assign(fs.fstatSync(fd), { uid: 0 }),
    readlinkSync: (path: string) => path.startsWith("/proc/") ? "namespace:TEST" : fs.readlinkSync(path),
    readFileSync: (path: string | number, options: Parameters<typeof fs.readFileSync>[1]) =>
      path === "/proc/self/uid_map" ? "0 0 4294967295\n" : path === "/proc/sys/kernel/random/boot_id" ? "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n" : fs.readFileSync(typeof path === "string" ? local(path) : path, options),
    openSync: (path: string, flags: number, mode: number) => {
      facts.reads.push(path);
      const fd = fs.openSync(local(path), flags, mode); facts.fdPaths.set(fd, path); return fd;
    },
    closeSync: (fd: number) => { facts.fdPaths.delete(fd); fs.closeSync(fd); },
    mkdirSync: (path: string, options: Parameters<typeof fs.mkdirSync>[1]) => fs.mkdirSync(local(path), options),
    rmdirSync: (path: string) => fs.rmdirSync(local(path)),
    fsyncSync: (fd: number) => {
      if (facts.fail === "claim-fsync" && facts.fdPaths.get(fd)?.endsWith(".next")) throw new Error("TEST failed claim fsync");
      fs.fsyncSync(fd);
    },
  };
});
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, mkdir: (path: string, options: Parameters<typeof fs.mkdir>[1]) => fs.mkdir(local(path), options),
    rmdir: (path: string) => fs.rmdir(local(path)) };
});
// Controlled checkout process, separate from controlled host submission. Its
// output is checked against real private workspace HEAD bytes by the adapter.
vi.mock("node:child_process", async original => {
  const cp = await original<typeof import("node:child_process")>();
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const run = (_command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    void (async () => {
      try {
        if (facts.gate) await facts.gate;
        if (args.includes("clone")) { const workspace = args.at(-1)!; fs.mkdirSync(join(workspace, ".git"), { recursive: true }); }
        if (args.includes("checkout")) fs.writeFileSync(join(args[1]!, ".git", "HEAD"), args.at(-1)! + "\n");
        facts.effect?.();
        if (facts.fail === "checkout") throw new Error("TEST partial checkout");
        callback(null, args.includes("rev-parse") ? fs.readFileSync(join(args[1]!, ".git", "HEAD"), "utf8") :
          args.includes("status") && facts.fail === "dirty-source" ? " M TEST.md\n" : "", "");
      } catch (error) { callback(error as Error, "", ""); }
    })();
  };
  const { promisify } = await import("node:util");
  return { ...cp, execFile: Object.assign(run, { [promisify.custom]: (command: string, args: string[], options: unknown) =>
    new Promise((resolve, reject) => run(command, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))) }) };
});
vi.mock("../hosted-readonly-host-kernel", async original => ({ ...await original<typeof import("../hosted-readonly-host-kernel")>(),
  readHostedReadonlyHostInventory: () => JSON.parse(readFileSync(join(facts.root, "inventory.json"), "utf8")) }));
vi.mock("../hosted-installation-activation", async original => ({ ...await original<typeof import("../hosted-installation-activation")>(),
  readHostedInstallationActivation: () => ({ installation: { runtimeSha: "d".repeat(40) }, activation: { phase: "ORDINARY" } }) }));
vi.mock("../hosted-readonly-custody", async original => ({ ...await original<typeof import("../hosted-readonly-custody")>(),
  readonlySupervisorRoot: "/var/lib/subscription-runtime-host-policy" }));
vi.mock("../hosted-test-egress-files", async original => ({ ...await original<typeof import("../hosted-test-egress-files")>(),
  hostedTestEgressGrantRoot: "/var/lib/subscription-runtime-host-policy/grants" }));
const digest = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
function deferred() { let resolve!: () => void; let reject!: (error: Error) => void; const promise = new Promise<void>((r, e) => { resolve = r; reject = e; }); return { promise, resolve, reject }; }
const request = { key: "TEST-key", profile: Profile.ReadOnly, task: "Exact TEST task\n😀" };
let stop!: () => void;
let joinWork: (() => Promise<void>) | undefined;
beforeEach(() => {
  facts.root = mkdtempSync(join(tmpdir(), "pr4-TEST-application-")); facts.fail = ""; facts.gate = null; facts.effect = null; facts.reads = [];
  vi.spyOn(process, "getuid").mockReturnValue(0);
});
afterEach(async () => { stop?.(); await joinWork?.(); vi.useRealTimers(); vi.restoreAllMocks(); rmSync(facts.root, { recursive: true, force: true }); });
function fixture(production = false, deadline = Date.now() + 60000) {
  for (const name of ["keyed-child-ledgers", "child-slots", "grants", "prompts", "source", "jobs"]) mkdirSync(join(facts.root, name), { mode: 0o700 });
  const slots = [1, 2].map(n => {
    const slotId = `TEST-slot-${n}`, creatorId = `TEST-creator-${n}`, jobId = `TEST-child-${n}`, jobRootDir = join(facts.root, "jobs", jobId);
    mkdirSync(jobRootDir, { mode: 0o700 });
    const workspacePath = jobRootDir + "/workspace", promptPath = join(facts.root, "prompts", jobId + ".md");
    const lifetime = { schemaVersion: 1, accountId: "account-s", deadlineEpochMs: deadline, maxGoalTurns: 2, maxAttempts: 1,
      maxAccountCycles: 1, continuationMode: ChildContinuationMode.Disabled, allowedTools: [AgentRuntimeTool.ReadFile],
      denyProjectInstructions: true, accessBoundary: "read_only" };
    const grant = { schemaVersion: 3, slotId, jobId, jobRootDir, workspacePath, accountId: "account-s", hostedProfile: "child",
      profileId: CodexProviderEgressProfileId.MimoTokenPlan, modelBackend: "xiaomi-mimo-token-plan", executionEngine: "app-server-goal", namedPermissions: true, globalScanGuard: true, nativeToolSurface: "disabled" };
    const grantBytes = JSON.stringify(grant) + "\n";
    writeFileSync(join(facts.root, "grants", digest(jobId) + ".json"), grantBytes, { mode: 0o600 });
    const launch = { command: process.execPath, cwd: workspacePath, args: ["/TEST/cli.js", "run", "--prompt", promptPath, "--workspace", workspacePath,
      "--job-root", jobRootDir, "--job-id", jobId, "--task-id", jobId, "--auth-root", jobRootDir + "/capacity", "--codex-binary", "/TEST/pinned-codex",
      "--accounts", "account-s", "--max-account-cycles", "1", "--max-attempts", "1", "--continuation-mode", "disabled", "--max-goal-turns", "2",
      "--child-lifetime-json", JSON.stringify(lifetime), "--execution-engine", "app-server-goal", "--model-backend", "xiaomi-mimo-token-plan",
      "--model", "mimo-v2.6-pro", "--access-boundary", "read_only", "--edit-mode", "read-only",
      "--project-access-scope-json", JSON.stringify({ projectId: jobId, readRoots: [workspacePath] })] };
    const slot = parseImmutableChildSlot({ schemaVersion: 1, slotId, creatorId, jobId, jobRootDir, workspacePath, promptPath,
      sourceSha: "c".repeat(40), artifactSha: "d".repeat(40), grantSha256: digest(grantBytes), launch, lifetime });
    writeFileSync(join(facts.root, "child-slots", digest(creatorId) + ".json"), JSON.stringify(slot) + "\n", { mode: 0o600 });
    return slot;
  });
  const creators = slots.map(slot => ({ creatorId: slot.creatorId, jobId: slot.jobId, jobRootDir: slot.jobRootDir, workspacePath: slot.workspacePath,
    launch: slot.launch, childSlotSha256: digest(JSON.stringify(slot) + "\n") }));
  writeFileSync(join(facts.root, "inventory.json"), JSON.stringify({ ordinaryCreators: creators }), { mode: 0o600 });
  const grant = "TEST-private-grant-".repeat(3);
  let changedOrigin = false, changedGrant = false;
  const origin = HostedControllerOriginCapability.retain({
    readRetainedOrigin: () => ({ installationId: "11111111-1111-1111-1111-111111111111", startId: "22222222-2222-2222-2222-222222222222",
      jobId: changedOrigin ? "TEST-foreign" : "TEST-controller", originSha256: "a".repeat(64) }),
    readPrivateGrant: () => Buffer.from(changedGrant ? grant + "changed" : grant),
  });
  const authority: ReviewedChildAuthority = { projectId: "TEST-project", workstreamId: "TEST-work", controllerId: "TEST-controller",
    grantDigest: digest(grant), reviewedSnapshotDigest: digest(slots), accountId: "account-s", sourceSha: "c".repeat(40), artifactSha: "d".repeat(40),
    absoluteDeadline: deadline, maxGoalTurns: 2, effectiveOptionDigest: digest(slots.map(s => s.lifetime)) };
  const allocations = slots.map(slot => { const startId = randomUUID(); return { slotId: slot.slotId, requestId: randomUUID(), operationId: randomUUID(),
    childHandle: randomUUID(), startId, unitCorrelation: `subscription-runtime-ordinary-${startId}.service`, profile: Profile.ReadOnly }; });
  const retained = new RetainedKeyedAuthority(origin, authority, allocations), store = new KeyedLaunchLedgerStore(authority, allocations);
  withHostedActivationFence(f => store.initialize(f));
  const wait = deferred(), calls: FreshKeyedSubmission[] = [], stops: string[] = [];
  const host = production ? new OrdinaryKeyedChildHost() : { submitFresh(fence: HostedActivationFence, permission: FreshKeyedSubmission) {
    consumeFreshKeyedSubmission(fence, permission);
    const durable = store.readHeld(fence, authority, retained.seed.authorityDigest).observe(authority, permission.binding.childHandle);
    expect(durable.state).toBe(State.DispatchIntent); expect(durable.startId).toBe(permission.binding.startId);
    calls.push(permission);
    if (facts.fail === "before-os") { calls.pop(); throw new Error("TEST before OS call"); }
    if (facts.fail === "accepted-then-throw") throw new Error("TEST accepted then lost response");
    return { completion: wait.promise };
  } };
  const materialization = new SlotMaterialization(retained, join(facts.root, "source"));
  const adapter = new KeyedChildDispatchAdapter(retained, store, materialization, host, { request: async binding => { stops.push(binding.startId); return ScopedStopResult.Unresolved; } });
  const app = new KeyedChildLaunchApplication(adapter), tools = new HostedControllerKeyedToolAdapter(retained, app);
  stop = wait.resolve; joinWork = () => app.drain();
  return { slots, authority, allocations, store, retained, adapter, app, tools, wait, calls, stops, materialization,
    ledger: () => withHostedActivationFence(f => store.readHeld(f, authority, retained.seed.authorityDigest)),
    originChanged: () => { changedOrigin = true; }, grantChanged: () => { changedGrant = true; } };
}
async function submitted(f: ReturnType<typeof fixture>) {
  await vi.waitFor(() => expect(f.calls.length).toBe(1));
}

describe("PR4 keyed application with private TEST persistence and controlled host", () => {
  it("concurrent identical keys claim once, acknowledge before prep/wait, and submit once", async () => {
    const f = fixture(), prep = deferred(); facts.gate = prep.promise;
    const views = await Promise.all(Array.from({ length: 8 }, () => f.app.launch(request, new AbortController().signal)));
    expect(new Set(views.map(v => v.childHandle)).size).toBe(1); expect(f.calls).toHaveLength(0);
    expect(views[0]!.state).toBe(State.Claimed); expect(f.ledger().remainingAllowance).toBe(1);
    prep.resolve(); await submitted(f);
    const view = await f.app.observe(views[0]!.childHandle); expect(view.state).toBe(State.Submitted);
    await f.app.stop(view.operationHandle); await f.app.stop(view.childHandle);
    expect(f.ledger().observe(f.authority, view.childHandle).state).toBe(State.StopRequested);
    f.wait.resolve(); await f.app.drain();
    expect((await f.app.observe(view.childHandle)).state).toBe(State.StopRequested); expect(f.calls).toHaveLength(1);
  });
  it("different keys consume no loser slot and changed request conflicts", async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.app.launch(request, new AbortController().signal), f.app.launch({ ...request, key: "other" }, new AbortController().signal)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(f.ledger().remainingAllowance).toBe(1);
    await expect(f.app.launch({ ...request, task: "changed" }, new AbortController().signal)).rejects.toThrow("key conflict");
    await submitted(f); f.wait.resolve(); await f.app.drain(); expect(f.calls).toHaveLength(1);
    expect((await f.app.observe(f.allocations[0]!.childHandle)).occupied).toBe(true);
  });
  it("terminal same key keeps original handles forever without new effects", async () => {
    const f = fixture();
    await f.adapter.coordinate(async () => {
      const claim = await f.store.transact(f.authority, f.retained.seed.authorityDigest, 0, l => l.accept(0, request, Date.now()));
      await f.store.transact(f.authority, f.retained.seed.authorityDigest, claim.generation, l => l.terminalizeBeforeIntent({ kind: NoEffectProofKind.IndependentlyEstablished,
        correlation: l.observe(f.authority, f.allocations[0]!.childHandle), evidenceDigest: "a".repeat(64) }));
    });
    const replay = await f.app.launch(request, new AbortController().signal);
    expect(replay.state).toBe(State.Terminal); expect(replay.childHandle).toBe(f.allocations[0]!.childHandle); expect(f.calls).toHaveLength(0);
    expect(f.ledger().remainingAllowance).toBe(1);
  });
  it("cancelled response/dropped acknowledgment retains accepted work independently", async () => {
    const f = fixture(), signal = new AbortController(); const view = await f.app.launch(request, signal.signal); signal.abort();
    await submitted(f); const replay = await f.app.launch(request, new AbortController().signal);
    expect(replay.childHandle).toBe(view.childHandle); f.wait.resolve(); await f.app.drain(); expect(f.calls).toHaveLength(1);
  });
  it("failed claim durability has zero materialization and never empties pending ledger", async () => {
    const f = fixture(); facts.fail = "claim-fsync";
    await expect(f.app.launch(request, new AbortController().signal)).rejects.toThrow();
    expect(readdirSync(join(facts.root, "prompts"))).toHaveLength(0); expect(f.calls).toHaveLength(0);
    facts.fail = ""; await expect(f.app.launch(request, new AbortController().signal)).rejects.toThrow("pending");
  });
  it.each(["checkout", "before-os", "accepted-then-throw"])("retains claim/correlation across %s and never invokes replay", async failure => {
    const f = fixture(); facts.fail = failure; const first = await f.app.launch(request, new AbortController().signal); await f.app.drain();
    const l = f.ledger(), binding = l.observe(f.authority, first.childHandle);
    expect(binding.state).toBe(State.Uncertain); expect(l.occupied).toBe(true);
    expect(!!binding.dispatchIntent).toBe(failure !== "checkout");
    facts.fail = ""; expect((await f.app.launch(request, new AbortController().signal)).childHandle).toBe(first.childHandle);
    expect(f.calls).toHaveLength(failure === "accepted-then-throw" ? 1 : 0);
    const restarted = new KeyedChildLaunchApplication(f.adapter);
    await restarted.launch(request, new AbortController().signal); await restarted.drain(); expect(f.calls).toHaveLength(failure === "accepted-then-throw" ? 1 : 0);
  });
  it.each(["origin", "grant", "foreign-handle"])("denies %s before any target manifest opens", async mode => {
    const f = fixture(); if (mode === "origin") f.originChanged(); if (mode === "grant") f.grantChanged(); facts.reads = [];
    await expect(f.app.observe("foreign")).rejects.toThrow();
    expect(facts.reads.some(path => path.includes("keyed-child-manifest") || path.includes("keyed-publication"))).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  it("expired input and cancelled preclaim do not allocate; production activation stays closed", async () => {
    const f = fixture(true); const cancelled = new AbortController(); cancelled.abort();
    await expect(f.app.launch(request, cancelled.signal)).rejects.toThrow(); expect(f.ledger().generation).toBe(0);
    const view = await f.app.launch(request, new AbortController().signal); await f.app.drain();
    expect(f.calls).toHaveLength(0); expect((await f.app.observe(view.childHandle)).occupied).toBe(true);
    expect(() => new OrdinaryKeyedChildHost().submitFresh({ held: true }, { binding: f.ledger().observe(f.authority, view.childHandle), retained: f.retained })).toThrow();
  });
  it("deadline cannot renew by replay; missing termination port remains unresolved", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const f = fixture(false, Date.now() + 5000); const view = await f.app.launch(request, new AbortController().signal); await submitted(f);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(async () => expect((await f.app.observe(view.childHandle)).state).toBe(State.StopRequested), { timeout: 1500 });
    expect(f.stops).toEqual([f.allocations[0]!.startId]);
    await f.app.launch(request, new AbortController().signal); expect(f.calls).toHaveLength(1); f.wait.resolve(); await f.app.drain();
  });
  it("exact prompt and manifest replay preserves bytes; conflicts/partial/symlink fail without clobber", async () => {
    const f = fixture(); await f.app.launch(request, new AbortController().signal); await submitted(f);
    const binding = f.ledger().observe(f.authority, f.allocations[0]!.childHandle), path = join(f.slots[0]!.jobRootDir, "keyed-child-manifest.json"), original = readFileSync(path);
    await f.materialization.materialize(binding, request.task); expect(readFileSync(path)).toEqual(original);
    writeFileSync(path, original.subarray(0, 6), { mode: 0o600 }); await expect(f.materialization.materialize(binding, request.task)).rejects.toThrow(); expect(readFileSync(path)).toEqual(original.subarray(0, 6));
    rmSync(path); symlinkSync(f.slots[0]!.promptPath, path); await expect(f.materialization.materialize(binding, request.task)).rejects.toThrow();
    f.wait.resolve(); await f.app.drain(); expect(f.calls).toHaveLength(1);
  });
  it.each(["directory", "symlink"])("replaced parent during staging (%s) is rejected and claim is held", async mode => {
    const f = fixture(); facts.effect = () => { facts.effect = null; const parent = f.slots[0]!.jobRootDir; renameSync(parent, parent + "-old"); if (mode === "directory") mkdirSync(parent, { mode: 0o700 }); else symlinkSync(parent + "-old", parent); };
    const view = await f.app.launch(request, new AbortController().signal); await f.app.drain();
    expect(f.ledger().occupied).toBe(true); expect(f.calls).toHaveLength(0);
  });
  it.each(["accountId", "sourceSha", "artifactSha"])("rejects changed reviewed %s before any manifest reads", field => {
    const f = fixture(); facts.reads = [];
    const change = field === "accountId" ? "foreign-account" : "f".repeat(40);
    expect(() => new RetainedKeyedAuthority(f.retained.origin, { ...f.authority, [field]: change }, f.allocations)).toThrow();
    expect(facts.reads.some(path => path.includes("keyed-child-manifest"))).toBe(false); expect(f.calls).toHaveLength(0);
  });
  it("expired new key has no claim while original intent remains permanently ineligible", async () => {
    const f = fixture(false, Date.now() - 1);
    await expect(f.app.launch(request, new AbortController().signal)).rejects.toThrow("deadline"); expect(f.ledger().generation).toBe(0);
  });
  it("existing intent and absent unit cannot recreate ephemeral permission", async () => {
    const f = fixture();
    let binding = f.retained.seed.accept(0, request, Date.now()).observe(f.authority, f.allocations[0]!.childHandle);
    await f.adapter.coordinate(async () => {
      for (const state of [State.Claimed, State.Materializing, State.Prepared, State.DispatchIntent]) {
        const current = f.adapter.read();
        const next = await f.store.transact(f.authority, f.retained.seed.authorityDigest, current.generation,
          l => state === State.Claimed ? l.accept(l.generation, request, Date.now()) : l.advance(l.observe(f.authority, binding.childHandle), state, Date.now()));
        binding = next.observe(f.authority, binding.childHandle);
      }
      expect(() => f.adapter.dispatchPrepared(binding)).toThrow();
    });
    const view = await f.app.launch(request, new AbortController().signal); await f.app.drain();
    expect(view.state).toBe(State.DispatchIntent); expect(view.occupied).toBe(true); expect(f.calls).toHaveLength(0);
  });
  it("stop without a PR5 implementation is durable unresolved; returned booleans never release", async () => {
    const f = fixture(), app = new KeyedChildLaunchApplication(new KeyedChildDispatchAdapter(f.retained, f.store, f.materialization, new OrdinaryKeyedChildHost()));
    const view = await app.launch(request, new AbortController().signal); await app.drain();
    const stopped = await app.stop(view.childHandle); expect(stopped.reason).toBe("termination_unresolved"); expect(stopped.occupied).toBe(true);
    expect((await app.stop(view.operationHandle)).state).toBe(State.StopRequested);
  });
  it("detects substituted checkout source and refuses transport overrides without target effects", async () => {
    const f = fixture(); facts.effect = () => {
      const head = join(f.slots[0]!.workspacePath, ".git", "HEAD");
      try { writeFileSync(head, "f".repeat(40) + "\n"); } catch { /* Clone has not populated HEAD yet. */ }
    };
    await f.app.launch(request, new AbortController().signal); await f.app.drain(); expect(f.calls).toHaveLength(0); expect(f.ledger().occupied).toBe(true);
    facts.reads = [];
    const result = await f.tools.dispatch({ tool: HostedControllerToolName.Launch, arguments: { key: "different", profile: "read-only", task: "bounded", account: "foreign", sourceSha: "f".repeat(40) } }, new AbortController().signal);
    expect(result.status).toBe("rejected"); expect(facts.reads.some(path => path.includes("keyed-child-manifest"))).toBe(false);
  });
  it("actual client -> handler -> framed dispatcher returns typed handles; channel loss never re-invokes", async () => {
    const f = fixture(), inbound = new PassThrough(), outbound = new PassThrough();
    const channel = new HostedControllerFramedDispatcher(hostedControllerPipe(inbound, outbound));
    const hostChannel = new HostedControllerFramedDispatcher(hostedControllerPipe(outbound, inbound), { retainedTools: f.tools });
    const factory = new FakeAppServerFactory({ suppressTurnCompletion: true }), abort = new AbortController();
    const client = new CodexAppServerClient({ codexBinaryPath: "/TEST/pinned-codex", sourceEnv: {}, processFactory: factory.create,
      signalChildProcess: (child, signal) => { child.kill(signal); },
      session: { home: facts.root, codexHome: facts.root, env: {}, release: async () => undefined },
      workspacePath: facts.root, executionProfile: resolveCodexExecutionProfile({ kind: "custom", disableTools: false, historyMode: "none" }),
      nativeToolSurface: "disabled", timeoutMs: 2000, startupTimeoutMs: 2000, reconnectGraceMs: 100, maxOutputBytes: 4096,
      abortSignal: abort.signal, hostedControllerTools: hostedControllerAdapterFromFramedDispatcher(channel) });
    await client.start();
    const threadId = await client.startThread({ workspacePath: facts.root, model: "TEST-model", reasoningEffort: "low", timeoutMs: 2000, abortSignal: abort.signal, goalMode: true });
    const turn = client.startTurn({ threadId, prompt: "TEST controller", model: "TEST-model", reasoningEffort: "low", workspacePath: facts.root, timeoutMs: 10000, abortSignal: abort.signal, goalMode: true });
    void turn.catch(() => {});
    try {
      await vi.waitFor(() => expect(factory.requests.some(r => r.method === "turn/start")).toBe(true));
      const thread = factory.requests.find(r => r.method === "thread/start")!;
      expect((thread.params!.dynamicTools as unknown[]).length).toBe(3); expect(thread.params!.environments).toEqual([]);
      factory.processes[0]!.stdout.emit("data", JSON.stringify({ id: 9001, method: "item/tool/call", params: { namespace: null,
        threadId, turnId: "turn-1", callId: "TEST-transport-call", tool: "launch", arguments: { key: request.key, task: request.task, profile: "read-only" } } }) + "\n");
      await vi.waitFor(() => expect(factory.responses.some(r => r.id === 9001)).toBe(true));
      const result = factory.responses.find(r => r.id === 9001)!.result as { success: boolean; contentItems: { text: string }[] };
      expect(result.success).toBe(true); expect(JSON.parse(result.contentItems[0]!.text).view.childHandle).toBe(f.allocations[0]!.childHandle);
      await submitted(f); channel.close(); hostChannel.close();
      const replay = await f.app.launch(request, new AbortController().signal); expect(replay.childHandle).toBe(f.allocations[0]!.childHandle);
      f.wait.resolve(); await f.app.drain(); expect(f.calls).toHaveLength(1); expect(f.ledger().occupied).toBe(true);
    } finally { abort.abort(); await turn.catch(() => {}); await client.stop(); channel.close(); hostChannel.close(); }
  });
  it("dropped framed ack ends only the response; one claimed owner continues preparation", async () => {
    const f = fixture(), prep = deferred(); facts.gate = prep.promise;
    const inbound = new PassThrough(), outbound = new PassThrough();
    const client = new HostedControllerFramedDispatcher(hostedControllerPipe(inbound, outbound));
    const server = new HostedControllerFramedDispatcher(hostedControllerPipe(outbound, inbound), { retainedTools: f.tools });
    vi.spyOn(inbound, "write").mockReturnValue(true); // Accepted bytes are lost by the TEST transport.
    const response = await client.request({ tool: HostedControllerToolName.Launch,
      arguments: { key: request.key, task: request.task, profile: "read-only" } }, new AbortController().signal, 200);
    expect(response).toBe("unavailable"); expect(f.ledger().occupied).toBe(true); expect(f.calls).toHaveLength(0);
    prep.resolve(); await submitted(f); client.close(); server.close();
    expect((await f.app.launch(request, new AbortController().signal)).childHandle).toBe(f.allocations[0]!.childHandle);
    f.wait.resolve(); await f.app.drain(); expect(f.calls).toHaveLength(1);
  });
  it("rejects forged retained adapter/authority and calls outside async coordination", () => {
    const f = fixture();
    expect(() => assertHostedControllerKeyedToolAdapter(Object.create(HostedControllerKeyedToolAdapter.prototype))).toThrow();
    expect(() => new SlotMaterialization(Object.create(RetainedKeyedAuthority.prototype), join(facts.root, "source"))).toThrow();
    expect(() => f.adapter.read()).toThrow("coordination_required");
  });
  it("a dispatcher clock rollback fails before claim, without renewing the lifetime", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000); const f = fixture(); clock.mockReturnValue(999);
    await expect(f.app.launch(request, new AbortController().signal)).rejects.toThrow("clock_inconsistent");
    expect(f.ledger().generation).toBe(0); expect(f.calls).toHaveLength(0); expect(readdirSync(join(facts.root, "prompts"))).toHaveLength(0);
  });
  it("a dirty retained workspace cannot substitute source bytes beneath a matching HEAD", async () => {
    const f = fixture(); facts.fail = "dirty-source";
    await f.app.launch(request, new AbortController().signal); await f.app.drain();
    expect(f.calls).toHaveLength(0); expect(f.ledger().occupied).toBe(true);
  });
  it("retryable foreground failure remains held and never invokes a second submission", async () => {
    const f = fixture(), view = await f.app.launch(request, new AbortController().signal); await submitted(f);
    f.wait.reject(new Error("TEST retryable provider failure")); await f.app.drain();
    expect((await f.app.observe(view.childHandle)).state).toBe(State.Uncertain);
    expect((await f.app.launch(request, new AbortController().signal)).childHandle).toBe(view.childHandle);
    expect(f.calls).toHaveLength(1); expect(f.ledger().occupied).toBe(true);
  });
  it("uses the real handler and framed dispatcher: typed ack while foreground pending; stop remains held", async () => {
    const f = fixture(); const inbound = new PassThrough(), outbound = new PassThrough();
    const client = new HostedControllerFramedDispatcher(hostedControllerPipe(inbound, outbound));
    const server = new HostedControllerFramedDispatcher(hostedControllerPipe(outbound, inbound), { retainedTools: f.tools });
    const replies: Record<string, unknown>[] = [];
    const handler = new AppServerDynamicToolHandler({ adapter: hostedControllerAdapterFromFramedDispatcher(client), isActiveTurn: () => true,
      logicalTurnId: id => id, isTerminal: () => false, respond: (_id, result) => replies.push(result) }); handler.addThread("TEST-thread");
    const invoke = (id: number, tool: HostedControllerToolName, args: object) => handler.call(id, { namespace: null, threadId: "TEST-thread", turnId: "TEST-turn", callId: "call-" + id, tool, arguments: args });
    await invoke(1, HostedControllerToolName.Launch, { key: request.key, profile: "read-only", task: request.task });
    expect(replies[0]!.success).toBe(true); await submitted(f);
    await invoke(2, HostedControllerToolName.Stop, { handle: f.allocations[0]!.childHandle });
    expect(JSON.stringify(replies[1])).toContain("termination_unresolved");
    await invoke(3, HostedControllerToolName.Observe, { handle: "foreign" }); expect(replies[2]!.success).toBe(false);
    handler.close(); client.close(); server.close(); f.wait.resolve(); await f.app.drain(); expect(f.calls).toHaveLength(1);
  });
});
