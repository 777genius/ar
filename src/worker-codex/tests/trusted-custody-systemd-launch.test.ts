import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { TrustedCustodyLaunchRole, trustedCustodySystemdLaunch, trustedOrdinaryInstallationSupervisorLaunch,
  trustedOrdinaryQualificationOuterLaunch, trustedOrdinaryQualificationWorkerLaunch } from "../trusted-custody-systemd-launch";

const probes = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawnSync: probes.run }));
const complete = (stdout: string, status = 0, stderr = "") => ({ stdout, stderr, status, signal: null, error: undefined });
const old252 = () => probes.run.mockImplementation((_file: string, args: string[]) => args.includes("--help")
  ? complete("", 1, "/usr/bin/systemd-run: unrecognized option '--expand-environment=no'\n")
  : complete("systemd 252 (252.39-1~deb12u2)\n+PAM +AUDIT\n"));
beforeEach(() => { probes.run.mockReset(); probes.run.mockReturnValue(complete("  --expand-environment=BOOL\n")); });
const startId = "12345678-1234-1234-1234-123456789abc";
describe("trusted custody launch contract", () => {
  it.each([TrustedCustodyLaunchRole.Outer, TrustedCustodyLaunchRole.Ordinary])("fixes all service properties for %s", role => {
    const invocation = trustedCustodySystemdLaunch(role, startId, "/synthetic/workspace");
    expect(invocation.command).toBe("/usr/bin/systemd-run");
    expect(invocation.args.slice(0, 13)).toEqual(["--quiet", "--wait", "--pipe", "--collect",
      `--unit=subscription-runtime-${role}-${startId}.service`, "--service-type=exec",
      "--property=Slice=subscription-runtime-hosted.slice", "--property=KillMode=control-group",
      "--property=SendSIGKILL=yes", "--property=Delegate=no", "--working-directory=/synthetic/workspace",
      "--", process.execPath]);
    expect(invocation.args.slice(13)).toEqual(role === TrustedCustodyLaunchRole.Outer
      ? [fileURLToPath(new URL("../hosted-readonly-runtime-bootstrap.js", import.meta.url))]
      : [fileURLToPath(new URL("../hosted-readonly-host-launch-cli.js", import.meta.url)), "ordinary-bootstrap"]);
  });
  it("rejects an unknown role at runtime", () => {
    expect(() => trustedCustodySystemdLaunch("custom" as TrustedCustodyLaunchRole, startId, "/synthetic/workspace")).toThrow();
  });
  it.each(["../foreign", "--property=Environment=SECRET", "z".repeat(36)])("rejects invalid start identity %s", id => {
    expect(() => trustedCustodySystemdLaunch(TrustedCustodyLaunchRole.Outer, id, "/synthetic/workspace")).toThrow();
  });
  it.each(["relative", "/synthetic/workspace\n--property=Delegate=yes", "--unit=foreign.service"])("rejects cwd injection %s", cwd => {
    expect(() => trustedCustodySystemdLaunch(TrustedCustodyLaunchRole.Outer, startId, cwd)).toThrow();
  });
});

// These negative recipe contracts catch a new owner boundary admitting injected
// identity/path or expired work; they construct no privileged qualification.
describe("fixed ordinary installation recipes", () => {
  const rootfs = "/srv/workers/TEST-ordinary-rootfs";
  it.each(["../foreign", "--unit=foreign.service", "12345678-1234-1234-1234-123456789abc\n--property=Delegate=yes"])("refuses injected identity %s", id => {
    expect(() => trustedOrdinaryInstallationSupervisorLaunch(id, 10_000, 20_000)).toThrow();
    expect(() => trustedOrdinaryQualificationOuterLaunch(id, rootfs, 10_000, 1_000)).toThrow();
    expect(() => trustedOrdinaryQualificationWorkerLaunch(id, 10_000, 1_000)).toThrow();
  });
  it.each(["/tmp/TEST-rootfs", "/srv/workers/../foreign", "/srv/workers/TEST-rootfs\n--property=Delegate=yes"])("refuses non-scratch or injected rootfs %s", path => {
    expect(() => trustedOrdinaryQualificationOuterLaunch(startId, path, 10_000, 1_000)).toThrow();
  });
  it.each([0, -1, Number.NaN])("refuses exhausted or invalid original work %s", workMs => {
    expect(() => trustedOrdinaryInstallationSupervisorLaunch(startId, workMs, 20_000)).toThrow();
    expect(() => trustedOrdinaryQualificationOuterLaunch(startId, rootfs, workMs, 1_000)).toThrow();
    expect(() => trustedOrdinaryQualificationWorkerLaunch(startId, workMs, 1_000)).toThrow();
  });
  it.each([0, -1, 30_001])("refuses invalid original stop allowance %s", stopMs => {
    expect(() => trustedOrdinaryQualificationOuterLaunch(startId, rootfs, 10_000, stopMs)).toThrow();
    expect(() => trustedOrdinaryQualificationWorkerLaunch(startId, 10_000, stopMs)).toThrow();
  });
});


describe("original ordinary literal argv compatibility", () => {
  const recipes = [
    () => trustedOrdinaryInstallationSupervisorLaunch(startId, 10_000, 20_000),
    () => trustedOrdinaryQualificationOuterLaunch(startId, "/srv/workers/TEST-ordinary-rootfs", 10_000, 1_000),
    () => trustedOrdinaryQualificationWorkerLaunch(startId, 10_000, 1_000),
  ];
  it.each([0, 1, 2])("retains exact modern recipe and explicit expansion veto for role %s", ordinal => {
    const plan = recipes[ordinal]!();
    expect(plan.args).toContain("--expand-environment=no");
    expect(plan.args).toContain("--property=Delegate=no");
    expect(plan.args).toContain("--property=KillMode=control-group");
    expect(probes.run).toHaveBeenCalledOnce();
    expect(probes.run.mock.calls[0]![0]).toBe("/usr/bin/systemd-run");
    expect(probes.run.mock.calls[0]![1]).toEqual(["--expand-environment=no", "--help"]);
    expect(probes.run.mock.calls[0]![2]).toMatchObject({ timeout: 2000, maxBuffer: 32768, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
  });
  it.each([0, 1, 2])("admits stock252 only with dollar-free exact unchanged operands/properties for role %s", ordinal => {
    const modern = recipes[ordinal]!(); probes.run.mockClear(); old252(); const legacy = recipes[ordinal]!();
    expect(legacy.command).toBe(modern.command);
    expect(legacy.args).toEqual(modern.args.filter(arg => arg !== "--expand-environment=no"));
    expect(legacy.args.slice(legacy.args.indexOf("--") + 1).every(arg => !arg.includes("$"))).toBe(true);
    expect(probes.run.mock.calls.map(call => call[1])).toEqual([["--expand-environment=no", "--help"], ["--version"]]);
  });
  it.each(["$USER", "${USER}", "$$", "literal$tail"])("rejects legacy command expansion operand %s before original launch", operand => {
    old252(); const before = process.execPath;
    try { Object.defineProperty(process, "execPath", { value: "/synthetic/" + operand, configurable: true });
      expect(() => recipes[0]!()).toThrow("ordinary_launcher_qualification_held");
      expect(() => recipes[2]!()).toThrow("ordinary_launcher_qualification_held");
      expect(probes.run.mock.calls.every(call => JSON.stringify(call[1]) === '["--expand-environment=no","--help"]' || JSON.stringify(call[1]) === '["--version"]')).toBe(true);
    } finally { Object.defineProperty(process, "execPath", { value: before, configurable: true }); }
  });
  it("retains literal dollar operands on the modern explicit-veto route", () => {
    const before = process.execPath;
    try { Object.defineProperty(process, "execPath", { value: "/synthetic/$USER", configurable: true });
      const plan = recipes[2]!(); expect(plan.args).toContain("--expand-environment=no");
      expect(plan.args.slice(plan.args.indexOf("--") + 1)[0]).toBe("/synthetic/$USER");
    } finally { Object.defineProperty(process, "execPath", { value: before, configurable: true }); }
  });
  it("keeps rootfs dollar injection rejected before capability reads", () => {
    old252(); expect(() => trustedOrdinaryQualificationOuterLaunch(startId, "/srv/workers/$USER", 10_000, 1000)).toThrow();
    expect(probes.run).not.toHaveBeenCalled();
  });
  it.each(["systemd 251\n", "systemd 253\n", "systemd UNKNOWN\n"])("refuses an unsupported unqualified version %s", version => {
    old252(); probes.run.mockImplementationOnce(() => complete("", 1, "/usr/bin/systemd-run: unrecognized option '--expand-environment=no'\n"));
    probes.run.mockImplementationOnce(() => complete(version)); expect(() => recipes[1]!()).toThrow("ordinary_launcher_qualification_held");
  });
  it.each([complete("help without required capability"), complete("", 1, "foreign failure\n"), { ...complete(""), signal: "SIGTERM" }, { ...complete(""), error: new Error("TEST private probe failure") }])("refuses ambiguous capability evidence", result => {
    probes.run.mockReturnValue(result); expect(() => recipes[1]!()).toThrow("ordinary_launcher_qualification_held");
  });
});
