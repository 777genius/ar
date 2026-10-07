import { host, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { researchHash, researchRead } from "../research-launch-files";
import * as files from "../research-launch-files";
import { signalResearchProvider } from "../research-launch-lifecycle";
import { runResearchProviderService } from "../research-provider-service";
import * as roots from "../research-provider-root";
import * as mounts from "../host-scratch-mount";
import { prepareHelper } from "./research-provider-service-fixture";

beforeEach(setupResearchFixture);
afterEach(cleanupResearchFixture);
const record = (current: ReturnType<typeof prepareHelper>, suffix: string) =>
  JSON.parse(researchRead(join(current.directory, "providers", current.provider + suffix + ".json")).toString());

describe("private identity-bound root diagnostics", () => {
  // A real root guard must identify its finite check; the selected private
  // account records and ownership paths must never become diagnostic output.
  it.each(["owner", "accounts", "mount-table"])("classifies the root %s guard without admitting the provider", async fault => {
    const current = prepareHelper();
    const check = fault === "owner" ? "observe" : fault === "accounts" ? "validateAccounts" : "mountTable";
    const prepare = roots.prepareResearchProviderRoot;
    // Activate the fault only at the real root boundary; /usr also participates
    // in runtime capture custody and must remain valid until service-plan.
    vi.spyOn(roots, "prepareResearchProviderRoot").mockImplementationOnce((...args) => {
      if (fault === "owner") host.foreign.add("/usr");
      else if (fault === "accounts") fs.writeFileSync("/etc/group", "TEST-private-account:TEST-private-password:0:\n");
      else {
        vi.spyOn(mounts, "readKernelMountTable").mockReturnValue("TEST-private-mount-path");
      }
      return prepare(...args);
    });
    await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow("hosted_research_launch_denied");
    expect(JSON.parse(researchRead(join(current.directory, "provider-failure.json")).toString())).toEqual({
      schemaVersion: 1, unit: current.provider, phase: "service-plan", check: `research-provider-root:${check}`,
    });
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    expect(() => record(current, ".submission")).toThrow();
  });
  it("retains the inner root check for a native host failure with hostile error accessors", async () => {
    const current = prepareHelper(), error = new Error("TEST-private-native-error");
    const getter = vi.fn(() => { throw new Error("TEST-private-accessor"); });
    Object.defineProperties(error, { stack: { get: getter }, cause: { get: getter } });
    const unexpected = (): never => { throw new Error("TEST-unexpected-root-port-operation"); };
    const rootHost: roots.ResearchProviderRootHost = {
      info: path => { if (path === "/usr") throw error; return unexpected(); },
      read: path => fs.readFileSync(path, "utf8"),
      canonical: unexpected, link: unexpected, entries: unexpected,
      mkdir: unexpected, symlink: unexpected, file: unexpected,
      regular: unexpected, snapshot: unexpected, publish: unexpected, record: unexpected,
    };
    const prepare = roots.prepareResearchProviderRoot;
    // nativeHost retains info at module initialization; use the explicit TEST
    // port so the fault belongs to the real root walk, before every root effect.
    vi.spyOn(roots, "prepareResearchProviderRoot").mockImplementationOnce((value, unit, home, scratchHost) =>
      prepare(value, unit, home, scratchHost, rootHost));
    // Observe the runtime before giving a hostile Error to a rejection matcher,
    // which may inspect its stack when attaching assertion context.
    let observed: unknown;
    try { await runResearchProviderService(current.jobId, current.provider, current.home); }
    catch (failure) { observed = failure; }
    expect(getter).not.toHaveBeenCalled();
    expect(observed === error).toBe(true);
    expect(JSON.parse(researchRead(join(current.directory, "provider-failure.json")).toString())).toEqual({
      schemaVersion: 1, unit: current.provider, phase: "service-plan", check: "research-provider-root:observe",
    });
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    expect(() => record(current, ".submission")).toThrow();
  });
  it.each(["forged-frame", "hostile-accessors"])(
    "preserves an unobserved %s failure without emitting private data or calling getters", async fault => {
      const current = prepareHelper(), error = new Error("TEST-private-message-credential");
      const getter = vi.fn(() => { throw new Error("TEST-private-getter"); });
      // Even an exact internal frame cannot forge the root-owned observation.
      error.stack = `Error: TEST-private-message-credential\n    at observe (${fileURLToPath(new URL("../research-provider-root.ts", import.meta.url))}:1:2)`;
      if (fault === "hostile-accessors") Object.defineProperties(error, { stack: { get: getter }, cause: { get: getter } });
      vi.spyOn(roots, "prepareResearchProviderRoot").mockImplementationOnce(() => { throw error; });
      await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toBe(error);
      expect(getter).not.toHaveBeenCalled();
      expect(JSON.parse(researchRead(join(current.directory, "provider-failure.json")).toString())).toEqual({
        schemaVersion: 1, unit: current.provider, phase: "service-plan",
      });
      expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
      expect(() => record(current, ".submission")).toThrow();
    });
});

describe("private synchronous root timing", () => {
  it("counts the nested prepare assertion without summing inclusive labels", () => {
    const current = prepareHelper(); let rows: readonly roots.ResearchProviderRootTiming[] = [];
    const plan = roots.captureResearchProviderRootTiming(() =>
      roots.prepareResearchProviderRoot(current.spec, current.provider, current.home), value => { rows = value; });
    expect(plan.fixedRootDirectory).toBeDefined();
    expect(rows.map(row => row.check)).toEqual(Object.values(roots.ResearchProviderRootCheck));
    expect(rows.find(row => row.check === roots.ResearchProviderRootCheck.Prepare)?.count).toBe(1);
    expect(rows.find(row => row.check === roots.ResearchProviderRootCheck.Assert)?.count).toBe(1);
    expect(rows.find(row => row.check === roots.ResearchProviderRootCheck.Snapshot)?.count).toBe(2);
    for (const row of rows) { expect(Number.isSafeInteger(row.count)).toBe(true); expect(row.count).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(row.inclusiveElapsedMs)).toBe(true); expect(row.inclusiveElapsedMs).toBeGreaterThanOrEqual(0); }
  });
  it("restores an outer collector after a nested capture and preserves hostile failures", () => {
    const current = prepareHelper(), getter = vi.fn(() => { throw Error("TEST-private-getter"); });
    const frozen = Object.freeze(Error("TEST-private-error")), proxy = new Proxy(frozen, { get: getter });
    for (const error of [frozen, proxy, "TEST-private-primitive", undefined]) {
      let observed: unknown, outer: readonly roots.ResearchProviderRootTiming[] = [], inner: readonly roots.ResearchProviderRootTiming[] = [];
      const rootHost: roots.ResearchProviderRootHost = { info: () => { throw error; }, read: path => fs.readFileSync(path, "utf8"),
        canonical: getter, link: getter, entries: getter, mkdir: getter, symlink: getter, file: getter, regular: getter, snapshot: getter, publish: getter, record: getter };
      try { roots.captureResearchProviderRootTiming(() => {
        try { roots.captureResearchProviderRootTiming(() => roots.prepareResearchProviderRoot(current.spec, current.provider, current.home, undefined, rootHost),
          value => { inner = value; throw Error("TEST-private-observer"); }); } catch { /* Exercise parent restoration. */ }
        return roots.prepareResearchProviderRoot(current.spec, current.provider, current.home, undefined, rootHost);
      }, value => { outer = value; throw Error("TEST-private-observer"); }); } catch (failure) { observed = failure; }
      expect(observed === error).toBe(true);
      for (const rows of [inner, outer]) expect(rows.find(row => row.check === roots.ResearchProviderRootCheck.Prepare)?.count).toBe(1);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(roots.captureResearchProviderRootTiming(() => 7, () => { throw Error("TEST-observer"); })).toBe(7);
  });
  it("publishes all three bounded scopes once before spawn, with no private content", async () => {
    const current = prepareHelper(), error = Object.freeze(Error("TEST-private-spawn-error"));
    const publish = files.researchPublish, attempts: string[] = [];
    vi.spyOn(files, "researchPublish").mockImplementation((path, value, exclusive) => { if (path.endsWith("/provider-root-timing.json")) attempts.push(path); publish(path, value, exclusive); });
    host.spawn.mockImplementationOnce(() => {
      const text = researchRead(join(current.directory, "provider-root-timing.json")).toString(), receipt = JSON.parse(text);
      expect(receipt).toMatchObject({ schemaVersion: 1, unit: current.provider, specSha256: researchHash(current.bytes), artifactSha256: current.spec.artifactSha256, phase: "systemd-submission" });
      expect(Object.keys(receipt).sort()).toEqual(["artifactSha256", "phase", "schemaVersion", "scopes", "specSha256", "unit"]);
      expect(receipt.scopes.map((scope: { scope: string; outcome: string }) => [scope.scope, scope.outcome])).toEqual([
        ["prepare", "completed"], ["initial-launch", "completed"], ["submission-assert", "completed"]]);
      for (const scope of receipt.scopes) { expect(Object.keys(scope).sort()).toEqual(["checks", "elapsedMs", "outcome", "scope"]);
        for (const row of scope.checks) expect(Object.keys(row).sort()).toEqual(["check", "count", "inclusiveElapsedMs"]);
        expect(scope.checks.map((row: { check: string }) => row.check)).toEqual(Object.values(roots.ResearchProviderRootCheck));
        expect(Number.isFinite(scope.elapsedMs)).toBe(true); expect(scope.elapsedMs).toBeGreaterThanOrEqual(0); }
      expect(text).not.toContain(current.home); expect(text).not.toContain(current.spec.runtimeDirectory); expect(text).not.toContain(error.message);
      throw error;
    });
    let observed: unknown; try { await runResearchProviderService(current.jobId, current.provider, current.home); } catch (failure) { observed = failure; }
    expect(observed === error).toBe(true); expect(attempts).toHaveLength(1); expect(host.spawn).toHaveBeenCalledTimes(1); expect(host.authReads).toBe(0);
  });
  it("honors a cancellation fence written during the private timing publication", async () => {
    const current = prepareHelper(), publish = files.researchPublish, attempts = vi.fn();
    vi.spyOn(files, "researchPublish").mockImplementation((path, value, exclusive) => {
      publish(path, value, exclusive);
      if (path.endsWith("/provider-root-timing.json")) { attempts(); signalResearchProvider(current.directory, current.provider); }
    });
    await expect(runResearchProviderService(current.jobId, current.provider, current.home)).rejects.toThrow("hosted_research_launch_denied");
    const receipt = JSON.parse(researchRead(join(current.directory, "provider-root-timing.json")).toString());
    expect(receipt.scopes.map((scope: { scope: string; outcome: string }) => [scope.scope, scope.outcome])).toEqual([
      ["prepare", "completed"], ["initial-launch", "completed"], ["submission-assert", "completed"]]);
    expect(attempts).toHaveBeenCalledTimes(1); expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    expect(current.forward).not.toHaveBeenCalled();
  });
  it("attempts a failed receipt only once and preserves the service's original refusal", async () => {
    const current = prepareHelper(), error = Object.freeze(Error("TEST-private-original-error")), publish = files.researchPublish, attempts = vi.fn();
    vi.spyOn(roots, "prepareResearchProviderRoot").mockImplementationOnce(() => { throw error; });
    vi.spyOn(files, "researchPublish").mockImplementation((path, value, exclusive) => {
      if (path.endsWith("/provider-root-timing.json")) { attempts(value); throw Error("TEST-private-publish-error"); }
      publish(path, value, exclusive);
    });
    let observed: unknown; try { await runResearchProviderService(current.jobId, current.provider, current.home); } catch (failure) { observed = failure; }
    expect(observed === error).toBe(true); expect(attempts).toHaveBeenCalledTimes(1);
    expect(attempts.mock.calls[0]![0].scopes.map((scope: { scope: string; outcome: string }) => [scope.scope, scope.outcome])).toEqual([["prepare", "failed"]]);
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
});
