import { beforeEach, expect, it, vi } from "vitest";

// Synthetic physical-reader facts only. No installed/native authority is
// created here; actual namespace/mount validation remains a Linux TEST gate.
const fixture = vi.hoisted(() => ({
  root: "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-inspection",
  mounts: "1 0 259:1 / / rw - ext4 /dev/TEST rw\n", linked: false,
  operator: vi.fn(), installationRead: vi.fn(),
}));
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation", () => ({
  assertHostedActivationOperator: fixture.operator,
  readHostedActivationBytes: fixture.installationRead,
}));
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real,
    lstatSync: (path: string, options?: { bigint?: boolean }) => ({
      isDirectory: () => !(fixture.linked && path === fixture.root + "/workspace/.git"),
      isSymbolicLink: () => false, uid: options?.bigint ? 0n : 0, mode: 0o40700,
      dev: options?.bigint ? 259n : 259, ino: options?.bigint ? 123n : 123,
    }),
    realpathSync: (path: string) => path,
    readdirSync: () => [],
    readFileSync: (path: string, ...rest: unknown[]) => path === "/proc/self/mountinfo"
      ? fixture.mounts : Reflect.apply(real.readFileSync, real, [path, ...rest]),
  };
});
import { assertHostedDependencyPhysicalWorkspaceInspection } from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";

const selection = { jobRootDir: fixture.root,
  workspace: { canonicalPath: fixture.root + "/workspace", dev: "259", ino: "123" } };
beforeEach(() => { vi.clearAllMocks(); fixture.operator.mockImplementation(() => undefined);
  fixture.mounts = "1 0 259:1 / / rw - ext4 /dev/TEST rw\n"; fixture.linked = false; });

it("inspects factual workspace identity without fabricated installation fields or reading an installed profile", () => {
  expect(() => assertHostedDependencyPhysicalWorkspaceInspection(selection)).not.toThrow();
  expect(fixture.operator).toHaveBeenCalledOnce(); expect(fixture.installationRead).not.toHaveBeenCalled();
});
it("retains the operator check and rejects a mismatched original identity", () => {
  const denied = new Error("operator_denied"); fixture.operator.mockImplementation(() => { throw denied; });
  expect(() => assertHostedDependencyPhysicalWorkspaceInspection(selection)).toThrow(denied);
  fixture.operator.mockImplementation(() => undefined);
  expect(() => assertHostedDependencyPhysicalWorkspaceInspection({ ...selection, workspace: { ...selection.workspace, ino: "124" } })).toThrow();
});
it("rejects linked Git metadata and same-device mounts without a caller mount exception", () => {
  fixture.linked = true;
  expect(() => assertHostedDependencyPhysicalWorkspaceInspection(selection)).toThrow();
  fixture.linked = false;
  fixture.mounts += "2 1 259:1 /other " + fixture.root + "/workspace rw - ext4 /dev/TEST rw\n";
  expect(() => assertHostedDependencyPhysicalWorkspaceInspection(selection)).toThrow();
  expect(fixture.installationRead).not.toHaveBeenCalled();
});
