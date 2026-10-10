import { host, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { readResearchStartBinding } from "../research-launch-admission";
import { researchHash, researchRead } from "../research-launch-files";
import { researchProcessIdentity, researchServiceIdentity } from "../research-launch-host";
import { runResearchProviderService } from "../research-provider-service";
import { prepareHelper } from "./research-provider-service-fixture";
import { streams, readyFrame, settledNamespaces, providerProxy, record } from "./research-provider-service-protocol-fixture";

let previousExitCode: typeof process.exitCode;
beforeEach(() => { previousExitCode = process.exitCode; setupResearchFixture(); });
afterEach(() => { for (const stream of streams) { stream.unpipe(); stream.destroy(); } streams.clear(); vi.useRealTimers(); process.exitCode = previousExitCode; cleanupResearchFixture(); });

describe("provider readiness retains live runtime namespace authority", () => {
  // RED if the provider-role split treats a cached binding as a live runtime
  // namespace observation or releases bootstrap after its creator lost authority.
  it.each(["before-ready", "after-raw-ready"] as const)("holds all native input when the live runtime namespace changes %s", async timing => {
    const current = prepareHelper(), { proxy, forwarded, submit } = providerProxy(current, true, false);
    const binding = readResearchStartBinding(current.directory), runtimePid = binding.process.pid;
    const before = researchProcessIdentity(runtimePid), service = researchServiceIdentity(current.spec.unit);
    const documents = [join(current.directory, "spec.json"), join(current.directory, "binding.json"),
      join("/run/user/subscription-runtime-research-v1", researchHash(current.jobId), "grant.json")];
    const retained = documents.map(path => researchRead(path));
    const changed = { ...before.namespaces, mnt: "TEST-live-runtime-mount-drift" };
    let mutated = false;
    const mutate = (): void => { host.processNamespaces.set(runtimePid, changed); mutated = true; };
    const outputForward = vi.spyOn(proxy.stdout, "pipe"), sync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      sync(fd);
      if (timing === "after-raw-ready" && host.fdPaths.get(fd)?.endsWith(current.provider + ".owner.json")) mutate();
    });
    host.spawn.mockImplementation(() => {
      const result = submit();
      queueMicrotask(() => { if (timing === "before-ready") mutate(); proxy.stdout.write(readyFrame); });
      return result;
    });
    // A broken forwarding fence finishes promptly and becomes an assertion
    // failure, rather than waiting for the full production transport deadline.
    proxy.stdin.once("data", () => { proxy.exitCode = 0; proxy.emit("exit", 0, null); });
    await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow("hosted_research_launch_denied");
    expect(mutated).toBe(true);
    expect(researchProcessIdentity(runtimePid)).toEqual({ ...before, namespaces: changed });
    expect(researchServiceIdentity(current.spec.unit)).toEqual(service);
    documents.forEach((path, index) => expect(researchRead(path).equals(retained[index]!)).toBe(true));
    expect(readResearchStartBinding(current.directory)).toEqual(binding);
    expect(forwarded).toHaveLength(0); expect(current.forward).not.toHaveBeenCalled(); expect(outputForward).not.toHaveBeenCalled();
    expect(host.authReads).toBe(0); expect(host.spawn).toHaveBeenCalledOnce(); expect(proxy.stdin.destroyed).toBe(true);
    expect(proxy.kill).toHaveBeenCalledWith("SIGTERM"); expect(record(current, ".cancel").unit).toBe(current.provider);
    const controls = host.calls.filter(call => ["kill", "stop"].includes(call.args[0]!));
    expect(controls.some(call => call.args[0] === "stop")).toBe(true);
    expect(controls.every(call => call.args.at(-1) === current.provider)).toBe(true);
    expect(record(current, ".submission").state).toBe("pending");
    if (timing === "after-raw-ready") expect(record(current, ".owner").process.namespaces).toEqual(settledNamespaces);
    else expect(() => record(current, ".owner")).toThrow();
  });
});
