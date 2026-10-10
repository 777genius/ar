import { host, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as processes from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { copyResearchHostCommandFailure, researchHostCommandFailure, researchRead,
  ResearchHostCommandOperation as Operation, ResearchHostCommandUnitRole as Role } from "../research-launch-files";
import { researchCommand } from "../research-launch-host";
import { runResearchProviderService } from "../research-provider-service";
import { prepareHelper } from "./research-provider-service-fixture";

const streams = new Set<PassThrough>();
beforeEach(setupResearchFixture);
afterEach(() => { for (const stream of streams) { stream.unpipe(); stream.destroy(); } streams.clear(); vi.useRealTimers(); cleanupResearchFixture(); });
function proxyFixture() {
  const proxy = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kill: vi.fn(() => true) });
  const forwarded: Buffer[] = [];
  for (const stream of [proxy.stdin, proxy.stdout, proxy.stderr]) streams.add(stream);
  proxy.stdin.on("data", chunk => forwarded.push(Buffer.from(chunk)));
  host.spawn.mockReturnValue(proxy);
  return { proxy, forwarded };
}
const record = (current: ReturnType<typeof prepareHelper>, suffix: string) =>
  JSON.parse(researchRead(join(current.directory, "providers", current.provider + suffix + ".json")).toString());

describe("closed research control-command failure diagnostics", () => {
  // Red if the first ready guard discards command metadata, the owner path
  // misclassifies a provider unit, or any failure releases held bootstrap.
  it.each([Role.Runtime, Role.Provider])("retains the %s show timeout before owner or bootstrap", async unitRole => {
    const current = prepareHelper(), { proxy, forwarded } = proxyFixture(), original = processes.spawnSync;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const outcome = runResearchProviderService(current.jobId, current.provider, current.home).then(() => undefined, error => error as Error);
    vi.spyOn(processes, "spawnSync").mockImplementation(((command: string, args: string[], options: never) => {
      if (command === "/usr/bin/systemctl" && args[0] === "show" && args[1] === (unitRole === Role.Runtime ? current.unit : current.provider))
        return { status: null, error: Object.assign(new Error("TEST-private-command-detail"), { code: "ETIMEDOUT" }), stdout: "TEST-private-output", stderr: "TEST-private-stderr" };
      return original(command, args, options);
    }) as typeof processes.spawnSync);
    proxy.stdout.write("subscription-runtime-research-provider-ready-v1\n");
    await vi.advanceTimersByTimeAsync(2_600);
    const error = await outcome, hostCommand = researchHostCommandFailure(error);
    expect(error?.message).toBe("hosted_research_launch_denied"); expect(error?.cause).toBe("host-command-timeout");
    expect(hostCommand).toEqual({ operation: Operation.SystemctlShow, unitRole, elapsedMs: expect.any(Number) });
    expect(Object.isFrozen(hostCommand)).toBe(true);
    expect(hostCommand!.elapsedMs).toBeGreaterThanOrEqual(0); expect(hostCommand!.elapsedMs).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    const bytes = researchRead(join(current.directory, "provider-failure.json")).toString();
    expect(JSON.parse(bytes)).toMatchObject({ phase: "ready-and-owner", observation: "host-command-timeout", check: "researchCommand", hostCommand });
    expect(Object.keys(JSON.parse(bytes).hostCommand).sort()).toEqual(["elapsedMs", "operation", "unitRole"]);
    expect(bytes).not.toContain("TEST-private"); expect(bytes).not.toContain(current.home);
    expect(() => record(current, ".owner")).toThrow(); expect(record(current, ".submission").state).toBe("pending");
    expect(host.authReads).toBe(0); expect(current.forward).not.toHaveBeenCalled(); expect(forwarded).toHaveLength(0);
  });
  // Red if arbitrary Error properties/accessors synthesize authentic metadata
  // or are invoked by the ready-refusal copy or persisted failure receipt.
  it.each(["data", "getter"])("ignores forged diagnostic %s on the first ready refusal", async kind => {
    const current = prepareHelper(), { proxy, forwarded } = proxyFixture(), original = processes.spawnSync;
    const forged = new Error("TEST-private-forged-error"), getter = vi.fn(() => { throw Error("TEST-private-getter"); });
    Object.defineProperty(forged, "hostCommand", kind === "getter" ? { get: getter }
      : { value: { operation: Operation.SystemctlShow, unitRole: Role.Runtime, elapsedMs: 7, secret: "TEST-private-data" } });
    const replacement = new Error("TEST-replacement"); copyResearchHostCommandFailure(forged, replacement);
    expect(researchHostCommandFailure(replacement)).toBeUndefined();
    const outcome = runResearchProviderService(current.jobId, current.provider, current.home).then(() => undefined, error => error as Error);
    vi.spyOn(processes, "spawnSync").mockImplementation(((command: string, args: string[], options: never) => {
      if (command === "/usr/bin/systemctl" && args[0] === "show" && args[1] === current.unit) throw forged;
      return original(command, args, options);
    }) as typeof processes.spawnSync);
    proxy.stdout.write("subscription-runtime-research-provider-ready-v1\n");
    expect(researchHostCommandFailure(await outcome)).toBeUndefined(); expect(getter).not.toHaveBeenCalled();
    const bytes = researchRead(join(current.directory, "provider-failure.json")).toString();
    expect(JSON.parse(bytes).hostCommand).toBeUndefined(); expect(bytes).not.toContain("TEST-private");
    expect(() => record(current, ".owner")).toThrow(); expect(record(current, ".submission").state).toBe("pending");
    expect(host.authReads).toBe(0); expect(current.forward).not.toHaveBeenCalled(); expect(forwarded).toHaveLength(0);
  });
  // Red if classifications scan arbitrary argv, timing failure replaces a
  // refusal, or diagnostics change the existing command timeout/environment.
  const unit = `subscription-runtime-research-${"a".repeat(36)}.service`, provider = `subscription-runtime-research-provider-${"a".repeat(36)}.service`;
  it.each([
    ["/usr/bin/systemctl", ["list-jobs", "--no-legend", "--no-pager"], Operation.SystemctlListJobs, Role.Unknown, 30_000],
    ["/usr/bin/systemd-run", ["--quiet", `--unit=${unit}`], Operation.SystemdRun, Role.Runtime, 330_000],
    ["/usr/bin/systemd-run", ["--quiet", "--wait", "--pipe", "--collect", `--unit=${provider}`], Operation.SystemdRun, Role.Provider, 60_000],
    ["/usr/bin/systemd-run", ["--quiet", "TEST-private-argument", `--unit=${provider}`], Operation.SystemdRun, Role.Unknown, 60_000],
    ["/usr/bin/systemctl", ["show", "TEST-private-unit", unit], Operation.SystemctlShow, Role.Unknown, 60_000],
    ["/usr/bin/findmnt", ["show", unit], Operation.Unknown, Role.Unknown, 15_000],
  ] as const)("closes failed %s classification for %j", (command, args, operation, unitRole, timeout) => {
    const execute = vi.spyOn(processes, "spawnSync").mockReturnValue({ status: 1, stdout: "", stderr: "TEST-private-stderr" } as ReturnType<typeof processes.spawnSync>);
    vi.spyOn(performance, "now").mockImplementation(() => { throw Error("TEST-clock-unavailable"); });
    let error: unknown; try { researchCommand(command, args); } catch (failure) { error = failure; }
    expect((error as Error).message).toBe("hosted_research_launch_denied"); expect((error as Error).cause).toBe("host-command-failed");
    expect(researchHostCommandFailure(error)).toEqual({ operation, unitRole, elapsedMs: 0 });
    expect(execute).toHaveBeenCalledWith(command, [...args], expect.objectContaining({ timeout, env: { PATH: "/usr/bin:/bin", LANG: "C" } }));
  });
  it("allows the measured slow runtime read while keeping list-jobs bounded and timeout nonretrying", () => {
    const execute = vi.spyOn(processes, "spawnSync").mockReturnValue({ status: 0, stdout: "TEST-read" } as ReturnType<typeof processes.spawnSync>);
    expect(researchCommand("/usr/bin/systemctl", ["show", unit])).toBe("TEST-read");
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ timeout: 60_000 });
    execute.mockReturnValueOnce({ pid: 0, output: [], stderr: "", signal: null, status: null, stdout: "", error: Object.assign(new Error("TEST-private"), { code: "ETIMEDOUT" }) } as ReturnType<typeof processes.spawnSync>);
    let failure: unknown; try { researchCommand("/usr/bin/systemctl", ["list-jobs"]); } catch (error) { failure = error; }
    expect(execute.mock.calls[1]?.[2]).toMatchObject({ timeout: 30_000 });
    expect((failure as Error).cause).toBe("host-command-timeout");
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it.each([[3, 0], [NaN, 0], [Infinity, 0], [Number.MAX_VALUE, Number.MAX_SAFE_INTEGER]] as const)(
    "bounds an elapsed observation ending at %s", (ended, elapsedMs) => {
      vi.spyOn(processes, "spawnSync").mockReturnValue({ status: 1, stdout: "" } as ReturnType<typeof processes.spawnSync>);
      vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(ended);
      let error: unknown; try { researchCommand("/usr/bin/systemctl", ["show", unit]); } catch (failure) { error = failure; }
      expect((error as Error).cause).toBe("host-command-failed");
      expect(researchHostCommandFailure(error)).toEqual({ operation: Operation.SystemctlShow, unitRole: Role.Runtime, elapsedMs });
    });
  it("keeps command results and native throws unchanged when diagnostic timing fails", () => {
    const execute = vi.spyOn(processes, "spawnSync").mockReturnValue({ status: 0, stdout: "TEST-success" } as ReturnType<typeof processes.spawnSync>);
    const now = vi.spyOn(performance, "now").mockImplementation(() => { throw Error("TEST-clock-unavailable"); });
    expect(researchCommand("/usr/bin/systemctl", ["show", unit])).toBe("TEST-success");
    const original = Object.freeze(new Error("TEST-native-spawn-error")); execute.mockImplementationOnce(() => { throw original; });
    let failure: unknown; try { researchCommand("/usr/bin/systemctl", ["show", unit]); } catch (error) { failure = error; }
    expect(failure === original).toBe(true); expect(researchHostCommandFailure(failure)).toBeUndefined();
    execute.mockReturnValueOnce({ status: 1, stdout: "" } as ReturnType<typeof processes.spawnSync>); now.mockReturnValueOnce(10);
    try { researchCommand("/usr/bin/systemctl", ["show", unit]); } catch (error) { failure = error; }
    expect(researchHostCommandFailure(failure)).toEqual({ operation: Operation.SystemctlShow, unitRole: Role.Runtime, elapsedMs: 0 });
  });
});
