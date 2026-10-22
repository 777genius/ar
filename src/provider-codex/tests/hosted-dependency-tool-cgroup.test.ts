import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { DependencyAdmissionError } from "../../core/dependency-environment/dependency-owner";

const observed = vi.hoisted(() => ({
  membership: "",
  origin: vi.fn(() => ({ start: { jobId: "TEST-tool-cgroup" } })),
  binding: vi.fn(() => ({ version: 2 })),
}));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn((path: unknown, ...args: unknown[]) => {
    if (path === "/proc/self/cgroup") return observed.membership;
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...args);
  }) };
});
vi.mock("../app-server/adapters/hosted-process-activation", async importOriginal => {
  const actual = await importOriginal<typeof import("../app-server/adapters/hosted-process-activation")>();
  return { ...actual, assertHostedActivationFence: vi.fn(), readHostedOrdinaryProcessOrigin: observed.origin };
});
vi.mock("../app-server/adapters/hosted-dependency-workspace", async importOriginal => {
  const actual = await importOriginal<typeof import("../app-server/adapters/hosted-dependency-workspace")>();
  return { ...actual, readHostedDependencyBinding: observed.binding };
});
import { assertHostedDependencyToolRelease } from "../app-server/adapters/hosted-dependency-tool-plan";

const unit = "subscription-runtime-ordinary-11111111-1111-1111-1111-111111111111.service";
const ordinary = "0::/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/" + unit;
// No retained child/plan is supplied: every ordinary V2 release must reject it.
// This checks the actual gate dispatch; mocked protected snapshots are not
// runtime authority and cannot produce a successful provider release.
function release() {
  assertHostedDependencyToolRelease({} as ChildProcess, undefined as never,
    undefined as never, {unit} as never);
}
describe("ordinary V2 dependency release on hybrid cgroups", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it.each([ordinary + "\n", ordinary + "\n1:name=systemd:/\n", "1:name=systemd:/\n" + ordinary + "\n"])(
    "enforces the original missing-plan refusal for %j", membership => {
      observed.membership = membership;
      expect(release).toThrow(DependencyAdmissionError);
      expect(observed.origin).toHaveBeenCalledOnce();
      expect(observed.binding).toHaveBeenCalledWith("TEST-tool-cgroup");
    });
  it.each([ordinary + "\n0::/other\n", ordinary + "\n1:name=systemd:/other\n",
    ordinary + "\n2:cpu:/\n"])("refuses malformed membership before origin lookup for %j", membership => {
    observed.membership = membership;
    expect(release).toThrow();
    expect(observed.origin).not.toHaveBeenCalled();
  });
  it("keeps the separate managed route outside the ordinary release boundary", () => {
    observed.membership = "1:name=systemd:/\n0::/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/subscription-runtime-outer-11111111-1111-1111-1111-111111111111.service\n";
    expect(release).not.toThrow();
    expect(observed.origin).not.toHaveBeenCalled();
  });
});
