import { cleanupResearchFixture, host, local, request, setupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { researchProcessIdentity, researchUnitFromCurrentProcess } from "../research-launch-host";
import { admitResearchRuntime, bindResearchRuntime, captureResearchRuntime, researchCurrentStart } from "../research-launch-admission";
import { grantResearchLaunch, startResearchLaunch } from "../research-launch-owner";
import { researchHash, researchRead } from "../research-launch-files";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";

beforeEach(setupResearchFixture);
afterEach(cleanupResearchFixture);

function kernelCgroupText(text: string): void {
  const read = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation(((path, options) =>
    typeof path === "string" && /^\/proc\/(?:self|[1-9][0-9]*)\/cgroup$/.test(path)
      ? text : read(path, options)) as typeof fs.readFileSync);
}
function start() {
  const r = request();
  grantResearchLaunch(r.jobId, r.jobRootDir, r.workspacePath);
  return startResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")));
}

describe("kernel cgroup membership at the research authority boundary", () => {
  it("extracts the reported nspawn leader's unified membership independently of its named hierarchy", () => {
    kernelCgroupText("1:name=systemd:/system.slice/subscription-runtime-clean-native-capsule-TEST-20261003-01.service/payload/init.scope\n" +
      "0::/system.slice/subscription-runtime-clean-native-capsule-TEST-20261003-01.service/payload\n");
    expect(researchProcessIdentity().controlGroup).toBe("/system.slice/subscription-runtime-clean-native-capsule-TEST-20261003-01.service/payload");
    expect(researchUnitFromCurrentProcess()).toBeNull();
  });

  it.each(["unified-only", "named-first", "controllers-last"])("binds and retains admission with %s membership", shape => {
    const current = start(), group = `/system.slice/${current.unit}`;
    const unified = `0::${group}\n`;
    kernelCgroupText(shape === "named-first" ? `1:name=systemd:${group}/init.scope\n${unified}`
      : shape === "controllers-last" ? `${unified}2:cpu,cpuacct:/\n1:name=systemd:/\n` : unified);
    bindResearchRuntime(current.jobId, current.startId);
    const { directory } = researchCurrentStart(current.jobId);
    expect(JSON.parse(researchRead(join(directory, "binding.json")).toString())).toMatchObject({
      process: { controlGroup: group }, service: { controlGroup: group, mainPid: process.pid },
    });
    expect(researchUnitFromCurrentProcess()).toBe(current.unit);
    expect(admitResearchRuntime(request())).toBe(CodexProviderEgressProfileId.FullInternetV1);
    expect(() => captureResearchRuntime(request()).assertAuthorityCurrent()).not.toThrow();
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });

  it.each(["/", "/../../../user.slice/TEST-session.scope", "/system.slice/foreign.service"])(
    "refuses v2 ownership at %s despite an approved-looking named v1 row", group => {
      const current = start();
      kernelCgroupText(`1:name=systemd:/system.slice/${current.unit}\n0::${group}\n`);
      expect(researchProcessIdentity().controlGroup).toBe(group);
      expect(researchUnitFromCurrentProcess()).toBeNull();
      expect(() => bindResearchRuntime(current.jobId, current.startId)).toThrow("hosted_research_launch_denied");
      expect(fs.existsSync(local(join(researchCurrentStart(current.jobId).directory, "binding.json")))).toBe(false);
      expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    });

  it.each([
    ["duplicate-identical", (group: string) => `0::${group}\n0::${group}\n`],
    ["duplicate-conflicting", (group: string) => `0::${group}\n0::/\n`],
    ["duplicate-reversed", (group: string) => `0::/\n0::${group}\n`],
    ["no-v2", (group: string) => `1:name=systemd:${group}\n`],
    ["empty", () => ""],
    ["missing-path", () => "0::\n"],
    ["relative-path", () => "0::relative\n"],
    ["v2-controllers", (group: string) => `0:name=systemd:${group}\n`],
    ["malformed-extra", (group: string) => `1:name=systemd\n0::${group}\n`],
    ["empty-v1-controllers", (group: string) => `1::/\n0::${group}\n`],
    ["malformed-controller-list", (group: string) => `1:cpu,,cpuacct:/\n0::${group}\n`],
    ["blank-row", (group: string) => `0::${group}\n\n`],
    ["carriage-return", (group: string) => `0::${group}\r\n`],
    ["nul-path", (group: string) => `0::${group}\0\n`],
  ] as const)("fails closed on %s kernel text", (_fault, text) => {
    const current = start();
    kernelCgroupText(text(`/system.slice/${current.unit}`));
    expect(() => researchProcessIdentity()).toThrow("hosted_research_launch_denied");
    expect(researchUnitFromCurrentProcess()).toBeNull();
    expect(() => bindResearchRuntime(current.jobId, current.startId)).toThrow("hosted_research_launch_denied");
    expect(fs.existsSync(local(join(researchCurrentStart(current.jobId).directory, "binding.json")))).toBe(false);
    expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });
});
