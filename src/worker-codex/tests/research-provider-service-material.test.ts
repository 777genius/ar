import { host, local, request, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as processes from "node:child_process";
import { join } from "node:path";
import { revokeResearchLaunch } from "../research-launch-owner";
import { researchDirectoryIdentity, researchHash, researchPublish, researchRead } from "../research-launch-files";
import { signalResearchProvider } from "../research-launch-lifecycle";
import { runResearchProviderService } from "../research-provider-service";
import * as scratch from "../host-scratch-temp";
import { preparedResearchScratch } from "./fixtures/research-scratch-host";
import { trustedResearchRuntimeLaunch } from "../trusted-custody-systemd-launch";
import { prepareHelper, providerProxy, providerStreams, readyFrame, settledNamespaces, record, researchClock, slowBoundedMaterial } from "./research-provider-service-fixture";
import { CodexModelBackend, codexMimoDefaultModel } from "@vioxen/subscription-runtime/provider-codex";
import { parseResearchOperatorRequest } from "../research-launch-contract";

let previousExitCode: typeof process.exitCode;
beforeEach(() => { previousExitCode = process.exitCode; setupResearchFixture(); });
afterEach(() => {
  for (const stream of providerStreams) { stream.unpipe(); stream.destroy(); }
  providerStreams.clear(); vi.useRealTimers(); process.exitCode = previousExitCode; cleanupResearchFixture();
});

describe("slow bounded material at research effect boundaries", () => {
  // RED: provider transport and its service reject at 300s despite the sealed allocation.
  it.each([[600_000, 1_200_000, 600], [600_000, 400_000, 400]])("shares owned MiMo startup %s / task %s allowance with the actual provider transport", async (startup, task, seconds) => {
    const current = prepareHelper("mimo-TEST/codex-home", parseResearchOperatorRequest({ ...request(), accounts: ["account-q"], modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      model: codexMimoDefaultModel, maxAccountCycles: 1, prewarmOnStart: false, appServerStartupTimeoutMs: startup, taskTimeoutMs: task }));
    researchPublish(join(current.directory, "mimo-home.json"), { schemaVersion: 1,
      specSha256: researchHash(current.bytes), identity: researchDirectoryIdentity(current.home) }, true);
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
    const footprintPath = join(current.directory, "mimo-writable-footprint.json");
    const footprint = JSON.parse(researchRead(footprintPath).toString());
    expect(footprint).toMatchObject({ unit: current.provider, specSha256: researchHash(current.bytes),
      artifactSha256: current.spec.artifactSha256, homeSha256: researchHash(researchRead(join(current.directory, "mimo-home.json"))) });
    expect(footprint.planSha256).toBe(researchHash(researchRead(join(current.directory, "provider-roots", current.provider, "plan.json"))));
    expect(footprint.roots.length).toBeGreaterThanOrEqual(2);

  });
  // RED: footprint drift was not observed at the real submission/forwarding boundary.
  it.each(["executable-custody", "final-owner-read"] as const)("rejects MiMo footprint drift at %s before forwarding", async boundary => {
    const current = prepareHelper("mimo-TEST/codex-home", parseResearchOperatorRequest({ ...request(),
      accounts: ["account-q"], modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      model: codexMimoDefaultModel, maxAccountCycles: 1, prewarmOnStart: false }));
    researchPublish(join(current.directory, "mimo-home.json"), { schemaVersion: 1,
      specSha256: researchHash(current.bytes), identity: researchDirectoryIdentity(current.home) }, true);
    const { forwarded, submit } = providerProxy(current);
    host.spawn.mockImplementation(submit);
    const path = join(current.directory, "mimo-writable-footprint.json");
    let changed = false;
    const corrupt = () => {
      changed = true;
      const binding = JSON.parse(researchRead(path).toString());
      researchPublish(path, { ...binding, roots: [] });
    };
    if (boundary === "executable-custody") {
      const stat = fs.lstatSync;
      vi.spyOn(fs, "lstatSync").mockImplementation(((input: string) => {
        if (input === "/usr/bin/tini" && !changed && fs.existsSync(path)) corrupt();
        return stat(input);
      }) as typeof fs.lstatSync);
    } else {
      const run = processes.spawnSync;
      vi.spyOn(processes, "spawnSync").mockImplementation(((command: string, args: string[], options: never) => {
        const result = run(command, args, options);
        if (!changed && command === "/usr/bin/systemctl" && args[0] === "show" && args.includes(current.provider) &&
            fs.existsSync(local(join(current.directory, "providers", current.provider + ".owner.json")))) corrupt();
        return result;
      }) as typeof processes.spawnSync);
    }
    await expect(runResearchProviderService(current.jobId, current.provider, current.home))
      .rejects.toThrow("hosted_research_launch_denied");
    expect(changed).toBe(true);
    expect(host.spawn).toHaveBeenCalledTimes(boundary === "executable-custody" ? 0 : 1);
    expect(forwarded).toHaveLength(0); expect(current.forward).not.toHaveBeenCalled();
    expect(host.authReads).toBe(0);
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
