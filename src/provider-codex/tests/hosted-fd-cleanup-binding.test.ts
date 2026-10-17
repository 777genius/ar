import * as processes from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { FdCollectorRenderer, parseFdCollectorProfile } from "../../core/host-infrastructure/fd-collector-profile";
import * as observation from "../app-server/adapters/hosted-fd-observation";
import { assertHostedFdProcess, HostedFdLaunchKind } from "../app-server/adapters/hosted-fd-child";
import { hostedFdCleanupUnit, hostedFdLaunch, hostedFdReadyMarker, spawnHostedFdChild } from "../app-server/adapters/hosted-fd-launch";
import { signalCodexAppServerChildGroup } from "../app-server/adapters/node-app-server-process";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn), spawnSync: vi.fn() };
});
afterEach(() => vi.restoreAllMocks());

const unit = "subscription-runtime-hosted-01234567-89ab-cdef-0123-456789abcdef.service";
const file = (path: string) => ({ path, sha256: "a".repeat(64) });
const executable = (path: string) => ({ ...file(path), elfFiles: [file(path), file("/usr/lib/TEST-loader.so")] });

async function fixture() {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const peers: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<void> }> = [];
  let spawned: ChildProcessWithoutNullStreams | undefined;
  let ready!: Promise<void>;
  const peer = () => {
    const child = actual.spawn(process.execPath,
      ["-e", `process.stdin.resume();process.stdout.write(${JSON.stringify(hostedFdReadyMarker)})`], { stdio: "pipe" });
    peers.push({ child, closed: new Promise(resolve => child.once("close", () => resolve())) });
    return child;
  };
  const close = async () => {
    for (const { child } of peers) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.all(peers.map(({ closed }) => closed));
  };
  spawned = peer();
  ready = new Promise<void>((resolve, reject) => {
    spawned!.stdout.once("data", () => resolve()); spawned!.once("error", reject);
  });
  try {
    await ready;
    // Only the external spawn/control transport is substituted. The child,
    // birth, /proc observations, stream gate and invalidation are genuine.
    vi.mocked(processes.spawn).mockImplementation(command => {
      if (command !== "/usr/bin/systemd-run") throw new Error("unexpected TEST transport");
      return spawned!;
    });
    vi.spyOn(observation, "readHostedFdProfile").mockReturnValue(parseFdCollectorProfile({
      schemaVersion: 1, renderer: FdCollectorRenderer.SsV61Signed,
      ss: executable("/usr/bin/ss"), node: executable(process.execPath),
      wrappers: ["setpriv", "systemd-run", "tini", "unshare"].map(name => executable(`/usr/bin/${name}`)),
      bootstraps: ["hosted-app-server-launcher", "hosted-dependency-installer-bootstrap",
        "hosted-readonly-host-launch-cli", "hosted-readonly-runtime-bootstrap"].map(name => file(`/TEST-runtime/${name}.js`)),
      limits: { setupTimeoutMs: 1000, collectorTimeoutMs: 500, maxOutputBytes: 4096, maxRows: 32,
        maxBufferedInputBytes: 4096, maxEventPoll: 2, maxEventFd: 2, maxPipeEndpoints: 8, maxDevNullReserves: 2 },
    }));
    const control = vi.mocked(processes.spawnSync).mockReset().mockReturnValue({ pid: 0, output: [], stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0), status: 0, signal: null });
    return { peer, control, spawned: () => spawned!, ready: () => ready,
      close };
  } catch (error) { await close(); throw error; }
}

// Old RED: stream failure deletes the live birth, so cancellation loses the
// owned unit and signals only the proxy/process group instead of the service.
it.skipIf(process.platform !== "linux")("cancels the authenticated unit after stream revocation without reviving execution", async () => {
  const test = await fixture();
  try {
    const child = spawnHostedFdChild("/usr/bin/systemd-run", ["--unit=" + unit, "--", process.execPath], {}, unit, HostedFdLaunchKind.Provider);
    await test.ready();
    expect(() => assertHostedFdProcess(child, unit, HostedFdLaunchKind.Provider)).not.toThrow();
    const foreign = test.peer();
    expect(hostedFdCleanupUnit(foreign)).toBeUndefined();
    expect(hostedFdCleanupUnit({ ...child })).toBeUndefined();
    // The retained stderr is a real pipe with the constructor's error handler.
    child.stderr.emit("error", new Error("TEST stream failure"));
    expect(() => assertHostedFdProcess(child, unit, HostedFdLaunchKind.Provider)).toThrow("hosted_fd_child_unresolved");
    expect(() => hostedFdLaunch(child).remainingSetupMs()).toThrow();
    const proxyKill = vi.spyOn(child, "kill");
    signalCodexAppServerChildGroup(child, "SIGTERM");
    expect(test.control.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["/usr/bin/systemctl", ["kill", "--signal=SIGTERM", "--kill-whom=all", unit]],
      ["/usr/bin/systemctl", ["stop", "--no-block", unit]],
    ]);
    expect(proxyKill).not.toHaveBeenCalled();
    expect(() => assertHostedFdProcess(child, unit, HostedFdLaunchKind.Provider)).toThrow();
    expect(hostedFdCleanupUnit(child)).toBe(unit);
  } finally { await test.close(); }
});

it.skipIf(process.platform !== "linux")("withholds cleanup membership when the fixed constructor refuses the spawn", async () => {
  const test = await fixture();
  try {
    // A live child is born, but the required service separator is absent.
    expect(() => spawnHostedFdChild("/usr/bin/systemd-run", ["--unit=" + unit], {}, unit, HostedFdLaunchKind.Provider)).toThrow();
    const child = test.spawned();
    expect(hostedFdCleanupUnit(child)).toBeUndefined();
    expect(() => assertHostedFdProcess(child, unit, HostedFdLaunchKind.Provider)).toThrow();
    expect(test.control).not.toHaveBeenCalled();
  } finally { await test.close(); }
});
