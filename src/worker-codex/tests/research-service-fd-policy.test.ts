import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import * as fdObservation from "../../provider-codex/app-server/adapters/hosted-fd-observation";
import { trustedResearchProviderLaunch, trustedResearchRuntimeLaunch } from "../trusted-custody-systemd-launch";
import { prepareResearchProviderRoot } from "../research-provider-root";
import { researchHash } from "../research-launch-files";
import { prepareHelper } from "./research-provider-service-fixture";

let previousExitCode: typeof process.exitCode;
beforeEach(() => { previousExitCode = process.exitCode; setupResearchFixture(); });
afterEach(() => { vi.useRealTimers(); process.exitCode = previousExitCode; cleanupResearchFixture(); });

describe("research service FD filter contract", () => {
  // PID1 creates each service independently; parent filters cannot supply this policy.
  it.each(["runtime", "provider"] as const)("fixes %s filters without installed-profile authority", role => {
    const current = prepareHelper();
    const root = prepareResearchProviderRoot(current.spec, current.provider, current.home);
    const profile = vi.spyOn(fdObservation, "readHostedFdProfile").mockImplementation(() => {
      throw new Error("TEST research recipe must not inspect optional hosted FD admission");
    });
    try {
      const launch = role === "runtime"
        ? trustedResearchRuntimeLaunch(current.spec, researchHash(current.bytes))
        : trustedResearchProviderLaunch(current.spec, current.provider, current.home, root);
      const boundary = launch.args.indexOf("--"), options = launch.args.slice(0, boundary);
      expect(launch.command).toBe("/usr/bin/systemd-run");
      expect(boundary).toBeGreaterThan(0);
      expect(options.filter(arg => arg.startsWith("--property=SystemCallFilter="))).toEqual([
        "--property=SystemCallFilter=~io_uring_setup:ENOSYS io_uring_enter:ENOSYS io_uring_register:ENOSYS",
        ...(role === "provider" ? ["--property=SystemCallFilter=~@raw-io @module"] : []),
      ]);
      expect(options.filter(arg => arg.startsWith("--property=SystemCallArchitectures="))).toEqual(["--property=SystemCallArchitectures=native"]);
      expect([...new Set(options.filter(arg => arg.startsWith("--property=NoNewPrivileges=")))]).toEqual(["--property=NoNewPrivileges=yes"]);
      expect(options).toContain("--expand-environment=no");
      expect(options.filter(arg => arg.startsWith("--property=FileDescriptorStoreMax="))).toEqual(["--property=FileDescriptorStoreMax=0"]);
      expect(options.filter(arg => arg.startsWith("--property=PassEnvironment="))).toEqual(["--property=PassEnvironment="]);
      expect(options.filter(arg => arg.startsWith("--property=UnsetEnvironment="))).toEqual([
        "--property=UnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_V8_COVERAGE NODE_EXTRA_CA_CERTS NODE_REDIRECT_WARNINGS OPENSSL_CONF OPENSSL_MODULES LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT GCONV_PATH LOCPATH GLIBC_TUNABLES",
      ]);
      expect(options.some(arg => /^--(?:setenv=|property=Environment(?:Files)?=)/.test(arg))).toBe(false);
      expect(profile).not.toHaveBeenCalled();
    } finally { profile.mockRestore(); }
  });
});

