import { host, local, request, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as processes from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { grantResearchLaunch, startResearchLaunch, revokeResearchLaunch } from "../research-launch-owner";
import { admitResearchProcessFactory, bindResearchRuntime, researchCurrentStart } from "../research-launch-admission";
import { researchHash, researchPublish, researchRead } from "../research-launch-files";
import { researchProcessIdentity, researchServiceIdentity } from "../research-launch-host";
import { cancelResearchLaunch, signalResearchProvider, statusResearchLaunch } from "../research-launch-lifecycle";
import { runResearchProviderService } from "../research-provider-service";
import { signalCodexAppServerChildGroup } from "../../provider-codex/app-server/adapters/node-app-server-process";
import * as scratch from "../host-scratch-temp";
import { preparedResearchScratch } from "./fixtures/research-scratch-host";
import { trustedResearchProviderLaunch, trustedResearchRuntimeLaunch } from "../trusted-custody-systemd-launch";

let previousExitCode: typeof process.exitCode;
const streams = new Set<PassThrough>();
beforeEach(() => { previousExitCode = process.exitCode; setupResearchFixture(); });
afterEach(() => { for (const stream of streams) { stream.unpipe(); stream.destroy(); } streams.clear(); vi.useRealTimers(); process.exitCode = previousExitCode; cleanupResearchFixture(); });
function prepareHelper() {
  const req = request(); grantResearchLaunch(req.jobId, req.jobRootDir, req.workspacePath);
  const start = startResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")));
  host.group = `/system.slice/${start.unit}`; bindResearchRuntime(start.jobId, start.startId);
  const current = researchCurrentStart(start.jobId);
  const home = join(req.jobRootDir, "home", "TEST-a");
  fs.mkdirSync(local(home), { recursive: true, mode: 0o700 });
  const helper = admitResearchProcessFactory(req)({ command: req.codexBinaryPath, args: ["app-server"], cwd: req.workspacePath,
    env: { HOME: join(req.jobRootDir, "home"), CODEX_HOME: home } });
  const unit = fs.readdirSync(local(join(current.directory, "providers")))[0]!.slice(0, -5);
  // Substitute the runtime parent observation, while invoking the real helper
  // and retained-file protocol in this TEST process.
  host.units.get(start.unit)!.pid = process.ppid;
  researchPublish(join(current.directory, "binding.json"), { schemaVersion: 1, specSha256: researchHash(current.bytes),
    process: researchProcessIdentity(process.ppid), service: researchServiceIdentity(start.unit) });
  host.spawn.mockClear();
  const held = helper.stdin as PassThrough;
  const forward = vi.spyOn(process.stdin, "pipe").mockImplementation(destination => held.pipe(destination));
  return { ...current, ...start, provider: unit, helper, forward, home };
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

describe("private finite launch diagnostics", () => {
  it("identifies pre-submission plan denial without persisting paths or the selected home", async () => {
    const current = prepareHelper(), secretHome = "/TEST-never-log-this-home";
    await expect(runResearchProviderService(current.jobId, current.provider, secretHome)).rejects.toThrow();
    const bytes = researchRead(join(current.directory, "provider-failure.json")).toString();
    expect(JSON.parse(bytes)).toEqual({ schemaVersion: 1, unit: current.provider, phase: "service-plan" });
    expect(bytes).not.toContain(secretHome);
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    expect(() => record(current, ".submission")).toThrow();
  });
  it("keeps a changed runtime binding denied and records only the capture phase", async () => {
    const current = prepareHelper();
    const bindingPath = join(current.directory, "binding.json");
    const binding = JSON.parse(researchRead(bindingPath).toString()); binding.process.pid++;
    researchPublish(bindingPath, binding);
    await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow();
    expect(JSON.parse(researchRead(join(current.directory, "provider-failure.json")).toString())).toEqual({
      schemaVersion: 1, unit: current.provider, phase: "runtime-capture", check: "captureResearchRuntime",
    });
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
});

describe("authenticated prepared scratch visibility (synthetic Host, no OS mounts)", () => {
  it("carries all three selected physical sources so independent providers see runtime-private data", async () => {
    const current = prepareHelper(), f = await preparedResearchScratch(current.spec.request.jobRootDir, current.home);
    const plan = trustedResearchProviderLaunch(current.spec, current.provider, current.home, f.host);
    expect(plan.args).toContain("--property=TimeoutStartSec=180s");
    const runtime = trustedResearchRuntimeLaunch(current.spec, researchHash(current.bytes));
    const pinBinds = runtime.args.filter(arg => arg.startsWith("--property=BindPaths="));
    const selected = [
      { source: "/TEST-nvme/runtime-tmp/8794cd8e3d7d92468efc8cef6960bd97fd9e40dd0460e297c3004b12a3ec7a5c", target: join(current.spec.request.jobRootDir, "tmp") },
      { source: "/TEST-nvme/runtime-caches/37e385e326df74a53659409f92ea51bf571e9b9ee28533aff43ea69d4a5af86c", target: join(current.home, "plugins/cache") },
      { source: "/TEST-nvme/runtime-caches/a071e67a38dd8556cbcfc146144797299a85af79956fd438f852c7c4364ed5c6", target: join(current.home, "cache/remote_plugin_catalog") },
    ];
    expect(plan.args.filter(arg => arg.startsWith("--property=BindPaths="))).toEqual([
      ...pinBinds, ...selected.map(({ source, target }) => `--property=BindPaths=${source}:${target}:norbind`),
    ]);
    // Model the independently observed topology: original nonrecursive pins
    // contain none of these later private mounts. Only explicit physical binds
    // can resolve their data. This assertion does not simulate Linux confinement.
    const data = new Map(f.prepared.map(({ source }, i) => [source, ["TEST-agent-marker", "TEST-plugin-data", "TEST-catalog-data"][i]]));
    const visible = (args: readonly string[]) => new Map(args.filter(arg => arg.startsWith("--property=BindPaths="))
      .map(arg => { const [source, target] = arg.slice("--property=BindPaths=".length).split(":"); return [target, data.get(source!)] as const; }));
    for (const { target } of selected) expect(visible(pinBinds).get(target)).toBeUndefined();
    expect(selected.map(({ target }) => visible(plan.args).get(target))).toEqual(["TEST-agent-marker", "TEST-plugin-data", "TEST-catalog-data"]);
    expect(plan.args.some(arg => arg.includes("/proc/"))).toBe(false);
    expect(plan.args).toContain(`--property=ReadWritePaths=${current.spec.request.jobRootDir} ${current.spec.request.workspacePath}`);
    expect(plan.args).toContain("--mount-proc"); expect(plan.args.at(-1)).toBe("--research-ready-v1");
    expect(f.mutations).toEqual([]);
  });
  it.each(["absent", "legacy"])("keeps %s policy as a positive launch without extra binds or mutations", async kind => {
    const current = prepareHelper(), f = await preparedResearchScratch(current.spec.request.jobRootDir, current.home);
    if (kind === "absent") f.nodes.delete(f.configPath);
    else {
      const legacyTemps = Object.fromEntries(f.prepared.map(({ target }) => {
        f.mounts.delete(target); const info = f.nodes.get(target)!;
        return [target, { device: info.dev, inode: info.ino }];
      }));
      f.setPolicy({ schemaVersion: 1, root: f.root, uuid: f.uuid, legacyTemps });
    }
    const plan = trustedResearchProviderLaunch(current.spec, current.provider, current.home, f.host);
    expect(plan.args.filter(arg => arg.startsWith("--property=BindPaths="))).toEqual(
      trustedResearchRuntimeLaunch(current.spec, researchHash(current.bytes)).args.filter(arg => arg.startsWith("--property=BindPaths=")));
    expect(f.mutations).toEqual([]);
  });
  it("selects only this account's caches when another generated home is prepared", async () => {
    const current = prepareHelper(), f = await preparedResearchScratch(current.spec.request.jobRootDir, current.home);
    const other = join(current.spec.request.jobRootDir, "home", "TEST-b");
    fs.mkdirSync(local(other), { mode: 0o700 }); f.nodes.set(other, f.directory());
    await scratch.prepareHostScratchCaches(other, {}, f.host); f.mutations.length = 0;
    const plan = trustedResearchProviderLaunch(current.spec, current.provider, other, f.host);
    const binds = plan.args.filter(arg => arg.startsWith("--property=BindPaths="));
    expect(binds).toHaveLength(5);
    expect(binds.slice(2).map(arg => arg.split(":")[1])).toEqual([join(current.spec.request.jobRootDir, "tmp"), join(other, "plugins/cache"), join(other, "cache/remote_plugin_catalog")]);
    expect(binds.some(arg => arg.includes(current.home + "/"))).toBe(false); expect(f.mutations).toEqual([]);
  });
  it.each([0, 1, 2])("rejects changed mount/source/legacy facts at exact selected leaf %s before launch", async index => {
    const current = prepareHelper(), f = await preparedResearchScratch(current.spec.request.jobRootDir, current.home);
    const selected = f.prepared[index]!, mount = f.mounts.get(selected.target)!, originalSource = f.nodes.get(selected.source)!;
    const resolve = scratch.resolvePreparedHostScratchBinds;
    vi.spyOn(scratch, "resolvePreparedHostScratchBinds").mockImplementation((job, home) => resolve(job, home, f.host));
    // Positive control precedes every independent rejection.
    expect(trustedResearchProviderLaunch(current.spec, current.provider, current.home).args).toContain(`--property=BindPaths=${selected.source}:${selected.target}:norbind`);
    for (const badMount of [{ ...mount, uuid: "foreign" }, { ...mount, fsroot: "/foreign" }, { ...mount, target: "/foreign" }, undefined]) {
      f.mounts.set(selected.target, badMount);
      await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow();
    }
    f.mounts.set(selected.target, mount);
    const originalTarget = f.nodes.get(selected.target)!;
    for (const badTarget of [{ ...originalTarget, uid: 999 }, { ...originalTarget, mode: 0o777 }, { ...originalTarget, ino: originalTarget.ino + 1 }, { ...originalTarget, isSymbolicLink: () => true }]) {
      f.nodes.set(selected.target, badTarget);
      await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow();
    }
    f.nodes.set(selected.target, originalTarget);
    for (const badSource of [{ ...originalSource, uid: 999 }, { ...originalSource, mode: 0o777 }, { ...originalSource, ino: originalSource.ino + 1 }, { ...originalSource, isSymbolicLink: () => true }]) {
      f.nodes.set(selected.source, badSource);
      await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow();
    }
    f.nodes.set(selected.source, originalSource);
    f.mounts.delete(selected.target);
    const node = f.nodes.get(selected.target)!;
    for (const entry of [true, { device: node.dev, inode: node.ino + 1 }]) {
      f.setPolicy({ schemaVersion: 1, root: f.root, uuid: f.uuid, legacyTemps: { [selected.target]: entry } });
      await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow();
    }
    expect(host.spawn).not.toHaveBeenCalled(); expect(current.forward).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    expect(() => record(current, ".submission")).toThrow(); expect(f.mutations).toEqual([]);
  });
  it.each(["foreign", "symlink", "parent-symlink", "writable", "parent-owner", "pin-home", "outside", "prefix", "noncanonical", "bag", "missing"])(
    "rejects %s selected home before launch", async fault => {
      const current = prepareHelper(); let home = current.home;
      if (fault === "foreign") host.foreign.add(home);
      if (fault === "writable") fs.chmodSync(local(home), 0o777);
      if (fault === "parent-owner") host.foreign.add(join(current.spec.request.jobRootDir, "home"));
      if (fault === "pin-home") {
        const other = join(current.spec.request.jobRootDir, "home", "TEST-b"); fs.mkdirSync(local(other), { mode: 0o700 });
        const retained = [...host.pins]; host.pins.clear();
        host.pins.set(join(current.directory, "pins/job/home/TEST-a"), other);
        for (const [pin, target] of retained) host.pins.set(pin, target);
      }
      if (fault === "symlink" || fault === "parent-symlink") {
        const path = fault === "symlink" ? home : join(current.spec.request.jobRootDir, "home");
        fs.renameSync(local(path), local(path) + "-saved"); fs.symlinkSync(local(path) + "-saved", local(path));
      }
      if (fault === "outside") home = "/TEST-auth";
      if (fault === "prefix") home = join(current.spec.request.jobRootDir, "home-foreign", "TEST-a");
      if (fault === "noncanonical") home += "/../TEST-a";
      if (fault === "bag") home = { BindPaths: "/TEST-foreign" } as unknown as string;
      if (fault === "missing") home += "/missing";
      await expect(runResearchProviderService(current.jobId, current.provider, home)).rejects.toThrow();
      expect(host.spawn).not.toHaveBeenCalled(); expect(current.forward).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
      expect(() => record(current, ".submission")).toThrow();
    });
  it("keeps prepared scratch auth/bootstrap held until fixed readiness and settled owner", async () => {
    const current = prepareHelper(), f = await preparedResearchScratch(current.spec.request.jobRootDir, current.home);
    const resolve = scratch.resolvePreparedHostScratchBinds;
    vi.spyOn(scratch, "resolvePreparedHostScratchBinds").mockImplementation((job, home) => resolve(job, home, f.host));
    const { proxy, forwarded, submit } = providerProxy(current, true, false); host.spawn.mockImplementation(submit);
    proxy.stdin.once("data", () => { expect(record(current, ".owner").process.namespaces).toEqual(settledNamespaces); proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    const running = runResearchProviderService(current.jobId, current.provider, current.home);
    await Promise.resolve(); expect(forwarded).toHaveLength(0); expect(() => record(current, ".owner")).toThrow();
    proxy.stdout.write(readyFrame); await running;
    expect(forwarded.length).toBeGreaterThan(0); expect(current.forward).toHaveBeenCalledOnce(); expect(f.mutations).toEqual([]);
  });
});

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
    await runResearchProviderService(current.jobId, current.provider, current.home);
    expect(host.spawn).toHaveBeenCalledOnce(); expect(current.forward).toHaveBeenCalledOnce();
    expect(Buffer.concat(forwarded).toString()).toContain('"command":"/usr/bin/TEST-codex"');
    expect(record(current, ".submission").state).toBe("settled");
  });
  it("signaling the adapter before helper submission durably fences it without bootstrap or provider spawn", async () => {
    const current = prepareHelper();
    signalCodexAppServerChildGroup(current.helper, "SIGTERM");
    expect(record(current, ".cancel")).toMatchObject({ unit: current.provider, specSha256: researchHash(current.bytes) });
    await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow("hosted_research_launch_denied");
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
    await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow();
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
    await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow();
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
    await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow();
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
    await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow();
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
    await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow();
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

/** Model a three-second artifact traversal on slow Host I/O, still inside its
 * unchanged four-second bound. All retained bytes/digests remain real; only the
 * Host clock and directory-observation latency are substituted. */
function slowBoundedMaterial() {
  vi.useFakeTimers();
  const origin = Date.now(); let materialTime = 0;
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - origin + materialTime);
  const readDirectory = fs.readdirSync;
  vi.spyOn(fs, "readdirSync").mockImplementation(((path: string, options: never) => {
    if (path === "/TEST-artifact/dist") materialTime += 3_000;
    return readDirectory(path, options);
  }) as typeof fs.readdirSync);
  return Object.assign(() => performance.now(), { advance: (elapsed: number) => { materialTime += elapsed; } });
}

describe("slow bounded material at research effect boundaries", () => {
  it.each(["timeout", "nonzero"])("retains a closed Host command %s observation before bootstrap", async fault => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
    const original = processes.spawnSync;
    host.spawn.mockImplementation(submit);
    const outcome = runResearchProviderService(current.jobId, current.provider, current.home).then(() => undefined, error => error as Error);
    vi.spyOn(processes, "spawnSync").mockImplementation(((command: string, args: string[], options: never) => {
      if (command === "/usr/bin/systemctl" && args[0] === "show") return fault === "timeout"
        ? { status: null, error: Object.assign(new Error("TEST private transport detail"), { code: "ETIMEDOUT" }), stdout: "", stderr: "TEST private detail" }
        : { status: 1, stdout: "", stderr: "TEST private detail" };
      return original(command, args, options);
    }) as typeof processes.spawnSync);
    proxy.stdout.write(readyFrame);
    const observation = fault === "timeout" ? "host-command-timeout" : "host-command-failed";
    expect((await outcome)?.cause).toBe(observation);
    const diagnostic = researchRead(join(current.directory, "provider-failure.json")).toString();
    expect(JSON.parse(diagnostic)).toMatchObject({ observation, check: "researchCommand" });
    expect(diagnostic).not.toContain("private");
    expect(forwarded).toHaveLength(0); expect(current.forward).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  it.each([65_931, 98_727, 130_000])("holds bootstrap through %i ms setup despite three-second verification, then meets the 10s handoff", async setupMs => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
    const now = slowBoundedMaterial(); host.spawn.mockImplementation(submit);
    let readyAt = 0, releasedAt = 0;
    proxy.stdin.once("data", () => { releasedAt = now(); proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    const outcome = runResearchProviderService(current.jobId, current.provider, current.home).then(() => true, () => false);
    await vi.advanceTimersByTimeAsync(setupMs);
    expect(forwarded).toHaveLength(0); expect(current.forward).not.toHaveBeenCalled();
    readyAt = now();
    for (const part of [readyFrame.slice(0, 7), readyFrame.slice(7, 28), readyFrame.slice(28)]) proxy.stdout.write(part);
    await vi.advanceTimersByTimeAsync(0);
    const success = await outcome;
    console.info(`TEST substituted Host: success=${success}, ready-to-bootstrap=${releasedAt ? releasedAt - readyAt : "held"}ms; artifact walk=3000ms (bound=4000ms)`);
    expect(success).toBe(true);
    expect(releasedAt - readyAt).toBeLessThan(10_000);
    expect(forwarded.length).toBeGreaterThan(0); expect(current.forward).toHaveBeenCalledOnce();
    expect(record(current, ".owner").process.namespaces).toEqual(settledNamespaces);
    expect(record(current, ".submission").state).toBe("settled");
  });
  it("performs bounded material verification once during the fixed 10s ready-to-bootstrap window", async () => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
    const now = slowBoundedMaterial(); host.spawn.mockImplementation(submit);
    let readyAt = 0, releasedAt = 0;
    proxy.stdin.once("data", () => { releasedAt = now(); proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    const outcome = runResearchProviderService(current.jobId, current.provider, current.home).then(() => true, () => false);
    readyAt = now(); proxy.stdout.write(readyFrame);
    await vi.advanceTimersByTimeAsync(0);
    const success = await outcome;
    console.info(`TEST substituted Host: success=${success}, ready-to-bootstrap=${releasedAt ? releasedAt - readyAt : "held"}ms; artifact walk=3000ms (bound=4000ms)`);
    expect(success).toBe(true);
    expect(releasedAt - readyAt).toBeLessThan(10_000);
    expect(forwarded.length).toBeGreaterThan(0);
  });
  it("keeps bootstrap held when valid material plus slow ownership exceed the fixed 10s handoff", async () => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
    const now = slowBoundedMaterial(), sync = fs.fsyncSync; host.spawn.mockImplementation(submit);
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      sync(fd); if (host.fdPaths.get(fd)?.endsWith(current.provider + ".owner.json")) now.advance(9_500);
    });
    proxy.stdin.once("data", () => { proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    const outcome = runResearchProviderService(current.jobId, current.provider, current.home).then(() => false, () => true);
    const readyAt = now(); proxy.stdout.write(readyFrame); await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBe(true); expect(now() - readyAt).toBeGreaterThan(10_000);
    expect(forwarded).toHaveLength(0); expect(current.forward).not.toHaveBeenCalled();
    expect(record(current, ".submission").state).toBe("pending");
  });
  it.each(["cancel", "revoke", "grant", "binding", "spec", "artifact", "executable", "job-pin", "runtime-owner"])(
    "rejects retained %s mutation during inert waiting before any bootstrap", async fault => {
      const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
      host.spawn.mockImplementation(submit);
      const outcome = runResearchProviderService(current.jobId, current.provider, current.home).then(() => false, () => true);
      expect(forwarded).toHaveLength(0);
      if (fault === "cancel") signalResearchProvider(current.directory, current.provider);
      if (fault === "revoke") revokeResearchLaunch(current.jobId);
      if (fault === "grant") { const path = join(current.directory, "..", "..", "grant.json"); researchPublish(path, { ...JSON.parse(researchRead(path).toString()), grantId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" }); }
      if (fault === "binding") researchPublish(join(current.directory, "binding.json"), { ...JSON.parse(researchRead(join(current.directory, "binding.json")).toString()), specSha256: "e".repeat(64) });
      if (fault === "spec") researchPublish(join(current.directory, "spec.json"), { ...current.spec, artifactSha256: "e".repeat(64) });
      if (fault === "artifact") fs.writeFileSync(local("/TEST-artifact/dist/main.js"), "TEST mutated while inert");
      if (fault === "executable") fs.writeFileSync(join(host.root, "executable"), "TEST changed executable while inert");
      if (fault === "job-pin") host.pins.set(join(current.directory, "pins/job"), current.spec.request.workspacePath);
      if (fault === "runtime-owner") host.units.get(current.unit)!.invocation = "e".repeat(32);
      await new Promise(resolve => setTimeout(resolve, 35));
      expect(forwarded).toHaveLength(0); proxy.stdout.write(readyFrame);
      expect(await outcome).toBe(true); expect(current.forward).not.toHaveBeenCalled();
      expect(forwarded).toHaveLength(0); expect(host.authReads).toBe(0);
      if (fault === "runtime-owner") expect(JSON.parse(researchRead(join(current.directory, "provider-failure.json")).toString()))
        .toMatchObject({ phase: "ready-and-owner", check: "assertAuthorityCurrent" });
      expect(record(current, ".submission").state).toBe("pending");
      expect(proxy.kill).toHaveBeenCalledWith("SIGTERM");
    });
  it.each(["source-inode", "source-owner", "mount-identity", "removed-policy"])(
    "rechecks retained prepared scratch %s at bootstrap after inert waiting", async fault => {
      const current = prepareHelper(), f = await preparedResearchScratch(current.spec.request.jobRootDir, current.home);
      const resolve = scratch.resolvePreparedHostScratchBinds;
      vi.spyOn(scratch, "resolvePreparedHostScratchBinds").mockImplementation((job, home) => resolve(job, home, f.host));
      const { proxy, forwarded, submit } = providerProxy(current, true, false); host.spawn.mockImplementation(submit);
      const outcome = runResearchProviderService(current.jobId, current.provider, current.home).then(() => false, () => true);
      proxy.stdin.once("data", () => { proxy.exitCode = 0; proxy.emit("exit", 0, null); });
      const selected = f.prepared[0]!, source = f.nodes.get(selected.source)!;
      if (fault === "source-inode") f.nodes.set(selected.source, { ...source, ino: source.ino + 1 });
      if (fault === "source-owner") f.nodes.set(selected.source, { ...source, uid: 999 });
      if (fault === "mount-identity") f.mounts.set(selected.target, { ...f.mounts.get(selected.target)!, uuid: "TEST-foreign" });
      if (fault === "removed-policy") f.nodes.delete(f.configPath);
      expect(forwarded).toHaveLength(0); proxy.stdout.write(readyFrame);
      expect(await outcome).toBe(true); expect(current.forward).not.toHaveBeenCalled();
      expect(forwarded).toHaveLength(0); expect(host.authReads).toBe(0);
      expect(record(current, ".submission").state).toBe("pending"); expect(f.mutations).toEqual([]);
    });
  it.each(["artifact-deadline", "file-deadline"])("preserves %s as denial during final material verification", async observation => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current); host.spawn.mockImplementation(submit);
    const originalNow = performance.now.bind(performance); let elapsed = 0, ownerPublished = false;
    vi.spyOn(performance, "now").mockImplementation(() => originalNow() + elapsed);
    const sync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { sync(fd); if (host.fdPaths.get(fd)?.endsWith(current.provider + ".owner.json")) ownerPublished = true; });
    const readDirectory = fs.readdirSync, stat = fs.lstatSync;
    vi.spyOn(fs, "readdirSync").mockImplementation(((path: string, options: never) => {
      if (ownerPublished && observation === "artifact-deadline" && path === "/TEST-artifact/dist") elapsed += 4_001;
      return readDirectory(path, options);
    }) as typeof fs.readdirSync);
    vi.spyOn(fs, "lstatSync").mockImplementation(((path: string) => {
      if (ownerPublished && observation === "file-deadline" && path === process.execPath) elapsed += 4_001;
      return stat(path);
    }) as typeof fs.lstatSync);
    const error = await runResearchProviderService(current.jobId, current.provider, current.home).then(() => undefined, error => error as Error);
    expect(error?.cause).toBe(observation);
    expect(JSON.parse(researchRead(join(current.directory, "provider-failure.json")).toString())).toMatchObject({ phase: "ready-and-owner", observation });
    expect(forwarded).toHaveLength(0); expect(current.forward).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    expect(record(current, ".submission").state).toBe("pending");
  });
  it.each(["grant", "binding", "cancel"])("rechecks %s changed inside final synchronous material I/O", async fault => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current); host.spawn.mockImplementation(submit);
    const sync = fs.fsyncSync, readDirectory = fs.readdirSync; let ownerPublished = false, changed = false;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { sync(fd); if (host.fdPaths.get(fd)?.endsWith(current.provider + ".owner.json")) ownerPublished = true; });
    vi.spyOn(fs, "readdirSync").mockImplementation(((path: string, options: never) => {
      if (ownerPublished && !changed && path === "/TEST-artifact/dist") {
        changed = true;
        if (fault === "grant") revokeResearchLaunch(current.jobId);
        if (fault === "binding") researchPublish(join(current.directory, "binding.json"), { ...JSON.parse(researchRead(join(current.directory, "binding.json")).toString()), specSha256: "e".repeat(64) });
        if (fault === "cancel") signalResearchProvider(current.directory, current.provider);
      }
      return readDirectory(path, options);
    }) as typeof fs.readdirSync);
    proxy.stdin.once("data", () => { proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    const denied = await runResearchProviderService(current.jobId, current.provider, current.home).then(() => false, () => true);
    expect(changed).toBe(true); expect(denied).toBe(true); expect(forwarded).toHaveLength(0);
    expect(current.forward).not.toHaveBeenCalled(); expect(record(current, ".submission").state).toBe("pending");
  });
  it.each(["queued-duplicate", "queued-eof"])("observes %s queued during final material verification", async fault => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current);
    host.spawn.mockImplementation(submit);
    const sync = fs.fsyncSync, readDirectory = fs.readdirSync;
    let ownerPublished = false, queued = false;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { sync(fd); if (host.fdPaths.get(fd)?.endsWith(current.provider + ".owner.json")) ownerPublished = true; });
    vi.spyOn(fs, "readdirSync").mockImplementation(((path: string, options: never) => {
      if (ownerPublished && !queued && path === "/TEST-artifact/dist") {
        queued = true; process.nextTick(() => fault === "queued-eof" ? proxy.stdout.end() : proxy.stdout.write(readyFrame));
      }
      return readDirectory(path, options);
    }) as typeof fs.readdirSync);
    proxy.stdin.once("data", () => { proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    const denied = await runResearchProviderService(current.jobId, current.provider, current.home).then(() => false, () => true);
    expect(queued).toBe(true); expect(denied).toBe(true);
    expect(forwarded).toHaveLength(0); expect(current.forward).not.toHaveBeenCalled();
    expect(record(current, ".submission").state).toBe("pending");
  });
});

describe("bounded confined-launcher readiness (real streams; settled proc/systemd observations substituted)", () => {
  it("admits settled readiness after forty-six seconds without releasing bootstrap while waiting", async () => {
    vi.useFakeTimers();
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
    host.spawn.mockImplementation(submit);
    proxy.stdin.once("data", () => { proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    // Capture rejection immediately so the old fifteen-second deadline fails the
    // outcome assertion, rather than producing an unhandled rejection.
    const outcome = runResearchProviderService(current.jobId, current.provider, current.home)
      .then(() => true, () => false);
    await vi.advanceTimersByTimeAsync(46_025);
    expect(forwarded).toHaveLength(0); expect(current.forward).not.toHaveBeenCalled();
    expect(() => record(current, ".owner")).toThrow();
    proxy.stdout.write(readyFrame);
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBe(true);
    expect(record(current, ".owner").process.namespaces).toEqual(settledNamespaces);
    expect(forwarded.length).toBeGreaterThan(0); expect(current.forward).toHaveBeenCalledOnce();
  });
  it.each(["duplicate-separate-chunks", "ready-then-eof"])("keeps bootstrap held on the exact R3 %s counterexample", async fault => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
    const outputForward = vi.spyOn(proxy.stdout, "pipe");
    host.spawn.mockImplementation(() => {
      const result = submit();
      queueMicrotask(() => {
        if (fault === "duplicate-separate-chunks") { proxy.stdout.write(readyFrame); proxy.stdout.write(readyFrame); }
        else proxy.stdout.end(readyFrame);
      });
      return result;
    });
    // Make an incorrect bootstrap release terminate, so old code fails an
    // effect assertion instead of merely hanging until the test timeout.
    proxy.stdin.once("data", () => { proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    let denied = false;
    try { await runResearchProviderService(current.jobId, current.provider, current.home); } catch { denied = true; }
    expect(Buffer.concat(forwarded).length).toBe(0);
    expect(denied).toBe(true); expect(current.forward).not.toHaveBeenCalled(); expect(outputForward).not.toHaveBeenCalled();
    expect(host.authReads).toBe(0); expect(proxy.stdin.destroyed).toBe(true);
    expect(record(current, ".cancel").unit).toBe(current.provider); expect(proxy.kill).toHaveBeenCalledWith("SIGTERM");
    const controls = host.calls.filter(c => ["kill", "stop"].includes(c.args[0]!));
    expect(controls.length).toBeGreaterThan(0); expect(controls.every(c => c.args.at(-1) === current.provider)).toBe(true);
    expect(record(current, ".submission").state).toBe("pending");
  });
  it("accepts byte-fragmented readiness and forwards only later native output after owner publication", async () => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
    host.spawn.mockImplementation(submit);
    const output = new PassThrough(), nativeOutput: Buffer[] = [];
    streams.add(output); output.on("data", chunk => nativeOutput.push(Buffer.from(chunk)));
    const pipe = proxy.stdout.pipe.bind(proxy.stdout);
    const outputForward = vi.spyOn(proxy.stdout, "pipe").mockImplementation(destination => {
      expect(destination).toBe(process.stdout);
      expect(record(current, ".owner").process.namespaces).toEqual(settledNamespaces);
      return pipe(output) as typeof destination;
    });
    const native = '{"jsonrpc":"2.0","id":1,"result":{"TEST":true}}\n';
    proxy.stdin.once("data", () => {
      expect(record(current, ".owner").service.unit).toBe(current.provider);
      proxy.stdout.end(native); proxy.exitCode = 0; proxy.emit("exit", 0, null);
    });
    const running = runResearchProviderService(current.jobId, current.provider, current.home);
    for (const byte of Buffer.from(readyFrame)) {
      expect(forwarded).toHaveLength(0); expect(current.forward).not.toHaveBeenCalled();
      expect(outputForward).not.toHaveBeenCalled(); expect(() => record(current, ".owner")).toThrow();
      proxy.stdout.write(Buffer.from([byte])); await Promise.resolve();
    }
    await running;
    expect(Buffer.concat(nativeOutput).toString()).toBe(native);
    expect(Buffer.concat(forwarded).toString()).toContain('"command":"/usr/bin/TEST-codex"');
    expect(current.forward).toHaveBeenCalledOnce(); expect(outputForward).toHaveBeenCalledOnce();
    expect(record(current, ".submission").state).toBe("settled");
  });
  it("ignores early Type=exec MainPID until the confined launcher is ready and keeps later namespace changes fenced", async () => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
    host.spawn.mockImplementation(() => { const result = submit(); host.processNamespaces.delete(424242); return result; });
    proxy.stdin.once("data", () => { proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    const running = runResearchProviderService(current.jobId, current.provider, current.home);
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
      const rejected = expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow("hosted_research_launch_denied");
      if (fault === "timeout") await vi.advanceTimersByTimeAsync(180_025);
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
    await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow();
    expect(record(current, ".owner").process.namespaces).toEqual(settledNamespaces);
    expect(current.forward).not.toHaveBeenCalled(); expect(forwarded).toHaveLength(0);
  });
  it.each(["duplicate-frame", "queued-data", "eof", "queued-eof", "close-event", "stdout-error", "spawn-error", "exit", "signal", "timeout", "cancel", "owner-namespace", "owner-invocation"])(
    "retains the control failure fence through owner publication on %s", async fault => {
      const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current);
      host.spawn.mockImplementation(submit);
      const outputForward = vi.spyOn(proxy.stdout, "pipe"), sync = fs.fsyncSync;
      let published = false;
      vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
        sync(fd);
        if (!host.fdPaths.get(fd)?.endsWith(current.provider + ".owner.json")) return;
        published = true;
        if (fault === "duplicate-frame") proxy.stdout.write(readyFrame);
        if (fault === "queued-data") process.nextTick(() => proxy.stdout.write("TEST forbidden native output\n"));
        if (fault === "eof") proxy.stdout.end();
        if (fault === "queued-eof") process.nextTick(() => proxy.stdout.end());
        // A latched observation must also reject when stream flags remain live.
        if (fault === "close-event") proxy.stdout.emit("close");
        if (fault === "stdout-error") proxy.stdout.emit("error", new Error("TEST post-ready stdout error"));
        if (fault === "spawn-error") proxy.emit("error", new Error("TEST post-ready transport error"));
        if (fault === "exit") { proxy.exitCode = 0; proxy.emit("exit", 0, null); }
        if (fault === "signal") { proxy.signalCode = "SIGTERM"; proxy.emit("exit", null, "SIGTERM"); }
        if (fault === "timeout") vi.spyOn(performance, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
        if (fault === "cancel") signalResearchProvider(current.directory, current.provider);
        if (fault === "owner-namespace") host.processNamespaces.set(424242, { ...settledNamespaces, mnt: "TEST-foreign-mnt" });
        if (fault === "owner-invocation") host.units.get(current.provider)!.invocation = "e".repeat(32);
      });
      proxy.stdin.once("data", () => { proxy.exitCode = 0; proxy.emit("exit", 0, null); });
      let denied = false;
      try { await runResearchProviderService(current.jobId, current.provider, current.home); } catch { denied = true; }
      expect(published).toBe(true); expect(denied).toBe(true);
      expect(record(current, ".owner").process.namespaces).toEqual(settledNamespaces);
      expect(forwarded).toHaveLength(0); expect(current.forward).not.toHaveBeenCalled(); expect(outputForward).not.toHaveBeenCalled();
      expect(host.authReads).toBe(0); expect(proxy.stdin.destroyed).toBe(true); expect(proxy.kill).toHaveBeenCalledWith("SIGTERM");
      expect(record(current, ".cancel").unit).toBe(current.provider);
      const controls = host.calls.filter(c => ["kill", "stop"].includes(c.args[0]!));
      if (fault.startsWith("owner-")) expect(controls).toHaveLength(0); // Changed ownership cannot grant signal authority.
      else { expect(controls.length).toBeGreaterThan(0); expect(controls.every(c => c.args.at(-1) === current.provider)).toBe(true); }
      expect(record(current, ".submission").state).toBe(["exit", "signal"].includes(fault) ? "settled" : "pending");
    });
});

describe("independent review: selected plan changes across the added handoff yield", () => {
  it.each(["unchanged", "source-inode", "removed-policy"])("checks queued %s before bootstrap", async fault => {
    const current = prepareHelper();
    const f = await preparedResearchScratch(current.spec.request.jobRootDir, current.home);
    const resolve = scratch.resolvePreparedHostScratchBinds;
    let planReads = 0, changed = false;
    vi.spyOn(scratch, "resolvePreparedHostScratchBinds").mockImplementation((job, home) => {
      const result = resolve(job, home, f.host);
      if (++planReads === 2) process.nextTick(() => {
        if (fault === "source-inode") {
          const selected = f.prepared[0]!;
          const source = f.nodes.get(selected.source)!;
          f.nodes.set(selected.source, { ...source, ino: source.ino + 1 });
          changed = true;
        }
        if (fault === "removed-policy") { f.nodes.delete(f.configPath); changed = true; }
      });
      return result;
    });
    const { proxy, forwarded, submit } = providerProxy(current);
    host.spawn.mockImplementation(submit);
    proxy.stdin.once("data", () => { proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    let denied = false;
    try { await runResearchProviderService(current.jobId, current.provider, current.home); } catch { denied = true; }
    let planNowMatches = false;
    try {
      planNowMatches = JSON.stringify(trustedResearchProviderLaunch(current.spec, current.provider, current.home).args) ===
        JSON.stringify(host.spawn.mock.calls[0]![1]);
    } catch { /* Changed selected source is now explicitly refused by the existing validator. */ }
    console.info(JSON.stringify({ fault, changed, denied, planNowMatches, bootstrapBytes: Buffer.concat(forwarded).length, forwardCalls: current.forward.mock.calls.length, submission: record(current, ".submission").state }));
    if (fault === "unchanged") {
      expect(denied).toBe(false); expect(forwarded.length).toBeGreaterThan(0);
    } else {
      expect(changed).toBe(true); expect(planNowMatches).toBe(false);
      expect(denied).toBe(true); expect(forwarded).toHaveLength(0); expect(current.forward).not.toHaveBeenCalled();
    }
  });
});


describe("independent review: runtime binding authority after material I/O", () => {
  it.each(["unchanged", "revoke-during-walk"])("checks %s before publishing binding", fault => {
    const req = request();
    grantResearchLaunch(req.jobId, req.jobRootDir, req.workspacePath);
    const start = startResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")));
    host.group = "/system.slice/" + start.unit;
    const current = researchCurrentStart(start.jobId);
    const original = fs.readdirSync;
    let changed = false;
    vi.spyOn(fs, "readdirSync").mockImplementation(((path: string, options: never) => {
      if (fault === "revoke-during-walk" && !changed && path === "/TEST-artifact/dist") {
        changed = true; revokeResearchLaunch(start.jobId);
      }
      return original(path, options);
    }) as typeof fs.readdirSync);
    let denied = false;
    try { bindResearchRuntime(start.jobId, start.startId); } catch { denied = true; }
    const bindingExists = fs.existsSync(join(current.directory, "binding.json"));
    const grantExists = fs.existsSync(join(current.directory, "..", "..", "grant.json"));
    console.info(JSON.stringify({ fault, changed, denied, bindingExists, grantExists }));
    if (fault === "unchanged") { expect(denied).toBe(false); expect(bindingExists).toBe(true); }
    else { expect(changed).toBe(true); expect(grantExists).toBe(false); expect(denied).toBe(true); expect(bindingExists).toBe(false); }
  });
});
