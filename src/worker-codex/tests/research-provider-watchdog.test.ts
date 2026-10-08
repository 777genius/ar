import { host, local, setupResearchFixture, cleanupResearchFixture, configureResearchFixtureTaskTimeout } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { researchRead } from "../research-launch-files";
import { statusResearchLaunch } from "../research-launch-lifecycle";
import { runResearchProviderService } from "../research-provider-service";
import { prepareHelper } from "./research-provider-service-fixture";

const streams = new Set<PassThrough>();
let previousExitCode: typeof process.exitCode;
beforeEach(() => {
  previousExitCode = process.exitCode; setupResearchFixture(); configureResearchFixtureTaskTimeout(120_000);
  vi.useFakeTimers(); const origin = Date.now();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - origin);
});
afterEach(() => {
  for (const stream of streams) { stream.unpipe(); stream.destroy(); }
  streams.clear(); vi.useRealTimers(); process.exitCode = previousExitCode; cleanupResearchFixture();
});
const readyFrame = "subscription-runtime-research-provider-ready-v1\n";
const record = (current: ReturnType<typeof prepareHelper>, suffix: string) =>
  JSON.parse(researchRead(join(current.directory, "providers", current.provider + suffix + ".json")).toString());
function transport(current: ReturnType<typeof prepareHelper>) {
  const proxy = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn(() => true) });
  const forwarded: Buffer[] = [];
  for (const stream of [proxy.stdin, proxy.stdout, proxy.stderr]) streams.add(stream);
  proxy.stdin.on("data", chunk => forwarded.push(Buffer.from(chunk)));
  host.spawn.mockImplementation(() => {
    host.units.set(current.provider, { pid: 424242, description: `subscription-runtime-research-provider:${current.startId}:${current.provider}`,
      invocation: "d".repeat(32), active: true });
    host.processGroups.set(424242, `/system.slice/${current.provider}`);
    host.processNamespaces.set(424242, { user: "TEST-provider-user", mnt: "TEST-provider-mnt", pid: "TEST-host", net: "TEST-host" });
    writeFileSync(local(`/run/systemd/transient/${current.provider}`), "TEST provider fragment", { mode: 0o644 });
    return proxy;
  });
  return { proxy, forwarded };
}

describe("research setup plus task transport watchdog (real TEST files/streams; substituted Host)", () => {
  // Old code fails at 150s before READY despite the admitted 300s setup budget.
  it("holds bootstrap at 150s, accepts READY at 200s and completes after 350s", async () => {
    const current = prepareHelper(), { proxy, forwarded } = transport(current);
    expect(current.spec.request.taskTimeoutMs).toBe(120_000);
    let settled = false;
    const outcome = runResearchProviderService(current.jobId, current.provider, current.home).then(() => true, () => false);
    void outcome.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(150_000);
    expect(settled).toBe(false); expect(host.authReads).toBe(0); expect(forwarded).toHaveLength(0);
    expect(current.forward).not.toHaveBeenCalled(); expect(() => record(current, ".owner")).toThrow();
    expect(proxy.kill).not.toHaveBeenCalled(); expect(record(current, ".submission").state).toBe("pending");
    await vi.advanceTimersByTimeAsync(50_000); proxy.stdout.write(readyFrame); await vi.advanceTimersByTimeAsync(0);
    expect(record(current, ".owner")).toMatchObject({ process: { pid: 424242 }, service: { unit: current.provider } });
    expect(current.forward).toHaveBeenCalledOnce();
    expect(Buffer.concat(forwarded).toString()).toContain('"command":"/usr/bin/TEST-codex"');
    await vi.advanceTimersByTimeAsync(160_000); expect(settled).toBe(false);
    proxy.exitCode = 0; proxy.emit("exit", 0, null);
    expect(await outcome).toBe(true); expect(current.forward).toHaveBeenCalledOnce();
    expect(proxy.kill).not.toHaveBeenCalled(); expect(record(current, ".submission").state).toBe("settled");
  }, 30_000);
  // Red if the watchdog is removed, extended past 450s, or retires an uncertain
  // submission when its direct transport has not exited and owned stop fails.
  it("refuses an unfinished early-READY transport at 450s and retains owned uncertainty", async () => {
    const current = prepareHelper(), { proxy } = transport(current);
    expect(current.spec.request.taskTimeoutMs).toBe(120_000);
    let settled = false;
    const outcome = runResearchProviderService(current.jobId, current.provider, current.home).then(() => true, () => false);
    void outcome.then(() => { settled = true; });
    proxy.stdout.write(readyFrame); await vi.advanceTimersByTimeAsync(0);
    expect(current.forward).toHaveBeenCalledOnce(); expect(record(current, ".owner").service.unit).toBe(current.provider);
    host.stopFailures.add(current.provider);
    await vi.advanceTimersByTimeAsync(449_999); expect(settled).toBe(false); expect(proxy.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await outcome).toBe(false);
    expect(proxy.stdin.destroyed).toBe(true); expect(proxy.kill).toHaveBeenCalledWith("SIGTERM");
    expect(record(current, ".cancel").unit).toBe(current.provider); expect(record(current, ".submission").state).toBe("pending");
    const controls = host.calls.filter(call => ["kill", "stop"].includes(call.args[0]!));
    expect(controls.map(call => [call.args[0], call.args.at(-1)])).toEqual([["kill", current.provider], ["stop", current.provider]]);
    expect(statusResearchLaunch(current.jobId)).toMatchObject({ active: true, providers: [{ unit: current.provider, active: true }] });
  }, 30_000);
});
