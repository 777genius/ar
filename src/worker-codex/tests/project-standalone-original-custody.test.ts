import { beforeEach, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => {
  const root = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-sdk-00000000-0000-4000-8000-000000000000";
  return { root, workspace: root + "/workspace", source: root + "/source",
    publication: vi.fn(), create: vi.fn(), nativeGit: vi.fn(), ambientGit: vi.fn(),
    mkdir: vi.fn(), lstat: vi.fn(), rm: vi.fn() };
});
vi.mock("../hosted-project-control-native-allocation", () => ({
  originalHostedProjectControlAllocationPathPresent: (path: string) => path === fixtures.root || path.startsWith(fixtures.root + "/"),
  originalHostedProjectControlAllocationPublication: fixtures.publication,
  createOriginalHostedProjectControlWorkspace: fixtures.create,
  originalHostedProjectControlGitRoleForPath: () => "created_child",
  runOriginalHostedProjectControlGit: fixtures.nativeGit,
}));
vi.mock("../application/project-control/adapters/host-command-adapters", () => ({
  defaultProjectControlGitPort: { run: fixtures.ambientGit },
}));
vi.mock("node:fs/promises", () => ({ mkdir: fixtures.mkdir, lstat: fixtures.lstat,
  rm: fixtures.rm, realpath: vi.fn(), readdir: vi.fn() }));

import { materializeStandaloneProjectWorkspace, removeCreatedStandaloneProjectWorkspace } from "../project-standalone-workspace";
import { OriginalControlGitOperation, OriginalControlGitRole } from "../hosted-project-control-git-recipe";

const input = { path: fixtures.workspace, source: fixtures.source, revision: "a".repeat(40),
  branch: "test/standalone-sdk", existingBranchRevision: undefined };
beforeEach(() => {
  vi.resetAllMocks();
  fixtures.publication.mockReturnValue({ selectors: { workspace: fixtures.workspace, source: fixtures.source } });
  fixtures.create.mockReturnValue(fixtures.workspace);
});

it("does not bypass held original custody through mkdir or ambient Git", async () => {
  const failure = new Error("original_allocation_held");
  fixtures.publication.mockImplementation(() => { throw failure; });
  await expect(materializeStandaloneProjectWorkspace(input)).rejects.toBe(failure);
  expect(fixtures.create).not.toHaveBeenCalled();
  expect(fixtures.mkdir).not.toHaveBeenCalled();
  expect(fixtures.ambientGit).not.toHaveBeenCalled();
});

it("rejects a different source before the original creator is invoked", async () => {
  await expect(materializeStandaloneProjectWorkspace({ ...input, source: fixtures.source + "-foreign" })).rejects.toThrow("original_standalone_input_held");
  expect(fixtures.create).not.toHaveBeenCalled();
  expect(fixtures.nativeGit).not.toHaveBeenCalled();
});

it.each([new Error("native_drain_uncertain"), undefined])("preserves the primary Git rejection and original workspace without recursive rollback (%s)", async failure => {
  fixtures.nativeGit.mockRejectedValue(failure);
  let rejected = false, cause: unknown = Symbol("unobserved");
  try { await materializeStandaloneProjectWorkspace(input); } catch (error) { rejected = true; cause = error; }
  expect(rejected).toBe(true); expect(cause).toBe(failure);
  expect(fixtures.nativeGit).toHaveBeenCalledExactlyOnceWith(OriginalControlGitRole.CreatedChild, OriginalControlGitOperation.InitChild, null);
  expect(fixtures.mkdir).not.toHaveBeenCalled();
  expect(fixtures.rm).not.toHaveBeenCalled();
  expect(fixtures.ambientGit).not.toHaveBeenCalled();
  expect(await removeCreatedStandaloneProjectWorkspace(fixtures.workspace)).toBe(false);
  expect(fixtures.lstat).not.toHaveBeenCalled();
});
