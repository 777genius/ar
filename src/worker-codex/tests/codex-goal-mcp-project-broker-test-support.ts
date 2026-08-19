import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { git, gitInitRepository } from "./codex-goal-mcp-test-support";

export async function createCommittedTestRepository(
  workspacePath: string,
  contents: string,
  commitMessage = "test: base",
): Promise<void> {
  await mkdir(workspacePath, { recursive: true });
  await gitInitRepository(workspacePath);
  await writeFile(join(workspacePath, "README.md"), contents);
  await git(workspacePath, ["add", "README.md"]);
  await git(workspacePath, ["commit", "-m", commitMessage]);
}
