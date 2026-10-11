import { beforeEach, expect, it, vi } from "vitest";
import type { HostedActivationFence } from "../../provider-codex/app-server/adapters/hosted-process-activation";

// Synthetic OS/issuer facts stop before an entry is consumed. These regressions
// verify route selection and refusal, and grant no Native qualification.
const fixture = vi.hoisted(() => {
  const id = "22222222-2222-4222-8222-222222222222";
  const unit = `subscription-runtime-ordinary-${id}.service`;
  const group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`;
  const start = { startId: id, unit, controlGroup: group, jobId: "ordinary-job", installationId: "installation",
    bootId: "boot", supervisorId: "supervisor", activationGeneration: 7, creatorId: "ordinary-creator", originSha256: "origin", grantSha256: "grant",
    jobRootDir: "/srv/workers/jobs/ordinary-job", workspacePath: "/srv/workers/jobs/ordinary-job/workspace" };
  return { id, unit, group, start, cgroup: `0::${group}\n`, ordinary: vi.fn(), managed: vi.fn(),
    runtimeSession: vi.fn(), operatorSession: vi.fn(), runtime: vi.fn() };
});
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(),
  readFileSync: (path: string) => { if (path !== "/proc/self/cgroup") throw new Error("unexpected OS read"); return fixture.cgroup; },
}));
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation", () => ({
  assertHostedActivationFence: () => {}, assertHostedActivationOperator: () => {},
  decodeHostedActivationBytes: (bytes: Buffer) => JSON.parse(bytes.toString()),
}));
vi.mock("../../provider-codex/app-server/adapters/hosted-process-descriptors", () => ({ assertHostedProcessDescriptors: () => {} }));
vi.mock("../hosted-dependency-current-facts", () => ({
  collectCurrentHostedOrdinaryDependencyOrigin: (...args: unknown[]) => fixture.ordinary(...args),
}));
vi.mock("../hosted-managed-readonly-origin-collector", () => ({
  collectActualHostedManagedReadonlyOrigin: (...args: unknown[]) => fixture.managed(...args),
}));
vi.mock("@vioxen/subscription-runtime/worker-core", async original => ({
  ...await original<typeof import("@vioxen/subscription-runtime/worker-core")>(), parseHostedOrdinaryStart: () => fixture.start,
}));
vi.mock("../../provider-codex/app-server/adapters/hosted-dependency-workspace", async original => ({
  ...await original<typeof import("../../provider-codex/app-server/adapters/hosted-dependency-workspace")>(),
  readHostedDependencyBinding: () => ({ version: 2, installationId: fixture.start.installationId, runtimeSha: "runtime",
    workspace: { canonicalPath: fixture.start.workspacePath }, jobRootDir: fixture.start.jobRootDir, grantDigest: fixture.start.grantSha256 }),
}));
vi.mock("../hosted-readonly-inputs", async original => ({
  ...await original<typeof import("../hosted-readonly-inputs")>(), readHostedPrivateBytes: () => Buffer.from(JSON.stringify(fixture.start) + "\n"),
}));
vi.mock("../hosted-dependency-legacy-reference-records", async original => ({
  ...await original<typeof import("../hosted-dependency-legacy-reference-records")>(),
  pinReferenceFile: () => ({ bytes: Buffer.from(JSON.stringify(fixture.start) + "\n"), reference: {} }),
}));
vi.mock("../hosted-installation-activation", () => ({
  HostedInstallationActivationStore: class {},
  readHostedOrdinaryRuntime: (...args: unknown[]) => fixture.runtime(...args),
  readHostedOrdinaryBirth: () => ({ installation: { installationId: fixture.start.installationId, runtimeSha: "runtime" },
    activation: { phase: "ORDINARY", bootId: "boot", supervisorId: "supervisor", ordinaryStarts: [{ startId: fixture.id,
      state: "reserved", generation: 7, unit: fixture.unit, creatorId: fixture.start.creatorId, originSha256: fixture.start.originSha256 }] },
    originSha256: fixture.start.originSha256 }),
}));
vi.mock("../hosted-readonly-host-kernel", () => ({
  HostedReadonlyHostKernel: class {
    ordinaryRuntimeSession(...args: unknown[]) { return fixture.runtimeSession(...args); }
    operatorSession(...args: unknown[]) { return fixture.operatorSession(...args); }
  },
}));
import { readCurrentHostedDependencyOrigin, assertCurrentHostedDependencyOrigin } from "../hosted-current-dependency-origin";
import { readHostedOrdinaryDependencyParentFrame } from "../hosted-ordinary-dependency-reader";
const fence = {} as HostedActivationFence;
const unified = () => `0::${fixture.group}`;
beforeEach(() => {
  vi.resetAllMocks(); fixture.cgroup = unified() + "\n";
  fixture.ordinary.mockReturnValue({ digest: "ordinary-original", facts: { kind: "ordinary" } });
  fixture.managed.mockImplementation(() => { throw new Error("wrong managed origin"); });
  fixture.runtimeSession.mockReturnValue({ bootId: "boot", supervisorId: "supervisor" });
  fixture.operatorSession.mockImplementation(() => { throw new Error("wrong operator session"); });
  fixture.runtime.mockImplementation(() => { throw new Error("ordinary original runtime rejoin reached"); });
});
it.each(["unified", "legacy-first", "legacy-last"])("rejoins original ordinary origin and runtime for %s cgroup", layout => {
  fixture.cgroup = layout === "legacy-first" ? `1:name=systemd:/\n${unified()}\n` :
    layout === "legacy-last" ? `${unified()}\n1:name=systemd:/\n` : unified() + "\n";
  const context = readCurrentHostedDependencyOrigin(fence);
  expect(assertCurrentHostedDependencyOrigin(context, fence).kind).toBe("ordinary");
  expect(fixture.ordinary).toHaveBeenCalledTimes(4); expect(fixture.managed).not.toHaveBeenCalled();
  expect(() => readHostedOrdinaryDependencyParentFrame(fence, fixture.id, "{}"))
    .toThrow("ordinary original runtime rejoin reached");
  expect(fixture.runtimeSession).toHaveBeenCalledTimes(1); expect(fixture.runtime).toHaveBeenCalledTimes(1);
  expect(fixture.operatorSession).not.toHaveBeenCalled();
});
it.each(["duplicate-unified", "foreign-controller", "foreign-legacy", "duplicate-legacy", "whitespace"])(
  "refuses ambiguous %s before either collector/session or runtime rejoin", fault => {
    fixture.cgroup = fault === "duplicate-unified" ? `${unified()}\n${unified()}\n` :
      fault === "foreign-controller" ? `${unified()}\n2:cpu:/\n` :
      fault === "foreign-legacy" ? `${unified()}\n1:name=systemd:/foreign\n` :
      fault === "duplicate-legacy" ? `${unified()}\n1:name=systemd:/\n1:name=systemd:/\n` : `${unified()} \n`;
    expect(() => readCurrentHostedDependencyOrigin(fence)).toThrow("hosted_custody_kernel_evidence_invalid");
    expect(() => readHostedOrdinaryDependencyParentFrame(fence, fixture.id, "{}"))
      .toThrow("hosted_custody_kernel_evidence_invalid");
    for (const observation of [fixture.ordinary, fixture.managed, fixture.runtimeSession, fixture.operatorSession, fixture.runtime])
      expect(observation).not.toHaveBeenCalled();
  });
