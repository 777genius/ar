import { ScopedTerminationValidator } from "../hosted-controller/scoped-termination-validation";
import { HostedKeyedScopedStopAdapter, type ScopedTerminationKernelPort } from "../hosted-controller/scoped-termination-adapter";
import { ScopedTerminationKind, ScopedSignal, stableChildDigest, scopedDigest,
  ScopedEnqueueActorRole, ScopedActorDischargeMethod, type ScopedActorChain, type ScopedTerminationMember, type RuntimeValidatedTermination, type RuntimeValidatedOrdinaryTermination } from "../../worker-core/hosted-custody/domain/scoped-termination";
import { HostedInstallationActivationStore } from "../hosted-installation-activation";
import { KeyedAuthorizationMode as Mode, type KeyedScopedStopPort } from "../../worker-core/project-control/ports/keyed-child-application-ports";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, symlinkSync, readdirSync, chmodSync, linkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChildContinuationMode, AgentRuntimeTool, parseImmutableChildSlot } from "@vioxen/subscription-runtime/core";
import { CodexProviderEgressProfileId, HostedControllerToolName, assertHostedScopedAdmission, retainHostedScopedCorrelation, withHostedActivationFence, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { KeyedChildLedger, KeyedChildProfile as Profile, KeyedChildState as State, NoEffectProofKind, type ReviewedChildAuthority } from "../../worker-core/project-control/domain/keyed-child-launch";
import { KeyedChildLaunchApplication, ScopedStopReason, ScopedStopResult } from "../../worker-core/project-control/application/keyed-child-launch";
import { KeyedLaunchLedgerStore } from "../hosted-controller/keyed-launch-ledger-store";
import { RetainedKeyedAuthority } from "../hosted-controller/retained-authority";
import { SlotMaterialization } from "../hosted-controller/slot-materialization";
import { PreintentPreparationRecords } from "../hosted-controller/preintent-preparation-records";
import { PreparationEffect } from "../../worker-core/hosted-custody/domain/preintent-preparation";
import { KeyedChildDispatchAdapter, OrdinaryKeyedChildHost, consumeFreshKeyedSubmission, type FreshKeyedSubmission, type OwnedPreparationNativePort } from "../hosted-controller/child-submission";
import { HostedControllerOriginCapability } from "../hosted-controller-origin-binding";
import { assertHostedControllerKeyedToolAdapter, HostedControllerKeyedToolAdapter } from "../hosted-controller/tool-adapter";
import { HostedControllerFramedDispatcher, hostedControllerAdapterFromFramedDispatcher, hostedControllerPipe } from "../hosted-controller-framed-dispatcher";
import { PassThrough } from "node:stream";
import { FakeAppServerFactory } from "../../provider-codex/app-server/testing/fake-app-server";
import { CodexAppServerClient } from "../../provider-codex/app-server/application/app-server-client";
import { resolveCodexExecutionProfile } from "../../provider-codex/codex-execution-profile";
import { AppServerDynamicToolHandler } from "../../provider-codex/app-server/application/app-server-dynamic-tool-handler";
const facts = vi.hoisted(() => ({ root: "", fail: "", effect: null as (() => void) | null,
  syncFault: "", mutateOnSync: null as (() => void) | null,
  gate: null as Promise<void> | null, checkoutGate: null as Promise<void> | null,
  checkoutEntered: null as (() => void) | null, fdPaths: new Map<number, string>(), reads: [] as string[] }));
const policy = "/var/lib/subscription-runtime-host-policy";
const local = (path: string) => ["/var", "/var/lib", policy].includes(path) ? facts.root :
  path.startsWith(policy + "/") ? join(facts.root, path.slice(policy.length + 1)) : path;
// Host metadata is synthetic; byte writes, nofollow, inodes, modes, fsync and renameat2 remain real on fresh TEST files. No production filesystem hook.
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
      const fd = fs.openSync(local(path), flags, mode);
      const anchored = /^\/proc\/self\/fd\/(\d+)\/(.*)$/.exec(path);
      facts.fdPaths.set(fd, anchored ? facts.fdPaths.get(Number(anchored[1])) + "/" + anchored[2] : path); facts.reads.push(facts.fdPaths.get(fd)!); return fd;
    },
    closeSync: (fd: number) => { facts.fdPaths.delete(fd); fs.closeSync(fd); },
    mkdirSync: (path: string, options: Parameters<typeof fs.mkdirSync>[1]) => fs.mkdirSync(local(path), options),
    rmdirSync: (path: string) => fs.rmdirSync(local(path)),
    renameSync: (from: string, to: string) => fs.renameSync(local(from), local(to)),
    fsyncSync: (fd: number) => {
      if (facts.fail === "claim-fsync" && facts.fdPaths.get(fd)?.endsWith(".next")) throw new Error("TEST failed claim fsync");
      const path = facts.fdPaths.get(fd) ?? "";
      if ((facts.syncFault === "marker" && path.includes("/scoped-terminating/")) ||
          (facts.syncFault === "receipt-file" && path.includes("/scoped-receipts/") && path.endsWith(".json")) ||
          (facts.syncFault === "receipt-parent" && path.endsWith("/scoped-receipts")) ||
          (facts.syncFault === "activation" && path.endsWith("host-activation.next")) ||
          (facts.syncFault === "keyed" && path.includes("/keyed-child-ledgers/") && path.endsWith(".next")) ||
          (facts.syncFault === "preparation-close" && path.endsWith("/keyed-preparation-closed.json"))) throw new Error("TEST publication interrupted");
      fs.fsyncSync(fd);
      if (path.endsWith("/scoped-receipts") && facts.mutateOnSync) { const mutate = facts.mutateOnSync; facts.mutateOnSync = null; mutate(); }
    },
  };
});
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, mkdir: (path: string, options: Parameters<typeof fs.mkdir>[1]) => fs.mkdir(local(path), options),
    rmdir: (path: string) => fs.rmdir(local(path)) };
});
// Controlled checkout process, separate from controlled host submission. Its output is checked against real private workspace HEAD bytes by the adapter.
vi.mock("node:child_process", async original => {
  const cp = await original<typeof import("node:child_process")>();
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const run = (_command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    void (async () => {
      try {
        if (facts.gate) await facts.gate;
        if (args.includes("clone")) { const workspace = args.at(-1)!; fs.mkdirSync(join(workspace, ".git"), { recursive: true }); }
        if (args.includes("checkout")) { facts.checkoutEntered?.(); if (facts.checkoutGate) await facts.checkoutGate; }
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
vi.mock("../hosted-readonly-custody", async original => ({ ...await original<typeof import("../hosted-readonly-custody")>(),
  readonlySupervisorRoot: "/var/lib/subscription-runtime-host-policy" }));
vi.mock("../hosted-test-egress-files", async original => ({ ...await original<typeof import("../hosted-test-egress-files")>(),
  hostedTestEgressGrantRoot: "/var/lib/subscription-runtime-host-policy/grants" }));
const digest = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
function deferred() { let resolve!: () => void; let reject!: (error: Error) => void; const promise = new Promise<void>((r, e) => { resolve = r; reject = e; }); return { promise, resolve, reject }; }
async function bounded<T>(work: Promise<T>, timeoutMs = 1000): Promise<T> { const timeout = new AbortController();
  try { return await Promise.race([work, delay(timeoutMs, undefined, { signal: timeout.signal }).then(() => {
    throw new Error("TEST controlled work did not settle while preparation remained gated");
  })]); } finally { timeout.abort(); }
}
const request = { key: "TEST-key", profile: Profile.ReadOnly, task: "Exact TEST task\n😀" };
let stop!: () => void;
let joinWork: (() => Promise<void>) | undefined;
beforeEach(() => {
  facts.root = mkdtempSync(join(tmpdir(), "pr4-TEST-application-")); facts.fail = ""; facts.gate = null; facts.effect = null; facts.checkoutGate = null; facts.checkoutEntered = null; facts.reads = []; facts.syncFault = ""; facts.mutateOnSync = null;
  vi.spyOn(process, "getuid").mockReturnValue(0);
});
afterEach(async () => { stop?.(); await joinWork?.(); vi.useRealTimers(); vi.restoreAllMocks(); rmSync(facts.root, { recursive: true, force: true }); });
function testPreparationNative(): OwnedPreparationNativePort {
  // Policy/wiring fixture only. It explicitly supplies NO native quiescence authority and can never authorize a persisted pre-intent terminal.
  return { retain: owner => ({ owner, assertAdmission: () => {}, requestStop: () => {},
    join: async () => null, authenticateQuiescence: () => { throw new Error("TEST has no native authority"); },
    startGit: (_effect, args, remainingMs) => ({ completion: promisify(execFile)("/usr/bin/git", [...args], { env: {}, timeout: remainingMs }) }),
  }) };
}
function fixture(production = false, deadline = Date.now() + 60000, stopMode: "unresolved" | "throw" | "absent" | "proof" = "unresolved", nativeAvailable: boolean | OwnedPreparationNativePort = true) {
  for (const name of ["keyed-child-ledgers", "child-slots", "grants", "prompts", "source", "jobs", "scoped-terminating", "keyed-child-owners"]) mkdirSync(join(facts.root, name), { mode: 0o700 });
  const slots = [1, 2].map(n => {
    const slotId = `TEST-slot-${n}`, creatorId = `TEST-creator-${n}`, jobId = `TEST-child-${n}`, jobRootDir = join(facts.root, "jobs", jobId);
    mkdirSync(jobRootDir, { mode: 0o700 });
    const workspacePath = jobRootDir + "/workspace", promptPath = join(facts.root, "prompts", jobId + ".md");
    const lifetime = { schemaVersion: 1, accountId: "TEST-inventory-product", deadlineEpochMs: deadline, maxGoalTurns: 2, maxAttempts: 1,
      maxAccountCycles: 1, continuationMode: ChildContinuationMode.Disabled, allowedTools: [AgentRuntimeTool.ReadFile],
      denyProjectInstructions: true, accessBoundary: "read_only" };
    const grant = { schemaVersion: 3, slotId, jobId, jobRootDir, workspacePath, accountId: "TEST-inventory-product", hostedProfile: "child",
      profileId: CodexProviderEgressProfileId.MimoTokenPlan, modelBackend: "xiaomi-mimo-token-plan", executionEngine: "app-server-goal", namedPermissions: true, globalScanGuard: true, nativeToolSurface: "disabled" };
    const grantBytes = JSON.stringify(grant) + "\n";
    writeFileSync(join(facts.root, "grants", digest(jobId) + ".json"), grantBytes, { mode: 0o600 });
    const launch = { command: process.execPath, cwd: workspacePath, args: ["/TEST/cli.js", "run", "--prompt", promptPath, "--workspace", workspacePath,
      "--job-root", jobRootDir, "--job-id", jobId, "--task-id", jobId, "--auth-root", jobRootDir + "/capacity", "--codex-binary", "/TEST/pinned-codex",
      "--accounts", lifetime.accountId, "--max-account-cycles", "1", "--max-attempts", "1", "--continuation-mode", "disabled", "--max-goal-turns", "2",
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
  writeFileSync(join(facts.root, "inventory.json"), JSON.stringify({ ordinaryCreators: creators, supervisorUnit: "TEST-supervisor.service", units: [{ name: "TEST-supervisor.service", controlGroup: "/TEST/supervisor" }] }), { mode: 0o600 });
  const grant = "TEST-private-grant-".repeat(3);
  let changedOrigin = false, changedGrant = false;
  const origin = HostedControllerOriginCapability.retain({
    readRetainedOrigin: () => ({ installationId: "11111111-1111-1111-1111-111111111111", startId: "22222222-2222-2222-2222-222222222222",
      jobId: changedOrigin ? "TEST-foreign" : "TEST-controller", originSha256: "a".repeat(64) }),
    readPrivateGrant: () => Buffer.from(changedGrant ? grant + "changed" : grant),
  });
  const authority: ReviewedChildAuthority = { projectId: "TEST-project", workstreamId: "TEST-work", controllerId: "TEST-controller",
    grantDigest: digest(grant), reviewedSnapshotDigest: digest(slots), accountId: "TEST-inventory-product", sourceSha: "c".repeat(40), artifactSha: "d".repeat(40),
    absoluteDeadline: deadline, maxGoalTurns: 2, effectiveOptionDigest: digest(slots.map(s => s.lifetime)) };
  const allocations = slots.map(slot => { const startId = randomUUID(); return { slotId: slot.slotId, requestId: randomUUID(), operationId: randomUUID(),
    childHandle: randomUUID(), startId, unitCorrelation: `subscription-runtime-ordinary-${startId}.service`, profile: Profile.ReadOnly }; });
  writeFileSync(join(facts.root, "host-installation.json"), JSON.stringify({ schemaVersion: 1, installationId: "TEST-installation", hostId: "TEST-host",
    runtimeDirectory: "/TEST/runtime", runtimeSha: "d".repeat(40), runtimeManifestSha256: "1".repeat(64), inventorySha256: "f".repeat(64) }) + "\n", { mode: 0o600 });
  writeFileSync(join(facts.root, "host-activation.json"), JSON.stringify({ schemaVersion: 1, installationId: "TEST-installation", hostId: "TEST-host",
    bootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", supervisorId: "10:100", generation: 1, phase: "ORDINARY", ordinaryOriginsSha256: "2".repeat(64),
    exclusiveEnrollmentSha256: null, ordinaryStarts: [] }) + "\n", { mode: 0o600 });
  const retained = new RetainedKeyedAuthority(origin, authority, allocations), store = new KeyedLaunchLedgerStore(authority, allocations);
  withHostedActivationFence(f => store.initialize(f));
  const wait = deferred(), submittedSignal = deferred(), calls: FreshKeyedSubmission[] = [], stops: string[] = [];
  const host = production ? new OrdinaryKeyedChildHost() : { submitFresh(fence: HostedActivationFence, permission: FreshKeyedSubmission) {
    consumeFreshKeyedSubmission(fence, permission);
    const durable = store.readHeld(fence, authority, retained.seed.authorityDigest).observe(authority, permission.binding.childHandle);
    expect(durable.state).toBe(State.DispatchIntent); expect(durable.startId).toBe(permission.binding.startId);
    calls.push(permission);
    if (facts.fail === "before-os") { calls.pop(); throw new Error("TEST before OS call"); }
    if (facts.fail === "accepted-then-throw") throw new Error("TEST accepted then lost response");
    submittedSignal.resolve();
    return { completion: wait.promise };
  } };
  const materialization = new SlotMaterialization(retained, join(facts.root, "source"));
  let concreteProof: KeyedScopedStopPort | undefined;
  const stopRequests: { startId: string; reason: ScopedStopReason; at: number }[] = [];
  const adapter = new KeyedChildDispatchAdapter(retained, store, materialization, host, stopMode === "absent" ? undefined : {
    request: async (binding, reason) => {
      stops.push(binding.startId); stopRequests.push({ startId: binding.startId, reason, at: Date.now() });
      if (stopMode === "proof" && concreteProof) return concreteProof.request(binding, reason);
      if (stopMode === "throw") throw new Error("TEST unresolved stop failure");
      return ScopedStopResult.Unresolved;
    },
  }, typeof nativeAvailable === "boolean" ? nativeAvailable ? testPreparationNative() : undefined : nativeAvailable);
  const app = new KeyedChildLaunchApplication(adapter), tools = new HostedControllerKeyedToolAdapter(retained, app);
  stop = wait.resolve; joinWork = () => app.drain();
  return { slots, authority, allocations, store, retained, adapter, app, tools, wait, submittedSignal, calls, stops, stopRequests, materialization,
    ledger: () => withHostedActivationFence(f => store.readHeld(f, authority, retained.seed.authorityDigest)),
    bindProof: (port: KeyedScopedStopPort) => { concreteProof = port; },
    originChanged: () => { changedOrigin = true; }, grantChanged: () => { changedGrant = true; } };
}
async function submitted(f: ReturnType<typeof fixture>) {
  await bounded(f.submittedSignal.promise, 5000);
  await bounded(f.adapter.coordinate(async () => {}, Mode.Cleanup), 5000);
  expect(f.calls).toHaveLength(1);
}
describe("PR4 keyed application with private TEST persistence and controlled host", () => {
  it.each(["missing-custody", "rejected-admission"] as const)("failed original retention (%s) durably closes admission before launch rejects", async mode => {
    const requested = vi.fn(), joined = vi.fn(async () => null), base = testPreparationNative();
    let retains = 0;
    const native: OwnedPreparationNativePort = { retain: owner => {
      retains++;
      return { ...base.retain(owner), requestStop: requested, join: joined,
        assertAdmission: () => { throw new Error("TEST original admission rejected"); } };
    } };
    const f = fixture(false, Date.now() + 60000, "unresolved", mode === "missing-custody" ? false : native);
    await expect(f.app.launch(request, new AbortController().signal)).rejects.toThrow(
      mode === "missing-custody" ? "preparation_original_native_custody_required" : "TEST original admission rejected");
    const handle = f.allocations[0]!.childHandle, slot = f.slots[0]!;
    const stopped = f.ledger();
    expect(stopped.observe(f.authority, handle).state).toBe(State.StopRequested);
    expect(stopped.observe(f.authority, handle).dispatchIntent).toBeNull();
    expect(stopped.occupied).toBe(true); expect(stopped.remainingAllowance).toBe(1);
    const closurePath = join(slot.jobRootDir, "keyed-preparation-closed.json");
    const closure = readFileSync(closurePath);
    const ownerPath = join(slot.jobRootDir, "keyed-preparation-owner.json"), ownerBytes = readFileSync(ownerPath);
    const owner = JSON.parse(ownerBytes.toString("utf8")) as
      { preparationGeneration: number; deadlineEpochMs: number; maxGoalTurns: number };
    expect(JSON.parse(closure.toString("utf8"))).toMatchObject({ preparationGeneration: owner.preparationGeneration,
      closureGeneration: stopped.generation, reason: ScopedStopReason.Completion });
    expect(owner.deadlineEpochMs).toBe(f.authority.absoluteDeadline); expect(owner.maxGoalTurns).toBe(f.authority.maxGoalTurns);
    expect(() => readFileSync(slot.promptPath)).toThrow();
    expect(() => readFileSync(join(slot.jobRootDir, "keyed-publication.json"))).toThrow();
    const replay = await f.app.launch(request, new AbortController().signal);
    expect(replay.childHandle).toBe(handle); expect(replay.state).toBe(State.StopRequested);
    expect(retains).toBe(mode === "missing-custody" ? 0 : 1);
    if (mode === "rejected-admission") {
      expect(requested).toHaveBeenCalled(); await vi.waitFor(() => expect(joined).toHaveBeenCalledOnce());
    }
    await f.app.stop(handle, ScopedStopReason.Budget);
    expect(readFileSync(closurePath)).toEqual(closure);
    expect(readFileSync(ownerPath)).toEqual(ownerBytes);
    expect(f.ledger().generation).toBe(stopped.generation); expect(f.ledger().remainingAllowance).toBe(stopped.remainingAllowance);
    expect(f.calls).toHaveLength(0);
    if (mode === "rejected-admission") expect(joined).toHaveBeenCalledOnce();
    await expect(f.app.launch({ ...request, key: "next" }, new AbortController().signal)).rejects.toThrow("occupied");
  });
  it("closed preparation record inventory captures zero effects and refuses an unknown durable prefix", async () => {
    const f = fixture(false, Date.now() + 60000, "unresolved", false);
    await expect(f.app.launch(request, new AbortController().signal)).rejects.toThrow("preparation_original_native_custody_required");
    await f.app.stop(f.allocations[0]!.childHandle);
    const records = new PreintentPreparationRecords(f.retained);
    const binding = f.ledger().observe(f.authority, f.allocations[0]!.childHandle);
    const inventory = withHostedActivationFence(fence => records.closedInventory(fence, binding));
    expect(Object.keys(inventory.prefixDigests).sort()).toEqual(Object.values(PreparationEffect).sort());
    expect(Object.values(inventory.prefixDigests).every(value => value === null)).toBe(true);
    expect(inventory.ledgerGeneration).toBe(binding.generation);
    const closure = readFileSync(join(f.slots[0]!.jobRootDir, "keyed-preparation-closed.json"));
    expect(inventory.closureDigest).toBe(createHash("sha256").update(closure).digest("hex"));
    writeFileSync(join(f.slots[0]!.jobRootDir, "keyed-preparation-effect-unknown.json"), "{}\n", { mode: 0o600 });
    expect(() => withHostedActivationFence(fence => records.closedInventory(fence, binding))).toThrow("preparation_ownership_conflict");
    expect(f.ledger().occupied).toBe(true);
  });
  it("failed initial preparation closure fsync preserves the launch error and stops original custody without renewing allowance", async () => {
    const requested = vi.fn(), joined = vi.fn(async () => null), base = testPreparationNative();
    const native: OwnedPreparationNativePort = { retain: owner => ({ ...base.retain(owner),
      assertAdmission: () => { throw new Error("TEST original admission lost"); },
      requestStop: requested, join: joined,
    }) };
    const f = fixture(false, Date.now() + 60000, "unresolved", native);
    facts.syncFault = "preparation-close";
    await expect(f.app.launch(request, new AbortController().signal)).rejects.toThrow("TEST original admission lost");
    const handle = f.allocations[0]!.childHandle;
    expect(requested).toHaveBeenCalledOnce(); expect(joined).not.toHaveBeenCalled();
    const closurePath = join(f.slots[0]!.jobRootDir, "keyed-preparation-closed.json");
    const bytes = readFileSync(closurePath);
    const before = f.ledger();
    expect(before.observe(f.authority, handle).state).toBe(State.StopRequested);
    expect(before.occupied).toBe(true); expect(before.remainingAllowance).toBe(1);
    facts.syncFault = "";
    expect((await f.app.stop(handle, ScopedStopReason.Budget)).occupied).toBe(true);
    await vi.waitFor(() => expect(joined).toHaveBeenCalledOnce());
    expect(readFileSync(closurePath)).toEqual(bytes);
    expect(f.ledger().generation).toBe(before.generation);
    expect(f.ledger().remainingAllowance).toBe(before.remainingAllowance);
    expect(f.calls).toHaveLength(0);
    expect(f.ledger().observe(f.authority, handle).dispatchIntent).toBeNull();
  });
  it("a durable preparation prefix after original closure is rejected instead of omitted", async () => {
    const f = fixture(false, Date.now() + 60000, "unresolved", false);
    await expect(f.app.launch(request, new AbortController().signal)).rejects.toThrow("preparation_original_native_custody_required");
    await f.app.stop(f.allocations[0]!.childHandle);
    const records = new PreintentPreparationRecords(f.retained);
    const binding = f.ledger().observe(f.authority, f.allocations[0]!.childHandle);
    const owner = readFileSync(join(f.slots[0]!.jobRootDir, "keyed-preparation-owner.json"));
    const prefixPath = join(f.slots[0]!.jobRootDir, `keyed-preparation-effect-${PreparationEffect.SourceClone}.json`);
    const prefix = { schemaVersion: 1, ownershipDigest: createHash("sha256").update(owner).digest("hex"),
      generation: binding.generation + 1, effect: PreparationEffect.SourceClone };
    writeFileSync(prefixPath, JSON.stringify(prefix) + "\n", { mode: 0o600 });
    expect(() => withHostedActivationFence(fence => records.closedInventory(fence, binding))).toThrow("preparation_ownership_conflict");
    // A valid durable prefix is still only an obligation record, not proof that clone started or quiesced. The persisted ledger remains occupied.
    writeFileSync(prefixPath, JSON.stringify({ ...prefix, generation: binding.generation - 1 }) + "\n");
    const inventory = withHostedActivationFence(fence => records.closedInventory(fence, binding));
    expect(inventory.prefixDigests[PreparationEffect.SourceClone]).toBe(createHash("sha256").update(readFileSync(prefixPath)).digest("hex"));
    expect(f.ledger().occupied).toBe(true); expect(f.calls).toHaveLength(0);
  });
  it.each(["explicit", "deadline"])("PR4-R1: %s stop and observe settle while actual checkout is gated; no later dispatch", async mode => {
    if (mode === "deadline") vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const f = fixture(false, Date.now() + (mode === "deadline" ? 5000 : 60000));
    const checkout = deferred(), entered = deferred();
    facts.checkoutGate = checkout.promise; facts.checkoutEntered = entered.resolve;
    const view = await f.app.launch(request, new AbortController().signal);
    try {
      await entered.promise; // The checkout execFile itself entered, after clone and ledger transitions.
      const preparing = f.ledger().observe(f.authority, view.childHandle);
      expect(preparing.state).toBe(State.Materializing);
      let stopSettled = false, observeSettled = false;
      const control = mode === "explicit" ? f.app.stop(view.childHandle).then(() => { stopSettled = true; }) : undefined;
      if (mode === "deadline") await vi.advanceTimersByTimeAsync(f.authority.absoluteDeadline - Date.now());
      const observation = f.app.observe(view.childHandle).then(() => { observeSettled = true; });
      // Join actual control/observation while checkout still cannot complete.
      await bounded(Promise.all([control, observation]));
      await bounded(f.adapter.coordinate(async () => {}, Mode.Cleanup));
      const snapshot = { stopSettled: mode === "explicit" ? stopSettled : f.stops.length === 1,
        observeSettled, stopRequests: f.stops.length };
      checkout.resolve(); await control; await observation; await f.app.drain();
      expect(snapshot).toEqual({ stopSettled: true, observeSettled: true, stopRequests: 1 });
      const latest = f.ledger().observe(f.authority, view.childHandle);
      expect(latest.state).toBe(State.StopRequested); expect(latest.generation).toBeGreaterThan(preparing.generation);
      expect(latest.dispatchIntent).toBeNull(); expect(f.calls).toHaveLength(0); expect(f.ledger().occupied).toBe(true);
      expect(() => readFileSync(join(f.slots[0]!.jobRootDir, "keyed-preparation-effect-source_head.json"))).toThrow();
      expect(() => readFileSync(join(f.slots[0]!.jobRootDir, "keyed-child-manifest.json"))).toThrow();
      await expect(f.adapter.materialize(preparing, request.task)).rejects.toThrow();
    } finally { checkout.resolve(); }
  });
  it("PR4-R1: a separate preparation owner excludes concurrent materialization while control remains available", async () => {
    const f = fixture(), checkout = deferred(), entered = deferred();
    facts.checkoutGate = checkout.promise; facts.checkoutEntered = entered.resolve;
    const view = await f.app.launch(request, new AbortController().signal);
    try {
      await entered.promise;
      const binding = f.ledger().observe(f.authority, view.childHandle);
      await expect(f.adapter.materialize({ ...binding, generation: binding.generation - 1 }, request.task)).rejects.toThrow("keyed_materialization_ineligible");
      await expect(f.adapter.materialize({ ...binding, startId: "TEST-foreign-start" }, request.task)).rejects.toThrow("keyed_materialization_ineligible");
      const competing = f.adapter.materialize(binding, request.task);
      const stopped = f.app.stop(view.childHandle);
      // The competitor must reject while the first owner still holds checkout.
      const result = await bounded(competing.then(() => "accepted", () => "excluded"), 150);
      checkout.resolve(); await competing.catch(() => {}); await stopped; await f.app.drain();
      expect(result).toBe("excluded"); expect(f.calls).toHaveLength(0);
      expect((await f.app.observe(view.childHandle)).state).toBe(State.StopRequested);
    } finally { checkout.resolve(); }
  });
  it.each(["unresolved", "throw", "absent"] as const)("PR4-R2: %s explicit stop preserves the original deadline while foreground completion is pending", async stopMode => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const deadline = Date.now() + 5000, f = fixture(false, deadline, stopMode);
    let foregroundSettled = false; void f.wait.promise.then(() => { foregroundSettled = true; });
    const view = await f.app.launch(request, new AbortController().signal); await submitted(f);
    const stopCalls = vi.spyOn(f.app, "stop"); // Call-through observes the absent-port deadline action too.
    await vi.advanceTimersByTimeAsync(1000);
    const stopped = await f.app.stop(view.operationHandle);
    expect(stopped.state).toBe(State.StopRequested); expect(stopped.occupied).toBe(true);
    await f.app.launch(request, new AbortController().signal); // Replay must not renew the timer.
    await vi.advanceTimersByTimeAsync(deadline - Date.now() - 1);
    await bounded(f.adapter.coordinate(async () => {}, Mode.Cleanup));
    expect(stopCalls.mock.calls.filter(([, reason]) => reason === ScopedStopReason.Deadline)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const deadlineIndex = stopCalls.mock.calls.findIndex(([, reason]) => reason === ScopedStopReason.Deadline);
    expect(deadlineIndex).toBeGreaterThanOrEqual(0);
    await bounded(stopCalls.mock.results[deadlineIndex]!.value);
    const deadlineCalls = stopCalls.mock.calls.filter(([, reason]) => reason === ScopedStopReason.Deadline);
    const requests = [...f.stopRequests], pendingAtDeadline = !foregroundSettled;
    const atDeadline = await f.app.observe(view.childHandle);
    f.wait.resolve(); await f.app.drain();
    expect(pendingAtDeadline).toBe(true); expect(deadlineCalls).toEqual([[view.childHandle, ScopedStopReason.Deadline]]);
    expect(requests.map(r => r.reason)).toEqual(stopMode === "absent" ? [] : [ScopedStopReason.Requested, ScopedStopReason.Deadline]);
    if (stopMode !== "absent") expect(requests[1]).toEqual({ startId: f.allocations[0]!.startId, reason: ScopedStopReason.Deadline, at: deadline });
    expect(atDeadline).toMatchObject({ state: State.StopRequested, occupied: true, deadlineEpochMs: deadline });
    expect(f.calls).toHaveLength(1);
  });
  it.each(["observe", "stop"] as const)("forged pre-intent reconciliation through %s retains occupancy and original deadline", async reconciliation => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const deadline = Date.now() + 5000, f = fixture(false, deadline);
    const checkout = deferred(), entered = deferred();
    facts.checkoutGate = checkout.promise; facts.checkoutEntered = entered.resolve;
    const view = await f.app.launch(request, new AbortController().signal);
    try {
      await entered.promise; await f.app.stop(view.childHandle);
      await expect(f.adapter.coordinate(async () => {
        const current = f.adapter.read();
        await f.adapter.transact(f.authority, f.retained.seed.authorityDigest, current.generation,
          l => l.terminalizeBeforeIntent({ kind: NoEffectProofKind.IndependentlyEstablished,
            correlation: l.observe(f.authority, view.childHandle), evidenceDigest: "a".repeat(64) }));
      })).rejects.toThrow("preintent_authenticated_terminal_authority_required");
      const terminal = await f.app[reconciliation](view.childHandle);
      expect(terminal).toMatchObject({ state: State.StopRequested, occupied: true, deadlineEpochMs: deadline });
      expect(f.calls).toHaveLength(0);
    } finally { checkout.resolve(); await f.app.drain(); }
  });
  it.each([-60000, 60000])("wall clock shift %i cannot postpone an accepted pending child's deadline", async shift => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const acceptedAt = Date.now(), deadline = acceptedAt + 1000, f = fixture(false, deadline);
    let foregroundSettled = false; void f.wait.promise.then(() => { foregroundSettled = true; });
    const view = await f.app.launch(request, new AbortController().signal);
    // Join real private TEST submission without advancing either fake clock.
    await submitted(f);
    expect((await f.app.observe(view.childHandle)).state).toBe(State.Submitted);
    vi.setSystemTime(acceptedAt + shift);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.stopRequests).toHaveLength(0); expect(foregroundSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await f.adapter.coordinate(async () => {}); // Join the timer's queued durable stop.
    expect(f.stopRequests).toEqual([{ startId: f.allocations[0]!.startId,
      reason: ScopedStopReason.Deadline, at: deadline + shift }]);
    expect(foregroundSettled).toBe(false);
    expect(await f.app.observe(view.childHandle)).toMatchObject({ state: State.StopRequested,
      occupied: true, deadlineEpochMs: deadline });
    f.wait.resolve(); await f.app.drain();
    expect(foregroundSettled).toBe(true);
    expect((await f.app.observe(view.childHandle)).state).toBe(State.StopRequested);
    const requestsAfterCompletion = f.stopRequests.length;
    await vi.advanceTimersByTimeAsync(60000); await f.adapter.coordinate(async () => {});
    expect(f.stopRequests).toHaveLength(requestsAfterCompletion); expect(f.calls).toHaveLength(1);
  });
  it("foreground completion before the deadline retains occupancy and the original timer", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const deadline = Date.now() + 1000, f = fixture(false, deadline);
    const view = await f.app.launch(request, new AbortController().signal);
    f.wait.resolve(); await f.app.drain();
    expect(f.calls).toHaveLength(1);
    expect(await f.app.observe(view.childHandle)).toMatchObject({ state: State.Uncertain, occupied: true });
    expect(f.stopRequests).toEqual([{ startId: f.allocations[0]!.startId,
      reason: ScopedStopReason.Completion, at: deadline - 1000 }]);
    await vi.advanceTimersByTimeAsync(1000); await f.adapter.coordinate(async () => {});
    expect(f.stopRequests).toEqual([{ startId: f.allocations[0]!.startId,
      reason: ScopedStopReason.Completion, at: deadline - 1000 },
      { startId: f.allocations[0]!.startId, reason: ScopedStopReason.Deadline, at: deadline }]);
    expect((await f.app.observe(view.childHandle)).state).toBe(State.StopRequested);
    await vi.advanceTimersByTimeAsync(60000); await f.adapter.coordinate(async () => {});
    expect(f.stopRequests).toHaveLength(2);
  });
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
  it("forged terminal keeps the accepted key held without new effects", async () => {
    const f = fixture();
    await f.adapter.coordinate(async () => {
      const claim = await f.store.transact(f.authority, f.retained.seed.authorityDigest, 0, l => l.accept(0, request, Date.now()));
      await expect(f.store.transact(f.authority, f.retained.seed.authorityDigest, claim.generation, l => l.terminalizeBeforeIntent({ kind: NoEffectProofKind.IndependentlyEstablished,
        correlation: l.observe(f.authority, f.allocations[0]!.childHandle), evidenceDigest: "a".repeat(64) }))).rejects.toThrow("preintent_authenticated_terminal_authority_required");
    });
    const replay = await f.app.launch(request, new AbortController().signal);
    expect(replay.state).toBe(State.Claimed); expect(replay.childHandle).toBe(f.allocations[0]!.childHandle); expect(f.calls).toHaveLength(0);
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
    expect(binding.state).toBe(failure === "checkout" ? State.StopRequested : State.Uncertain); expect(l.occupied).toBe(true);
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
    f.materialization.verify(binding); expect(readFileSync(path)).toEqual(original);
    await expect(f.adapter.materialize(binding, request.task)).rejects.toThrow("keyed_materialization_ineligible");
    writeFileSync(path, original.subarray(0, 6), { mode: 0o600 }); expect(() => f.materialization.verify(binding)).toThrow(); expect(readFileSync(path)).toEqual(original.subarray(0, 6));
    rmSync(path); symlinkSync(f.slots[0]!.promptPath, path); expect(() => f.materialization.verify(binding)).toThrow();
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
    const f = fixture(), app = new KeyedChildLaunchApplication(new KeyedChildDispatchAdapter(f.retained, f.store, f.materialization, new OrdinaryKeyedChildHost(), undefined, testPreparationNative()));
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
    const factory = new FakeAppServerFactory({ suppressTurnCompletion: true, emitTurnEventsWithStartResponse: true }), abort = new AbortController();
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
/** Real application/retained authority/private stores and producer. The manager graph belongs to the fixture: effects NEVER imply queue/creator/group death. */
async function scopedFixture() {
  const f = fixture(false, Date.now() + 60000, "proof");
  const view = await f.app.launch(request, new AbortController().signal); await submitted(f);
  const target = f.ledger().observe(f.authority, view.childHandle);
  for (const name of ["codex-readonly-custody", "codex-readonly-revoked", "ordinary-origins", "ordinary-starts", "ordinary-correlations", "ordinary-invocations", "ordinary-submitters", "ordinary-submitter-exits", "ordinary-actor-chains", "scoped-operations", "scoped-observations", "scoped-receipts"]) mkdirSync(join(facts.root, name), { mode: 0o700 });
  const put = (name: string, value: unknown) => writeFileSync(join(facts.root, name), JSON.stringify(value) + "\n", { mode: 0o600 });
  const read = (name: string) => JSON.parse(readFileSync(join(facts.root, name), "utf8"));
  const slot = f.slots[0]!, identity = { scopeDigest: stableChildDigest(target, target.dispatchIntent!.generation),
    installationId: "TEST-installation", hostId: "TEST-host", bootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", supervisorId: "10:100", supervisorUnit: "TEST-supervisor.service", supervisorControlGroup: "/TEST/supervisor",
    accountId: slot.lifetime.accountId, grantDigest: slot.grantSha256, inventoryDigest: "f".repeat(64), sourceSha: slot.sourceSha,
    artifactSha: slot.artifactSha, deadlineEpochMs: slot.lifetime.deadlineEpochMs, authorityDigest: target.authorityDigest,
    slotId: slot.slotId, parentStartId: target.startId, dispatchIntentGeneration: target.dispatchIntent!.generation };
  const birth = { schemaVersion: 1, installationId: identity.installationId, jobId: slot.jobId,
    jobRootDir: slot.jobRootDir, workspacePath: slot.workspacePath, origin: "ordinary" };
  put(`ordinary-origins/${digest(slot.jobId)}.json`, birth);
  const birthDigest = digest(JSON.stringify(birth) + "\n");
  const catalog = { schemaVersion: 1, installationId: identity.installationId, revision: 1, origins: [{ jobId: slot.jobId,
    jobRootDir: slot.jobRootDir, workspacePath: slot.workspacePath, birthSha256: birthDigest }] };
  put("ordinary-origins.json", catalog);
  const rows = [{ startId: target.startId, unit: target.unitCorrelation }, { startId: randomUUID(), unit: "" }].map((r, i) => ({
    ...r, unit: i ? `subscription-runtime-hosted-${r.startId}.service` : r.unit,
    creatorId: slot.creatorId, originSha256: birthDigest, generation: i + 2, state: "reserved" }));
  const unrelated = { startId: randomUUID(), unit: "TEST-unrelated.service", creatorId: "TEST-unrelated", originSha256: "9".repeat(64), generation: 4, state: "reserved" };
  put("host-installation.json", { schemaVersion: 1, installationId: identity.installationId, hostId: identity.hostId,
    runtimeDirectory: "/TEST/runtime", runtimeSha: slot.artifactSha, runtimeManifestSha256: "1".repeat(64), inventorySha256: identity.inventoryDigest });
  put("host-activation.json", { schemaVersion: 1, installationId: identity.installationId, hostId: identity.hostId,
    bootId: identity.bootId, supervisorId: identity.supervisorId, generation: 4, phase: "ORDINARY",
    ordinaryOriginsSha256: digest(JSON.stringify(catalog) + "\n"), exclusiveEnrollmentSha256: null, ordinaryStarts: [...rows, unrelated] });
  const states = new Map<string, { enqueue: boolean; queued: boolean; populated: boolean; identity: boolean; malformed: boolean }>();
  const effects: { kind: string; startId: string }[] = [], members: ScopedTerminationMember[] = [];
  let parentDigest = "";
  rows.forEach((row, i) => {
    const start = { schemaVersion: 1, installationId: identity.installationId, jobId: slot.jobId, jobRootDir: slot.jobRootDir,
      workspacePath: slot.workspacePath, activationGeneration: row.generation, bootId: identity.bootId, supervisorId: identity.supervisorId,
      originSha256: row.originSha256, unit: row.unit, controlGroup: `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${row.unit}`,
      creatorId: row.creatorId, creatorPidBirth: i ? "20:200" : "10:100", grantSha256: slot.grantSha256 };
    put(`ordinary-starts/${row.startId}.json`, start);
    const startDigest = digest(JSON.stringify(start) + "\n"); if (!i) parentDigest = startDigest;
    const c = { schemaVersion: 1 as const, kind: i ? ScopedTerminationKind.Provider : ScopedTerminationKind.Runtime, identity,
      startId: row.startId, startDigest, parentStartDigest: parentDigest, reservationGeneration: row.generation, unit: row.unit,
      controlGroup: start.controlGroup, creatorPidBirth: start.creatorPidBirth, creatorControlGroup: i ? members[0]!.controlGroup : "/TEST/supervisor" };
    put(`ordinary-correlations/${row.startId}.json`, c);
    const invocationId = String(i + 1).repeat(32); put(`ordinary-invocations/${row.startId}.json`, { schemaVersion: 1, correlationDigest: scopedDigest(c), invocationId });
    const submitter = { schemaVersion: 1, correlationDigest: scopedDigest(c), pidBirth: i ? "40:400" : "30:300", controlGroup: "/TEST/submitters" };
    put(`ordinary-submitters/${row.startId}.json`, submitter);
    const member = { ...c, invocationId, submitterDigest: digest(JSON.stringify(submitter) + "\n") }; members.push(member);
    put(`ordinary-actor-chains/${row.startId}.json`, { schemaVersion: 1, correlationDigest: scopedDigest(c), submitterDigest: member.submitterDigest, actors: [
      { role: ScopedEnqueueActorRole.Creator, pidBirth: c.creatorPidBirth, controlGroup: c.creatorControlGroup, parentPidBirth: null },
      { role: ScopedEnqueueActorRole.Wrapper, pidBirth: submitter.pidBirth, controlGroup: submitter.controlGroup, parentPidBirth: c.creatorPidBirth },
      { role: ScopedEnqueueActorRole.ManagerSubmitter, pidBirth: i ? "41:401" : "31:301", controlGroup: submitter.controlGroup, parentPidBirth: submitter.pidBirth },
    ] });
    states.set(row.startId, { enqueue: false, queued: false, populated: false, identity: true, malformed: false });
  });
  let collectHook: (() => void) | undefined, identityHook: (() => void) | undefined;
  const kernel: ScopedTerminationKernelPort = {
    assertScopedIdentity(m) { identityHook?.(); if (!states.get(m.startId)!.identity) throw new Error("TEST replacement identity"); },
    fenceScopedSubmitter(m, chain) { effects.push({ kind: "fence", startId: m.startId }); this.assertScopedIdentity(m);
      if (states.get(m.startId)!.enqueue) throw new Error("TEST manager submitter can still enqueue");
      return { schemaVersion: 2, chainDigest: scopedDigest(chain), fenceDigest: scopedDigest(read(`scoped-terminating/${target.startId}.json`)),
        actors: chain.actors.map((a, i) => ({ ...a, method: i === 0 ? ScopedActorDischargeMethod.ScopedAdmissionFence : ScopedActorDischargeMethod.PidfdExit })) }; },
    drainScopedQueue(m) { effects.push({ kind: "drain", startId: m.startId }); this.assertScopedIdentity(m);
      if (states.get(m.startId)!.queued) throw new Error("TEST queue survives cancel ack"); },
    signalScoped(m, signal) { this.assertScopedIdentity(m); effects.push({ kind: signal, startId: m.startId }); },
    validateScopedPublication(m) { if (!states.get(m.startId)!.identity) throw new Error("TEST publication identity changed"); },
    collectScoped(m, _budget) {
      this.assertScopedIdentity(m); const state = states.get(m.startId)!;
      if (state.malformed) throw new Error("TEST malformed collector");
      const chain = read(`ordinary-actor-chains/${m.startId}.json`), discharge = read(`ordinary-submitter-exits/${m.startId}.json`);
      const identity = { hostId: m.identity.hostId, bootId: m.identity.bootId, supervisorBirth: m.identity.supervisorId,
        supervisorGroup: m.identity.supervisorControlGroup, invocationId: m.invocationId, invocationAnchor: { invocationId: m.invocationId, device: 1, inode: 2 }, unitGroup: m.controlGroup,
        creatorBirth: m.creatorPidBirth, creatorGroup: m.creatorControlGroup };
      const queue = state.queued ? `1 ${m.unit} start waiting\n` : "";
      const evidence = { schemaVersion: 1 as const, memberDigest: scopedDigest(m), chain, discharge,
        identityBefore: identity, identityAfter: identity, queueBefore: queue, queueAfter: queue,
        cgroups: [{ path: m.controlGroup, device: 1, inode: 1, events: `populated ${state.populated ? 1 : 0}\nfrozen 0\n`, processes: state.populated ? "50\n" : "", children: [] }] };
      const result = { startId: m.startId, identityUnchanged: state.identity, creatorFenced: !state.enqueue,
        queueEmpty: !state.queued, recursiveEmpty: !state.populated, digest: scopedDigest(evidence), evidence };
      collectHook?.(); return result;
    },
  };
  const proof = new HostedKeyedScopedStopAdapter(f.retained, f.adapter, kernel);
  f.bindProof(proof);
  return { ...f, proof, target, rows, members, unrelated, states, effects, read, put,
    identityHook: (hook: (() => void) | undefined) => { identityHook = hook; },
    collectHook: (hook: (() => void) | undefined) => { collectHook = hook; },
    receipt: () => join(facts.root, "scoped-receipts", target.startId + ".json") };
}
describe("PR5 scoped proof at the real application and private publication boundaries", () => {
  it("releases only after all independent creator/queue/recursive scopes and ordered durable publications", async () => {
    const f = await scopedFixture(), provider = f.states.get(f.rows[1]!.startId)!;
    provider.populated = true;
    expect((await f.app.stop(f.target.childHandle)).occupied).toBe(true);
    expect(() => readFileSync(f.receipt())).toThrow();
    expect(f.read("host-activation.json").ordinaryStarts.every((r: { state: string }) => r.state === "reserved")).toBe(true);
    expect(f.effects.filter(e => e.kind === ScopedSignal.Kill).map(e => e.startId)).toEqual([f.rows[1]!.startId]);
    provider.populated = false; // Independent population changes, unrelated to the stop return.
    const terminal = await f.app.stop(f.target.childHandle);
    expect(terminal.state).toBe(State.Terminal); expect(terminal.occupied).toBe(false);
    const activation = f.read("host-activation.json"); expect(activation.phase).toBe("ORDINARY");
    expect(activation.ordinaryStarts.slice(0, 2).map((r: { state: string }) => r.state)).toEqual(["terminal", "terminal"]);
    expect(activation.ordinaryStarts[2]).toEqual(f.unrelated);
    expect(f.effects.some(e => e.startId === f.unrelated.startId)).toBe(false);
    const restored = new KeyedLaunchLedgerStore(f.authority, f.allocations);
    const ledger = withHostedActivationFence(token => restored.readHeld(token, f.authority, f.retained.seed.authorityDigest));
    expect(ledger.observe(f.authority, f.target.childHandle).dispatchIntent).toEqual(f.target.dispatchIntent);
    expect(ledger.remainingAllowance).toBe(1); expect(ledger.occupied).toBe(false);
    const second = await f.app.launch({ ...request, key: "second" }, new AbortController().signal);
    expect(second.occupied).toBe(true);
    expect(await f.proof.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.ReceiptBacked });
    expect(f.ledger().occupied).toBe(true); expect(f.ledger().remainingAllowance).toBe(0);
    expect(f.ledger().observe(f.authority, second.childHandle).state).not.toBe(State.Terminal);
    await expect(f.app.launch(request, new AbortController().signal)).resolves.toMatchObject({ state: State.Terminal });
    expect(f.calls.filter(c => c.binding.startId === f.target.startId)).toHaveLength(1);
  });
  it("natural completion triggers independent collection and cannot release a surviving provider", async () => {
    const f = await scopedFixture(), provider = f.states.get(f.rows[1]!.startId)!;
    provider.populated = true; f.wait.resolve(); await f.app.drain();
    expect(f.stopRequests.some(r => r.reason === ScopedStopReason.Completion)).toBe(true);
    expect(f.ledger().occupied).toBe(true); expect(() => readFileSync(f.receipt())).toThrow();
    provider.populated = false;
    expect(await f.app.reconcile(f.target.childHandle)).toMatchObject({ state: State.Terminal, occupied: false });
    expect(f.calls).toHaveLength(1);
  });
  it.each(["enqueue", "queued", "malformed", "identity"] as const)("%s keeps obligations held; later exact reconciliation uses the same IDs", async kind => {
    const f = await scopedFixture(), provider = f.states.get(f.rows[1]!.startId)!;
    provider[kind] = kind !== "identity";
    const result = await f.proof.request(f.target, ScopedStopReason.Requested);
    expect(result).toMatchObject({ outcome: ScopedStopResult.Unresolved }); expect(f.ledger().occupied).toBe(true);
    expect(() => readFileSync(f.receipt())).toThrow();
    if (kind === "identity") expect(f.effects.filter(e => e.startId === f.rows[1]!.startId && e.kind.startsWith("SIG"))).toEqual([]);
    provider[kind] = kind === "identity";
    expect(await f.proof.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.ReceiptBacked });
    expect(f.ledger().observe(f.authority, f.target.childHandle).startId).toBe(f.target.startId); expect(f.calls).toHaveLength(1);
  });
  it.each(["companion", "invocation", "account", "parent"])("%s failure is held, with a durable marker even for incomplete reservations", async kind => {
    const f = await scopedFixture(), id = f.rows[1]!.startId;
    if (kind === "companion") rmSync(join(facts.root, `ordinary-correlations/${id}.json`));
    if (kind === "invocation") rmSync(join(facts.root, `ordinary-invocations/${id}.json`));
    if (kind === "account" || kind === "parent") {
      const c = f.read(`ordinary-correlations/${id}.json`);
      if (kind === "account") c.identity.accountId = "account-s"; else c.parentStartDigest = "0".repeat(64);
      f.put(`ordinary-correlations/${id}.json`, c);
    }
    expect((await f.app.stop(f.target.childHandle)).occupied).toBe(true);
    expect(f.read(`scoped-terminating/${f.target.startId}.json`).reservationIds).toEqual(f.rows.map(r => r.startId));
    withHostedActivationFence(token => {
      expect(() => assertHostedScopedAdmission(token, f.target.startId)).toThrow("termination_fenced");
      const { invocationId: _invocation, submitterDigest: _submitter, ...companion } = f.members[1]!;
      expect(() => retainHostedScopedCorrelation(token, companion)).toThrow("termination_fenced");
    });
    expect(f.read("host-activation.json").ordinaryStarts).toHaveLength(3);
    expect(f.effects).toEqual([]); expect(() => readFileSync(f.receipt())).toThrow();
  });
  it("cleanup survives deleted/revoked grant, changed inventory, dispatcher death and original deadline without authorizing fresh work", async () => {
    const f = await scopedFixture();
    f.grantChanged(); f.originChanged();
    rmSync(join(facts.root, "grants", digest(f.slots[0]!.jobId) + ".json"));
    rmSync(join(facts.root, "inventory.json"));
    vi.spyOn(Date, "now").mockReturnValue(f.authority.absoluteDeadline + 1);
    expect((await f.app.stop(f.target.childHandle)).occupied).toBe(false);
    await expect(f.app.launch({ ...request, key: "fresh" }, new AbortController().signal)).rejects.toThrow();
    const cleanupOwner = withHostedActivationFence(token => RetainedKeyedAuthority.restoreCleanup(f.store, token, f.authority, f.retained.seed.authorityDigest));
    expect(() => cleanupOwner.assertCurrent()).toThrow("live_admission_required");
    const freshStore = new KeyedLaunchLedgerStore(cleanupOwner.authority, cleanupOwner.seed.snapshot().slots);
    const cleanupAdapter = KeyedChildDispatchAdapter.cleanup(cleanupOwner, freshStore);
    await expect(cleanupAdapter.coordinate(async () => cleanupAdapter.read(Mode.Cleanup), Mode.Cleanup)).resolves.toBeInstanceOf(KeyedChildLedger);
    const restored = withHostedActivationFence(token => freshStore.readHeld(token, f.authority, f.retained.seed.authorityDigest));
    expect(restored.remainingAllowance).toBe(1); expect(f.calls).toHaveLength(1);
  });
  it("off-scope correlation and forged DTO authority cannot read target records, signal or terminalize", async () => {
    const f = await scopedFixture(); facts.reads = [];
    expect(await f.proof.request({ ...f.target, startId: randomUUID() }, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.Unresolved });
    expect(facts.reads.some(p => /ordinary-correlations|scoped-receipts|scoped-operations|scoped-terminating/.test(p))).toBe(false);
    expect(f.effects).toEqual([]);
    const forged = { receiptDigest: "a".repeat(64) } as RuntimeValidatedTermination;
    await expect(f.adapter.coordinate(async () => {
      const l = f.adapter.read(Mode.Cleanup);
      await f.adapter.transact(f.authority, l.authorityDigest, l.generation, current =>
        current.terminalizeAfterIntent(current.observe(f.authority, f.target.childHandle), forged), Mode.Cleanup);
    }, Mode.Cleanup)).rejects.toThrow("terminal_authority_required");
    withHostedActivationFence(token => {
      facts.reads = [];
      expect(() => new HostedInstallationActivationStore().publishScopedTerminal(token, {} as RuntimeValidatedOrdinaryTermination)).toThrow("ordinary_authority_required");
      expect(facts.reads).toEqual([]);
    });
    expect(f.ledger().occupied).toBe(true);
  });
  it.each(["marker", "receipt-file", "receipt-parent", "activation", "keyed"])("%s interruption retains occupancy, and only exact validated replay finishes safe steps", async fault => {
    const f = await scopedFixture(); facts.syncFault = fault;
    expect(await f.proof.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.Unresolved });
    facts.syncFault = "";
    if (fault === "keyed") expect(() => f.ledger()).toThrow("pending_publication"); else expect(f.ledger().occupied).toBe(true);
    expect(f.calls).toHaveLength(1);
    if (fault === "activation" || fault === "keyed") {
      // Existing .next/.hold conflicts REQUIRE explicit recovery. No auto cleanup.
      expect(await f.proof.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.Unresolved });
      if (fault === "keyed") expect(() => f.ledger()).toThrow("pending_publication"); else expect(f.ledger().occupied).toBe(true);
    } else {
      expect(await f.proof.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.ReceiptBacked });
      expect(f.ledger().occupied).toBe(false);
    }
  });
  it.each(["symlink", "mode", "hardlink", "digest-forgery"])("%s receipt cannot authorize ordinary or keyed publication", async attack => {
    const f = await scopedFixture(); facts.syncFault = "receipt-parent";
    expect(await f.proof.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.Unresolved });
    facts.syncFault = "";
    if (attack === "symlink") { renameSync(f.receipt(), f.receipt() + ".old"); symlinkSync(f.receipt() + ".old", f.receipt()); }
    if (attack === "mode") chmodSync(f.receipt(), 0o640);
    if (attack === "hardlink") linkSync(f.receipt(), f.receipt() + ".link");
    if (attack === "digest-forgery") { const dto = JSON.parse(readFileSync(f.receipt(), "utf8")); dto.observations[0].digest = "f".repeat(64); f.put(`scoped-receipts/${f.target.startId}.json`, dto); }
    expect(await f.proof.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.Unresolved });
    expect(f.ledger().occupied).toBe(true);
    expect(f.read("host-activation.json").ordinaryStarts.map((r: { state: string }) => r.state)).toEqual(["reserved", "reserved", "reserved"]);
  });
  it("tampering during last receipt parent fsync cannot publish ordinary or keyed Terminal", async () => {
    const f = await scopedFixture(); facts.mutateOnSync = () => writeFileSync(f.receipt(), "TEST tampered receipt");
    expect(await f.proof.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.Unresolved });
    expect(f.ledger().occupied).toBe(true);
    expect(f.read("host-activation.json").ordinaryStarts.map((r: { state: string }) => r.state)).toEqual(["reserved", "reserved", "reserved"]);
    expect(await f.proof.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.Unresolved });
  });
  it("cleanup observation exhaustion retains ownership and the unchanged work deadline", async () => {
    const f = await scopedFixture(); let clock = 1000;
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => clock);
    f.collectHook(() => { clock += 11_000; });
    const result = await f.proof.request(f.target, ScopedStopReason.Deadline);
    expect(result).toMatchObject({ outcome: ScopedStopResult.Unresolved, cause: "budget" });
    expect(f.ledger().occupied).toBe(true); expect(() => readFileSync(f.receipt())).toThrow();
    expect(f.authority.absoluteDeadline).toBe(f.slots[0]!.lifetime.deadlineEpochMs);
    monotonic.mockRestore(); f.collectHook(undefined);
    expect(await f.proof.request(f.target, ScopedStopReason.Deadline)).toMatchObject({ outcome: ScopedStopResult.ReceiptBacked });
  });
  it("an identity changed between collection and publication is refused without a replacement signal", async () => {
    const f = await scopedFixture(); let n = 0;
    f.collectHook(() => { if (++n === 4) f.states.get(f.rows[1]!.startId)!.identity = false; });
    expect(await f.proof.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.Unresolved });
    expect(() => readFileSync(f.receipt())).toThrow(); expect(f.ledger().occupied).toBe(true);
  });
  it("post-ordinary crash replay survives sibling ledger/activation generations without restoring allowance or submitting", async () => {
    const f = await scopedFixture(); facts.syncFault = "keyed";
    expect(await f.proof.request(f.target, ScopedStopReason.Completion)).toMatchObject({ outcome: ScopedStopResult.Unresolved });
    facts.syncFault = "";
    // Explicit fixture recovery resolves a known failed staging write by removing ONLY the exact retained .next from this owned TEST store. Production never does.
    for (const name of readdirSync(join(facts.root, "keyed-child-ledgers"))) if (name.endsWith(".next")) rmSync(join(facts.root, "keyed-child-ledgers", name));
    const priorActivation = f.read("host-activation.json"); f.put("host-activation.json", { ...priorActivation, generation: priorActivation.generation + 1 });
    await f.adapter.coordinate(async () => {
      const current = f.adapter.read(Mode.Cleanup);
      await f.adapter.transact(f.authority, f.retained.seed.authorityDigest, current.generation,
        l => l.stop(l.observe(f.authority, f.target.childHandle)), Mode.Cleanup);
    }, Mode.Cleanup);
    const freshPort = new HostedKeyedScopedStopAdapter(f.retained, f.adapter, {
      assertScopedIdentity: () => { throw new Error("TEST replay must use durable proof"); }, fenceScopedSubmitter: () => { throw new Error(); },
      drainScopedQueue: () => { throw new Error(); }, signalScoped: () => { throw new Error(); }, collectScoped: () => { throw new Error(); }, validateScopedPublication: () => { throw new Error("TEST replay uses durable evidence"); } });
    expect(await freshPort.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.ReceiptBacked });
    const ledger = f.ledger(); expect(ledger.occupied).toBe(false); expect(ledger.remainingAllowance).toBe(1);
    expect(ledger.observe(f.authority, f.target.childHandle).dispatchIntent).toEqual(f.target.dispatchIntent);
    expect(f.read("host-activation.json").ordinaryStarts[2]).toEqual(f.unrelated); expect(f.calls).toHaveLength(1);
  });
});
// Independent review regressions, each starts from a fresh explicit TEST graph.
describe("R1-R8 repair regressions", () => {
  it("R1 rejects callback factory forgery at the real durable keyed transaction", async () => {
    const f = await scopedFixture();
    await expect(f.adapter.coordinate(async () => {
      const l = f.adapter.read(Mode.Cleanup);
      await f.adapter.transact(f.authority, l.authorityDigest, l.generation, current =>
        current.terminalizeAfterIntent(current.observe(f.authority, f.target.childHandle),
          new (ScopedTerminationValidator as unknown as new (callback: () => void) => ScopedTerminationValidator)(() => {}).authorize(f.target, f.target.dispatchIntent!.generation, "a".repeat(64))), Mode.Cleanup);
    }, Mode.Cleanup)).rejects.toThrow();
    expect(f.ledger().occupied).toBe(true);
  });
  it("R3 refuses replay after removing every creator discharge record", async () => {
    const f = await scopedFixture(); facts.syncFault = "receipt-parent";
    expect(await f.proof.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.Unresolved });
    facts.syncFault = "";
    for (const name of readdirSync(join(facts.root, "ordinary-submitter-exits"))) rmSync(join(facts.root, "ordinary-submitter-exits", name));
    expect(await f.proof.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.Unresolved });
    expect(f.ledger().occupied).toBe(true);
  });
  it("R4 rejects an internally consistent substitution of the sealed creator", async () => {
    const f = await scopedFixture(), activation = f.read("host-activation.json"); let parent = "";
    for (const row of activation.ordinaryStarts.slice(0, 2)) {
      row.creatorId = "TEST-foreign";
      const start = f.read(`ordinary-starts/${row.startId}.json`); start.creatorId = row.creatorId;
      f.put(`ordinary-starts/${row.startId}.json`, start);
      const c = f.read(`ordinary-correlations/${row.startId}.json`); c.startDigest = digest(JSON.stringify(start) + "\n");
      parent ||= c.startDigest; c.parentStartDigest = parent; f.put(`ordinary-correlations/${row.startId}.json`, c);
      for (const ns of ["ordinary-invocations", "ordinary-submitters"]) {
        const v = f.read(`${ns}/${row.startId}.json`); v.correlationDigest = scopedDigest(c); f.put(`${ns}/${row.startId}.json`, v);
      }
    }
    f.put("host-activation.json", activation);
    expect(await f.proof.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.Unresolved });
    expect(f.ledger().occupied).toBe(true);
  });
  it("R5 fences before requiring the missing runtime companion", async () => {
    const f = await scopedFixture(); rmSync(join(facts.root, `ordinary-correlations/${f.target.startId}.json`));
    expect((await f.app.stop(f.target.childHandle)).occupied).toBe(true);
    expect(f.read(`scoped-terminating/${f.target.startId}.json`).reservationIds).toEqual(f.rows.map(r => r.startId));
    withHostedActivationFence(token => expect(() => assertHostedScopedAdmission(token, f.target.startId)).toThrow("termination_fenced"));
  });
  it("R6 rejects foreign restoration scope before opening ownership bytes", async () => {
    const f = await scopedFixture(); facts.reads = [];
    expect(() => withHostedActivationFence(token => RetainedKeyedAuthority.restoreCleanup(f.store, token, { ...f.authority, controllerId: "TEST-foreign" }, f.retained.seed.authorityDigest))).toThrow();
    expect(facts.reads.some(p => p.includes("keyed-child-owners/") && p.endsWith(".json"))).toBe(false);
  });
  it("R8 performs no manager collection inside the common publication fence", async () => {
    const f = await scopedFixture(); const held: boolean[] = [];
    // Actual fence ownership is observable through nested acquisition refusal.
    f.identityHook(() => {
      try { withHostedActivationFence(() => {}); } catch { held.push(true); }
    });
    expect(await f.proof.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.ReceiptBacked });
    expect(held).toEqual([]);
  });
});
it("authenticated independent reader reconstructs the exact admitted members", async () => {
  const f = await scopedFixture();
  expect(new ScopedTerminationValidator(f.retained, f.target).members()).toEqual(f.members);
});
it("R1 concrete issuer cannot be replaced by a subclass or callback for ordinary publication", async () => {
  const f = await scopedFixture();
  class ForgedValidator extends ScopedTerminationValidator { override validateReceipt(): never { throw new Error("TEST forgery"); } }
  expect(() => new ForgedValidator(f.retained, f.target)).toThrow("concrete_validator_required");
  expect(() => new (ScopedTerminationValidator as unknown as new (callback: () => void) => ScopedTerminationValidator)(() => {}).authorizeOrdinary("a".repeat(64))).toThrow();
  expect(f.ledger().occupied).toBe(true);
});
it.each(["actor-chain", "queue", "cgroup", "identity", "descendant-parent"])("R3 validates complete semantic %s evidence despite matching recomputed summaries", async attack => {
  const f = await scopedFixture(); facts.syncFault = "receipt-parent";
  expect(await f.proof.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.Unresolved }); facts.syncFault = "";
  const receipt = f.read(`scoped-receipts/${f.target.startId}.json`), observation = receipt.observations[0], evidence = observation.evidence;
  if (attack === "actor-chain") rmSync(join(facts.root, `ordinary-actor-chains/${f.target.startId}.json`));
  if (attack === "queue") evidence.queueBefore = evidence.queueAfter = `1 ${f.target.unitCorrelation} start waiting\n`;
  if (attack === "cgroup") evidence.cgroups[0].events = "populated 1\nfrozen 0\n";
  if (attack === "identity") evidence.identityBefore.creatorBirth = evidence.identityAfter.creatorBirth = "999:999";
  if (attack === "descendant-parent") evidence.cgroups.push({ ...evidence.cgroups[0], path: evidence.cgroups[0].path + "/missing/leaf" });
  observation.digest = scopedDigest(evidence);
  f.put(`scoped-receipts/${f.target.startId}.json`, receipt);
  const retained = f.read(`scoped-observations/${f.target.startId}.json`); retained.observations = receipt.observations; f.put(`scoped-observations/${f.target.startId}.json`, retained);
  expect(await f.proof.request(f.target, ScopedStopReason.Requested)).toMatchObject({ outcome: ScopedStopResult.Unresolved });
  expect(f.ledger().occupied).toBe(true);
  expect(f.read("host-activation.json").ordinaryStarts.map((r: { state: string }) => r.state)).toEqual(["reserved", "reserved", "reserved"]);
});
