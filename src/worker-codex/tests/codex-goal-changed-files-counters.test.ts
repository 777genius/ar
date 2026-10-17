import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceChangedFilesWarning, workspaceChangedFilesCount, workspaceChangedFilesCountText } from "../codex-goal-changed-files-report";
import { sameChangedFiles } from "../codex-goal-project-continuation-runtime";
import { reconcileCodexGoalRuntimeResult, type CodexGoalStatus } from "../codex-goal-ops";

describe("exact changed file count", () => {
  it("prefers the explicit count over the sample length", () => {
    expect(workspaceChangedFilesCount({ changedFiles: ["a", "b"], changedFilesCount: 9 })).toBe(9);
    expect(workspaceChangedFilesCount({ changedFiles: ["a", "b"] })).toBe(2);
    expect(workspaceChangedFilesCount({})).toBe(0);
    // A listing over the Git read budget is dirty without paths: unknown, never zero.
    expect(workspaceChangedFilesCount({ changedFiles: [], warnings: [WorkspaceChangedFilesWarning.OutputLimit] })).toBeUndefined();
    expect(workspaceChangedFilesCountText({ changedFiles: [], warnings: [WorkspaceChangedFilesWarning.OutputLimit] })).toBe("unknown (listing over budget)");
  });
  // A truncated sample must not match a different workspace that has the same first paths.
  it.each([
    ["the same sample and the same count", { changedFiles: ["a", "b"], details: { changedFilesCount: "9" } }, { changedFiles: ["b", "a"], changedFilesCount: 9 }, true],
    ["the same sample but a different count", { changedFiles: ["a", "b"], details: { changedFilesCount: "9" } }, { changedFiles: ["a", "b"], changedFilesCount: 10 }, false],
    ["a complete list against a truncated sample", { changedFiles: ["a", "b"], details: {} }, { changedFiles: ["a", "b"], changedFilesCount: 3 }, false],
    ["complete lists", { changedFiles: ["a", "b"], details: {} }, { changedFiles: ["a", "b"] }, true],
    ["an unknown count", { changedFiles: ["a", "b"], details: {} }, { changedFiles: ["a", "b"], warnings: [WorkspaceChangedFilesWarning.OutputLimit] }, false],
    ["a malformed recorded count", { changedFiles: ["a", "b"], details: { changedFilesCount: "x" } }, { changedFiles: ["a", "b"], changedFilesCount: 9 }, false],
  ])("compares continuation results with %s", (_name, parsed, status, expected) => {
    expect(sameChangedFiles(parsed, status)).toBe(expected);
  });
});

describe("reconcile of a workspace over the Git read budget", () => {
  let root: string;
  beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "TEST-reconcile-budget-"))); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  // Regression: such a status is dirty but has no paths; reconciling it as an empty workspace recorded a result with nothing preserved.
  it("refuses instead of reading the empty path list as a clean workspace", async () => {
    const jobRootDir = join(root, "job");
    await mkdir(jobRootDir);
    const status = { warnings: [WorkspaceChangedFilesWarning.OutputLimit], workspaceDirty: true, changedFiles: [] } as unknown as CodexGoalStatus;
    await expect(reconcileCodexGoalRuntimeResult({ config: { jobRootDir, taskId: "TEST-task", workspacePath: root }, status } as never))
      .rejects.toThrow("codex_goal_reconcile_changed_files_unavailable:workspace_changed_files_output_limit");
  });
});
