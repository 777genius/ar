import { mkdtemp, mkdir, lstat, readFile, realpath, readdir, rm, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { git, gitStdout } from "./codex-goal-mcp-test-support";
import { materializeStandaloneProjectWorkspace, removeCreatedStandaloneProjectWorkspace, assertStandaloneProjectWorkspace } from "../project-standalone-workspace";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "TEST-standalone-git-")));
  for (const [name, value] of Object.entries({ GIT_AUTHOR_NAME: "iliya", GIT_AUTHOR_EMAIL: "iliyazelenkog@gmail.com", GIT_COMMITTER_NAME: "iliya",
    GIT_COMMITTER_EMAIL: "iliyazelenkog@gmail.com", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" })) vi.stubEnv(name, value);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
async function source(): Promise<{ source: string; revision: string }> {
  const source = join(root, "source"); await mkdir(source);
  await git(source, ["init", "--template=", "--initial-branch=main"]);
  for (const kind of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) expect((await gitStdout(source, ["var", kind])).trim()).toMatch(/^iliya <iliyazelenkog@gmail.com> /);
  await writeFile(join(source, "README.md"), "Original pinned Source.\n"); await git(source, ["add", "README.md"]);
  await git(source, ["commit", "-m", "test: standalone workspace fixture"]);
  return { source, revision: (await gitStdout(source, ["rev-parse", "HEAD"])).trim() };
}
it("materializes pinned commit and tree with independent objects and no linked metadata or remote", async () => {
  const input = await source(), path = join(root, "workspace");
  await materializeStandaloneProjectWorkspace({ ...input, path, branch: "test/sdk", existingBranchRevision: undefined });
  expect((await lstat(join(path, ".git"))).isDirectory()).toBe(true);
  expect(await readdir(join(path, ".git"))).not.toContain("commondir");
  expect((await gitStdout(path, ["rev-parse", "HEAD"])).trim()).toBe(input.revision);
  expect((await gitStdout(path, ["rev-parse", "HEAD^{tree}"])).trim()).toBe((await gitStdout(input.source, ["rev-parse", "HEAD^{tree}"])).trim());
  expect((await gitStdout(path, ["symbolic-ref", "--short", "HEAD"])).trim()).toBe("test/sdk");
  await assertStandaloneProjectWorkspace(path);
  await rm(input.source, { recursive: true });
  expect((await gitStdout(path, ["show", "HEAD:README.md"])).trim()).toBe("Original pinned Source.");
  expect(await removeCreatedStandaloneProjectWorkspace(path)).toBe(true);
});
it("preserves an existing target and refuses rollback after inode replacement", async () => {
  const input = await source(), path = join(root, "workspace");
  await mkdir(path); await writeFile(join(path, "foreign"), "preserve");
  await expect(materializeStandaloneProjectWorkspace({ ...input, path, branch: "test/sdk", existingBranchRevision: undefined })).rejects.toThrow();
  expect(await removeCreatedStandaloneProjectWorkspace(path)).toBe(false); expect(await readFile(join(path, "foreign"), "utf8")).toBe("preserve");
  await rm(path, { recursive: true });
  await materializeStandaloneProjectWorkspace({ ...input, path, branch: "test/sdk", existingBranchRevision: undefined });
  await rename(path, path + "-owned"); await mkdir(path); await writeFile(join(path, "foreign"), "preserve");
  await expect(removeCreatedStandaloneProjectWorkspace(path)).rejects.toThrow("project_control_standalone_rollback_identity_changed");
  expect(await readFile(join(path, "foreign"), "utf8")).toBe("preserve");
});
it("rolls back only its own fresh directory when pinned source commit is absent", async () => {
  const input = await source(), path = join(root, "workspace");
  await expect(materializeStandaloneProjectWorkspace({ ...input, revision: "f".repeat(40), path, branch: "test/sdk", existingBranchRevision: undefined })).rejects.toThrow();
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(input.source, "README.md"), "utf8")).toBe("Original pinned Source.\n");
});
