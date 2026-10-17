import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const root = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-sdk-00000000-0000-4000-8000-000000000000";
  return { root, source: root + "/source", workspace: root + "/workspace",
    publication: vi.fn(), role: vi.fn(), native: vi.fn(), exec: vi.fn() };
});
vi.mock("../hosted-project-control-native-allocation", () => ({
  originalHostedProjectControlAllocationPathPresent: (path: string) => path === fixture.root || path.startsWith(fixture.root + "/"),
  originalHostedProjectControlAllocationPublication: fixture.publication,
  originalHostedProjectControlGitRoleForPath: fixture.role,
  runOriginalHostedProjectControlGit: fixture.native,
}));
vi.mock("node:child_process", () => ({ execFile: fixture.exec }));
import { ExecFileProjectControlGitAdapter } from "../application/project-control/adapters/host-command-adapters";
import { OriginalControlGitOperation, OriginalControlGitRole } from "../hosted-project-control-git-recipe";

beforeEach(() => {
  vi.resetAllMocks();
  fixture.publication.mockReturnValue({ selectors: { source: fixture.source, workspace: fixture.workspace } });
  fixture.role.mockReturnValue(OriginalControlGitRole.Source);
  fixture.native.mockResolvedValue({ stdout: "actual-native-query\n", code: 0, signal: "" });
});
const adapter = new ExecFileProjectControlGitAdapter();

it("routes an exact public Source query through the finite original producer", async () => {
  expect(await adapter.run({ args: ["--literal-pathspecs", "-C", fixture.source, "worktree", "list", "--porcelain"] }))
    .toEqual({ stdout: "actual-native-query\n", stderr: "" });
  expect(fixture.native).toHaveBeenCalledExactlyOnceWith(OriginalControlGitRole.Source, OriginalControlGitOperation.Worktrees, null);
  expect(fixture.exec).not.toHaveBeenCalled();
});

it("does not fall back to ambient Git when original custody is held", async () => {
  const error = new Error("allocation_held"); fixture.publication.mockImplementation(() => { throw error; });
  await expect(adapter.run({ args: ["-C", fixture.source, "rev-parse", "--verify", "HEAD"] })).rejects.toBe(error);
  expect(fixture.native).not.toHaveBeenCalled(); expect(fixture.exec).not.toHaveBeenCalled();
});

it("supports the unchanged admission HEAD query while refusing an arbitrary ref", async () => {
  fixture.role.mockReturnValue(OriginalControlGitRole.CreatedChild);
  await adapter.run({ args: ["-C", fixture.workspace, "rev-parse", "HEAD"] });
  expect(fixture.native).toHaveBeenCalledExactlyOnceWith(OriginalControlGitRole.CreatedChild, OriginalControlGitOperation.Head, null);
  await expect(adapter.run({ args: ["-C", fixture.source, "rev-parse", "foreign^{commit}"] })).rejects.toThrow("original_git_tuple_held");
  expect(fixture.native).toHaveBeenCalledTimes(1); expect(fixture.exec).not.toHaveBeenCalled();
});

it("preserves the real reuse status tuple and fixed read-only continuation options", async () => {
  await adapter.run({ args: ["--literal-pathspecs", "-C", fixture.source, "status", "--porcelain"] });
  expect(fixture.native).toHaveBeenLastCalledWith(OriginalControlGitRole.Source, OriginalControlGitOperation.StatusDefault, null);
  await adapter.run({ args: ["--no-optional-locks", "-c", "core.fsmonitor=false", "--literal-pathspecs", "-C", fixture.source, "rev-parse", "--show-toplevel"] });
  expect(fixture.native).toHaveBeenLastCalledWith(OriginalControlGitRole.Source, OriginalControlGitOperation.TopLevel, null);
  fixture.native.mockResolvedValue({ stdout: "", code: 1, signal: "" });
  await expect(adapter.run({ args: ["--no-optional-locks", "-C", fixture.source, "config", "--get-regexp", "^filter\\..*\\.(clean|process)$"] })).rejects.toMatchObject({ code: 1 });
  expect(fixture.exec).not.toHaveBeenCalled();
});

it("refuses stricter and invalid limits before querying custody or starting a child", async () => {
  const args = ["-C", fixture.source, "rev-parse", "--verify", "HEAD"];
  for (const limits of [{ timeoutMs: 1 }, { timeoutMs: Number.NaN }, { timeoutMs: -1 }, { maxBuffer: 1 }, { maxBuffer: 0 }, { maxBuffer: Number.POSITIVE_INFINITY }])
    await expect(adapter.run({ args, ...limits })).rejects.toThrow("original_git_limits_held");
  expect(fixture.publication).not.toHaveBeenCalled(); expect(fixture.native).not.toHaveBeenCalled(); expect(fixture.exec).not.toHaveBeenCalled();
  await expect(adapter.run({ args, timeoutMs: 5_000, maxBuffer: 1024 * 1024 })).resolves.toMatchObject({ stdout: "actual-native-query\n" });
});

it("uses the actual allocator-selected published child role rather than inferring publication from a path", async () => {
  fixture.role.mockReturnValue(OriginalControlGitRole.PublishedChild);
  await adapter.run({ args: ["-C", fixture.workspace, "status", "--porcelain", "--untracked-files=all"] });
  expect(fixture.role).toHaveBeenCalledExactlyOnceWith(fixture.workspace);
  expect(fixture.native).toHaveBeenCalledExactlyOnceWith(OriginalControlGitRole.PublishedChild, OriginalControlGitOperation.Status, null);
});

it("refuses caller environment, extra Git options, foreign child paths, and binary patch operations", async () => {
  for (const input of [
    { args: ["-C", fixture.source, "rev-parse", "--verify", "HEAD"], env: { GIT_CONFIG_GLOBAL: "/foreign" } },
    { args: ["-c", "core.hooksPath=/foreign", "-C", fixture.source, "rev-parse", "--verify", "HEAD"] },
    { args: ["-C", fixture.root + "/foreign", "rev-parse", "--verify", "HEAD"] },
    { args: ["--git-dir=" + fixture.source + "/.git", "rev-parse", "--verify", "HEAD"] },
  ]) await expect(adapter.run(input)).rejects.toThrow();
  await expect(adapter.runBuffered({ args: ["-C", fixture.workspace, "diff", "--binary"] })).rejects.toThrow("original_git_buffered_held");
  expect(fixture.native).not.toHaveBeenCalled(); expect(fixture.exec).not.toHaveBeenCalled();
});

it("serializes concurrent queries and revalidates custody after the first actual effect drains", async () => {
  let finish: (() => void) | undefined;
  fixture.native.mockImplementationOnce(() => new Promise(resolve => {
    finish = () => resolve({ stdout: "first\n", code: 0, signal: "" });
  }));
  const args = ["-C", fixture.source, "rev-parse", "--verify", "HEAD"];
  const first = adapter.run({ args }), second = adapter.run({ args });
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(fixture.native).toHaveBeenCalledTimes(1); expect(fixture.publication).toHaveBeenCalledTimes(1);
  finish!();
  await expect(first).resolves.toMatchObject({ stdout: "first\n" });
  await expect(second).resolves.toMatchObject({ stdout: "actual-native-query\n" });
  expect(fixture.publication).toHaveBeenCalledTimes(2); expect(fixture.exec).not.toHaveBeenCalled();
});

it("preserves the exit-code-1 contract without publishing child stderr", async () => {
  fixture.native.mockResolvedValue({ stdout: "", code: 1, signal: "" });
  await expect(adapter.run({ args: ["-C", fixture.source, "config", "--get-regexp", "^filter\\..*\\.(clean|process)$"] }))
    .rejects.toMatchObject({ code: 1, stderr: "", message: "project_control_original_git_exit" });
  expect(fixture.exec).not.toHaveBeenCalled();
});
