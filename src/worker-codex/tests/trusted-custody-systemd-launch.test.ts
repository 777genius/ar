import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { TrustedCustodyLaunchRole, trustedCustodySystemdLaunch, trustedOrdinaryInstallationSupervisorLaunch,
  trustedOrdinaryQualificationOuterLaunch, trustedOrdinaryQualificationWorkerLaunch } from "../trusted-custody-systemd-launch";

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
