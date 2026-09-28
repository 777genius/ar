import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { LocalGitIntegrationAdapter } from "../project-integration-local-adapters";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("inspects an unreferenced exact Git object without moving the synthetic branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "published-commit-inspection-"));
  roots.push(root);
  const git = async (...args: string[]) => (await run("git", args, { cwd: root, env: {
    ...process.env,
    GIT_AUTHOR_NAME: "iliya", GIT_AUTHOR_EMAIL: "iliyazelenkog@gmail.com",
    GIT_COMMITTER_NAME: "iliya", GIT_COMMITTER_EMAIL: "iliyazelenkog@gmail.com",
  } })).stdout.trim();
  await git("init", "-q", "-b", "main");
  await writeFile(join(root, "example.txt"), "base\n");
  await git("add", "example.txt");
  await git("commit", "-qm", "test: base");
  const parent = await git("rev-parse", "HEAD");
  await writeFile(join(root, "example.txt"), "reviewed\n");
  await git("add", "example.txt");
  const tree = await git("write-tree");
  const message = "fix(test): adopt reviewed commit";
  const commitSha = await git("commit-tree", tree, "-p", parent, "-m", message);
  await git("reset", "--hard", parent);
  await git("remote", "add", "origin", "git@github.com:vioxen/subscription-runtime.git");
  const adapter = new LocalGitIntegrationAdapter();
  expect(await adapter.currentHead({ workspacePath: root })).toBe(parent);
  expect(await adapter.remoteRepository({ workspacePath: root, remote: "origin" }))
    .toBe("vioxen/subscription-runtime");
  expect(await adapter.inspectIntegrationCommit({ workspacePath: root, commitSha })).toEqual({
    commitSha, tree, parentCommits: [parent],
    author: { name: "iliya", email: "iliyazelenkog@gmail.com" },
    committer: { name: "iliya", email: "iliyazelenkog@gmail.com" },
    message, files: ["example.txt"],
  });
});
