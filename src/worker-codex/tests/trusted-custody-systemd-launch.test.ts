import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { TrustedCustodyLaunchRole, trustedCustodySystemdLaunch } from "../trusted-custody-systemd-launch";

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
