import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { git, gitInitRepository, gitStdout } from "./codex-goal-mcp-test-support";

export type Fixture = {
  readonly root: string;
  readonly sourceWorkspacePath: string;
  readonly phaseStartSha: string;
};

export async function createFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "subscription-runtime-project-worktree-")));
  const sourceWorkspacePath = join(root, "source");
  await mkdir(sourceWorkspacePath, { recursive: true });
  await gitInitRepository(sourceWorkspacePath);
  await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
  await git(sourceWorkspacePath, ["add", "README.md"]);
  await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
  const phaseStartSha = (await gitStdout(
    sourceWorkspacePath,
    ["rev-parse", "HEAD"],
  )).trim();
  await git(sourceWorkspacePath, [
    "update-ref",
    "refs/remotes/origin/main",
    phaseStartSha,
  ]);
  return { root, sourceWorkspacePath, phaseStartSha };
}

export function createScope(fixture: Fixture): ProjectAccessScope {
  return {
    projectId: "test-project",
    workspaceRoots: [fixture.sourceWorkspacePath],
    worktreeRoots: [join(fixture.root, "worktrees")],
  };
}
