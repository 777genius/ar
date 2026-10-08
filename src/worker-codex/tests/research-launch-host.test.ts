import { cleanupResearchFixture, host, local, request, setupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { researchProcessIdentity, researchUnitFromCurrentProcess } from "../research-launch-host";
import { admitResearchRuntime, assertResearchStartMaterial, bindResearchRuntime, captureResearchRuntime, researchCurrentStart } from "../research-launch-admission";
import { grantResearchLaunch, startResearchLaunch } from "../research-launch-owner";
import { researchHash, researchRead } from "../research-launch-files";
import * as files from "../research-launch-files";
import * as materialHost from "../research-launch-host";
import { normalizeResearchMaterialFailure, ResearchMaterialRole as R, ResearchLaunchCause as C, ResearchLaunchDiagnostic as D } from "../research-launch-diagnostics";
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

describe("private material role at the existing byte guards", () => {
  it.each([R.RuntimeArtifact, R.NodeExecutable, R.CodexExecutable])("retains an actual cached file deadline and short-circuit at %s", role => {
    const current = researchCurrentStart(start().jobId), spec = current.spec, order: R[] = [];
    let original: unknown, observed: unknown, clock = 0;
    const artifact = files.researchArtifactDigest, executable = materialHost.researchExecutableDigest, open = fs.openSync;
    vi.spyOn(files, "researchArtifactDigest").mockImplementation(path => { order.push(R.RuntimeArtifact);
      try { return artifact(path); } catch (error) { original = error; throw error; } });
    vi.spyOn(materialHost, "researchExecutableDigest").mockImplementation(path => { order.push(path === process.execPath ? R.NodeExecutable : R.CodexExecutable);
      try { return executable(path); } catch (error) { original = error; throw error; } });
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(fs, "openSync").mockImplementation(((path, flags, mode) => {
      const fd = open(path, flags, mode);
      if (role === R.RuntimeArtifact ? typeof path === "string" && path.startsWith(spec.runtimeDirectory + "/")
        : path === (role === R.NodeExecutable ? process.execPath : spec.request.codexBinaryPath)) clock = files.researchByteValidationTimeoutMs + 1;
      return fd;
    }) as typeof fs.openSync);
    const reads = vi.spyOn(fs, "readSync");
    try { assertResearchStartMaterial(spec); } catch (error) { observed = error; }
    expect(original).toBeDefined(); expect(observed === original).toBe(true);
    expect(normalizeResearchMaterialFailure(observed)).toEqual({ legacyCode: 0, cause: C.FileDeadline, diagnostic: D.ResearchAdmission, materialRole: role });
    expect(order).toEqual([R.RuntimeArtifact, R.NodeExecutable, R.CodexExecutable].slice(0, [R.RuntimeArtifact, R.NodeExecutable, R.CodexExecutable].indexOf(role) + 1));
    expect(reads).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    expect(JSON.stringify(normalizeResearchMaterialFailure(observed))).not.toContain(spec.runtimeDirectory);
  });
  it("retains original order and rejects digest mismatches in their precise scope", () => {
    const spec = researchCurrentStart(start().jobId).spec, artifact = vi.spyOn(files, "researchArtifactDigest"), executable = vi.spyOn(materialHost, "researchExecutableDigest");
    expect(() => assertResearchStartMaterial(spec)).not.toThrow(); expect(artifact).toHaveBeenCalledTimes(1);
    expect(executable.mock.calls.map(call => call[0])).toEqual([process.execPath, spec.request.codexBinaryPath]);
    for (const [field, role, expectedCalls] of [["artifactSha256", R.RuntimeArtifact, 0], ["nodeSha256", R.NodeExecutable, 1], ["codexSha256", R.CodexExecutable, 2]] as const) {
      executable.mockClear(); artifact.mockClear(); let failure: unknown;
      const changed = { ...spec, [field]: (spec[field][0] === "0" ? "1" : "0") + spec[field].slice(1) };
      try { assertResearchStartMaterial(changed); } catch (error) { failure = error; }
      expect(normalizeResearchMaterialFailure(failure)).toEqual({ legacyCode: 0, cause: C.None, diagnostic: D.ResearchAdmission, materialRole: role });
      expect(artifact).toHaveBeenCalledTimes(1); expect(executable).toHaveBeenCalledTimes(expectedCalls);
    }
    executable.mockClear(); artifact.mockClear(); let failure: unknown;
    try { assertResearchStartMaterial({ ...spec, runtimeDirectory: "/TEST-private-invalid-runtime" }); } catch (error) { failure = error; }
    expect(normalizeResearchMaterialFailure(failure).materialRole).toBe(R.Unknown);
    expect(artifact).not.toHaveBeenCalled(); expect(executable).not.toHaveBeenCalled();
  });
});
