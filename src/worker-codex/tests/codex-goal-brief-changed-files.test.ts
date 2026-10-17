import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCodexGoalBrief } from "../application/codex-goal-brief";
import { buildCodexGoalBriefMcpResponse } from "../codex-goal-mcp-brief-response";
import { CodexGoalBriefDetail } from "../codex-goal-mcp-inputs";
import { WorkspaceChangedFilesWarning, reportedChangedFilesLimit } from "../codex-goal-changed-files-report";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "TEST-brief-changed-files-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** The real brief is built from a real status shape; nothing is added to the brief by hand. */
async function compactFor(status: Record<string, unknown>) {
  const jobRootDir = join(root, "job"), workspacePath = join(root, "workspace"), logPath = join(jobRootDir, "task-1.log");
  await mkdir(jobRootDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(logPath, "running\n");
  const launch = { cwd: workspacePath, logPath, cliCommand: ["subscription-runtime-codex-goal"], config: { jobId: "worker-1", jobRootDir,
    authRootDir: join(root, "auth"), workspacePath, promptPath: join(jobRootDir, "prompt.md"), taskId: "task-1", accounts: [] } } as const;
  const full = { tmuxAlive: false, resultExists: false, workspaceExists: true, logPath, logExists: true, logByteLength: 8, warnings: [], ...status };
  const brief = await buildCodexGoalBrief({ jobId: "worker-1", launch, status: full as never, accounts: [], staleAfterMs: 60_000, tailLines: 0 });
  const compact = buildCodexGoalBriefMcpResponse({ ok: true, registryRootDir: root, jobId: "worker-1", brief, status: full } as never,
    { detail: CodexGoalBriefDetail.Compact, registryRootDir: root, jobId: "worker-1", staleAfterMs: 60_000, logTailLines: 0 }) as
    { brief: Record<string, unknown>; status: Record<string, unknown> };
  return { brief, compact };
}

describe("changed file counters in the brief", () => {
  it("report the exact count of a truncated sample", async () => {
    const sample = Array.from({ length: reportedChangedFilesLimit.paths }, (_, index) => `f/${String(index).padStart(5, "0")}`);
    const { brief, compact } = await compactFor({ workspaceDirty: true, changedFiles: sample, changedFilesCount: 14_000 });
    expect(brief).toMatchObject({ changedFilesCount: 14_000, statusView: { dirtyFilesCount: 14_000 } });
    expect(compact.brief).toMatchObject({ changedFileCount: 14_000 });
    expect(compact.status).toMatchObject({ changedFileCount: 14_000, dirtyFileCount: 14_000 });
    expect(JSON.stringify(brief)).toContain("changed files 14000");
  });
  it("use the list length when the list is complete", async () => {
    const { brief, compact } = await compactFor({ workspaceDirty: true, changedFiles: ["a.ts", "b.ts"] });
    expect(brief).toMatchObject({ changedFilesCount: 2 });
    expect(compact.brief.changedFileCount).toBe(2);
  });
  // A listing over the Git read budget is dirty without paths: the count is unknown, not zero.
  it("report an unknown count, not zero, for a listing over the Git read budget", async () => {
    const { brief, compact } = await compactFor({ workspaceDirty: true, changedFiles: [], warnings: [WorkspaceChangedFilesWarning.OutputLimit] });
    expect(brief).not.toHaveProperty("changedFilesCount");
    expect((brief as { statusView: Record<string, unknown> }).statusView).not.toHaveProperty("dirtyFilesCount");
    expect(JSON.stringify(brief)).toContain("changed files unknown (listing over budget)");
    expect(compact.brief).not.toHaveProperty("changedFileCount");
    expect(compact.status).not.toHaveProperty("changedFileCount");
    expect(compact.status).not.toHaveProperty("dirtyFileCount");
    expect(compact.status).toMatchObject({ workspaceDirty: true });
  });
});
