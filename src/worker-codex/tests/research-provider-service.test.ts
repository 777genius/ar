import { host, local, request, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as processes from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { grantResearchLaunch, startResearchLaunch } from "../research-launch-owner";
import { admitResearchProcessFactory, bindResearchRuntime, researchCurrentStart } from "../research-launch-admission";
import { researchHash, researchPublish, researchRead } from "../research-launch-files";
import { researchProcessIdentity, researchServiceIdentity } from "../research-launch-host";
import { cancelResearchLaunch, signalResearchProvider, statusResearchLaunch } from "../research-launch-lifecycle";
import { runResearchProviderService } from "../research-provider-service";
import { signalCodexAppServerChildGroup } from "../../provider-codex/app-server/adapters/node-app-server-process";

let previousExitCode: typeof process.exitCode;
beforeEach(() => { previousExitCode = process.exitCode; setupResearchFixture(); });
afterEach(() => { process.exitCode = previousExitCode; cleanupResearchFixture(); });
function prepareHelper() {
  const req = request(); grantResearchLaunch(req.jobId, req.jobRootDir, req.workspacePath);
  const start = startResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")));
  host.group = `/system.slice/${start.unit}`; bindResearchRuntime(start.jobId, start.startId);
  const current = researchCurrentStart(start.jobId);
  const helper = admitResearchProcessFactory(req)({ command: req.codexBinaryPath, args: ["app-server"], cwd: req.workspacePath,
    env: { HOME: join(req.jobRootDir, "home"), CODEX_HOME: join(req.jobRootDir, "home", "TEST-a") } });
  const unit = fs.readdirSync(local(join(current.directory, "providers")))[0]!.slice(0, -5);
  // Substitute the runtime parent observation, while invoking the real helper
  // and retained-file protocol in this TEST process.
  host.units.get(start.unit)!.pid = process.ppid;
  researchPublish(join(current.directory, "binding.json"), { schemaVersion: 1, specSha256: researchHash(current.bytes),
    process: researchProcessIdentity(process.ppid), service: researchServiceIdentity(start.unit) });
  host.spawn.mockClear();
  const held = helper.stdin as PassThrough;
  const forward = vi.spyOn(process.stdin, "pipe").mockImplementation(destination => held.pipe(destination));
  return { ...current, ...start, provider: unit, helper, forward };
}
function providerProxy(current: ReturnType<typeof prepareHelper>, accept = true) {
  const proxy = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn(() => true) });
  const forwarded: Buffer[] = [];
  proxy.stdin.on("data", chunk => forwarded.push(Buffer.from(chunk)));
  const submit = () => {
    if (accept) {
      host.units.set(current.provider, { pid: 424242, description: `subscription-runtime-research-provider:${current.startId}:${current.provider}`,
        invocation: "d".repeat(32), active: true });
      host.processGroups.set(424242, `/system.slice/${current.provider}`);
      fs.writeFileSync(local(`/run/systemd/transient/${current.provider}`), "TEST provider fragment", { mode: 0o644 });
    }
    return proxy;
  };
  return { proxy, forwarded, submit };
}
const record = (current: ReturnType<typeof prepareHelper>, suffix: string) =>
  JSON.parse(researchRead(join(current.directory, "providers", current.provider + suffix + ".json")).toString());

describe("owned research provider cancellation (real files and streams; systemd/proc substituted)", () => {
  it("forwards the held frame only after retaining actual service ownership", async () => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current);
    host.spawn.mockImplementation(submit);
    proxy.stdin.once("data", () => {
      expect(record(current, ".owner")).toMatchObject({ process: { pid: 424242 }, service: { unit: current.provider } });
      proxy.exitCode = 0; proxy.emit("exit", 0, null);
    });
    await runResearchProviderService(current.jobId, current.provider);
    expect(host.spawn).toHaveBeenCalledOnce(); expect(current.forward).toHaveBeenCalledOnce();
    expect(Buffer.concat(forwarded).toString()).toContain('"command":"/usr/bin/TEST-codex"');
    expect(record(current, ".submission").state).toBe("settled");
  });
  it("signaling the adapter before helper submission durably fences it without bootstrap or provider spawn", async () => {
    const current = prepareHelper();
    signalCodexAppServerChildGroup(current.helper, "SIGTERM");
    expect(record(current, ".cancel")).toMatchObject({ unit: current.provider, specSha256: researchHash(current.bytes) });
    await expect(runResearchProviderService(current.jobId, current.provider)).rejects.toThrow("hosted_research_launch_denied");
    expect(host.spawn).not.toHaveBeenCalled(); expect(current.forward).not.toHaveBeenCalled();
    expect(host.calls.filter(c => ["kill", "stop"].includes(c.args[0]!))).toHaveLength(0);
    expect(host.authReads).toBe(0);
  });
  it("honors cancellation arriving after publishing pending but before submitting", async () => {
    const current = prepareHelper(), realSync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      realSync(fd);
      if (host.fdPaths.get(fd)?.endsWith(current.provider + ".submission.json")) signalResearchProvider(current.directory, current.provider);
    });
    await expect(runResearchProviderService(current.jobId, current.provider)).rejects.toThrow();
    expect(host.spawn).not.toHaveBeenCalled(); expect(current.forward).not.toHaveBeenCalled();
    expect(record(current, ".submission").state).toBe("settled");
  });
  it("attempts stop after pending/no-MainPID kill failure and cancels the creator first", () => {
    const current = prepareHelper(), { submit } = providerProxy(current); submit();
    host.units.get(current.provider)!.pending = true; host.jobs.add(current.provider); host.killFailures.add(current.provider);
    expect(cancelResearchLaunch(current.jobId)).toMatchObject({ terminal: true, startId: current.startId });
    const controls = host.calls.filter(c => ["kill", "stop"].includes(c.args[0]!));
    expect(controls.map(c => [c.args[0], c.args.at(-1)])).toEqual([
      ["stop", current.unit], ["kill", current.provider], ["stop", current.provider],
    ]);
    expect(host.jobs.has(current.provider)).toBe(false);
    expect(statusResearchLaunch(current.jobId)).toMatchObject({ active: false, providers: [{ unit: current.provider, active: false }] });
    expect(controls.some(c => c.args.some(a => a.endsWith(".scope")))).toBe(false);
  });
  it("reconciles cancellation racing an accepted submission without forwarding bootstrap and retains ownership on stop uncertainty", async () => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current);
    host.spawn.mockImplementation(() => {
      // Cancellation observes not-found, then the already accepted start appears.
      signalResearchProvider(current.directory, current.provider);
      const result = submit(); host.stopFailures.add(current.provider); return result;
    });
    await expect(runResearchProviderService(current.jobId, current.provider)).rejects.toThrow();
    expect(current.forward).not.toHaveBeenCalled(); expect(forwarded).toHaveLength(0);
    expect(proxy.stdin.destroyed).toBe(true); expect(proxy.kill).toHaveBeenCalledWith("SIGTERM");
    expect(record(current, ".submission").state).toBe("pending");
    expect(statusResearchLaunch(current.jobId)).toMatchObject({ active: true, providers: [{ unit: current.provider, active: true }] });
    expect(() => cancelResearchLaunch(current.jobId)).toThrow();
    expect(researchCurrentStart(current.jobId).spec.startId).toBe(current.startId);
    expect(() => researchRead(join(current.directory, "..", "..", "last-terminal.json"))).toThrow();
    host.stopFailures.clear();
    expect(cancelResearchLaunch(current.jobId)).toMatchObject({ terminal: true, startId: current.startId });
    expect(record(current, "").unit).toBe(current.provider);
    expect(statusResearchLaunch(current.jobId)).toMatchObject({ active: false });
  });
  it("holds uncertainty when a transport has not settled even though no unit is yet observable", async () => {
    const current = prepareHelper(), { proxy, submit } = providerProxy(current, false);
    host.spawn.mockImplementation(() => { signalResearchProvider(current.directory, current.provider); return submit(); });
    await expect(runResearchProviderService(current.jobId, current.provider)).rejects.toThrow();
    expect(proxy.kill).toHaveBeenCalled();
    expect(record(current, ".submission").state).toBe("pending");
    expect(statusResearchLaunch(current.jobId)).toMatchObject({ active: true, providers: [{ unit: current.provider, active: true }] });
    expect(researchCurrentStart(current.jobId).spec.startId).toBe(current.startId);
    expect(cancelResearchLaunch(current.jobId)).toMatchObject({ terminal: true });
  });
  it("rechecks the fence after retaining the owner and before piping the frame", async () => {
    const current = prepareHelper(), { forwarded, submit } = providerProxy(current); host.spawn.mockImplementation(submit);
    const realSync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      realSync(fd);
      if (host.fdPaths.get(fd)?.endsWith(current.provider + ".owner.json")) signalResearchProvider(current.directory, current.provider);
    });
    await expect(runResearchProviderService(current.jobId, current.provider)).rejects.toThrow();
    expect(record(current, ".owner").service.unit).toBe(current.provider);
    expect(current.forward).not.toHaveBeenCalled(); expect(forwarded).toHaveLength(0);
  });
  it.each(["reservation-spec", "reservation-runtime", "service-description", "service-invocation"])("refuses %s ownership mismatch before cancel authority or systemd effects", fault => {
    const current = prepareHelper(), { submit } = providerProxy(current); submit();
    if (fault.startsWith("reservation")) {
      const original = record(current, "");
      researchPublish(join(current.directory, "providers", current.provider + ".json"), { ...original,
        ...(fault === "reservation-spec" ? { specSha256: "e".repeat(64) } : { runtimeUnit: "foreign.service" }) });
    }
    if (fault === "service-description") host.units.get(current.provider)!.description = "foreign TEST provider";
    if (fault === "service-invocation") {
      researchPublish(join(current.directory, "providers", current.provider + ".owner.json"), { schemaVersion: 1,
        process: researchProcessIdentity(424242), service: researchServiceIdentity(current.provider) });
      host.units.get(current.provider)!.invocation = "e".repeat(32);
    }
    expect(() => signalResearchProvider(current.directory, current.provider)).toThrow();
    expect(() => record(current, ".cancel")).toThrow();
    expect(host.calls.filter(c => ["kill", "stop"].includes(c.args[0]!))).toHaveLength(0);
  });
  it("does not retire ownership while a queued start remains after stop acknowledgement", () => {
    const current = prepareHelper(), { submit } = providerProxy(current); submit();
    const realCommand = processes.spawnSync;
    vi.spyOn(processes, "spawnSync").mockImplementation(((command: string, args: string[], options: never) => {
      const result = realCommand(command, args, options);
      if (command === "/usr/bin/systemctl" && args[0] === "stop" && args.at(-1) === current.provider) host.jobs.add(current.provider);
      return result;
    }) as typeof processes.spawnSync);
    expect(() => cancelResearchLaunch(current.jobId)).toThrow();
    expect(researchCurrentStart(current.jobId).spec.startId).toBe(current.startId);
    expect(() => statusResearchLaunch(current.jobId)).toThrow(); // Observation cannot authenticate a terminal unit while its start is queued.
    host.jobs.clear();
    expect(cancelResearchLaunch(current.jobId)).toMatchObject({ terminal: true });
  });
});
