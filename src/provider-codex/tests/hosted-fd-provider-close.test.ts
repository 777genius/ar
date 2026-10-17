import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { FdCollectorRenderer, parseFdCollectorProfile, parseFdCollectorRows } from "../../core/host-infrastructure/fd-collector-profile";
import * as childTransport from "../app-server/adapters/hosted-fd-child";
import * as observation from "../app-server/adapters/hosted-fd-observation";
import type { HostedActivationFence } from "../app-server/adapters/hosted-process-activation";
import { hostedFdLaunch, hostedFdReadyMarker, HostedFdLaunchKind, spawnHostedFdChild } from "../app-server/adapters/hosted-fd-launch";

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

async function fixture(exitCode = 0, holdAfterInput = false) {
  // Real subprocess, private pipes, public gate and native exit/close/EOF.
  // Only external host observations, transport and release authority are fixtures;
  // this test proves stream lifecycle behavior, not Native qualification.
  const peer = spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(hostedFdReadyMarker)});
    process.stdin.resume(); process.stdin.on('end', () => { process.exitCode = ${exitCode};
      if (${holdAfterInput}) { process.stdout.write('TEST-input-finished\\n'); setInterval(() => {}, 1000); } });`], { stdio: "pipe" });
  const closed = once(peer, "close");
  const ready = once(peer.stdout, "data");
  vi.spyOn(childTransport, "spawnHostedFdProcess").mockReturnValue(peer);
  vi.spyOn(childTransport, "readHostedFdProcessBirth").mockImplementation((child, childUnit, kind, command, args) => {
    expect(child).toBe(peer);
    expect([childUnit, kind, command, args]).toEqual([unit, HostedFdLaunchKind.Provider, "/usr/bin/systemd-run",
      ["--unit=" + unit, "--", process.execPath]]);
    return `${peer.pid}:TEST`;
  });
  const revoke = vi.spyOn(childTransport, "invalidateHostedFdProcess");
  const profile = parseFdCollectorProfile({ schemaVersion: 1, renderer: FdCollectorRenderer.SsV61Signed,
    ss: executable("/usr/bin/ss"), node: executable(process.execPath),
    wrappers: ["setpriv", "systemd-run", "tini", "unshare"].map(name => executable(`/usr/bin/${name}`)),
    bootstraps: ["hosted-app-server-launcher", "hosted-dependency-installer-bootstrap",
      "hosted-readonly-host-launch-cli", "hosted-readonly-runtime-bootstrap"].map(name => file(`/TEST-runtime/${name}.js`)),
    limits: { setupTimeoutMs: 5000, collectorTimeoutMs: 500, maxOutputBytes: 4096, maxRows: 32,
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
    pid, parentPid: process.pid, birth: String(pid) + ":TEST", exe: process.execPath,
    argv: pid === 999999 ? [process.execPath, "/runtime/bootstrap.js"] : [process.execPath],
    group: `0::${group}`, net: "TEST-net", user: "TEST-user", mount: "TEST-mount", pidNamespace: "TEST-pid",
    uidMap: "TEST-uid", gidMap: "TEST-gid", status: "TEST", descriptors: remote,
  }));
  vi.spyOn(observation, "observeHostedFdUnit").mockReturnValue({ unit, invocation: "TEST-invocation", group, mainPid: 999999, root: "",
    lifecycle: { Type: "exec", ExitType: "main", RemainAfterExit: "no", KillMode: "control-group", SendSIGKILL: "yes",
      Restart: "no", Delegate: "no", KillSignal: "15", FinalKillSignal: "9", ProtectControlGroups: "yes", TimeoutStopUSec: "30000000" } });
  vi.spyOn(observation, "hostedFdGroupPids").mockReturnValue([999999]);
  vi.spyOn(observation, "assertHostedFdBootstrap").mockImplementation(() => {});
  vi.spyOn(observation, "assertHostedFdConfinement").mockImplementation(() => {});
  vi.spyOn(observation, "collectHostedFdPeers").mockReturnValue(parseFdCollectorRows(
    [0, 1, 2].flatMap(fd => [`0 0 * ${100 + fd} * ${200 + fd}`, `0 0 * ${200 + fd} * ${100 + fd}`]).join("\n"), 32));
  const child: ChildProcessWithoutNullStreams = spawnHostedFdChild("/usr/bin/systemd-run",
    ["--unit=" + unit, "--", process.execPath], {}, unit, HostedFdLaunchKind.Provider);
  await ready;
  const guard = hostedFdLaunch(child);
  await guard.observe();
  return { child, guard, closed, revoke,
    release: (end: boolean) => guard.release({} as HostedActivationFence, "TEST-public-frame\n", end, () => {}),
    cleanup: async () => { if (peer.exitCode === null && peer.signalCode === null) peer.kill("SIGTERM"); await closed; } };
}

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
