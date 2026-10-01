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
const streams = new Set<PassThrough>();
beforeEach(() => { previousExitCode = process.exitCode; setupResearchFixture(); });
afterEach(() => { for (const stream of streams) { stream.unpipe(); stream.destroy(); } streams.clear(); vi.useRealTimers(); process.exitCode = previousExitCode; cleanupResearchFixture(); });
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
const readyFrame = "subscription-runtime-research-provider-ready-v1\n";
const settledNamespaces = { user: "TEST-provider-user", mnt: "TEST-provider-mnt", pid: "TEST-host", net: "TEST-host" };
function providerProxy(current: ReturnType<typeof prepareHelper>, accept = true, ready = true) {
  const proxy = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn(() => true) });
  const forwarded: Buffer[] = [];
  for (const stream of [proxy.stdin, proxy.stdout, proxy.stderr]) streams.add(stream);
  proxy.stdin.on("data", chunk => forwarded.push(Buffer.from(chunk)));
  const submit = () => {
    if (accept) {
      host.units.set(current.provider, { pid: 424242, description: `subscription-runtime-research-provider:${current.startId}:${current.provider}`,
        invocation: "d".repeat(32), active: true });
      host.processGroups.set(424242, `/system.slice/${current.provider}`);
      host.processNamespaces.set(424242, settledNamespaces);
      fs.writeFileSync(local(`/run/systemd/transient/${current.provider}`), "TEST provider fragment", { mode: 0o644 });
    }
    if (ready) queueMicrotask(() => proxy.stdout.write(readyFrame));
    return proxy;
  };
  return { proxy, forwarded, submit };
}
const record = (current: ReturnType<typeof prepareHelper>, suffix: string) =>
  JSON.parse(researchRead(join(current.directory, "providers", current.provider + suffix + ".json")).toString());

describe("owned research provider cancellation (real files and streams; systemd/proc substituted)", () => {
  it("consumes fixed readiness and forwards the held frame only after retaining settled ownership", async () => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current);
    host.spawn.mockImplementation(submit);
    proxy.stdin.once("data", () => {
      expect(record(current, ".owner")).toMatchObject({ process: { pid: 424242 }, service: { unit: current.provider } });
      expect(record(current, ".owner").process.namespaces).toEqual(settledNamespaces);
      expect(proxy.stdout.readableLength).toBe(0); // Readiness was consumed, never forwarded to the protocol.
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
  it.each(["reservation-spec", "reservation-runtime", "service-description", "service-invocation"])("refuses %s physical ownership mismatch while separately fencing authentic reservations", fault => {
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
    if (fault.startsWith("reservation")) expect(() => record(current, ".cancel")).toThrow();
    else expect(record(current, ".cancel").specSha256).toBe(researchHash(current.bytes));
    expect(host.calls.filter(c => ["kill", "stop"].includes(c.args[0]!))).toHaveLength(0);
  });
  it.each(["inactive-queued", "deactivating-zero", "owned-deactivating-zero"])("fences and stops the precise initial %s unit even when kill fails", async state => {
    const current = prepareHelper(), { submit } = providerProxy(current, true, false); submit();
    if (state === "owned-deactivating-zero") researchPublish(join(current.directory, "providers", current.provider + ".owner.json"), {
      schemaVersion: 1, process: researchProcessIdentity(424242), service: researchServiceIdentity(current.provider),
    });
    const service = host.units.get(current.provider)!;
    service.pid = 0; service.state = state === "inactive-queued" ? "inactive" : "deactivating";
    if (state === "inactive-queued") { service.active = false; host.jobs.add(current.provider); }
    host.killFailures.add(current.provider);
    const sync = processes.spawnSync;
    vi.spyOn(processes, "spawnSync").mockImplementation(((command: string, args: string[], options: never) => {
      if (command === "/usr/bin/systemctl" && args[0] === "show" && args[1] === current.provider) {
        expect(record(current, ".cancel").specSha256).toBe(researchHash(current.bytes));
      }
      return sync(command, args, options);
    }) as typeof processes.spawnSync);
    signalResearchProvider(current.directory, current.provider);
    expect(host.calls.filter(c => ["kill", "stop"].includes(c.args[0]!)).map(c => c.args[0])).toEqual(["kill", "stop"]);
    expect(host.jobs.has(current.provider)).toBe(false);
    signalResearchProvider(current.directory, current.provider); // A late individual fence remains valid.
    await expect(runResearchProviderService(current.jobId, current.provider)).rejects.toThrow();
  });
  it.each(["observer", "description", "drop-ins", "fragment", "invocation"])("closes and fences before uncertain/foreign %s inspection, retains active evidence and never signals that provider", fault => {
    const current = prepareHelper(), { submit } = providerProxy(current, true, false); submit();
    researchPublish(join(current.directory, "providers", current.provider + ".owner.json"), { schemaVersion: 1,
      process: researchProcessIdentity(424242), service: researchServiceIdentity(current.provider) });
    const service = host.units.get(current.provider)!;
    service.state = "deactivating"; service.pid = 0;
    if (fault === "observer") host.showFailures.add(current.provider);
    if (fault === "description") service.description = "foreign";
    if (fault === "drop-ins") service.dropIns = "/TEST-foreign.conf";
    if (fault === "fragment") fs.writeFileSync(local(`/run/systemd/transient/${current.provider}`), "foreign fragment");
    if (fault === "invocation") service.invocation = "e".repeat(32);
    const sync = processes.spawnSync; let observations = 0;
    vi.spyOn(processes, "spawnSync").mockImplementation(((command: string, args: string[], options: never) => {
      if (command === "/usr/bin/systemctl" && args[0] === "show") {
        expect(JSON.parse(researchRead(join(current.directory, "closing.json")).toString()).specSha256).toBe(researchHash(current.bytes));
        expect(record(current, ".cancel").specSha256).toBe(researchHash(current.bytes));
        observations++;
      }
      return sync(command, args, options);
    }) as typeof processes.spawnSync);
    expect(() => cancelResearchLaunch(current.jobId)).toThrow();
    // Keep durable assertions outside the failing observer: cancel's expected
    // rejection must not swallow a missing-fence assertion and make this pass.
    expect(observations).toBeGreaterThan(0);
    expect(JSON.parse(researchRead(join(current.directory, "closing.json")).toString()).specSha256).toBe(researchHash(current.bytes));
    expect(record(current, ".cancel").specSha256).toBe(researchHash(current.bytes));
    expect(researchCurrentStart(current.jobId).spec.startId).toBe(current.startId);
    expect(() => researchRead(join(current.directory, "..", "..", "last-terminal.json"))).toThrow();
    expect(host.calls.filter(c => ["kill", "stop"].includes(c.args[0]!) && c.args.at(-1) === current.provider)).toHaveLength(0);
    expect(record(current, ".owner").process.pid).toBe(424242);
    expect(() => record(current, "")).not.toThrow();
  });
  it("revokes all logical authority even when the creator observation is foreign", () => {
    const current = prepareHelper(); host.units.get(current.unit)!.description = "foreign creator";
    expect(() => cancelResearchLaunch(current.jobId)).toThrow();
    expect(record(current, ".cancel").unit).toBe(current.provider);
    expect(researchRead(join(current.directory, "closing.json"))).toBeDefined();
    expect(host.calls.filter(c => ["kill", "stop"].includes(c.args[0]!))).toHaveLength(0);
    expect(researchCurrentStart(current.jobId).spec.startId).toBe(current.startId);
  });
  it("retains a failed owned pending stop, then revalidates repeated and late whole-job cancellation", () => {
    const current = prepareHelper(), { submit } = providerProxy(current, true, false); submit();
    const service = host.units.get(current.provider)!; service.state = "inactive"; service.pid = 0; service.active = false;
    host.jobs.add(current.provider); host.killFailures.add(current.provider); host.stopFailures.add(current.provider);
    expect(() => cancelResearchLaunch(current.jobId)).toThrow();
    expect(record(current, ".cancel").unit).toBe(current.provider);
    expect(researchCurrentStart(current.jobId).spec.startId).toBe(current.startId);
    expect(() => researchRead(join(current.directory, "..", "..", "last-terminal.json"))).toThrow();
    host.stopFailures.clear();
    expect(cancelResearchLaunch(current.jobId).terminal).toBe(true);
    expect(cancelResearchLaunch(current.jobId).startId).toBe(current.startId);
    host.jobs.add(current.provider);
    expect(() => cancelResearchLaunch(current.jobId)).toThrow(); // Late queued work cannot inherit terminal success.
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

describe("bounded confined-launcher readiness (real streams; settled proc/systemd observations substituted)", () => {
  it("ignores early Type=exec MainPID until the confined launcher is ready and keeps later namespace changes fenced", async () => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
    host.spawn.mockImplementation(() => { const result = submit(); host.processNamespaces.delete(424242); return result; });
    proxy.stdin.once("data", () => { proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    const running = runResearchProviderService(current.jobId, current.provider);
    await Promise.resolve();
    expect(() => record(current, ".owner")).toThrow(); expect(forwarded).toHaveLength(0);
    host.processNamespaces.set(424242, settledNamespaces);
    proxy.stdout.write(readyFrame.slice(0, 12)); await Promise.resolve();
    expect(() => record(current, ".owner")).toThrow(); expect(forwarded).toHaveLength(0);
    proxy.stdout.write(readyFrame.slice(12)); await running;
    expect(record(current, ".owner").process.namespaces).toEqual(settledNamespaces);
    host.processNamespaces.set(424242, { ...settledNamespaces, mnt: "TEST-later-foreign-mnt" });
    expect(() => signalResearchProvider(current.directory, current.provider)).toThrow();
    expect(record(current, ".cancel").unit).toBe(current.provider);
    expect(host.calls.filter(c => ["kill", "stop"].includes(c.args[0]!))).toHaveLength(0);
  });
  it.each(["native-output", "oversize", "extra-output", "eof", "close", "stdout-error", "stderr-error", "stdin-error", "stdin-epipe", "spawn-error", "exit", "signal", "timeout", "cancel"])(
    "fails closed before owner/bootstrap/auth on readiness %s", async fault => {
      if (fault === "timeout") vi.useFakeTimers();
      const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
      host.spawn.mockImplementation(() => {
        const result = submit();
        queueMicrotask(() => {
          if (fault === "native-output") proxy.stdout.write('{"jsonrpc":"2.0","method":"tool/call"}\n');
          if (fault === "oversize") proxy.stdout.write("x".repeat(1024 * 1024));
          if (fault === "extra-output") proxy.stdout.write(readyFrame + '{}\n');
          if (fault === "eof") proxy.stdout.end();
          if (fault === "close") proxy.stdout.destroy();
          if (fault === "stdout-error") proxy.stdout.emit("error", new Error("TEST stdout failure"));
          if (fault === "stderr-error") proxy.stderr.emit("error", new Error("TEST stderr failure"));
          if (fault === "stdin-error") proxy.stdin.emit("error", new Error("TEST stdin failure"));
          if (fault === "stdin-epipe") proxy.stdin.emit("error", Object.assign(new Error("TEST closed stdin"), { code: "EPIPE" }));
          if (fault === "spawn-error") proxy.emit("error", new Error("TEST transport failure"));
          if (fault === "exit") { proxy.exitCode = 0; proxy.emit("exit", 0, null); }
          if (fault === "signal") { proxy.signalCode = "SIGTERM"; proxy.emit("exit", null, "SIGTERM"); }
          if (fault === "cancel") signalResearchProvider(current.directory, current.provider);
        });
        return result;
      });
      const rejected = expect(runResearchProviderService(current.jobId, current.provider)).rejects.toThrow("hosted_research_launch_denied");
      if (fault === "timeout") await vi.advanceTimersByTimeAsync(5025);
      await rejected;
      expect(current.forward).not.toHaveBeenCalled(); expect(forwarded).toHaveLength(0); expect(host.authReads).toBe(0);
      expect(() => record(current, ".owner")).toThrow(); expect(record(current, ".cancel").unit).toBe(current.provider);
      expect(proxy.kill).toHaveBeenCalledWith("SIGTERM");
      expect(record(current, ".submission").state).toBe(["exit", "signal"].includes(fault) ? "settled" : "pending");
    });
  it("refuses an errored stream after owner publication before releasing any input", async () => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current); host.spawn.mockImplementation(submit);
    const sync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      sync(fd);
      if (host.fdPaths.get(fd)?.endsWith(current.provider + ".owner.json")) proxy.stderr.emit("error", new Error("TEST stream failed after ready"));
    });
    await expect(runResearchProviderService(current.jobId, current.provider)).rejects.toThrow();
    expect(record(current, ".owner").process.namespaces).toEqual(settledNamespaces);
    expect(current.forward).not.toHaveBeenCalled(); expect(forwarded).toHaveLength(0);
  });
});
