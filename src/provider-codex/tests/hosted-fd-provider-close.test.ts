import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { FdCollectorRenderer, parseFdCollectorProfile, parseFdCollectorRows } from "../../core/host-infrastructure/fd-collector-profile";
import * as childTransport from "../app-server/adapters/hosted-fd-child";
import * as observation from "../app-server/adapters/hosted-fd-observation";
import * as fullSetup from "../app-server/adapters/hosted-full-setup-channel";
import * as recipeImages from "../app-server/adapters/hosted-fd-recipe-images";
import * as namespaces from "../app-server/adapters/hosted-fd-namespace-stages";
import { AppServerNamespaceArgKind } from "../app-server/domain/app-server-namespace-failure";
import type { HostedActivationFence } from "../app-server/adapters/hosted-process-activation";
import { hostedFdLaunch, hostedFdReadyMarker, HostedFdLaunchKind, spawnHostedFdChild } from "../app-server/adapters/hosted-fd-launch";
import { AppServerProviderSetupStage as SetupStage, AppServerProviderSetupCheckpoint as Checkpoint,
  AppServerProviderSetupCode as SetupCode } from "../app-server/domain/app-server-provider-setup-observation";

import { AppServerObserverPoint as Point, AppServerObserverCode as ObserverCode, AppServerObserverErrno as Errno, retainObserverFailure } from "../app-server/domain/app-server-observer-failure";

vi.mock("../app-server/adapters/hosted-process-activation", () => ({
  assertHostedActivationFence: vi.fn(), assertHostedOrdinaryProviderRelease: vi.fn(),
}));
vi.mock("../app-server/adapters/hosted-dependency-tool-plan", () => ({
  assertHostedDependencyToolRelease: vi.fn(), assertHostedDependencyToolParentFrame: vi.fn(),
}));
vi.mock("../app-server/adapters/hosted-retained-tool-files", () => ({ revokeHostedToolFilesForChild: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
const unit = "subscription-runtime-hosted-01234567-89ab-cdef-0123-456789abcdef.service";
const file = (path: string) => ({ path, sha256: "a".repeat(64) });
const executable = (path: string) => ({ ...file(path), elfFiles: [file(path), file("/TEST/loader")] });

async function fixture(exitCode = 0, holdAfterInput = false, setupTimeoutMs = 5000, namespaceRecipe = false) {
  // Real subprocess, private pipes, public gate and native exit/close/EOF.
  // Only external host observations, transport and release authority are fixtures;
  // this test proves stream lifecycle behavior, not Native qualification.
  const peer = spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(hostedFdReadyMarker)});
    process.stdin.resume(); process.stdin.on('end', () => { process.exitCode = ${exitCode};
      if (${holdAfterInput}) { process.stdout.write('TEST-input-finished\\n'); setInterval(() => {}, 1000); } });`], { stdio: "pipe" });
  const closed = once(peer, "close");
  const ready = once(peer.stdout, "data");
  const serviceArgv = namespaceRecipe ? [...namespaces.hostedFdNamespacePrefix, process.execPath, "/runtime/bootstrap.js"] : [process.execPath];
  const spawnArgs = ["--unit=" + unit, "--", ...serviceArgv];
  vi.spyOn(childTransport, "spawnHostedFdProcess").mockReturnValue(peer);
  vi.spyOn(childTransport, "readHostedFdProcessBirth").mockImplementation((child, childUnit, kind, command, args) => {
    expect(child).toBe(peer);
    expect([childUnit, kind, command, args]).toEqual([unit, HostedFdLaunchKind.Provider, "/usr/bin/systemd-run",
      spawnArgs]);
    return `${peer.pid}:TEST`;
  });
  const revoke = vi.spyOn(childTransport, "invalidateHostedFdProcess");
  const profile = parseFdCollectorProfile({ schemaVersion: 1, renderer: FdCollectorRenderer.SsV61Signed,
    ss: executable("/usr/bin/ss"), node: executable(process.execPath),
    wrappers: ["setpriv", "systemd-run", "tini", "unshare"].map(name => executable(`/usr/bin/${name}`)),
    bootstraps: ["hosted-app-server-launcher", "hosted-dependency-installer-bootstrap",
      "hosted-readonly-host-launch-cli", "hosted-readonly-runtime-bootstrap"].map(name => file(`/TEST-runtime/${name}.js`)),
    limits: { setupTimeoutMs, collectorTimeoutMs: 100, maxOutputBytes: 4096, maxRows: 32,
      maxBufferedInputBytes: 4096, maxEventPoll: 2, maxEventFd: 2, maxPipeEndpoints: 8, maxDevNullReserves: 2 },
  });
  const descriptor = (fd: number, inode: number): observation.HostedFdFact => ({
    fd, target: `socket:[${inode}]`, flags: 0, dev: "1", ino: String(inode), rdev: "0",
    socket: true, pipe: false, character: false, file: false, directory: false,
  });
  const remote = [0, 1, 2].map(fd => descriptor(fd, 100 + fd));
  let parentTableReads = 0;
  vi.spyOn(observation, "hostedFdTable").mockImplementation(() => ++parentTableReads === 1 ? [] :
    [0, 1, 2].map(fd => descriptor(fd + 10, 200 + fd)));
  vi.spyOn(observation, "readHostedFdProfile").mockReturnValue(profile);
  const group = "/TEST/service";
  vi.spyOn(observation, "observeHostedFdProcess").mockImplementation(pid => ({
    pid, parentPid: namespaceRecipe && pid === 999999 ? 999998 : namespaceRecipe && pid === 999998 ? 999997 : process.pid,
    birth: String(pid) + ":TEST", exe: namespaceRecipe && pid === 999997 ? "/usr/bin/unshare" : namespaceRecipe && pid === 999998 ? "/usr/bin/tini" : process.execPath,
    argv: namespaceRecipe && pid === 999997 ? serviceArgv : namespaceRecipe && pid === 999998 ? serviceArgv.slice(18) : pid === 999999 ? [process.execPath, "/runtime/bootstrap.js"] : [process.execPath],
    group: `0::${group}`, net: "TEST-net", user: "TEST-user", mount: "TEST-mount", pidNamespace: "TEST-pid",
    uidMap: "TEST-uid", gidMap: "TEST-gid", status: "TEST", descriptors: remote,
  }));
  vi.spyOn(observation, "observeHostedFdUnit").mockReturnValue({ unit, invocation: "TEST-invocation", group, mainPid: namespaceRecipe ? 999997 : 999999, root: "",
    lifecycle: { Type: "exec", ExitType: "main", RemainAfterExit: "no", KillMode: "control-group", SendSIGKILL: "yes",
      Restart: "no", Delegate: "no", KillSignal: "15", FinalKillSignal: "9", ProtectControlGroups: "yes", TimeoutStopUSec: "30000000" } });
  vi.spyOn(observation, "hostedFdGroupPids").mockReturnValue(namespaceRecipe ? [999997, 999998, 999999] : [999999]);
  vi.spyOn(observation, "assertHostedFdBootstrap").mockImplementation(() => {});
  vi.spyOn(observation, "assertHostedFdConfinement").mockImplementation(() => {});
  vi.spyOn(observation, "collectHostedFdPeers").mockReturnValue(parseFdCollectorRows(
    [0, 1, 2].flatMap(fd => [`0 0 * ${100 + fd} * ${200 + fd}`, `0 0 * ${200 + fd} * ${100 + fd}`]).join("\n"), 32));
  const child: ChildProcessWithoutNullStreams = spawnHostedFdChild("/usr/bin/systemd-run",
    spawnArgs, {}, unit, HostedFdLaunchKind.Provider);
  const guard = hostedFdLaunch(child);
  const initialFact = guard.providerSetupFailureFact(SetupStage.Observing, new Error("hosted_fd_boundary_unresolved"));
  await ready;
  await guard.observe();
  return { child, guard, closed, revoke, initialFact,
    release: (end: boolean) => guard.release({} as HostedActivationFence, "TEST-public-frame\n", end, () => {}),
    cleanup: async () => { if (peer.exitCode === null && peer.signalCode === null) peer.kill("SIGTERM"); await closed; } };
}

it("keeps the rootless canonical namespace lane unchanged and refuses aliases there", async () => {
  const authenticate = vi.spyOn(recipeImages, "readHostedFdRecipeImages").mockImplementation(() => { throw Error("TEST rootless route must not authenticate a private dependency root"); });
  vi.spyOn(fullSetup, "retainOriginalFullSetupIntent").mockReturnValue(undefined); // External full-setup backing is absent in this stream fixture.
  const test = await fixture(0, false, 5000, true);
  try {
    expect(authenticate).not.toHaveBeenCalled();
    const original = vi.mocked(observation.observeHostedFdProcess).getMockImplementation()!;
    vi.mocked(observation.observeHostedFdProcess).mockImplementation(pid => {
      const observed = original(pid); return pid === 999997 ? { ...observed, exe: "/TEST-foreign-root/usr/bin/unshare" } : observed;
    });
    expect(() => test.release(false)).toThrow("hosted_fd_namespace_stage_unresolved");
    expect(authenticate).not.toHaveBeenCalled(); test.guard.invalidate();
  } finally { await test.cleanup(); }
});

it("accepts native zero close and raw EOF after private input completion with an unused public gate", async () => {
  const test = await fixture();
  try {
    expect(test.child.stdin.writableFinished).toBe(false);
    test.release(true);
    expect(await test.closed).toEqual([0, null]);
    expect(test.child.stdin.writableFinished).toBe(false);
    expect(test.child.stdin.destroyed).toBe(true);
    expect(() => test.guard.assertOriginalZeroWaitClosed()).not.toThrow();
    expect(test.revoke).not.toHaveBeenCalled();
  } finally { await test.cleanup(); }
});

it("retains the last actual collector rejection before deadline teardown instead of its generic terminal error", async () => {
  const test = await fixture(0, false, 1500);
  try {
    expect(test.initialFact).toMatchObject({ stage: SetupStage.WaitingReady, checkpoint: Checkpoint.None, ready: false, released: false });
    const denied = vi.spyOn(observation, "assertHostedFdConfinement").mockImplementation(() => {
      throw new Error("TEST-private-target-and-auth-canary");
    });
    let failure: unknown;
    try { await test.guard.observe(); } catch (error) { failure = error; }
    expect((failure as Error).message).toBe("hosted_fd_boundary_unresolved");
    expect(denied.mock.calls.length).toBeGreaterThan(1);
    const fact = test.guard.providerSetupFailureFact(SetupStage.Observing, failure);
    expect(fact).toMatchObject({ stage: SetupStage.Observing, checkpoint: Checkpoint.Confinement,
      code: SetupCode.Unknown, ready: true, released: false, limitMs: 1500 });
    expect(fact!.elapsedMsCapped).toBeGreaterThanOrEqual(1500);
    expect(fact!.collectAttempts).toBeGreaterThan(1);
    expect(fact!.firstCollectElapsedMsCapped).toBeLessThan(1500);
    expect(fact!.checkpointEntryElapsedMsCapped).toBeLessThanOrEqual(fact!.elapsedMsCapped);
    expect(fact!.budgetExpired).toBe(true);
    expect(fact!.rejections).toHaveLength(1);
    expect(fact!.rejections![0]!.count).toBeGreaterThan(1);
    expect(fact!.omittedRejections).toBe(0);
    expect(JSON.stringify(fact)).not.toContain("canary");
    test.guard.invalidate();
    expect(() => test.guard.assertOriginalZeroWaitClosed()).toThrow("hosted_fd_boundary_unresolved");
  } finally { await test.cleanup(); }
});

it("preserves the first three distinct ready collector failures when a later profile failure reaches the deadline", async () => {
  const test = await fixture(0, false, 1500);
  try {
    expect(test.initialFact?.rejections).toEqual([]);
    let calls = 0;
    vi.spyOn(observation, "observeHostedFdUnit").mockImplementation(() => {
      const original = Object.assign(new Error("TEST-private-target-and-auth-canary"), { code: "EACCES" });
      const wrapped = new Error("system_bus_infrastructure_unqualified");
      const point = [Point.BusArrays, Point.BusProcess, Point.BusPins, Point.BusService][Math.min(calls++, 3)]!;
      retainObserverFailure(original, point, 17, wrapped);
      if (calls === 5) vi.spyOn(observation, "readHostedFdProfile").mockImplementation(() => { throw Error("hosted_fd_boundary_unresolved"); });
      throw wrapped;
    });
    let failure: unknown;
    try { await test.guard.observe(); } catch (error) { failure = error; }
    expect((failure as Error).message).toBe("hosted_fd_boundary_unresolved");
    const fact = test.guard.providerSetupFailureFact(SetupStage.Observing, failure)!;
    expect(fact).toMatchObject({ checkpoint: Checkpoint.Profile, code: SetupCode.Boundary, budgetExpired: true, ready: true, released: false });
    expect(fact.rejections).toHaveLength(3);
    expect(fact.rejections?.map(row => row.observer.point)).toEqual([Point.BusArrays, Point.BusProcess, Point.BusPins]);
    expect(fact.rejections?.[0]).toMatchObject({ checkpoint: Checkpoint.Unit, code: SetupCode.Unknown, count: 1,
      observer: { point: Point.BusArrays, code: ObserverCode.Unknown, errno: Errno.EACCES, elapsedMsCapped: 17 } });
    expect(fact.rejections![0]!.elapsedMsCapped).toBeLessThan(fact.checkpointEntryElapsedMsCapped!);
    expect(fact.omittedRejections).toBeGreaterThanOrEqual(2); // Repeated fourth kind counts observations, not unique kinds.
    expect(JSON.stringify(fact)).not.toContain("canary");
    test.guard.invalidate();
  } finally { await test.cleanup(); }
});

it("distinguishes different closed namespace shapes within the bounded ready-collector history", async () => {
  const test = await fixture();
  try {
    let calls = 0;
    vi.spyOn(namespaces, "assertHostedFdNamespaceAncestry").mockImplementation(() => {
      const argv = [...namespaces.hostedFdNamespacePrefix, "/TEST/node", "/TEST/bootstrap.js"];
      const observed = [...argv]; observed[1] = ++calls < 3 ? "--user" : "TEST-private-canary";
      if (calls === 3) test.guard.invalidate(); // End this owned test without changing any production deadline.
      namespaces.hostedFdNamespaceStage(argv, { exe: "/usr/bin/unshare", argv: observed });
    });
    let failure: unknown;
    try { await test.guard.observe(); } catch (error) { failure = error; }
    expect((failure as Error).message).toBe("hosted_fd_boundary_unresolved");
    const fact = test.guard.providerSetupFailureFact(SetupStage.Observing, failure)!;
    expect(fact.rejections).toHaveLength(2);
    expect(fact.rejections?.map(row => row.count)).toEqual([2, 1]);
    expect(fact.rejections?.map(row => row.observer.namespace?.actor.argKind)).toEqual([AppServerNamespaceArgKind.KnownLiteral, AppServerNamespaceArgKind.Other]);
    expect(fact.rejections?.every(row => row.checkpoint === Checkpoint.Namespace)).toBe(true);
    expect(JSON.stringify(fact)).not.toContain("canary");
  } finally { await test.cleanup(); }
});

it("reports a failed final collection and a pre-release refusal without reusing a successful checkpoint", async () => {
  const test = await fixture();
  try {
    expect(test.guard.providerSetupFailureFact(SetupStage.FinalRelease, new Error("hosted_activation_evidence_invalid")))
      .toMatchObject({ stage: SetupStage.FinalRelease, checkpoint: Checkpoint.PreRelease, code: SetupCode.Activation, released: false });
    vi.spyOn(observation, "assertHostedFdBootstrap").mockImplementation(() => { throw new Error("hosted_fd_boundary_unresolved"); });
    let failure: unknown;
    try { test.release(false); } catch (error) { failure = error; }
    expect((failure as Error).message).toBe("hosted_fd_boundary_unresolved");
    expect(test.guard.providerSetupFailureFact(SetupStage.FinalRelease, failure))
      .toMatchObject({ stage: SetupStage.FinalRelease, checkpoint: Checkpoint.Bootstrap, code: SetupCode.Boundary, ready: true, released: false });
    test.guard.invalidate();
  } finally { await test.cleanup(); }
});

it.each([false, true])("retains invalidation for premature public gate destruction (with error: %s)", async error => {
  const test = await fixture();
  try {
    test.release(false);
    test.child.stdin.destroy(error ? new Error("TEST gate failure") : undefined);
    expect(test.revoke).toHaveBeenCalledWith(test.child);
    expect(() => test.guard.assertOriginalZeroWaitClosed()).toThrow("hosted_fd_boundary_unresolved");
  } finally { await test.cleanup(); }
});

it("retains failure for raw output errors even when the child later closes with zero", async () => {
  const test = await fixture();
  try {
    test.release(true);
    test.child.stderr.emit("error", new Error("TEST output failure"));
    expect(test.revoke).toHaveBeenCalledWith(test.child);
    await test.closed;
    expect(() => test.guard.assertOriginalZeroWaitClosed()).toThrow("hosted_fd_boundary_unresolved");
  } finally { await test.cleanup(); }
});

it("rejects native nonzero close after private input completion", async () => {
  const test = await fixture(1);
  try {
    test.release(true);
    expect(await test.closed).toEqual([1, null]);
    expect(test.revoke).toHaveBeenCalledWith(test.child);
    expect(() => test.guard.assertOriginalZeroWaitClosed()).toThrow("hosted_fd_boundary_unresolved");
  } finally { await test.cleanup(); }
});

it("revokes premature gate destruction even after private input finishes while the child remains live", async () => {
  const test = await fixture(0, true);
  try {
    const consumed = once(test.child.stdout, "data");
    test.release(true);
    await consumed;
    expect(test.child.exitCode).toBeNull();
    test.child.stdin.destroy();
    expect(test.revoke).toHaveBeenCalledWith(test.child);
    expect(() => test.guard.assertOriginalZeroWaitClosed()).toThrow("hosted_fd_boundary_unresolved");
  } finally { await test.cleanup(); }
});
