import { ScopedTerminationValidator } from "../hosted-controller/scoped-termination-validation";
import { codexMimoDefaultModel } from "@vioxen/subscription-runtime/provider-codex";
import { HostedKeyedScopedStopAdapter, type ScopedTerminationKernelPort } from "../hosted-controller/scoped-termination-adapter";
import { ScopedTerminationKind, ScopedSignal, stableChildDigest, scopedDigest,
  ScopedEnqueueActorRole, ScopedActorDischargeMethod, type ScopedActorChain, type ScopedTerminationMember, type RuntimeValidatedTermination, type RuntimeValidatedOrdinaryTermination } from "../../worker-core/hosted-custody/domain/scoped-termination";
import { HostedInstallationActivationStore } from "../hosted-installation-activation";
import { KeyedAuthorizationMode as Mode, type KeyedScopedStopPort } from "../../worker-core/project-control/ports/keyed-child-application-ports";
import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
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

const facts = vi.hoisted(() => ({ root: "", fail: "", closeOnRelease: null as (() => void) | null, effect: null as (() => void) | null,
  syncFault: "", mutateOnSync: null as (() => void) | null,
  gate: null as Promise<void> | null, checkoutGate: null as Promise<void> | null,
  checkoutEntered: null as (() => void) | null, fdPaths: new Map<number, string>(), reads: [] as string[] }));
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
      const fd = fs.openSync(local(path), flags, mode);
      const anchored = /^\/proc\/self\/fd\/(\d+)\/(.*)$/.exec(path);
      facts.fdPaths.set(fd, anchored ? facts.fdPaths.get(Number(anchored[1])) + "/" + anchored[2] : path); facts.reads.push(facts.fdPaths.get(fd)!); return fd;
    },
    closeSync: (fd: number) => { facts.fdPaths.delete(fd); fs.closeSync(fd); },
    mkdirSync: (path: string, options: Parameters<typeof fs.mkdirSync>[1]) => fs.mkdirSync(local(path), options),
    rmdirSync: (path: string) => { fs.rmdirSync(local(path)); if (path.includes("readonly-epoch.") && facts.closeOnRelease) { const close = facts.closeOnRelease; facts.closeOnRelease = null; close(); } },
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
const request = { key: "TEST-key", profile: Profile.ReadOnly, task: "Exact TEST task\n😀" };
let stop!: () => void;
let joinWork: (() => Promise<void>) | undefined;
beforeEach(() => {
  facts.root = mkdtempSync(join(tmpdir(), "pr4-TEST-application-")); facts.fail = ""; facts.gate = null; facts.effect = null; facts.checkoutGate = null; facts.checkoutEntered = null; facts.reads = []; facts.syncFault = ""; facts.mutateOnSync = null;
  vi.spyOn(process, "getuid").mockReturnValue(0);
});
afterEach(async () => { stop?.(); await joinWork?.(); vi.useRealTimers(); vi.restoreAllMocks(); rmSync(facts.root, { recursive: true, force: true }); });
function testPreparationNative(): OwnedPreparationNativePort {
  // Policy/wiring fixture only. It explicitly supplies NO native quiescence
  // authority and can never authorize a persisted pre-intent terminal.
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
      "--model", codexMimoDefaultModel, "--access-boundary", "read_only", "--edit-mode", "read-only",
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
  return { slots, authority, allocations, store, retained, adapter, app, tools, wait, calls, stops, stopRequests, materialization,
    ledger: () => withHostedActivationFence(f => store.readHeld(f, authority, retained.seed.authorityDigest)),
    bindProof: (port: KeyedScopedStopPort) => { concreteProof = port; },
    originChanged: () => { changedOrigin = true; }, grantChanged: () => { changedGrant = true; } };
}

import { existsSync } from "node:fs";

// Negative TEST operation only: a file-backed original admission, with no
// native quiescence, complete inventory, receipt issuer or terminal authority.
// The real common-fence release seam schedules an independent foreground
// process, not a microtask, to close this exact retained operation.
it.each([State.Claimed, State.Materializing])("C1 P2: original closure between common fences forbids the successor from %s", async from => {
  const commonLock = join(facts.root, "readonly-epoch.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.lock");
  const gate = join(facts.root, "TEST-original-admission");
  const closed = gate + ".closed";
  const originalBytes = Buffer.from("TEST original preparation operation\n");
  writeFileSync(gate, originalBytes, { flag: "wx", mode: 0o600 });
  const reads: { generation: number; closed: boolean; held: boolean }[] = [];
  let retains = 0;
  const native: OwnedPreparationNativePort = { retain: owner => {
    retains++;
    const base = testPreparationNative().retain(owner);
    return { ...base, assertAdmission: binding => {
      expect(readFileSync(gate)).toEqual(originalBytes);
      const isClosed = existsSync(closed), held = existsSync(commonLock);
      reads.push({ generation: binding.generation, closed: isClosed, held });
      expect(held).toBe(true);
      if (isClosed) throw new Error("TEST original admission closed independently");
    } };
  } };
  const f = fixture(false, Date.now() + 60000, "unresolved", native);
  const sample = () => {
    const ledger = f.ledger(), observation = ledger.observe(f.authority, f.allocations[0]!.childHandle);
    return { bytes: ledger.serialize(), state: observation.state, generation: ledger.generation,
      occupied: ledger.occupied, remainingAllowance: ledger.remainingAllowance,
      prefixes: readdirSync(f.slots[0]!.jobRootDir).filter(name => name.startsWith("keyed-")).sort()
        .map(name => [name, readFileSync(join(f.slots[0]!.jobRootDir, name)).toString("hex")]),
      prompt: existsSync(f.slots[0]!.promptPath) ? readFileSync(f.slots[0]!.promptPath).toString("hex") : null };
  };
  let before: ReturnType<typeof sample> | undefined, after: ReturnType<typeof sample> | undefined;
  let closures = 0, transitionError: unknown;
  const check = f.adapter.assertPreparationAdmission.bind(f.adapter);
  vi.spyOn(f.adapter, "assertPreparationAdmission").mockImplementation(binding => {
    if (f.ledger().observe(f.authority, binding.childHandle).state === from && closures === 0) facts.closeOnRelease = () => {
      expect(existsSync(commonLock)).toBe(false); // Actual mutex already released.
      before = sample();
      // NEW TEST path only; create-only, bounded, independently executed closure.
      execFileSync("/usr/bin/mkdir", ["--", closed], { env: {}, timeout: 5000, stdio: "pipe" });
      closures++;
      expect(existsSync(closed)).toBe(true);
      expect(sample()).toEqual(before); // Closing admission did not change ledger generation.
    };
    check(binding); // Real concrete admission check, including original custody.
  });
  const coordinate = f.adapter.coordinate.bind(f.adapter);
  vi.spyOn(f.adapter, "coordinate").mockImplementation(async <T>(action: () => Promise<T>, mode?: Mode): Promise<T> => {
    try {
      const result = await coordinate(action, mode);
      if (closures === 1 && !after) after = sample();
      return result;
    } catch (error) {
      // Capture the transition boundary BEFORE the application's subsequent
      // uncertain/stop cleanup. That cleanup legitimately advances generation.
      if (closures === 1 && !after) { after = sample(); transitionError = error; }
      throw error;
    }
  });
  await f.app.launch(request, new AbortController().signal);
  await f.app.drain();
  expect(closures).toBe(1); expect(retains).toBe(1);
  expect(before?.state).toBe(from);
  expect(before?.occupied).toBe(true); expect(before?.remainingAllowance).toBe(1);
  if (from === State.Claimed) expect(before?.prefixes.map(([name]) => name)).toEqual(["keyed-preparation-owner.json"]);
  else expect(before?.prefixes.map(([name]) => name)).toContain("keyed-child-manifest.json");
  expect(after?.state).toBe(from);
  expect(after).toEqual(before); // Exact CAS bytes, prefixes, prompt, finite allowance and occupancy.
  expect(transitionError).toBeInstanceOf(Error);
  expect(String(transitionError)).toContain("TEST original admission closed independently");
  expect(reads.some(read => read.generation === before?.generation && read.closed && read.held)).toBe(true);
  const stopped = f.ledger().observe(f.authority, f.allocations[0]!.childHandle);
  expect(stopped.state).toBe(State.StopRequested); expect(stopped.dispatchIntent).toBeNull();
  expect(f.ledger().occupied).toBe(true); expect(f.ledger().remainingAllowance).toBe(1);
  expect(readFileSync(gate)).toEqual(originalBytes); expect(f.calls).toHaveLength(0);
});
