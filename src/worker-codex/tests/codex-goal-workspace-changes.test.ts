import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { changedFilesFromWorkspace } from "../codex-goal-workspace-changes";
import { boundedChangedFiles, reportedChangedFilesLimit, changedFilesTruncatedEvidence, WorkspaceChangedFilesWarning } from "../codex-goal-changed-files-report";
import { gitWorkspaceStatus } from "../codex-goal-status-files";
import { collectCodexGoalStatus } from "../codex-goal-ops";
import { codexExceptionRuntimeResultInput } from "../codex-goal-runtime-result-collection";
import { buildRuntimeResultEnvelope } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalRunConfig } from "../codex-goal-runner";
import { gitReadBudgetBytes } from "../codex-goal-handoff-preservation-budget";

const execFileAsync = promisify(execFile);
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "TEST-workspace-changes-"))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("workspace changed files", () => {
  // Regression: Node's default 1 MiB maxBuffer made a large untracked cache look like an unavailable workspace.
  it("returns the full list when the status output exceeds the default 1 MiB buffer", async () => {
    const workspace = join(root, "workspace"), cache = join(workspace, "cache");
    await mkdir(cache, { recursive: true });
    await execFileAsync("git", ["init", "--quiet", workspace]);
    const names = Array.from({ length: 14_000 }, (_, index) => `${"x".repeat(80)}-${String(index).padStart(6, "0")}.txt`);
    await Promise.all(names.map(name => writeFile(join(cache, name), "")));
    const { stdout } = await execFileAsync("git", ["-C", workspace, "status", "--porcelain", "--untracked-files=all"], { maxBuffer: gitReadBudgetBytes });
    expect(stdout.length).toBeGreaterThan(1024 * 1024);
    const result = await changedFilesFromWorkspace(workspace);
    expect(result.warning).toBeUndefined();
    expect(result.changedFiles).toHaveLength(names.length);
    expect(result.changedFiles).toContain(`cache/${names[0]}`);
  }, 60_000);

  // A stand-in git keeps the over-budget case small: no 32 MiB of files are needed.
  it.each([
    ["output over the Git read budget", `head -c ${gitReadBudgetBytes + 1024} /dev/zero | tr '\\0' 'a'`, WorkspaceChangedFilesWarning.OutputLimit],
    ["a failing git", "exit 128", WorkspaceChangedFilesWarning.Unavailable],
  ])("reports %s with its own closed warning", async (_name, script, warning) => {
    const bin = join(root, "bin"), previous = process.env.PATH;
    await mkdir(bin);
    await writeFile(join(bin, "git"), `#!/bin/sh\n${script}\n`);
    await chmod(join(bin, "git"), 0o700);
    process.env.PATH = `${bin}:${previous}`;
    try { expect(await changedFilesFromWorkspace(join(root, "missing"))).toEqual({ changedFiles: [], warning }); }
    finally { process.env.PATH = previous; }
  });

  async function largeWorkspace(total: number): Promise<string> {
    const workspace = join(root, "workspace"), cache = join(workspace, "cache");
    await mkdir(cache, { recursive: true });
    await execFileAsync("git", ["init", "--quiet", workspace]);
    await Promise.all(Array.from({ length: total }, (_, index) => writeFile(join(cache, `${"x".repeat(80)}-${String(index).padStart(6, "0")}.txt`), "")));
    return workspace;
  }
  // Regression: the staged candidate carried every path and exceeded the 1 MiB limit it is read back through.
  it("stages a bounded sample of a large workspace and keeps the exact count", async () => {
    const workspace = await largeWorkspace(14_000);
    const input = await codexExceptionRuntimeResultInput({ config: { workspacePath: workspace, taskId: "TEST-task" } as CodexGoalRunConfig,
      error: new Error("TEST failure"), executionGeneration: "TEST-generation", deferHandoff: true });
    const envelope = buildRuntimeResultEnvelope(input);
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(1024 * 1024 / 2);
    expect(envelope.changedFiles.length).toBe(reportedChangedFilesLimit.paths);
    expect(envelope.evidence).toContain(changedFilesTruncatedEvidence);
    expect(envelope.details?.changedFilesCount).toBe("14000");
    expect(envelope.nextAction).toBe("preserve_patch");
  }, 60_000);
  // Regression: the full list went into the Status response and pushed it over the 1 MiB bridge limit.
  it("reports a large dirty workspace as dirty with a bounded sample and the exact count", async () => {
    const workspace = await largeWorkspace(14_000);
    const status = await gitWorkspaceStatus(workspace);
    expect(status).toMatchObject({ exists: true, dirty: true, changedFilesCount: 14_000 });
    expect(status.changedFiles).toHaveLength(reportedChangedFilesLimit.paths);
    const jobRootDir = join(root, "job");
    await mkdir(jobRootDir);
    const collected = await collectCodexGoalStatus({ jobRootDir, taskId: "TEST-task", workspacePath: workspace });
    expect(collected).toMatchObject({ workspaceDirty: true, changedFilesCount: 14_000 });
    expect(Buffer.byteLength(JSON.stringify(collected))).toBeLessThan(1024 * 1024 / 2);
  }, 60_000);
  it("never reports status output over the Git read budget as clean", async () => {
    const bin = join(root, "bin"), previous = process.env.PATH;
    await mkdir(bin);
    await writeFile(join(bin, "git"), `#!/bin/sh\nhead -c ${gitReadBudgetBytes + 1024} /dev/zero | tr '\\0' 'a'\n`);
    await chmod(join(bin, "git"), 0o700);
    process.env.PATH = `${bin}:${previous}`;
    try { expect(await gitWorkspaceStatus(root)).toEqual({ exists: true, dirty: true, changedFiles: [], warning: WorkspaceChangedFilesWarning.OutputLimit }); }
    finally { process.env.PATH = previous; }
  });
});

describe("bounded changed files", () => {
  it("is sorted, unique, never empty for a dirty workspace and cut by count", () => {
    const paths = Array.from({ length: reportedChangedFilesLimit.paths + 5 }, (_, index) => `f/${String(index).padStart(6, "0")}`);
    const reported = boundedChangedFiles([...paths].reverse().concat(paths[0]!, "  "));
    expect(reported).toMatchObject({ count: paths.length, truncated: true });
    expect(reported.changedFiles).toEqual(paths.slice(0, reportedChangedFilesLimit.paths));
  });
  it("is cut by bytes but always keeps the first path, and is exact below the limits", () => {
    const long = Array.from({ length: 10 }, (_, index) => `${index}${"y".repeat(100_000)}`);
    const reported = boundedChangedFiles(long);
    expect(reported.truncated).toBe(true);
    expect(reported.changedFiles.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(reported.changedFiles))).toBeLessThan(reportedChangedFilesLimit.bytes + 100_100);
    expect(boundedChangedFiles(["b", "a"])).toEqual({ changedFiles: ["a", "b"], count: 2, truncated: false });
    expect(boundedChangedFiles([])).toEqual({ changedFiles: [], count: 0, truncated: false });
  });
});
