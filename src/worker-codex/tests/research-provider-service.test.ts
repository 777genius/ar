import { publicTestCa, host, local, request, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as processes from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { grantResearchLaunch, startResearchLaunch, revokeResearchLaunch } from "../research-launch-owner";
import { bindResearchRuntime, researchCurrentStart } from "../research-launch-admission";
import { researchHash, researchPublish, researchRead } from "../research-launch-files";
import { researchProcessIdentity, researchServiceIdentity } from "../research-launch-host";
import { cancelResearchLaunch, signalResearchProvider, statusResearchLaunch } from "../research-launch-lifecycle";
import { runResearchProviderService } from "../research-provider-service";
import { signalCodexAppServerChildGroup } from "../../provider-codex/app-server/adapters/node-app-server-process";
import * as scratch from "../host-scratch-temp";
import { preparedResearchScratch } from "./fixtures/research-scratch-host";
import { trustedResearchProviderLaunch, trustedResearchRuntimeLaunch } from "../trusted-custody-systemd-launch";
import { prepareResearchProviderRoot, type ResearchProviderRootPlan } from "../research-provider-root";
import { prepareHelper } from "./research-provider-service-fixture";
import { CodexModelBackend, codexMimoDefaultModel } from "@vioxen/subscription-runtime/provider-codex";
import { parseResearchOperatorRequest } from "../research-launch-contract";

let previousExitCode: typeof process.exitCode;
const streams = new Set<PassThrough>();
beforeEach(() => { previousExitCode = process.exitCode; setupResearchFixture(); });
afterEach(() => { for (const stream of streams) { stream.unpipe(); stream.destroy(); } streams.clear(); vi.useRealTimers(); process.exitCode = previousExitCode; cleanupResearchFixture(); });
const rootPlans = new WeakMap<ReturnType<typeof prepareHelper>, ResearchProviderRootPlan>();
function providerLaunch(current: ReturnType<typeof prepareHelper>, home = current.home, scratchHost?: scratch.ScratchTempHost) {
  let root = rootPlans.get(current);
  if (!root) { root = prepareResearchProviderRoot(current.spec, current.provider, home, scratchHost); rootPlans.set(current, root); }
  return trustedResearchProviderLaunch(current.spec, current.provider, home, root);
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
describe("authenticated prepared scratch visibility (synthetic Host, no OS mounts)", () => {
  it("carries all three selected physical sources so independent providers see runtime-private data", async () => {
    const current = prepareHelper(), f = await preparedResearchScratch(current.spec.request.jobRootDir, current.home);
    const plan = providerLaunch(current, current.home, f.host);
    expect(plan.args).toContain("--property=TimeoutStartSec=300s");
    const runtime = trustedResearchRuntimeLaunch(current.spec, researchHash(current.bytes));
    expect(runtime.args).toContain("--property=MountFlags=private");
    expect(plan.args).toContain("--property=MountFlags=private");
    // Propagation is installed policy; caller input cannot replace it or append properties.
    for (const injected of [{ ...current.spec, mountFlags: "shared" }, { ...current.spec, systemdProperties: ["MountFlags=shared"] }]) {
      expect(() => trustedResearchRuntimeLaunch(injected, researchHash(current.bytes))).toThrow("hosted_research_launch_denied");
      expect(() => trustedResearchProviderLaunch(injected, current.provider, current.home, rootPlans.get(current)!)).toThrow("hosted_research_launch_denied");
    }
    const pinBinds = runtime.args.filter(arg => arg.startsWith("--property=BindPaths="));
    const selected = [
      { source: "/TEST-nvme/runtime-tmp/8794cd8e3d7d92468efc8cef6960bd97fd9e40dd0460e297c3004b12a3ec7a5c", target: join(current.spec.request.jobRootDir, "tmp") },
      { source: "/TEST-nvme/runtime-caches/37e385e326df74a53659409f92ea51bf571e9b9ee28533aff43ea69d4a5af86c", target: join(current.home, "plugins/cache") },
      { source: "/TEST-nvme/runtime-caches/a071e67a38dd8556cbcfc146144797299a85af79956fd438f852c7c4364ed5c6", target: join(current.home, "cache/remote_plugin_catalog") },
    ];
    expect(plan.args.filter(arg => arg.startsWith("--property=BindPaths="))).toEqual([
      ...pinBinds, ...selected.map(({ source, target }) => `--property=BindPaths=${source}:${target}:norbind`),
    ]);
    // Model the independently observed topology: original nonrecursive pins contain none of these later private mounts. Only explicit physical binds
    // can resolve their data. This assertion does not simulate Linux confinement.
    const data = new Map(f.prepared.map(({ source }, i) => [source, ["TEST-agent-marker", "TEST-plugin-data", "TEST-catalog-data"][i]]));
    const visible = (args: readonly string[]) => new Map(args.filter(arg => arg.startsWith("--property=BindPaths="))
      .map(arg => { const [source, target] = arg.slice("--property=BindPaths=".length).split(":"); return [target, data.get(source!)] as const; }));
    for (const { target } of selected) expect(visible(pinBinds).get(target)).toBeUndefined();
    expect(selected.map(({ target }) => visible(plan.args).get(target))).toEqual(["TEST-agent-marker", "TEST-plugin-data", "TEST-catalog-data"]);
    expect(plan.args).toContain("--property=MountAPIVFS=yes");
    expect(plan.args.filter(arg => arg.startsWith("--property=BindReadOnlyPaths="))).toContain("--property=BindReadOnlyPaths=/usr:/usr:norbind");
    expect(plan.args).toContain(`--property=ReadWritePaths=${current.spec.request.jobRootDir} ${current.spec.request.workspacePath}`);
    expect(plan.args).toContain("--mount-proc"); expect(plan.args.at(-1)).toBe("--research-ready-v1");
    expect(f.mutations).toEqual([]);
  });
  it.each(["absent", "legacy"])("keeps %s policy as a positive launch without extra binds or mutations", async kind => {
    const current = prepareHelper(), f = await preparedResearchScratch(current.spec.request.jobRootDir, current.home);
    if (kind === "absent") {
      f.nodes.delete(f.configPath);
      for (const { target } of f.prepared) { f.mounts.delete(target); host.scratchMounts.delete(target); }
    }
    else {
      const legacyTemps = Object.fromEntries(f.prepared.map(({ target }) => {
        f.mounts.delete(target); host.scratchMounts.delete(target); const info = f.nodes.get(target)!;
        return [target, { device: info.dev, inode: info.ino }];
      }));
      f.setPolicy({ schemaVersion: 1, root: f.root, uuid: f.uuid, legacyTemps });
    }
    const plan = providerLaunch(current, current.home, f.host);
    expect(plan.args.filter(arg => arg.startsWith("--property=BindPaths="))).toEqual(
      trustedResearchRuntimeLaunch(current.spec, researchHash(current.bytes)).args.filter(arg => arg.startsWith("--property=BindPaths=")));
    expect(f.mutations).toEqual([]);
  });
  async function fallbackHomes(partial = false) {
    const current = prepareHelper(`codex-session-cache/codex-${"b".repeat(32)}/codex-home`), other = current.home;
    const earlier = join(current.spec.request.jobRootDir, "home/codex-session-cache", `codex-${"a".repeat(32)}`, "codex-home");
    fs.mkdirSync(local(earlier), { recursive: true, mode: 0o700 });
    const f = await preparedResearchScratch(current.spec.request.jobRootDir, earlier, partial);
    expect(f.observedCacheFailure?.message).toBe(partial ? "TEST second cache preparation failed" : undefined);
    f.nodes.set(other, f.directory()); await scratch.prepareHostScratchCaches(other, {}, f.host); f.mutations.length = 0;
    return { current, f, other, earlier };
  }
  // Regression: A's genuine native mounts survive when B is selected; neither complete nor partially prepared A caches may become B's explicit sources.
  it.each([false, true])("selects only this account's caches with earlier partial=%s preparation", async partial => {
    const { current, f, other, earlier } = await fallbackHomes(partial);
    const foreign = f.prepared.filter(bind => bind.target.startsWith(earlier + "/") && f.mounts.has(bind.target));
    expect(foreign).toHaveLength(partial ? 1 : 2);
    for (const { target } of foreign) expect(host.scratchMounts.get(target)).toEqual(f.mounts.get(target));
    const plan = providerLaunch(current, other, f.host), binds = plan.args.filter(arg => arg.startsWith("--property=BindPaths="));
    expect(binds).toEqual([
      ...trustedResearchRuntimeLaunch(current.spec, researchHash(current.bytes)).args.filter(arg => arg.startsWith("--property=BindPaths=")),
      ...f.prepared.filter(bind => !bind.target.startsWith(earlier + "/")).map(({ source, target }) => `--property=BindPaths=${source}:${target}:norbind`),
    ]);
    expect(binds.slice(2).map(arg => arg.split(":")[1])).toEqual([join(current.spec.request.jobRootDir, "tmp"), join(other, "plugins/cache"), join(other, "cache/remote_plugin_catalog")]);
    expect(plan.args.some(arg => foreign.some(bind => arg.includes(bind.source) || arg.includes(bind.target)))).toBe(false);
    expect(providerLaunch(current, other, f.host).args).toEqual(plan.args);
    expect(f.mutations).toEqual([]); expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  // Regression: the default descriptor reader must select the fixed CA role for both public source and retained snapshot, rather than the DNS limit.
  it("prepares and revalidates a public CA bundle above 64 KiB through the default root adapter", () => {
    const current = prepareHelper(), bytes = publicTestCa.repeat(94);
    fs.writeFileSync("/etc/ssl/certs/ca-certificates.crt", bytes, { mode: 0o644 });
    const plan = providerLaunch(current);
    expect(providerLaunch(current).args).toEqual(plan.args);
    expect(plan.args.some(arg => arg.startsWith("--property=RootDirectory="))).toBe(true);
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  // Regression: the real policy is over 1 MiB; borrowing DNS's 64 KiB cap rejects valid fallback, while an unbounded policy reader admits >8 MiB.
  it("accepts a large legacy policy through the policy-role contract and denies its fixed ceiling", async () => {
    const { current, f, other } = await fallbackHomes(true);
    const legacyTemps = Object.fromEntries(Array.from({ length: 25000 }, (_, index) =>
      [`/TEST-retired-job/${index}/tmp`, { device: 2049, inode: index + 1 }]));
    f.setPolicy({ schemaVersion: 1, root: f.root, uuid: f.uuid, legacyTemps });
    const bytes = fs.readFileSync(f.configPath);
    expect(bytes.length).toBeGreaterThan(1249282); expect(bytes.length).toBeLessThan(8 * 1024 * 1024);
    fs.writeFileSync(f.configPath, Buffer.concat([bytes, Buffer.alloc(8 * 1024 * 1024, 0x20)]));
    expect(() => providerLaunch(current, other, f.host)).toThrow();
    expect(fs.existsSync(local(join(current.directory, "provider-roots")))).toBe(false);
    fs.writeFileSync(f.configPath, bytes);
    const plan = providerLaunch(current, other, f.host);
    expect(providerLaunch(current, other, f.host).args).toEqual(plan.args);
    expect(plan.args.filter(arg => arg.startsWith("--property=BindPaths="))).toHaveLength(5);
    expect(f.mutations).toEqual([]); expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  // Regression: the omission class must retain native/policy/base custody, and reject the same corrupted topology both initially and on a retained receipt.
  it.each(["native-source", "mount-backing", "source-owner", "home-owner", "base-data", "base-alias", "unknown-child", "unknown-suffix", "unknown-home", "foreign-uuid", "selected-alias"])(
    "denies foreign cache %s before root effects and at revalidation", async fault => {
      const { current, f, other, earlier } = await fallbackHomes(true), foreign = f.prepared.find(bind => bind.target === join(earlier, "plugins/cache"))!;
      const source = host.scratchNodes.get(foreign.source)!, target = host.scratchNodes.get(foreign.target)!, mount = host.scratchMounts.get(foreign.target)!;
      const base = join(current.directory, "pins/job", foreign.target.slice(current.spec.request.jobRootDir.length));
      const corrupt = () => {
        if (fault === "native-source") host.scratchNodes.set(foreign.source, { ...source, ino: source.ino + 1 });
        if (fault === "mount-backing") host.scratchMounts.set(foreign.target, { ...mount, fsroot: "/TEST-foreign" });
        if (fault === "source-owner") host.scratchNodes.set(foreign.source, { ...source, uid: 999 });
        if (fault === "home-owner") host.foreign.add(earlier);
        if (fault === "base-data") fs.writeFileSync(join(base, "TEST-data"), "TEST", { mode: 0o600 });
        if (fault === "base-alias") { fs.renameSync(base, base + "-saved"); fs.symlinkSync(base + "-saved", base); }
        if (fault === "unknown-child") host.scratchMounts.set(foreign.target + "/TEST-child", { ...mount, target: foreign.target + "/TEST-child" });
        if (fault === "unknown-suffix") host.scratchMounts.set(join(earlier, "TEST-unknown"), { ...mount, target: join(earlier, "TEST-unknown") });
        if (fault === "unknown-home") host.scratchMounts.set(join(current.spec.request.jobRootDir, "home/TEST-b/plugins/cache"), { ...mount, target: join(current.spec.request.jobRootDir, "home/TEST-b/plugins/cache") });
        if (fault === "foreign-uuid") f.mounts.set(foreign.target, { ...mount, uuid: "11111111-1111-1111-1111-111111111111" });
        if (fault === "selected-alias") {
          const selected = f.prepared.find(bind => bind.target === join(other, "plugins/cache"))!, alias = host.scratchNodes.get(selected.source)!;
          for (const path of [foreign.source, foreign.target]) { host.scratchNodes.set(path, alias); f.nodes.set(path, alias); }
        }
      };
      const restore = () => {
        host.scratchNodes.set(foreign.source, source); host.scratchNodes.set(foreign.target, target); f.nodes.set(foreign.source, source); f.nodes.set(foreign.target, target);
        host.scratchMounts.set(foreign.target, mount); f.mounts.set(foreign.target, mount); host.foreign.delete(earlier);
        host.scratchMounts.delete(foreign.target + "/TEST-child"); host.scratchMounts.delete(join(earlier, "TEST-unknown")); host.scratchMounts.delete(join(current.spec.request.jobRootDir, "home/TEST-b/plugins/cache"));
        if (fault === "base-data") fs.unlinkSync(join(base, "TEST-data"));
        if (fault === "base-alias") { fs.unlinkSync(base); fs.renameSync(base + "-saved", base); }
        f.setPolicy({ schemaVersion: 1, root: f.root, uuid: f.uuid });
      };
      corrupt(); expect(() => providerLaunch(current, other, f.host)).toThrow();
      expect(fs.existsSync(local(join(current.directory, "provider-roots")))).toBe(false);
      restore(); const plan = providerLaunch(current, other, f.host);
      corrupt(); expect(() => providerLaunch(current, other, f.host)).toThrow();
      restore(); expect(providerLaunch(current, other, f.host).args).toEqual(plan.args);
      expect(host.spawn).not.toHaveBeenCalled(); expect(current.forward).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
      expect(() => record(current, ".submission")).toThrow(); expect(f.mutations).toEqual([]);
    });
  it("retains native policy identity/semantics and the foreign lower anchor after preparation", async () => {
    const { current, f, other, earlier } = await fallbackHomes(true), foreign = f.prepared.find(bind => bind.target === join(earlier, "plugins/cache"))!;
    const base = join(current.directory, "pins/job", foreign.target.slice(current.spec.request.jobRootDir.length));
    const plan = providerLaunch(current, other, f.host), policyBytes = fs.readFileSync(f.configPath);
    // Valid unrelated legacy data preserves the adapter's selected binds, but changes the trusted policy fingerprint retained by this exact receipt.
    f.setPolicy({ schemaVersion: 1, root: f.root, uuid: f.uuid, legacyTemps: { "/TEST-unselected": { device: 2049, inode: 1 } } });
    expect(() => providerLaunch(current, other, f.host)).toThrow();
    f.setPolicy({ schemaVersion: 1, root: f.root, uuid: f.uuid });
    expect(providerLaunch(current, other, f.host).args).toEqual(plan.args);
    for (const path of [base, f.configPath]) {
      fs.renameSync(path, path + "-saved");
      if (path === base) fs.mkdirSync(path, { mode: 0o701 }); else fs.writeFileSync(path, policyBytes, { mode: 0o600 });
      expect(() => providerLaunch(current, other, f.host)).toThrow();
      if (path === base) fs.rmdirSync(local(path)); else fs.unlinkSync(path);
      fs.renameSync(path + "-saved", path); expect(providerLaunch(current, other, f.host).args).toEqual(plan.args);
    }
    expect(f.mutations).toEqual([]); expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
  it.each([0, 1, 2])("rejects changed mount/source facts at exact selected leaf %s before launch", async index => {
    const current = prepareHelper(), f = await preparedResearchScratch(current.spec.request.jobRootDir, current.home);
    const selected = f.prepared[index]!, mount = f.mounts.get(selected.target)!, originalSource = f.nodes.get(selected.source)!;
    const resolve = scratch.resolvePreparedHostScratchBinds;
    vi.spyOn(scratch, "resolvePreparedHostScratchBinds").mockImplementation((job, home) => resolve(job, home, f.host));
    // Revalidate the same retained receipt on healthy and corrupted facts. Re-entering the service would deny the pre-existing root independently.
    const healthy = (): string[] => {
      const args = providerLaunch(current).args;
      expect(args).toContain(`--property=BindPaths=${selected.source}:${selected.target}:norbind`);
      return args;
    };
    const originalArgs = healthy();
    const rootRecord = join(current.directory, "provider-roots", current.provider, "plan.json"), originalRootBytes = researchRead(rootRecord);
    for (const badMount of [{ ...mount, uuid: "foreign" }, { ...mount, fsroot: "/foreign" }, { ...mount, target: "/foreign" }, undefined]) {
      expect(healthy()).toEqual(originalArgs);
      f.mounts.set(selected.target, badMount);
      expect(() => providerLaunch(current)).toThrow();
      f.mounts.set(selected.target, mount);
      expect(healthy()).toEqual(originalArgs);
    }
    const originalTarget = f.nodes.get(selected.target)!;
    for (const badTarget of [{ ...originalTarget, uid: 999 }, { ...originalTarget, mode: 0o777 }, { ...originalTarget, ino: originalTarget.ino + 1 }, { ...originalTarget, isSymbolicLink: () => true }]) {
      expect(healthy()).toEqual(originalArgs);
      f.nodes.set(selected.target, badTarget);
      expect(() => providerLaunch(current)).toThrow();
      f.nodes.set(selected.target, originalTarget);
      expect(healthy()).toEqual(originalArgs);
    }
    for (const badSource of [{ ...originalSource, uid: 999 }, { ...originalSource, mode: 0o777 }, { ...originalSource, ino: originalSource.ino + 1 }, { ...originalSource, isSymbolicLink: () => true }]) {
      expect(healthy()).toEqual(originalArgs);
      f.nodes.set(selected.source, badSource);
      expect(() => providerLaunch(current)).toThrow();
      f.nodes.set(selected.source, originalSource);
      expect(healthy()).toEqual(originalArgs);
    }
    expect(researchRead(rootRecord)).toEqual(originalRootBytes);
    expect(host.spawn).not.toHaveBeenCalled(); expect(current.forward).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    expect(() => record(current, ".submission")).toThrow(); expect(f.mutations).toEqual([]);
  });
  it.each([0, 1, 2])("rejects changed legacy identity at selected leaf %s through the same healthy receipt", async index => {
    const current = prepareHelper(), f = await preparedResearchScratch(current.spec.request.jobRootDir, current.home);
    const selected = f.prepared[index]!;
    f.mounts.delete(selected.target); host.scratchMounts.delete(selected.target);
    const legacy = { ...f.nodes.get(selected.target)!, dev: 2049, ino: 90000 + index };
    f.nodes.set(selected.target, legacy); host.scratchNodes.set(selected.target, legacy);
    const originalEntry = { device: 2049, inode: 90000 + index };
    const policy = (entry: unknown) => f.setPolicy({ schemaVersion: 1, root: f.root, uuid: f.uuid, legacyTemps: { [selected.target]: entry } });
    policy(originalEntry);
    const resolve = scratch.resolvePreparedHostScratchBinds;
    vi.spyOn(scratch, "resolvePreparedHostScratchBinds").mockImplementation((job, home) => resolve(job, home, f.host));
    const healthy = () => providerLaunch(current).args;
    const originalArgs = healthy();
    expect(originalArgs.filter(arg => arg.startsWith("--property=BindPaths="))).toEqual([
      ...trustedResearchRuntimeLaunch(current.spec, researchHash(current.bytes)).args.filter(arg => arg.startsWith("--property=BindPaths=")),
      ...f.prepared.filter(bind => bind.target !== selected.target).map(({ source, target }) => `--property=BindPaths=${source}:${target}:norbind`),
    ]);
    const rootRecord = join(current.directory, "provider-roots", current.provider, "plan.json"), originalRootBytes = researchRead(rootRecord);
    for (const entry of [true, { device: originalEntry.device, inode: originalEntry.inode + 1 }]) {
      expect(healthy()).toEqual(originalArgs);
      policy(entry); expect(() => providerLaunch(current)).toThrow();
      policy(originalEntry); expect(healthy()).toEqual(originalArgs);
    }
    expect(researchRead(rootRecord)).toEqual(originalRootBytes);
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
    const timing = JSON.parse(researchRead(join(current.directory, "provider-root-timing.json")).toString());
    expect(timing.scopes.map((scope: { scope: string; outcome: string }) => [scope.scope, scope.outcome])).toEqual([
      ["prepare", "completed"], ["initial-launch", "completed"]]);
    expect(timing.phase).toBe("submission-custody");
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
    // Keep durable assertions outside the failing observer: cancel's expected rejection must not swallow a missing-fence assertion and make this pass.
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
/** Move the substituted Host monotonic clock without replaying every 25 ms permission poll. Tests still execute the real poll at the selected boundary. */
function researchClock() {
  vi.useFakeTimers();
  const origin = Date.now(); let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - origin + elapsed);
  return Object.assign(() => performance.now(), { advance: (ms: number) => { elapsed += ms; } });
}
/** Model a three-second artifact traversal on slow Host I/O, still inside its finite thirty-second bound. All retained bytes/digests remain real; only the Host clock and directory-observation latency are substituted. */
function slowBoundedMaterial() {
  const now = researchClock();
  const readDirectory = fs.readdirSync;
  vi.spyOn(fs, "readdirSync").mockImplementation(((path: string, options: never) => {
    if (path === "/TEST-artifact/dist") now.advance(3_000);
    return readDirectory(path, options);
  }) as typeof fs.readdirSync);
  return now;
}
describe("slow bounded material at research effect boundaries", () => {
  // RED: provider transport and its service reject at 300s despite the sealed allocation.
  it.each([[600_000, 1_200_000, 600], [600_000, 400_000, 400]])("shares owned MiMo startup %s / task %s allowance with the actual provider transport", async (startup, task, seconds) => {
    const current = prepareHelper("TEST-mimo", parseResearchOperatorRequest({ ...request(), accounts: ["account-q"], modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      model: codexMimoDefaultModel, maxAccountCycles: 1, prewarmOnStart: false, appServerStartupTimeoutMs: startup, taskTimeoutMs: task }));
    const { proxy, forwarded, submit } = providerProxy(current, true, false);
    const now = slowBoundedMaterial(); host.spawn.mockImplementation(submit);
    expect(trustedResearchRuntimeLaunch(current.spec, researchHash(current.bytes)).args).toContain("--property=TimeoutStartSec=300s");
    const outcome = runResearchProviderService(current.jobId, current.provider, current.home).then(() => true, () => false);
    expect(host.spawn.mock.calls[0]?.[1]).toContain(`--property=TimeoutStartSec=${seconds}s`);
    proxy.stdin.once("data", () => { proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    now.advance(310_000); proxy.stdout.write(readyFrame); await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBe(true);
    expect(forwarded.length).toBeGreaterThan(0);
    expect(record(current, ".submission").state).toBe("settled");
  });
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
  it.each([65_931, 98_727, 130_000])("holds bootstrap through %i ms setup despite three-second verification, then completes bounded handoff", async setupMs => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
    const now = slowBoundedMaterial(); host.spawn.mockImplementation(submit);
    let readyAt = 0, releasedAt = 0;
    proxy.stdin.once("data", () => { releasedAt = now(); proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    const outcome = runResearchProviderService(current.jobId, current.provider, current.home).then(() => true, () => false);
    now.advance(setupMs - 25); await vi.advanceTimersByTimeAsync(25);
    expect(forwarded).toHaveLength(0); expect(current.forward).not.toHaveBeenCalled();
    readyAt = now();
    for (const part of [readyFrame.slice(0, 7), readyFrame.slice(7, 28), readyFrame.slice(28)]) proxy.stdout.write(part);
    await vi.advanceTimersByTimeAsync(0);
    const success = await outcome;
    console.info(`TEST substituted Host: success=${success}, ready-to-bootstrap=${releasedAt ? releasedAt - readyAt : "held"}ms; artifact walk=3000ms (bound=30000ms)`);
    expect(success).toBe(true);
    expect(releasedAt - readyAt).toBeLessThan(10_000);
    expect(forwarded.length).toBeGreaterThan(0); expect(current.forward).toHaveBeenCalledOnce();
    expect(record(current, ".owner").process.namespaces).toEqual(settledNamespaces);
    expect(record(current, ".submission").state).toBe("settled");
  });
  it("performs bounded material verification once before bootstrap within the setup deadline", async () => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
    const now = slowBoundedMaterial(); host.spawn.mockImplementation(submit);
    let readyAt = 0, releasedAt = 0;
    proxy.stdin.once("data", () => { releasedAt = now(); proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    const outcome = runResearchProviderService(current.jobId, current.provider, current.home).then(() => true, () => false);
    readyAt = now(); proxy.stdout.write(readyFrame);
    await vi.advanceTimersByTimeAsync(0);
    const success = await outcome;
    console.info(`TEST substituted Host: success=${success}, ready-to-bootstrap=${releasedAt ? releasedAt - readyAt : "held"}ms; artifact walk=3000ms (bound=30000ms)`);
    expect(success).toBe(true);
    expect(releasedAt - readyAt).toBeLessThan(10_000);
    expect(forwarded.length).toBeGreaterThan(0);
  });
  it("finishes eleven-second ownership I/O before releasing bootstrap within the original setup deadline", async () => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current);
    const now = researchClock(), sync = fs.fsyncSync; let verifiedAt = 0;
    host.spawn.mockImplementation(submit);
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      sync(fd);
      if (host.fdPaths.get(fd)?.endsWith(current.provider + ".owner.json")) {
        verifiedAt = now();
        expect(forwarded).toHaveLength(0); expect(current.forward).not.toHaveBeenCalled();
        // Synchronous fsync cannot yield to polling, even on slow Host I/O.
        now.advance(11_000);
        expect(forwarded).toHaveLength(0); expect(current.forward).not.toHaveBeenCalled();
      }
    });
    proxy.stdin.once("data", () => { proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    const running = runResearchProviderService(current.jobId, current.provider, current.home);
    await vi.advanceTimersByTimeAsync(0); await running;
    expect(now() - verifiedAt).toBeGreaterThanOrEqual(11_000);
    expect(record(current, ".owner").process.namespaces).toEqual(settledNamespaces);
    expect(forwarded.length).toBeGreaterThan(0); expect(current.forward).toHaveBeenCalledOnce();
    expect(record(current, ".submission").state).toBe("settled");
  });
  it("keeps bootstrap held when late readiness and final verification exceed the original 300s setup deadline", async () => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
    const now = slowBoundedMaterial(), sync = fs.fsyncSync; host.spawn.mockImplementation(submit);
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      sync(fd); if (host.fdPaths.get(fd)?.endsWith(current.provider + ".owner.json")) now.advance(9_500);
    });
    proxy.stdin.once("data", () => { proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    const outcome = runResearchProviderService(current.jobId, current.provider, current.home).then(() => false, () => true);
    const waitingAt = now(); now.advance(295_000); proxy.stdout.write(readyFrame); await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBe(true); expect(now() - waitingAt).toBeGreaterThan(300_000);
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
      if (ownerPublished && observation === "artifact-deadline" && path === "/TEST-artifact/dist") elapsed += 31_000;
      return readDirectory(path, options);
    }) as typeof fs.readdirSync);
    vi.spyOn(fs, "lstatSync").mockImplementation(((path: string) => {
      if (ownerPublished && observation === "file-deadline" && path === process.execPath) elapsed += 31_000;
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
  // RED: synchronous manager reads during inert namespace setup deny before
  // readiness; existing tests exercise manager failure only after readiness.
  it("waits without manager reads, then freshly verifies both owners before forwarding", async () => {
    researchClock();
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
    const original = processes.spawnSync;
    let managerBusy = false, earlyReads = 0;
    const verified: string[] = [];
    vi.spyOn(processes, "spawnSync").mockImplementation(((command: string, args: string[], options: never) => {
      if (command === "/usr/bin/systemctl" && args[0] === "show") {
        if (managerBusy) {
          earlyReads++;
          return { status: null, error: Object.assign(new Error("TEST manager busy"), { code: "ETIMEDOUT" }), stdout: "", stderr: "" };
        }
        verified.push(args[1]!);
      }
      return original(command, args, options);
    }) as typeof processes.spawnSync);
    host.spawn.mockImplementation(() => { const result = submit(); managerBusy = true; verified.length = 0; return result; });
    proxy.stdin.once("data", () => {
      expect(verified).toContain(current.unit); expect(verified).toContain(current.provider);
      expect(record(current, ".owner").process.namespaces).toEqual(settledNamespaces);
      proxy.exitCode = 0; proxy.emit("exit", 0, null);
    });
    const outcome = runResearchProviderService(current.jobId, current.provider, current.home).then(() => true, () => false);
    await vi.advanceTimersByTimeAsync(100);
    expect(earlyReads).toBe(0); expect(verified).toHaveLength(0);
    expect(forwarded).toHaveLength(0); expect(current.forward).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    expect(() => record(current, ".owner")).toThrow();
    managerBusy = false; proxy.stdout.write(readyFrame);
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBe(true); expect(earlyReads).toBe(0);
    expect(forwarded.length).toBeGreaterThan(0); expect(current.forward).toHaveBeenCalledOnce();
    expect(record(current, ".submission").state).toBe("settled");
  });
  it("admits settled readiness after forty-six seconds without releasing bootstrap while waiting", async () => {
    const now = researchClock();
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
    host.spawn.mockImplementation(submit);
    proxy.stdin.once("data", () => { proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    // Capture rejection immediately so the old fifteen-second deadline fails the outcome assertion, rather than producing an unhandled rejection.
    const outcome = runResearchProviderService(current.jobId, current.provider, current.home)
      .then(() => true, () => false);
    now.advance(46_000); await vi.advanceTimersByTimeAsync(25);
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
    // Make an incorrect bootstrap release terminate, so old code fails an effect assertion instead of merely hanging until the test timeout.
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
  it.each(["native-output", "oversize", "extra-output", "eof", "close", "stdout-error", "stderr-error", "stdin-error", "stdin-epipe", "stdin-destroyed", "spawn-error", "exit", "signal", "timeout", "cancel"])(
    "fails closed before owner/bootstrap/auth on readiness %s", async fault => {
      const now = fault === "timeout" ? researchClock() : undefined;
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
          if (fault === "stdin-destroyed") proxy.stdin.destroy();
          if (fault === "spawn-error") proxy.emit("error", new Error("TEST transport failure"));
          if (fault === "exit") { proxy.exitCode = 0; proxy.emit("exit", 0, null); }
          if (fault === "signal") { proxy.signalCode = "SIGTERM"; proxy.emit("exit", null, "SIGTERM"); }
          if (fault === "cancel") signalResearchProvider(current.directory, current.provider);
        });
        return result;
      });
      const rejected = expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow("hosted_research_launch_denied");
      if (now) {
        now.advance(299_974); await vi.advanceTimersByTimeAsync(25);
        expect(proxy.kill).not.toHaveBeenCalled(); expect(forwarded).toHaveLength(0);
        expect(current.forward).not.toHaveBeenCalled(); expect(() => record(current, ".owner")).toThrow();
        now.advance(1); await vi.advanceTimersByTimeAsync(25);
      }
      await rejected;
      expect(current.forward).not.toHaveBeenCalled(); expect(forwarded).toHaveLength(0); expect(host.authReads).toBe(0);
      expect(() => record(current, ".owner")).toThrow(); expect(record(current, ".cancel").unit).toBe(current.provider);
      expect(proxy.kill).toHaveBeenCalledWith("SIGTERM");
      expect(record(current, ".submission").state).toBe(["exit", "signal"].includes(fault) ? "settled" : "pending");
      const checks: Record<string, string> = {
        eof: "research-provider-transport:stdout-ended", close: "research-provider-transport:stdout-destroyed",
        "stdout-error": "research-provider-transport:transport-failed", "stderr-error": "research-provider-transport:transport-failed",
        "stdin-error": "research-provider-transport:transport-failed", "stdin-epipe": "research-provider-transport:transport-failed",
        "stdin-destroyed": "research-provider-transport:stdin-destroyed", "spawn-error": "research-provider-transport:transport-failed",
        exit: "research-provider-transport:proxy-exited", signal: "research-provider-transport:proxy-exited",
        timeout: "research-provider-transport:setup-deadline", cancel: "assertResearchProviderNotCancelled",
      };
      if (checks[fault]) expect(JSON.parse(researchRead(join(current.directory, "provider-failure.json")).toString()))
        .toEqual({ schemaVersion: 1, unit: current.provider, phase: "ready-and-owner", check: checks[fault] });
    });
  it("does not trust adapter error text, stack or cause as a finite transport observation", async () => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
    const error = new Error("TEST private adapter payload", { cause: "artifact-deadline" });
    error.stack = "Error: TEST private adapter payload\n    at research-provider-transport:setup-deadline (TEST)";
    host.spawn.mockImplementation(() => {
      const result = submit(); queueMicrotask(() => proxy.emit("error", error)); return result;
    });
    await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow("hosted_research_launch_denied");
    const bytes = researchRead(join(current.directory, "provider-failure.json")).toString();
    expect(JSON.parse(bytes)).toEqual({ schemaVersion: 1, unit: current.provider, phase: "ready-and-owner",
      check: "research-provider-transport:transport-failed" });
    expect(bytes).not.toContain("private adapter"); expect(bytes).not.toContain("artifact-deadline");
    expect(forwarded).toHaveLength(0); expect(current.forward).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    expect(() => record(current, ".owner")).toThrow();
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
      if (++planReads > 2 && host.fdPaths.size && host.units.has(current.provider) && !changed) process.nextTick(() => {
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
      planNowMatches = JSON.stringify(providerLaunch(current).args) ===
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
