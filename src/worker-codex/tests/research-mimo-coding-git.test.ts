import { mkdtempSync, mkdirSync, readFileSync, lstatSync, realpathSync, cpSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { it, expect } from "vitest";
import { researchMimoCodingGitReadPaths } from "../research-mimo-coding-git";

it("admits only the current linked worktree and common object/ref data", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "TEST-mimo-git-")));
  const source = join(root, "source"), workspace = join(root, "workspaces/worker");
  const git = (args: string[]) => execFileSync("git", args, { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: "pipe" });
  const host = {
    exists: (path: string) => { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } },
    read: (path: string) => readFileSync(path, "utf8"),
    isFile: (path: string) => { try { return lstatSync(path).isFile(); } catch { return false; } },
    isDirectory: (path: string) => lstatSync(path).isDirectory(),
  };
  try {
    mkdirSync(source); mkdirSync(join(root, "workspaces"));
    git(["init", "--quiet", source]);
    git(["-C", source, "-c", "user.name=TEST", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "TEST fixture"]);
    git(["-C", source, "worktree", "add", "--quiet", "--detach", workspace]);
    const paths = researchMimoCodingGitReadPaths(workspace, host);
    expect(paths).toEqual([...["HEAD", "index", "commondir", "gitdir"].map(leaf => join(source, ".git/worktrees/worker", leaf)), join(source, ".git/objects"), join(source, ".git/refs")]);
    expect(paths).not.toContain(join(source, ".git"));
    expect(paths).not.toContain(join(source, ".git/config"));
    const isolated = join(root, "isolated");
    for (const path of paths) {
      const target = join(isolated, path.slice(root.length + 1));
      mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      cpSync(path, target, { recursive: true });
    }
    const isolatedGit = join(isolated, "source/.git/worktrees/worker");
    expect(git([`--git-dir=${isolatedGit}`, `--work-tree=${workspace}`, "rev-parse", "HEAD"]).toString().trim()).toMatch(/^[a-f0-9]{40}$/);
    expect(git([`--git-dir=${isolatedGit}`, `--work-tree=${workspace}`, "diff", "--check"]).length).toBe(0);
    writeFileSync(join(source, ".git/objects/info/alternates"), "/outside/objects\n");
    expect(() => researchMimoCodingGitReadPaths(workspace, host)).toThrow("mimo_coding_git_external_objects");
    rmSync(join(source, ".git/objects/info/alternates"));
    symlinkSync(join(workspace, "alternates"), join(source, ".git/objects/info/alternates"));
    expect(() => researchMimoCodingGitReadPaths(workspace, host)).toThrow("mimo_coding_git_external_objects");
    rmSync(join(source, ".git/objects/info/alternates"));
    rmSync(join(source, ".git/objects/info"), { recursive: true });
    symlinkSync(workspace, join(source, ".git/objects/info"));
    expect(() => researchMimoCodingGitReadPaths(workspace, host)).toThrow("mimo_coding_git_external_objects");
    rmSync(join(source, ".git/objects/info"));
    mkdirSync(join(source, ".git/objects/info"));
    writeFileSync(join(workspace, ".git"), `gitdir: ${source}/.git/worktrees/sibling\n`);
    expect(() => researchMimoCodingGitReadPaths(workspace, host)).toThrow("mimo_coding_git_binding_invalid");
    rmSync(join(workspace, ".git"));
    symlinkSync("missing-git", join(workspace, ".git"));
    expect(() => researchMimoCodingGitReadPaths(workspace, host)).toThrow("mimo_coding_git_binding_invalid");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
