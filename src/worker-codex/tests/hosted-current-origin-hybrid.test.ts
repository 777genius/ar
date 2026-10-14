import { beforeEach, expect, it, vi } from "vitest";
const os = vi.hoisted(() => ({ cgroup: "", ordinary: vi.fn(), budget: vi.fn() }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) =>
    args[0] === "/proc/self/cgroup" ? os.cgroup : fs.readFileSync(...args) };
});
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation", async original => ({
  ...await original<typeof import("../../provider-codex/app-server/adapters/hosted-process-activation")>(),
  assertHostedActivationFence: vi.fn(), assertHostedActivationOperator: vi.fn(),
  readHostedOrdinaryProcessOrigin: (...args: unknown[]) => os.ordinary(...args),
}));
vi.mock("../../provider-codex/app-server/adapters/systemd-service-arrays", async original => ({
  ...await original<typeof import("../../provider-codex/app-server/adapters/systemd-service-arrays")>(),
  systemdObservationBudget: () => os.budget(),
}));
import { readCurrentHostedDependencyOrigin, assertCurrentHostedDependencyOrigin, CurrentHostedDependencyOriginKind } from "../hosted-current-dependency-origin";
import { collectActualHostedManagedReadonlyOrigin } from "../hosted-managed-readonly-origin-collector";
import type { HostedActivationFence } from "../../provider-codex/app-server/adapters/hosted-process-activation";
const fence = Object.freeze({}) as HostedActivationFence;
const group = (role: string) => `0::/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/subscription-runtime-${role}-22222222-2222-4222-8222-222222222222.service`;
beforeEach(() => {
  vi.resetAllMocks(); os.ordinary.mockReturnValue(Object.freeze({ marker: "protected ordinary observation" }));
  os.budget.mockImplementation(() => { throw new Error("managed protected observation reached"); });
});
it.each([false, true])("captures and revalidates ordinary origin with hybrid=%s", hybrid => {
  os.cgroup = `${hybrid ? "1:name=systemd:/\n" : ""}${group("ordinary")}\n`;
  const origin = readCurrentHostedDependencyOrigin(fence);
  expect(assertCurrentHostedDependencyOrigin(origin, fence)).toEqual({ kind: CurrentHostedDependencyOriginKind.Ordinary,
    ordinary: { marker: "protected ordinary observation" } });
  expect(os.ordinary).toHaveBeenCalledTimes(2);
  expect(os.budget).not.toHaveBeenCalled();
});
it.each([false, true])("routes final managed origin to protected observation with hybrid=%s", hybrid => {
  os.cgroup = `${hybrid ? "1:name=systemd:/\n" : ""}${group("outer")}\n`;
  expect(() => collectActualHostedManagedReadonlyOrigin(fence)).toThrow("managed protected observation reached");
  expect(() => readCurrentHostedDependencyOrigin(fence)).toThrow("managed protected observation reached");
  expect(os.budget).toHaveBeenCalledTimes(2);
  expect(os.ordinary).not.toHaveBeenCalled();
});
it.each(["duplicate", "foreign", "whitespace", "legacy-only"])("rejects %s at both final origin boundaries", fault => {
  os.cgroup = fault === "duplicate" ? `${group("outer")}\n${group("outer")}\n` :
    fault === "foreign" ? `1:name=systemd:/foreign\n${group("outer")}\n` :
    fault === "legacy-only" ? "1:name=systemd:/\n" : `${group("outer")} \n`;
  expect(() => collectActualHostedManagedReadonlyOrigin(fence)).toThrow("hosted_custody_kernel_evidence_invalid");
  expect(() => readCurrentHostedDependencyOrigin(fence)).toThrow("hosted_custody_kernel_evidence_invalid");
  expect(os.budget).not.toHaveBeenCalled(); expect(os.ordinary).not.toHaveBeenCalled();
});
