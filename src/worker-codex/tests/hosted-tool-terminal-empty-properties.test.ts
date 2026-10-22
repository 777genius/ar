import { beforeEach, expect, it, vi } from "vitest";
const observed = vi.hoisted(() => ({ fault: "", drain: vi.fn(), descendants: vi.fn() }));
vi.mock("../hosted-readonly-linux-collector", () => ({ collectUnitNotFound: vi.fn(() => false) }));
vi.mock("../hosted-readonly-host-kernel", () => ({ HostedReadonlyHostKernel: class {
  drainQueuedStart = observed.drain;
  confirmTerminalDescendants = observed.descendants;
} }));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn((_command: string, args: readonly string[]) => {
    const unit = args.at(-1)!;
    const provider = unit.startsWith("subscription-runtime-hosted-");
    const rows = provider ? [`Id=${unit}`, "InvocationID=11111111111111111111111111111111",
      "ActiveState=failed", "SubState=failed", "MainPID=0", "ControlPID=0", "Job=",
      "ExecMainCode=1", "ExecMainStatus=7", "Result=exit-code"] :
      [`Id=${unit}`, "LoadState=loaded", "ActiveState=inactive", "SubState=dead", "MainPID=0", "ControlGroup=", "DropInPaths="];
    const key = provider ? "Job=" : "DropInPaths=";
    // Actual systemctl show omits empty values without --all. Even with that
    // option, absent or nonempty required properties must remain unresolved.
    const output = !args.includes("--all") || observed.fault === "missing" ? rows.filter(row => row !== key) :
      observed.fault === "nonempty" ? rows.map(row => row === key ? key + "unexpected" : row) : rows;
    return { status: 0, signal: null, stdout: output.join("\n") + "\n", stderr: "" };
  }) };
});
import { collectHostedManagedProviderDrain } from "../hosted-managed-provider-drain-observation";
import { HostedManagedProviderResult, HostedManagedProviderWaitKind } from "../hosted-managed-provider-terminal-facts";
import { assertInstallerTerminalUnit } from "../hosted-dependency-installer-unit";
const id = "11111111-1111-1111-1111-111111111111";
const provider = `subscription-runtime-hosted-${id}.service`, installer = `subscription-runtime-installer-${id}.service`;
beforeEach(() => { vi.clearAllMocks(); observed.fault = ""; });
it("preserves a nonzero real manager result while requesting its empty Job", () => {
  expect(collectHostedManagedProviderDrain(provider)).toEqual({ unit: provider, invocationId: "1".repeat(32),
    kind: HostedManagedProviderWaitKind.Exited, status: 7, result: HostedManagedProviderResult.ExitCode });
  expect(observed.drain).toHaveBeenCalledOnce();
  expect(observed.descendants).toHaveBeenCalledOnce();
});
it("accepts the terminal installer observation only with both empty manager properties present", () => {
  expect(() => assertInstallerTerminalUnit(installer)).not.toThrow();
});
it.each(["missing", "nonempty"])("keeps %s required manager facts unresolved before descendant discharge", fault => {
  observed.fault = fault;
  expect(() => collectHostedManagedProviderDrain(provider)).toThrow("hosted_dependency_provider_terminal_unresolved");
  expect(() => assertInstallerTerminalUnit(installer)).toThrow("dependency_installer_unit_unresolved");
  expect(observed.drain).not.toHaveBeenCalled();
  expect(observed.descendants).not.toHaveBeenCalled();
});
