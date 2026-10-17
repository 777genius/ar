import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ cgroup: "", fence: vi.fn() }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === "/proc/self/cgroup") return fixture.cgroup;
    return fs.readFileSync(...args);
  } };
});
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation", () => ({
  withHostedActivationFence: (...args: unknown[]) => fixture.fence(...args),
}));
import { isHostedManagedReadonlyOuterRuntime, requiresCurrentHostedDependencyRootPurpose } from "../hosted-dependency-current-facts";
import { isHostedOrdinaryRuntime } from "../hosted-installation-activation";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const group = (role: "ordinary" | "outer") => `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/subscription-runtime-${role}-22222222-2222-4222-8222-222222222222.service`;
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  vi.resetAllMocks(); fixture.fence.mockImplementation(() => { throw new Error("original protected fence reached"); });
});
afterEach(() => Object.defineProperty(process, "platform", platform));
it.each(["ordinary", "outer"] as const)("preserves %s routing and requires the original fence for the real hybrid shape", role => {
  fixture.cgroup = `1:name=systemd:/\n0::${group(role)}\n`;
  expect(isHostedOrdinaryRuntime()).toBe(role === "ordinary");
  expect(isHostedManagedReadonlyOuterRuntime()).toBe(role === "outer");
  expect(() => requiresCurrentHostedDependencyRootPurpose()).toThrow("original protected fence reached");
  expect(fixture.fence).toHaveBeenCalledTimes(1);
});
it.each(["duplicate", "foreign", "whitespace"])("refuses %s membership before protected admission", fault => {
  const unified = `0::${group("ordinary")}`;
  fixture.cgroup = fault === "duplicate" ? `${unified}\n${unified}\n` :
    fault === "foreign" ? `${unified}\n1:name=systemd:/foreign\n` : `${unified} \n`;
  for (const read of [isHostedOrdinaryRuntime, isHostedManagedReadonlyOuterRuntime, requiresCurrentHostedDependencyRootPurpose])
    expect(read).toThrow("hosted_custody_kernel_evidence_invalid");
  expect(fixture.fence).not.toHaveBeenCalled();
});
