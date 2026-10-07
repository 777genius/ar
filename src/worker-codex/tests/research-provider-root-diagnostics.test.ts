import { host, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { researchRead } from "../research-launch-files";
import { runResearchProviderService } from "../research-provider-service";
import * as roots from "../research-provider-root";
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
        const read = fs.readFileSync;
        vi.spyOn(fs, "readFileSync").mockImplementation(((path: string, options: never) =>
          path === "/proc/self/mountinfo" ? "TEST-private-mount-path" : read(path, options)) as typeof fs.readFileSync);
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
